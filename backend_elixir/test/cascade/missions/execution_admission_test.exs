defmodule Cascade.Missions.ExecutionAdmissionTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Missions.{ExecutionAdmission, RepositoryBinding, Scheduler, Store, Dispatches}

  setup do
    prior = Application.get_env(:cascade_elixir, :execution_admission)
    on_exit(fn -> Application.put_env(:cascade_elixir, :execution_admission, prior) end)
    owner = Cascade.TestHelpers.owner_vault("admission")
    user = %{id: owner.user_id, username: owner.username}
    channel = Cascade.Content.Store.create_note(owner.vault_id, user.id, %{title: "Scoped", content: "cascade://chat-channel"})
    {:ok, coordinator} = Agents.upsert_member(user.id, owner.vault_id, channel.id, %{agentId: "codex", mention: "coordinator", orchestrator: true})
    {:ok, worker} = Agents.upsert_member(user.id, owner.vault_id, channel.id, %{agentId: "codex", mention: "worker", yolo: false})
    {:ok, root} = Messages.create(user, owner.vault_id, channel.id, %{body: "Fixture only; no provider"})
    {:ok, mission} = Store.create(user.id, owner.vault_id, channel.id, %{rootMessageId: root.id, coordinatorRegistrationId: coordinator.id, title: "Scoped"}, control_plane: true)
    add = fn title ->
      {:ok, result} = Store.add_task(user.id, channel.id, mission.mission.id, %{title: title, assignee: worker.id, coordinatorRegistrationId: coordinator.id, purpose: "research", workspaceMode: "isolated"})
      result.task.id
    end
    task = add.("Admitted")
    old = add.("Unadmitted old task")
    binding = ExecutionAdmission.task_binding(task)
    policy = %{"version" => 1, "owners" => [%{"ownerId" => user.id, "maxConcurrent" => 2, "retainedRuns" => [], "tasks" => [binding]}]}
    %{user: user, vault: owner.vault_id, channel: channel.id, worker: worker, coordinator: coordinator, root: root, mission: mission.mission.id, task: task, old: old, binding: binding, policy: policy}
  end

  test "exact owner/vault/task/attempt bindings gate schedule and immutable original dispatch", c do
    Application.put_env(:cascade_elixir, :execution_admission, c.policy)
    assert ExecutionAdmission.task_allowed?(c.task)
    refute ExecutionAdmission.task_allowed?(c.old)
    assert {:ok, nil} = Store.claim_wake(c.mission)
    [item] = Scheduler.schedule(c.mission).dispatches
    assert item.message.missionTaskId == c.task
    assert ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    assert {:ok, _} = Dispatches.for_execution(item.dispatch.id)
    assert Scheduler.schedule(c.mission).dispatches == []
    SQL.exec("UPDATE chat_mission_tasks SET attempt=attempt+1 WHERE id=?", [c.task])
    refute ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    assert {:deferred, _} = Dispatches.for_execution(item.dispatch.id)
    refute Enum.any?(Dispatches.pending(), &(&1.id == item.dispatch.id))
    assert SQL.one("SELECT failed_at,run_id FROM chat_agent_dispatches WHERE id=?", [item.dispatch.id]) == [nil,nil]
  end

  test "future authentic owner requests and exact workflows advance without admitting old chat", c do
    [seq] = SQL.one("SELECT MAX(rowid) FROM chat_messages")
    policy = put_in(c.policy, ["owners", Access.at(0), "futureOwnerMessageAfterSeq"], seq)
    Application.put_env(:cascade_elixir, :execution_admission, policy)
    {:ok, old_dispatch} = Dispatches.create(c.user.id, c.channel, c.root, c.coordinator.id)
    refute ExecutionAdmission.dispatch_allowed?(old_dispatch.id)
    refute ExecutionAdmission.workflow_allowed?(c.mission)
    {:ok, message} = Messages.create(c.user, c.vault, c.channel, %{body: "New explicit owner request"})
    {:ok, dispatch} = Dispatches.create(c.user.id, c.channel, message, c.coordinator.id)
    assert ExecutionAdmission.dispatch_allowed?(dispatch.id)
    assert ExecutionAdmission.claim_allowed?(dispatch.id)
    {:ok, mission} = Store.create(c.user.id, c.vault, c.channel, %{rootMessageId: message.id, coordinatorRegistrationId: c.coordinator.id, title: "Future"}, control_plane: true)
    assert ExecutionAdmission.workflow_allowed?(mission.mission.id)
    assert ExecutionAdmission.mission_wake_allowed?(mission.mission.id)
    {:ok, task} = Store.add_task(c.user.id, c.channel, mission.mission.id, %{title: "Later research", assignee: c.worker.id, coordinatorRegistrationId: c.coordinator.id, purpose: "research", workspaceMode: "isolated"})
    assert ExecutionAdmission.task_allowed?(task.task.id)
    SQL.exec("UPDATE chat_messages SET agent_id='automation' WHERE id=?", [message.id])
    refute ExecutionAdmission.dispatch_allowed?(dispatch.id)
    refute ExecutionAdmission.task_allowed?(task.task.id)
    refute ExecutionAdmission.task_allowed?(c.old)
  end

  test "rejected review durably creates one correction and independent re-review, no repeated batches", c do
    workflow = %{"missionId" => c.mission, "vaultId" => c.vault, "channelId" => c.channel, "rootMessageId" => c.root.id}
    policy = put_in(c.policy, ["owners", Access.at(0), "workflows"], [workflow])
    Application.put_env(:cascade_elixir, :execution_admission, policy)
    SQL.exec("UPDATE chat_missions SET phase='executing' WHERE id=?", [c.mission])
    SQL.exec("UPDATE chat_mission_tasks SET purpose='implementation',status='completed' WHERE id=?", [c.task])
    {:ok, reviewer} = Agents.upsert_member(c.user.id, c.vault, c.channel, %{agentId: "codex", mention: "reviewer", yolo: false})
    {:ok, review} = Store.add_task(c.user.id, c.channel, c.mission, %{title: "Review", assignee: reviewer.id, coordinatorRegistrationId: c.coordinator.id, purpose: "review", workspaceMode: "isolated", dependsOn: [c.task]})
    {:ok, integration} = Store.add_task(c.user.id, c.channel, c.mission, %{title: "Integrate", assignee: c.worker.id, coordinatorRegistrationId: c.coordinator.id, purpose: "integration", workspaceMode: "isolated", dependsOn: [review.task.id]})
    SQL.exec("UPDATE chat_mission_tasks SET status='completed',review_outcome='changes_requested',summary='Fix crossing geometry' WHERE id=?", [review.task.id])
    config = Application.get_all_env(:cascade_elixir) |> :erlang.term_to_binary() |> Base.encode64()
    paths = :code.get_path() |> Enum.flat_map(&["-pa", to_string(&1)])
    script = Path.expand("../../support/progression_process_probe.exs", __DIR__)
    invoke = fn mode -> System.cmd(System.find_executable("elixir"), paths ++ [script, config, c.mission, mode], env: [{"ERL_FLAGS", "+S 2:2"}], stderr_to_stdout: true) end
    {output, code} = invoke.("rollback")
    assert code == 23, output
    assert SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=? AND purpose='fix'", [c.mission]) == [0]
    {output, code} = invoke.("commit")
    assert code == 24, output
    {output, code} = invoke.("restart")
    assert code == 0, output
    [[fix, implementer]] = SQL.all("SELECT id,assignee_registration_id FROM chat_mission_tasks WHERE mission_id=? AND purpose='fix'", [c.mission])
    assert implementer == c.worker.id
    [[check, ^fix, reviewer_id]] = SQL.all("SELECT t.id,d.value,t.assignee_registration_id FROM chat_mission_tasks t JOIN json_each(t.depends_on_json) d WHERE t.mission_id=? AND t.title LIKE 'Re-review %'", [c.mission])
    assert reviewer_id == reviewer.id
    assert SQL.one("SELECT depends_on_json FROM chat_mission_tasks WHERE id=?", [integration.task.id]) == [Jason.encode!([check])]
    before = SQL.all("SELECT id,dispatch_id,depends_on_json FROM chat_mission_tasks WHERE mission_id=? ORDER BY id", [c.mission])
    for _ <- 1..3, do: SQL.transaction(fn -> Cascade.Missions.Progression.reconcile(c.mission) end)
    assert before == SQL.all("SELECT id,dispatch_id,depends_on_json FROM chat_mission_tasks WHERE mission_id=? ORDER BY id", [c.mission])
    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='automatic_review_repair'", [c.mission]) == [1]
    assert ExecutionAdmission.task_allowed?(fix)
    SQL.exec("UPDATE chat_mission_tasks SET status='completed' WHERE id=?", [fix])
    SQL.exec("UPDATE chat_mission_tasks SET status='completed',review_outcome='changes_requested' WHERE id=?", [check])
    SQL.transaction(fn -> Cascade.Missions.Progression.reconcile(c.mission) end)
    [[second_fix, second_check]] = SQL.all("SELECT f.id,r.id FROM chat_mission_tasks f JOIN chat_mission_tasks r ON r.depends_on_json=json_array(f.id) WHERE f.mission_id=? AND f.purpose='fix' AND f.depends_on_json=json_array(?)", [c.mission, check])
    SQL.exec("UPDATE chat_mission_tasks SET status='completed' WHERE id=?", [second_fix])
    SQL.exec("UPDATE chat_mission_tasks SET status='completed',review_outcome='changes_requested' WHERE id=?", [second_check])
    for _ <- 1..2, do: SQL.transaction(fn -> Cascade.Missions.Progression.reconcile(c.mission) end)
    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='automatic_review_repair'", [c.mission]) == [2]
    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='automatic_review_repair_exhausted'", [c.mission]) == [1]
    Cascade.Missions.Notifications.reconcile(c.mission, fn _ -> :ok end)
    assert [[body]] = SQL.all("SELECT body FROM chat_messages WHERE id=?", ["task-notification:#{second_check}:0:repair-exhausted"])
    assert body =~ "Request remains blocked"
    assert SQL.one("SELECT COUNT(*) FROM runs WHERE owner_user_id=?", [c.user.id]) == [0]
    SQL.exec("UPDATE chat_missions SET status='canceled' WHERE id=?", [c.mission])
    assert Scheduler.schedule(c.mission).dispatches == []
  end

  test "research completion advances the original dependency despite quiet coordinator acknowledgment", c do
    workflow = %{"missionId" => c.mission, "vaultId" => c.vault, "channelId" => c.channel, "rootMessageId" => c.root.id}
    Application.put_env(:cascade_elixir, :execution_admission, put_in(c.policy, ["owners", Access.at(0), "workflows"], [workflow]))
    SQL.exec("UPDATE chat_missions SET phase='executing' WHERE id=?", [c.mission])
    SQL.exec("UPDATE chat_mission_tasks SET status='canceled' WHERE id=?", [c.old])
    {:ok, next} = Store.add_task(c.user.id, c.channel, c.mission, %{title: "Implement original research", assignee: c.worker.id, coordinatorRegistrationId: c.coordinator.id, purpose: "implementation", workspaceMode: "isolated", dependsOn: [c.task]})
    assert Enum.all?(Store.schedulable(c.mission).candidates, &(&1.taskId != next.task.id))
    {:ok, _} = Store.update_task(c.user.id, c.channel, c.task, %{status: "completed", summary: "Research evidence, not delivered implementation"})
    {:ok, held} = Dispatches.create(c.user.id, c.channel, c.root, c.coordinator.id)
    refute ExecutionAdmission.dispatch_allowed?(held.id)
    scheduled = Scheduler.schedule(c.mission)
    [item] = scheduled.dispatches
    assert item.message.missionTaskId == next.task.id
    [wake] = scheduled.wakeDispatches
    assert ExecutionAdmission.dispatch_allowed?(wake.dispatch.id)
    assert {:ok, _} = Dispatches.for_execution(wake.dispatch.id)
    {:ok, run} = Cascade.Runs.Store.start(c.vault, nil, "Inert coordinator", "codex", owner_user_id: c.user.id, chat_dispatch_id: wake.dispatch.id, conversation_id: wake.dispatch.conversationId)
    :ok = Dispatches.attach_run(wake.dispatch.id, run.id)
    {:ok, current} = Cascade.Missions.Interpretation.get(c.user.id, c.channel, c.mission, c.coordinator.id)
    assert {:ok, %{messageId: nil}} = Cascade.Missions.Interpretation.record(c.user, c.channel, c.mission, c.coordinator.id, %{"revision" => current.revision, "fingerprint" => current.fingerprint, "noMaterialChange" => true}, run.id, Cascade.Chat.Events.Noop)
    assert ExecutionAdmission.run_allowed?(run.id, c.user.id)
    assert Scheduler.schedule(c.mission).dispatches == []
    assert SQL.one("SELECT dispatch_id,status FROM chat_mission_tasks WHERE id=?", [next.task.id]) == [item.dispatch.id, "pending"]
    assert ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    refute SQL.one("SELECT status FROM chat_missions WHERE id=?", [c.mission]) == ["completed"]
  end

  test "qualification start budget is durable and does not block future owner messages", c do
    [seq] = SQL.one("SELECT MAX(rowid) FROM chat_messages")
    workflow = %{"missionId" => c.mission, "vaultId" => c.vault, "channelId" => c.channel, "rootMessageId" => c.root.id}
    owner = c.policy["owners"] |> hd() |> Map.merge(%{"workflows" => [workflow], "futureOwnerMessageAfterSeq" => seq, "qualificationBudget" => %{"afterRunId" => 0, "maxStarts" => 1}})
    Application.put_env(:cascade_elixir, :execution_admission, %{"version" => 1, "owners" => [owner]})
    item = Scheduler.schedule(c.mission).dispatches |> hd()
    assert ExecutionAdmission.claim_allowed?(item.dispatch.id)
    {:ok, run} = Cascade.Runs.Store.start(c.vault, nil, "Inert budget fixture", "codex", owner_user_id: c.user.id, chat_dispatch_id: item.dispatch.id)
    Cascade.Runs.Store.finish(run.id, "completed", "Inert fixture")
    refute ExecutionAdmission.claim_allowed?(item.dispatch.id)
    assert ExecutionAdmission.run_allowed?(run.id, c.user.id)
    {:ok, message} = Messages.create(c.user, c.vault, c.channel, %{body: "New owner instruction"})
    {:ok, dispatch} = Dispatches.create(c.user.id, c.channel, message, c.coordinator.id)
    assert ExecutionAdmission.claim_allowed?(dispatch.id)
  end

  test "repository binding is atomic, exact snapshot guarded and SELECT-only preview", c do
    Application.put_env(:cascade_elixir, :execution_admission, c.policy)
    SQL.exec("PRAGMA query_only=ON")
    try do
      assert {:ok, %{contract: "repository_binding_atomic_v1"}} = RepositoryBinding.preview(c.user.id, c.binding["workItemId"])
    after
      SQL.exec("PRAGMA query_only=OFF")
    end
    {:ok, preview} = RepositoryBinding.preview(c.user.id, c.binding["workItemId"])
    SQL.exec("UPDATE chat_agent_members SET model='changed' WHERE id=?", [c.worker.id])
    assert {:error, _} = RepositoryBinding.bind(c.user.id, c.binding["workItemId"], %{"repository" => "/fixture/repository", "expectedRevision" => preview.revision})
    assert SQL.one("SELECT repository FROM work_items WHERE id=?", [c.binding["workItemId"]]) == [""]
    {:ok, fresh} = RepositoryBinding.preview(c.user.id, c.binding["workItemId"])
    assert {:ok, item} = RepositoryBinding.bind(c.user.id, c.binding["workItemId"], %{"repository" => "/fixture/repository", "expectedRevision" => fresh.revision})
    assert item.repository == "/fixture/repository"
    assert {:error, _} = RepositoryBinding.bind(c.user.id, item.id, %{"repository" => "/different", "expectedRevision" => fresh.revision})
    assert item.runIds == []
  end

  test "cross-vault and identity edits cannot reuse a grant; explicit repository readiness does not widen task admission", c do
    entry = Map.put(c.binding, "requireRepository", "/fixture/repository")
    policy = put_in(c.policy, ["owners", Access.at(0), "tasks"], [entry])
    Application.put_env(:cascade_elixir, :execution_admission, policy)
    [item] = Scheduler.schedule(c.mission).dispatches
    refute ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    {:ok, preview} = RepositoryBinding.preview(c.user.id, c.binding["workItemId"])
    {:ok, _} = RepositoryBinding.bind(c.user.id, c.binding["workItemId"], %{"repository" => "/fixture/repository", "expectedRevision" => preview.revision})
    assert ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    SQL.exec("UPDATE chat_agent_members SET yolo=1 WHERE id=?", [c.worker.id])
    refute ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
    SQL.exec("UPDATE chat_agent_members SET yolo=0 WHERE id=?", [c.worker.id])
    changed = put_in(policy, ["owners", Access.at(0), "tasks", Access.at(0), "vaultId"], "wrong-vault")
    Application.put_env(:cascade_elixir, :execution_admission, changed)
    refute ExecutionAdmission.dispatch_allowed?(item.dispatch.id)
  end
end
