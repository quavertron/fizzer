defmodule Cascade.Missions.DispatchReannouncer do
  @moduledoc "Starts durable chat dispatches independently of browsers, one job per session."

  use GenServer
  require Logger

  alias Cascade.Missions.Dispatches
  alias CascadeWeb.OrchestrationController

  @default_interval 1_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

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
       interval: Keyword.get(opts, :interval, @default_interval),
       jobs: %{},
       scheduled: false,
       recover_missions_at: 0
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
    pending = Dispatches.pending() |> Enum.group_by(& &1.group, & &1.id)

    now = System.monotonic_time(:millisecond)
    recover = state.recover_missions_at == 0 or now >= state.recover_missions_at
    pending = if recover, do: Map.put(pending, :missions, []), else: pending

    jobs =
      Enum.reduce(pending, state.jobs, fn {group, ids}, jobs ->
        if Map.has_key?(jobs, group) do
          jobs
        else
          {pid, ref} =
            :erlang.spawn_opt(
              fn ->
                if group == :missions,
                  do: recover_missions(),
                  else: drain(ids)
              end,
              [:link, :monitor]
            )

          Map.put(jobs, group, {pid, ref})
        end
      end)

    {:noreply,
     %{
       state
       | jobs: jobs,
         scheduled: false,
         recover_missions_at: if(recover, do: now + 10_000, else: state.recover_missions_at)
     }}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    if reason != :normal,
      do: Logger.warning("Chat dispatch startup interrupted: #{inspect(reason)}")

    jobs = Map.reject(state.jobs, fn {_group, {_pid, monitor}} -> monitor == ref end)
    {:noreply, %{state | jobs: jobs}}
  end

  def handle_info({:EXIT, _pid, _reason}, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    Enum.each(state.jobs, fn {_group, {pid, _ref}} -> Process.exit(pid, :kill) end)
  end

  def recover_missions do
    Cascade.Accounts.SQL.all(
      "SELECT id,created_by FROM chat_missions WHERE status NOT IN ('completed','canceled')"
    )
    |> Enum.each(fn [mission_id, owner_id] ->
      if Cascade.Runs.RunnerLifecycle.online?(owner_id),
        do: Cascade.Missions.Scheduler.schedule(mission_id, events: Cascade.Realtime.Events)
    end)
  end

  defp drain(ids) do
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
