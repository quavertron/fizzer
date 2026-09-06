defmodule CascadeWeb.MissionRouterTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test
  import Cascade.TestHelpers

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Runs.Store, as: RunStore

  setup do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 800_000
    username = "mission_http_#{suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [user_id, username, "x", username]
    )

    vault = ContentStore.create_vault(user_id, %{name: "Mission HTTP #{suffix}"})

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
        title: "Mission HTTP room",
        content: "cascade://chat-channel"
      })

    {:ok, coordinator_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-http-#{suffix}",
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
        mention: "terra-http-#{suffix}",
        model: "gpt-5.6-terra"
      })

    {:ok, worker} = Agents.add_to_channel(user_id, vault.id, channel.id, worker_identity.id)
    user = %{id: user_id, username: username, auth_version: 0}

    {:ok, root} =
      Messages.create(user, vault.id, channel.id, %{
        id: "mission-http-root-#{suffix}",
        body: "Exercise every mission route.",
        createdAt: "2026-08-10T13:00:00.000Z"
      })

    %{
      user: user,
      vault: vault,
      channel: channel,
      root: root,
      coordinator: coordinator,
      worker: worker,
      token: Token.sign_user(user)
    }
  end

  test "a worker reads its current mission instead of filtering itself as coordinator", ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Worker context"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Worker",
        assignee: ctx.worker.id
      })

    {:ok, run} = RunStore.start(ctx.vault.id, nil, "Worker", "codex", owner_user_id: ctx.user.id)
    SQL.exec("UPDATE chat_mission_tasks SET run_id=? WHERE id=?", [run.id, added.task.id])
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions"
    query = "?coordinator=#{ctx.worker.id}"
    status = request(ctx, :get, base <> "/current" <> query, nil, run.id)
    assert status.status == 200
    assert json(status)["mission"]["id"] == created.mission.id
    listed = request(ctx, :get, base <> query, nil, run.id)
    assert Enum.map(json(listed)["missions"], & &1["id"]) == [created.mission.id]
    compact = request(ctx, :get, base <> query <> "&view=compact", nil, run.id)
    assert [mission] = json(compact)["missions"]
    assert mission["id"] == created.mission.id
    refute Map.has_key?(mission, "authority")
    SQL.exec("UPDATE runs SET owner_user_id=NULL WHERE id=?", [run.id])
    assert request(ctx, :get, base <> "/current" <> query, nil, run.id).status == 404
    assert json(request(ctx, :get, base <> query, nil, run.id))["missions"] == []

    assert json(request(ctx, :get, base <> query <> "&view=compact", nil, run.id))["missions"] ==
             []
  end

  test "compact list filters in the store and keeps the legacy detail contract", ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Ownership"
      })

    {:ok, first} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Deliver",
        assignee: ctx.worker.id
      })

    {:ok, second} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Historical",
        assignee: ctx.worker.id
      })

    SQL.exec("UPDATE chat_mission_tasks SET status='completed',summary=? WHERE id=?", [
      String.duplicate("large history", 1000),
      second.task.id
    ])

    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions"
    response = request(ctx, :get, base <> "?view=compact")
    assert response.status == 200
    assert [mission] = json(response)["missions"]

    assert Enum.sort(Map.keys(mission)) ==
             Enum.sort(~w(id title status coordinatorRegistrationId coordinatorMention tasks))

    assert mission["coordinatorRegistrationId"] == ctx.coordinator.id
    assert [task] = mission["tasks"]
    assert task["id"] == first.task.id
    assert task["assigneeRegistrationId"] == ctx.worker.id
    assert task["assigneeMention"] == ctx.worker.mention

    assert Enum.sort(Map.keys(task)) ==
             Enum.sort(~w(id title status assigneeRegistrationId assigneeMention))

    assert byte_size(response.resp_body) < 1500
    assert json(request(ctx, :get, base <> "?view=compact&status=completed"))["missions"] == []

    assert [filtered] =
             json(request(ctx, :get, base <> "?view=compact&taskStatus=completed"))["missions"]

    assert Enum.map(filtered["tasks"], & &1["id"]) == [second.task.id]

    assert [all] =
             json(request(ctx, :get, base <> "?view=compact&status=all&taskStatus=all"))[
               "missions"
             ]

    assert length(all["tasks"]) == 2
    assert json(request(ctx, :get, base <> "?view=compact&coordinator=other"))["missions"] == []

    for query <- ["status=typo", "taskStatus=active", "status=%27", "status=%2C"] do
      assert request(ctx, :get, base <> "?view=compact&" <> query).status == 400
    end

    assert [detail] = json(request(ctx, :get, base))["missions"]
    assert Map.has_key?(detail, "objective")
    assert Enum.any?(detail["tasks"], &(byte_size(&1["summary"]) > 1000))
    stranger = %{ctx | token: Token.sign_user(%{ctx.user | id: ctx.user.id + 999_999})}
    assert request(stranger, :get, base <> "?view=compact").status in [401, 403, 404]
  end

  test "worker HTTP progress stays quiet and explicit findings use the same authorized update",
       ctx do
    {:ok, created} =
      Store.create(
        ctx.user.id,
        ctx.vault.id,
        ctx.channel.id,
        %{
          rootMessageId: ctx.root.id,
          coordinatorRegistrationId: ctx.coordinator.id,
          title: "Continuous worker"
        },
        control_plane: true
      )

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Implement and ship",
        assignee: ctx.worker.id
      })

    [worker] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Worker", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: worker.dispatch.id
      )

    :ok = Dispatches.attach_run(worker.dispatch.id, run.id)
    {:ok, _} = Store.attach_run(worker.dispatch.id, run.id)
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}

    path =
      "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions/tasks/#{added.task.id}"

    assert request(ctx, :patch, path, %{status: "running", summary: "Build passes"}, run.id).status ==
             200

    assert SQL.one("SELECT dispatch_id FROM chat_mission_interpretations WHERE mission_id=?", [
             created.mission.id
           ]) == [nil]

    assert request(
             ctx,
             :patch,
             path,
             %{status: "running", summary: "Scope decision needed", finding: true},
             run.id
           ).status == 200

    assert [dispatch] =
             SQL.one("SELECT dispatch_id FROM chat_mission_interpretations WHERE mission_id=?", [
               created.mission.id
             ])

    assert is_binary(dispatch)

    assert SQL.one(
             "SELECT summary FROM chat_mission_events WHERE task_id=? AND kind='task_finding'",
             [added.task.id]
           ) == ["Scope decision needed"]
  end

  test "route catalog exposes the complete Node contract" do
    assert CascadeWeb.MissionRoutes.catalog() == [
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/agent-dispatches/pending"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/history"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/continuation"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/continuation"},
             {"GET",
              "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/interpretation"},
             {"POST",
              "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/interpretation"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/tasks"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/children"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/children/join"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id/steer"},
             {"PATCH", "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id"},
             {"POST",
              "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id/recovery-evidence"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/finish"}
           ]
  end

  test "create, list, get, delegate, pending dispatch, update, history, and finish preserve response shapes",
       ctx do
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    created =
      request(ctx, :post, base <> "/missions", %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "HTTP mission",
        objective: "Port the complete contract."
      })

    assert created.status == 201
    %{"mission" => mission} = json(created)
    assert mission["status"] == "active"
    assert mission["tasks"] == []

    listed = request(ctx, :get, base <> "/missions")
    assert listed.status == 200
    assert [listed_mission] = json(listed)["missions"]
    assert listed_mission["id"] == mission["id"]

    fetched = request(ctx, :get, base <> "/missions/current?coordinator=#{ctx.coordinator.id}")
    assert fetched.status == 200
    assert json(fetched)["mission"]["id"] == mission["id"]

    delegated =
      request(ctx, :post, base <> "/missions/#{mission["id"]}/tasks", %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Implement HTTP parity",
        assignee: ctx.worker.id,
        prompt: "Implement and report evidence.",
        reasoningEffort: "high"
      })

    assert delegated.status == 201
    delegated_body = json(delegated)
    assert delegated_body["scheduled"] == true
    assert delegated_body["message"]["missionTaskId"] == delegated_body["task"]["id"]

    pending = request(ctx, :get, base <> "/agent-dispatches/pending")
    assert pending.status == 200
    assert [dispatch] = json(pending)["dispatches"]
    assert dispatch["messageId"] == delegated_body["message"]["id"]
    assert dispatch["reasoningEffort"] == "high"

    assert Enum.any?(Cascade.Missions.Dispatches.pending(), &(&1.id == dispatch["id"]))

    completed =
      request(
        ctx,
        :patch,
        base <> "/missions/tasks/#{delegated_body["task"]["id"]}",
        %{status: "completed", summary: "Evidence recorded."}
      )

    assert completed.status == 200
    assert json(completed)["mission"]["status"] == "attention"

    history = request(ctx, :get, base <> "/missions/#{mission["id"]}/history")
    assert history.status == 200
    kinds = Enum.map(json(history)["events"], & &1["kind"])

    assert kinds ==
             ~w(mission_created task_added task_dispatched task_status_changed mission_status_changed)

    finished =
      request(ctx, :post, base <> "/missions/#{mission["id"]}/finish", %{
        coordinatorRegistrationId: ctx.coordinator.id,
        status: "completed",
        summary: "Integrated and verified."
      })

    assert finished.status == 200
    assert json(finished)["mission"]["status"] == "completed"
  end

  test "authentication, channel privacy, and mutation errors fail closed", ctx do
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    unauthorized =
      conn(:get, base <> "/missions")
      |> CascadeWeb.MissionRouter.call(CascadeWeb.MissionRouter.init([]))

    assert unauthorized.status == 401
    assert json(unauthorized) == %{"error" => "Invalid or expired token"}

    missing_channel =
      request(ctx, :get, "/api/vaults/#{ctx.vault.id}/channels/missing/missions")

    assert missing_channel.status == 404
    assert json(missing_channel) == %{"error" => "Chat channel not found"}

    invalid =
      request(ctx, :post, base <> "/missions", %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: ""
      })

    assert invalid.status == 400
    assert json(invalid) == %{"error" => "Mission title is required"}
  end

  test "a worker run cannot start or delegate nested missions", ctx do
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    created =
      request(ctx, :post, base <> "/missions", %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Parent mission",
        controlPlane: true
      })

    assert created.status == 201
    mission_id = json(created)["mission"]["id"]

    delegated =
      request(ctx, :post, base <> "/missions/#{mission_id}/tasks", %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Execute parent work",
        assignee: ctx.coordinator.id,
        anonymous: true
      })

    assert delegated.status == 201
    task_id = json(delegated)["task"]["id"]
    {:ok, pending} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)
    dispatch = Enum.find(pending, &(&1.message[:missionTaskId] == task_id))
    assert dispatch

    {:ok, worker_run} =
      RunStore.start(ctx.vault.id, nil, "worker clone", "codex",
        conversation_id: "http-worker-#{task_id}",
        chat_dispatch_id: dispatch.id
      )

    :ok = Dispatches.attach_run(dispatch.id, worker_run.id)
    {:ok, _} = Store.attach_run(dispatch.id, worker_run.id)

    nested =
      request(
        ctx,
        :post,
        base <> "/missions",
        %{
          rootMessageId: ctx.root.id,
          coordinatorRegistrationId: ctx.coordinator.id,
          title: "Worker clone",
          controlPlane: true
        },
        worker_run.id
      )

    assert nested.status == 400
    assert json(nested) == %{"error" => "Mission workers cannot start or delegate missions"}

    nested_task =
      request(
        ctx,
        :post,
        base <> "/missions/#{mission_id}/tasks",
        %{
          coordinatorRegistrationId: ctx.coordinator.id,
          title: "Another clone",
          assignee: ctx.coordinator.id,
          anonymous: true
        },
        worker_run.id
      )

    assert nested_task.status == 400
    assert json(nested_task) == %{"error" => "Mission workers cannot start or delegate missions"}

    rejected =
      request(
        ctx,
        :post,
        base <> "/missions/tasks/#{task_id}/recovery-evidence",
        %{
          coordinatorRegistrationId: ctx.coordinator.id,
          sourceTaskId: task_id,
          objective: "Exercise every mission route.",
          verification: "Claimed evidence"
        },
        worker_run.id
      )

    assert rejected.status == 400
    assert json(rejected)["error"] == "Mission workers cannot finish the mission"
  end

  test "worker HTTP child and join routes preserve identity and reject cross-task updates", ctx do
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}
    base = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}"

    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Children"
      })

    {:ok, parent} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        assignee: ctx.worker.id,
        title: "Parent"
      })

    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "parent", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)

    response =
      request(
        ctx,
        :post,
        base <> "/missions/current/children",
        %{
          title: "HTTP child",
          prompt: "Bounded work",
          assignee: ctx.coordinator.id,
          workspaceMode: "shared"
        },
        run.id
      )

    assert response.status == 201
    child = json(response)["task"]
    assert child["parentTaskId"] == parent.task.id
    assert child["workspaceMode"] == "isolated"
    assert child["assigneeMention"] == ctx.worker.mention <> "·sub"

    assert request(ctx, :post, base <> "/missions/current/children", %{title: "No run"}).status ==
             400

    assert request(
             ctx,
             :post,
             base <> "/missions/another-mission/children",
             %{title: "Wrong mission"},
             run.id
           ).status == 400

    other_channel =
      ContentStore.create_note(ctx.vault.id, ctx.user.id, %{
        title: "Other room",
        content: "cascade://chat-channel"
      })

    other_base = "/api/vaults/#{ctx.vault.id}/channels/#{other_channel.id}"
    other_id = ctx.user.id + 10_000_000

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,'','',0)",
      [other_id, "other_#{other_id}", "x"]
    )

    foreign = %{
      ctx
      | token: Token.sign_agent(%{id: other_id, username: "other_#{other_id}", auth_version: 0})
    }

    for endpoint <- ["current/children", "children/join"] do
      assert request(
               ctx,
               :post,
               other_base <> "/missions/" <> endpoint,
               %{title: "Wrong channel"},
               run.id
             ).status == 400

      assert request(ctx, :post, base <> "/missions/" <> endpoint, %{title: "Missing run"}).status ==
               400

      assert request(
               ctx,
               :post,
               base <> "/missions/" <> endpoint,
               %{title: "Unknown run"},
               999_999_999
             ).status == 400

      assert request(
               foreign,
               :post,
               base <> "/missions/" <> endpoint,
               %{title: "Foreign owner"},
               run.id
             ).status in [400, 403, 404]
    end

    joined = request(ctx, :post, base <> "/missions/children/join", %{}, run.id)
    assert joined.status == 200
    assert hd(json(joined)["children"])["id"] == child["id"]

    [child_dispatch_id] =
      SQL.one("SELECT dispatch_id FROM chat_mission_tasks WHERE id=?", [child["id"]])

    {:ok, child_run} =
      RunStore.start(ctx.vault.id, nil, "child", "codex", chat_dispatch_id: child_dispatch_id)

    :ok = Dispatches.attach_run(child_dispatch_id, child_run.id)
    {:ok, _} = Store.attach_run(child_dispatch_id, child_run.id)

    assert request(
             ctx,
             :post,
             base <> "/missions/current/children",
             %{title: "Recursive child"},
             child_run.id
           ).status == 400

    child_join = request(ctx, :post, base <> "/missions/children/join", %{}, child_run.id)
    assert json(child_join)["children"] == []
    :ok = RunStore.finish(child_run.id, "completed", "Child HTTP artifact verified")
    {:ok, _} = Scheduler.settle_run(child_run.id, "completed", "Child HTTP artifact verified")
    result = request(ctx, :post, base <> "/missions/children/join", %{}, run.id)

    assert [
             %{
               "id" => result_id,
               "status" => "completed",
               "summary" => "Child HTTP artifact verified"
             }
           ] = json(result)["children"]

    assert result_id == child["id"]

    assert request(
             ctx,
             :patch,
             base <> "/missions/tasks/#{parent.task.id}",
             %{status: "completed"},
             run.id
           ).status == 400

    {:ok, unrelated} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        assignee: ctx.worker.id,
        title: "Other task"
      })

    assert request(
             ctx,
             :patch,
             base <> "/missions/tasks/#{unrelated.task.id}",
             %{status: "canceled"},
             run.id
           ).status == 400

    {:ok, coordinator_message} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{body: "Coordinator update"})

    {:ok, coordinator_dispatch} =
      Dispatches.create(ctx.user.id, ctx.channel.id, coordinator_message, ctx.coordinator.id)

    {:ok, coordinator_run} =
      RunStore.start(ctx.vault.id, nil, "coordinator", "codex",
        chat_dispatch_id: coordinator_dispatch.id
      )

    assert request(
             ctx,
             :patch,
             base <> "/missions/tasks/#{unrelated.task.id}",
             %{status: "canceled"},
             coordinator_run.id
           ).status == 200
  end

  test "steering HTTP route pins the task snapshot and acknowledges queued delivery", ctx do
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}

    {:ok, mission} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Steer HTTP"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, mission.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        assignee: ctx.worker.id,
        title: "Queued work"
      })

    path =
      "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions/tasks/#{added.task.id}/steer"

    input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      message: "Narrow the work.",
      attempt: 4,
      runId: nil
    }

    {:ok, worker_run} = RunStore.start(ctx.vault.id, nil, "Worker", "codex")
    SQL.exec("UPDATE chat_mission_tasks SET run_id=? WHERE id=?", [worker_run.id, added.task.id])
    rejected = request(ctx, :post, path, input, worker_run.id)
    assert rejected.status == 409
    assert json(rejected)["error"] == "Mission workers cannot steer other workers"
    SQL.exec("UPDATE chat_mission_tasks SET run_id=NULL WHERE id=?", [added.task.id])
    assert request(ctx, :post, path, input).status == 409
    response = request(ctx, :post, path, %{input | attempt: 0})
    assert response.status == 202
    assert json(response)["steering"]["status"] == "queued"
    assert [prompt] = SQL.one("SELECT prompt FROM chat_mission_tasks WHERE id=?", [added.task.id])
    assert prompt =~ "Narrow the work."
  end

  test "interpretation is available to its live coordinator, atomically publishes, and rejects workers and foreign scope",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Interpret HTTP"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Worker",
        assignee: ctx.worker.id
      })

    {:ok, _} =
      Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
        status: "blocked",
        summary: "Changed blocker"
      })

    [wake] = Scheduler.schedule(created.mission.id).wakeDispatches

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Interpret", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: wake.dispatch.id
      )

    :ok = Dispatches.attach_run(wake.dispatch.id, run.id)
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}

    path =
      "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions/#{created.mission.id}/interpretation"

    response = request(ctx, :get, path <> "?coordinator=#{ctx.coordinator.id}", nil, run.id)
    assert response.status == 200
    state = json(response)

    input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      revision: state["revision"],
      fingerprint: state["fingerprint"],
      assessment: "Blocked; delivery remains open",
      body: "The blocker changed; the worker is still independent."
    }

    assert request(ctx, :post, path, input).status == 409

    assert request(ctx, :post, path, %{input | coordinatorRegistrationId: ctx.worker.id}, run.id).status ==
             409

    posted = request(ctx, :post, path, input, run.id)
    assert posted.status == 200
    assert request(ctx, :post, path, input, run.id).resp_body == posted.resp_body
    {:ok, message} = Messages.get(ctx.channel.id, ctx.user.id, json(posted)["messageId"])
    assert message.body == input.body
    assert message.registrationId == ctx.coordinator.id
    SQL.exec("UPDATE chat_mission_tasks SET run_id=? WHERE id=?", [run.id, added.task.id])
    assert request(ctx, :post, path, input, run.id).status == 409
  end

  test "continuation HTTP checkpoints require a live owning coordinator and current revision",
       ctx do
    {:ok, dispatch} = Dispatches.create(ctx.user.id, ctx.channel.id, ctx.root, ctx.coordinator.id)

    {:ok, run} =
      RunStore.start(ctx.vault.id, nil, "Coordinate", "codex",
        owner_user_id: ctx.user.id,
        chat_dispatch_id: dispatch.id,
        conversation_id: dispatch.conversationId
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    ctx = %{ctx | token: Token.sign_agent(ctx.user)}
    path = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/continuation"
    assert request(ctx, :get, path).status == 404
    response = request(ctx, :get, path, nil, run.id)
    assert response.status == 200

    input = %{
      revision: json(response)["revision"],
      status: "waiting",
      summary: "Worker already owns delivery"
    }

    assert request(ctx, :post, path, input).status == 409
    assert request(ctx, :post, path, input, run.id).status == 200
    assert request(ctx, :post, path, input, run.id).status == 409
    RunStore.finish(run.id, "completed", "Waiting")
    assert request(ctx, :post, path, %{input | revision: 1}, run.id).status == 409
  end

  defp request(ctx, method, path, body \\ nil, run_id \\ nil) do
    json_conn(method, path, body, ctx.token)
    |> maybe_run_id(run_id)
    |> CascadeWeb.MissionRouter.call(CascadeWeb.MissionRouter.init([]))
  end

  defp maybe_run_id(conn, run_id) when is_integer(run_id) and run_id > 0,
    do: put_req_header(conn, "x-cascade-run-id", Integer.to_string(run_id))

  defp maybe_run_id(conn, _run_id), do: conn

  defp json(conn), do: Jason.decode!(conn.resp_body)
end
