defmodule Cascade.Missions.Store do
  @moduledoc "Authoritative mission/task state machine and materialized chat projection."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.WorkItems
  alias Cascade.Content.Store, as: ContentStore

  @mission_statuses ~w(active reviewing attention blocked completed canceled)
  @task_statuses ~w(pending running completed failed blocked canceled)
  @terminal_task_statuses ~w(completed failed blocked canceled)
  @task_purposes ~w(research implementation review fix integration verification)

  @mission_select """
  id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,
  status,summary,wake_sent,created_by,created_at,updated_at,phase,approved_at,approved_by,
  approved_revisions_json,creation_fingerprint
  """

  @task_select """
  id,mission_id,title,assignee_registration_id,status,summary,prompt,depends_on_json,
  priority,reasoning_effort,anonymous,workspace_mode,dispatch_id,run_id,attempt,work_item_id,
  created_at,updated_at,purpose,brief_note_id,brief_revisions_json,review_outcome,verification_passed
  """

  @qualified_task_select """
  t.id,t.mission_id,t.title,t.assignee_registration_id,t.status,t.summary,t.prompt,
  t.depends_on_json,t.priority,t.reasoning_effort,t.anonymous,t.workspace_mode,t.dispatch_id,t.run_id,
  t.attempt,t.work_item_id,t.created_at,t.updated_at,t.purpose,t.brief_note_id,t.brief_revisions_json,
  t.review_outcome,t.verification_passed
  """

  @task_field_count 23

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

              Cascade.Missions.Interpretation.initialize(mission_id)
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

  @doc "Creates one vault-scoped mission workspace and its durable brief."
  def create_workspace(user_id, vault_id, input, opts \\ []) do
    with vault when not is_nil(vault) <- ContentStore.get_writable_vault(vault_id, user_id),
         {:ok, mission_id} <- workspace_id(field(input, :id)),
         title when title != "" <- clean(field(input, :title), 180),
         identity_id when identity_id != "" <-
           clean(field(input, :coordinatorIdentityId), 120),
         brief when brief != "" <-
           clean(nonblank(field(input, :briefContent), title), 12_000) do
      fingerprint = mission_id
      resources_key = {__MODULE__, :workspace_resources}
      Process.put(resources_key, %{})

      try do
        SQL.transaction(fn ->
          if is_nil(ContentStore.get_writable_vault(vault_id, user_id)),
            do: raise("Vault not found")

          existing =
            SQL.one(
              """
              SELECT m.id,m.vault_id,m.coordinator_registration_id,m.title,m.objective,
                     c.vault_agent_id
              FROM chat_missions m
              LEFT JOIN chat_agent_members c
                ON c.channel_id=m.channel_id AND c.id=m.coordinator_registration_id
              WHERE m.id=? OR m.creation_fingerprint=?
              ORDER BY CASE WHEN m.id=? THEN 0 ELSE 1 END,m.rowid
              LIMIT 1
              """,
              [mission_id, fingerprint, mission_id]
            )

          result =
            case existing do
              [^mission_id, ^vault_id, _registration_id, existing_title, existing_brief,
               ^identity_id] ->
                if existing_title == title and existing_brief == brief do
                  get_workspace(user_id, vault_id, mission_id)
                else
                  {:error, "Mission retry has different creation options"}
                end

              [_existing_id, _other_vault, _registration_id, _title, _brief, _identity_id] ->
                {:error, "Mission id is already in use"}
              nil ->
                create_workspace_attempt(
                  user_id,
                  vault_id,
                  mission_id,
                  fingerprint,
                  title,
                  identity_id,
                  brief,
                  opts
                )
            end

          case result do
            {:ok, _workspace} = ok ->
              ok

            {:error, reason} ->
              cleanup_workspace_resources(Process.get(resources_key, %{}), vault_id)
              {:error, reason}

            other ->
              cleanup_workspace_resources(Process.get(resources_key, %{}), vault_id)
              {:error, other}
          end
        end)
      rescue
        error ->
          cleanup_workspace_resources(Process.get(resources_key, %{}), vault_id)
          {:error, Exception.message(error)}
      after
        Process.delete(resources_key)
      end
    else
      nil -> {:error, "Vault not found"}
      "" -> {:error, "Mission title, coordinator identity, and brief are required"}
      {:error, _} = error -> error
    end
  end

  def list_workspace(user_id, vault_id) do
    case ContentStore.get_vault(vault_id, user_id) do
      nil ->
        {:error, "Vault not found"}

      _vault ->
        SQL.all(
          "SELECT #{@mission_select} FROM chat_missions WHERE vault_id=? ORDER BY updated_at DESC,rowid DESC",
          [vault_id]
        )
        |> Enum.map(&mission_from_row/1)
        |> Enum.map(&refresh(&1.id))
        |> Enum.reduce_while({:ok, []}, fn
          {:ok, mission}, {:ok, missions} -> {:cont, {:ok, missions ++ [mission]}}
          {:error, reason}, _ -> {:halt, {:error, reason}}
        end)
    end
  end

  def get_workspace(user_id, vault_id, mission_id) do
    with vault when not is_nil(vault) <- ContentStore.get_vault(vault_id, user_id),
         mission when not is_nil(mission) <- mission_row(mission_id),
         true <- mission.vault_id == vault.id do
      refresh(mission.id)
    else
      nil -> {:error, "Vault not found"}
      false -> {:error, "Mission not found"}
    end
  end

  def create_workspace_note(user_id, vault_id, mission_id, input, _opts \\ []) do
    with vault when not is_nil(vault) <- ContentStore.get_writable_vault(vault_id, user_id),
         mission when not is_nil(mission) <- mission_row(mission_id),
         true <- mission.vault_id == vault.id,
         kind when kind in ~w(milestone feature) <- clean(field(input, :kind), 20),
         title when title != "" <- clean(field(input, :title), 180),
         content <- clean(field(input, :content), 20_000),
         {:ok, parent} <- workspace_note_parent(mission.id, kind, field(input, :parentNoteId)),
         {:ok, note} <-
           workspace_note(
             vault_id,
             user_id,
             %{
               id: clean(field(input, :id), 120),
               title: title,
               content: content,
               is_listed: false
             }
           ) do
      revision = Cascade.Content.Privacy.note_revision(note)
      position = next_note_position(mission.id, parent)

      SQL.transaction(fn ->
        SQL.exec(
          """
          INSERT INTO chat_mission_notes
            (mission_id,note_id,kind,parent_note_id,position,revision)
          VALUES (?,?,?,?,?,?)
          """,
          [mission.id, note.id, kind, parent, position, revision]
        )

        SQL.exec("UPDATE chat_missions SET updated_at=datetime('now') WHERE id=?", [mission.id])
      end)

      note_changed(note.id, user_id, :create)
      {:ok, %{note: workspace_note_projection(mission.id, note.id), mission: refresh!(mission.id).mission}}
    else
      nil -> {:error, "Vault or mission not found"}
      false -> {:error, "Mission does not belong to this vault"}
      "" -> {:error, "Mission note title is required"}
      kind when is_binary(kind) -> {:error, "Mission note kind must be milestone or feature"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def approve_workspace(user_id, vault_id, mission_id, expected_revisions, _opts \\ []) do
    result = SQL.transaction(fn ->
      with vault when not is_nil(vault) <- ContentStore.get_writable_vault(vault_id, user_id),
           mission when not is_nil(mission) <- mission_row(mission_id),
           true <- mission.vault_id == vault.id,
           :ok <- ensure_workspace_brief(mission.id),
           revisions <- workspace_revisions(mission.id),
           :ok <- ensure_expected_revisions(revisions, expected_revisions) do
        approved_at = DateTime.utc_now() |> DateTime.to_iso8601()

        SQL.exec(
          """
          UPDATE chat_missions
          SET phase='executing',status='active',approved_at=?,approved_by=?,
              approved_revisions_json=?,wake_sent=0,updated_at=datetime('now')
          WHERE id=? AND phase<>'closed'
          """,
          [approved_at, user_id, Jason.encode!(revisions), mission.id]
        )

        record_event(mission.id, %{
          kind: "mission_approved",
          title: mission.title,
          to_status: "active",
          summary: Jason.encode!(%{approvedBy: user_id, revisions: revisions})
        })

        Cascade.Missions.Interpretation.resolve_migration_decision(mission.id, user_id)
        Cascade.Missions.Interpretation.initialize(mission.id)
        {:ok, mission.id}
      else
        nil -> {:error, "Vault or mission not found"}
        false -> {:error, "Mission does not belong to this vault"}
        {:error, _} = error -> error
      end
    end)

    with {:ok, id} <- result do
      _ = Cascade.Missions.Scheduler.schedule(id)
      {:ok, refresh!(id).mission}
    end
  rescue
    error -> {:error, Exception.message(error)}
  end
  @doc "Records a successful linked-note mutation and coalesces coordinator awareness."
  def note_changed(note_id, actor_id, kind, opts \\ []) do
    Cascade.Missions.Interpretation.note_changed(note_id, actor_id, kind, opts)
  rescue
    error ->
      if Keyword.get(opts, :in_transaction, false),
        do: reraise(error, __STACKTRACE__),
        else: :ok
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

  @doc "Read-only ownership projection; never expands prompts, authority, or historical task detail."
  def list_compact(user_id, channel_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, statuses} <-
           list_statuses(opts[:status], @mission_statuses, ~w(active reviewing attention blocked)),
         {:ok, task_statuses} <-
           list_statuses(opts[:task_status], @task_statuses, ~w(pending running failed blocked)) do
      coordinator = clean(opts[:coordinator], 120)
      mission_id = clean(opts[:mission_id], 120)

      missions =
        SQL.all(
          """
          SELECT m.id,m.title,m.status,m.coordinator_registration_id,COALESCE(a.mention,'')
          FROM chat_missions m
          LEFT JOIN chat_agent_members a ON a.id=m.coordinator_registration_id
          WHERE m.channel_id=? AND (?='' OR m.coordinator_registration_id=?)
            AND (?='' OR m.id=?) AND m.status IN (#{Enum.map_join(statuses, ",", fn _ -> "?" end)})
          ORDER BY m.updated_at DESC,m.rowid DESC
          """,
          [route.sourceChannelId, coordinator, coordinator, mission_id, mission_id] ++ statuses
        )
        |> Enum.map(fn [id, title, status, owner, mention] ->
          tasks =
            SQL.all(
              """
              SELECT t.id,t.title,t.status,t.assignee_registration_id,COALESCE(a.mention,''),t.anonymous
              FROM chat_mission_tasks t
              LEFT JOIN chat_agent_members a ON a.id=t.assignee_registration_id
              WHERE t.mission_id=? AND t.status IN (#{Enum.map_join(task_statuses, ",", fn _ -> "?" end)})
              ORDER BY t.created_at,t.rowid
              """,
              [id] ++ task_statuses
            )
            |> Enum.map(fn [task_id, title, status, owner, mention, anonymous] ->
              %{
                id: task_id,
                title: title,
                status: status,
                assigneeRegistrationId: owner,
                assigneeMention:
                  if(anonymous != 0 and mention != "", do: mention <> "·sub", else: mention)
              }
            end)

          %{
            id: id,
            title: title,
            status: status,
            coordinatorRegistrationId: owner,
            coordinatorMention: mention,
            tasks: tasks
          }
        end)

      {:ok, missions}
    end
  end

  defp list_statuses(value, allowed, open) do
    case value do
      value when value in [nil, "", "open"] ->
        {:ok, open}

      "all" ->
        {:ok, allowed}

      value when is_binary(value) ->
        statuses =
          value |> String.split(",") |> Enum.map(&String.trim/1) |> Enum.uniq()

        if statuses != [] and Enum.all?(statuses, &(&1 in allowed)),
          do: {:ok, statuses},
          else: {:error, :invalid_list_status}

      _ ->
        {:error, :invalid_list_status}
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
         purpose when purpose in @task_purposes <-
           clean(nonblank(field(input, :purpose), "implementation"), 30),
         :ok <- validate_task_purpose(mission, purpose),
         {:ok, coordinator} <- assert_coordinator(user_id, channel_id, coordinator_id),
         true <- mission.coordinator_registration_id == coordinator.id,
         :ok <- reject_worker_control(opts, :delegate),
         {:ok, assignee} <- find_assignee(user_id, channel_id, field(input, :assignee)),
         anonymous <- truthy?(field(input, :anonymous)),
         :ok <- validate_self_assignment(assignee, coordinator, anonymous, opts),
         title when title != "" <- clean(field(input, :title), 240),
         dependencies <- clean_ids(field(input, :dependsOn)),
         :ok <- validate_dependencies(mission.id, dependencies),
         :ok <- validate_reviewer_distinct(mission.id, purpose, assignee.id, dependencies),
         {:ok, effort} <- validate_effort(assignee, field(input, :reasoningEffort)),
         workspace_mode when workspace_mode in ~w(shared isolated) <-
           clean(nonblank(field(input, :workspaceMode), "shared"), 20) do
      priority = field(input, :priority) |> integer(0) |> max(-100) |> min(100)
      prompt = clean(nonblank(field(input, :prompt), title), 12_000)
      dependency_json = Jason.encode!(dependencies)
      anonymous_int = if anonymous, do: 1, else: 0

      result =
        SQL.transaction(fn ->
          # Recheck under the write lock: Stop or a historical fence may have
          # arrived while this delegation was waiting to commit.
          current = mission_row(mission.id)
          if current.status in ~w(completed canceled) or current.phase == "closed",
            do: raise(ArgumentError, "Mission is already closed")

          if Cascade.Missions.Interpretation.migration_decision_pending?(mission.id),
            do: raise(ArgumentError, "Historical mission requires an explicit resumption decision")

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

          case task_brief(
                 mission.id,
                 field(input, :briefNoteId),
                 field(input, :briefRevisions),
                 existing
               ) do
            {:ok, brief_note_id, brief_revisions} ->
              brief_revision_json = Jason.encode!(brief_revisions)
              validate_idempotent_task!(
                existing,
                prompt,
                dependency_json,
                priority,
                effort,
                anonymous,
                workspace_mode,
                purpose,
                brief_note_id,
                brief_revisions
              )

              task_id = if existing, do: existing.id, else: Ecto.UUID.generate()

              if is_nil(existing) do
                SQL.exec(
                  """
                  INSERT INTO chat_mission_tasks
                    (id,mission_id,title,assignee_registration_id,prompt,depends_on_json,
                     priority,reasoning_effort,anonymous,workspace_mode,parent_task_id,purpose,
                     brief_note_id,brief_revisions_json)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                    Keyword.get(opts, :parent_task_id),
                    purpose,
                    brief_note_id,
                    brief_revision_json
                  ]
                )

                SQL.exec(
                  "UPDATE chat_missions SET status='active',phase=CASE WHEN ?='research' THEN phase ELSE 'executing' END,wake_sent=0,updated_at=datetime('now') WHERE id=?",
                  [purpose, mission.id]
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

            {:error, reason} ->
              {:error, reason}
          end
        end)

      case result do
        {:error, reason} -> {:error, reason}
        result -> {:ok, result}
      end
    else
      false -> {:error, "Mission belongs to another coordinator"}
      "" -> {:error, "Task title is required"}
      purpose when is_binary(purpose) -> {:error, "Invalid mission task purpose"}
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
        WHERE phase IN ('planning','executing')
          AND status IN ('active','reviewing','attention','blocked') #{filter}
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
            WHERE m.channel_id=? AND m.phase IN ('planning','executing')
              AND m.status IN ('active','reviewing','attention','blocked')
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
              task_schedulable?(mission, task, by_id) and
              not Cascade.Missions.Children.joining?(task.id)
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
              attempt: task.attempt || 0,
              purpose: task.purpose,
              briefNoteId: task.brief_note_id,
              briefRevisions: decode_json_map(task.brief_revisions_json),
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

        action_key =
          Cascade.Missions.Interpretation.action_key(caller_run, ["steer", task_id, instruction])

        case action_key &&
               SQL.one("SELECT id FROM chat_mission_events WHERE source_key=?", [action_key]) do
          [id] ->
            {:ok, id}

          _ ->
            unless task.attempt == field(input, :attempt) and task.run_id == field(input, :runId),
              do: raise("Task changed; refresh its status before steering")

            if instruction == "", do: raise("Steering needs a message")

            if Cascade.Missions.PendingSteering.pending_for_task?(task_id),
              do: raise("Task already has queued steering; inspect mission history")

            record_event(mission.id, %{
              task_id: task.id,
              kind: "steering_requested",
              title: task.title,
              summary: instruction,
              run_id: task.run_id,
              attempt: task.attempt,
              source_key: action_key
            })

            {:ok, SQL.last_insert_id()}
        end
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
         status when status in @task_statuses <- clean(field(input, :status), 40),
         :ok <- validate_task_outcome(row, status, input) do
      summary = clean(field(input, :summary), 4_000)
      review_outcome = normalized_review_outcome(row, input)
      verification_passed = normalized_verification(row, input)
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
                    review_outcome=NULL,verification_passed=NULL,attempt=attempt+1,updated_at=datetime('now') WHERE id=?
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
                  "UPDATE chat_mission_tasks SET status=?,summary=?,review_outcome=?,verification_passed=?,updated_at=datetime('now') WHERE id=?",
                  [status, summary, review_outcome, verification_passed, task_id]
                )

                if row.status != status or row.summary != summary or
                     field(input, :finding) == true do
                  record_event(row.mission_id, %{
                    task_id: task_id,
                    kind:
                      if(field(input, :finding) == true,
                        do: "task_finding",
                        else: "task_status_changed"
                      ),
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

            if final_status == "completed" do
              ensure_delivery_ready!(mission, tasks)
            end

            if final_status == "completed" and
                 Enum.any?(tasks, fn task ->
                   task.status in ~w(pending running blocked) or
                     (not current_primary?(task, mission, current_run_id) and
                        SQL.one(
                          "SELECT 1 FROM runs WHERE id=? AND status IN ('queued','running')",
                          [task.run_id]
                        ) == [1])
                 end) do
              raise "Mission still has active workers"
            end

            verification = clean(field(input, :verification), 8_000)

            SQL.exec("UPDATE chat_missions SET verification=? WHERE id=?", [
              verification,
              mission.id
            ])

            record_event(mission.id, %{kind: "coordinator_verification", summary: verification})

            SQL.exec(
              "UPDATE chat_missions SET phase=CASE WHEN ? IN ('completed','canceled') THEN 'closed' ELSE phase END,status=?,summary=?,wake_sent=1,updated_at=datetime('now') WHERE id=?",
              [final_status, final_status, summary, mission.id]
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

            cleanup =
              if final_status == "canceled",
                do: cleanup_stale_wakes(mission, current_run_id),
                else: %{}

            Enum.each(task_rows(mission.id), fn task ->
              sync_work_item(user_id, mission, task, release: true)
            end)

            update = refresh!(mission.id) |> Map.merge(cleanup)
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

  @doc "Claims a coalesced interpretation without waiting for independent workers."
  def claim_wake(mission_id) do
    with {:ok, update} <- refresh(mission_id) do
      case Cascade.Missions.Interpretation.claim(update) do
        nil ->
          mission = mission_row(mission_id)

          if mission.wake_sent == 0 and update.mission.tasks == [] and
               update.mission.status == "attention" and recoverable_creation?(mission) do
            {:ok,
             Map.merge(update, %{
               coordinatorRegistrationId: mission.coordinator_registration_id,
               generation: "setup"
             })}
          else
            {:ok, nil}
          end

        wake ->
          {:ok, wake}
      end
    end
  end

  def settle_run(run_id, status, summary) when status in ~w(completed failed canceled) do
    if status == "canceled" and Cascade.Missions.PendingSteering.interrupting?(run_id),
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
            _tasks = task_rows(task.mission_id)

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
      [run_id, status] when status in ~w(completed failed canceled) ->
        not Cascade.Chat.Continuations.owns_recovery?(run_id) and
          (status != "canceled" or
             SQL.one(
               "SELECT 1 FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload_json,'$.steering')=1 LIMIT 1",
               [run_id]
             ) == [1])

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
          purpose: task.purpose,
          briefNoteId: task.brief_note_id,
          briefRevisions: decode_json_map(task.brief_revisions_json),
          reviewOutcome: task.review_outcome,
          verificationPassed: task.verification_passed,
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
      vaultId: mission.vault_id,
      channelId: mission.channel_id,
      rootMessageId: mission.root_message_id,
      title: mission.title,
      objective: mission.objective,
      phase: mission.phase,
      authority:
        SQL.one("SELECT authority_json FROM chat_missions WHERE id=?", [mission.id])
        |> hd()
        |> Jason.decode!(),
      verification:
        SQL.one("SELECT verification FROM chat_missions WHERE id=?", [mission.id]) |> hd(),
      status: derive_status(mission, tasks),
      coordinator: if(coordinator, do: agent_name(coordinator), else: "Coordinator"),
      coordinatorMention: if(coordinator, do: coordinator.mention || "", else: ""),
      coordinatorRegistrationId: mission.coordinator_registration_id,
      tasks: projected_tasks,
      notes: workspace_note_projections(mission.id),
      approvedAt: mission.approved_at,
      approvedBy: mission.approved_by,
      approvedRevisions: decode_json_map(mission.approved_revisions_json),
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
    # Task completion records the delivered outcome; run status records provider
    # execution. A recovered delivery may complete a task whose bound run failed.
    # Keep that failure intact, require a settled bound run, and leave observed
    # verification and coordinator authority to finish/5. Canceled runs never qualify.
    run_produced =
      is_integer(task.run_id) and task.run_id > 0 and task.dispatch_id not in [nil, ""] and
        SQL.one(
          "SELECT COUNT(*) FROM runs WHERE id=? AND chat_dispatch_id=? AND status IN ('completed','failed')",
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

  @doc "Verified same-owner room outcomes that may clear an open mission's blocker."
  def recovery_context(mission_id) do
    SQL.all(
      """
      SELECT source.id,source.title,substr(source.verification,1,2000)
      FROM chat_missions target JOIN chat_missions source
        ON source.channel_id=target.channel_id AND source.created_by=target.created_by
      WHERE target.id=? AND source.id<>target.id AND source.status='completed'
        AND source.verification<>'' AND source.updated_at>=target.created_at
        AND EXISTS (SELECT 1 FROM chat_mission_tasks t
          WHERE t.mission_id=target.id AND t.status IN ('blocked','failed'))
      ORDER BY source.updated_at DESC,source.id LIMIT 8
      """,
      [mission_id]
    )
    |> Enum.map(fn [id, title, verification] ->
      %{missionId: id, title: title, verification: verification}
    end)
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
                  purpose: if(mission.phase == "planning", do: "research", else: "implementation"),
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

  defp ensure_delivery_ready!(mission, tasks) do
    historical = SQL.all("SELECT task_id,attempt FROM chat_mission_events WHERE mission_id=? AND kind='historical_task_fenced'", [mission.id]) |> MapSet.new(&List.to_tuple/1)
    tasks = Enum.reject(tasks, &MapSet.member?(historical, {&1.id, &1.attempt}))

    if Enum.any?(tasks, &(&1.status in ~w(pending running failed blocked canceled))) do
      raise "Mission has unfinished or failed work"
    end

    delivered = Enum.filter(tasks, &(&1.purpose in ~w(implementation fix)))

    if delivered == [] do
      raise "Mission has no delivered implementation work"
    end

    by_id = Map.new(tasks, &{&1.id, &1})
    accepted_reviews = Enum.filter(tasks, &accepted_review?/1)
    integrations = Enum.filter(tasks, &(&1.purpose == "integration" and &1.status == "completed"))
    passed_verifications = Enum.filter(tasks, &passed_verification?/1)

    unless Enum.all?(delivered, &delivery_covered?(&1, accepted_reviews, integrations, passed_verifications, by_id)) do
      raise "Every delivered implementation or fix must have an accepted review, integration, and passed verification"
    end

    unless Enum.all?(
               Enum.filter(tasks, &negative_review?/1),
               &negative_review_resolved?(&1, accepted_reviews, by_id)
             ) do
      raise "Every changes-requested review must be resolved by a fix and re-review"
    end

    unless Enum.all?(
               Enum.filter(tasks, &negative_verification?/1),
               &negative_verification_resolved?(&1, passed_verifications, by_id)
             ) do
      raise "Every failed verification must be resolved by a subsequent passed verification"
    end

    :ok
  end

  defp accepted_review?(task) do
    task.purpose == "review" and task.status == "completed" and
      task.review_outcome == "accepted"
  end

  defp passed_verification?(task) do
    task.purpose == "verification" and task.status == "completed" and
      task.verification_passed == true
  end

  defp negative_review?(task) do
    task.purpose == "review" and task.status == "completed" and
      task.review_outcome == "changes_requested"
  end

  defp negative_verification?(task) do
    task.purpose == "verification" and task.status == "completed" and
      task.verification_passed == false
  end

  defp delivery_covered?(work, accepted_reviews, integrations, passed_verifications, by_id) do
    Enum.any?(accepted_reviews, fn review ->
      work.id in dependency_closure(dependencies(review), by_id) and
        Enum.any?(integrations, fn integration ->
          review.id in dependencies(integration) and
            Enum.any?(passed_verifications, fn verification ->
              integration.id in dependencies(verification)
            end)
        end)
    end)
  end

  defp negative_review_resolved?(negative, accepted_reviews, by_id) do
    Enum.any?(accepted_reviews, fn review ->
      closure = dependency_closure(dependencies(review), by_id)

      negative.id in closure and
        Enum.any?(closure, fn id ->
          case by_id[id] do
            %{purpose: "fix"} = fix ->
              negative.id in dependency_closure(dependencies(fix), by_id)

            _ ->
              false
          end
        end)
    end)
  end

  defp negative_verification_resolved?(negative, passed_verifications, by_id) do
    Enum.any?(passed_verifications, fn verification ->
      negative.id in dependency_closure(dependencies(verification), by_id)
    end)
  end

  defp dependency_closure(ids, by_id, seen \\ MapSet.new()) do
    Enum.reduce(ids, seen, fn id, acc ->
      if MapSet.member?(acc, id) do
        acc
      else
        acc = MapSet.put(acc, id)

        case by_id[id] do
          nil -> acc
          task -> dependency_closure(dependencies(task), by_id, acc)
        end
      end
    end)
  end

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

  defp validate_task_purpose(%{phase: phase}, _) when phase in ~w(planning executing), do: :ok
  defp validate_task_purpose(%{phase: "closed"}, _), do: {:error, "Mission is already closed"}
  defp validate_task_purpose(_, _), do: {:error, "Mission phase is invalid"}

  defp validate_reviewer_distinct(_mission_id, purpose, _assignee, _dependencies)
       when purpose != "review",
       do: :ok

  defp validate_reviewer_distinct(mission_id, "review", assignee, dependencies) do
    by_id = Map.new(task_rows(mission_id), &{&1.id, &1})

    if Enum.any?(dependency_closure(dependencies, by_id), fn id ->
         task = by_id[id]
         task.assignee_registration_id == assignee and task.purpose in ~w(implementation fix)
       end) do
      {:error, "Review assignee must be independent from implementation and fix workers"}
    else
      :ok
    end
  end

  defp task_brief(_mission_id, nil, expected, _existing) do
    normalized = normalize_revisions(expected)

    if expected in [nil, ""] or normalized == %{},
      do: {:ok, nil, %{}},
      else: {:error, {:revision_conflict, %{}}}
  end

  defp task_brief(_mission_id, "", expected, _existing) do
    normalized = normalize_revisions(expected)

    if expected in [nil, ""] or normalized == %{},
      do: {:ok, nil, %{}},
      else: {:error, {:revision_conflict, %{}}}
  end

  defp task_brief(mission_id, note_id, expected, existing) do
    case SQL.one(
           """
           SELECT mn.note_id,n.revision_counter
           FROM chat_mission_notes mn
           JOIN notes n ON n.id=mn.note_id
           WHERE mn.mission_id=? AND mn.note_id=?
           """,
           [mission_id, clean(note_id, 120)]
         ) do
      [id, revision_counter] ->
        current =
          if expected in [nil, ""] and existing && existing.brief_note_id == id,
            do: decode_json_map(existing.brief_revisions_json),
            else: %{id => Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter})}

        if expected in [nil, ""] or normalize_revisions(expected) == current,
          do: {:ok, id, current},
          else: {:error, {:revision_conflict, current}}

      _ ->
        {:error, "Task brief note is not linked to this mission"}
    end
  end
  defp validate_task_outcome(%{purpose: "review"}, "completed", input) do
    case clean(field(input, :reviewOutcome), 30) do
      outcome when outcome in ~w(accepted changes_requested) -> :ok
      _ -> {:error, "Review completion requires reviewOutcome accepted or changes_requested"}
    end
  end

  defp validate_task_outcome(%{purpose: "verification"}, "completed", input) do
    case field(input, :verificationPassed) do
      value when value in [true, false, 1, 0, "true", "false", "1", "0"] -> :ok
      _ -> {:error, "Verification completion requires verificationPassed true or false"}
    end
  end

  defp validate_task_outcome(_row, _status, _input), do: :ok

  defp normalized_review_outcome(%{review_outcome: current}, input) do
    value = field(input, :reviewOutcome)
    if is_nil(value), do: current, else: clean(value, 30)
  end

  defp normalized_verification(%{verification_passed: current}, input) do
    case field(input, :verificationPassed) do
      nil -> current
      value when value in [true, 1, "true", "1"] -> true
      value when value in [false, 0, "false", "0"] -> false
      _ -> current
    end
  end

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
  defp task_schedulable?(mission, task, by_id) do
    dependencies = dependencies(task)

    mission.phase in ~w(planning executing) and
      not Cascade.Missions.Interpretation.migration_decision_pending?(mission.id) and
      required_stage_dependency?(task, dependencies, by_id) and
      Enum.all?(dependencies, fn id ->
        case by_id[id] do
          nil -> false
          dependency -> dependency_ready_for?(task, dependency)
        end
      end)
  end

  defp required_stage_dependency?(%{purpose: "integration"}, dependencies, by_id) do
    Enum.any?(dependencies, fn id ->
      case by_id[id] do
        %{purpose: "review", status: "completed", review_outcome: "accepted"} = review ->
          Enum.any?(dependency_closure(dependencies(review), by_id), fn dependency_id ->
            case by_id[dependency_id] do
              %{purpose: purpose} when purpose in ~w(implementation fix) -> true
              _ -> false
            end
          end)

        _ ->
          false
      end
    end)
  end

  defp required_stage_dependency?(%{purpose: "verification"}, dependencies, by_id) do
    Enum.any?(dependencies, fn id ->
      case by_id[id] do
        %{purpose: "integration", status: "completed"} -> true
        _ -> false
      end
    end)
  end

  defp required_stage_dependency?(_task, _dependencies, _by_id), do: true

  defp dependency_ready_for?(%{purpose: "integration"}, %{purpose: "review"} = dependency),
    do: dependency.status == "completed" and dependency.review_outcome == "accepted"

  defp dependency_ready_for?(%{purpose: "verification"}, %{purpose: "integration"} = dependency),
    do: dependency.status == "completed"

  defp dependency_ready_for?(_task, dependency), do: dependency.status == "completed"

  defp validate_idempotent_task!(
         nil,
         _prompt,
         _deps,
         _priority,
         _effort,
         _anonymous,
         _workspace,
         _purpose,
         _brief_note_id,
         _brief_revisions
       ),
       do: :ok

  defp validate_idempotent_task!(
         task,
         prompt,
         deps,
         priority,
         effort,
         anonymous,
         workspace,
         purpose,
         brief_note_id,
         brief_revisions
       ) do
    if task.prompt != prompt or task.depends_on_json != deps or task.priority != priority or
         task.reasoning_effort != effort or task.anonymous != 0 != anonymous or
         task.workspace_mode != workspace or task.purpose != purpose or
         task.brief_note_id != brief_note_id or
         decode_json_map(task.brief_revisions_json) != brief_revisions do
      raise "A task with this title already exists with different scheduling options; use a distinct title"
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
        (mission_id,task_id,kind,title,from_status,to_status,summary,run_id,attempt,source_key)
      VALUES (?,?,?,?,?,?,?,?,?,?)
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
        input[:attempt] || 0,
        input[:source_key]
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
        {task_values, [channel_id, created_by, mission_status]} =
          Enum.split(row, @task_field_count)

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
         updated_at,
         phase,
         approved_at,
         approved_by,
         approved_revisions_json,
         creation_fingerprint
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
      updated_at: updated_at,
      phase: if(phase in ~w(planning executing closed), do: phase, else: "planning"),
      approved_at: approved_at,
      approved_by: approved_by,
      approved_revisions_json: approved_revisions_json || "{}",
      creation_fingerprint: creation_fingerprint
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
         updated_at,
         purpose,
         brief_note_id,
         brief_revisions_json,
         review_outcome,
         verification_passed
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
      updated_at: updated_at,
      purpose: if(purpose in @task_purposes, do: purpose, else: "implementation"),
      brief_note_id: brief_note_id,
      brief_revisions_json: brief_revisions_json || "{}",
      review_outcome: review_outcome,
      verification_passed: decode_bool(verification_passed)
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

  defp workspace_id(nil), do: {:ok, Ecto.UUID.generate()}
  defp workspace_id(""), do: {:ok, Ecto.UUID.generate()}

  defp workspace_id(value) do
    case Ecto.UUID.cast(clean(value, 80)) do
      {:ok, id} -> {:ok, id}
      :error -> {:error, "Mission id must be a UUID"}
    end
  end

  defp workspace_note(vault_id, user_id, opts) do
    case workspace_note_with_creation(vault_id, user_id, opts) do
      {:ok, note, _created?} -> {:ok, note}
      other -> other
    end
  end

  defp workspace_note_with_creation(vault_id, user_id, opts) do
    requested_id = clean(opts[:id], 120)

    case requested_id != "" && ContentStore.get_note(requested_id) do
      note when is_map(note) ->
        if note[:vault_id] == vault_id or note["vault_id"] == vault_id,
          do: {:ok, note, false},
          else: {:error, "Mission note belongs to another vault"}

      _ ->
        created = ContentStore.create_note(vault_id, user_id, opts)

        case created do
          note when is_map(note) -> {:ok, note, true}
          _ -> {:error, "Could not create mission note"}
        end
    end
  rescue
    error -> {:error, Exception.message(error)}
  end


  defp workspace_root_message_with_creation(
         user,
         vault_id,
         channel_id,
         message_id,
         body,
         _registration_id
       ) do
    case Messages.get(channel_id, user.id, message_id) do
      {:ok, message} ->
        {:ok, message, false}

      _ ->
        case Messages.create(
               user,
               vault_id,
               channel_id,
               %{
                 id: message_id,
                 body: body,
                 createdAt: DateTime.utc_now() |> DateTime.to_iso8601()
               }
             ) do
          {:ok, message} -> {:ok, message, true}
          other -> other
        end
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp create_workspace_attempt(
         user_id,
         vault_id,
         mission_id,
         fingerprint,
         title,
         identity_id,
         brief,
         opts
       ) do
    channel_id = "mission-channel-#{mission_id}"
    root_id = "mission-root-#{mission_id}"
    brief_id = "mission-brief-#{mission_id}"
    user = user!(user_id)
    track_workspace_resource(:mission_id, mission_id, true)

    with {:ok, channel, channel_created?} <-
           workspace_note_with_creation(
             vault_id,
             user_id,
             %{
               id: channel_id,
               title: title,
               content: "cascade://chat-channel\nmission_id=#{mission_id}",
               is_listed: false
             }
           ),
         :ok <- track_workspace_resource(:channel_id, channel.id, channel_created?),
         {:ok, coordinator, member_created?} <-
           workspace_coordinator(user_id, vault_id, channel.id, identity_id),
         :ok <- track_workspace_resource(:member_id, coordinator.id, member_created?),
         {:ok, root, root_created?} <-
           workspace_root_message_with_creation(
             user,
             vault_id,
             channel.id,
             root_id,
             brief,
             coordinator.id
           ),
         :ok <- track_workspace_resource(:root_id, root.id, root_created?),
         {:ok, brief_note, brief_created?} <-
           workspace_note_with_creation(
             vault_id,
             user_id,
             %{
               id: brief_id,
               title: "#{title} brief",
               content: brief,
               is_listed: false
             }
           ),
         :ok <- track_workspace_resource(:brief_id, brief_note.id, brief_created?),
         {:ok, _persisted} <-
           persist_workspace(
             user_id,
             vault_id,
             mission_id,
             fingerprint,
             channel,
             root,
             coordinator,
             title,
             brief_note,
             opts
           ) do

      case Cascade.Missions.Dispatches.create(
             user_id,
             channel.id,
             root,
             coordinator.id
           ) do
        {:ok, _dispatch} ->
          get_workspace(user_id, vault_id, mission_id)

        {:error, reason} ->
          {:error, reason}
      end
    end
  rescue
      error ->
        cleanup_workspace_resources(
          Process.get({__MODULE__, :workspace_resources}, %{}),
          vault_id
        )

        {:error, Exception.message(error)}
  end

  defp workspace_coordinator(user_id, vault_id, channel_id, identity_id) do
    existing =
      SQL.one(
        "SELECT id FROM chat_agent_members WHERE channel_id=? AND vault_agent_id=?",
        [channel_id, identity_id]
      )

    case Agents.add_to_channel(
           user_id,
           vault_id,
           channel_id,
           identity_id,
           %{"orchestrator" => true, "ambientGroupChat" => true}
         ) do
      {:ok, coordinator} -> {:ok, coordinator, is_nil(existing)}
      other -> other
    end
  end
  defp ensure_workspace_brief(mission_id) do
    case SQL.one(
           """
           SELECT 1
           FROM chat_mission_notes mn
           JOIN chat_missions m ON m.id=mn.mission_id
           JOIN notes n ON n.id=mn.note_id AND n.vault_id=m.vault_id
           WHERE mn.mission_id=? AND mn.kind='mission'
           LIMIT 1
           """,
           [mission_id]
         ) do
      [1] -> :ok
      _ -> {:error, "Mission brief is missing"}
    end
  end

  defp track_workspace_resource(_key, _id, false), do: :ok

  defp track_workspace_resource(key, id, true) when is_binary(id) do
    resource_key = {__MODULE__, :workspace_resources}
    resources = Process.get(resource_key, %{})
    Process.put(resource_key, Map.put(resources, key, id))
    :ok
  end

  defp track_workspace_resource(_key, _id, _created), do: :ok

  defp persist_workspace(
         user_id,
         vault_id,
         mission_id,
         fingerprint,
         channel,
         root,
         coordinator,
         title,
         brief_note,
         _opts
       ) do
    revision = Cascade.Content.Privacy.note_revision(brief_note)

    SQL.exec(
      """
      INSERT INTO chat_missions
        (id,vault_id,channel_id,root_message_id,coordinator_registration_id,
         title,objective,status,phase,created_by,creation_fingerprint)
      VALUES (?,?,?,?,?,?,?,'active','planning',?,?)
      """,
      [
        mission_id,
        vault_id,
        channel.id,
        root.id,
        coordinator.id,
        title,
        brief_note[:content] || brief_note["content"] || "",
        user_id,
        fingerprint
      ]
    )

    SQL.exec(
      """
      INSERT INTO chat_mission_notes
        (mission_id,note_id,kind,parent_note_id,position,revision)
      VALUES (?,?, 'mission',NULL,0,?)
      """,
      [mission_id, brief_note.id, revision]
    )

    record_event(mission_id, %{
      kind: "mission_created",
      title: title,
      to_status: "active",
      summary: brief_note[:content] || brief_note["content"] || ""
    })

    Cascade.Missions.Interpretation.initialize(mission_id)
    {:ok, refresh!(mission_id)}
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp cleanup_workspace_resources(resources, vault_id) when is_map(resources) do
    if mission_id = resources[:mission_id] do
      SQL.exec("DELETE FROM chat_missions WHERE id=? AND vault_id=?", [mission_id, vault_id])
    end

    if member_id = resources[:member_id] do
      SQL.exec("DELETE FROM chat_agent_members WHERE id=?", [member_id])
    end

    if not Map.has_key?(resources, :channel_id) and not is_nil(resources[:root_id]) do
      SQL.exec("DELETE FROM chat_messages WHERE id=?", [resources[:root_id]])
    end

    if channel_id = resources[:channel_id], do: delete_created_note(channel_id, vault_id)
    if brief_id = resources[:brief_id], do: delete_created_note(brief_id, vault_id)
    :ok
  rescue
    _ -> :ok
  end

  defp cleanup_workspace_resources(_resources, _vault_id), do: :ok

  defp delete_created_note(note_id, vault_id) do
    case ContentStore.get_note(note_id) do
      %{vault_id: ^vault_id} -> ContentStore.delete_note(note_id)
      %{"vault_id" => ^vault_id} -> ContentStore.delete_note(note_id)
      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  defp workspace_note_parent(mission_id, "milestone", parent_id) do
    parent = clean(parent_id, 120)

    if parent == "" do
      case SQL.one(
             "SELECT note_id FROM chat_mission_notes WHERE mission_id=? AND kind='mission' LIMIT 1",
             [mission_id]
           ) do
        [brief_id] -> {:ok, brief_id}
        _ -> {:error, "Mission brief is missing"}
      end
    else
      case SQL.one(
             "SELECT note_id FROM chat_mission_notes WHERE mission_id=? AND note_id=? AND kind='mission'",
             [mission_id, parent]
           ) do
        [^parent] -> {:ok, parent}
        _ -> {:error, "Milestones must be linked to the mission brief"}
      end
    end
  end

  defp workspace_note_parent(mission_id, "feature", parent_id) do
    parent = clean(parent_id, 120)

    case SQL.one(
           "SELECT note_id FROM chat_mission_notes WHERE mission_id=? AND note_id=? AND kind='milestone'",
           [mission_id, parent]
         ) do
      [^parent] -> {:ok, parent}
      _ -> {:error, "Features must be linked to a mission milestone"}
    end
  end

  defp next_note_position(mission_id, parent_id) do
    SQL.one(
      "SELECT COALESCE(MAX(position),-1)+1 FROM chat_mission_notes WHERE mission_id=? AND parent_note_id IS ?",
      [mission_id, parent_id]
    )
    |> hd()
  end

  defp workspace_note_projection(mission_id, note_id) do
    SQL.one(
      """
      SELECT n.id,m.kind,m.parent_note_id,n.title,n.revision_counter,n.updated_at
      FROM chat_mission_notes m JOIN notes n ON n.id=m.note_id
      WHERE m.mission_id=? AND m.note_id=?
      """,
      [mission_id, note_id]
    )
    |> case do
      [id, kind, parent, title, revision_counter, updated_at] ->
        %{noteId: id, kind: kind, parentNoteId: parent, title: title, revision: Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter}), updatedAt: updated_at}

      _ ->
        nil
    end
  end

  defp workspace_note_projections(mission_id) do
    SQL.all(
      """
      SELECT n.id,m.kind,m.parent_note_id,n.title,n.revision_counter,n.updated_at
      FROM chat_mission_notes m JOIN notes n ON n.id=m.note_id
      WHERE m.mission_id=? ORDER BY m.position,m.created_at,m.note_id
      """,
      [mission_id]
    )
    |> Enum.map(fn [id, kind, parent, title, revision_counter, updated_at] ->
      %{noteId: id, kind: kind, parentNoteId: parent, title: title, revision: Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter}), updatedAt: updated_at}
    end)
  end

  defp workspace_revisions(mission_id) do
    SQL.all(
      "SELECT m.note_id,n.revision_counter FROM chat_mission_notes m JOIN notes n ON n.id=m.note_id WHERE m.mission_id=? ORDER BY m.note_id",
      [mission_id]
    )
    |> Map.new(fn [id, revision_counter] ->
      {id, Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter})}
    end)
  end

  defp ensure_expected_revisions(current, expected) do
    if current == normalize_revisions(expected),
      do: :ok,
      else: {:error, {:revision_conflict, current}}
  end

  defp normalize_revisions(value) when is_map(value) do
    Map.new(value, fn {key, revision} -> {to_string(key), to_string(revision || "")} end)
  end

  defp normalize_revisions(_), do: %{}


  defp decode_json_map(value) when is_map(value), do: value

  defp decode_json_map(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, map} when is_map(map) -> map
      _ -> %{}
    end
  end

  defp decode_json_map(_), do: %{}

  defp decode_bool(value) when value in [1, true, "1", "true"], do: true
  defp decode_bool(value) when value in [0, false, "0", "false"], do: false
  defp decode_bool(_), do: nil

  defp user!(user_id) do
    case SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      [username] -> %{id: user_id, username: username}
      _ -> raise "Mission owner not found"
    end
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

  defp clean(nil, _max), do: ""
  defp clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)

  defp field(nil, _key), do: nil

  defp field(map, key) do
    Map.get(map, key, Map.get(map, Atom.to_string(key)))
  end
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
