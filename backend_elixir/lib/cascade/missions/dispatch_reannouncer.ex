defmodule Cascade.Missions.DispatchReannouncer do
  @moduledoc "Starts durable dispatches in bounded jobs, serialized per agent session."
  use GenServer
  require Logger

  alias Cascade.Accounts.SQL
  alias Cascade.Missions.{Dispatches, Recovery, Scheduler, Steering}
  alias Cascade.Runs.RunnerLifecycle
  alias CascadeWeb.OrchestrationController

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def wake do
    if pid = Process.whereis(__MODULE__), do: send(pid, :wake)
    :ok
  end

  @impl true
  def init(opts) do
    Process.flag(:trap_exit, true)
    send(self(), :tick)

    {:ok,
     %{
       interval: Keyword.get(opts, :interval, 1_000),
       max_jobs: Keyword.get(opts, :max_jobs, 32),
       jobs: %{},
       cursor: 0,
       scheduled: false,
       recover_at: nil,
       maintenance: %{}
     }}
  end

  @impl true
  def handle_info(:tick, state) do
    Process.send_after(self(), :tick, state.interval)
    send(self(), :wake)
    {:noreply, state}
  end

  def handle_info(:wake, %{scheduled: true} = state), do: {:noreply, state}

  def handle_info(:wake, state) do
    Process.send_after(self(), :dispatch, 10)
    {:noreply, %{state | scheduled: true}}
  end

  def handle_info(:dispatch, state) do
    now = System.monotonic_time(:millisecond)
    recover = is_nil(state.recover_at) or now >= state.recover_at

    if recover, do: Cascade.Chat.Continuations.reconcile()

    maintenance =
      if recover, do: Map.merge(state.maintenance, mission_jobs()), else: state.maintenance

    # Offline outbox rows stay untouched, including during maintenance cutover.
    # Runner registration wakes the queue after the owner can actually execute.
    pending =
      Dispatches.pending()
      |> Enum.filter(&RunnerLifecycle.online?(&1.owner))
      |> Enum.group_by(&{:dispatch, &1.group}, & &1.id)

    deliveries =
      Cascade.Runs.Store.pending_deliveries()
      |> Enum.filter(fn {_id, owner} -> RunnerLifecycle.online?(owner) end)
      |> Map.new(fn {id, owner} -> {{:delivery, id}, owner} end)

    entries = pending |> Map.merge(maintenance) |> Map.merge(deliveries) |> Enum.sort()
    offset = if entries == [], do: 0, else: rem(state.cursor, length(entries))
    {before, after_offset} = Enum.split(entries, offset)

    {jobs, maintenance} =
      Enum.reduce(after_offset ++ before, {state.jobs, maintenance}, fn {key, args},
                                                                        {jobs, maintenance} ->
        cond do
          Map.has_key?(jobs, key) ->
            {jobs, Map.delete(maintenance, key)}

          map_size(jobs) >= state.max_jobs ->
            {jobs, maintenance}

          true ->
            {pid, ref} = :erlang.spawn_opt(fn -> perform(key, args) end, [:link, :monitor])
            {Map.put(jobs, key, {pid, ref}), Map.delete(maintenance, key)}
        end
      end)

    {:noreply,
     %{
       state
       | jobs: jobs,
         maintenance: maintenance,
         cursor: offset + 1,
         scheduled: false,
         recover_at: if(recover, do: now + 10_000, else: state.recover_at)
     }}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    if reason != :normal,
      do: Logger.warning("Chat dispatch startup interrupted: #{inspect(reason)}")

    jobs = Map.reject(state.jobs, fn {_key, {_pid, monitor}} -> monitor == ref end)
    {:noreply, %{state | jobs: jobs}}
  end

  def handle_info({:EXIT, _pid, _reason}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.jobs, fn {_key, {pid, _ref}} -> Process.exit(pid, :kill) end)
  end

  defp mission_jobs do
    SQL.all("""
    SELECT id,created_by FROM chat_missions m
    WHERE status NOT IN ('completed','canceled') OR (status='completed' AND EXISTS (
      SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.stopped=0
        AND (i.pending_fingerprint<>'' OR i.publication_pending IS NOT NULL
          OR json_extract(i.state_json,'$.executionCompleted') IS NOT 1
          OR EXISTS (SELECT 1 FROM json_each(i.state_json,'$.commitments') c
            WHERE json_extract(c.value,'$.status')='open')))) OR EXISTS (
      SELECT 1 FROM chat_mission_tasks t JOIN runs r ON r.id=t.run_id
      WHERE t.mission_id=m.id AND t.status='canceled' AND r.status IN ('queued','running'))
    """)
    |> Map.new(fn [id, owner] -> {{:mission, id}, owner} end)
  end

  defp perform({:delivery, id}, owner), do: RunnerLifecycle.replay_delivery(id, owner)

  defp perform({:mission, id}, owner) do
    Recovery.replay_cancellations(&RunnerLifecycle.cancel(&1, &2, 2_000), id)
    Steering.replay(id)
    if RunnerLifecycle.online?(owner), do: Scheduler.schedule(id, events: Cascade.Realtime.Events)
  end

  defp perform({:dispatch, _session}, ids) do
    Enum.each(ids, &OrchestrationController.prepare_dispatch/1)

    Enum.reduce_while(ids, :ok, fn id, _ ->
      case OrchestrationController.execute_dispatch(id) do
        {:busy, reason} ->
          Dispatches.retry(id, reason)
          {:cont, :ok}

        {:retry, reason} ->
          Dispatches.retry(id, reason)
          {:halt, :ok}

        {:error, reason} ->
          Dispatches.fail(id, reason)
          {:cont, :ok}

        _ ->
          {:cont, :ok}
      end
    end)
  end
end
