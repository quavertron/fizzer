defmodule Cascade.Missions.NotificationsTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Missions.{Dispatches, Interpretation, Notifications, Scheduler, Store}
  alias Cascade.Runs.Store, as: Runs

  setup do
    owner = Cascade.TestHelpers.owner_vault("notifications")
    user = %{id: owner.user_id, username: owner.username}

    channel =
      Cascade.Content.Store.create_note(owner.vault_id, user.id, %{
        title: "Receipts",
        content: "cascade://chat-channel"
      })

    {:ok, coordinator} =
      Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "coordinator",
        orchestrator: true
      })

    {:ok, worker} =
      Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "worker"
      })

    {:ok, root} =
      Messages.create(user, owner.vault_id, channel.id, %{
        body: "Deliver the requested work and report its outcome."
      })

    {:ok, update} =
      Store.create(
        user.id,
        owner.vault_id,
        channel.id,
        %{rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: "Deliver"},
        control_plane: true
      )

    {:ok, task} =
      Store.add_task(user.id, channel.id, update.mission.id, %{
        title: "Research",
        assignee: worker.id,
        coordinatorRegistrationId: coordinator.id,
        purpose: "research"
      })

    %{
      user: user,
      vault: owner.vault_id,
      channel: channel.id,
      coordinator: coordinator,
      worker: worker,
      mission: update.mission.id,
      task: task.task.id
    }
  end

  defp block(c),
    do:
      Store.update_task(c.user.id, c.channel, c.task, %{
        status: "blocked",
        summary:
          "Screenshot verification cannot open the protected page; owner login is required."
      })

  defp receipts(c),
    do:
      SQL.all(
        "SELECT id,body FROM chat_messages WHERE channel_id=? AND id LIKE 'task-notification:%' ORDER BY id",
        [c.channel]
      )

  defp dispatch_run(c, d) do
    {:ok, run} =
      Runs.start(c.vault, nil, "Synthetic", "codex",
        owner_user_id: c.user.id,
        chat_dispatch_id: d.id,
        conversation_id: d.conversationId
      )

    :ok = Dispatches.attach_run(d.id, run.id)
    run
  end

  test "offline coordinator cannot prevent durable blocker receipt; independent maintenance selects it",
       c do
    {:ok, _} = block(c)
    refute Cascade.Runs.RunnerLifecycle.online?(c.user.id)
    assert Notifications.jobs()[{:notification, c.mission}] == c.user.id
    before_runs = SQL.one("SELECT COUNT(*) FROM runs")
    :ok = Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    [[id, body]] = receipts(c)
    assert id == "task-notification:#{c.task}:0:blocked"
    assert SQL.one("SELECT agent_id,registration_id FROM chat_messages WHERE id=?", [id]) == ["fizzer-task-status", nil]
    SQL.exec("UPDATE chat_messages SET agent_id=NULL WHERE id=?", [id])
    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    assert SQL.one("SELECT agent_id FROM chat_messages WHERE id=?", [id]) == ["fizzer-task-status"]
    assert body =~ "owner login is required"
    assert SQL.one("SELECT COUNT(*) FROM runs") == before_runs
    assert SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [c.task]) == ["blocked"]
  end

  test "noMaterialChange acknowledgment cannot swallow an actionable blocker", c do
    {:ok, _} = block(c)
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    run = dispatch_run(c, wake.dispatch)
    {:ok, current} = Interpretation.get(c.user.id, c.channel, c.mission, c.coordinator.id)

    assert {:ok, %{messageId: nil}} =
             Interpretation.record(
               c.user,
               c.channel,
               c.mission,
               c.coordinator.id,
               %{
                 "revision" => current.revision,
                 "fingerprint" => current.fingerprint,
                 "noMaterialChange" => true
               },
               run.id,
               Cascade.Chat.Events.Noop
             )

    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    assert [[_, body]] = receipts(c)
    assert body =~ "Task blocked"
  end

  test "fanout failure and new concurrent callers replay one durable id, never an action", c do
    {:ok, _} = block(c)
    failing = fn _ -> raise "synthetic delivery outage" end

    assert_raise RuntimeError, "synthetic delivery outage", fn ->
      Notifications.reconcile(c.mission, failing)
    end

    [[id, _]] = receipts(c)

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [0]

    parent = self()
    sink = fn event -> send(parent, {:delivered, event.message.id}) end

    1..8
    |> Enum.map(fn _ -> Task.async(fn -> Notifications.reconcile(c.mission, sink) end) end)
    |> Enum.each(&Task.await/1)

    assert_receive {:delivered, ^id}
    refute_receive {:delivered, _}
    assert [[^id, _]] = receipts(c)

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [1]
  end

  test "persisted fanout without acknowledgment may replay same id after restart", c do
    {:ok, _} = block(c)
    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    [[id, _]] = receipts(c)

    SQL.exec(
      "DELETE FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
      [c.mission]
    )

    parent = self()

    Task.async(fn ->
      Notifications.reconcile(c.mission, fn e -> send(parent, {:replay, e.message.id}) end)
    end)
    |> Task.await()

    assert_receive {:replay, ^id}
    assert [[^id, _]] = receipts(c)
  end

  test "Stop suppresses pending fanout and revoked owner access cannot publish", c do
    {:ok, _} = block(c)

    assert_raise RuntimeError, fn ->
      Notifications.reconcile(c.mission, fn _ -> raise "outage" end)
    end

    SQL.exec("UPDATE chat_mission_interpretations SET stopped=1 WHERE mission_id=?", [c.mission])
    # Ensure Stop exists even before the first interpretation wake.
    SQL.exec("UPDATE chat_missions SET status='canceled' WHERE id=?", [c.mission])
    Notifications.reconcile(c.mission, fn _ -> flunk("published after Stop") end)
    refute Map.has_key?(Notifications.jobs(), {:notification, c.mission})
    SQL.exec("UPDATE chat_missions SET status='attention' WHERE id=?", [c.mission])
    SQL.exec("UPDATE chat_mission_interpretations SET stopped=0 WHERE mission_id=?", [c.mission])
    SQL.exec("DELETE FROM vault_members WHERE vault_id=? AND user_id=?", [c.vault, c.user.id])
    Notifications.flush(c.mission, fn _ -> flunk("published after revocation") end)
  end

  test "mixed blocked/dependent heap still dispatches independent work without completing queued items",
       c do
    {:ok, _} = block(c)

    {:ok, dependent} =
      Store.add_task(c.user.id, c.channel, c.mission, %{
        title: "Dependent",
        assignee: c.worker.id,
        coordinatorRegistrationId: c.coordinator.id,
        purpose: "research",
        dependsOn: [c.task]
      })

    {:ok, ready} =
      Store.add_task(c.user.id, c.channel, c.mission, %{
        title: "Independent",
        assignee: c.worker.id,
        coordinatorRegistrationId: c.coordinator.id,
        purpose: "research"
      })

    result = Scheduler.schedule(c.mission)
    assert length(result.dispatches) == 1

    assert SQL.one("SELECT dispatch_id FROM chat_mission_tasks WHERE id=?", [ready.task.id]) != [
             nil
           ]

    assert SQL.one("SELECT status,dispatch_id FROM chat_mission_tasks WHERE id=?", [
             dependent.task.id
           ]) == ["pending", nil]

    assert Enum.any?(receipts(c), fn [_, body] ->
             body =~ "dependency that needs attention (not terminal)"
           end)

    refute Enum.any?(receipts(c), fn [_, body] -> body =~ "Independent" end)
  end

  test "real BEAM crash and concurrent restarted processes reconcile the same durable receipt",
       c do
    {:ok, _} = block(c)

    directory =
      Path.join(System.tmp_dir!(), "notification-probe-#{System.unique_integer([:positive])}")

    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)

    config =
      Application.get_all_env(:cascade_elixir) |> :erlang.term_to_binary() |> Base.encode64()

    paths = :code.get_path() |> Enum.flat_map(&["-pa", to_string(&1)])
    script = Path.expand("../../support/notification_process_probe.exs", __DIR__)

    invoke = fn participant, mode ->
      System.cmd(
        System.find_executable("elixir"),
        paths ++ [script, config, directory, participant, c.mission, mode],
        env: [{"ERL_FLAGS", "+S 2:2"}],
        stderr_to_stdout: true
      )
    end

    {_, 23} = invoke.("crash", "crash")
    [[id, _]] = receipts(c)
    assert File.read!(Path.join(directory, "delivery-crash")) == id

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [0]

    callers = for n <- 1..2, do: Task.async(fn -> invoke.(to_string(n), "replay") end)

    ready =
      Enum.reduce_while(1..1_000, false, fn _, _ ->
        if Enum.all?(1..2, &File.exists?(Path.join(directory, "ready-#{&1}"))),
          do: {:halt, true},
          else:
            (
              Process.sleep(10)
              {:cont, false}
            )
      end)

    assert ready
    File.write!(Path.join(directory, "release"), "release")

    Enum.each(callers, fn caller ->
      {output, code} = Task.await(caller, 15_000)
      assert code == 0, output
    end)

    assert [[^id, _]] = receipts(c)
    deliveries = Path.wildcard(Path.join(directory, "delivery-*")) |> Enum.map(&File.read!/1)
    assert Enum.all?(deliveries, &(&1 == id))
    assert length(deliveries) >= 2

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [1]

    assert SQL.one("SELECT COUNT(*) FROM runs WHERE owner_user_id=?", [c.user.id]) == [0]
  end

  test "noop/error sinks do not consume receipts and completed missions still drain", c do
    {:ok, _} = block(c)
    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [0]

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [c.mission])
    assert Map.has_key?(Notifications.jobs(), {:notification, c.mission})

    assert_raise RuntimeError, "Task notification fanout failed", fn ->
      Notifications.reconcile(c.mission, fn _ -> {:error, :offline} end)
    end

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='task_notification_sent'",
             [c.mission]
           ) == [0]

    Notifications.reconcile(c.mission, fn _ -> :ok end)
    refute Map.has_key?(Notifications.jobs(), {:notification, c.mission})
    [[id, _]] = receipts(c)
    SQL.exec("UPDATE chat_messages SET agent_id=NULL WHERE id=?", [id])
    assert Map.has_key?(Notifications.jobs(), {:notification, c.mission})
    Notifications.reconcile(c.mission, fn _ -> flunk("metadata repair republished an acknowledged receipt") end)
    assert SQL.one("SELECT agent_id FROM chat_messages WHERE id=?", [id]) == ["fizzer-task-status"]
    refute Map.has_key?(Notifications.jobs(), {:notification, c.mission})
  end

  test "waiting reasons distinguish capacity, dispatch and recorded provider trouble without terminal status",
       c do
    {:ok, initial} = Store.get(c.user.id, c.channel, c.mission)
    assert hd(initial.mission.tasks).waitingReason.kind == "capacity"
    [item] = Scheduler.schedule(c.mission).dispatches
    {:ok, queued} = Store.get(c.user.id, c.channel, c.mission)
    assert hd(queued.mission.tasks).waitingReason.kind == "dispatch"

    SQL.exec(
      "UPDATE chat_agent_dispatches SET error='Provider unavailable; retry after recovery' WHERE id=?",
      [item.dispatch.id]
    )

    {:ok, waiting} = Store.get(c.user.id, c.channel, c.mission)
    assert hd(waiting.mission.tasks).waitingReason.kind == "provider"
    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    assert [[_, body]] = receipts(c)
    assert body =~ "task not marked terminal"
    assert SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [c.task]) == ["pending"]
  end

  test "actual missing repository preparation rejection survives offline as an exact follow-up",
       c do
    worker = Process.whereis(Cascade.Missions.DispatchReannouncer)
    :sys.suspend(worker)
    on_exit(fn -> :sys.resume(worker) end)
    SQL.exec("UPDATE chat_mission_tasks SET workspace_mode='isolated' WHERE id=?", [c.task])

    SQL.exec(
      "UPDATE work_items SET workspace_mode='isolated',repository='',worktree_path='' WHERE id=(SELECT work_item_id FROM chat_mission_tasks WHERE id=?)",
      [c.task]
    )

    [item] = Scheduler.schedule(c.mission).dispatches
    alias Cascade.Realtime.{Session, Protocol.EngineIO, Protocol.SocketIO}
    sid = "notification-preparation-#{c.task}"

    {:ok, ^sid, pid} =
      Cascade.Realtime.start_session(sid: sid, domain: Cascade.Realtime.DomainAdapter)

    on_exit(fn ->
      Cascade.Realtime.Hub.unregister_runner(c.user.id, sid)

      if Process.alive?(pid),
        do: DynamicSupervisor.terminate_child(Cascade.Realtime.SessionSupervisor, pid)
    end)

    {:ok, _} = Session.poll(sid, 1_000)
    token = Cascade.Auth.Token.sign_user(Map.put(c.user, :auth_version, 0))

    send_packet = fn packet ->
      :ok =
        Session.receive_payload(
          sid,
          EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(packet)}])
        )
    end

    send_packet.(%{type: :connect, namespace: "/runners", data: %{"token" => token}})
    {:ok, _} = Session.poll(sid, 1_000)

    send_packet.(
      SocketIO.event("/runners", "runner:register", [
        %{"activeRunIds" => [], "runnerInstanceId" => sid}
      ])
    )

    {:ok, _} = Session.poll(sid, 1_000)
    assert Cascade.Runs.RunnerLifecycle.online?(c.user.id)
    assert {:retry, reason} = Cascade.Missions.Execution.execute_dispatch(item.dispatch.id)

    assert reason ==
             "Mission task needs a repository cwd before its isolated workspace can be prepared."

    Dispatches.retry(item.dispatch.id, reason)
    Cascade.Realtime.Hub.unregister_runner(c.user.id, sid)
    Notifications.reconcile(c.mission, fn _ -> :ok end)
    [[_, body]] = receipts(c)
    assert body =~ reason
    assert body =~ "task not marked terminal"
    assert SQL.one("SELECT COUNT(*) FROM runs WHERE owner_user_id=?", [c.user.id]) == [0]

    assert SQL.one("SELECT status,run_id FROM chat_mission_tasks WHERE id=?", [c.task]) == [
             "pending",
             nil
           ]

    Notifications.reconcile(c.mission, fn _ -> :ok end)
    assert length(receipts(c)) == 1
  end

  test "a forged completed status cannot produce a completion receipt", c do
    SQL.exec("UPDATE chat_mission_tasks SET status='completed',summary='Done' WHERE id=?", [
      c.task
    ])

    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)
    [[id, body]] = receipts(c)
    assert id =~ "evidence-missing"
    assert body =~ "Completion is not verified"
    refute body =~ "Task outcome recorded"
  end

  test "terminal run evidence produces one outcome without rerunning completed work", c do
    [item] = Scheduler.schedule(c.mission).dispatches
    run = dispatch_run(c, item.dispatch)
    {:ok, _} = Store.attach_run(item.dispatch.id, run.id)
    Runs.finish(run.id, "completed", "Observed the requested source and saved findings.")

    {:ok, _} =
      Scheduler.settle_run(
        run.id,
        "completed",
        "Observed the requested source and saved findings."
      )

    Notifications.reconcile(c.mission, Cascade.Chat.Events.Noop)

    assert Enum.any?(receipts(c), fn [id, body] ->
             String.ends_with?(id, ":completed") and body =~ "Task outcome recorded"
           end)

    assert Scheduler.schedule(c.mission).dispatches == []

    assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [item.dispatch.id]) == [
             1
           ]
  end
end
