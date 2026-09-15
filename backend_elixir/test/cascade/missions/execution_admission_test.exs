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
    %{user: user, vault: owner.vault_id, channel: channel.id, worker: worker, mission: mission.mission.id, task: task, old: old, binding: binding, policy: policy}
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
