defmodule CascadeWeb.Security do
  @moduledoc "Security headers, CORS, CSRF, and bounded request throttling."

  import Plug.Conn

  alias Cascade.Auth.Session
  alias CascadeWeb.{JSON, RateLimiter}

  @app_csp Enum.join(
             [
               "default-src 'self'",
               "base-uri 'self'",
               "object-src 'none'",
               "frame-ancestors 'none'",
               "form-action 'self'",
               "script-src 'self'",
               "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
               "font-src 'self' data: https://fonts.gstatic.com",
               "img-src 'self' data: blob: https:",
               "media-src 'self' blob: https:",
               "connect-src 'self' wss:",
               "frame-src https://www.youtube.com https://platform.twitter.com https://open.spotify.com",
               "worker-src 'self' blob:",
               "manifest-src 'self'"
             ],
             "; "
           )

  @public_note_csp "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors *; img-src data: https:; style-src 'unsafe-inline'"

  def init(options), do: options

  def call(conn, _options) do
    conn
    |> put_security_headers()
    |> enforce_cors()
    |> enforce_rate_limits()
    |> enforce_cookie_csrf()
  end

  defp put_security_headers(conn) do
    public_note? = String.starts_with?(conn.request_path, "/p/")
    landing? = conn.request_path in ["/", "/download"]
    csp = if(public_note?, do: @public_note_csp, else: landing_csp(landing?))

    conn =
      conn
      |> put_resp_header("x-content-type-options", "nosniff")
      |> put_resp_header("referrer-policy", "no-referrer")
      |> put_resp_header(
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      )
      |> put_resp_header("content-security-policy", csp)

    conn =
      if public_note? do
        conn
      else
        conn
        |> put_resp_header("x-frame-options", "DENY")
        |> put_resp_header("cross-origin-opener-policy", "same-origin")
      end

    if Cascade.Config.network_mode?() and conn.scheme == :https do
      put_resp_header(conn, "strict-transport-security", "max-age=31536000; includeSubDomains")
    else
      conn
    end
  end

  defp enforce_cors(%Plug.Conn{halted: true} = conn), do: conn

  defp enforce_cors(conn) do
    case get_req_header(conn, "origin") do
      [] ->
        conn

      [origin] ->
        if origin_allowed?(origin) do
          conn =
            conn
            |> put_resp_header("access-control-allow-origin", origin)
            |> put_resp_header("access-control-allow-credentials", "true")
            |> put_resp_header("vary", "Origin")

          if conn.method == "OPTIONS" do
            conn
            |> put_resp_header(
              "access-control-allow-methods",
              "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"
            )
            |> put_resp_header(
              "access-control-allow-headers",
              "authorization,content-type,x-cascade-browser,x-cascade-session-migrate"
            )
            |> send_resp(204, "")
            |> halt()
          else
            conn
          end
        else
          conn |> JSON.send(403, %{error: "Origin not allowed"}) |> halt()
        end

      _ ->
        conn |> JSON.send(400, %{error: "Invalid Origin header"}) |> halt()
    end
  end

  defp enforce_rate_limits(%Plug.Conn{halted: true} = conn), do: conn

  defp enforce_rate_limits(conn) do
    if String.starts_with?(conn.request_path, "/api") do
      enforce_api_rate_limits(conn)
    else
      conn
    end
  end

  defp enforce_api_rate_limits(conn) do
    key = peer_key(conn)

    limits =
      if String.starts_with?(conn.request_path, "/api/auth") do
        [{:api, 1_200, 60_000}, {:auth, 30, 15 * 60_000}]
      else
        [{:api, 1_200, 60_000}]
      end

    case Enum.find_value(limits, fn {bucket, max, window} ->
           case RateLimiter.check(bucket, key, max, window) do
             :ok -> false
             {:error, retry_after} -> retry_after
           end
         end) do
      nil ->
        conn

      retry_after ->
        conn
        |> put_resp_header("retry-after", Integer.to_string(retry_after))
        |> JSON.send(429, %{error: "Too many requests. Please try again shortly."})
        |> halt()
    end
  end

  defp enforce_cookie_csrf(%Plug.Conn{halted: true} = conn), do: conn

  defp enforce_cookie_csrf(conn) do
    safe_method? = conn.method in ["GET", "HEAD", "OPTIONS"]
    api? = String.starts_with?(conn.request_path, "/api")
    browser_header? = get_req_header(conn, "x-cascade-browser") == ["1"]

    cookie_authenticated? = not is_nil(Session.cookie_token(conn))

    if api? and not safe_method? and cookie_authenticated? and not Session.bearer?(conn) and
         not browser_header? do
      conn
      |> JSON.send(403, %{error: "Authenticated browser request was missing CSRF protection"})
      |> halt()
    else
      conn
    end
  end

  defp origin_allowed?(origin) do
    not Cascade.Config.network_mode?() or
      origin in ["https://localhost", "capacitor://localhost", "ionic://localhost"] or
      origin in Application.fetch_env!(:cascade_elixir, :allowed_origins)
  end

  @doc false
  def peer_key(%Plug.Conn{remote_ip: remote_ip} = conn) do
    fallback = remote_ip |> :inet.ntoa() |> to_string()
    hops = Application.fetch_env!(:cascade_elixir, :trust_proxy_hops)

    if hops > 0 do
      conn
      |> get_req_header("x-forwarded-for")
      |> List.first()
      |> forwarded_address(hops)
      |> case do
        nil -> fallback
        address -> address
      end
    else
      fallback
    end
  end

  defp forwarded_address(nil, _hops), do: nil

  defp forwarded_address(value, hops) do
    candidate =
      value
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1)
      |> Enum.reverse()
      |> Enum.at(hops - 1)

    case candidate && :inet.parse_address(String.to_charlist(candidate)) do
      {:ok, address} -> address |> :inet.ntoa() |> to_string()
      _ -> nil
    end
  end

  defp landing_csp(true),
    do: String.replace(@app_csp, "script-src 'self'", "script-src 'self' 'unsafe-inline'")

  defp landing_csp(false), do: @app_csp
end
