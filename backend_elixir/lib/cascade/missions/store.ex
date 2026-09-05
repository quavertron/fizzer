defmodule Cascade.Missions.Store do
  @moduledoc "Authoritative mission/task state machine and materialized chat projection."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.WorkItems

  @mission_statuses ~w(active reviewing attention blocked completed canceled)
  @task_statuses ~w(pending running completed failed blocked canceled)
  @terminal_task_statuses ~w(completed failed blocked canceled)

  @mission_select """
  id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,
  status,summary,wake_sent,created_by,created_at,updated_at
  """

  @task_select """
  id,mission_id,title,assignee_registration_id,status,summary,prompt,depends_on_json,
  priority,reasoning_effort,anonymous,workspace_mode,dispatch_id,run_id,attempt,work_item_id,
  created_at,updated_at
  """

  @qualified_task_select """
  t.id,t.mission_id,t.title,t.assignee_registration_id,t.status,t.summary,t.prompt,
  t.depends_on_json,t.priority,t.reasoning_effort,t.anonymous,t.workspace_mode,t.dispatch_id,t.run_id,
  t.attempt,t.work_item_id,t.created_at,t.updated_at
  """

  @event_select """
  id,mission_id,task_id,kind,title,from_status,to_status,summary,run_id,attempt,created_at
  """

  def create(user_id, vault_id, channel_id, input, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         true <- route.localVaultId == vault_id,
         {:ok, coordinator} <-
           assert_coordinator(
             user_id,
             channel_id,
             field(input, :coordinatorRegistrationId)
           ),
         :ok <- reject_worker_control(opts, :start),
         {:ok, root} <- Messages.get(channel_id, user_id, field(input, :rootMessageId)),
         title when title != "" <- clean(field(input, :title), 180) do
      objective = clean(nonblank(field(input, :objective), root.body), 4_000)

      result =
        SQL.transaction(fn ->
          existing =
            SQL.one(
              "SELECT id,coordinator_registration_id FROM chat_missions WHERE channel_id=? AND root_message_id=?",
              [route.sourceChannelId, root.id]
            )

          case existing do
            [_, registration_id] when registration_id != coordinator.id ->
              raise "Mission belongs to another coordinator"

            [mission_id, _] ->
              refresh!(mission_id)

            nil ->
              mission_id = Ecto.UUID.generate()

              SQL.exec(
                """
                INSERT INTO chat_missions
                  (id,vault_id,channel_id,root_message_id,coordinator_registration_id,
                   title,objective,created_by)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                [
                  mission_id,
                  route.sourceVaultId,
                  route.sourceChannelId,
                  root.id,
                  coordinator.id,
                  title,
                  objective,
                  user_id
                ]
              )

              authority =
                Cascade.Missions.Authority.capture!(
                  user_id,
                  channel_id,
                  root,
                  field(input, :authorityMessageIds) || []
                )

              SQL.exec("UPDATE chat_missions SET authority_json=? WHERE id=?", [
                authority,
                mission_id
              ])

              record_event(mission_id, %{
                kind: "mission_created",
                title: title,
                to_status: "active",
                summary: objective,
                run_id:
                  creation_run_id(
                    Keyword.get(opts, :current_run_id),
                    coordinator.id,
                    route.sourceChannelId,
                    user_id
                  )
              })

              refresh!(mission_id)
          end
        end)

      maybe_bind_primary(result, user_id, channel_id, opts)
    else
      false -> {:error, "Chat channel not found"}
      "" -> {:error, "Mission title is required"}
      {:error, "Message not found"} -> {:error, "Mission root message not found"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def get(user_id, channel_id, mission_ref, coordinator_registration_id \\ nil) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      row =
        if mission_ref in [nil, "", "current"] do
          coordinator = clean(coordinator_registration_id, 120)

          SQL.one(
            """
            SELECT #{@mission_select} FROM chat_missions
            WHERE channel_id=? AND (?='' OR coordinator_registration_id=?)
            ORDER BY
              CASE WHEN status IN ('active','reviewing','attention','blocked') THEN 0 ELSE 1 END,
              updated_at DESC,rowid DESC
            LIMIT 1
            """,
            [route.sourceChannelId, coordinator, coordinator]
          )
        else
          case mission_row(mission_ref) do
            %{channel_id: channel_id} = mission when channel_id == route.sourceChannelId ->
              mission

            _ ->
              nil
          end
        end

      case row do
        nil -> {:error, "Mission not found"}
        mission when is_map(mission) -> refresh(mission.id)
        mission -> mission |> mission_from_row() |> Map.fetch!(:id) |> refresh()
      end
    end
  end

  def list(user_id, channel_id, coordinator_registration_id \\ nil) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      coordinator = clean(coordinator_registration_id, 120)

      missions =
        SQL.all(
          """
          SELECT #{@mission_select} FROM chat_missions
          WHERE channel_id=? AND (?='' OR coordinator_registration_id=?)
          ORDER BY updated_at DESC,rowid DESC
          """,
          [route.sourceChannelId, coordinator, coordinator]
        )
        |> Enum.map(fn row -> row |> mission_from_row() |> then(&refresh!(&1.id).mission) end)

      {:ok, missions}
    end
  end

  def list_active(user_id, channel_id, limit \\ 3) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      limit = limit |> integer(3) |> max(1) |> min(10)

      missions =
        SQL.all(
          """
          SELECT #{@mission_select} FROM chat_missions
          WHERE channel_id=? AND status IN ('active','reviewing','attention','blocked')
          ORDER BY updated_at DESC,rowid DESC LIMIT ?
          """,
          [route.sourceChannelId, limit]
        )
        |> Enum.map(fn row ->
          mission = mission_from_row(row)
          project(mission, task_rows(mission.id))
        end)

      {:ok, missions}
    end
  end

  def events(user_id, channel_id, mission_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         %{channel_id: channel_id} <- mission_row(mission_id),
         true <- channel_id == route.sourceChannelId do
      result =
        SQL.all(
          "SELECT #{@event_select} FROM chat_mission_events WHERE mission_id=? ORDER BY created_at ASC,id ASC",
          [mission_id]
        )
        |> Enum.map(&event_from_row/1)

      {:ok, result}
    else
      _ -> {:error, "Mission not found"}
    end
  end

  def add_task(user_id, channel_id, mission_id, input, opts \\ []) do
    coordinator_id = field(input, :coordinatorRegistrationId)

    with {:ok, update} <- get(user_id, channel_id, mission_id, coordinator_id),
         mission <- mission_row(update.mission.id),
         :ok <- ensure_mission_open(mission.status),
         {:ok, coordinator} <- assert_coordinator(user_id, channel_id, coordinator_id),
         true <- mission.coordinator_registration_id == coordinator.id,
         :ok <- reject_worker_control(opts, :delegate),
         {:ok, assignee} <- find_assignee(user_id, channel_id, field(input, :assignee)),
         anonymous <- truthy?(field(input, :anonymous)),
         :ok <- validate_self_assignment(assignee, coordinator, anonymous, opts),
         title when title != "" <- clean(field(input, :title), 240),
         dependencies <- clean_ids(field(input, :dependsOn)),
         :ok <- validate_dependencies(mission.id, dependencies),
         {:ok, effort} <- validate_effort(assignee, field(input, :reasoningEffort)),
         workspace_mode when workspace_mode in ~w(shared isolated) <-
           clean(nonblank(field(input, :workspaceMode), "shared"), 20) do
      priority = field(input, :priority) |> integer(0) |> max(-100) |> min(100)
      prompt = clean(nonblank(field(input, :prompt), title), 12_000)
      dependency_json = Jason.encode!(dependencies)
      anonymous_int = if anonymous, do: 1, else: 0

      result =
        SQL.transaction(fn ->
          existing =
            SQL.one(
              """
              SELECT #{@task_select} FROM chat_mission_tasks
              WHERE mission_id=? AND assignee_registration_id=? AND title=? AND parent_task_id IS ?
              ORDER BY created_at ASC,rowid ASC LIMIT 1
              """,
              [mission.id, assignee.id, title, Keyword.get(opts, :parent_task_id)]
            )
            |> task_from_nullable_row()

          validate_idempotent_task!(
            existing,
            prompt,
            dependency_json,
            priority,
            effort,
            anonymous,
            workspace_mode
          )

          task_id = if existing, do: existing.id, else: Ecto.UUID.generate()

          if is_nil(existing) do
            SQL.exec(
              """
              INSERT INTO chat_mission_tasks
                (id,mission_id,title,assignee_registration_id,prompt,depends_on_json,
                 priority,reasoning_effort,anonymous,workspace_mode,parent_task_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)
              """,
              [
                task_id,
                mission.id,
                title,
                assignee.id,
                prompt,
                dependency_json,
                priority,
                effort,
                anonymous_int,
                workspace_mode,
                Keyword.get(opts, :parent_task_id)
              ]
            )

            SQL.exec(
              "UPDATE chat_missions SET status='active',wake_sent=0,updated_at=datetime('now') WHERE id=?",
              [mission.id]
            )

            if mission.status != "active" do
              record_event(mission.id, %{
                kind: "mission_status_changed",
                title: mission.title,
                from_status: mission.status,
                to_status: "active",
                summary: "Follow-up work added."
              })
            end

            task = task_row(task_id)
            ensure_work_item(user_id, mission, task)

            record_event(mission.id, %{
              task_id: task_id,
              kind: "task_added",
              title: title,
              to_status: "pending",
              summary: prompt,
              attempt: 0
            })
          else
            if is_nil(existing.work_item_id), do: ensure_work_item(user_id, mission, existing)
          end

          refreshed = refresh!(mission.id)

          %{
            update: refreshed,
            task: Enum.find(refreshed.mission.tasks, &(&1.id == task_id)),
            assignee: assignee
          }
        end)

      {:ok, result}
    else
      false -> {:error, "Mission belongs to another coordinator"}
      "" -> {:error, "Task title is required"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def schedulable(mission_id \\ nil) do
    {filter, params} = if mission_id, do: {"AND id=?", [mission_id]}, else: {"", []}

    missions =
      SQL.all(
        """
        SELECT #{@mission_select} FROM chat_missions
        WHERE status IN ('active','reviewing','attention','blocked') #{filter}
        ORDER BY created_at ASC,rowid ASC
        """,
        params
      )
      |> Enum.map(&mission_from_row/1)

    {candidates, _reserved} =
      Enum.reduce(missions, {[], MapSet.new()}, fn mission, {candidates, reserved} ->
        tasks = task_rows(mission.id)

        occupied =
          SQL.all(
            """
            SELECT DISTINCT t.assignee_registration_id
            FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
            WHERE m.channel_id=? AND m.status IN ('active','reviewing','attention','blocked')
              AND COALESCE(t.anonymous,0)=0
              AND (t.status='running' OR (t.status='pending' AND t.dispatch_id IS NOT NULL))
            """,
            [mission.channel_id]
          )
          |> Enum.map(&hd/1)
          |> MapSet.new()

        by_id = Map.new(tasks, &{&1.id, &1})

        ready =
          tasks
          |> Enum.with_index()
          |> Enum.filter(fn {task, _index} ->
            task.status == "pending" and is_nil(task.dispatch_id) and
              not Cascade.Missions.Children.joining?(task.id) and
              Enum.all?(dependencies(task), &(by_id[&1] && by_id[&1].status == "completed"))
          end)
          |> Enum.sort_by(fn {task, index} -> {-task.priority, index} end)

        Enum.reduce(ready, {candidates, reserved}, fn {task, _index}, {items, held} ->
          key = "#{mission.channel_id}:#{task.assignee_registration_id}"
          anonymous = task.anonymous != 0

          if not anonymous and
               (MapSet.member?(occupied, task.assignee_registration_id) or
                  MapSet.member?(held, key)) do
            {items, held}
          else
            candidate = %{
              taskId: task.id,
              missionId: mission.id,
              vaultId: mission.vault_id,
              channelId: mission.channel_id,
              createdBy: mission.created_by,
              coordinatorRegistrationId: mission.coordinator_registration_id,
              assigneeRegistrationId: task.assignee_registration_id,
              title: task.title,
              prompt: nonblank(task.prompt, task.title),
              reasoningEffort: task.reasoning_effort || "",
              anonymous: anonymous,
              attempt: task.attempt || 0
            }

            {items ++ [candidate], if(anonymous, do: held, else: MapSet.put(held, key))}
          end
        end)
      end)

    %{candidates: candidates, updates: []}
  end

  def link_dispatch(task_id, dispatch_id) do
    SQL.transaction(fn ->
      task = task_row(task_id) || raise "Mission task not found"

      case {task.dispatch_id, task_for_dispatch(dispatch_id)} do
        {^dispatch_id, %{id: ^task_id}} ->
          refresh!(task.mission_id)

        {nil, nil} ->
          SQL.exec(
            "UPDATE chat_mission_tasks SET dispatch_id=?,updated_at=datetime('now') WHERE id=? AND dispatch_id IS NULL",
            [dispatch_id, task_id]
          )

          record_event(task.mission_id, %{
            task_id: task.id,
            kind: "task_dispatched",
            title: task.title,
            from_status: task.status,
            to_status: task.status,
            attempt: task.attempt
          })

          refresh!(task.mission_id)

        {_current, %{id: owner_id}} ->
          raise "Dispatch already belongs to mission task #{owner_id}"

        {_current, nil} ->
          raise "Mission task already has a different dispatch"
      end
    end)
    |> then(&{:ok, &1})
  rescue
    error -> {:error, Exception.message(error)}
  end

  def attach_run(dispatch_id, run_id) when is_integer(run_id) and run_id > 0 do
    case SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE dispatch_id=?", [
           dispatch_id
         ]) do
      nil ->
        {:ok, nil}

      row ->
        task = task_from_row(row)

        if task.status in ~w(pending running) do
          SQL.exec(
            "UPDATE chat_mission_tasks SET run_id=?,status='running',updated_at=datetime('now') WHERE id=?",
            [run_id, task.id]
          )

          if task.status != "running" or task.run_id != run_id do
            record_event(task.mission_id, %{
              task_id: task.id,
              kind: "task_started",
              title: task.title,
              from_status: task.status,
              to_status: "running",
              run_id: run_id,
              attempt: task.attempt
            })
          end
        end

        mission = mission_row(task.mission_id)
        updated = task_row(task.id)

        if mission && updated,
          do: sync_work_item(mission.created_by, mission, updated, run_id: run_id, lease: true)

        refresh(task.mission_id)
    end
  end

  def attach_run(_dispatch_id, _run_id), do: {:error, "Invalid run id"}

  def request_steering(user_id, channel_id, task_id, input, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <- task_with_mission(task_id),
         :ok <- authorize_task_row(row, route, user_id),
         :ok <- reject_worker_control(opts, :steer),
         {:ok, coordinator} <-
           assert_coordinator(user_id, channel_id, field(input, :coordinatorRegistrationId)) do
      SQL.transaction(fn ->
        task = task_row(task_id)
        mission = mission_row(task.mission_id)
        instruction = clean(field(input, :message), 8_000)
        caller_run = Keyword.get(opts, :current_run_id)

        if caller_run &&
             SQL.one(
               "SELECT d.registration_id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id WHERE r.id=? AND d.channel_id=?",
               [caller_run, mission.channel_id]
             ) != [coordinator.id],
           do: raise("Only this mission's coordinator can steer its workers")

        unless SQL.one(
                 "SELECT va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=?",
                 [task.assignee_registration_id]
               ) == [user_id],
               do: raise("Only the worker owner can steer this task")

        unless mission.coordinator_registration_id == coordinator.id,
          do: raise("Mission belongs to another coordinator")

        unless mission.status not in ~w(completed canceled) and task.status in ~w(pending running),
          do: raise("Task is already finished; steering was not delivered")

        unless task.attempt == field(input, :attempt) and task.run_id == field(input, :runId),
          do: raise("Task changed; refresh its status before steering")

        if instruction == "", do: raise("Steering needs a message")

        if Cascade.Missions.Steering.pending_for_task?(task_id),
          do: raise("Task already has queued steering; inspect mission history")

        record_event(mission.id, %{
          task_id: task.id,
          kind: "steering_requested",
          title: task.title,
          summary: instruction,
          run_id: task.run_id,
          attempt: task.attempt
        })

        {:ok, SQL.last_insert_id()}
      end)
    else
      nil -> {:error, "Mission task not found"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def update_task(user_id, channel_id, task_id, input) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <- task_with_mission(task_id),
         :ok <- authorize_task_row(row, route, user_id),
         :ok <- ensure_mission_open(row.mission_status),
         status when status in @task_statuses <- clean(field(input, :status), 40) do
      summary = clean(field(input, :summary), 4_000)
      retrying = status == "pending" and row.status in @terminal_task_statuses

      cond do
        status == "pending" and row.status == "running" ->
          {:error, "Task is still running; cancel or wait for it before retrying"}

        retrying and active_run?(row.run_id) ->
          {:error, "Task run is still active; cancel or wait for it before retrying"}

        true ->
          result =
            SQL.transaction(fn ->
              if status == "completed" and Cascade.Missions.Children.unresolved?(task_id),
                do: raise("Join and integrate child results before completing the parent")

              if retrying do
                SQL.exec(
                  "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id=?",
                  [row.dispatch_id]
                )

                prompt = nonblank(row.prompt, row.title)

                prompt =
                  if summary == "",
                    do: prompt,
                    else:
                      prompt <>
                        "\n\nCoordinator retry instructions (subject to saved user authority):\n" <>
                        summary

                SQL.exec(
                  """
                  UPDATE chat_mission_tasks
                  SET status='pending',summary=?,prompt=?,dispatch_id=NULL,run_id=NULL,child_result_delivered=0,joining_children=0,
                    attempt=attempt+1,updated_at=datetime('now') WHERE id=?
                  """,
                  [summary, prompt, task_id]
                )

                SQL.exec(
                  "UPDATE chat_missions SET status='active',wake_sent=0,updated_at=datetime('now') WHERE id=?",
                  [row.mission_id]
                )

                if row.mission_status != "active" do
                  record_event(row.mission_id, %{
                    kind: "mission_status_changed",
                    title: mission_row(row.mission_id).title,
                    from_status: row.mission_status,
                    to_status: "active",
                    summary: "Retrying #{row.title}."
                  })
                end

                record_event(row.mission_id, %{
                  task_id: task_id,
                  kind: "task_retried",
                  title: row.title,
                  from_status: row.status,
                  to_status: "pending",
                  summary: summary,
                  attempt: row.attempt + 1
                })
              else
                SQL.exec(
                  "UPDATE chat_mission_tasks SET status=?,summary=?,updated_at=datetime('now') WHERE id=?",
                  [status, summary, task_id]
                )

                if row.status != status or row.summary != summary do
                  record_event(row.mission_id, %{
                    task_id: task_id,
                    kind: "task_status_changed",
                    title: row.title,
                    from_status: row.status,
                    to_status: status,
                    summary: summary,
                    run_id: row.run_id,
                    attempt: row.attempt
                  })
                end
              end

              if status in @terminal_task_statuses do
                SQL.exec(
                  "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id=(SELECT dispatch_id FROM chat_mission_tasks WHERE id=?)",
                  [task_id]
                )
              end

              mission = mission_row(row.mission_id)
              task = task_row(task_id)

              sync_work_item(mission.created_by, mission, task,
                release: status in @terminal_task_statuses,
                reset: retrying
              )

              canceled =
                if status in ~w(canceled failed blocked),
                  do: Cascade.Missions.Children.cancel(task_id),
                  else: []

              update = refresh!(row.mission_id)

              runs =
                if status == "canceled" and row.run_id,
                  do: [row.run_id | canceled],
                  else: canceled

              Map.put(update, :canceledTaskRunIds, runs)
            end)

          {:ok, result}
      end
    else
      nil -> {:error, "Mission task not found"}
      status when is_binary(status) -> {:error, "Invalid mission task status"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def finish(user_id, channel_id, mission_id, input, opts \\ []) do
    coordinator_id = field(input, :coordinatorRegistrationId)

    with {:ok, update} <- get(user_id, channel_id, mission_id, coordinator_id),
         mission <- mission_row(update.mission.id),
         {:ok, coordinator} <- assert_coordinator(user_id, channel_id, coordinator_id),
         true <- mission.coordinator_registration_id == coordinator.id,
         :ok <- reject_worker_control(opts, :finish),
         status when status in ~w(completed canceled) <- field(input, :status) do
      if mission.status in ~w(completed canceled) do
        if mission.status == status,
          do: refresh(mission.id),
          else: {:error, "Mission is already closed"}
      else
        current_run_id = Keyword.get(opts, :current_run_id)
        summary = clean(field(input, :summary), 4_000)

        result =
          SQL.transaction(fn ->
            tasks =
              maybe_finish_primary(
                mission,
                task_rows(mission.id),
                status,
                current_run_id,
                summary
              )

            final_status =
              if status == "completed" and tasks != [] and
                   Enum.all?(
                     tasks,
                     &(&1.status == "canceled" and not recovered_evidence_ready?(&1, mission))
                   ),
                 do: "canceled",
                 else: status

            if final_status == "completed" and
                 Enum.any?(tasks, &(&1.status in ~w(pending running))) do
              raise "Mission still has active workers"
            end

            if final_status == "completed" and
                 not Enum.any?(tasks, fn task ->
                   completion_evidence_ready?(task, mission) or
                     current_primary?(task, mission, current_run_id)
                 end) do
              raise "Mission has no completed worker evidence"
            end

            if final_status == "completed" and
                 Enum.any?(tasks, fn task ->
                   task.status != "canceled" and
                     not completion_evidence_ready?(task, mission) and
                     not current_primary?(task, mission, current_run_id)
                 end) do
              raise "Mission task evidence is incomplete"
            end

            verification = clean(field(input, :verification), 8_000)

            if final_status == "completed" and verification == "",
              do:
                raise(
                  "Coordinator verification is required: record observed checks and artifact or live revision evidence"
                )

            SQL.exec("UPDATE chat_missions SET verification=? WHERE id=?", [
              verification,
              mission.id
            ])

            record_event(mission.id, %{kind: "coordinator_verification", summary: verification})

            SQL.exec(
              "UPDATE chat_missions SET status=?,summary=?,wake_sent=1,updated_at=datetime('now') WHERE id=?",
              [final_status, summary, mission.id]
            )

            record_event(mission.id, %{
              kind:
                if(final_status == "completed", do: "mission_completed", else: "mission_canceled"),
              title: mission.title,
              from_status: mission.status,
              to_status: final_status,
              summary: summary
            })

            if final_status == "canceled", do: cancel_open_tasks(mission, tasks)
            cleanup = cleanup_stale_wakes(mission, current_run_id)

            Enum.each(task_rows(mission.id), fn task ->
              sync_work_item(user_id, mission, task, release: true)
            end)

            update = refresh!(mission.id) |> Map.merge(cleanup)
            Cascade.Chat.NextSteps.completion(update)
            update
          end)

        {:ok, result}
      end
    else
      false -> {:error, "Mission belongs to another coordinator"}
      status when is_binary(status) -> {:error, "Invalid mission status"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  @doc "Returns a ready review wake without consuming it; the scheduler marks it with its outbox writes."
  def claim_wake(mission_id) do
    with {:ok, update} <- refresh(mission_id) do
      tasks = task_rows(mission_id)
      by_id = Map.new(tasks, &{&1.id, &1})

      all_settled =
        tasks != [] and Enum.all?(tasks, &(&1.status in @terminal_task_statuses))

      moving =
        Enum.any?(tasks, fn task ->
          task.status == "running" or
            (task.status == "pending" and not is_nil(task.dispatch_id)) or
            (task.status == "pending" and is_nil(task.dispatch_id) and
               Enum.all?(dependencies(task), &(by_id[&1] && by_id[&1].status == "completed")))
        end)

      stalled = tasks != [] and update.mission.status in ~w(attention blocked) and not moving

      mission = mission_row(mission_id)
      interrupted_start = tasks == [] and recoverable_creation?(mission)

      if mission.wake_sent == 0 and (all_settled or stalled or interrupted_start) and
           not Enum.any?(tasks, &active_run?(&1.run_id)) and
           update.mission.status in ~w(reviewing attention blocked) do
        generation = review_fingerprint(mission_id)

        {:ok,
         Map.merge(update, %{
           coordinatorRegistrationId: mission.coordinator_registration_id,
           generation: generation
         })}
      else
        {:ok, nil}
      end
    end
  end

  def settle_run(run_id, status, summary) when status in ~w(completed failed canceled) do
    if status == "canceled" and Cascade.Missions.Steering.interrupting?(run_id),
      do: {:ok, nil},
      else: do_settle_run(run_id, status, summary)
  end

  defp do_settle_run(run_id, status, summary) do
    case SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE run_id=? LIMIT 1", [run_id]) do
      nil ->
        {:ok, nil}

      row ->
        task = task_from_row(row)

        result =
          SQL.transaction(fn ->
            next =
              if task.status in @terminal_task_statuses,
                do: status,
                else: Cascade.Missions.Children.settlement(task.id, status)

            if next == "joining", do: Cascade.Missions.Children.wait(task.id)
            next = if next == "joining", do: "pending", else: next
            cleaned = clean(summary, 4_000)

            if task.status not in @terminal_task_statuses or
                 (next == "completed" and task.status == "completed" and
                    task.summary != cleaned) do
              SQL.exec(
                "UPDATE chat_mission_tasks SET status=?,summary=?,updated_at=datetime('now') WHERE id=?",
                [next, cleaned, task.id]
              )

              record_event(task.mission_id, %{
                task_id: task.id,
                kind: "task_status_changed",
                title: task.title,
                from_status: task.status,
                to_status: next,
                summary: cleaned,
                run_id: run_id,
                attempt: task.attempt
              })
            end

            mission = mission_row(task.mission_id)
            settled = task_row(task.id)

            sync_work_item(mission.created_by, mission, settled,
              run_id: run_id,
              release: not Cascade.Missions.Children.joining?(task.id),
              verification: if(settled.status == "completed", do: settled.summary, else: nil)
            )

            update = refresh!(task.mission_id)
            {:ok, wake} = claim_wake(task.mission_id)
            %{update: wake || update, wake: wake}
          end)

        {:ok, result}
    end
  end

  def refresh(mission_id) do
    case mission_row(mission_id) do
      nil -> {:error, "Mission not found"}
      mission -> {:ok, do_refresh(mission)}
    end
  end

  def root_message(%{channelId: channel_id, createdBy: user_id, rootMessageId: message_id}) do
    case owner_route(user_id, nil, channel_id) do
      {:ok, route} -> Messages.get(route.localChannelId, user_id, message_id)
      error -> error
    end
  end

  @doc "Finds the mission owner's accessible local projection of a canonical source channel."
  def owner_route(user_id, source_vault_id, source_channel_id) do
    case Channel.assert_channel(source_channel_id, user_id) do
      {:ok, route} ->
        {:ok, route}

      _ ->
        source_vault_id =
          source_vault_id ||
            case SQL.one("SELECT vault_id FROM notes WHERE id=?", [source_channel_id]) do
              [vault_id] -> vault_id
              _ -> nil
            end

        if is_binary(source_vault_id) do
          route =
            Channel.list_routes(source_vault_id, source_channel_id)
            |> Enum.find(fn candidate ->
              SQL.one("SELECT created_by FROM vaults WHERE id=?", [candidate.localVaultId]) == [
                user_id
              ]
            end)

          if route, do: {:ok, route}, else: {:error, "Chat channel not found"}
        else
          {:error, "Chat channel not found"}
        end
    end
  end

  defp refresh!(mission_id) do
    case refresh(mission_id) do
      {:ok, update} -> update
      {:error, reason} -> raise reason
    end
  end

  defp do_refresh(mission) do
    tasks = task_rows(mission.id)
    status = derive_status(mission, tasks)

    mission =
      if status != mission.status do
        SQL.exec("UPDATE chat_missions SET status=?,updated_at=datetime('now') WHERE id=?", [
          status,
          mission.id
        ])

        record_event(mission.id, %{
          kind: "mission_status_changed",
          title: mission.title,
          from_status: mission.status,
          to_status: status
        })

        mission_row(mission.id)
      else
        mission
      end

    projection = project(mission, tasks)
    encoded_projection = Jason.encode!(projection)

    # Startup refreshes must not rewrite historical message bytes just because
    # a JSON encoder chooses a different key order. The Node and Elixir APIs
    # expose the parsed projection; preserve an already-equivalent durable
    # value and write only when mission state actually changed.
    unless mission_projection_equal?(
             SQL.one(
               "SELECT mission_json FROM chat_messages WHERE id=? AND channel_id=?",
               [mission.root_message_id, mission.channel_id]
             ),
             encoded_projection
           ) do
      SQL.exec(
        "UPDATE chat_messages SET mission_json=? WHERE id=? AND channel_id=?",
        [encoded_projection, mission.root_message_id, mission.channel_id]
      )
    end

    %{
      mission: projection,
      vaultId: mission.vault_id,
      channelId: mission.channel_id,
      rootMessageId: mission.root_message_id,
      createdBy: mission.created_by
    }
  end

  defp mission_projection_equal?([existing], encoded)
       when is_binary(existing) and is_binary(encoded) do
    case {Jason.decode(existing), Jason.decode(encoded)} do
      {{:ok, left}, {:ok, right}} -> left == right
      _ -> false
    end
  end

  defp mission_projection_equal?(_, _), do: false

  defp creation_run_id(run_id, registration_id, channel_id, user_id) do
    case SQL.one(
           """
           SELECT r.id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
           WHERE r.id=? AND r.owner_user_id=? AND r.status IN ('queued','running')
             AND d.registration_id=? AND d.channel_id=?
           """,
           [run_id, user_id, registration_id, channel_id]
         ) do
      [id] -> id
      nil -> nil
    end
  end

  defp creation_run(mission) do
    SQL.one(
      """
      SELECT r.id,r.status FROM chat_mission_events e JOIN runs r ON r.id=e.run_id
      WHERE e.mission_id=? AND e.kind='mission_created' ORDER BY e.id LIMIT 1
      """,
      [mission.id]
    )
  end

  defp recoverable_creation?(mission) do
    case creation_run(mission) do
      [_, status] when status in ~w(completed failed) ->
        true

      [run_id, "canceled"] ->
        SQL.one(
          "SELECT 1 FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload_json,'$.steering')=1 LIMIT 1",
          [run_id]
        ) == [1]

      _ ->
        false
    end
  end

  defp derive_status(%{status: "canceled"}, _tasks), do: "canceled"
  defp derive_status(%{status: "completed"}, _tasks), do: "completed"

  defp derive_status(mission, []) do
    fresh_unbound =
      is_nil(creation_run(mission)) and
        SQL.one(
          "SELECT 1 FROM chat_missions WHERE id=? AND created_at>datetime('now','-30 seconds')",
          [mission.id]
        ) == [1]

    if fresh_unbound or
         not is_nil(
           Cascade.Runs.Store.find_open_for_chat_registration(mission.coordinator_registration_id)
         ), do: "active", else: "attention"
  end

  defp derive_status(mission, tasks) do
    by_id = Map.new(tasks, &{&1.id, &1})

    cond do
      Enum.any?(
        tasks,
        &(&1.status in ~w(failed blocked) and not completion_evidence_ready?(&1, mission))
      ) ->
        "attention"

      Enum.any?(tasks, &(&1.status == "pending" and dependency_attention?(&1, by_id))) ->
        "attention"

      Enum.all?(
        tasks,
        &(&1.status in ~w(completed canceled) or completion_evidence_ready?(&1, mission))
      ) ->
        completed =
          Enum.filter(tasks, &(&1.status != "canceled" or recovered_evidence_ready?(&1, mission)))

        if completed != [] and Enum.all?(completed, &completion_evidence_ready?(&1, mission)),
          do: "reviewing",
          else: "attention"

      true ->
        "active"
    end
  end

  defp project(mission, tasks) do
    member_channel_id =
      case owner_route(mission.created_by, mission.vault_id, mission.channel_id) do
        {:ok, route} -> route.localChannelId
        _ -> mission.channel_id
      end

    registrations =
      case Agents.list_members(member_channel_id, mission.created_by) do
        {:ok, members} -> members
        _ -> []
      end

    by_registration = Map.new(registrations, &{&1.id, &1})
    by_task = Map.new(tasks, &{&1.id, &1})
    coordinator = by_registration[mission.coordinator_registration_id]

    projected_tasks =
      Enum.map(tasks, fn task ->
        assignee = by_registration[task.assignee_registration_id]
        depends_on = dependencies(task)

        waiting_for =
          Enum.filter(depends_on, &(is_nil(by_task[&1]) or by_task[&1].status != "completed"))

        attention = task.status == "pending" and dependency_attention?(task, by_task)
        anonymous = task.anonymous != 0
        mention = if assignee, do: assignee.mention, else: ""

        base = %{
          id: task.id,
          title: task.title,
          assignee:
            if(anonymous,
              do: "#{agent_name(assignee)} subagent",
              else: if(assignee, do: agent_name(assignee), else: "Unassigned agent")
            ),
          assigneeMention: if(anonymous and mention != "", do: mention <> "·sub", else: mention),
          assigneeModel: if(assignee, do: assignee.model || "", else: ""),
          status: task.status,
          summary: task.summary || "",
          dependsOn: depends_on,
          waitingFor: waiting_for,
          priority: task.priority || 0,
          reasoningEffort: task.reasoning_effort || "",
          anonymous: anonymous,
          attempt: task.attempt || 0,
          recoveryEvidence:
            case SQL.one(
                   "SELECT source_task_id,verification FROM chat_mission_recovery_evidence WHERE task_id=?",
                   [task.id]
                 ) do
              [source, verification] ->
                %{
                  sourceTaskId: source,
                  verification: verification,
                  valid: recovered_evidence_ready?(task, mission)
                }

              _ ->
                nil
            end,
          queueReason: queue_reason(task, waiting_for, attention),
          updatedAt: task.updated_at
        }

        base
        |> Map.merge(Cascade.Missions.Children.projection(task.id))
        |> maybe_put(:runId, task.run_id)
        |> add_work_item_projection(mission.created_by, task.work_item_id)
      end)

    %{
      id: mission.id,
      rootMessageId: mission.root_message_id,
      title: mission.title,
      objective: mission.objective,
      authority:
        SQL.one("SELECT authority_json FROM chat_missions WHERE id=?", [mission.id])
        |> hd()
        |> Jason.decode!(),
      verification:
        SQL.one("SELECT verification FROM chat_missions WHERE id=?", [mission.id]) |> hd(),
      status: derive_status(mission, tasks),
      coordinator: if(coordinator, do: agent_name(coordinator), else: "Coordinator"),
      coordinatorMention: if(coordinator, do: coordinator.mention || "", else: ""),
      tasks: projected_tasks,
      summary: mission.summary || "",
      createdAt: mission.created_at,
      updatedAt: mission.updated_at
    }
  end

  defp add_work_item_projection(task, _user_id, nil), do: task

  defp add_work_item_projection(task, user_id, work_item_id) do
    case WorkItems.get(user_id, work_item_id) do
      {:ok, item} ->
        task
        |> Map.merge(%{
          workItemId: item.id,
          workItemStatus: item.status,
          workspaceMode: item.workspaceMode,
          baseCommit: item.baseCommit,
          branch: item.branch,
          worktreePath: item.worktreePath,
          reviewReady: item.reviewReadiness.ready,
          reviewBlockers: item.reviewReadiness.blockers,
          reviewState: review_state(item)
        })
        |> maybe_put_nonblank(:prUrl, item.prUrl)
        |> maybe_put_nonblank(:prState, item.prState)
        |> maybe_put_nonblank(:verification, item.verification)
        |> maybe_put(:gitState, projected_git_state(item))

      _ ->
        task
    end
  end

  defp projected_git_state(%{gitState: state, gitStateUpdatedAt: updated}) when is_map(state) do
    %{
      changedFiles: state.changedFiles,
      dirty: state.dirty,
      behind: state.behind,
      updatedAt: updated || ""
    }
  end

  defp projected_git_state(_), do: nil
  defp review_state(%{status: "review", prUrl: url}) when url not in [nil, ""], do: "in_review"
  defp review_state(%{status: "review"}), do: "requested"

  defp review_state(%{status: "done", verification: value}) when value not in [nil, ""],
    do: "ready"

  defp review_state(_), do: "none"

  defp ensure_work_item(user_id, mission, task) do
    existing =
      cond do
        task.work_item_id ->
          case WorkItems.get(user_id, task.work_item_id) do
            {:ok, item} -> item
            _ -> nil
          end

        true ->
          nil
      end

    existing =
      existing ||
        case SQL.one(
               "SELECT id FROM work_items WHERE vault_id=? AND source_kind='mission' AND source_id=? LIMIT 1",
               [mission.vault_id, task.id]
             ) do
          [id] ->
            SQL.exec("UPDATE chat_mission_tasks SET work_item_id=? WHERE id=?", [id, task.id])

            case WorkItems.get(user_id, id) do
              {:ok, item} -> item
              _ -> nil
            end

          nil ->
            nil
        end

    if existing do
      existing
    else
      dependency_work_items =
        dependencies(task)
        |> Enum.flat_map(fn id ->
          case SQL.one(
                 "SELECT work_item_id FROM chat_mission_tasks WHERE mission_id=? AND id=? AND work_item_id IS NOT NULL",
                 [mission.id, id]
               ) do
            [work_item_id] -> [work_item_id]
            _ -> []
          end
        end)

      input = %{
        title: task.title,
        brief: nonblank(task.prompt, task.title),
        channelId: mission.channel_id,
        priority: task.priority,
        sourceKind: "mission",
        sourceId: task.id,
        dependsOn: dependency_work_items,
        assigneeRegistrationId: task.assignee_registration_id,
        workspaceMode: task.workspace_mode,
        branch:
          if(task.workspace_mode == "isolated",
            do: work_item_branch(mission.id, task.id, task.title),
            else: ""
          )
      }

      case WorkItems.create(user_id, mission.vault_id, input) do
        {:ok, item} ->
          SQL.exec("UPDATE chat_mission_tasks SET work_item_id=? WHERE id=?", [item.id, task.id])
          item

        {:error, reason} ->
          raise reason
      end
    end
  end

  defp sync_work_item(user_id, mission, task, opts) do
    item = ensure_work_item(user_id, mission, task)
    run_id = Keyword.get(opts, :run_id)

    if is_integer(run_id) and run_id > 0, do: WorkItems.link_run(user_id, item.id, run_id)

    if Keyword.get(opts, :lease) do
      WorkItems.acquire_lease(user_id, item.id, task.assignee_registration_id)
    end

    reset = Keyword.get(opts, :reset, false)
    verification = Keyword.get(opts, :verification)

    WorkItems.update(user_id, item.id, %{
      status: task_to_work_item_status(task.status),
      summary: if(reset, do: "", else: nonblank(task.summary, item.summary)),
      verification: if(reset, do: "", else: nonblank(verification, item.verification)),
      stopReason: if(reset, do: "", else: item.stopReason),
      assigneeRegistrationId: task.assignee_registration_id
    })

    if Keyword.get(opts, :release) or
         task_to_work_item_status(task.status) in ~w(done canceled blocked) do
      WorkItems.release_lease(user_id, item.id)
    end

    :ok
  rescue
    _ -> :ok
  end

  defp task_to_work_item_status("running"), do: "in_progress"
  defp task_to_work_item_status(status) when status in ~w(blocked failed), do: "blocked"
  defp task_to_work_item_status("completed"), do: "done"
  defp task_to_work_item_status("canceled"), do: "canceled"
  defp task_to_work_item_status(_), do: "open"

  defp completion_evidence_ready?(task, mission),
    do: direct_evidence_ready?(task, mission) or recovered_evidence_ready?(task, mission)

  defp direct_evidence_ready?(%{status: status}, _mission) when status != "completed",
    do: false

  defp direct_evidence_ready?(task, mission) do
    run_produced =
      is_integer(task.run_id) and task.run_id > 0 and task.dispatch_id not in [nil, ""] and
        SQL.one(
          "SELECT COUNT(*) FROM runs WHERE id=? AND chat_dispatch_id=? AND status='completed'",
          [task.run_id, task.dispatch_id]
        ) == [1]

    primary =
      (mission && task.title == "Primary task") and
        task.assignee_registration_id == mission.coordinator_registration_id

    workspace_bound =
      case task.work_item_id do
        nil ->
          false

        "" ->
          false

        work_item_id ->
          SQL.one(
            "SELECT COUNT(*) FROM work_items WHERE id=? AND base_commit<>'' AND worktree_path<>'' AND verification<>''",
            [work_item_id]
          ) == [1]
      end

    run_produced and task.summary not in [nil, ""] and
      (primary or task.workspace_mode == "shared" or workspace_bound)
  end

  @doc "Coordinator attestation binds existing successful evidence to an unchanged original objective."
  def link_recovery(user_id, channel_id, task_id, input, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         target when not is_nil(target) <- task_with_mission(task_id),
         :ok <- authorize_task_row(target, route, user_id),
         :ok <- ensure_mission_open(target.mission_status),
         :ok <- reject_worker_control(opts, :finish),
         {:ok, coordinator} <-
           assert_coordinator(user_id, channel_id, field(input, :coordinatorRegistrationId)) do
      result =
        SQL.transaction(fn ->
          target = task_row(task_id)
          mission = mission_row(target.mission_id)
          source = task_row(field(input, :sourceTaskId))
          source_mission = source && mission_row(source.mission_id)
          verification = clean(field(input, :verification), 8_000)

          unless ((mission.coordinator_registration_id == coordinator.id and source_mission) &&
                    source_mission.created_by == user_id) and
                   source_mission.vault_id == mission.vault_id and
                   source_mission.channel_id == mission.channel_id and
                   source_mission.coordinator_registration_id == coordinator.id,
                 do: raise("Recovery evidence belongs to another owner, channel, or coordinator")

          unless field(input, :objective) == mission.objective and verification != "",
            do:
              raise("Recovery requires the exact original objective and coordinator verification")

          unless field(input, :sourceRunId) == source.run_id and
                   field(input, :targetRunId) == target.run_id and
                   field(input, :targetAttempt) == target.attempt and
                   (is_nil(target.run_id) or source.run_id > target.run_id),
                 do:
                   raise(
                     "Recovery evidence is stale: pin the current target attempt and recovery run"
                   )

          unless target.id != source.id and target.status in @terminal_task_statuses and
                   not active_run?(target.run_id) and
                   direct_evidence_ready?(source, source_mission),
                 do:
                   raise(
                     "Recovery requires a settled original task and completed worker evidence"
                   )

          # Pin both attempts and all evidence-bearing inputs. Later retries or edits
          # invalidate the relationship rather than rewriting either run's history.
          target_snapshot = objective_snapshot(target, mission)
          source_snapshot = evidence_snapshot(source, source_mission)

          existing =
            SQL.one(
              "SELECT source_task_id,target_snapshot,source_snapshot,verification FROM chat_mission_recovery_evidence WHERE task_id=?",
              [task_id]
            )

          values = [source.id, target_snapshot, source_snapshot, verification]

          if existing != values do
            SQL.exec(
              "INSERT INTO chat_mission_recovery_evidence (task_id,source_task_id,target_snapshot,source_snapshot,verification,coordinator_registration_id) VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET source_task_id=excluded.source_task_id,target_snapshot=excluded.target_snapshot,source_snapshot=excluded.source_snapshot,verification=excluded.verification,coordinator_registration_id=excluded.coordinator_registration_id,created_at=datetime('now')",
              [task_id] ++ values ++ [coordinator.id]
            )

            record_event(mission.id, %{
              task_id: task_id,
              kind: "recovery_evidence_linked",
              run_id: source.run_id,
              summary: "Recovery task #{source.id}: #{verification}",
              attempt: target.attempt
            })
          end

          refresh!(mission.id)
        end)

      {:ok, result}
    else
      nil -> {:error, "Mission task not found"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp recovered_evidence_ready?(task, mission) do
    case SQL.one(
           "SELECT source_task_id,target_snapshot,source_snapshot FROM chat_mission_recovery_evidence WHERE task_id=?",
           [task.id]
         ) do
      [source_id, target_snapshot, source_snapshot] ->
        source = task_row(source_id)
        source_mission = source && mission_row(source.mission_id)

        ((task.status in @terminal_task_statuses and source) && source_mission &&
           target_snapshot == objective_snapshot(task, mission)) and
          source_snapshot == evidence_snapshot(source, source_mission) and
          direct_evidence_ready?(source, source_mission)

      _ ->
        false
    end
  end

  defp objective_snapshot(task, mission) do
    digest(
      {task.id, task.attempt, task.run_id, task.dispatch_id, task.title, task.prompt,
       task.workspace_mode, task.work_item_id, mission.id, mission.objective, mission.created_by,
       mission.vault_id, mission.channel_id, mission.coordinator_registration_id,
       SQL.one("SELECT authority_json FROM chat_missions WHERE id=?", [mission.id])}
    )
  end

  defp evidence_snapshot(task, mission) do
    digest(
      {objective_snapshot(task, mission), task.status, task.summary,
       SQL.one("SELECT status,summary,chat_dispatch_id FROM runs WHERE id=?", [task.run_id]),
       SQL.one("SELECT base_commit,worktree_path,verification FROM work_items WHERE id=?", [
         task.work_item_id
       ])}
    )
  end

  def review_fingerprint(mission_id) do
    mission = mission_row(mission_id)

    digest(
      Enum.map(task_rows(mission_id), fn task ->
        {evidence_snapshot(task, mission),
         SQL.one(
           "SELECT source_task_id,target_snapshot,source_snapshot,verification FROM chat_mission_recovery_evidence WHERE task_id=?",
           [task.id]
         ), recovered_evidence_ready?(task, mission)}
      end)
    )
  end

  defp digest(value),
    do:
      value
      |> :erlang.term_to_binary()
      |> then(&:crypto.hash(:sha256, &1))
      |> Base.encode16(case: :lower)

  defp current_primary?(task, mission, run_id) do
    is_integer(run_id) and task.run_id == run_id and task.title == "Primary task" and
      task.assignee_registration_id == mission.coordinator_registration_id
  end

  defp reject_worker_control(opts, action) do
    case worker_task_for_run(Keyword.get(opts, :current_run_id)) do
      nil ->
        :ok

      _task ->
        {:error,
         case action do
           :finish -> "Mission workers cannot finish the mission"
           :steer -> "Mission workers cannot steer other workers"
           _ -> "Mission workers cannot start or delegate missions"
         end}
    end
  end

  defp worker_task_for_run(run_id) when is_integer(run_id) and run_id > 0 do
    case SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE run_id=? LIMIT 1", [run_id]) do
      nil ->
        nil

      row ->
        task = task_from_row(row)
        mission = mission_row(task.mission_id)

        if current_primary?(task, mission, run_id), do: nil, else: task
    end
  end

  defp worker_task_for_run(_run_id), do: nil

  defp maybe_bind_primary(update, user_id, channel_id, opts) do
    run_id = Keyword.get(opts, :current_run_id)

    if Keyword.get(opts, :agent, false) and not Keyword.get(opts, :control_plane, false) and
         is_integer(run_id) and run_id > 0 do
      mission = mission_row(update.mission.id)

      active =
        SQL.one(
          """
          SELECT d.id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
          WHERE r.id=? AND r.status IN ('queued','running')
            AND d.registration_id=? AND d.channel_id=?
          """,
          [run_id, mission.coordinator_registration_id, update.channelId]
        )

      case active do
        [dispatch_id] ->
          if task_for_dispatch(dispatch_id) do
            {:ok, update}
          else
            {:ok, added} =
              add_task(
                user_id,
                channel_id,
                mission.id,
                %{
                  coordinatorRegistrationId: mission.coordinator_registration_id,
                  title: "Primary task",
                  assignee: mission.coordinator_registration_id,
                  prompt: update.mission.objective
                },
                primary: true
              )

            with {:ok, linked} <- link_dispatch(added.task.id, dispatch_id) do
              case attach_run(dispatch_id, run_id) do
                {:ok, nil} -> {:ok, linked}
                result -> result
              end
            end
          end

        nil ->
          {:ok, update}
      end
    else
      {:ok, update}
    end
  end

  defp maybe_finish_primary(mission, tasks, "completed", run_id, summary)
       when is_integer(run_id) do
    primary =
      Enum.find(tasks, fn task ->
        task.status == "running" and task.run_id == run_id and
          task.assignee_registration_id == mission.coordinator_registration_id
      end)

    if primary do
      SQL.exec(
        "UPDATE chat_mission_tasks SET status='completed',summary=?,updated_at=datetime('now') WHERE id=?",
        [summary, primary.id]
      )

      record_event(mission.id, %{
        task_id: primary.id,
        kind: "task_status_changed",
        title: primary.title,
        from_status: primary.status,
        to_status: "completed",
        summary: summary,
        run_id: primary.run_id,
        attempt: primary.attempt
      })

      sync_work_item(
        mission.created_by,
        mission,
        %{primary | status: "completed", summary: summary},
        release: true
      )

      task_rows(mission.id)
    else
      tasks
    end
  end

  defp maybe_finish_primary(_mission, tasks, _status, _run_id, _summary), do: tasks

  defp cancel_open_tasks(mission, tasks) do
    SQL.exec(
      "UPDATE chat_mission_tasks SET status='canceled',updated_at=datetime('now') WHERE mission_id=? AND status IN ('pending','running')",
      [mission.id]
    )

    Enum.each(Enum.filter(tasks, &(&1.status in ~w(pending running))), fn task ->
      record_event(mission.id, %{
        task_id: task.id,
        kind: "task_status_changed",
        title: task.title,
        from_status: task.status,
        to_status: "canceled",
        summary: "Mission canceled.",
        run_id: task.run_id,
        attempt: task.attempt
      })
    end)

    SQL.exec(
      "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id IN (SELECT dispatch_id FROM chat_mission_tasks WHERE mission_id=?)",
      [mission.id]
    )
  end

  defp cleanup_stale_wakes(mission, current_run_id) do
    stale =
      SQL.all(
        """
        SELECT m.id,d.run_id,d.id FROM chat_messages m
        JOIN chat_agent_dispatches d ON d.message_id=m.id
        WHERE m.channel_id=? AND m.id LIKE ? AND d.registration_id=?
        """,
        [mission.channel_id, "sys-mission-#{mission.id}-%", mission.coordinator_registration_id]
      )
      |> Enum.reject(fn [_id, run_id, _dispatch_id] ->
        not is_nil(run_id) and run_id == current_run_id
      end)

    {removed, canceled} =
      Enum.reduce(stale, {[], []}, fn [message_id, run_id, dispatch_id], {removed, canceled} ->
        Cascade.Missions.Dispatches.retract_pending_reply(dispatch_id)

        if is_nil(run_id) do
          SQL.exec(
            "DELETE FROM chat_agent_dispatches WHERE id=? AND run_id IS NULL AND NOT EXISTS (SELECT 1 FROM runs WHERE chat_dispatch_id=chat_agent_dispatches.id)",
            [dispatch_id]
          )
        end

        carrier = String.replace_prefix(message_id, "sys-mission-", "agent-trace-")

        shell_ids =
          if is_nil(run_id) do
            []
          else
            SQL.all(
              "SELECT id FROM chat_messages WHERE channel_id=? AND run_id=? AND registration_id=?",
              [mission.channel_id, run_id, mission.coordinator_registration_id]
            )
            |> List.flatten()
          end

        ids = [message_id, carrier | shell_ids]

        removed_now =
          Enum.filter(ids, fn id ->
            SQL.changes("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
              id,
              mission.channel_id
            ]) > 0
          end)

        {removed ++ removed_now, if(is_nil(run_id), do: canceled, else: canceled ++ [run_id])}
      end)

    %{}
    |> maybe_put_nonempty(:removedWakeMessageIds, removed)
    |> maybe_put_nonempty(:canceledWakeRunIds, canceled)
  end

  defp active_run?(nil), do: false

  defp active_run?(run_id) do
    case SQL.one("SELECT status FROM runs WHERE id=?", [run_id]) do
      [status] -> status in ~w(queued running)
      _ -> false
    end
  end

  defp assert_coordinator(user_id, channel_id, registration_id) do
    with {:ok, registration} <- find_registration(user_id, channel_id, registration_id),
         {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         [^user_id] <-
           SQL.one(
             """
             SELECT va.owner_user_id FROM chat_agent_members m
             JOIN vault_agents va ON va.id=m.vault_agent_id
             WHERE m.id=? AND m.channel_id=?
             """,
             [registration.id, route.sourceChannelId]
           ) do
      {:ok, registration}
    else
      [_other] -> {:error, "Only the agent owner can operate its mission"}
      {:error, _} = error -> error
      _ -> {:error, "Only the agent owner can operate its mission"}
    end
  end

  defp find_registration(user_id, channel_id, ref) do
    normalized = ref |> clean(120) |> String.trim_leading("@") |> String.downcase()

    with {:ok, members} <- Agents.list_members(channel_id, user_id) do
      case Enum.find(members, fn member ->
             member.id == ref or member.vaultAgentId == ref or
               String.downcase(member.mention) == normalized or
               String.downcase(member.displayName) == normalized
           end) do
        nil -> {:error, "Mission agent not found"}
        member -> {:ok, member}
      end
    end
  end

  defp find_assignee(user_id, channel_id, ref) do
    case find_registration(user_id, channel_id, ref) do
      {:ok, registration} -> {:ok, registration}
      _ -> {:error, "No channel agent matches #{to_string(ref || "")}"}
    end
  end

  defp validate_self_assignment(assignee, coordinator, anonymous, opts) do
    if assignee.id == coordinator.id and not anonymous and not Keyword.get(opts, :primary, false),
      do:
        {:error,
         "Delegate this task to another channel agent, or pass anonymous for a self-subagent"},
      else: :ok
  end

  defp ensure_mission_open(status) when status in ~w(completed canceled),
    do: {:error, "Mission is already closed"}

  defp ensure_mission_open(_status), do: :ok

  defp authorize_task_row(row, route, user_id) do
    if row.owner_channel_id == route.sourceChannelId and row.created_by == user_id,
      do: :ok,
      else: {:error, "Mission task not found"}
  end

  defp validate_dependencies(_mission_id, []), do: :ok

  defp validate_dependencies(mission_id, dependencies) do
    placeholders = Enum.map_join(dependencies, ",", fn _ -> "?" end)

    found =
      SQL.one(
        "SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=? AND id IN (#{placeholders})",
        [mission_id | dependencies]
      )
      |> hd()

    if found == length(dependencies),
      do: :ok,
      else: {:error, "Every dependency must be an existing task in this mission"}
  end

  defp validate_effort(assignee, value) do
    effort = value |> clean(20) |> String.downcase()

    allowed =
      case assignee.agentId do
        "codex" -> ["" | ~w(low medium high xhigh max ultra)]
        "claude-code" -> ["" | ~w(low medium high xhigh max)]
        _ -> [""]
      end

    if effort in allowed,
      do: {:ok, effort},
      else:
        {:error,
         "#{nonblank(effort, "Reasoning effort")} is not supported by @#{assignee.mention}"}
  end

  defp validate_idempotent_task!(nil, _prompt, _deps, _priority, _effort, _anonymous, _workspace),
    do: :ok

  defp validate_idempotent_task!(task, prompt, deps, priority, effort, anonymous, workspace) do
    if task.prompt != prompt or task.depends_on_json != deps or task.priority != priority or
         task.reasoning_effort != effort or task.anonymous != 0 != anonymous or
         task.workspace_mode != workspace do
      raise "A task with this title already exists with different scheduling options; use a distinct title"
    end
  end

  defp dependency_attention?(task, by_id, seen \\ MapSet.new()) do
    if MapSet.member?(seen, task.id) do
      false
    else
      seen = MapSet.put(seen, task.id)

      Enum.any?(dependencies(task), fn id ->
        case by_id[id] do
          nil -> false
          dependency when dependency.status in ~w(failed blocked canceled) -> true
          %{status: "pending"} = dependency -> dependency_attention?(dependency, by_id, seen)
          _ -> false
        end
      end)
    end
  end

  defp dependencies(task) do
    case Jason.decode(task.depends_on_json || "[]") do
      {:ok, values} when is_list(values) -> Enum.filter(values, &is_binary/1)
      _ -> []
    end
  end

  defp queue_reason(%{status: status}, _waiting, _attention) when status != "pending", do: ""
  defp queue_reason(_task, waiting, true) when waiting != [], do: "dependency-attention"
  defp queue_reason(_task, waiting, _attention) when waiting != [], do: "dependency"
  defp queue_reason(%{dispatch_id: id}, _waiting, _attention) when not is_nil(id), do: "queued"
  defp queue_reason(_task, _waiting, _attention), do: "agent-busy"

  defp record_event(mission_id, input) do
    SQL.exec(
      """
      INSERT INTO chat_mission_events
        (mission_id,task_id,kind,title,from_status,to_status,summary,run_id,attempt)
      VALUES (?,?,?,?,?,?,?,?,?)
      """,
      [
        mission_id,
        input[:task_id],
        input.kind,
        input[:title] || "",
        input[:from_status] || "",
        input[:to_status] || "",
        input[:summary] || "",
        input[:run_id],
        input[:attempt] || 0
      ]
    )
  end

  defp mission_row(id) do
    SQL.one("SELECT #{@mission_select} FROM chat_missions WHERE id=?", [id])
    |> mission_from_nullable_row()
  end

  defp task_row(id) do
    SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE id=?", [id])
    |> task_from_nullable_row()
  end

  defp task_for_dispatch(dispatch_id) when dispatch_id in [nil, ""], do: nil

  defp task_for_dispatch(dispatch_id) do
    SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE dispatch_id=?", [dispatch_id])
    |> task_from_nullable_row()
  end

  defp task_rows(mission_id) do
    SQL.all(
      "SELECT #{@task_select} FROM chat_mission_tasks WHERE mission_id=? ORDER BY created_at ASC,rowid ASC",
      [mission_id]
    )
    |> Enum.map(&task_from_row/1)
  end

  defp task_with_mission(id) do
    SQL.one(
      """
      SELECT #{@qualified_task_select},m.channel_id,m.created_by,m.status
      FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
      WHERE t.id=?
      """,
      [id]
    )
    |> case do
      nil ->
        nil

      row ->
        {task_values, [channel_id, created_by, mission_status]} = Enum.split(row, 18)

        task_values
        |> task_from_row()
        |> Map.merge(%{
          owner_channel_id: channel_id,
          created_by: created_by,
          mission_status: mission_status
        })
    end
  end

  defp mission_from_nullable_row(nil), do: nil
  defp mission_from_nullable_row(row), do: mission_from_row(row)

  defp mission_from_row([
         id,
         vault_id,
         channel_id,
         root_message_id,
         coordinator_registration_id,
         title,
         objective,
         status,
         summary,
         wake_sent,
         created_by,
         created_at,
         updated_at
       ]) do
    %{
      id: id,
      vault_id: vault_id,
      channel_id: channel_id,
      root_message_id: root_message_id,
      coordinator_registration_id: coordinator_registration_id,
      title: title,
      objective: objective || "",
      status: if(status in @mission_statuses, do: status, else: "active"),
      summary: summary || "",
      wake_sent: wake_sent || 0,
      created_by: created_by,
      created_at: created_at,
      updated_at: updated_at
    }
  end

  defp task_from_nullable_row(nil), do: nil
  defp task_from_nullable_row(row), do: task_from_row(row)

  defp task_from_row([
         id,
         mission_id,
         title,
         assignee_registration_id,
         status,
         summary,
         prompt,
         depends_on_json,
         priority,
         reasoning_effort,
         anonymous,
         workspace_mode,
         dispatch_id,
         run_id,
         attempt,
         work_item_id,
         created_at,
         updated_at
       ]) do
    %{
      id: id,
      mission_id: mission_id,
      title: title,
      assignee_registration_id: assignee_registration_id,
      status: if(status in @task_statuses, do: status, else: "pending"),
      summary: summary || "",
      prompt: prompt || "",
      depends_on_json: depends_on_json || "[]",
      priority: priority || 0,
      reasoning_effort: reasoning_effort || "",
      anonymous: anonymous || 0,
      workspace_mode: workspace_mode || "shared",
      dispatch_id: dispatch_id,
      run_id: run_id,
      attempt: attempt || 0,
      work_item_id: work_item_id,
      created_at: created_at,
      updated_at: updated_at
    }
  end

  defp event_from_row([
         id,
         mission_id,
         task_id,
         kind,
         title,
         from_status,
         to_status,
         summary,
         run_id,
         attempt,
         created_at
       ]) do
    %{
      id: id,
      missionId: mission_id,
      kind: kind,
      title: title,
      fromStatus: from_status,
      toStatus: to_status,
      summary: summary,
      attempt: attempt || 0,
      createdAt: created_at
    }
    |> maybe_put(:taskId, task_id)
    |> maybe_put(:runId, run_id)
  end

  defp work_item_branch(mission_id, task_id, title) do
    slug =
      title
      |> clean(40)
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9]+/, "-")
      |> String.trim("-")
      |> String.slice(0, 32)
      |> nonblank("task")

    "cascade/#{String.slice(mission_id, 0, 8)}/#{slug}-#{String.slice(task_id, 0, 6)}"
  end

  defp clean_ids(values) do
    values
    |> List.wrap()
    |> Enum.map(&clean(&1, 80))
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  defp field(nil, _key), do: nil

  defp field(map, key) do
    Map.get(map, key, Map.get(map, Atom.to_string(key)))
  end

  defp clean(nil, _max), do: ""
  defp clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)
  defp integer(value, _fallback) when is_integer(value), do: value
  defp integer(value, _fallback) when is_float(value), do: value |> Float.floor() |> trunc()

  defp integer(value, fallback) do
    case Integer.parse(to_string(value || "")) do
      {number, _} -> number
      _ -> fallback
    end
  end

  defp truthy?(value) when value in [nil, false, 0, 0.0, ""], do: false
  defp truthy?(_value), do: true
  defp nonblank(nil, fallback), do: fallback
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value
  defp agent_name(nil), do: "agent"
  defp agent_name(agent), do: nonblank(agent.displayName, agent.mention)
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp maybe_put_nonblank(map, _key, value) when value in [nil, ""], do: map
  defp maybe_put_nonblank(map, key, value), do: Map.put(map, key, value)
  defp maybe_put_nonempty(map, _key, []), do: map
  defp maybe_put_nonempty(map, key, value), do: Map.put(map, key, value)
end
