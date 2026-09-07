defmodule CascadeWeb.ExtendedContentRouter do
  @moduledoc "Isolated router; mount before the original content router and invite oEmbed fallback."

  use CascadeWeb.DomainDispatch

  alias CascadeWeb.{ExtendedContentController, JSON}

  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  get "/p/:slug.json", do: ExtendedContentController.public_json(conn, slug)
  get "/p/:slug", do: ExtendedContentController.public_page(conn, slug)
  get "/oembed", do: ExtendedContentController.oembed(conn)

  get "/api/notes/:id/publish", do: ExtendedContentController.get_publish(conn, id)
  post "/api/notes/:id/publish", do: ExtendedContentController.publish(conn, id)
  delete "/api/notes/:id/publish", do: ExtendedContentController.unpublish(conn, id)

  get "/api/vaults/:id/search", do: ExtendedContentController.search(conn, id)

  post "/api/vaults/:id/scratchpad/journal",
    do: ExtendedContentController.append_journal(conn, id)

  get "/api/vaults/:id/scratchpad/journal", do: ExtendedContentController.list_journal(conn, id)

  post "/api/vaults/:id/scratchpad/consolidate",
    do: ExtendedContentController.consolidate(conn, id)

  get "/api/vaults/:id/scratchpad/status",
    do: ExtendedContentController.scratchpad_status(conn, id)

  get "/api/vaults/:id/scratchpad/threads", do: ExtendedContentController.list_threads(conn, id)
  post "/api/vaults/:id/scratchpad/threads", do: ExtendedContentController.open_thread(conn, id)

  post "/api/vaults/:id/scratchpad/threads/:threadId/close",
    do: ExtendedContentController.close_thread(conn, id, threadId)

  post "/api/vaults/:id/scratchpad/skills", do: ExtendedContentController.create_skill(conn, id)
  get "/api/vaults/:id/scratchpad/skills", do: ExtendedContentController.list_skills(conn, id)
  post "/api/vaults/:id/scratchpad/outcome", do: ExtendedContentController.outcome(conn, id)
  post "/api/vaults/:id/scratchpad/promote", do: ExtendedContentController.promote(conn, id)
  get "/api/vaults/:id/scratchpad/recall", do: ExtendedContentController.recall(conn, id)

  post "/api/vaults/:id/chat-backlinks/backfill",
    do: ExtendedContentController.backfill_backlinks(conn, id)

  post "/api/vaults/:vaultId/channels/:channelId/distill",
    do: ExtendedContentController.distill(conn, vaultId, channelId)

  get "/api/vaults/:id/wiki-maintenance", do: ExtendedContentController.wiki_maintenance(conn, id)

  put "/api/vaults/:id/wiki-maintenance",
    do: ExtendedContentController.configure_wiki_maintenance(conn, id)

  get "/api/vaults/:id/agent-memory", do: ExtendedContentController.get_agent_memory(conn, id)
  put "/api/vaults/:id/agent-memory", do: ExtendedContentController.update_agent_memory(conn, id)

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end
end
