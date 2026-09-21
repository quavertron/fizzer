defmodule Cascade.Auth.Session do
  @moduledoc "Bearer/cookie authentication with server-side auth-version revocation."

  import Plug.Conn

  alias Cascade.Auth.{Accounts, Token}

  @secure_cookie "__Host-cascade_session"
  @local_cookie "cascade_session"
  @renewal_window_seconds 3 * 24 * 60 * 60

  def authenticate(conn, options \\ []) do
    conn = fetch_cookies(conn)

    candidates =
      [bearer_candidate(conn), cookie_candidate(conn)]
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq_by(&elem(&1, 1))

    Enum.find_value(candidates, {:error, :invalid_or_expired}, &verify_candidate(&1, options))
  end

  def cookie_token(conn) do
    conn = fetch_cookies(conn)
    conn.req_cookies[@secure_cookie] || conn.req_cookies[@local_cookie]
  end

  def put_user_cookie(conn, token) do
    name = if Cascade.Config.network_mode?(), do: @secure_cookie, else: @local_cookie

    secure =
      if Cascade.Config.network_mode?(), do: ["Secure", "SameSite=None"], else: ["SameSite=Lax"]

    cookie =
      [
        "#{name}=#{URI.encode_www_form(token)}",
        "Path=/",
        "HttpOnly"
      ] ++
        secure ++
        ["Max-Age=#{Token.user_session_max_age_seconds()}", "Priority=High"]

    put_resp_header(conn, "set-cookie", Enum.join(cookie, "; "))
  end

  def clear_user_cookies(conn) do
    secure = "#{@secure_cookie}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0"
    local = "#{@local_cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    conn
    |> put_resp_header("set-cookie", secure)
    |> prepend_resp_headers([{"set-cookie", local}])
  end

  def maybe_renew_user_cookie(
        conn,
        %{source: :cookie, access: "user", expires_at: expires_at, user: user}
      )
      when is_integer(expires_at) do
    if expires_at - System.system_time(:second) <= @renewal_window_seconds,
      do: put_user_cookie(conn, Token.sign_user(user)),
      else: conn
  end

  def maybe_renew_user_cookie(conn, _session), do: conn

  def bearer?(conn), do: bearer_candidate(conn) != nil

  defp bearer_candidate(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> {:bearer, token}
      _ -> nil
    end
  end

  defp cookie_candidate(conn) do
    case cookie_token(conn) do
      nil -> nil
      token -> {:cookie, token}
    end
  end

  defp verify_candidate({source, token}, options) do
    with {:ok, claims, expires_at} <- Token.verify_with_expiration(token, options),
         {:ok, user} <- Accounts.fetch_by_id(claims.id),
         true <- user.username == claims.username,
         true <- user.auth_version == claims.auth_version do
      {:ok,
       %{
         source: source,
         token: token,
         user: user,
         access: claims.access,
         agent_source: claims.agent_source,
         expires_at: expires_at
       }}
    else
      _ -> false
    end
  end
end
