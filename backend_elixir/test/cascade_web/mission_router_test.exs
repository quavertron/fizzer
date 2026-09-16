defmodule CascadeWeb.MissionRouterTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test
  import Cascade.TestHelpers

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Store}
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

  test "route catalog exposes the complete Node contract" do
    assert CascadeWeb.MissionRoutes.catalog() == [
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/agent-dispatches/pending"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/history"},
             {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id"},
             {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/tasks"},
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

    assert finished.status == 400
    assert json(finished)["error"] == "Mission has no completed worker evidence"
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
