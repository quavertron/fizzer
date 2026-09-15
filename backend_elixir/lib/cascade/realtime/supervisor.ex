defmodule Cascade.Realtime.Supervisor do
  @moduledoc "Supervision tree for native Engine.IO sessions and room membership."
  use Supervisor

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    presence_opts =
      opts
      |> Keyword.put_new(:refresh, &Cascade.Realtime.Events.emit_presence_now(&1, &2, :dispatcher))
      |> Keyword.put_new(:refresh_channel, &Cascade.Realtime.Events.emit_presence_for_channel_now(&1, :dispatcher))

    children = [
      {Registry, keys: :unique, name: Cascade.Realtime.Registry},
      {DynamicSupervisor, strategy: :one_for_one, name: Cascade.Realtime.SessionSupervisor},
      {Cascade.Realtime.Hub, opts},
      {Task.Supervisor, name: Cascade.Realtime.PresenceTaskSupervisor},
      {Cascade.Realtime.PresenceDispatcher, presence_opts}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end
end
