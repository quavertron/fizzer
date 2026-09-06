defmodule Cascade.Missions.ChildrenTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Missions.Children
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

    on_exit(fn ->
      SQL.exec(
        "DELETE FROM chat_mission_tasks WHERE mission_id IN (SELECT id FROM chat_missions WHERE vault_id=?)",
        [vault.id]
      )

      SQL.exec("DELETE FROM chat_missions WHERE vault_id=?", [vault.id])
      SQL.exec("DELETE FROM vaults WHERE id=?", [vault.id])
    end)

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

  test "parallel children join once, resume their parent with artifacts, and gate completion",
       ctx do
    {mission, parent, run} = parent(ctx)
    :ok = RunStore.finish(run.id, "failed", "Original deadline expired")
    {:ok, _} = Store.settle_run(run.id, "failed", "Original deadline expired")

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{
        status: "pending",
        summary: "Renewed deadline applies through child integration."
      })

    renewed = Scheduler.schedule(mission.id)
    [%{dispatch: retry_dispatch}] = renewed.dispatches
    assert length(renewed.wakeDispatches) == 1
    run = start(ctx, retry_dispatch)

    {:ok, child} =
      Children.add(
        ctx.user.id,
        ctx.channel.id,
        mission.id,
        %{title: "Piece", prompt: "Implement piece"},
        run.id
      )

    assert child.task.parentTaskId == parent.id
    assert child.task.anonymous
    assert child.task.workspaceMode == "isolated"
    assert child.task.assigneeMention == ctx.worker.mention <> "·sub"
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    assert {:error, _} =
             Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "completed"})

    assert {:ok, %{children: [%{id: child_id}]}} =
             Children.join(ctx.user.id, ctx.channel.id, run.id)

    assert child_id == child.task.id
    :ok = RunStore.finish(run.id, "completed", "Independent work done")
    {:ok, waiting} = Scheduler.settle_run(run.id, "completed", "Independent work done")
    assert waiting.scheduled.dispatches == []
    assert waiting.scheduled.wakeDispatches == []
    assert Children.joining?(parent.id)
    assert Store.schedulable(mission.id).candidates == []
    :ok = RunStore.finish(child_run.id, "completed", "Commit abc; focused test passed")

    {:ok, joined} =
      Scheduler.settle_run(child_run.id, "completed", "Commit abc; focused test passed")

    assert [%{dispatch: continuation, message: message}] = joined.scheduled.dispatches
    assert message.missionTaskId == parent.id
    assert message.body =~ "Commit abc"
    assert message.body =~ "Renewed deadline applies through child integration."
    assert message.body =~ child.task.branch
    assert message.body =~ "Integrate and verify"
    assert joined.scheduled.wakeDispatches == []
    assert Scheduler.schedule(mission.id).dispatches == []
    assert {:ok, nil} = Store.settle_run(run.id, "completed", "duplicate")
    integrated = start(ctx, continuation)
    :ok = RunStore.finish(integrated.id, "completed", "Integrated and tested")
    {:ok, final} = Scheduler.settle_run(integrated.id, "completed", "Integrated and tested")

    assert final.settled.update.mission.tasks
           |> Enum.find(&(&1.id == parent.id))
           |> Map.get(:status) == "completed"

    assert final.scheduled.wakeDispatches == []
    # Findings coalesce into the interpretation already queued during recovery.
    assert Scheduler.schedule(mission.id).wakeDispatches == []
  end

  test "restart recovery reconciles missed parent and child settlements exactly once", ctx do
    {mission, parent, run} = parent(ctx)
    {:ok, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Child"}, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    # Persist terminal runs without delivering their settlement callbacks, as at a crash.
    :ok = RunStore.finish(run.id, "completed", "Parent independent work")
    :ok = RunStore.finish(child_run.id, "completed", "Durable child evidence")
    recovered = Scheduler.schedule(mission.id)
    assert [%{dispatch: continuation, message: message}] = recovered.dispatches
    assert message.missionTaskId == parent.id
    assert message.body =~ "Durable child evidence"
    assert length(recovered.wakeDispatches) == 1
    assert Scheduler.schedule(mission.id).dispatches == []
    assert {:ok, nil} = Store.settle_run(run.id, "completed", "Late callback")
    resumed = start(ctx, continuation)
    :ok = RunStore.finish(resumed.id, "completed", "Integrated evidence")
    recovered = Scheduler.schedule(mission.id)
    assert recovered.wakeDispatches == []
    assert Scheduler.schedule(mission.id).wakeDispatches == []
  end

  test "authority, one-level depth, stale runs, and fanout are bounded", ctx do
    {mission, parent, run} = parent(ctx)
    input = %{title: "Piece", prompt: "Only this piece"}
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, "elsewhere", input, run.id)
    assert {:error, _} = Children.add(ctx.user.id + 1, ctx.channel.id, mission.id, input, run.id)
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, nil)
    {:ok, child} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    assert {:error, _} =
             Children.add(ctx.user.id, ctx.channel.id, mission.id, input, child_run.id)

    assert {:error, _} =
             Children.authorize_update(ctx.user.id, ctx.channel.id, parent.id, child_run.id)

    assert :ok = Children.authorize_update(ctx.user.id, ctx.channel.id, child.task.id, run.id)

    assert {:error, _} =
             Store.add_task(
               ctx.user.id,
               ctx.channel.id,
               mission.id,
               %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 title: "Escape",
                 assignee: ctx.worker.id
               },
               current_run_id: run.id
             )

    for n <- 2..8 do
      assert {:ok, _} =
               Children.add(
                 ctx.user.id,
                 ctx.channel.id,
                 mission.id,
                 %{title: "Piece #{n}"},
                 run.id
               )
    end

    assert {:ok, duplicate} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, run.id)
    assert duplicate.task.id == child.task.id

    assert {:error, _} =
             Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Ninth"}, run.id)

    :ok = RunStore.finish(run.id, "completed", "done")
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, run.id)
  end

  test "parent cancellation propagates to running and queued children", ctx do
    {mission, parent, run} = parent(ctx)

    {:ok, first} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Running child"}, run.id)

    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    {:ok, second} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Queued child"}, run.id)

    {:ok, update} =
      Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "canceled"})

    assert child_run.id in update.canceledTaskRunIds

    for child <- [first.task, second.task] do
      assert ["canceled"] =
               SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [child.id])
    end

    assert Scheduler.schedule(mission.id).dispatches == []
  end

  test "failed results return to parent and cannot be silently completed", ctx do
    {mission, parent, run} = parent(ctx)

    {:ok, _} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Failing child"}, run.id)

    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    :ok = RunStore.finish(child_run.id, "failed", "Test failed")
    {:ok, result} = Scheduler.settle_run(child_run.id, "failed", "Test failed")
    assert length(result.scheduled.wakeDispatches) == 1
    assert RunStore.get(run.id).status in ["queued", "running"]
    :ok = RunStore.finish(run.id, "completed", "join")
    {:ok, result} = Scheduler.settle_run(run.id, "completed", "join")
    assert [%{dispatch: dispatch}] = result.scheduled.dispatches
    integration = start(ctx, dispatch)

    assert {:error, _} =
             Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "completed"})

    :ok = RunStore.finish(integration.id, "completed", "Ignored failure")
    {:ok, result} = Scheduler.settle_run(integration.id, "completed", "Ignored failure")

    assert Enum.find(result.settled.update.mission.tasks, &(&1.id == parent.id)).status ==
             "blocked"
  end

  test "cancellation retries survive missing runner acknowledgment", ctx do
    {mission, parent, run} = parent(ctx)
    {:ok, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Child"}, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    :ok = RunStore.finish(run.id, "canceled", "Stopped")
    {:ok, _} = Scheduler.settle_run(run.id, "canceled", "Stopped")

    Cascade.Missions.Recovery.replay_cancellations(fn user, id ->
      assert user == ctx.user.id
      assert id == child_run.id
      false
    end)

    assert RunStore.get(child_run.id).status == child_run.status

    Cascade.Missions.Recovery.replay_cancellations(fn user, id ->
      assert user == ctx.user.id
      assert id == child_run.id
      true
    end)

    assert RunStore.get(child_run.id).status == "canceled"

    Cascade.Missions.Recovery.replay_cancellations(fn _, _ ->
      flunk("Canceled children must not be replayed")
    end)

    assert {:error, _} = Children.authorize_update(ctx.user.id, ctx.channel.id, parent.id, run.id)
  end

  test "canceled parent and children retry stop acknowledgment from canonical task state", ctx do
    {mission, parent, run} = parent(ctx)
    {:ok, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Child"}, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    {:ok, _} = Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "canceled"})

    attempted = fn acknowledge ->
      Cascade.Missions.Recovery.replay_cancellations(fn owner, id ->
        assert owner == ctx.user.id
        send(self(), {:stop, id})
        acknowledge
      end)
    end

    attempted.(false)
    assert_receive {:stop, id} when id == run.id
    assert_receive {:stop, id} when id == child_run.id
    assert RunStore.get(run.id).status == run.status
    assert RunStore.get(child_run.id).status == child_run.status
    assert Scheduler.schedule(mission.id).dispatches == []

    attempted.(true)
    assert RunStore.get(run.id).status == "canceled"
    assert RunStore.get(child_run.id).status == "canceled"
    Cascade.Missions.Recovery.replay_cancellations(fn _, _ -> flunk("Already stopped") end)
    assert Scheduler.schedule(mission.id).dispatches == []
  end

  test "steering a parent preserves its live children and join resumes the same task", ctx do
    {mission, parent, run} = parent(ctx)

    SQL.exec("UPDATE runs SET session_id='parent-session',conversation_id=? WHERE id=?", [
      "mission:#{parent.id}",
      run.id
    ])

    {:ok, child} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Independent child"}, run.id)

    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    {:ok, request} =
      Store.request_steering(ctx.user.id, ctx.channel.id, parent.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        message: "Keep children; fix integration",
        attempt: 0,
        runId: run.id
      })

    Cascade.Missions.Steering.deliver(request,
      cancel: fn _, id ->
        :ok = RunStore.finish(id, "canceled", "steering")
        assert {:ok, nil} = Scheduler.settle_run(id, "canceled", "steering")
        true
      end,
      schedule: fn _ -> :ok end
    )

    assert ["running", child_run.id] ==
             SQL.one("SELECT status,run_id FROM chat_mission_tasks WHERE id=?", [child.task.id])

    [%{dispatch: dispatch, message: message}] = Scheduler.schedule(mission.id).dispatches
    assert message.missionTaskId == parent.id
    assert message.body =~ "fix integration"

    assert RunStore.find_conversation_session(%{
             vault_id: ctx.vault.id,
             note_id: nil,
             agent: "codex",
             conversation_id: "mission:#{parent.id}"
           }) == "parent-session"

    resumed = start(ctx, dispatch)
    :ok = RunStore.finish(resumed.id, "completed", "join")
    {:ok, waiting} = Scheduler.settle_run(resumed.id, "completed", "join")
    assert waiting.scheduled.dispatches == []
    :ok = RunStore.finish(child_run.id, "completed", "Child artifact")
    {:ok, joined} = Scheduler.settle_run(child_run.id, "completed", "Child artifact")
    assert [%{message: integrated}] = joined.scheduled.dispatches
    assert integrated.body =~ "Child artifact"
    assert integrated.body =~ "fix integration"
    assert integrated.missionTaskId == parent.id
  end

  test "steering a waiting join can resume independent parent work", ctx do
    {mission, parent, run} = parent(ctx)
    {:ok, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Child"}, run.id)
    Scheduler.schedule(mission.id)
    :ok = RunStore.finish(run.id, "completed", "joining")
    {:ok, _} = Scheduler.settle_run(run.id, "completed", "joining")

    {:ok, request} =
      Store.request_steering(ctx.user.id, ctx.channel.id, parent.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        message: "Do independent correction while waiting",
        attempt: 0,
        runId: nil
      })

    Cascade.Missions.Steering.deliver(request, schedule: fn _ -> :ok end)
    refute Children.joining?(parent.id)
    assert [%{message: message}] = Scheduler.schedule(mission.id).dispatches
    assert message.body =~ "independent correction"
    assert message.missionTaskId == parent.id
    assert Children.unresolved?(parent.id)
  end

  test "ready child results do not overtake an accepted steering request", ctx do
    {mission, parent, run} = parent(ctx)
    {:ok, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Child"}, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    :ok = RunStore.finish(run.id, "completed", "joining")
    {:ok, _} = Scheduler.settle_run(run.id, "completed", "joining")

    {:ok, request} =
      Store.request_steering(ctx.user.id, ctx.channel.id, parent.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        message: "Review the new constraint",
        attempt: 0,
        runId: nil
      })

    :ok = RunStore.finish(child_run.id, "completed", "Child ready")
    {:ok, held} = Scheduler.settle_run(child_run.id, "completed", "Child ready")
    assert held.scheduled.dispatches == []
    Cascade.Missions.Steering.deliver(request, schedule: fn _ -> :ok end)
    assert [%{message: message}] = Scheduler.schedule(mission.id).dispatches
    assert message.body =~ "new constraint"
    assert message.missionTaskId == parent.id
  end

  defp parent(ctx) do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Child lifecycle"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        assignee: ctx.worker.id,
        title: "Parent"
      })

    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches
    {created.mission, added.task, start(ctx, dispatch)}
  end

  defp start(ctx, dispatch) do
    {:ok, run} = RunStore.start(ctx.vault.id, nil, "work", "codex", chat_dispatch_id: dispatch.id)
    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)
    run
  end
end
