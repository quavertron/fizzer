defmodule Cascade.Missions.DeliveryContractTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Agents
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Store

  setup do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 700_000
    username = "delivery_owner_#{suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [user_id, username, "x", username]
    )

    vault = ContentStore.create_vault(user_id, %{name: "Delivery #{suffix}"})
    other_vault = ContentStore.create_vault(user_id, %{name: "Other delivery #{suffix}"})

    {:ok, coordinator_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Coordinator #{suffix}",
        mention: "delivery-coordinator-#{suffix}",
        model: "gpt-5.6"
      })

    {:ok, other_coordinator_identity} =
      Agents.upsert_identity(user_id, other_vault.id, %{
        agentId: "codex",
        displayName: "Other coordinator #{suffix}",
        mention: "other-delivery-coordinator-#{suffix}",
        model: "gpt-5.6"
      })

    %{
      user_id: user_id,
      user: %{id: user_id, username: username},
      vault: vault,
      other_vault: other_vault,
      coordinator_identity: coordinator_identity,
      other_coordinator_identity: other_coordinator_identity,
      suffix: suffix
    }
  end

  test "a deterministic mission id cannot roll back a workspace in another vault", ctx do
    id = Ecto.UUID.generate()

    {:ok, first} =
      workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id, id, "First workspace")

    assert {:error, _reason} =
             Store.create_workspace(ctx.user_id, ctx.other_vault.id, %{
               id: id,
               title: "Cross-vault collision",
               coordinatorIdentityId: ctx.other_coordinator_identity.id,
               briefContent: "Must not claim the first workspace"
             })

    assert ContentStore.get_note(first.channelId)
    assert Enum.any?(first.mission.notes, &ContentStore.get_note(&1.noteId))
    assert match?({:ok, _}, Store.get_workspace(ctx.user_id, ctx.vault.id, first.mission.id))
  end

  test "omitted brief revisions capture once and retries reuse the captured snapshot", ctx do
    {:ok, created} =
      workspace_fixture(
        ctx,
        ctx.vault.id,
        ctx.coordinator_identity.id,
        Ecto.UUID.generate(),
        "Brief retry"
      )

    {:ok, worker_identity} =
      Agents.upsert_identity(ctx.user_id, ctx.vault.id, %{
        agentId: "codex",
        displayName: "Worker #{ctx.suffix}",
        mention: "delivery-worker-#{ctx.suffix}",
        model: "gpt-5.6"
      })

    {:ok, worker} =
      Agents.add_to_channel(ctx.user_id, ctx.vault.id, created.channelId, worker_identity.id)

    brief = Enum.find(created.mission.notes, &(&1.kind == "mission"))

    input = %{
      coordinatorRegistrationId: created.mission.coordinatorRegistrationId,
      title: "Research the brief",
      assignee: worker.id,
      purpose: "research",
      briefNoteId: brief.noteId
    }

    {:ok, first} = Store.add_task(ctx.user_id, created.channelId, created.mission.id, input)
    captured = first.task.briefRevisions[brief.noteId]

    ContentStore.update_note(brief.noteId, "Changed after delegation", ctx.user_id,
      expected_revision: brief.revision
    )

    {:ok, retry} = Store.add_task(ctx.user_id, created.channelId, created.mission.id, input)
    assert retry.task.id == first.task.id
    assert retry.task.briefRevisions[brief.noteId] == captured

    assert {:error, {:revision_conflict, _}} =
             Store.add_task(
               ctx.user_id,
               created.channelId,
               created.mission.id,
               Map.put(input, :briefRevisions, %{brief.noteId => "note-v1:999"})
             )
  end

  test "approval rejects an empty revision set when the durable brief is missing", ctx do
    {:ok, created} =
      workspace_fixture(
        ctx,
        ctx.vault.id,
        ctx.coordinator_identity.id,
        Ecto.UUID.generate(),
        "Missing brief"
      )

    SQL.exec("DELETE FROM chat_mission_notes WHERE mission_id=?", [created.mission.id])

    assert {:error, "Mission brief is missing"} =
             Store.approve_workspace(ctx.user_id, ctx.vault.id, created.mission.id, %{})
  end

  test "integration and verification tasks need their required stage dependencies", ctx do
    {:ok, created} =
      workspace_fixture(
        ctx,
        ctx.vault.id,
        ctx.coordinator_identity.id,
        Ecto.UUID.generate(),
        "Stage dependencies"
      )

    {:ok, approved} =
      Store.approve_workspace(
        ctx.user_id,
        ctx.vault.id,
        created.mission.id,
        Map.new(created.mission.notes, &{&1.noteId, &1.revision})
      )

    {:ok, worker_identity} =
      Agents.upsert_identity(ctx.user_id, ctx.vault.id, %{
        agentId: "codex",
        displayName: "Stage worker #{ctx.suffix}",
        mention: "stage-worker-#{ctx.suffix}",
        model: "gpt-5.6"
      })

    {:ok, worker} =
      Agents.add_to_channel(ctx.user_id, ctx.vault.id, created.channelId, worker_identity.id)

    {:ok, integration} =
      Store.add_task(ctx.user_id, created.channelId, approved.id, %{
        coordinatorRegistrationId: approved.coordinatorRegistrationId,
        title: "Integration without review",
        assignee: worker.id,
        purpose: "integration"
      })

    {:ok, verification} =
      Store.add_task(ctx.user_id, created.channelId, approved.id, %{
        coordinatorRegistrationId: approved.coordinatorRegistrationId,
        title: "Verification without integration",
        assignee: worker.id,
        purpose: "verification"
      })

    candidates = Store.schedulable(approved.id).candidates
    refute Enum.any?(candidates, &(&1.taskId in [integration.task.id, verification.task.id]))
  end

  test "finish requires a covered chain and accepts only an explicit fix and re-review", ctx do
    {:ok, created} =
      workspace_fixture(
        ctx,
        ctx.vault.id,
        ctx.coordinator_identity.id,
        Ecto.UUID.generate(),
        "Finish coverage"
      )

    {:ok, approved} =
      Store.approve_workspace(
        ctx.user_id,
        ctx.vault.id,
        created.mission.id,
        Map.new(created.mission.notes, &{&1.noteId, &1.revision})
      )

    {:ok, worker_identity} =
      Agents.upsert_identity(ctx.user_id, ctx.vault.id, %{
        agentId: "codex",
        displayName: "Finish worker #{ctx.suffix}",
        mention: "finish-worker-#{ctx.suffix}",
        model: "gpt-5.6"
      })

    {:ok, worker} =
      Agents.add_to_channel(ctx.user_id, ctx.vault.id, created.channelId, worker_identity.id)
    coordinator_id = approved.coordinatorRegistrationId
    mission_id = approved.id

    {:ok, implementation} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Implementation A", "implementation", worker.id)

    {:ok, review} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Review A", "review", coordinator_id,
        depends_on: [implementation.task.id], anonymous: true
      )

    {:ok, integration} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Integration A", "integration", worker.id,
        depends_on: [review.task.id]
      )

    {:ok, verification} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Verification A", "verification", worker.id,
        depends_on: [integration.task.id]
      )

    complete(implementation.task.id)
    complete(review.task.id, review_outcome: "accepted")
    complete(integration.task.id)
    complete(verification.task.id, verification_passed: 1)

    {:ok, implementation_b} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Implementation B", "implementation", worker.id)

    {:ok, rejected} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Review B", "review", coordinator_id,
        depends_on: [implementation_b.task.id], anonymous: true
      )

    complete(implementation_b.task.id)
    complete(rejected.task.id, review_outcome: "changes_requested")

    assert {:error, _} =
             Store.finish(ctx.user_id, created.channelId, mission_id, %{
               coordinatorRegistrationId: coordinator_id,
               status: "completed",
               summary: "Must not bypass the unresolved review"
             })

    {:ok, fix} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Fix B", "fix", worker.id,
        depends_on: [rejected.task.id]
      )

    {:ok, rereview} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Re-review B", "review", coordinator_id,
        depends_on: [fix.task.id], anonymous: true
      )

    {:ok, integration_b} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Integration B", "integration", worker.id,
        depends_on: [rereview.task.id]
      )

    {:ok, verification_b} =
      add_task(ctx, created.channelId, mission_id, coordinator_id, "Verification B", "verification", worker.id,
        depends_on: [integration_b.task.id]
      )

    complete(fix.task.id)
    complete(rereview.task.id, review_outcome: "accepted")
    complete(integration_b.task.id)
    complete(verification_b.task.id, verification_passed: 1)

    # Historical canceled attempts remain evidence; retries remain accountable.
    historical_id = "historical-#{ctx.suffix}"
    SQL.exec("INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status,purpose,attempt) VALUES(?,?,?,?,'canceled','implementation',1)", [historical_id, mission_id, "Historical task", worker.id])
    SQL.exec("INSERT INTO chat_mission_events(mission_id,task_id,kind,source_key,attempt) VALUES(?,?,'historical_task_fenced',?,1)", [mission_id, historical_id, "migration:task:#{historical_id}:fenced"])
    SQL.exec("UPDATE chat_mission_tasks SET attempt=2 WHERE id=?", [historical_id])
    assert {:error, "Mission has unfinished or failed work"} =
      Store.finish(ctx.user_id, created.channelId, mission_id, %{
        coordinatorRegistrationId: coordinator_id,
        status: "completed",
        summary: "A canceled retry cannot be excused as migration history"
      })
    SQL.exec("UPDATE chat_mission_tasks SET attempt=1 WHERE id=?", [historical_id])

    assert {:ok, finished} =
             Store.finish(ctx.user_id, created.channelId, mission_id, %{
               coordinatorRegistrationId: coordinator_id,
               status: "completed",
               summary: "The fix and re-review completed the delivery chain"
             })

    assert finished.mission.status == "completed"
    assert ["canceled", 1] == SQL.one("SELECT status,attempt FROM chat_mission_tasks WHERE id=?", [historical_id])
  end

  test "migration decision blocks workers until the owner approves a fresh brief", ctx do
    {:ok, created} = workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id, Ecto.UUID.generate(), "Migrated plan")
    id = created.mission.id
    state = %{"questions" => [%{"id" => "migration-resumption", "question" => "Resume, revise, or close?", "status" => "open"}], "commitments" => [%{"id" => "old", "status" => "open", "summary" => "Retain responsibility"}]}
    {:ok, added} = Store.add_task(ctx.user_id, created.channelId, id, %{
      coordinatorRegistrationId: created.mission.coordinatorRegistrationId,
      assignee: created.mission.coordinatorRegistrationId,
      purpose: "research",
      title: "Wait for migration decision",
      anonymous: true
    })
    SQL.exec("UPDATE chat_mission_interpretations SET state_json=? WHERE mission_id=?", [Jason.encode!(state), id])
    before_state = SQL.one("SELECT phase,status FROM chat_missions WHERE id=?", [id])
    for purpose <- ~w(research implementation) do
      assert {:error, "Historical mission requires an explicit resumption decision"} =
        Store.add_task(ctx.user_id, created.channelId, id, %{
          coordinatorRegistrationId: created.mission.coordinatorRegistrationId,
          assignee: created.mission.coordinatorRegistrationId,
          purpose: purpose, title: "Fenced #{purpose}", anonymous: true
        })
    end
    assert SQL.one("SELECT phase,status FROM chat_missions WHERE id=?", [id]) == before_state
    assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [id])
    assert [nil] == SQL.one("SELECT dispatch_id FROM chat_mission_tasks WHERE id=?", [added.task.id])
    refute Enum.any?(Store.schedulable(id).candidates, &(&1.taskId == added.task.id))
    assert Cascade.Missions.Interpretation.migration_decision_pending?(id)
    assert {:ok, _} = Store.approve_workspace(ctx.user_id, ctx.vault.id, id, Map.new(created.mission.notes, &{&1.noteId, &1.revision}))
    refute Cascade.Missions.Interpretation.migration_decision_pending?(id)
    [encoded] = SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [id])
    assert Jason.decode!(encoded)["commitments"] == state["commitments"]
  end

  test "approval rejects a brief edit committed while waiting for the write lock", ctx do
    {:ok, created} = workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id,
      Ecto.UUID.generate(), "Concurrent approval")
    expected = Map.new(created.mission.notes, &{&1.noteId, &1.revision})
    brief = Enum.find(created.mission.notes, &(&1.kind == "mission"))

    approval = Cascade.DB.WriteCoordinator.with_lock(fn ->
      approval = Task.async(fn ->
        Store.approve_workspace(ctx.user_id, ctx.vault.id, created.mission.id, expected)
      end)
      wait_for_write_lock(approval.pid)
      SQL.exec("UPDATE notes SET content=?,revision_counter=revision_counter+1 WHERE id=?",
        ["Changed scope before approval commits", brief.noteId])
      approval
    end)

    assert {:error, {:revision_conflict, _}} = Task.await(approval)
    assert ["planning"] = SQL.one("SELECT phase FROM chat_missions WHERE id=?", [created.mission.id])
  end

  test "review independence includes implementation ancestors behind a fix", ctx do
    {:ok, created} = workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id,
      Ecto.UUID.generate(), "Independent ancestry")
    {:ok, approved} = Store.approve_workspace(ctx.user_id, ctx.vault.id, created.mission.id,
      Map.new(created.mission.notes, &{&1.noteId, &1.revision}))
    {:ok, identity} = Agents.upsert_identity(ctx.user_id, ctx.vault.id, %{
      agentId: "codex", displayName: "Ancestry worker", mention: "ancestry-#{ctx.suffix}", model: "gpt-5.6"})
    {:ok, worker} = Agents.add_to_channel(ctx.user_id, ctx.vault.id, created.channelId, identity.id)
    coordinator = approved.coordinatorRegistrationId
    {:ok, implementation} = add_task(ctx, created.channelId, approved.id, coordinator,
      "Original implementation", "implementation", worker.id)
    {:ok, fix} = add_task(ctx, created.channelId, approved.id, coordinator,
      "Follow-up fix", "fix", coordinator, depends_on: [implementation.task.id], anonymous: true)

    assert {:error, "Review assignee must be independent from implementation and fix workers"} =
      add_task(ctx, created.channelId, approved.id, coordinator,
        "Review own implementation through fix", "review", worker.id, depends_on: [fix.task.id])
  end

  test "planning research remains schedulable after approval", ctx do
    {:ok, created} = workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id,
      Ecto.UUID.generate(), "Research crossing approval")
    coordinator = created.mission.coordinatorRegistrationId
    {:ok, research} = add_task(ctx, created.channelId, created.mission.id, coordinator,
      "Already accepted research", "research", coordinator, anonymous: true)

    {:ok, _} = Store.approve_workspace(ctx.user_id, ctx.vault.id, created.mission.id,
      Map.new(created.mission.notes, &{&1.noteId, &1.revision}))

    assert [dispatch] = SQL.one("SELECT dispatch_id FROM chat_mission_tasks WHERE id=?", [research.task.id])
    assert is_binary(dispatch)
    assert {:ok, _} =
      add_task(ctx, created.channelId, created.mission.id, coordinator,
        "New research after approval", "research", coordinator, anonymous: true)
  end

  test "closed missions retain cancellation maintenance until workers acknowledge Stop", ctx do
    {:ok, created} = workspace_fixture(ctx, ctx.vault.id, ctx.coordinator_identity.id,
      Ecto.UUID.generate(), "Disconnected Stop")
    coordinator = created.mission.coordinatorRegistrationId
    {:ok, research} = add_task(ctx, created.channelId, created.mission.id, coordinator,
      "Running research", "research", coordinator, anonymous: true)
    SQL.exec("INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status) VALUES(?,?,?,?,?)",
      [ctx.vault.id, ctx.user_id, "Research", Ecto.UUID.generate(), "running"])
    run = SQL.last_insert_id()
    SQL.exec("UPDATE chat_mission_tasks SET status='running',run_id=? WHERE id=?", [run, research.task.id])
    {:ok, stopped} = Store.finish(ctx.user_id, created.channelId, created.mission.id, %{
      coordinatorRegistrationId: coordinator, status: "canceled", summary: "User Stop"})
    assert stopped.mission.phase == "closed"

    for acknowledged <- [false, true] do
      assert Enum.any?(Cascade.Missions.Scheduler.maintenance_missions(), &(hd(&1) == created.mission.id))
      scheduled = Cascade.Missions.Scheduler.schedule(created.mission.id)
      assert scheduled.dispatches == []
      assert scheduled.wakeDispatches == []
      Cascade.Missions.Scheduler.replay_cancellations(fn owner, id ->
        assert owner == ctx.user_id
        assert id == run
        acknowledged
      end, created.mission.id)
    end

    refute Enum.any?(Cascade.Missions.Scheduler.maintenance_missions(), &(hd(&1) == created.mission.id))
    assert ["canceled"] = SQL.one("SELECT status FROM runs WHERE id=?", [run])
  end

  defp wait_for_write_lock(pid, attempts \\ 200)
  defp wait_for_write_lock(_pid, 0), do: flunk("Approval did not reach the write lock")
  defp wait_for_write_lock(pid, attempts) do
    state = :sys.get_state(Cascade.DB.WriteCoordinator)
    if Enum.any?(state.waiters, fn {_, waiter} -> waiter.pid == pid end) do
      :ok
    else
      Process.sleep(5)
      wait_for_write_lock(pid, attempts - 1)
    end
  end

  defp workspace_fixture(ctx, vault_id, identity_id, id, title) do
    Store.create_workspace(ctx.user_id, vault_id, %{
      id: id,
      title: title,
      coordinatorIdentityId: identity_id,
      briefContent: "#{title} brief"
    })
  end

  defp add_task(ctx, channel_id, mission_id, coordinator_id, title, purpose, assignee, opts \\ []) do
    Store.add_task(ctx.user_id, channel_id, mission_id, %{
      coordinatorRegistrationId: coordinator_id,
      title: title,
      assignee: assignee,
      purpose: purpose,
      dependsOn: Keyword.get(opts, :depends_on, []),
      anonymous: Keyword.get(opts, :anonymous, false)
    })
  end

  defp complete(task_id, opts \\ []) do
    SQL.exec(
      "UPDATE chat_mission_tasks SET status='completed',summary=?,review_outcome=?,verification_passed=? WHERE id=?",
      ["completed", Keyword.get(opts, :review_outcome), Keyword.get(opts, :verification_passed), task_id]
    )
  end
end
