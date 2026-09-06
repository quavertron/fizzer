defmodule CascadeWeb.OrchestrationMissionExecutionTest do
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
    worker = Process.whereis(Cascade.Missions.DispatchReannouncer)
    :sys.suspend(worker)
    Process.unregister(Cascade.Missions.DispatchReannouncer)

    on_exit(fn ->
      Process.register(worker, Cascade.Missions.DispatchReannouncer)
      :sys.resume(worker)
    end)

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

    {:ok, dispatch} =
      Dispatches.create(guest.id, guest_channel.id, source_message, registration.id,
        reasoning_effort: "max"
      )

    Dispatches.fail(dispatch.id, "Fixture admission consumed")

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

  for terminal <- ["canceled", "completed", "failed"] do
    @race_terminal terminal
    test "cancel tolerates #{@race_terminal} arriving before its acknowledgment", ctx do
      {:ok, run} = Store.start(ctx.owner_vault.id, nil, "Cancel race", "codex")
      :ok = Store.record_delegated(run.id, ctx.owner.id)
      cancel = Task.async(fn -> Store.cancel(run.id, steering: true) end)
      assert {:ok, packet} = Session.poll(ctx.sid, 1_000)
      {:ok, [%{data: encoded}]} = EngineIO.decode_payload(packet)
      {:ok, %{id: ack_id, data: ["run:cancel", _]}} = SocketIO.decode(encoded)
      :ok = Store.finish(run.id, @race_terminal, "Provider settled first")

      send_socket!(ctx.sid, %{
        type: :ack,
        namespace: "/runners",
        id: ack_id,
        data: [%{success: true}]
      })

      assert Task.await(cancel)
      assert Store.get(run.id).status == @race_terminal

      terminal_events =
        Store.events(run.id)
        |> Enum.filter(
          &(&1.type == "status" and Jason.decode!(&1.payload_json)["status"] == "canceled")
        )

      assert length(terminal_events) == if(@race_terminal == "canceled", do: 1, else: 0)
    end
  end

  test "worker steering resumes its provider session and cwd without stopping the coordinator",
       ctx do
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1 WHERE id=?", [ctx.registration.id])

    {:ok, root} =
      Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
        id: "steer-root-#{ctx.registration.id}",
        body: "Implement steering"
      })

    {:ok, mission} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Steer wire"
      })

    {:ok, added} =
      Cascade.Missions.Store.add_task(ctx.owner.id, ctx.owner_channel.id, mission.mission.id, %{
        coordinatorRegistrationId: ctx.registration.id,
        assignee: ctx.registration.id,
        anonymous: true,
        title: "Worker",
        prompt: "Keep a file edit and remember a context marker."
      })

    SQL.exec("UPDATE chat_agent_dispatches SET failed_at=NULL,error='' WHERE id=?", [
      ctx.dispatch.id
    ])

    {:ok, coordinator_run} =
      Store.start(ctx.owner_vault.id, nil, "Coordinator", "codex",
        chat_dispatch_id: ctx.dispatch.id
      )

    Dispatches.attach_run(ctx.dispatch.id, coordinator_run.id)
    [item] = Cascade.Missions.Scheduler.schedule(mission.mission.id).dispatches

    response =
      request(ctx, %{
        prompt: "Execute the worker task",
        conversation_id: ctx.registration.conversationId,
        chatDispatchId: item.dispatch.id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "worker-http-#{added.task.id}"}
      })

    assert response.status == 202
    assert {:ok, worker} = CascadeWeb.OrchestrationController.execute_dispatch(item.dispatch.id)
    assert worker.conversation_id == "mission:#{added.task.id}"

    assert Store.get(coordinator_run.id).status == "queued"
    assert {:ok, initial_packet} = Session.poll(ctx.sid, 1_000)
    assert initial_packet =~ "run:delegate"
    refute initial_packet =~ "run:cancel"
    refute worker.prompt =~ "start a durable mission"
    SQL.exec("UPDATE runs SET session_id='retained-provider-context' WHERE id=?", [worker.id])

    {:ok, request} =
      Cascade.Missions.Store.request_steering(
        ctx.owner.id,
        ctx.owner_channel.id,
        added.task.id,
        %{
          coordinatorRegistrationId: ctx.registration.id,
          message: "Use the remembered marker and keep that file edit.",
          attempt: 0,
          runId: worker.id
        }
      )

    delivery = Task.async(fn -> Cascade.Missions.Steering.deliver(request) end)
    assert {:ok, cancel_packet} = Session.poll(ctx.sid, 1_000)
    {:ok, packets} = EngineIO.decode_payload(cancel_packet)
    [%{data: encoded}] = packets

    {:ok, %{id: ack_id, data: ["run:cancel", %{"runId" => canceled_id}]}} =
      SocketIO.decode(encoded)

    assert canceled_id == worker.id

    # The provider can report cancellation before the desktop acknowledges Stop.
    :ok = Store.finish(worker.id, "canceled", "Run canceled.")

    send_socket!(ctx.sid, %{
      type: :ack,
      namespace: "/runners",
      id: ack_id,
      data: [%{success: true}]
    })

    assert %{status: "queued"} = Task.await(delivery)

    [resumed_dispatch] =
      SQL.one("SELECT dispatch_id FROM chat_mission_tasks WHERE id=? AND run_id IS NULL", [
        added.task.id
      ])

    assert {:ok, resumed} = CascadeWeb.OrchestrationController.execute_dispatch(resumed_dispatch)
    resumed_id = resumed.id
    assert {:ok, resumed_packet} = Session.poll(ctx.sid, 1_000)
    assert resumed_packet =~ "retained-provider-context"
    assert resumed_packet =~ "resumeSessionId"
    assert resumed_packet =~ "Use the remembered marker"
    assert resumed_packet =~ "/owner/channel"
    refute resumed_packet =~ "run:cancel"
    assert Store.get(resumed_id).conversation_id == "mission:#{added.task.id}"
    assert Store.get(coordinator_run.id).status == "queued"
    assert Store.get(worker.id).status == "canceled"
  end

  test "a checkpoint deferred after browser discovery creates no run and remains durable", ctx do
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1,next_step_suggestions=1 WHERE id=?", [
      ctx.registration.id
    ])

    {:ok, _mission} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: ctx.dispatch.messageId,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Existing work"
      })

    source = "sys-next-enable-#{ctx.registration.id}"

    assert Cascade.Chat.NextSteps.enqueue(
             ctx.owner_channel.id,
             ctx.registration.id,
             source,
             "enable",
             "Consider next work"
           ) == nil

    [dispatch_id] = SQL.one("SELECT id FROM chat_agent_dispatches WHERE message_id=?", [source])

    response =
      request(ctx, %{
        prompt: "Consider next work",
        chatDispatchId: dispatch_id,
        chat: %{channelId: ctx.guest_channel.id, messageId: "agent-dispatch-#{dispatch_id}"}
      })

    assert response.status == 202
    assert {:busy, _} = CascadeWeb.OrchestrationController.execute_dispatch(dispatch_id)
    assert SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [dispatch_id]) == [nil]
    assert Store.find_by_chat_dispatch(dispatch_id) == nil

    assert SQL.one("SELECT outcome FROM chat_next_step_checks WHERE source_id=?", [source]) == [
             "pending"
           ]
  end

  test "enabled obligation is claimed without a chat page and retains owner authority", ctx do
    # A stalled historical mission must not suppress all later consideration.
    {:ok, stalled} =
      Cascade.Missions.Store.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
        rootMessageId: ctx.dispatch.messageId,
        coordinatorRegistrationId: ctx.registration.id,
        title: "Old repair awaiting attention"
      })

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status) VALUES(?,?,?,?, 'failed')",
      ["stalled-#{stalled.mission.id}", stalled.mission.id, "Failed repair", ctx.registration.id]
    )

    SQL.exec("UPDATE chat_missions SET status='attention',wake_sent=1 WHERE id=?", [
      stalled.mission.id
    ])

    {:ok, registration} =
      Agents.add_to_channel(
        ctx.owner.id,
        ctx.owner_vault.id,
        ctx.owner_channel.id,
        ctx.registration.vaultAgentId,
        %{orchestrator: true, nextStepSuggestions: true}
      )

    [source] =
      SQL.one(
        "SELECT source_id FROM chat_next_step_checks WHERE registration_id=? AND kind='enable'",
        [registration.id]
      )

    {:ok, [dispatch]} =
      Dispatches.list_pending(ctx.owner.id, ctx.owner_channel.id)
      |> case do
        {:ok, items} -> {:ok, Enum.filter(items, &(&1.messageId == source))}
      end

    assert {:ok, _} = CascadeWeb.OrchestrationController.execute_dispatch(dispatch.id)

    [run_id] = SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [dispatch.id])
    assert is_integer(run_id)
    assert Store.get(run_id).prompt =~ "You must evaluate the next useful step"
    refute Store.get(run_id).prompt =~ "Do not offer a new proactive suggestion"
    refute Store.get(run_id).prompt =~ "start a durable mission"
    assert {:ok, transcript} = Messages.list(ctx.owner_channel.id, ctx.owner.id)
    refute Enum.any?(transcript, &(&1.id == source))
    assert {:ok, internal} = Messages.get(ctx.owner_channel.id, ctx.owner.id, source)
    assert internal.body =~ "Next-step checkpoint"

    reply =
      complete_checkpoint(
        ctx,
        dispatch.id,
        run_id,
        "<!-- fizzer-next:#{source} --> The old repair is stalled. Should reviewing its saved evidence be next?"
      )

    assert reply.body =~ "Should reviewing its saved evidence be next?"
    assert {:ok, transcript} = Messages.list(ctx.owner_channel.id, ctx.owner.id)
    assert Enum.any?(transcript, &(&1.id == reply.id))
    assert Store.get(run_id).prompt =~ "This checkpoint grants no authority to start work"

    assert {:ok, same} =
             CascadeWeb.OrchestrationController.execute_dispatch(dispatch.id)

    assert same.id == run_id

    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [ctx.owner_channel.id]) ==
             [1]
  end

  for outcome <- [:proposal, :none] do
    @tag checkpoint_outcome: outcome
    test "next-step lifecycle reconsiders #{outcome} after mission closure and scheduler restart",
         ctx do
      alias Cascade.Chat.{NextSteps, Schema}
      alias Cascade.Missions.{Authority, DispatchReannouncer, Scheduler}
      alias Cascade.Missions.Store, as: Missions

      {:ok, _source} =
        Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
          body: "The updater keeps failing and interrupting my work."
        })

      {:ok, registration} =
        Agents.add_to_channel(
          ctx.owner.id,
          ctx.owner_vault.id,
          ctx.owner_channel.id,
          ctx.registration.vaultAgentId,
          %{orchestrator: true, nextStepSuggestions: true}
        )

      [source] =
        SQL.one(
          "SELECT source_id FROM chat_next_step_checks WHERE registration_id=? AND kind='enable'",
          [registration.id]
        )

      # Use the actual recovery process and connected test runner; no provider is invoked.
      scheduler = start_supervised!({DispatchReannouncer, interval: 60_000})

      eventually(fn ->
        match?(
          [_, run] when is_integer(run),
          SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id=?", [source])
        )
      end)

      [dispatch, run] =
        SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id=?", [source])

      assert is_integer(run)
      assert Store.get(run).prompt =~ "must evaluate"
      assert {:ok, packet} = Session.poll(ctx.sid, 1_000)
      assert length(Regex.scan(~r/run:delegate/, packet)) == 1
      :ok = stop_supervised(DispatchReannouncer)

      body =
        "<!-- fizzer-next:#{source} -->\n\nThe updater keeps interrupting you. Should fixing that failure be next?"

      proposed = complete_checkpoint(ctx, dispatch, run, body)
      assert proposed.body == body

      assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [
               ctx.owner_channel.id
             ]) ==
               [0]

      {:ok, accepted} =
        Messages.create(ctx.owner, ctx.owner_vault.id, ctx.owner_channel.id, %{
          body: "Yes, fix that failure, but keep my editor open.",
          replyTo: %{messageId: proposed.id, author: proposed.author, body: proposed.body}
        })

      assert {:ok, [accept_dispatch]} =
               Dispatches.create_for_message(ctx.owner.id, ctx.owner_channel.id, accepted)

      assert accept_dispatch.registration.id == registration.id

      assert {:ok, accepted_run} =
               CascadeWeb.OrchestrationController.execute_dispatch(accept_dispatch.id)

      assert {:ok, _packet} = Session.poll(ctx.sid, 1_000)
      Store.finish(accepted_run.id, "completed", "Accepted bounded repair")

      assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [
               ctx.owner_channel.id
             ]) ==
               [0]

      {:ok, feedback} =
        Messages.create(
          ctx.owner,
          ctx.owner_vault.id,
          ctx.owner_channel.id,
          %{
            agentId: "codex",
            registrationId: registration.id,
            body:
              "<!-- fizzer-next-feedback:#{proposed.id}:#{accepted.id}:accepted --> I will fix only that failure and keep your editor open."
          },
          access: :agent
        )

      assert feedback.body == "I will fix only that failure and keep your editor open."

      assert SQL.one(
               "SELECT feedback,feedback_message_id FROM chat_next_step_checks WHERE message_id=?",
               [proposed.id]
             ) == ["accepted", accepted.id]

      {:ok, created} =
        Missions.create(ctx.owner.id, ctx.owner_vault.id, ctx.owner_channel.id, %{
          rootMessageId: accepted.id,
          coordinatorRegistrationId: registration.id,
          title: "Fix updater failure",
          objective: "Fix only the updater failure; keep the editor open."
        })

      authority = Authority.context(created.mission.id)
      assert authority =~ accepted.body
      assert authority =~ Jason.encode!(proposed.body)
      assert authority =~ "bounded_proposal_context"

      finish = %{
        coordinatorRegistrationId: registration.id,
        status: "completed",
        summary:
          "Updater repair verified; editor remained open." <>
            if(ctx.checkpoint_outcome == :proposal,
              do:
                " Separate packaging failure still blocks release; outside the accepted repair.",
              else: ""
            )
      }

      {:ok, _task} =
        Missions.add_task(ctx.owner.id, ctx.owner_channel.id, created.mission.id, %{
          coordinatorRegistrationId: registration.id,
          assignee: registration.id,
          anonymous: true,
          title: "Repair and verify updater",
          workspaceMode: "shared"
        })

      [%{dispatch: worker}] = Scheduler.schedule(created.mission.id).dispatches

      {:ok, worker_run} =
        Store.start(ctx.owner_vault.id, nil, "Repair updater", "codex",
          chat_dispatch_id: worker.id
        )

      :ok = Dispatches.attach_run(worker.id, worker_run.id)
      {:ok, _} = Missions.attach_run(worker.id, worker_run.id)
      evidence = "Fixture artifact: updater repair; focused checks passed."
      :ok = Store.finish(worker_run.id, "completed", evidence)
      {:ok, settled} = Scheduler.settle_run(worker_run.id, "completed", evidence)
      assert settled.settled.update.mission.status == "reviewing"

      verification =
        "Fixture verification: inspected artifact and passing focused checks; editor remained open."

      assert {:ok, completed} =
               Missions.finish(
                 ctx.owner.id,
                 ctx.owner_channel.id,
                 created.mission.id,
                 Map.put(finish, :verification, verification)
               )

      assert completed.mission.status == "completed"

      assert SQL.one("SELECT verification FROM chat_missions WHERE id=?", [created.mission.id]) ==
               [
                 verification
               ]

      # Store.finish must persist the completion wake even if publication is interrupted.
      completion_source = "sys-next-completed-#{created.mission.id}"

      [completion_dispatch, nil] =
        SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id=?", [
          completion_source
        ])

      assert SQL.one("SELECT kind,outcome FROM chat_next_step_checks WHERE source_id=?", [
               completion_source
             ]) == ["completion", "pending"]

      # Restart the scheduler with only persisted outbox/checkpoint state to recover.
      Schema.ensure!()
      recovered = start_supervised!({DispatchReannouncer, interval: 60_000})
      refute recovered == scheduler

      eventually(fn ->
        match?(
          [run] when is_integer(run),
          SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [completion_dispatch])
        )
      end)

      [completion_run] =
        SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [completion_dispatch])

      assert is_integer(completion_run)
      assert Store.get(completion_run).prompt =~ "must evaluate"
      assert Store.get(completion_run).prompt =~ finish.summary
      assert Store.get(completion_run).prompt =~ accepted.body
      assert {:ok, packet} = Session.poll(ctx.sid, 1_000)
      assert length(Regex.scan(~r/run:delegate/, packet)) == 1

      Scheduler.emit_projection(completed)
      send(recovered, :wake)

      eventually(fn ->
        match?(
          [run] when is_integer(run),
          SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [completion_dispatch])
        )
      end)

      assert {:ok, same} =
               CascadeWeb.OrchestrationController.execute_dispatch(completion_dispatch)

      assert same.id == completion_run

      assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [completion_dispatch]) ==
               [1]

      Session.emit(ctx.sid, "/runners", "boundary:barrier", [])
      assert {:ok, replay_packet} = Session.poll(ctx.sid, 1_000)
      refute replay_packet =~ "run:delegate"

      reconsideration =
        if ctx.checkpoint_outcome == :proposal,
          do:
            "<!-- fizzer-next:#{completion_source} -->\n\nThe separate packaging failure still blocks release. Should diagnosing it be next?",
          else:
            "<!-- fizzer-next-none:#{completion_source} --> The updater issue is resolved; no other grounded need remains."

      expected_body =
        if ctx.checkpoint_outcome == :proposal,
          do: reconsideration,
          else: "The updater issue is resolved; no other grounded need remains."

      reconsidered =
        complete_checkpoint(ctx, completion_dispatch, completion_run, reconsideration)

      assert reconsidered.body == expected_body

      assert NextSteps.context(ctx.owner_channel.id, registration.id, completion_source) =~
               "already checked"

      :ok = stop_supervised(DispatchReannouncer)
      final_scheduler = start_supervised!({DispatchReannouncer, interval: 60_000})
      assert :sys.get_state(final_scheduler).interval == 60_000

      assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [completion_dispatch]) ==
               [1]

      assert SQL.one("SELECT COUNT(*) FROM chat_agent_dispatches WHERE message_id=?", [
               completion_source
             ]) == [1]

      Session.emit(ctx.sid, "/runners", "boundary:barrier", [])
      assert {:ok, final_packet} = Session.poll(ctx.sid, 1_000)
      refute final_packet =~ "run:delegate"
    end
  end

  defp complete_checkpoint(ctx, dispatch_id, run_id, body) do
    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [%{runId: run_id, type: "status", payload: %{status: "completed", summary: body}}],
               %{id: ctx.owner.id},
               %{}
             )

    assert Store.get(run_id).status == "completed"

    assert {:ok, message} =
             Messages.get(ctx.owner_channel.id, ctx.owner.id, "agent-dispatch-#{dispatch_id}")

    message
  end

  test "coordinator reviews are claimed without a chat page and repeated claims reuse the run",
       ctx do
    SQL.exec("UPDATE chat_agent_members SET orchestrator=1,next_step_suggestions=1 WHERE id=?", [
      ctx.registration.id
    ])

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

    [review_id] =
      SQL.one("SELECT id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{mission.mission.id}-%"
      ])

    assert {:ok, _} = CascadeWeb.OrchestrationController.execute_dispatch(review_id)

    [dispatch_id, run_id] =
      SQL.one("SELECT id,run_id FROM chat_agent_dispatches WHERE message_id LIKE ?", [
        "sys-mission-#{mission.mission.id}-%"
      ])

    assert is_integer(run_id)
    run = Store.get(run_id)

    assert {:ok, duplicate} =
             CascadeWeb.OrchestrationController.execute_dispatch(dispatch_id)

    assert duplicate.id == run.id
    assert Store.get(run.id).prompt =~ "include --verification when useful"
    refute Store.get(run.id).prompt =~ "You must evaluate the next useful step"
    refute Store.get(run.id).prompt =~ "You must evaluate the next useful step"

    assert SQL.one("SELECT COUNT(*) FROM runs WHERE chat_dispatch_id=?", [dispatch_id]) == [
             1
           ]

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [
             mission.mission.id
           ]) == [1]
  end

  defp eventually(fun, attempts \\ 200)
  defp eventually(fun, 0), do: assert(fun.())

  defp eventually(fun, attempts) do
    if fun.(),
      do: :ok,
      else:
        (
          Process.sleep(10)
          eventually(fun, attempts - 1)
        )
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
