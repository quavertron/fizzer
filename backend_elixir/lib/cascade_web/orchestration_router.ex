defmodule CascadeWeb.OrchestrationRouter do
  @moduledoc "Mountable native run, runner, work-item, and managed-agent HTTP surface."
  use CascadeWeb.DomainDispatch

  alias CascadeWeb.{JSON, OrchestrationController, OrchestrationRoutes}

  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["*/*"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  get "/api/vaults/:id/runs", do: OrchestrationController.list_runs(conn, id)
  post "/api/vaults/:id/runs", do: OrchestrationController.create_run(conn, id)
  get "/api/vaults/:id/active-sessions", do: OrchestrationController.active_sessions(conn, id)
  get "/api/me/active-sessions", do: OrchestrationController.my_active_sessions(conn)
  post "/api/me/active-sessions/stop", do: OrchestrationController.cancel_all_runs(conn)
  post "/api/local-agents", do: OrchestrationController.local_agents(conn)
  get "/api/runs/:id", do: OrchestrationController.get_run(conn, id)
  get "/api/runs/:id/events", do: OrchestrationController.run_events(conn, id)
  post "/api/runs/:id/cancel", do: OrchestrationController.cancel_run(conn, id)
  get "/api/me/desktop-runner", do: OrchestrationController.runner_status(conn)

  get "/api/vaults/:id/managed-agent/entitlement",
    do: OrchestrationController.managed_entitlement(conn, id)

  put "/api/vaults/:id/managed-agent/entitlement",
    do: OrchestrationController.update_managed_entitlement(conn, id)

  get "/api/vaults/:id/work-items", do: OrchestrationController.list_work_items(conn, id)
  post "/api/vaults/:id/work-items", do: OrchestrationController.create_work_item(conn, id)
  get "/api/work-items/:id", do: OrchestrationController.get_work_item(conn, id)
  patch "/api/work-items/:id", do: OrchestrationController.update_work_item(conn, id)
  put "/api/work-items/:id/git-state", do: OrchestrationController.report_git_state(conn, id)
  post "/api/work-items/:id/lease", do: OrchestrationController.lease_work_item(conn, id)
  post "/api/work-items/:id/release", do: OrchestrationController.release_work_item(conn, id)
  post "/api/work-items/:id/runs", do: OrchestrationController.link_work_item_run(conn, id)
  post "/api/work-items/:id/handoff", do: OrchestrationController.handoff_work_item(conn, id)
  post "/api/work-items/:id/reviews", do: OrchestrationController.review_work_item(conn, id)
  post "/api/work-items/:id/stop", do: OrchestrationController.stop_work_item(conn, id)

  match _ do
    JSON.send(conn, 404, %{error: "Not found", routes: OrchestrationRoutes.count()})
  end
end
