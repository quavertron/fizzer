defmodule CascadeWeb.OrchestrationChatDispatchTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Dispatches
  alias Cascade.Realtime.{Hub, Session}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}
  alias Cascade.Runs.Store

  setup do
    suffix = System.unique_integer([:positive])
    owner = user!(900_000 + suffix, "dispatch_owner_#{suffix}")
    guest = user!(1_900_000 + suffix, "dispatch_guest_#{suffix}")
    owner_vault = ContentStore.create_vault(owner.id, %{name: "Owner #{suffix}"})
    guest_vault = ContentStore.create_vault(guest.id, %{name: "Guest #{suffix}"})

    owner_channel =
      ContentStore.create_note(owner_vault.id, owner.id, %{
        title: "Owner room",
        content: "cascade://chat-channel"
      })

    guest_channel =
      ContentStore.create_note(guest_vault.id, guest.id, %{
        title: "Guest projection",
        content: "cascade://chat-channel"
      })

    assert {:ok, _route} =
             Channel.link(
               owner_vault.id,
               owner_channel.id,
               guest_vault.id,
               guest_channel.id,
               guest.id
             )

    {:ok, identity} =
      Agents.upsert_identity(owner.id, owner_vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-#{suffix}",
        model: "gpt-5.6-sol",
        cwd: "/owner/registration"
      })

    {:ok, registration} =
      Agents.add_to_channel(owner.id, owner_vault.id, owner_channel.id, identity.id, %{
        reasoningEffort: "high",
        priorityServiceTier: true,
        pingableByOthers: true,
        yolo: true,
        conversationId: "owner-conversation-#{suffix}"
      })

    assert {:ok, %{cwd: "/owner/channel"}} =
             Channel.update_settings(owner_channel.id, owner.id, %{cwd: "/owner/channel"})

    {:ok, source_message} =
      Messages.create(guest, guest_vault.id, guest_channel.id, %{
        id: "dispatch-source-#{suffix}",
        body: "@#{registration.mention} finish the owner-side work"
      })

    sid = "chat-dispatch-runner-#{suffix}"

    {:ok, ^sid, session_pid} =
      Cascade.Realtime.start_session(sid: sid, domain: Cascade.Realtime.DomainAdapter)

    assert {:ok, _open_packet} = Session.poll(sid, 1_000)
    connect_runner!(sid, Token.sign_user(owner))
    assert {:ok, _connect_packet} = Session.poll(sid, 1_000)
    register_runner!(sid)
    assert {:ok, registered_packet} = Session.poll(sid, 1_000)
    assert registered_packet =~ "runner:registered"

    on_exit(fn ->
      Hub.unregister_runner(owner.id, sid)

      if Process.alive?(session_pid) do
        DynamicSupervisor.terminate_child(Cascade.Realtime.SessionSupervisor, session_pid)
      end

      SQL.exec("DELETE FROM vaults WHERE id IN (?,?)", [owner_vault.id, guest_vault.id])
      SQL.exec("DELETE FROM users WHERE id IN (?,?)", [owner.id, guest.id])
      File.rm_rf!(owner_vault.root_path)
      File.rm_rf!(guest_vault.root_path)
    end)

    {:ok, dispatch} =
      Dispatches.create(guest.id, guest_channel.id, source_message, registration.id,
        reasoning_effort: "max"
      )

    %{
      owner: owner,
      guest: guest,
      owner_vault: owner_vault,
      guest_vault: guest_vault,
      owner_channel: owner_channel,
      guest_channel: guest_channel,
      registration: registration,
      dispatch: dispatch,
      sid: sid
    }
  end

  test "coordinator reviews are claimed without a chat page and repeated claims reuse the run",
       ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1 WHERE id=?", [ctx.registration.id])

    {:ok, root} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: "review-root-#{ctx.registration.id}",
        body: "Finish the task"
      })

    {:ok, mission} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Review without UI"
      })

    {:ok, added} =
      Cascade.Missions.Store.add_task(ctx.owner.id, ctx.owner_channel.id, mission.mission.id, %{
        coordinatorRegistrationId: ctx.registration.id,
        assignee: ctx.registration.id,
        anonymous: true,
        title: "Worker"
      })

    {:ok, _} =
      Cascade.Missions.Store.update_task(ctx.owner.id, ctx.owner_channel.id, added.task.id, %{
        status: "failed",
        summary: "Needs review"
      })

    Cascade.Missions.Scheduler.schedule(mission.mission.id)

    [dispatch_id, _run_id] =
      SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{mission.mission.id}-%"
      ])

    # A conversational follow-up must not erase the durable review before
    # the headless runner claims it.
    {:ok, followup} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        body: "@#{ctx.registration.mention} is it running?"
      })

    assert {:ok, [_]} =
             Dispatches.create_for_message(ctx.owner.id, ctx.owner_channel.id, followup)

    assert {:ok, started} = CascadeWeb.OrchestrationController.execute_dispatch(dispatch_id)
    run = Store.get(started.id)

    assert {:ok, duplicate} =
             CascadeWeb.OrchestrationController.execute_dispatch(dispatch_id)

    assert duplicate.id == run.id
    assert Store.get(run.id).prompt =~ "include --verification when useful"

    assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [dispatch_id]) == [
             1
           ]

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [
             mission.mission.id
           ]) == [1]
  end

  test "headless admission starts on the owner's projection; HTTP cannot override or duplicate",
       ctx do
    delegate = event!(ctx.sid, "run:delegate")
    run = Store.find_by_chat_dispatch(ctx.dispatch.id)
    assert run.vault_id == ctx.owner_vault.id
    assert run.agent == "codex"
    assert run.model == "gpt-5.6-sol"
    assert run.conversation_id == ctx.registration.conversationId
    assert delegate["chatChannelId"] == ctx.owner_channel.id
    assert delegate["cwd"] == "/owner/channel"
    refute delegate["yolo"]
    assert delegate["prompt"] =~ "finish the owner-side work"
    assert delegate["prompt"] =~ "Shared room state"

    response =
      request(ctx, %{
        prompt: "attacker prompt",
        agent: "hermes",
        cwd: "/guest/override",
        conversation_id: "attacker-session",
        chatDispatchId: ctx.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "attacker-shell"}
      })

    assert response.status == 200
    assert %{"reused" => true, "run" => %{"id" => id}} = Jason.decode!(response.resp_body)
    assert id == run.id
    assert [1] == SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [ctx.dispatch.id])

    assert {:ok, message} =
             Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{ctx.dispatch.id}")

    assert message.runId == run.id
    assert message.author == "Sol"
    assert message.status == "running"
  end

  test "a deferred next-step checkpoint does not block later human turns", ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    Hub.unregister_runner(ctx.owner.id, ctx.sid)

    SQL.exec("UPDATE chat_agent_members SET orchestrator=1,next_step_suggestions=1 WHERE id=?", [
      ctx.registration.id
    ])

    {:ok, _} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: ctx.dispatch.messageId,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Existing work keeps the checkpoint deferred"
      })

    source = "sys-next-enable-#{ctx.registration.id}"

    assert nil ==
             Cascade.Chat.NextSteps.enqueue(
               ctx.owner_channel.id,
               ctx.registration.id,
               source,
               "enable",
               "Consider next work"
             )

    [checkpoint] = SQL.one("SELECT id FROM chat_agent_dispatches WHERE message_id=?", [source])
    human = admit(ctx, "Please answer this instead of waiting for proactive work")
    register_runner!(ctx.sid)
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(human.id).id == delegated["runId"]
    refute Store.find_by_chat_dispatch(checkpoint)

    assert [nil, nil] ==
             SQL.one("SELECT run_id,failed_at FROM chat_agent_dispatches WHERE id=?", [checkpoint])

    Store.finish(delegated["runId"], "completed", "Answered")
  end

  test "peer input queues and terminal events wake it without browser ownership", ctx do
    first = event!(ctx.sid, "run:delegate")
    peer = admit(ctx, "peer turn", registrationId: ctx.registration.id)
    Cascade.Missions.DispatchReannouncer.wake()
    Process.sleep(80)
    assert Store.get(first["runId"]).status == "queued"
    refute Store.find_by_chat_dispatch(peer.id)
    Store.finish(first["runId"], "completed", "done")
    next = event!(ctx.sid, "run:delegate")
    assert next["runId"] != first["runId"]
    assert Store.find_by_chat_dispatch(peer.id).id == next["runId"]
  end

  test "a queued peer yields to human steering but resumes only after the human completes", ctx do
    first = event!(ctx.sid, "run:delegate")
    peer = admit(ctx, "peer turn", registrationId: ctx.registration.id)
    Process.sleep(50)
    human = admit(ctx, "urgent human turn")
    cancel = packet!(ctx.sid, "run:cancel")
    refute Store.find_by_chat_dispatch(peer.id)
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: false}]))
    Process.sleep(50)
    refute Store.find_by_chat_dispatch(peer.id)
    refute Store.find_by_chat_dispatch(human.id)
    Cascade.Missions.DispatchReannouncer.wake()
    cancel = packet!(ctx.sid, "run:cancel")
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(human.id).id == delegated["runId"]
    assert Store.get(first["runId"]).status == "canceled"
    refute Store.find_by_chat_dispatch(peer.id)
    Store.finish(delegated["runId"], "completed", "done")
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(peer.id).id == delegated["runId"]
  end

  test "settings changed during a delayed stop ACK are authoritative", ctx do
    event!(ctx.sid, "run:delegate")

    {:ok, message} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: Ecto.UUID.generate(),
        body: "owner steering"
      })

    {:ok, _dispatch} =
      Dispatches.create(ctx.owner.id, ctx.owner_channel.id, message, ctx.registration.id)

    cancel = packet!(ctx.sid, "run:cancel")

    SQL.exec("UPDATE chat_agent_members SET yolo=0,model='fresh-model' WHERE id=?", [
      ctx.registration.id
    ])

    Channel.update_settings(ctx.owner_channel.id, ctx.owner.id, %{cwd: "/fresh/cwd"})
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))
    delegated = event!(ctx.sid, "run:delegate")
    refute delegated["yolo"]
    assert delegated["model"] == "fresh-model"
    assert delegated["cwd"] == "/fresh/cwd"
  end

  test "identity replacement during stop ACK fails closed and settles the queued shell", ctx do
    event!(ctx.sid, "run:delegate")
    dispatch = admit(ctx, "must not reroute")
    cancel = packet!(ctx.sid, "run:cancel")

    {:ok, identity} =
      Agents.upsert_identity(ctx.owner.id, ctx.owner_vault.id, %{
        agentId: "codex",
        displayName: "Replacement",
        mention: "replacement"
      })

    SQL.exec("UPDATE chat_agent_members SET vault_agent_id=? WHERE id=?", [
      identity.id,
      ctx.registration.id
    ])

    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))

    eventually(fn ->
      {:ok, shell} =
        Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch.id}")

      assert shell.status == "failed"
    end)

    refute Store.find_by_chat_dispatch(dispatch.id)
    assert {:error, _} = Dispatches.for_execution(dispatch.id)
  end

  test "human steering waits for the actual desktop stop ACK and preserves the session", ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.persist_session(first["runId"], "provider-session")
    Store.publish(first["runId"], "harness", %{data: "Investigating the deployment timing"})
    Cascade.Runs.ChatProjection.sync(first["runId"])
    next = admit(ctx, "human steering")
    cancel = packet!(ctx.sid, "run:cancel")
    assert Store.get(first["runId"]).status == "queued"
    refute Store.find_by_chat_dispatch(next.id)
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: false}]))
    Process.sleep(40)
    assert Store.get(first["runId"]).status == "queued"
    refute Store.find_by_chat_dispatch(next.id)
    Cascade.Missions.DispatchReannouncer.wake()
    cancel = packet!(ctx.sid, "run:cancel")
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.get(first["runId"]).status == "canceled"
    assert Store.get(delegated["runId"]).session_id == "provider-session"
    assert delegated["prompt"] =~ "Earlier requests interrupted by follow-ups (still unanswered)"
    assert delegated["prompt"] =~ "finish the owner-side work"
    assert delegated["prompt"] =~ "human steering"
    Cascade.Runs.ChatProjection.sync(first["runId"])

    {:ok, prior} =
      Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{ctx.dispatch.id}")

    assert prior.harnessLog =~ "Investigating the deployment timing"
    assert prior.body =~ "Steered into the continuation below."

    latest = admit(ctx, "And why was the build slow?")
    cancel = packet!(ctx.sid, "run:cancel")
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))
    continued = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(latest.id).id == continued["runId"]
    assert continued["prompt"] =~ "finish the owner-side work"
    assert continued["prompt"] =~ "human steering"
    assert continued["prompt"] =~ "And why was the build slow?"
  end

  test "explicit Stop does not carry canceled requests into a later question", ctx do
    first = event!(ctx.sid, "run:delegate")
    stop = Task.async(fn -> Store.cancel(first["runId"]) end)
    cancel = packet!(ctx.sid, "run:cancel")
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: true}]))
    assert Task.await(stop)
    admit(ctx, "Why did deployment take ten minutes?")
    next = event!(ctx.sid, "run:delegate")
    refute next["prompt"] =~ "Earlier requests interrupted by follow-ups (still unanswered)"
    assert Store.get(first["runId"]).summary == "Run canceled by user."
  end

  test "offline admission retains provenance and generation across clear and reconnect", ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    Hub.unregister_runner(ctx.owner.id, ctx.sid)
    before_clear = admit(ctx, "before clear")

    response =
      post_message(
        ctx.owner,
        ctx.owner_vault,
        ctx.owner_channel,
        "  /clear @#{ctx.registration.mention}  "
      )

    assert response.status == 201
    cleared = Jason.decode!(response.resp_body)
    assert cleared["dispatches"] == []
    assert cleared["notice"]["body"] =~ "Cleared the session for @#{ctx.registration.mention}"
    assert cleared["notice"]["author"] == "Cascade"
    generation = hd(cleared["agents"])["conversationId"]
    refute generation == ctx.registration.conversationId

    response =
      post_message(
        ctx.owner,
        ctx.owner_vault,
        ctx.owner_channel,
        "@#{ctx.registration.mention} ping"
      )

    assert response.status == 201
    [after_clear] = Jason.decode!(response.resp_body)["dispatches"]
    assert before_clear.conversationId == ctx.registration.conversationId
    assert after_clear["conversationId"] == generation

    assert {:ok, []} =
             Dispatches.create_for_message(ctx.owner.id, ctx.owner_channel.id, cleared["message"])

    assert {:ok, []} =
             Dispatches.create_for_message(ctx.owner.id, ctx.owner_channel.id, cleared["notice"])

    assert before_clear.requesterUserId == ctx.guest.id
    assert before_clear.requesterChannelId == ctx.guest_channel.id

    before_rows =
      SQL.all(
        "SELECT id,error,failed_at,run_id FROM chat_agent_dispatches WHERE channel_id=? ORDER BY id",
        [ctx.owner_channel.id]
      )

    before_messages =
      SQL.all("SELECT id,body,status FROM chat_messages WHERE channel_id=? ORDER BY id", [
        ctx.owner_channel.id
      ])

    Cascade.Missions.DispatchReannouncer.wake()
    Process.sleep(60)

    assert SQL.all(
             "SELECT id,error,failed_at,run_id FROM chat_agent_dispatches WHERE channel_id=? ORDER BY id",
             [ctx.owner_channel.id]
           ) == before_rows

    assert SQL.all("SELECT id,body,status FROM chat_messages WHERE channel_id=? ORDER BY id", [
             ctx.owner_channel.id
           ]) == before_messages

    refute Store.find_by_chat_dispatch(before_clear.id)

    assert [nil] ==
             SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [before_clear.id])

    register_runner!(ctx.sid)
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.get(delegated["runId"]).conversation_id == before_clear.conversationId
    Store.finish(delegated["runId"], "completed", "done")
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.get(delegated["runId"]).conversation_id == generation
  end

  test "clear rejects another owner's registration even when it is pingable", ctx do
    for command <- ["/clear", "/RESET @#{ctx.registration.mention}"] do
      response = post_message(ctx.guest, ctx.guest_vault, ctx.guest_channel, command)
      assert response.status == 403
      assert Jason.decode!(response.resp_body)["error"] =~ "own roster"

      assert [ctx.registration.conversationId] ==
               SQL.one("SELECT conversation_id FROM chat_agent_members WHERE id=?", [
                 ctx.registration.id
               ])
    end

    assert [0] ==
             SQL.one(
               "SELECT count(*) FROM chat_messages WHERE channel_id=? AND body LIKE '%/clear%'",
               [ctx.owner_channel.id]
             )
  end

  test "reset without targets rotates all registrations; compact stays an ordinary dispatch",
       ctx do
    SQL.exec("UPDATE vault_agents SET agent_id='claude-code' WHERE id=?", [
      ctx.registration.vaultAgentId
    ])

    SQL.exec("UPDATE chat_agent_members SET agent_id='claude-code' WHERE id=?", [
      ctx.registration.id
    ])

    response = post_message(ctx.owner, ctx.owner_vault, ctx.owner_channel, " /ReSeT ")
    assert response.status == 201
    cleared = Jason.decode!(response.resp_body)
    generation = hd(cleared["agents"])["conversationId"]
    refute generation == ctx.registration.conversationId

    response =
      post_message(
        ctx.owner,
        ctx.owner_vault,
        ctx.owner_channel,
        "/compact @#{ctx.registration.mention}"
      )

    assert response.status == 201
    [dispatch] = Jason.decode!(response.resp_body)["dispatches"]
    assert dispatch["conversationId"] == generation
    assert is_nil(Jason.decode!(response.resp_body)["notice"])
  end

  test "targeted clear leaves other sessions unchanged and retries do not rotate again", ctx do
    {:ok, identity} =
      Agents.upsert_identity(ctx.owner.id, ctx.owner_vault.id, %{
        agentId: "codex",
        displayName: "Luna",
        mention: "luna-#{ctx.owner.id}"
      })

    {:ok, other} =
      Agents.add_to_channel(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, identity.id)

    id = Ecto.UUID.generate()
    command = "/clear @#{ctx.registration.mention}"
    response = post_message(ctx.owner, ctx.owner_vault, ctx.owner_channel, command, id)
    assert response.status == 201
    cleared = Jason.decode!(response.resp_body)

    assert Enum.find(cleared["agents"], &(&1["id"] == other.id))["conversationId"] ==
             other.conversationId

    response = post_message(ctx.owner, ctx.owner_vault, ctx.owner_channel, command, id)
    assert response.status == 201
    assert Jason.decode!(response.resp_body)["agents"] == cleared["agents"]

    assert [1] ==
             SQL.one("SELECT count(*) FROM chat_messages WHERE id=?", [cleared["notice"]["id"]])
  end

  test "clear in an empty channel reports an error without a notice", ctx do
    channel =
      ContentStore.create_note(ctx.guest_vault.id, ctx.guest.id, %{
        title: "Empty room",
        content: "cascade://chat-channel"
      })

    response = post_message(ctx.guest, ctx.guest_vault, channel, "/clear")
    assert response.status == 400
    assert Jason.decode!(response.resp_body)["error"] == "No agents in this channel to clear."
    assert {:ok, []} = Messages.list(channel.id, ctx.guest.id)
  end

  test "revoked requester access fails closed even when the display author impersonates the owner",
       ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    Hub.unregister_runner(ctx.owner.id, ctx.sid)
    dispatch = admit(ctx, "must not run")
    # Preserve coverage for a queued shell created by an earlier server.
    CascadeWeb.OrchestrationController.prepare_dispatch(dispatch.id)

    eventually(fn ->
      assert {:ok, %{status: "queued"}} =
               Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch.id}")
    end)

    SQL.exec("UPDATE chat_messages SET author=? WHERE id=?", [
      ctx.owner.username,
      dispatch.messageId
    ])

    SQL.exec("UPDATE chat_agent_members SET pingable_by_others=0 WHERE id=?", [
      ctx.registration.id
    ])

    register_runner!(ctx.sid)

    eventually(fn ->
      assert [failed] =
               SQL.one("SELECT failed_at FROM chat_agent_dispatches WHERE id=?", [dispatch.id])

      assert failed
    end)

    refute Store.find_by_chat_dispatch(dispatch.id)

    assert {:ok, %{status: "failed"}} =
             Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch.id}")

    assert {:error, _} = Dispatches.for_execution(dispatch.id)
  end

  test "interrupted pre-atomic startup repairs and settles its existing reply shell", ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    Hub.unregister_runner(ctx.owner.id, ctx.sid)
    dispatch = admit(ctx, "interrupted startup")
    # Preserve coverage for a queued shell created by an earlier server.
    CascadeWeb.OrchestrationController.prepare_dispatch(dispatch.id)

    eventually(fn ->
      assert {:ok, %{status: "queued"}} =
               Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch.id}")
    end)

    {:ok, run} =
      Store.start(ctx.owner_vault.id, nil, "interrupted", "codex",
        owner_user_id: ctx.owner.id,
        chat_dispatch_id: dispatch.id
      )

    SQL.exec("UPDATE runs SET started_at=datetime('now','-1 minute') WHERE id=?", [run.id])
    register_runner!(ctx.sid)
    Cascade.Missions.DispatchReannouncer.wake()

    eventually(fn ->
      assert Store.get(run.id).status == "failed"

      assert {:ok, %{status: "failed", runId: id}} =
               Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch.id}")

      assert id == run.id
      assert [id] == SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [dispatch.id])
    end)
  end

  test "legacy provenance is repaired only from authenticated actor IDs and blank generations persist once",
       ctx do
    event!(ctx.sid, "run:delegate")
    Hub.unregister_runner(ctx.owner.id, ctx.sid)
    dispatch = admit(ctx, "legacy turn")

    SQL.exec(
      "UPDATE chat_agent_dispatches SET requester_user_id=NULL,requester_channel_id=NULL,conversation_id=NULL WHERE id=?",
      [dispatch.id]
    )

    SQL.exec("UPDATE chat_agent_members SET conversation_id='' WHERE id=?", [ctx.registration.id])
    assert {:ok, repaired} = Dispatches.for_execution(dispatch.id)
    assert repaired.requesterUserId == ctx.guest.id
    assert repaired.conversationId not in [nil, ""]
    assert {:ok, again} = Dispatches.for_execution(dispatch.id)
    assert repaired.conversationId == again.conversationId

    SQL.exec(
      "UPDATE chat_agent_dispatches SET requester_user_id=NULL,requester_channel_id=NULL WHERE id=?",
      [dispatch.id]
    )

    SQL.exec("UPDATE chat_messages SET actor_user_id=NULL,author=? WHERE id=?", [
      ctx.owner.username,
      dispatch.messageId
    ])

    assert {:error, _} = Dispatches.for_execution(dispatch.id)
  end

  test "mission worker startup shares admission but never stops the coordinator", ctx do
    coordinator = event!(ctx.sid, "run:delegate")
    mission_id = Ecto.UUID.generate()
    task_id = Ecto.UUID.generate()

    worker =
      SQL.transaction(fn ->
        SQL.exec(
          "INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,created_by) VALUES(?,?,?,?,?,'Mission',?)",
          [
            mission_id,
            ctx.owner_vault.id,
            ctx.owner_channel.id,
            ctx.dispatch.messageId,
            ctx.registration.id,
            ctx.owner.id
          ]
        )

        worker =
          admit(ctx, "isolated mission turn",
            registrationId: ctx.registration.id,
            missionTaskId: task_id
          )

        SQL.exec(
          "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,dispatch_id) VALUES(?,?,'Worker',?,?)",
          [task_id, mission_id, ctx.registration.id, worker.id]
        )

        worker
      end)

    delegated = event!(ctx.sid, "run:delegate")
    assert Store.get(coordinator["runId"]).status == "queued"
    assert Store.find_by_chat_dispatch(worker.id).conversation_id == "mission:#{task_id}"
    assert delegated["prompt"] =~ "mission worker"

    assert {:ok, run} = CascadeWeb.OrchestrationController.execute_dispatch(worker.id)
    assert run.id == delegated["runId"]
  end

  test "scheduler restart recovers pending work while another registration waits on a stop ACK",
       ctx do
    first = event!(ctx.sid, "run:delegate")
    _blocked = admit(ctx, "wait for ack")
    cancel = packet!(ctx.sid, "run:cancel")

    {:ok, identity} =
      Agents.upsert_identity(ctx.owner.id, ctx.owner_vault.id, %{
        agentId: "codex",
        displayName: "Other",
        mention: "other-agent"
      })

    {:ok, other} =
      Agents.add_to_channel(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, identity.id)

    {:ok, message} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: Ecto.UUID.generate(),
        body: "Independent work"
      })

    {:ok, independent} = Dispatches.create(ctx.owner.id, ctx.owner_channel.id, message, other.id)
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(independent.id).id == delegated["runId"]
    assert Store.get(first["runId"]).status == "queued"
    send_socket!(ctx.sid, SocketIO.ack("/runners", cancel.id, [%{success: false}]))
    Hub.unregister_runner(ctx.owner.id, ctx.sid)
    :ok = Supervisor.terminate_child(Cascade.Supervisor, Cascade.Missions.DispatchReannouncer)

    {:ok, _pid} =
      Supervisor.restart_child(Cascade.Supervisor, Cascade.Missions.DispatchReannouncer)

    Store.finish(first["runId"], "completed", "done")
    register_runner!(ctx.sid)
    assert event!(ctx.sid, "run:delegate")["runId"] != first["runId"]
  end

  test "an attached mission startup without a desktop lease settles during periodic replay",
       ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    worker = Process.whereis(Cascade.Missions.DispatchReannouncer)
    :sys.suspend(worker)

    {run, task} =
      try do
        {mission, task} = mission_task(ctx, "Crash boundary")
        [item] = Cascade.Missions.Scheduler.schedule(mission.mission.id).dispatches

        {:ok, run} =
          Store.start(ctx.owner_vault.id, nil, "Worker", "codex",
            owner_user_id: ctx.owner.id,
            chat_dispatch_id: item.dispatch.id
          )

        :ok = Dispatches.attach_run(item.dispatch.id, run.id)
        {:ok, _} = Cascade.Missions.Store.attach_run(item.dispatch.id, run.id)
        SQL.exec("UPDATE runs SET started_at=datetime('now','-10 minutes') WHERE id=?", [run.id])
        {run, task}
      after
        :sys.resume(worker)
      end

    Cascade.Missions.DispatchReannouncer.wake()

    eventually(fn ->
      assert Store.get(run.id).status == "failed"
      assert SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [task.id]) == ["failed"]
    end)

    assert is_nil(Store.delegated_owner(run.id))
  end

  test "child preparation uses its parent's workspace while another session bypasses a slow ACK",
       ctx do
    first = event!(ctx.sid, "run:delegate")
    Store.finish(first["runId"], "completed", "done")
    {mission, _parent} = mission_task(ctx, "Parent", "isolated")
    Cascade.Missions.Scheduler.schedule(mission.mission.id)
    preparation = packet!(ctx.sid, "workspace:prepare")
    assert Enum.at(preparation.data, 1)["dir"] == "/owner/channel"

    {:ok, identity} =
      Agents.upsert_identity(ctx.owner.id, ctx.owner_vault.id, %{
        agentId: "codex",
        displayName: "Independent",
        mention: "independent"
      })

    {:ok, other} =
      Agents.add_to_channel(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, identity.id)

    {:ok, message} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: Ecto.UUID.generate(),
        body: "Independent work"
      })

    {:ok, independent} = Dispatches.create(ctx.owner.id, ctx.owner_channel.id, message, other.id)
    delegated = event!(ctx.sid, "run:delegate")
    assert Store.find_by_chat_dispatch(independent.id).id == delegated["runId"]

    prepared!(ctx.sid, preparation, "/parent/task", "parent-base")
    parent_run = event!(ctx.sid, "run:delegate")
    assert parent_run["cwd"] == "/parent/task"

    {:ok, added} =
      Cascade.Missions.Children.add(
        ctx.owner.id,
        ctx.owner_channel.id,
        mission.mission.id,
        %{title: "Child", prompt: "Use parent work"},
        parent_run["runId"]
      )

    Cascade.Missions.Scheduler.schedule(mission.mission.id)
    preparation = packet!(ctx.sid, "workspace:prepare")
    assert Enum.at(preparation.data, 1)["dir"] == "/parent/task"
    prepared!(ctx.sid, preparation, "/child/task", "parent-tip")
    child_run = event!(ctx.sid, "run:delegate")
    assert child_run["cwd"] == "/child/task"
    assert child_run["prompt"] =~ "bounded child worker"
    assert {:ok, child_item} = Cascade.WorkItems.get(ctx.owner.id, added.task.workItemId)
    assert child_item.baseCommit == "parent-tip"
  end

  defp mission_task(ctx, title, mode \\ "shared") do
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1 WHERE id=?", [ctx.registration.id])

    {:ok, root} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: Ecto.UUID.generate(),
        body: title
      })

    {:ok, mission} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.registration.id,
        title: title
      })

    {:ok, added} =
      Cascade.Missions.Store.add_task(ctx.owner.id, ctx.owner_channel.id, mission.mission.id, %{
        coordinatorRegistrationId: ctx.registration.id,
        assignee: ctx.registration.id,
        anonymous: true,
        workspaceMode: mode,
        title: title,
        prompt: "Do work"
      })

    {mission, added.task}
  end

  defp prepared!(sid, packet, path, base) do
    input = Enum.at(packet.data, 1)

    send_socket!(
      sid,
      SocketIO.ack("/runners", packet.id, [
        %{
          ok: true,
          path: path,
          repository: "/repo",
          branch: input["branch"],
          baseBranch: "master",
          baseCommit: base
        }
      ])
    )
  end

  defp admit(ctx, body, opts \\ []) do
    peer? = Keyword.has_key?(opts, :registrationId)
    user = if peer?, do: ctx.owner, else: ctx.guest
    vault = if peer?, do: ctx.owner_vault, else: ctx.guest_vault
    channel = if peer?, do: ctx.owner_channel, else: ctx.guest_channel

    {:ok, message} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        Map.merge(
          %{id: Ecto.UUID.generate(), body: "@#{ctx.registration.mention} #{body}"},
          Map.new(opts)
        ),
        access: if(peer?, do: :agent, else: :user)
      )

    {:ok, dispatch} = Dispatches.create(user.id, channel.id, message, ctx.registration.id)
    dispatch
  end

  defp event!(sid, name), do: packet!(sid, name).data |> Enum.at(1)

  defp packet!(sid, name, remaining \\ 12) do
    assert remaining > 0
    {:ok, payload} = Session.poll(sid, 1_000)

    packets =
      payload
      |> EngineIO.decode_payload()
      |> elem(1)
      |> Enum.flat_map(fn
        %{type: :message, data: data} ->
          case SocketIO.decode(data) do
            {:ok, packet} -> [packet]
            _ -> []
          end

        _ ->
          []
      end)

    case Enum.find(packets, &(Map.get(&1, :data, []) |> List.wrap() |> List.first() == name)) do
      nil -> packet!(sid, name, remaining - 1)
      packet -> packet
    end
  end

  defp eventually(fun, remaining \\ 100) do
    fun.()
  rescue
    error in ExUnit.AssertionError ->
      if remaining == 0, do: reraise(error, __STACKTRACE__)
      Process.sleep(20)
      eventually(fun, remaining - 1)
  end

  defp post_message(user, vault, channel, body, id \\ Ecto.UUID.generate()) do
    conn(
      :post,
      "/api/vaults/#{vault.id}/channels/#{channel.id}/messages",
      Jason.encode!(%{id: id, body: body})
    )
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer #{Token.sign_user(user)}")
    |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))
  end

  defp request(ctx, body) do
    conn(:post, "/api/vaults/#{ctx.guest_vault.id}/runs", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer #{Token.sign_user(ctx.guest)}")
    |> CascadeWeb.OrchestrationRouter.call(CascadeWeb.OrchestrationRouter.init([]))
  end

  defp user!(id, username) do
    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [id, username, "x", username]
    )

    %{id: id, username: username, auth_version: 0}
  end

  defp connect_runner!(sid, token) do
    send_socket!(sid, %{type: :connect, namespace: "/runners", data: %{"token" => token}})
  end

  defp register_runner!(sid) do
    send_socket!(
      sid,
      SocketIO.event("/runners", "runner:register", [
        %{"activeRunIds" => [], "runnerInstanceId" => sid}
      ])
    )
  end

  defp send_socket!(sid, packet) do
    payload = EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(packet)}])
    assert :ok = Session.receive_payload(sid, payload)
  end
end
