defmodule CascadeWeb.MirrorRouter do
  @moduledoc "Read-only HTTP directory source for rclone vault mirrors."
  use CascadeWeb.DomainDispatch
  alias Cascade.Content.Store
  alias CascadeWeb.{Auth, JSON}

  plug :match
  plug :dispatch

  get "/api/vaults/:id/mirror/*segments", do: download(conn, id, segments)
  head "/api/vaults/:id/mirror/*segments", do: download(conn, id, segments)
  match _, do: JSON.send(conn, 404, %{error: "Not found"})

  defp download(conn, id, segments) do
    with {:ok, conn} <- Auth.require(conn, access: :user) do
      # A filesystem mirror includes unlisted files, so require write-level vault access.
      if Store.vault_role(id, conn.assigns.current_user.id) in ["owner", "editor"] do
        vault = Store.get_vault(id, conn.assigns.current_user.id)

        with {:ok, path, stat} <- resolve(vault.root_path, segments) do
          conn = put_resp_header(conn, "cache-control", "no-store")

          case stat.type do
            :directory -> listing(conn, path)
            :regular -> file(conn, path, stat)
          end
        else
          _ -> JSON.send(conn, 404, %{error: "Not found"})
        end
      else
        JSON.send(conn, 403, %{error: "Vault write access required"})
      end
    else
      {:error, conn} -> conn
    end
  end

  defp visible?(name) do
    name not in ["", ".", ".."] and not String.contains?(name, ["/", "\\", <<0>>]) and
      not String.contains?(name, [".alock-", ".pending-"])
  end

  defp resolve(root, segments) do
    # Check each component with lstat: never follow vault symlinks.
    Enum.reduce_while(segments, {:ok, root, File.lstat(root)}, fn segment,
                                                                  {:ok, parent, parent_stat} ->
      if visible?(segment) and match?({:ok, %{type: :directory}}, parent_stat) do
        path = Path.join(parent, segment)

        case File.lstat(path) do
          {:ok, %{type: type} = stat} when type in [:regular, :directory] ->
            {:cont, {:ok, path, {:ok, stat}}}

          _ ->
            {:halt, {:error, :invalid}}
        end
      else
        {:halt, {:error, :invalid}}
      end
    end)
    |> case do
      {:ok, path, {:ok, %{type: type} = stat}} when type in [:regular, :directory] ->
        {:ok, path, stat}

      _ ->
        {:error, :invalid}
    end
  end

  defp listing(conn, path) do
    with {:ok, names} <- File.ls(path) do
      links =
        for name <- Enum.sort(names),
            visible?(name),
            {:ok, stat} <- [File.lstat(Path.join(path, name))],
            stat.type in [:regular, :directory] do
          href =
            URI.encode(name, &URI.char_unreserved?/1) <>
              if(stat.type == :directory, do: "/", else: "")

          "<a href=\"#{href}\">#{href}</a>\n"
        end

      conn
      |> put_resp_content_type("text/html")
      |> send_resp(200, ["<!doctype html><body>\n", links, "</body>"])
    else
      _ -> JSON.send(conn, 503, %{error: "Cannot list vault"})
    end
  end

  defp file(conn, path, stat) do
    conn =
      conn
      |> put_resp_content_type("application/octet-stream")
      |> put_resp_header("last-modified", stat.mtime |> :httpd_util.rfc1123_date() |> to_string())
      |> put_resp_header("content-length", Integer.to_string(stat.size))

    if conn.method == "HEAD", do: send_resp(conn, 200, ""), else: send_file(conn, 200, path)
  end
end
