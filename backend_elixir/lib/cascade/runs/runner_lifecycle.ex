defmodule Cascade.Runs.RunnerLifecycle do
  @moduledoc "Durable desktop-runner presence, reclaim, delegation, and ACK lifecycle."
  use GenServer

  @behaviour Cascade.Realtime.RunnerCallbacks

  alias Cascade.Realtime.Hub
  alias Cascade.Runs.Store

  @orphan_reclaim 120_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def register(owner_id, sid, metadata),
    do: GenServer.call(__MODULE__, {:register, owner_id, sid, normalize_metadata(metadata)})

  def report_plan_usage(owner_id, usage),
    do: GenServer.cast(__MODULE__, {:plan_usage, owner_id, clean_usage(usage)})

  def heartbeat(run_id, owner_id),
    do: GenServer.cast(__MODULE__, {:heartbeat, run_id, owner_id})

  def plan_usage(owner_id), do: GenServer.call(__MODULE__, {:plan_usage, owner_id})

  def health(owner_id) do
    base = GenServer.call(__MODULE__, {:health, owner_id})
    %{base | online: online?(owner_id), activeRuns: Store.active_delegated_count(owner_id)}
  end

  def online?(owner_id) do
    case Hub.runner(owner_id) do
      {:ok, %{sid: sid}} -> match?({:ok, _pid}, Cascade.Realtime.lookup(sid))
      :error -> false
    end
  rescue
    _ -> false
  end

  def wait_online(owner_id, timeout_ms \\ 6_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    wait_online_until(owner_id, deadline)
  end

  def delegate(owner_id, payload) when is_map(payload) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, _pid} <- Cascade.Realtime.lookup(sid),
         run_id when is_integer(run_id) <- field(payload, :runId) do
      if Store.record_delegated(run_id, owner_id, payload) == :ok do
        Cascade.Realtime.emit(sid, "/runners", "run:delegate", [payload])
        true
      else
        false
      end
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  def replay_delivery(run_id, owner_id) do
    if online?(owner_id) do
      case Store.pending_delivery(run_id, owner_id) do
        [_payload, attempts] when attempts >= 5 ->
          summary =
            "Desktop did not confirm run delivery after five attempts; no worker startup was observed."

          Store.finish(run_id, "failed", summary)
          Store.publish(run_id, "status", %{status: "failed", summary: summary})

        [payload, _] ->
          delegate(owner_id, Jason.decode!(payload))

        nil ->
          :ok
      end
    end
  end

  def cancel(owner_id, run_id, timeout \\ 15_000) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, replies} <-
           Cascade.Realtime.emit_with_ack(
             sid,
             "/runners",
             "run:cancel",
             [%{runId: run_id}],
             timeout
           ),
         response when is_map(response) <- List.first(replies),
         true <- field(response, :success) == true do
      true
    else
      _ -> false
    end
  end

  # User Stop must not block on the runner ACK (up to 15s). Still emit with an
  # acknowledgement id so desktop/preflight runners can reply; we just don't wait.
  def request_cancel(owner_id, run_id) do
    case Hub.runner(owner_id) do
      {:ok, %{sid: sid}} ->
        _ =
          Task.start(fn ->
            Cascade.Realtime.emit_with_ack(
              sid,
              "/runners",
              "run:cancel",
              [%{runId: run_id}],
              2_000
            )
          end)

        true

      _ ->
        false
    end
  end

  def prepare_workspace(owner_id, payload, timeout \\ 30_000) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, replies} <-
           Cascade.Realtime.emit_with_ack(
             sid,
             "/runners",
             "workspace:prepare",
             [payload],
             timeout
           ),
         response when is_map(response) <- List.first(replies),
         true <- field(response, :ok) == true,
         {:ok, prepared} <- complete_workspace(response) do
      {:ok, prepared}
    else
      {:error, _} = error -> error
      _ -> {:error, "Desktop workspace preparation failed"}
    end
  end

  def accept_event?(run_id, owner_id), do: Store.delegated_owner(run_id) == owner_id

  @impl true
  # DomainAdapter owns registration because its reclaimed IDs are part of the
  # runner:registered response. Hub owns transport replacement and invokes this
  # callback only after that domain action has already committed.
  def registered(_owner_id, _sid, _metadata, _previous),
    do: Cascade.Missions.DispatchReannouncer.wake()

  @impl true
  def disconnected(owner_id, sid, _metadata, reason) do
    if Process.whereis(__MODULE__),
      do: GenServer.cast(__MODULE__, {:disconnected, owner_id, sid, reason}),
      else: :ok
  end

  @impl true
  def init(opts) do
    state = %{
      runners: %{},
      last_error: %{},
      plan_usage: %{},
      last_seen: %{},
      disconnect_timers: %{},
      run_leases: %{},
      orphan_reclaim: Keyword.get(opts, :orphan_reclaim_ms, @orphan_reclaim),
      run_lease: Keyword.get(opts, :run_lease_ms, @orphan_reclaim)
    }

    timer = Process.send_after(self(), :orphan_reclaim, state.orphan_reclaim)
    lease_timer = Process.send_after(self(), :lease_sweep, lease_sweep_ms(state.run_lease))
    {:ok, state |> Map.put(:orphan_timer, timer) |> Map.put(:lease_timer, lease_timer)}
  end

  @impl true
  def handle_call({:register, owner_id, sid, metadata}, _from, state) do
    active_ids = Map.get(metadata, :activeRunIds, [])
    previous = state.runners[owner_id]
    next_instance = Map.get(metadata, :runnerInstanceId, "")

    if conflicting_live_runner?(owner_id, previous, next_instance) do
      {:reply, {:error, :active_runner}, state}
    else
      register_runner(owner_id, sid, metadata, active_ids, previous, next_instance, state)
    end
  end

  def handle_call({:health, owner_id}, _from, state) do
    error = state.last_error[owner_id]

    {:reply,
     %{
       online: false,
       activeRuns: 0,
       lastError: error && error.message,
       lastErrorAt: error && error.at,
       lastSeenAt: state.last_seen[owner_id],
       planUsage: state.plan_usage[owner_id]
     }, state}
  end

  def handle_call({:plan_usage, owner_id}, _from, state),
    do: {:reply, state.plan_usage[owner_id] || %{}, state}

  defp register_runner(owner_id, sid, metadata, active_ids, previous, next_instance, state) do
    state = cancel_disconnect_timer(state, owner_id)

    reclaimed =
      active_ids
      |> Enum.filter(&(Store.delegated_owner(&1) == owner_id))
      |> Enum.uniq()

    previous_instance = previous && previous.instance_id

    state =
      if previous_instance not in [nil, ""] and next_instance != "" and
           previous_instance != next_instance do
        interrupted =
          Store.open_delegated()
          |> Enum.filter(&(&1.owner_user_id == owner_id and &1.run_id not in reclaimed))
          |> Enum.map(& &1.run_id)

        fail_runs(interrupted, "Desktop app restarted before this run completed.")

        if interrupted == [] do
          state
        else
          put_error(state, owner_id, "Desktop app restarted before this run completed.")
        end
      else
        state
      end

    now = iso_now()

    runner = %{
      sid: sid,
      instance_id: if(next_instance == "", do: previous_instance || "", else: next_instance),
      metadata: metadata
    }

    state = %{
      state
      | runners: Map.put(state.runners, owner_id, runner),
        last_seen: Map.put(state.last_seen, owner_id, now)
    }

    {:reply, {:ok, reclaimed}, state}
  end

  # Two desktop installations can be signed into the same account. A newcomer
  # must not be mistaken for a restart while the incumbent transport is still
  # alive and owns work; replacing it would disconnect the real runner and fail
  # its omitted runs with the misleading desktop-restarted summary.
  defp conflicting_live_runner?(owner_id, previous, next_instance) do
    previous_instance = previous && previous.instance_id

    previous_instance not in [nil, ""] and next_instance not in [nil, ""] and
      previous_instance != next_instance and incumbent_online?(owner_id, previous.sid) and
      Enum.any?(Store.open_delegated(), &(&1.owner_user_id == owner_id))
  end

  defp incumbent_online?(owner_id, sid) do
    match?({:ok, %{sid: ^sid}}, Hub.runner(owner_id)) and
      match?({:ok, _pid}, Cascade.Realtime.lookup(sid))
  rescue
    _ -> false
  end

  @impl true
  def handle_cast({:plan_usage, owner_id, usage}, state) do
    usage = merge_plan_usage(state.plan_usage[owner_id] || %{}, usage)

    {:noreply,
     %{
       state
       | plan_usage: Map.put(state.plan_usage, owner_id, usage),
         last_seen: Map.put(state.last_seen, owner_id, iso_now())
     }}
  end

  def handle_cast({:heartbeat, run_id, owner_id}, state) do
    if Store.delegated_owner(run_id) == owner_id do
      lease = %{owner_id: owner_id, touched_at: System.monotonic_time(:millisecond)}
      {:noreply, put_in(state, [:run_leases, run_id], lease)}
    else
      {:noreply, update_in(state.run_leases, &Map.delete(&1, run_id))}
    end
  end

  def handle_cast({:disconnected, owner_id, sid, _reason}, state) do
    # A Socket.IO disconnect only proves transport loss. Electron main owns the
    # child and buffers its events; keep the last instance metadata so a same-
    # instance reconnect can reclaim, while a changed instance can fail omitted
    # children authoritatively in register/3.
    case state.runners[owner_id] do
      %{sid: ^sid} ->
        state = cancel_disconnect_timer(state, owner_id)
        token = make_ref()

        timer =
          Process.send_after(
            self(),
            {:disconnect_expired, owner_id, sid, token},
            state.orphan_reclaim
          )

        {:noreply,
         put_in(state, [:disconnect_timers, owner_id], %{timer: timer, token: token, sid: sid})}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info({:disconnect_expired, owner_id, sid, token}, state) do
    case state.disconnect_timers[owner_id] do
      %{sid: ^sid, token: ^token} ->
        state = update_in(state.disconnect_timers, &Map.delete(&1, owner_id))

        if online?(owner_id) do
          {:noreply, state}
        else
          summary = "Desktop agent runner disconnected and did not reclaim this run."

          Store.open_delegated()
          |> Enum.filter(&(&1.owner_user_id == owner_id))
          |> Enum.map(& &1.run_id)
          |> fail_runs(summary)

          {:noreply, put_error(state, owner_id, summary)}
        end

      _ ->
        {:noreply, state}
    end
  end

  def handle_info(:lease_sweep, state) do
    now = System.monotonic_time(:millisecond)

    {expired, retained} =
      Enum.split_with(state.run_leases, fn {run_id, lease} ->
        Store.delegated_owner(run_id) != lease.owner_id or
          now - lease.touched_at >= state.run_lease
      end)

    summary = "Agent worker heartbeat expired before the run completed."

    expired
    |> Enum.filter(fn {run_id, lease} -> Store.delegated_owner(run_id) == lease.owner_id end)
    |> Enum.map(&elem(&1, 0))
    |> fail_runs(summary)

    timer = Process.send_after(self(), :lease_sweep, lease_sweep_ms(state.run_lease))
    {:noreply, %{state | run_leases: Map.new(retained), lease_timer: timer}}
  end

  @impl true
  def handle_info(:orphan_reclaim, state) do
    summary = "Desktop agent runner did not reclaim this run after server restart."

    Store.open_delegated()
    |> Enum.reject(fn row ->
      online?(row.owner_user_id) and
        get_in(state, [:runners, row.owner_user_id, :metadata, :activeRunIds])
        |> List.wrap()
        |> Enum.member?(row.run_id)
    end)
    |> Enum.reject(fn row ->
      not is_nil(Store.pending_delivery(row.run_id, row.owner_user_id))
    end)
    |> Enum.each(fn row ->
      Store.finish(row.run_id, "failed", summary)
      Store.publish(row.run_id, "status", %{status: "failed", summary: summary})
    end)

    loose_summary = "Server restarted while this run was in progress."

    sql_all_loose_runs()
    |> Enum.each(fn run_id ->
      Store.finish(run_id, "failed", loose_summary)
      Store.publish(run_id, "status", %{status: "failed", summary: loose_summary})
    end)

    {:noreply, state}
  end

  defp sql_all_loose_runs do
    Cascade.Accounts.SQL.all("""
    SELECT id FROM runs WHERE status IN ('queued','running')
    AND id NOT IN (SELECT run_id FROM delegated_runs)
    """)
    |> Enum.map(&hd/1)
  end

  defp fail_runs(run_ids, reason) do
    Enum.each(run_ids, fn run_id ->
      if is_nil(Store.pending_delivery(run_id, Store.delegated_owner(run_id))) do
        Store.finish(run_id, "failed", reason)
        Store.publish(run_id, "status", %{status: "failed", summary: reason})
      end
    end)
  end

  defp cancel_disconnect_timer(state, owner_id) do
    case state.disconnect_timers[owner_id] do
      %{timer: timer} ->
        Process.cancel_timer(timer)
        update_in(state.disconnect_timers, &Map.delete(&1, owner_id))

      _ ->
        state
    end
  end

  defp lease_sweep_ms(run_lease), do: min(30_000, max(10, div(run_lease, 4)))

  defp put_error(state, owner_id, message) do
    %{state | last_error: Map.put(state.last_error, owner_id, %{message: message, at: iso_now()})}
  end

  defp wait_online_until(owner_id, deadline) do
    cond do
      online?(owner_id) ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(250)
        wait_online_until(owner_id, deadline)
    end
  end

  defp normalize_metadata(metadata) when is_map(metadata) do
    ids =
      field(metadata, :activeRunIds)
      |> List.wrap()
      |> Enum.map(fn value -> if is_integer(value), do: value, else: nil end)
      |> Enum.reject(&is_nil/1)
      |> Enum.filter(&(&1 > 0))
      |> Enum.take(10_000)

    instance = field(metadata, :runnerInstanceId)

    %{
      activeRunIds: ids,
      runnerInstanceId: if(is_binary(instance), do: String.slice(instance, 0, 200), else: "")
    }
  end

  defp normalize_metadata(_), do: %{activeRunIds: [], runnerInstanceId: ""}

  defp clean_usage(usage) when is_map(usage) do
    usage
    |> Enum.reduce(%{}, fn {agent, raw}, acc ->
      agent = to_string(agent)

      if agent in ~w(claude-code codex grok nous) and is_map(raw) do
        Map.put(acc, agent, clean_plan(raw))
      else
        acc
      end
    end)
  end

  defp clean_usage(_), do: %{}

  defp merge_plan_usage(previous, incoming) do
    Map.merge(previous, incoming, fn _provider, old, new ->
      if field(new, :status) == "ok" or field(old, :status) != "ok", do: new, else: old
    end)
  end

  defp clean_plan(raw) do
    status = if field(raw, :status) in ["ok", "error"], do: field(raw, :status), else: "unknown"
    percent = number(field(raw, :usedPercent))

    %{
      status: status,
      fetchedAt: clean_string(field(raw, :fetchedAt), 100, iso_now())
    }
    |> maybe_put(
      :usedPercent,
      if(status == "ok" and percent, do: clamp(percent, 0, 100), else: nil)
    )
    |> maybe_put(:windowMinutes, number(field(raw, :windowMinutes)))
    |> maybe_put(:resetsAt, string_or_nil(field(raw, :resetsAt), 100))
    |> maybe_put(:resetsLabel, string_or_nil(field(raw, :resetsLabel), 100))
    |> maybe_put(:planType, string_or_nil(field(raw, :planType), 100))
    |> maybe_put(:detail, string_or_nil(field(raw, :detail), 300))
    |> maybe_put(:extraUsageAvailable, boolean_or_nil(field(raw, :extraUsageAvailable)))
  end

  defp complete_workspace(response) do
    fields = [:path, :repository, :branch, :baseBranch, :baseCommit]
    values = Map.new(fields, &{&1, clean_string(field(response, &1), 2_000, "")})

    if Enum.all?(fields, &(values[&1] != "")) do
      {:ok, Map.put(values, :resumed, field(response, :resumed) == true)}
    else
      {:error, "Desktop returned an incomplete workspace binding"}
    end
  end

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp number(value) when is_number(value), do: value * 1.0
  defp number(_), do: nil
  defp boolean_or_nil(value) when is_boolean(value), do: value
  defp boolean_or_nil(_), do: nil
  defp clamp(value, min, max), do: value |> Kernel.max(min) |> Kernel.min(max)

  defp string_or_nil(value, max),
    do: if(is_binary(value), do: String.slice(value, 0, max), else: nil)

  defp clean_string(value, max, fallback), do: string_or_nil(value, max) || fallback
  defp iso_now, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
