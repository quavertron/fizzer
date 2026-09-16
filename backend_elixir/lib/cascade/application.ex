defmodule Cascade.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        Cascade.DB.Repo,
        Cascade.DB.WriteCoordinator,
        Cascade.DB.Bootstrap,
        Cascade.DomainBootstrap,
        Cascade.Realtime.OrderedPublisher,
        Cascade.Runs.Supervisor,
        Cascade.Realtime.VerifiedTokenCache,
        Cascade.Realtime.AuthBatcher,
        CascadeWeb.RateLimiter
      ] ++
        qmd_children() ++
        [{Cascade.Realtime.Supervisor, runner_callbacks: Cascade.Runs.RunnerLifecycle}] ++
        dispatch_children() ++ http_children()

    # Every child after the repository and write coordinator depends on their
    # current instances. Restart the downstream edge before replacing either
    # dependency so an in-flight writer cannot retain a stale lock lease while
    # a replacement coordinator grants another one.
    Supervisor.start_link(children, strategy: :rest_for_one, name: Cascade.Supervisor)
  end

  defp qmd_children do
    if Application.fetch_env!(:cascade_elixir, :qmd_worker_enabled),
      do: [Cascade.Search.QMD.Worker],
      else: []
  end

  defp dispatch_children do
    if Application.fetch_env!(:cascade_elixir, :dispatch_worker_enabled),
      do: [Cascade.Missions.DispatchReannouncer],
      else: []
  end

  defp http_children do
    if Application.fetch_env!(:cascade_elixir, :server) do
      acceptors = Application.fetch_env!(:cascade_elixir, :http_acceptors)
      max_connections = Application.fetch_env!(:cascade_elixir, :http_max_connections)
      backlog = Application.fetch_env!(:cascade_elixir, :http_backlog)
      connections_per_acceptor = div(max_connections + acceptors - 1, acceptors)

      [
        {Bandit,
         plug: CascadeWeb.Router,
         scheme: :http,
         ip: Application.fetch_env!(:cascade_elixir, :bind_ip),
         port: Application.fetch_env!(:cascade_elixir, :port),
         thousand_island_options: [
           num_acceptors: acceptors,
           num_connections: connections_per_acceptor,
           transport_options: [backlog: backlog]
         ]}
      ]
    else
      []
    end
  end
end
