defmodule CascadeWeb.Static do
  @moduledoc "Vite asset and SPA serving with the current cache-control contract."

  # These contracts are implemented by the safe static/SPA fallback rather
  # than Plug.Router macros, so the parity extractor records them explicitly.
  # parity-route GET /
  # parity-route GET /download
  # parity-route GET *

  import Plug.Conn

  @one_year_seconds 365 * 24 * 60 * 60
  @reserved_prefixes ["/api/", "/socket.io/", "/p/"]

  def serve(conn) do
    root = Application.fetch_env!(:cascade_elixir, :client_dist_dir) |> Path.expand()
    beta_root = Application.get_env(:cascade_elixir, :beta_client_dist_dir)

    cond do
      reserved?(conn.request_path) ->
        :not_found

      beta_root && beta_request?(conn.request_path) ->
        serve_asset_or_app(conn, Path.expand(beta_root), beta_relative(conn.path_info))

      conn.request_path in ["/", "/download"] ->
        serve_landing_or_app(conn, root)

      match?([_, _], Regex.run(~r<^/vault/([a-fA-F0-9]{8})$>, conn.request_path)) ->
        [_, hex] = Regex.run(~r<^/vault/([a-fA-F0-9]{8})$>, conn.request_path)
        upper = String.upcase(hex)

        if hex != upper do
          qs = if conn.query_string != "", do: "?" <> conn.query_string, else: ""

          redirected =
            conn
            |> put_resp_header("location", "/vault/" <> upper <> qs)
            |> send_resp(301, "")
            |> halt()

          {:served, redirected}
        else
          serve_app(conn, root)
        end

      conn.request_path == "/vault" or String.starts_with?(conn.request_path, "/vault/") ->
        :not_found

      true ->
        serve_asset_or_app(conn, root)
    end
  end

  def cache_control(path) do
    normalized = String.replace(path, "\\", "/")

    cond do
      String.contains?(normalized, "/assets/") ->
        "public, max-age=#{@one_year_seconds}, immutable"

      Path.basename(normalized) == "version.json" ->
        "no-store"

      String.ends_with?(normalized, ".html") ->
        "no-cache"

      true ->
        nil
    end
  end

  defp serve_landing_or_app(conn, root) do
    case safe_regular_file(root, "landing.html") do
      {:ok, path} -> send_static(conn, path)
      :error -> serve_app(conn, root)
    end
  end

  defp serve_asset_or_app(conn, root, relative \\ nil) do
    relative = relative || Enum.join(conn.path_info, "/")

    case safe_regular_file(root, relative) do
      {:ok, path} -> send_static(conn, path)
      :error -> serve_app(conn, root)
    end
  end

  defp serve_app(conn, root) do
    case safe_regular_file(root, "app.html") do
      {:ok, path} -> send_static(conn, path)
      :error -> :not_found
    end
  end

  defp send_static(conn, path) do
    conn =
      conn
      |> put_resp_content_type(MIME.from_path(path))
      |> maybe_put_cache(path)

    conn =
      if Path.basename(path) == "app.html" do
        origin = Cascade.Publishing.public_base_url(conn)
        csp = conn |> get_resp_header("content-security-policy") |> List.first() || ""
        put_resp_header(conn, "content-security-policy", String.replace(csp, "frame-src ", "frame-src #{origin}/api/html-previews/ "))
      else
        conn
      end

    conn =
      if Path.basename(path) == "app.html" and Cascade.Chat.Voice.enabled?() do
        put_resp_header(conn, "permissions-policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()")
      else
        conn
      end

    {:served, send_file(conn, 200, path)}
  end

  defp maybe_put_cache(conn, path) do
    case cache_control(path) do
      nil -> conn
      value -> put_resp_header(conn, "cache-control", value)
    end
  end

  defp safe_regular_file(root, relative) do
    candidate = Path.expand(relative, root)

    if within_root?(candidate, root) and File.regular?(candidate) do
      {:ok, candidate}
    else
      :error
    end
  end

  defp within_root?(candidate, root),
    do: candidate == root or String.starts_with?(candidate, root <> "/")

  defp beta_request?(path), do: path == "/beta" or String.starts_with?(path, "/beta/")
  defp beta_relative(["beta" | rest]), do: Enum.join(rest, "/")
  defp beta_relative(_path), do: ""

  defp reserved?(path) do
    path == "/oembed" or Enum.any?(@reserved_prefixes, &String.starts_with?(path, &1))
  end
end
