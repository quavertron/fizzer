defmodule Cascade.Runs.TransportCallbacks do
  @moduledoc "Connects runner transport events to dispatch wake-ups and durable disconnect handling."
  @behaviour Cascade.Realtime.RunnerCallbacks

  # DomainAdapter already committed registration/reclaim before Hub invokes
  # this callback. Waking the outbox must not register the runner a second time.
  @impl true
  def registered(_owner_id, _sid, _metadata, _previous),
    do: Cascade.Missions.DispatchReannouncer.wake()

  @impl true
  defdelegate disconnected(owner_id, sid, metadata, reason), to: Cascade.Runs.RunnerLifecycle
end
