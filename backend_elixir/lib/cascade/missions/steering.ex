defmodule Cascade.Missions.Steering do
  @moduledoc "Task-scoped interrupt/resume using the mission event outbox and provider session."
  alias Cascade.Accounts.SQL
  alias Cascade.Missions.Scheduler
  alias Cascade.Runs.Store, as: Runs
  alias Cascade.Runs.RunnerLifecycle

  @pending """
  SELECT e.id,e.task_id,e.run_id,e.attempt,e.summary,e.mission_id
  FROM chat_mission_events e
  WHERE e.kind='steering_requested' AND NOT EXISTS
    (SELECT 1 FROM chat_mission_events result WHERE result.source_key='steering-result:' || e.id)
  """

  def pending_for_task?(id), do: SQL.one(@pending <> " AND e.task_id=?", [id]) != nil

  def interrupting?(run_id) do
    SQL.one(
      @pending <>
        " AND e.run_id=? AND EXISTS (SELECT 1 FROM chat_mission_events i WHERE i.source_key='steering-interrupt:' || e.id)",
      [run_id]
    ) != nil
  end

  def cancel_pending(run_id) do
    SQL.all(@pending <> " AND e.run_id=?", [run_id])
    |> Enum.each(&reject(&1, "Worker stopped; queued steering was canceled"))
  end

  def replay(mission_id \\ nil) do
    filter = if mission_id, do: " AND e.mission_id=?", else: ""

    SQL.all(@pending <> filter, if(mission_id, do: [mission_id], else: []))
    |> Enum.each(fn [id | _] -> deliver(id) end)
  end

  def deliver(id, opts \\ []) do
    # Do not hold the publisher/database lock while waiting for desktop ACKs:
    # provider terminal events need those same locks before acknowledging stop.
    :global.trans({{__MODULE__, id}, self()}, fn -> do_deliver(id, opts) end)
  end

  defp do_deliver(id, opts) do
    case SQL.one(@pending <> " AND e.id=?", [id]) do
      nil ->
        acknowledgment(id)

      [^id, task, run_id, attempt, _instruction, _mission] = request ->
        case snapshot(task) do
          [status, ^run_id, ^attempt, mission_status, owner, _dispatch]
          when status in ~w(pending running) and mission_status not in ~w(completed canceled) ->
            stop = Keyword.get(opts, :cancel, &RunnerLifecycle.cancel/2)
            run = run_id && Runs.get(run_id)

            cond do
              not is_nil(run_id) and is_nil(run) ->
                reject(request, "Worker run is missing; instructions were not delivered")

              run && run.status in ~w(completed failed) ->
                reject(request, "Worker already finished; instructions were not delivered")

              run && run.session_id in [nil, ""] ->
                queued(id, "Waiting for the worker's saved provider session")

              run && run.conversation_id != "mission:#{task}" ->
                reject(request, "Worker session does not match the task")

              not is_nil(run) and run.status == "canceled" and not interrupting?(run_id) ->
                reject(request, "Worker was canceled; instructions were not delivered")

              run ->
                event(
                  request,
                  "steering_interrupt",
                  "steering-interrupt:#{id}",
                  "Awaiting provider stop acknowledgment"
                )

                if stop.(owner, run_id) do
                  continue(request, opts)
                else
                  queued(
                    id,
                    "Waiting for provider stop acknowledgment; no replacement worker started"
                  )
                end

              true ->
                continue(request, opts)
            end

          _ ->
            reject(request, "Task changed or finished; instructions were not delivered")
        end
    end
  end

  defp continue([id, task, run_id, attempt, instruction, mission] = request, opts) do
    result =
      SQL.transaction(fn ->
        case snapshot(task) do
          [status, ^run_id, ^attempt, mission_status, _owner, dispatch]
          when status in ~w(pending running) and mission_status not in ~w(completed canceled) ->
            run = run_id && Runs.get(run_id)

            if is_nil(SQL.one(@pending <> " AND e.id=?", [id])) or
                 (not is_nil(run) and run.status in ~w(completed failed)) do
              :stale
            else
              # Keep the work item, workspace, provider session and task identity.
              # The existing scheduler allocates a new dispatch for this attempt.
              SQL.exec("DELETE FROM chat_agent_dispatches WHERE id=? AND run_id IS NULL", [
                dispatch
              ])

              prompt =
                if run_id do
                  "Coordinator steering for this same task. Retain your work, context and original authority. Apply this correction and continue:\n\n" <>
                    instruction
                else
                  [original] = SQL.one("SELECT prompt FROM chat_mission_tasks WHERE id=?", [task])
                  original <> "\n\nCoordinator steering:\n" <> instruction
                end

              SQL.exec(
                "UPDATE chat_mission_tasks SET status='pending',joining_children=0,prompt=?,run_id=NULL,dispatch_id=NULL,attempt=attempt+1,updated_at=datetime('now') WHERE id=?",
                [prompt, task]
              )

              if run do
                Runs.finish(run_id, "canceled", "Steered into the continuation below.")
              end

              event(
                request,
                "steering_queued",
                "steering-result:#{id}",
                "Instructions queued for the same task and workspace"
              )

              :ok
            end

          _ ->
            :stale
        end
      end)

    if result == :stale do
      reject(request, "Task changed or finished during interruption; no replacement started")
    else
      if run_id,
        do:
          Runs.publish(run_id, "status", %{
            status: "canceled",
            steering: true,
            summary: "Steered into the continuation below."
          })

      schedule = Keyword.get(opts, :schedule, &schedule/1)
      schedule.(mission)
      acknowledgment(id)
    end
  end

  defp schedule(mission) do
    Scheduler.schedule(mission, events: Cascade.Realtime.Events)
    Cascade.Missions.DispatchReannouncer.wake()
  end

  def acknowledgment(id) do
    case SQL.one(
           "SELECT e.task_id,e.attempt,r.kind,r.summary FROM chat_mission_events e LEFT JOIN chat_mission_events r ON r.source_key='steering-result:' || e.id WHERE e.id=?",
           [id]
         ) do
      [task, attempt, "steering_queued", _] ->
        case SQL.one(
               "SELECT r.id,r.status,r.owner_user_id FROM chat_mission_events e JOIN runs r ON r.id=e.run_id WHERE e.task_id=? AND e.attempt=? AND e.kind='task_started' ORDER BY e.id LIMIT 1",
               [task, attempt + 1]
             ) do
          [run, status, owner] when not is_nil(owner) ->
            if Runs.delegated_owner(run) || status in ~w(completed failed canceled) do
              %{
                id: id,
                taskId: task,
                runId: run,
                status: "dispatched",
                detail:
                  "Instructions dispatched to worker run #{run} (#{status}); execution is not confirmed by dispatch alone"
              }
            else
              queued(id, "Instructions assigned to run #{run}; waiting for runner delivery")
            end

          _ ->
            queued(id, "Instructions saved; waiting for worker dispatch")
        end

      [task, _, "steering_rejected", reason] ->
        %{id: id, taskId: task, status: "rejected", detail: reason}

      _ ->
        queued(id, "Instructions saved; waiting for worker dispatch")
    end
  end

  defp queued(id, reason), do: %{id: id, status: "queued", detail: reason}

  defp reject([id | _] = request, reason) do
    event(request, "steering_rejected", "steering-result:#{id}", reason)
    acknowledgment(id)
  end

  defp event([_, task, run, attempt, _, mission], kind, key, summary) do
    SQL.exec(
      "INSERT OR IGNORE INTO chat_mission_events (mission_id,task_id,run_id,attempt,kind,source_key,summary) VALUES (?,?,?,?,?,?,?)",
      [mission, task, run, attempt, kind, key, summary]
    )
  end

  defp snapshot(task) do
    SQL.one(
      "SELECT t.status,t.run_id,t.attempt,m.status,m.created_by,t.dispatch_id FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id WHERE t.id=?",
      [task]
    )
  end
end
