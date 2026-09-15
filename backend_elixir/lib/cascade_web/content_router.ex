defmodule CascadeWeb.ContentRouter do
  @moduledoc "Isolated Plug router for the content domain; mount before the main API catch-all."

  use CascadeWeb.DomainDispatch

  alias CascadeWeb.{ContentController, JSON}

  plug :put_domain_options
  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason,
    length: 96 * 1_024 * 1_024

  plug :dispatch

  get "/api/vaults", do: ContentController.list_vaults(conn)
  post "/api/vaults", do: ContentController.create_vault(conn)
  get "/api/vaults/:id", do: ContentController.get_vault(conn, id)
  patch "/api/vaults/:id", do: ContentController.rename_vault(conn, id)
  delete "/api/vaults/:id", do: ContentController.delete_vault(conn, id)

  get "/api/vaults/:id/folders", do: ContentController.list_folders(conn, id)
  post "/api/vaults/:id/folders", do: ContentController.create_folder(conn, id)
  patch "/api/folders/:id", do: ContentController.update_folder(conn, id)
  delete "/api/folders/:id", do: ContentController.delete_folder(conn, id)

  get "/api/vaults/:id/notes", do: ContentController.list_notes(conn, id)
  post "/api/vaults/:id/notes", do: ContentController.create_note(conn, id)
  get "/api/notes/:id", do: ContentController.get_note(conn, id)
  put "/api/notes/:id", do: ContentController.update_note(conn, id)
  post "/api/notes/:id/orbit-caption", do: ContentController.append_orbit_caption(conn, id)
  post "/api/notes/:id/rename", do: ContentController.rename_note(conn, id)
  delete "/api/notes/:id", do: ContentController.delete_note(conn, id)
  post "/api/notes/:id/move", do: ContentController.move_note(conn, id)
  post "/api/notes/:id/unlist", do: ContentController.unlist_note(conn, id)
  post "/api/notes/:id/pin", do: ContentController.pin_note(conn, id)
  post "/api/notes/:id/archive", do: ContentController.archive_note(conn, id)

  post "/api/notes/:id/assets", do: ContentController.upload_asset(conn, id)
  get "/api/notes/:id/assets/:assetId", do: ContentController.serve_asset(conn, id, assetId)
  get "/api/html-previews/:id/:assetId", do: ContentController.preview_html(conn, id, assetId)

  get "/api/notes/:id/backlinks", do: ContentController.backlinks(conn, id)
  get "/api/vaults/:id/tags", do: ContentController.list_tags(conn, id)
  post "/api/notes/:id/tags", do: ContentController.add_tag(conn, id)
  delete "/api/notes/:id/tags/:tagId", do: ContentController.remove_tag(conn, id, tagId)
  get "/api/notes/:id/versions", do: ContentController.versions(conn, id)
  get "/api/notes/:id/diff", do: ContentController.diff(conn, id)
  get "/api/vaults/:id/graph", do: ContentController.graph(conn, id)

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end

  defp put_domain_options(%{assigns: %{domain_options: _}} = conn, _compiled), do: conn
  defp put_domain_options(conn, options), do: Plug.Conn.assign(conn, :domain_options, options)
end
