defmodule CascadeWeb.Router do
  @moduledoc false

  use Plug.Router

  alias Cascade.DB.Repo
  alias CascadeWeb.{AuthController, DomainDispatch, JSON, SocketIOPlug, Static}

  def domains do
    [
      {CascadeWeb.MirrorRouter, CascadeWeb.MirrorRouter},
      {CascadeWeb.AlockRouter, CascadeWeb.AlockRouter},
      {CascadeWeb.SystemRoutes, CascadeWeb.SystemRouter},
      {CascadeWeb.AccountRoutes, CascadeWeb.AccountRouter,
       Cascade.Realtime.Events.account_options() ++
         [public_base_url: &Cascade.Publishing.public_base_url/1]},
      {CascadeWeb.ChatRoutes, CascadeWeb.ChatRouter,
       Cascade.Realtime.Events.chat_options() ++
         [public_base_url: &Cascade.Publishing.public_base_url/1]},
      {CascadeWeb.MissionRoutes, CascadeWeb.MissionRouter,
       events: Cascade.Realtime.Events, cancel_run: &Cascade.Runs.Store.cancel/2},
      {CascadeWeb.OrchestrationRoutes, CascadeWeb.OrchestrationRouter},
      {CascadeWeb.ExtendedContentRoutes, CascadeWeb.ExtendedContentRouter},
      {CascadeWeb.ContentRoutes, CascadeWeb.ContentRouter,
       Cascade.Realtime.Events.content_options()}
    ]
  end

  plug Plug.RequestId
  plug CascadeWeb.Security
  plug :normalize_vault_routes
  plug :match

  @login_parser Plug.Parsers.init(
                  parsers: [:json],
                  pass: ["*/*"],
                  json_decoder: Jason,
                  length: 12 * 1_024 * 1_024
                )

  plug :dispatch

  get "/api/health" do
    case Repo.healthcheck() do
      :ok -> JSON.send(conn, 200, %{status: "ok"})
      {:error, _reason} -> JSON.send(conn, 503, %{status: "unavailable"})
    end
  end

  post "/api/auth/login" do
    conn |> Plug.Parsers.call(@login_parser) |> AuthController.login()
  end

  post "/api/auth/logout", do: AuthController.logout(conn)
  get "/api/session", do: AuthController.session(conn)
  get "/api/me", do: AuthController.me(conn)

  match "/socket.io/*_path" do
    SocketIOPlug.call(
      conn,
      SocketIOPlug.init(
        domain: Cascade.Realtime.DomainAdapter,
        max_sessions: 20_000,
        max_queue_packets: 256,
        max_queue_bytes: 1_000_000,
        max_mailbox: 512,
        max_pending_acks: 128
      )
    )
  end

  match _ do
    case dispatch_domain(conn) do
      {:handled, conn} ->
        conn

      {:database_unavailable, _reason} ->
        JSON.send(conn, 503, %{error: "Database is temporarily unavailable"})

      :not_found ->
        if String.starts_with?(conn.request_path, "/api/") do
          JSON.send(conn, 404, %{error: "Not found"})
        else
          case Static.serve(conn) do
            {:served, conn} -> conn
            :not_found -> JSON.send(conn, 404, %{error: "Not found"})
          end
        end
    end
  end

  defp dispatch_domain(conn) do
    DomainDispatch.dispatch(conn, domains())
  rescue
    error in [DBConnection.ConnectionError, Exqlite.Error] ->
      {:database_unavailable, Exception.message(error)}
  end

  defp normalize_vault_routes(%Plug.Conn{path_info: ["api", "vault", hex | rest]} = conn, _opts) do
    if Regex.match?(~r/^[A-Fa-f0-9]{8}$/, hex) do
      upper = String.upcase(hex)
      canonical_id = Cascade.Content.Store.resolve_vault_id(upper)
      new_path_info = ["api", "vaults", canonical_id | rest]
      new_request_path = "/api/vaults/" <> Enum.join([canonical_id | rest], "/")
      %{conn | path_info: new_path_info, request_path: new_request_path}
    else
      conn
    end
  end

  defp normalize_vault_routes(%Plug.Conn{path_info: ["api", "vault"]} = conn, _opts) do
    %{conn | path_info: ["api", "vaults"], request_path: "/api/vaults"}
  end

  defp normalize_vault_routes(conn, _opts), do: conn
end
