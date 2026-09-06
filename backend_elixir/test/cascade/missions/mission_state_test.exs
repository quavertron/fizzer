defmodule Cascade.Missions.MissionStateTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Missions.Schema, as: MissionSchema
  alias Cascade.Runs.Store, as: RunStore

  setup do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 500_000
    username = "mission_owner_#{suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [user_id, username, "x", username]
    )

    vault = ContentStore.create_vault(user_id, %{name: "Mission #{suffix}"})

    channel =
      ContentStore.create_note(vault.id, user_id, %{
        title: "Mission room",
        content: "cascade://chat-channel"
      })

    {:ok, coordinator_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-#{suffix}",
        model: "gpt-5.6-sol"
      })

    {:ok, coordinator} =
      Agents.add_to_channel(user_id, vault.id, channel.id, coordinator_identity.id, %{
        orchestrator: true
      })

    {:ok, worker_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Terra",
        mention: "terra-#{suffix}",
        model: "gpt-5.6-terra"
      })

    {:ok, worker} =
      Agents.add_to_channel(user_id, vault.id, channel.id, worker_identity.id)

    user = %{id: user_id, username: username}

    {:ok, root} =
      Messages.create(user, vault.id, channel.id, %{
        id: "mission-root-#{suffix}",
        body: "Build and verify the native mission scheduler.",
        createdAt: "2026-08-10T12:00:00.000Z"
      })

    %{
      user: user,
      vault: vault,
      channel: channel,
      root: root,
      coordinator: coordinator,
      worker: worker,
      suffix: suffix
    }
  end

  test "a worker reporting a blocker is reviewed only after its run settles", ctx do
    {:ok, created} = mission(ctx, "Settle before review")
    {:ok, added} = task(ctx, created.mission.id, "Worker")
    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Working", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "blocked",
        summary: "Missing workspace"
      })

    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    :ok = RunStore.finish(run.id, "completed", "Reported missing workspace")
    {:ok, result} = Scheduler.settle_run(run.id, "completed", "Reported missing workspace")
    assert length(result.scheduled.wakeDispatches) == 1
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
  end

  for action <- [:finish, :human_followup] do
    test "#{action} preserves or cancels an admitted review according to owner authority", ctx do
      {:ok, created} = mission(ctx, "Queued review cleanup")
      {:ok, added} = task(ctx, created.mission.id, "Worker")

      {:ok, _} =
        Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
          status: "blocked",
          summary: "Needs review"
        })

      [wake] = Scheduler.schedule(created.mission.id).wakeDispatches
      assert wake.message.body =~ "cancel only the waived optional-check tasks"
      assert wake.message.body =~ "Do not mark unperformed checks completed"
      assert wake.message.body =~ "standalone waived-check mission should be canceled"
      assert wake.message.body =~ "Keep real blockers in attention and honor explicit Stop"
      CascadeWeb.OrchestrationController.prepare_dispatch(wake.dispatch.id)
      reply_id = "agent-dispatch-#{wake.dispatch.id}"

      assert {:ok, %{status: "queued"}} =
               Messages.get(ctx.channel.id, ctx.user.id, reply_id)

      case unquote(action) do
        :finish ->
          assert {:ok, _} =
                   Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
                     coordinatorRegistrationId: ctx.coordinator.id,
                     status: "canceled"
                   })

        :human_followup ->
          {:ok, message} =
            Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
              body: "@#{ctx.coordinator.mention} Continue with my follow-up"
            })

          assert {:ok, [_]} = Dispatches.create_for_message(ctx.user.id, ctx.channel.id, message)
      end

      if unquote(action) == :finish do
        assert is_nil(
                 SQL.one("SELECT id FROM chat_agent_dispatches WHERE id=?", [wake.dispatch.id])
               )

        assert {:error, _} = Messages.get(ctx.channel.id, ctx.user.id, reply_id)
      else
        assert SQL.one("SELECT id FROM chat_agent_dispatches WHERE id=?", [wake.dispatch.id]) == [
                 wake.dispatch.id
               ]

        assert {:ok, %{status: "queued"}} = Messages.get(ctx.channel.id, ctx.user.id, reply_id)
      end
    end
  end

  test "reply retraction preserves an admitted run even before its message is bound", ctx do
    {:ok, dispatch} = Dispatches.create(ctx.user.id, ctx.channel.id, ctx.root, ctx.coordinator.id)
    CascadeWeb.OrchestrationController.prepare_dispatch(dispatch.id)

    {:ok, _run} =
      RunStore.start(ctx.vault.id, nil, "Starting", "codex", chat_dispatch_id: dispatch.id)

    Dispatches.retract_pending_reply(dispatch.id)
    assert {:ok, _} = Messages.get(ctx.channel.id, ctx.user.id, "agent-dispatch-#{dispatch.id}")
  end

  test "an interrupted control-plane startup gets one continuation after the coordinator is idle",
       ctx do
    {:ok, dispatch} = Dispatches.create(ctx.user.id, ctx.channel.id, ctx.root, ctx.coordinator.id)

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Begin mission", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: dispatch.id
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)

    {:ok, created} =
      Store.create(
        ctx.user.id,
        ctx.vault.id,
        ctx.channel.id,
        %{
          rootMessageId: ctx.root.id,
          coordinatorRegistrationId: ctx.coordinator.id,
          title: "Interrupted before delegation"
        },
        agent: true,
        control_plane: true,
        current_run_id: run.id
      )

    assert created.mission.tasks == []
    assert {:ok, nil} = Store.claim_wake(created.mission.id)

    assert [run.id] ==
             SQL.one(
               "SELECT run_id FROM chat_mission_events WHERE mission_id=? AND kind='mission_created'",
               [created.mission.id]
             )

    RunStore.finish(run.id, "canceled", "Steered into the continuation below.")
    RunStore.publish(run.id, "status", %{status: "canceled", steering: true})

    {:ok, followup} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        body: "A follow-up while preserving the original task"
      })

    {:ok, next} = Dispatches.create(ctx.user.id, ctx.channel.id, followup, ctx.coordinator.id)

    {:ok, continued} =
      RunStore.start(ctx.vault.id, nil, "Follow-up", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: next.id
      )

    :ok = Dispatches.attach_run(next.id, continued.id)
    assert {:ok, nil} = Store.claim_wake(created.mission.id)
    RunStore.finish(continued.id, "completed", "Answered follow-up")
    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches
    assert wake.message.body =~ "no tasks were delegated"
    assert wake.message.body =~ "Continue this existing mission"
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    {:ok, recovery} =
      RunStore.start(ctx.vault.id, nil, "Recover", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: wake.dispatch.id
      )

    :ok = Dispatches.attach_run(wake.dispatch.id, recovery.id)
    RunStore.finish(recovery.id, "failed", "Cannot continue")
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    assert {:ok, %{mission: %{status: "attention"}}} =
             Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
  end

  test "explicit Stop leaves an empty mission needing attention without restarting it", ctx do
    {:ok, dispatch} = Dispatches.create(ctx.user.id, ctx.channel.id, ctx.root, ctx.coordinator.id)

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Begin mission", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: dispatch.id
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)

    {:ok, created} =
      Store.create(
        ctx.user.id,
        ctx.vault.id,
        ctx.channel.id,
        %{
          rootMessageId: ctx.root.id,
          coordinatorRegistrationId: ctx.coordinator.id,
          title: "Stopped before delegation"
        },
        agent: true,
        control_plane: true,
        current_run_id: run.id
      )

    assert RunStore.cancel(run.id)
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    assert {:ok, %{mission: %{status: "attention"}}} =
             Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
  end

  test "legacy empty missions become attention without inventing permission to replay old work",
       ctx do
    {:ok, created} = mission(ctx, "Legacy stranded mission")

    SQL.exec("UPDATE chat_missions SET created_at=datetime('now','-5 minutes') WHERE id=?", [
      created.mission.id
    ])

    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    assert {:ok, %{mission: %{status: "attention"}}} =
             Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
  end

  test "dependency DAG, priority, occupancy, retries, history, and review wake are durable",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Native scheduler"
      })

    {:ok, first} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Implement",
        assignee: ctx.worker.id,
        prompt: "Implement the native state machine.",
        priority: 20,
        reasoningEffort: "high",
        workspaceMode: "isolated"
      })

    {:ok, second} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Verify",
        assignee: ctx.worker.id,
        prompt: "Verify the native state machine.",
        dependsOn: [first.task.id],
        reasoningEffort: "low"
      })

    assert first.task.workItemId
    assert first.task.workspaceMode == "isolated"
    assert String.starts_with?(first.task.branch, "cascade/")
    assert second.task.waitingFor == [first.task.id]

    assert [candidate] = Store.schedulable(created.mission.id).candidates
    assert candidate.taskId == first.task.id
    assert candidate.reasoningEffort == "high"

    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch, message: message}] = scheduled.dispatches
    assert message.missionTaskId == first.task.id
    assert dispatch.reasoningEffort == "high"
    assert Store.schedulable(created.mission.id).candidates == []

    :ok = Dispatches.attach_run(dispatch.id, 900_000 + ctx.suffix)
    {:ok, running} = Store.attach_run(dispatch.id, 900_000 + ctx.suffix)
    assert hd(running.mission.tasks).status == "running"

    {:ok, settled} =
      Store.settle_run(900_000 + ctx.suffix, "failed", "Transient worker failure.")

    assert settled.update.mission.status == "attention"
    assert Enum.at(settled.update.mission.tasks, 1).status == "pending"
    assert Enum.at(settled.update.mission.tasks, 1).queueReason == "dependency-attention"
    assert settled.wake.coordinatorRegistrationId == ctx.coordinator.id
    assert {:ok, ready} = Store.claim_wake(created.mission.id)
    assert {:ok, _wake} = Scheduler.enqueue_wake(ready)
    assert {:ok, nil} == Store.claim_wake(created.mission.id)

    {:ok, retried} =
      Store.update_task(ctx.user.id, ctx.channel.id, first.task.id, %{
        status: "pending",
        summary: "Original deadline superseded: retry before 23:37 UTC; scratch work only."
      })

    retried_first = Enum.find(retried.mission.tasks, &(&1.id == first.task.id))
    assert retried.mission.status == "active"
    assert retried_first.attempt == 1
    assert [retry] = Store.schedulable(created.mission.id).candidates
    assert retry.taskId == first.task.id
    assert retry.attempt == 1
    assert [%{message: retry_message}] = Scheduler.schedule(created.mission.id).dispatches

    assert retry_message.body =~
             "Original deadline superseded: retry before 23:37 UTC; scratch work only."

    assert retry_message.body =~ candidate.prompt
    refute message.body =~ "Coordinator retry instructions"

    {:ok, events} = Store.events(ctx.user.id, ctx.channel.id, created.mission.id)
    assert Enum.any?(events, &(&1.kind == "task_retried" and &1.taskId == first.task.id))
  end

  for path <- [:schedule, :settle_run] do
    @wake_path path
    test "#{path} rolls back the wake marker and messages when dispatch insertion fails", ctx do
      {:ok, created} = mission(ctx, "Atomic review wake")
      {:ok, added} = task(ctx, created.mission.id, "Fail then retry")
      [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches
      run_id = 9_000_000 + ctx.suffix
      :ok = Dispatches.attach_run(dispatch.id, run_id)
      {:ok, _} = Store.attach_run(dispatch.id, run_id)

      if @wake_path == :schedule,
        do: Store.settle_run(run_id, "failed", "Needs review")

      parent = self()

      events = fn event ->
        refute Cascade.DB.Repo.in_transaction?()

        assert [1] ==
                 SQL.one("SELECT wake_sent FROM chat_missions WHERE id=?", [created.mission.id])

        send(parent, {:wake_event, event})
      end

      trigger = "fail_review_wake_#{ctx.suffix}"

      SQL.exec("""
      CREATE TRIGGER #{trigger} BEFORE INSERT ON chat_agent_dispatches
      WHEN NEW.message_id LIKE 'sys-mission-#{created.mission.id}-%'
      BEGIN SELECT RAISE(ABORT, 'injected review dispatch failure'); END
      """)

      on_exit(fn -> SQL.exec("DROP TRIGGER IF EXISTS #{trigger}") end)

      assert_raise RuntimeError, ~r/injected review dispatch failure/, fn ->
        if @wake_path == :schedule,
          do: Scheduler.schedule(nil, events: events),
          else: Scheduler.settle_run(run_id, "failed", "Needs review", events: events)
      end

      assert [0] ==
               SQL.one("SELECT wake_sent FROM chat_missions WHERE id=?", [created.mission.id])

      assert wake_rows(created.mission.id) == []
      refute_receive {:wake_event, _}
      assert {:ok, ready} = Store.claim_wake(created.mission.id)

      SQL.exec("DROP TRIGGER #{trigger}")
      scheduled = Scheduler.schedule(nil, events: events)

      assert [wake] =
               Enum.filter(scheduled.wakeDispatches, &(&1.message.channelId == ctx.channel.id))

      assert wake.message.id == "sys-mission-#{created.mission.id}-#{ready.generation}"
      assert length(wake_rows(created.mission.id)) == 2

      carrier_id = wake.carrier.id
      message_id = wake.message.id

      assert_receive {:wake_event,
                      %{event: "vault:chatMessageCreated", message: %{id: ^carrier_id}}}

      assert_receive {:wake_event,
                      %{
                        event: "vault:chatMessageCreated",
                        message: %{id: ^message_id},
                        dispatches: [_]
                      }}

      assert {:ok, nil} = Scheduler.enqueue_wake(ready)
      assert Scheduler.schedule(created.mission.id).wakeDispatches == []
      assert {:ok, replay} = Scheduler.settle_run(run_id, "failed", "Needs review")
      assert replay.wakeDispatch == nil
      assert length(wake_rows(created.mission.id)) == 2

      {:ok, _} =
        Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{status: "pending"})

      {:ok, _} =
        Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{status: "failed"})

      assert {:ok, retried} = Store.claim_wake(created.mission.id)
      refute retried.generation == ready.generation
      assert {:ok, nil} = Scheduler.enqueue_wake(ready)

      assert [0] ==
               SQL.one("SELECT wake_sent FROM chat_missions WHERE id=?", [created.mission.id])

      assert {:ok, next_wake} = Scheduler.enqueue_wake(retried)
      refute next_wake.message.id == wake.message.id
      refute next_wake.dispatch.id == wake.dispatch.id
      assert {:ok, nil} = Scheduler.enqueue_wake(retried)
      assert length(wake_rows(created.mission.id)) == 4
    end
  end

  test "a publication failure cannot lose or duplicate a committed review dispatch", ctx do
    {:ok, created} = mission(ctx, "Committed review")
    {:ok, added} = task(ctx, created.mission.id, "Needs attention")
    {:ok, _} = Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{status: "failed"})

    assert_raise RuntimeError, "publication interrupted", fn ->
      Scheduler.schedule(created.mission.id,
        events: fn _ -> raise "publication interrupted" end
      )
    end

    assert [1] == SQL.one("SELECT wake_sent FROM chat_missions WHERE id=?", [created.mission.id])
    rows = wake_rows(created.mission.id)
    assert length(rows) == 2
    assert Enum.count(rows, fn [_, dispatch_id] -> not is_nil(dispatch_id) end) == 1
    assert {:ok, [dispatch]} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)
    assert dispatch.message.id =~ "sys-mission-#{created.mission.id}-"
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    assert wake_rows(created.mission.id) == rows
  end

  defp wake_rows(mission_id) do
    SQL.all(
      "SELECT m.id,d.id FROM chat_messages m LEFT JOIN chat_agent_dispatches d ON d.message_id=m.id WHERE m.id LIKE ? OR m.id LIKE ?",
      ["sys-mission-#{mission_id}-%", "agent-trace-#{mission_id}-%"]
    )
  end

  test "mission and task retries are idempotent while conflicting task options fail closed",
       ctx do
    input = %{
      rootMessageId: ctx.root.id,
      coordinatorRegistrationId: ctx.coordinator.id,
      title: "Durable work"
    }

    assert {:ok, first_mission} = Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, input)

    assert {:ok, retried_mission} =
             Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{input | title: "Changed"})

    assert retried_mission.mission.id == first_mission.mission.id
    assert retried_mission.mission.title == "Durable work"

    task_input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      title: "One assignment",
      assignee: ctx.worker.id,
      prompt: "Do it"
    }

    assert {:ok, first_task} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, task_input)

    assert {:ok, retried_task} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, task_input)

    assert retried_task.task.id == first_task.task.id
    assert length(retried_task.update.mission.tasks) == 1

    assert {:error, error} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, %{
               task_input
               | prompt: "Different"
             })

    assert error =~ "different scheduling options"
  end

  test "refresh preserves semantically identical historical mission JSON bytes but writes real changes",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Stable projection"
      })

    [encoded] =
      SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])

    historical = " \n" <> encoded <> "\n"
    SQL.exec("UPDATE chat_messages SET mission_json=? WHERE id=?", [historical, ctx.root.id])

    assert {:ok, _update} = Store.refresh(created.mission.id)

    assert [^historical] =
             SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])

    assert {:ok, _added} =
             Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Material projection change",
               assignee: ctx.worker.id
             })

    [changed] = SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])
    refute changed == historical
    assert {:ok, projection} = Jason.decode(changed)
    assert Enum.any?(projection["tasks"], &(&1["title"] == "Material projection change"))
  end

  test "legacy worker evidence repair chooses the first task row for a shared run", ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Deterministic repair"
      })

    run_id = 8_000_000 + ctx.suffix
    first_id = "repair-first-#{ctx.suffix}"
    second_id = "repair-second-#{ctx.suffix}"

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,run_id) VALUES(?,?,?,?,?)",
      [first_id, created.mission.id, "First", ctx.worker.id, run_id]
    )

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,run_id) VALUES(?,?,?,?,?)",
      [second_id, created.mission.id, "Second", ctx.worker.id, run_id]
    )

    SQL.exec("UPDATE chat_messages SET run_id=?,mission_task_id=NULL WHERE id=?", [
      run_id,
      ctx.root.id
    ])

    MissionSchema.ensure!()

    assert [^first_id] =
             SQL.one("SELECT mission_task_id FROM chat_messages WHERE id=?", [ctx.root.id])
  end

  test "a successful shared worker wakes its coordinator exactly once", ctx do
    {:ok, created} = mission(ctx, "Thin delegation")

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Run directly",
        assignee: ctx.worker.id
      })

    assert added.task.workspaceMode == "shared"
    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch}] = scheduled.dispatches

    assert {:ok, run} =
             RunStore.start(ctx.vault.id, nil, "thin worker", "codex",
               conversation_id: "thin-worker-session",
               chat_dispatch_id: dispatch.id
             )

    assert :ok = Dispatches.attach_run(dispatch.id, run.id)
    assert {:ok, _running} = Store.attach_run(dispatch.id, run.id)
    assert :ok = RunStore.finish(run.id, "completed", "Finished directly.")

    assert {:ok, result} = Scheduler.settle_run(run.id, "completed", "Finished directly.")
    assert result.settled.update.mission.status == "reviewing"
    assert result.wakeDispatch.dispatch.registration.id == ctx.coordinator.id
    assert length(result.scheduled.wakeDispatches) == 1
    rows = wake_rows(created.mission.id)

    assert {:ok, replay} = Scheduler.settle_run(run.id, "completed", "Finished directly.")
    assert replay.settled.update.mission.status == "reviewing"
    assert replay.wakeDispatch == nil
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    review_dispatch = result.wakeDispatch.dispatch

    {:ok, review_run} =
      RunStore.start(ctx.vault.id, nil, "Coordinator follow-through", "codex",
        chat_dispatch_id: review_dispatch.id
      )

    assert :ok = Dispatches.attach_run(review_dispatch.id, review_run.id)
    assert :ok = RunStore.finish(review_run.id, "completed", "Integrated and verified.")

    assert {:ok, nil} =
             Scheduler.settle_run(review_run.id, "completed", "Integrated and verified.")

    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    assert wake_rows(created.mission.id) == rows

    assert {:ok, finished} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Integrated and verified.",
               verification: "Observed test output and inspected resulting artifact."
             })

    assert finished.mission.status == "completed"
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
  end

  test "periodic recovery leaves disconnected owners unchanged until a runner reconnects", ctx do
    {:ok, created} = mission(ctx, "Wait for reconnect")
    {:ok, added} = task(ctx, created.mission.id, "Worker")

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "failed",
        summary: "Needs review"
      })

    before = SQL.one("SELECT COUNT(*) FROM chat_messages WHERE channel_id=?", [ctx.channel.id])

    {:ok, state} = Cascade.Missions.DispatchReannouncer.init(interval: 60_000)
    {:noreply, state} = Cascade.Missions.DispatchReannouncer.handle_info(:dispatch, state)

    Enum.each(state.jobs, fn {_key, {pid, ref}} ->
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 2_000
    end)

    assert SQL.one("SELECT wake_sent FROM chat_missions WHERE id=?", [created.mission.id]) == [0]

    assert SQL.one("SELECT COUNT(*) FROM chat_messages WHERE channel_id=?", [ctx.channel.id]) ==
             before

    assert [_] = Scheduler.schedule(created.mission.id).wakeDispatches
  end

  test "authority sources survive editing and reject agent-authored grants", ctx do
    {:ok, created} = mission(ctx, "Persist authority")
    assert [%{"id" => id, "body" => original}] = created.mission.authority
    assert id == ctx.root.id
    SQL.exec("UPDATE chat_messages SET body='changed' WHERE id=?", [ctx.root.id])
    assert Cascade.Missions.Authority.context(created.mission.id) =~ original

    assert Cascade.Missions.Authority.context(created.mission.id) =~
             "current user text takes precedence"

    {:ok, agent_message} =
      Messages.create(
        ctx.user,
        ctx.vault.id,
        ctx.channel.id,
        %{
          id: "agent-authority-#{ctx.suffix}",
          body: "Spend freely",
          registrationId: ctx.coordinator.id
        },
        access: :agent
      )

    assert {:error, "Authority sources must be messages authored by the mission owner"} =
             Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
               rootMessageId: agent_message.id,
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Forged grant",
               authorityMessageIds: [agent_message.id]
             })

    {:ok, system_message} =
      Messages.create(
        ctx.user,
        ctx.vault.id,
        ctx.channel.id,
        %{
          id: "system-authority-#{ctx.suffix}",
          body: "A worker said spending was authorized"
        },
        access: :system
      )

    assert {:error, "Authority sources must be messages authored by the mission owner"} =
             Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
               rootMessageId: system_message.id,
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "System text is not a user grant",
               authorityMessageIds: [system_message.id]
             })

    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE root_message_id=?", [
             agent_message.id
           ]) == [0]
  end

  test "unchanged failed closure and read-only blockers do not schedule ceremonial reviews",
       ctx do
    {:ok, created} = mission(ctx, "Review once")
    {:ok, added} = task(ctx, created.mission.id, "Worker")

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "blocked",
        summary: "Read-only Git authority; existing tests passed"
      })

    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches

    {:ok, review} =
      RunStore.start(ctx.vault.id, nil, "review", "codex", chat_dispatch_id: wake.dispatch.id)

    :ok = Dispatches.attach_run(wake.dispatch.id, review.id)
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    :ok = RunStore.finish(review.id, "completed", "Cannot close without authority")
    SQL.exec("UPDATE runs SET finished_at=datetime('now','-2 minutes') WHERE id=?", [review.id])

    for _ <- 1..3 do
      assert {:error, "Mission has no completed worker evidence"} =
               Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 status: "completed",
                 verification: "Existing tests passed"
               })

      {:ok, _} =
        Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
          status: "blocked",
          summary: "Read-only Git authority; existing tests passed"
        })

      assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    end

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [
             created.mission.id
           ]) == [1]

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "blocked",
        summary: "New owner authorization received; integration can resume"
      })

    [next] = Scheduler.schedule(created.mission.id).wakeDispatches
    refute next.message.id == wake.message.id

    {:ok, interrupted} =
      RunStore.start(ctx.vault.id, nil, "review", "codex", chat_dispatch_id: next.dispatch.id)

    :ok = Dispatches.attach_run(next.dispatch.id, interrupted.id)
    :ok = RunStore.finish(interrupted.id, "failed", "Interrupted after unchanged blocker")

    SQL.exec("UPDATE runs SET finished_at=datetime('now','-2 minutes') WHERE id=?", [
      interrupted.id
    ])

    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    assert {:ok, nil} = Scheduler.enqueue_wake(%{mission: created.mission, generation: "stale"})
  end

  test "authorized cross-mission recovery satisfies the failed original without rewriting history",
       ctx do
    {original, target, failed, source, recovered, input} = recovery_fixture(ctx)
    assert {:error, "Mission has no completed worker evidence"} = finish_recovered(ctx, original)
    assert {:ok, linked} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)
    assert linked.mission.status == "reviewing"
    assert hd(linked.mission.tasks).status == "failed"
    assert hd(linked.mission.tasks).recoveryEvidence.valid
    assert {:ok, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='recovery_evidence_linked'",
             [original.id]
           ) == [1]

    assert {:ok, closed} = finish_recovered(ctx, original)
    assert closed.mission.status == "completed"
    assert SQL.one("SELECT status FROM runs WHERE id=?", [failed.id]) == ["failed"]

    assert SQL.one("SELECT run_id,status FROM chat_mission_tasks WHERE id=?", [target.id]) == [
             failed.id,
             "failed"
           ]

    assert SQL.one("SELECT run_id FROM chat_mission_tasks WHERE id=?", [source.id]) == [
             recovered.id
           ]
  end

  test "recovery rejects stale, foreign, insufficient and worker-authorized evidence", ctx do
    {original, target, _failed, source, recovered, input} = recovery_fixture(ctx)

    for invalid <- [
          Map.put(input, :objective, "another objective"),
          Map.put(input, :verification, ""),
          Map.put(input, :targetAttempt, 99),
          Map.put(input, :sourceRunId, recovered.id - 1)
        ] do
      assert {:error, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, invalid)
    end

    assert {:error, _} =
             Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input,
               current_run_id: recovered.id
             )

    SQL.exec("UPDATE chat_mission_tasks SET summary='' WHERE id=?", [source.id])
    assert {:error, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)

    SQL.exec("UPDATE chat_mission_tasks SET summary='Verified deployment' WHERE id=?", [source.id])

    SQL.exec(
      "UPDATE chat_missions SET coordinator_registration_id=? WHERE id=(SELECT mission_id FROM chat_mission_tasks WHERE id=?)",
      [ctx.worker.id, source.id]
    )

    assert {:error, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)

    SQL.exec(
      "UPDATE chat_missions SET coordinator_registration_id=? WHERE id=(SELECT mission_id FROM chat_mission_tasks WHERE id=?)",
      [ctx.coordinator.id, source.id]
    )

    SQL.exec("UPDATE runs SET chat_dispatch_id=NULL WHERE id=?", [recovered.id])
    assert {:error, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)
    assert {:error, _} = finish_recovered(ctx, original)
  end

  test "linked evidence becomes invalid when its evidence or original attempt changes", ctx do
    {original, target, _failed, source, _recovered, input} = recovery_fixture(ctx)
    assert {:ok, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)
    SQL.exec("UPDATE chat_mission_tasks SET summary='Different artifact' WHERE id=?", [source.id])
    assert {:error, _} = finish_recovered(ctx, original)
    assert {:ok, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)
    SQL.exec("UPDATE chat_mission_tasks SET attempt=attempt+1 WHERE id=?", [target.id])
    assert {:error, _} = finish_recovered(ctx, original)
    assert {:error, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, target.id, input)
  end

  test "recovery repairs missed run settlement and a removed review outbox entry", ctx do
    {:ok, created} = mission(ctx, "Repair crash gap")
    {:ok, added} = task(ctx, created.mission.id, "Worker")

    assert {:error, error} =
             Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Worker",
               assignee: ctx.worker.id,
               workspaceMode: "isolated"
             })

    assert error =~ "different scheduling options"
    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "worker", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    :ok = RunStore.finish(run.id, "completed", "Durable run result")
    # Neither task attachment nor its completion callback was delivered.
    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches
    {:ok, update} = Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
    assert hd(update.mission.tasks).id == added.task.id
    assert hd(update.mission.tasks).status == "completed"
    assert hd(update.mission.tasks).summary == "Durable run result"
    SQL.exec("DELETE FROM chat_agent_dispatches WHERE id=?", [wake.dispatch.id])

    SQL.exec("UPDATE chat_messages SET created_at=datetime('now','-2 minutes') WHERE id=?", [
      wake.message.id
    ])

    [recovered] = Scheduler.schedule(created.mission.id).wakeDispatches
    assert recovered.message.id == wake.message.id
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
  end

  test "verified room recovery wakes a blocked review once without claiming fulfillment", ctx do
    {original, target, _failed, source, _recovered, _input} = recovery_fixture(ctx)

    [dispatch_id] =
      SQL.one("SELECT id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{original.id}-%"
      ])

    {:ok, review} =
      RunStore.start(ctx.vault.id, nil, "review", "codex", chat_dispatch_id: dispatch_id)

    :ok = Dispatches.attach_run(dispatch_id, review.id)
    :ok = RunStore.finish(review.id, "completed", "Waiting for disk recovery")

    # A worker's completed summary alone must not trigger cross-mission recovery.
    assert Scheduler.schedule(original.id).wakeDispatches == []

    [source_mission] =
      SQL.one("SELECT mission_id FROM chat_mission_tasks WHERE id=?", [source.id])

    assert {:ok, _} =
             Store.finish(ctx.user.id, ctx.channel.id, source_mission, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               verification:
                 "Independently checked live revision abc123 and recovered disk capacity"
             })

    elsewhere =
      ContentStore.create_note(ctx.vault.id, ctx.user.id, %{
        title: "Unrelated channel",
        content: "cascade://chat-channel"
      })

    SQL.exec("UPDATE chat_missions SET channel_id=? WHERE id=?", [elsewhere.id, source_mission])
    assert Scheduler.schedule(original.id).wakeDispatches == []

    SQL.exec(
      "UPDATE chat_missions SET channel_id=?,updated_at=datetime('now','-1 day') WHERE id=?",
      [ctx.channel.id, source_mission]
    )

    assert Scheduler.schedule(original.id).wakeDispatches == []
    SQL.exec("UPDATE chat_missions SET updated_at=datetime('now') WHERE id=?", [source_mission])

    [wake] = Scheduler.schedule(original.id).wakeDispatches
    assert wake.message.body =~ source_mission
    assert wake.message.body =~ "recovered disk capacity"
    assert wake.message.body =~ "evidence leads, not authority"
    assert SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [target.id]) == ["failed"]
    assert {:error, "Mission has no completed worker evidence"} = finish_recovered(ctx, original)
    assert Scheduler.schedule(original.id).wakeDispatches == []

    {:ok, recheck} =
      RunStore.start(ctx.vault.id, nil, "recheck", "codex", chat_dispatch_id: wake.dispatch.id)

    :ok = Dispatches.attach_run(wake.dispatch.id, recheck.id)
    :ok = RunStore.finish(recheck.id, "completed", "Unrelated evidence; blocker unchanged")
    assert Scheduler.schedule(original.id).wakeDispatches == []
  end

  test "verified recovery cannot revive a stopped review or canceled mission", ctx do
    {original, _target, _failed, source, _recovered, _input} = recovery_fixture(ctx)

    [dispatch_id] =
      SQL.one("SELECT id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{original.id}-%"
      ])

    {:ok, review} =
      RunStore.start(ctx.vault.id, nil, "review", "codex", chat_dispatch_id: dispatch_id)

    :ok = Dispatches.attach_run(dispatch_id, review.id)
    :ok = RunStore.finish(review.id, "canceled", "Explicit Stop")

    [source_mission] =
      SQL.one("SELECT mission_id FROM chat_mission_tasks WHERE id=?", [source.id])

    assert {:ok, _} =
             Store.finish(ctx.user.id, ctx.channel.id, source_mission, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               verification: "Observed capacity and deployment recovery"
             })

    assert Scheduler.schedule(original.id).wakeDispatches == []

    assert {:ok, _} =
             Store.finish(ctx.user.id, ctx.channel.id, original.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "canceled"
             })

    assert Scheduler.schedule(original.id).wakeDispatches == []
  end

  test "owner status and greeting preserve the queued review obligation", ctx do
    {:ok, created} = mission(ctx, "Keep authorized follow-through")
    {:ok, added} = task(ctx, created.mission.id, "Worker")

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "blocked",
        summary: "Await capacity"
      })

    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches

    for body <- [
          "@#{ctx.coordinator.mention} is it running?",
          "@#{ctx.coordinator.mention} hello"
        ] do
      {:ok, message} = Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{body: body})
      assert {:ok, [_]} = Dispatches.create_for_message(ctx.user.id, ctx.channel.id, message)

      assert SQL.one("SELECT id FROM chat_agent_dispatches WHERE id=?", [wake.dispatch.id]) == [
               wake.dispatch.id
             ]

      assert Scheduler.schedule(created.mission.id).wakeDispatches == []
    end
  end

  test "recovery respects canceled reviews and closed missions", ctx do
    {:ok, created} = mission(ctx, "Do not revive cancellation")
    {:ok, added} = task(ctx, created.mission.id, "Failed worker")

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "failed",
        summary: "Needs review"
      })

    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches

    {:ok, review} =
      RunStore.start(ctx.vault.id, nil, "review", "codex", chat_dispatch_id: wake.dispatch.id)

    :ok = Dispatches.attach_run(wake.dispatch.id, review.id)
    :ok = RunStore.finish(review.id, "canceled", "User stopped")
    SQL.exec("UPDATE runs SET finished_at=datetime('now','-2 minutes') WHERE id=?", [review.id])
    assert Scheduler.schedule(created.mission.id).wakeDispatches == []

    {:ok, _} =
      Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        status: "canceled"
      })

    assert Scheduler.schedule(created.mission.id).wakeDispatches == []
  end

  test "a terminal isolated runner event settles its mission task and materializes the review wake",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Runner settlement"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Finish from runner",
        assignee: ctx.worker.id,
        workspaceMode: "isolated"
      })

    assert {:ok, _bound} =
             Cascade.WorkItems.bind_workspace(ctx.user.id, added.task.workItemId, %{
               repository: "/repo/#{ctx.suffix}",
               baseCommit: String.duplicate("a", 40),
               branch: added.task.branch,
               worktreePath: "/work/#{ctx.suffix}"
             })

    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch}] = scheduled.dispatches

    assert {:ok, run} =
             RunStore.start(ctx.vault.id, nil, "mission worker", "codex",
               conversation_id: "mission-worker-session",
               chat_dispatch_id: dispatch.id
             )

    assert :ok = Dispatches.attach_run(dispatch.id, run.id)
    assert {:ok, _running} = Store.attach_run(dispatch.id, run.id)
    assert :ok = RunStore.record_delegated(run.id, ctx.user.id)
    assert is_nil(RunStore.find_open_for_chat_registration(ctx.worker.id))

    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [
                 %{
                   runId: run.id,
                   type: "status",
                   payload: %{status: "completed", summary: "Worker evidence is complete."}
                 }
               ],
               %{id: ctx.user.id},
               %{}
             )

    assert {:ok, update} = Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
    assert [settled_task] = update.mission.tasks
    assert settled_task.status == "completed"
    assert settled_task.summary == "Worker evidence is complete."
    assert update.mission.status == "reviewing"
    assert RunStore.get(run.id).status == "completed"

    assert {:ok, pending} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert Enum.any?(
             pending,
             &String.starts_with?(&1.messageId, "sys-mission-#{created.mission.id}-")
           )
  end

  test "a bound mission worker cannot start, delegate, or finish missions", ctx do
    {:ok, created} = mission(ctx, "Control plane")

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Do the work",
        assignee: ctx.coordinator.id,
        anonymous: true
      })

    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch}] = scheduled.dispatches

    assert {:ok, worker_run} =
             RunStore.start(ctx.vault.id, nil, "anonymous worker", "codex",
               conversation_id: "worker-#{added.task.id}",
               chat_dispatch_id: dispatch.id
             )

    assert :ok = Dispatches.attach_run(dispatch.id, worker_run.id)
    assert {:ok, _} = Store.attach_run(dispatch.id, worker_run.id)

    {:ok, nested_root} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        id: "nested-root-#{ctx.suffix}",
        body: "Worker trying to clone the control plane."
      })

    assert {:error, "Mission workers cannot start or delegate missions"} =
             Store.create(
               ctx.user.id,
               ctx.vault.id,
               ctx.channel.id,
               %{
                 rootMessageId: nested_root.id,
                 coordinatorRegistrationId: ctx.coordinator.id,
                 title: "Nested clone"
               },
               current_run_id: worker_run.id,
               agent: true,
               control_plane: true
             )

    assert {:error, "Mission workers cannot start or delegate missions"} =
             Store.add_task(
               ctx.user.id,
               ctx.channel.id,
               created.mission.id,
               %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 title: "Another clone",
                 assignee: ctx.coordinator.id,
                 anonymous: true
               },
               current_run_id: worker_run.id
             )

    assert {:error, "Mission workers cannot finish the mission"} =
             Store.finish(
               ctx.user.id,
               ctx.channel.id,
               created.mission.id,
               %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 status: "completed",
                 summary: "Worker closed the parent"
               },
               current_run_id: worker_run.id
             )

    assert {:ok, still_open} = Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
    assert still_open.mission.status == "active"
    assert length(still_open.mission.tasks) == 1
  end

  test "two anonymous missions run concurrently and wake only from bound worker evidence", ctx do
    {:ok, second_root} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        id: "parallel-root-#{ctx.suffix}",
        body: "Run independently.",
        createdAt: "2026-08-10T12:01:00.000Z"
      })

    {:ok, first_mission} = mission(ctx, "Parallel A")

    {:ok, second_mission} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: second_root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Parallel B"
      })

    task_input = fn title ->
      %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: title,
        assignee: ctx.coordinator.id,
        anonymous: true,
        workspaceMode: "isolated"
      }
    end

    {:ok, first} =
      Store.add_task(
        ctx.user.id,
        ctx.channel.id,
        first_mission.mission.id,
        task_input.("Worker A")
      )

    {:ok, second} =
      Store.add_task(
        ctx.user.id,
        ctx.channel.id,
        second_mission.mission.id,
        task_input.("Worker B")
      )

    scheduled = Scheduler.schedule()
    dispatch_by_task = Map.new(scheduled.dispatches, &{&1.message.missionTaskId, &1.dispatch})
    assert Map.has_key?(dispatch_by_task, first.task.id)
    assert Map.has_key?(dispatch_by_task, second.task.id)

    runs =
      for task <- [first.task, second.task] do
        assert {:ok, _bound} =
                 Cascade.WorkItems.bind_workspace(ctx.user.id, task.workItemId, %{
                   repository: "/repo/#{ctx.suffix}",
                   baseCommit: String.duplicate("b", 40),
                   branch: task.branch,
                   worktreePath: "/work/#{task.id}"
                 })

        dispatch = Map.fetch!(dispatch_by_task, task.id)

        assert {:ok, run} =
                 RunStore.start(ctx.vault.id, nil, task.title, "codex",
                   conversation_id: "parallel-#{task.id}",
                   chat_dispatch_id: dispatch.id
                 )

        assert :ok = Dispatches.attach_run(dispatch.id, run.id)
        assert {:ok, running} = Store.attach_run(dispatch.id, run.id)
        assert Enum.find(running.mission.tasks, &(&1.id == task.id)).status == "running"
        {task, run}
      end

    [{first_task, first_run}, {second_task, second_run}] = runs
    assert :ok = RunStore.finish(first_run.id, "completed", "Evidence A")
    assert {:ok, first_done} = Scheduler.settle_run(first_run.id, "completed", "Evidence A")
    assert first_done.settled.update.mission.status == "reviewing"

    assert {:ok, still_running} =
             Store.get(ctx.user.id, ctx.channel.id, second_mission.mission.id)

    assert Enum.find(still_running.mission.tasks, &(&1.id == second_task.id)).status == "running"
    assert still_running.mission.status == "active"

    assert :ok = RunStore.finish(second_run.id, "completed", "Evidence B")
    assert {:ok, second_done} = Scheduler.settle_run(second_run.id, "completed", "Evidence B")
    assert second_done.settled.update.mission.status == "reviewing"
    assert second_done.wakeDispatch.dispatch.runId == nil

    for {task, _run} <- [{first_task, first_run}, {second_task, second_run}] do
      {:ok, update} =
        Store.get(
          ctx.user.id,
          ctx.channel.id,
          if(task.id == first_task.id,
            do: first_mission.mission.id,
            else: second_mission.mission.id
          )
        )

      [projected] = update.mission.tasks
      assert projected.baseCommit == String.duplicate("b", 40)
      assert projected.verification in ["Evidence A", "Evidence B"]
    end
  end

  test "recovered task completion uses its bound failed run without rewriting failure or repeating work",
       ctx do
    {:ok, created} = mission(ctx, "Recovered delivered outcome")
    {:ok, added} = task(ctx, created.mission.id, "Delivery")
    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Delivery", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)
    :ok = RunStore.finish(run.id, "failed", "Provider disconnected")
    {:ok, _} = Scheduler.settle_run(run.id, "failed", "Provider disconnected")

    assert {:error, "Mission has no completed worker evidence"} =
             finish_recovered(ctx, created.mission)

    evidence =
      "Recovered existing commit; required checks passed; exact Actions deployment verified"

    {:ok, completed} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "completed",
        summary: evidence
      })

    assert completed.mission.status == "reviewing"
    # Late settlement must not erase the recovered delivery or revive a worker.
    {:ok, _} = Scheduler.settle_run(run.id, "failed", "Provider disconnected")
    assert Scheduler.schedule(created.mission.id).dispatches == []

    assert ["failed", "Provider disconnected"] ==
             SQL.one("SELECT status,summary FROM runs WHERE id=?", [run.id])

    assert ["completed", ^evidence] =
             SQL.one("SELECT status,summary FROM chat_mission_tasks WHERE id=?", [added.task.id])

    assert {:error,
            "Coordinator verification is required: record observed checks and artifact or live revision evidence"} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed"
             })

    assert {:error, "Mission workers cannot finish the mission"} =
             Store.finish(
               ctx.user.id,
               ctx.channel.id,
               created.mission.id,
               %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 status: "completed",
                 verification: evidence
               }, current_run_id: run.id)

    # Stop, live runs, and foreign bindings must still fail evidence qualification.
    for status <- ["running", "canceled"] do
      SQL.exec("UPDATE runs SET status=? WHERE id=?", [status, run.id])

      assert {:error, "Mission has no completed worker evidence"} =
               finish_recovered(ctx, created.mission)
    end

    SQL.exec("UPDATE runs SET status='failed',chat_dispatch_id=NULL WHERE id=?", [run.id])

    assert {:error, "Mission has no completed worker evidence"} =
             finish_recovered(ctx, created.mission)

    SQL.exec("UPDATE runs SET chat_dispatch_id=? WHERE id=?", [dispatch.id, run.id])
    assert {:ok, closed} = finish_recovered(ctx, created.mission)
    assert closed.mission.status == "completed"
    assert ["failed"] == SQL.one("SELECT status FROM runs WHERE id=?", [run.id])
  end

  test "manual completion without a bound worker run cannot enter review or finish", ctx do
    {:ok, created} = mission(ctx, "No borrowed evidence")
    {:ok, added} = task(ctx, created.mission.id, "Pending worker")

    assert {:ok, updated} =
             Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
               status: "completed",
               summary: "Unrelated preexisting commit deadbeef"
             })

    assert updated.mission.status == "attention"

    assert {:error, "Mission has no completed worker evidence"} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Looks done"
             })
  end

  test "canceling every task closes the mission without manufacturing completion evidence", ctx do
    {:ok, created} = mission(ctx, "Canceled without evidence")
    {:ok, added} = task(ctx, created.mission.id, "Never ran")

    assert {:ok, update} =
             Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{status: "canceled"})

    assert update.mission.status == "attention"

    assert {:ok, closed} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Nothing ran"
             })

    assert closed.mission.status == "canceled"
    assert closed.mission.summary == "Nothing ran"
  end

  test "completion cannot cover active work and cancellation removes pending dispatches", ctx do
    {:ok, created} = mission(ctx, "Cancelable")
    {:ok, added} = task(ctx, created.mission.id, "Pending task")
    scheduled = Scheduler.schedule(created.mission.id)
    assert length(scheduled.dispatches) == 1
    assert {:ok, [_]} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert {:error, "Mission still has active workers"} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Too soon"
             })

    assert {:ok, canceled} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "canceled",
               summary: "No longer needed"
             })

    assert canceled.mission.status == "canceled"
    assert hd(canceled.mission.tasks).status == "canceled"
    assert {:ok, []} == Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert {:error, "Mission is already closed"} =
             Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Too late",
               assignee: ctx.worker.id
             })

    assert added.task.id
  end

  test "a linked-channel participant cannot create source-vault work without write authority",
       ctx do
    guest_id = ctx.user.id + 100_000
    guest_name = "mission_guest_#{ctx.suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [guest_id, guest_name, "x", guest_name]
    )

    guest_vault = ContentStore.create_vault(guest_id, %{name: "Guest mission"})

    guest_channel =
      ContentStore.create_note(guest_vault.id, guest_id, %{
        title: "Linked mission room",
        content: "cascade://chat-channel"
      })

    assert {:ok, _route} =
             Channel.link(
               ctx.vault.id,
               ctx.channel.id,
               guest_vault.id,
               guest_channel.id,
               ctx.user.id
             )

    {:ok, guest_coordinator_identity} =
      Agents.upsert_identity(guest_id, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Sol",
        mention: "guest-sol-#{ctx.suffix}"
      })

    {:ok, guest_coordinator} =
      Agents.add_to_channel(
        guest_id,
        guest_vault.id,
        guest_channel.id,
        guest_coordinator_identity.id,
        %{orchestrator: true}
      )

    {:ok, guest_worker_identity} =
      Agents.upsert_identity(guest_id, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Terra",
        mention: "guest-terra-#{ctx.suffix}"
      })

    {:ok, guest_worker} =
      Agents.add_to_channel(
        guest_id,
        guest_vault.id,
        guest_channel.id,
        guest_worker_identity.id
      )

    guest = %{id: guest_id, username: guest_name}

    {:ok, root} =
      Messages.create(guest, guest_vault.id, guest_channel.id, %{
        id: "guest-mission-root-#{ctx.suffix}",
        body: "Run my own agent through the linked channel."
      })

    {:ok, created} =
      Store.create(guest_id, guest_vault.id, guest_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: guest_coordinator.id,
        title: "Guest-owned mission"
      })

    assert created.mission.coordinator == "Guest Sol"

    assert {:error, "Vault not writable"} =
             Store.add_task(guest_id, guest_channel.id, created.mission.id, %{
               coordinatorRegistrationId: guest_coordinator.id,
               title: "Guest work",
               assignee: guest_worker.id
             })
  end

  test "schema creates every table and index with one-statement execution and upgrades legacy rows",
       ctx do
    for table <-
          ~w(chat_mission_recovery_evidence chat_mission_events chat_mission_tasks chat_missions chat_agent_dispatches) do
      SQL.exec("DROP TABLE IF EXISTS #{table}")
    end

    SQL.exec("""
    CREATE TABLE chat_agent_dispatches (
      id TEXT PRIMARY KEY,message_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      registration_id TEXT NOT NULL,run_id INTEGER,created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id,registration_id)
    )
    """)

    SQL.exec("""
    CREATE TABLE chat_missions (
      id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,channel_id TEXT NOT NULL,root_message_id TEXT NOT NULL,
      coordinator_registration_id TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',summary TEXT NOT NULL DEFAULT '',wake_sent INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(channel_id,root_message_id)
    )
    """)

    SQL.exec("""
    CREATE TABLE chat_mission_tasks (
      id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,title TEXT NOT NULL,
      assignee_registration_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',dispatch_id TEXT,run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)

    SQL.exec(
      "INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,status,created_by) VALUES('legacy-mission',?,?,?,?,?,'blocked',?)",
      [ctx.vault.id, ctx.channel.id, ctx.root.id, ctx.coordinator.id, "Legacy", ctx.user.id]
    )

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status,summary) VALUES('legacy-task','legacy-mission','Child',?,'blocked','Dependency “Parent” ended failed.')",
      [ctx.worker.id]
    )

    assert :ok == MissionSchema.ensure!()

    assert Enum.sort(SQL.columns("chat_mission_tasks")) |> Enum.member?("depends_on_json")
    assert "reasoning_effort" in SQL.columns("chat_agent_dispatches")

    for object <-
          ~w(chat_agent_dispatches_pending_idx chat_missions_channel_idx chat_mission_tasks_mission_idx chat_mission_tasks_dispatch_idx chat_mission_tasks_run_idx chat_mission_events_mission_idx) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE name=?", [object]) == [1]
    end

    assert SQL.one("SELECT status,summary FROM chat_mission_tasks WHERE id='legacy-task'") == [
             "pending",
             ""
           ]

    assert SQL.one("SELECT status FROM chat_missions WHERE id='legacy-mission'") == ["active"]

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'")
           |> hd() >= 2

    before = SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'")
    assert :ok == MissionSchema.ensure!()

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'") ==
             before
  end

  defp recovery_fixture(ctx) do
    {:ok, original} = mission(ctx, "Original delivery")
    {:ok, target} = task(ctx, original.mission.id, "Delivery")
    [%{dispatch: dispatch}] = Scheduler.schedule(original.mission.id).dispatches

    {:ok, failed} =
      RunStore.start(ctx.vault.id, nil, "original", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, failed.id)
    {:ok, _} = Store.attach_run(dispatch.id, failed.id)
    :ok = RunStore.finish(failed.id, "failed", "Orphaned after restart; artifact exists")

    {:ok, _} =
      Scheduler.settle_run(failed.id, "failed", "Orphaned after restart; artifact exists")

    {:ok, root} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        body: "Recover and verify original delivery"
      })

    {:ok, recovery} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Recovery"
      })

    {:ok, source} = task(ctx, recovery.mission.id, "Existing delivery evidence")
    [%{dispatch: dispatch}] = Scheduler.schedule(recovery.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "recovery", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)
    :ok = RunStore.finish(run.id, "completed", "Verified deployment")
    {:ok, _} = Scheduler.settle_run(run.id, "completed", "Verified deployment")

    input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      sourceTaskId: source.task.id,
      sourceRunId: run.id,
      targetRunId: failed.id,
      targetAttempt: 0,
      objective: original.mission.objective,
      verification:
        "Observed exact deployed revision and preserved test artifact for original objective"
    }

    {original.mission, target.task, failed, source.task, run, input}
  end

  defp finish_recovered(ctx, mission) do
    Store.finish(ctx.user.id, ctx.channel.id, mission.id, %{
      coordinatorRegistrationId: ctx.coordinator.id,
      status: "completed",
      verification: "Observed deployment and artifact"
    })
  end

  test "steering stops only the bound worker and retains task, work item and provider context",
       ctx do
    {mission, task, run, input} = steering_fixture(ctx)
    [work_item] = SQL.one("SELECT work_item_id FROM chat_mission_tasks WHERE id=?", [task.id])
    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)
    parent = self()

    result =
      Cascade.Missions.Steering.deliver(request,
        cancel: fn owner, id ->
          assert owner == ctx.user.id
          assert id == run.id
          :ok = RunStore.finish(id, "canceled", "Run canceled.")
          assert {:ok, nil} = Scheduler.settle_run(id, "canceled", "Run canceled.")
          true
        end,
        schedule: fn mission_id ->
          scheduled = Scheduler.schedule(mission_id)
          [item] = scheduled.dispatches
          assert item.message.body =~ "Keep the edits; change only the test."
          refute item.message.body =~ "Original large instruction payload"

          assert RunStore.find_conversation_session(%{
                   vault_id: ctx.vault.id,
                   note_id: nil,
                   agent: "codex",
                   conversation_id: "mission:#{task.id}"
                 }) == "saved-steering-session"

          {:ok, resumed} =
            RunStore.start(ctx.vault.id, nil, item.message.body, "codex",
              conversation_id: "mission:#{task.id}",
              chat_dispatch_id: item.dispatch.id,
              session_id: "saved-steering-session"
            )

          :ok = RunStore.record_delegated(resumed.id, ctx.user.id)
          :ok = Dispatches.attach_run(item.dispatch.id, resumed.id)
          {:ok, _} = Store.attach_run(item.dispatch.id, resumed.id)
          send(parent, {:resumed, resumed.id})
        end
      )

    assert result.status == "dispatched"
    assert_receive {:resumed, resumed_id}
    assert result.runId == resumed_id

    assert [work_item, "running", 1] ==
             SQL.one("SELECT work_item_id,status,attempt FROM chat_mission_tasks WHERE id=?", [
               task.id
             ])

    assert {:ok, update} = Store.get(ctx.user.id, ctx.channel.id, mission.id)
    assert length(update.mission.tasks) == 1
    assert Cascade.Missions.Steering.deliver(request).runId == resumed_id
  end

  test "unacknowledged steering stays queued without replacing the worker", ctx do
    {_, task, run, input} = steering_fixture(ctx)
    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)

    assert %{status: "queued", detail: detail} =
             Cascade.Missions.Steering.deliver(request, cancel: fn _, _ -> false end)

    assert detail =~ "acknowledgment"

    assert [run.id, 0] ==
             SQL.one("SELECT run_id,attempt FROM chat_mission_tasks WHERE id=?", [task.id])

    assert {:error, reason} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)
    assert reason =~ "already has queued"
  end

  test "stop revocation wins while the provider acknowledgment is in flight", ctx do
    {_, task, run, input} = steering_fixture(ctx)
    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)

    assert %{status: "rejected"} =
             Cascade.Missions.Steering.deliver(request,
               cancel: fn _, _ ->
                 Cascade.Missions.Steering.cancel_pending(run.id)
                 true
               end
             )

    assert [run.id, 0] ==
             SQL.one("SELECT run_id,attempt FROM chat_mission_tasks WHERE id=?", [task.id])
  end

  test "explicit stop revokes queued steering", ctx do
    {_, task, run, input} = steering_fixture(ctx)
    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)

    assert %{status: "queued"} =
             Cascade.Missions.Steering.deliver(request, cancel: fn _, _ -> false end)

    assert RunStore.cancel(run.id, force: true)
    assert %{status: "rejected", detail: reason} = Cascade.Missions.Steering.deliver(request)
    assert reason =~ "Worker stopped"
    assert [0] == SQL.one("SELECT attempt FROM chat_mission_tasks WHERE id=?", [task.id])
  end

  test "steering rejects stale snapshots and completion during provider interruption", ctx do
    {_, task, run, input} = steering_fixture(ctx)

    assert {:error, reason} =
             Store.request_steering(ctx.user.id, ctx.channel.id, task.id, %{input | attempt: 7})

    assert reason =~ "Task changed"
    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)

    assert %{status: "rejected"} =
             Cascade.Missions.Steering.deliver(request,
               cancel: fn _, _ ->
                 RunStore.finish(run.id, "completed", "Done")
                 Scheduler.settle_run(run.id, "completed", "Done")
                 true
               end
             )

    assert [run.id, "completed", 0] ==
             SQL.one("SELECT run_id,status,attempt FROM chat_mission_tasks WHERE id=?", [task.id])

    assert {:error, reason} = Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input)
    assert reason =~ "already finished"
  end

  test "workers, wrong coordinators, and nonowners cannot steer", ctx do
    {_, task, run, input} = steering_fixture(ctx)

    assert {:error, reason} =
             Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input,
               current_run_id: run.id
             )

    assert reason =~ "workers cannot steer"

    assert {:error, reason} =
             Store.request_steering(ctx.user.id, ctx.channel.id, task.id, %{
               input
               | coordinatorRegistrationId: ctx.worker.id
             })

    assert reason =~ "another coordinator"

    assert {:error, _} =
             Store.request_steering(ctx.user.id + 100_000_000, ctx.channel.id, task.id, input)

    assert {:error, reason} =
             Store.request_steering(ctx.user.id, ctx.channel.id, task.id, input,
               current_run_id: 999_999_999
             )

    assert reason =~ "Only this mission's coordinator"
  end

  test "pending task steering changes the dispatched instructions without losing the original",
       ctx do
    {:ok, created} = mission(ctx, "Steer queued")
    {:ok, added} = task(ctx, created.mission.id, "Original queued work")

    input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      message: "Also preserve the fixture.",
      attempt: 0,
      runId: nil
    }

    {:ok, request} = Store.request_steering(ctx.user.id, ctx.channel.id, added.task.id, input)

    assert %{status: "queued"} =
             Cascade.Missions.Steering.deliver(request,
               schedule: fn id ->
                 [item] = Scheduler.schedule(id).dispatches
                 assert item.message.body =~ "Original queued work"
                 assert item.message.body =~ "Also preserve the fixture."
               end
             )
  end

  defp steering_fixture(ctx) do
    {:ok, created} = mission(ctx, "Worker steering")

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Steer worker",
        assignee: ctx.worker.id,
        prompt: "Original large instruction payload"
      })

    [item] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Existing work", "codex",
        chat_dispatch_id: item.dispatch.id,
        conversation_id: "mission:#{added.task.id}",
        session_id: "saved-steering-session"
      )

    :ok = Dispatches.attach_run(item.dispatch.id, run.id)
    {:ok, _} = Store.attach_run(item.dispatch.id, run.id)

    input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      message: "Keep the edits; change only the test.",
      attempt: 0,
      runId: run.id
    }

    {created.mission, added.task, run, input}
  end

  defp mission(ctx, title) do
    Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
      rootMessageId: ctx.root.id,
      coordinatorRegistrationId: ctx.coordinator.id,
      title: title
    })
  end

  defp task(ctx, mission_id, title) do
    Store.add_task(ctx.user.id, ctx.channel.id, mission_id, %{
      coordinatorRegistrationId: ctx.coordinator.id,
      title: title,
      assignee: ctx.worker.id
    })
  end
end
