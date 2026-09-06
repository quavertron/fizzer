defmodule Cascade.Chat.NextStepsTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages, NextSteps, Schema}
  alias Cascade.Content.Store
  alias Cascade.Missions.{Authority, Dispatches}
  alias Cascade.Missions.Store, as: Missions

  setup do
    ctx = Cascade.TestHelpers.owner_vault("next-steps")
    user = %{id: ctx.user_id, username: ctx.username}

    channel =
      Store.create_note(ctx.vault_id, user.id, %{title: "Room", content: "cascade://chat-channel"})

    {:ok, identity} =
      Agents.upsert_identity(user.id, ctx.vault_id, %{agentId: "codex", mention: "astra"})

    {:ok, member} =
      Agents.add_to_channel(user.id, ctx.vault_id, channel.id, identity.id, %{orchestrator: true})

    {:ok, source} =
      Messages.create(user, ctx.vault_id, channel.id, %{
        body: "The updater failed again and interrupted my work."
      })

    Map.merge(ctx, %{
      user: user,
      channel: channel,
      identity: identity,
      member: member,
      source: source
    })
  end

  test "default off, owner-only, per-channel, survives schema repair and clears on demotion", c do
    refute c.member.nextStepSuggestions
    assert context(c) =~ "suggestions are off"
    enable(c)
    Schema.ensure!()
    {:ok, [saved]} = Agents.list_members(c.channel.id, c.user.id)
    assert saved.nextStepSuggestions

    other =
      Store.create_note(c.vault_id, c.user.id, %{
        title: "Other",
        content: "cascade://chat-channel"
      })

    {:ok, other_member} = Agents.add_to_channel(c.user.id, c.vault_id, other.id, c.identity.id)
    refute other_member.nextStepSuggestions
    stranger = Cascade.TestHelpers.owner_vault("next-stranger")

    assert {:error, _} =
             Agents.add_to_channel(stranger.user_id, c.vault_id, c.channel.id, c.identity.id, %{
               nextStepSuggestions: true
             })

    {:ok, updated} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{model: "test"})

    assert updated.nextStepSuggestions

    {:ok, demoted} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{
        orchestrator: false
      })

    refute demoted.nextStepSuggestions
  end

  test "upgrading existing registrations defaults off and preserves message cursors", c do
    SQL.exec("ALTER TABLE chat_agent_members DROP COLUMN next_step_suggestions")
    Schema.ensure!()
    {:ok, [member]} = Agents.list_members(c.channel.id, c.user.id)
    assert member.id == c.member.id
    refute member.nextStepSuggestions
    {:ok, source} = Messages.get(c.channel.id, c.user.id, c.source.id)
    assert source == c.source

    normalized =
      SQL.table_sql("chat_agent_members") |> String.replace(~r/\s+/, " ") |> String.trim()

    assert Base.encode16(:crypto.hash(:sha256, normalized), case: :lower) ==
             "cbad10329484a7a611ef7c9c5789bc88987431279e0fdd44d51817579d693676"
  end

  test "enabled opportunity has grounded evidence and bounded acceptance", c do
    enable(c)
    prompt = context(c)
    assert prompt =~ "fizzer-next:#{c.source.id}"
    assert prompt =~ "Do not suggest for weak evidence"
    assert prompt =~ "Actively discover worthwhile new opportunities"
    assert prompt =~ "do not require a supplied unresolved issue"
    assert prompt =~ "features, experiments and simplifications"
    assert prompt =~ "no tools that implement proposed work until owner acceptance"
    assert prompt =~ "Do not fabricate defects or optimize for spending tokens"
    refute prompt =~ "if the supplied evidence shows a concrete unresolved need"

    assert prompt =~
             "Natural-language acceptance by the owner authorizes only the proposed bounded task"

    assert prompt =~ "using the acceptance message as authority"
    assert prompt =~ "silence, decline"
    assert prompt =~ "[no-reply]"
    assert NextSteps.context(c.channel.id, c.member.id, "missing") =~ "Do not offer a new"

    assert NextSteps.context(c.channel.id, c.member.id, c.source.id, true) =~
             "suggestions are off"

    refute proposal(c).body == ""
  end

  test "default off and disablement suppress a generated suggestion at publication", c do
    assert proposal(c).body == ""
    enable(c)
    assert context(c) =~ "You may offer"
    enable(c, false)
    assert proposal(c).body == ""
    assert context(c) =~ "overrides earlier suggestion settings"
  end

  test "terminal projection publishes once and disablement preserves prior feedback", c do
    enable(c)
    input = proposal_input(c)

    {:ok, shell} =
      Messages.create(
        c.user,
        c.vault_id,
        c.channel.id,
        %{input | body: "Thinking...", status: "running"},
        access: :agent
      )

    projection =
      Cascade.Runs.ChatProjection.build([
        %{
          type: "status",
          payload_json: Jason.encode!(%{status: "completed", summary: input.body})
        }
      ])

    assert projection.status == nil

    {:ok, saved} =
      Messages.update(
        c.user,
        c.vault_id,
        c.channel.id,
        shell.id,
        %{body: projection.body, status: projection.status},
        access: :agent
      )

    assert saved.body == input.body
    enable(c, false)

    {:ok, repeated} =
      Messages.update(
        c.user,
        c.vault_id,
        c.channel.id,
        shell.id,
        %{body: projection.body, status: projection.status},
        access: :agent
      )

    assert repeated.body == input.body
    assert proposal(c).body == ""
    {:ok, human} = Messages.create(c.user, c.vault_id, c.channel.id, %{body: "[no-reply]"})
    assert human.body == "[no-reply]"
  end

  test "streaming, workers and ungrounded references cannot publish suggestions", c do
    enable(c)
    draft = proposal_input(c)
    assert NextSteps.prepare(%{draft | status: "running"}, c.channel.id).body == ""
    assert NextSteps.prepare(Map.put(draft, :missionTaskId, "worker"), c.channel.id).body == ""

    assert NextSteps.prepare(
             %{draft | body: "<!-- fizzer-next:missing --> Invented problem?"},
             c.channel.id
           ).body == ""
  end

  test "persisted proposal suppresses repeats and retains decline reasons after a cold start",
       c do
    enable(c)
    first = proposal(c)
    assert first.body =~ "Should fixing it be next?"
    assert proposal(c).body == ""
    assert context(c) =~ "Do not offer a new"

    {:ok, decline} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "No, leave it; I need the editor stable for a demo."
      })

    age(first)
    prompt = NextSteps.context(c.channel.id, c.member.id, decline.id)
    assert prompt =~ "Do not offer a new"
    assert prompt =~ "Should fixing it be next?"
    assert prompt =~ "I need the editor stable for a demo"
    assert proposal(c).body == ""
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [0]
  end

  test "acceptance uses the existing coordinator dispatch and owner authority record", c do
    enable(c)
    proposed = proposal(c)

    {:ok, accepted} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "Yes, fix it, but keep my editor open.",
        replyTo: %{messageId: proposed.id, author: "Astra", body: proposed.body}
      })

    assert {:ok, dispatches} = Dispatches.create_for_message(c.user.id, c.channel.id, accepted)
    assert Enum.any?(dispatches, &(&1.registration.id == c.member.id))
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [0]

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: accepted.id,
        coordinatorRegistrationId: c.member.id,
        title: "Fix updater",
        objective: "Fix the recurring updater failure; keep the editor open."
      })

    authority = Authority.context(mission.mission.id)
    assert authority =~ "Yes, fix it, but keep my editor open."
    assert authority =~ accepted.id
    assert authority =~ "Should fixing it be next?"
    assert authority =~ "bounded_proposal_context"
    assert authority =~ "not independent authority"
  end

  test "mission authority reconciles missing feedback through completion and context", c do
    enable(c)
    proposed = proposal(c)

    {:ok, accepted} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "Yes, fix it, but keep my editor open.",
        replyTo: %{messageId: proposed.id, author: "Astra", body: proposed.body}
      })

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: accepted.id,
        coordinatorRegistrationId: c.member.id,
        title: "Fix updater"
      })

    # No simulated provider feedback marker: exercise the actual mission link.
    assert SQL.one("SELECT feedback FROM chat_next_step_checks WHERE message_id=?", [proposed.id]) ==
             [nil]

    assert NextSteps.context(c.channel.id, c.member.id, accepted.id) =~ "Recorded accepted"

    {:ok, worker_identity} =
      Agents.upsert_identity(c.user.id, c.vault_id, %{agentId: "codex", mention: "worker"})

    {:ok, worker} = Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, worker_identity.id)

    {:ok, _} =
      Missions.add_task(c.user.id, c.channel.id, mission.mission.id, %{
        coordinatorRegistrationId: c.member.id,
        title: "Repair updater",
        prompt: "Accepted proposal unchanged:\n" <> proposed.body,
        assignee: worker.id
      })

    [%{dispatch: dispatch}] = Cascade.Missions.Scheduler.schedule(mission.mission.id).dispatches

    {:ok, run} =
      Cascade.Runs.Store.start(c.vault_id, nil, "repair", "codex", chat_dispatch_id: dispatch.id)

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Missions.attach_run(dispatch.id, run.id)
    :ok = Cascade.Runs.Store.finish(run.id, "completed", "Fixture worker result")
    {:ok, _} = Cascade.Missions.Scheduler.settle_run(run.id, "completed", "Fixture worker result")
    # Reproduce the pre-obligation deployment: plain owner authority and no check
    # row, with the accepted proposal carried unchanged in the worker handoff.
    SQL.exec("UPDATE chat_missions SET authority_json=? WHERE id=?", [
      Jason.encode!([%{id: accepted.id, body: accepted.body}]),
      mission.mission.id
    ])

    SQL.exec("DELETE FROM chat_next_step_checks WHERE message_id=?", [proposed.id])

    {:ok, completed} =
      Missions.finish(c.user.id, c.channel.id, mission.mission.id, %{
        summary: "Updater repaired",
        status: "completed",
        coordinatorRegistrationId: c.member.id,
        verification: "Regression passed"
      })

    assert completed.mission.status == "completed"
    trigger = "sys-next-completed-#{mission.mission.id}"
    prompt = NextSteps.context(c.channel.id, c.member.id, trigger)
    assert prompt =~ "You may offer"
    assert prompt =~ "Linked mission #{mission.mission.id}: completed"
    assert prompt =~ "keep my editor open"
    assert NextSteps.context(c.channel.id, c.member.id, trigger) == prompt
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [1]
    assert proposal(c).body == ""

    {:ok, deferred} =
      Messages.create(
        c.user,
        c.vault_id,
        c.channel.id,
        %{proposal_input(c) | body: "<!-- fizzer-next-none:#{trigger} --> No unresolved need."},
        access: :agent
      )

    assert deferred.body == "No unresolved need."

    assert SQL.one("SELECT outcome FROM chat_next_step_checks WHERE source_id=?", [trigger]) == [
             "none"
           ]
  end

  test "accepted feedback permits fresh evidence but never repeats the same evidence", c do
    enable(c)
    first = proposal(c)

    {:ok, accepted} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{body: "Yes, fix only that issue."})

    assert feedback(c, first, accepted, "accepted").body == "Understood."

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Other work"
      })

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [mission.mission.id])

    {:ok, fresh} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "A new build error is now blocking the release."
      })

    assert NextSteps.context(c.channel.id, c.member.id, fresh.id) =~ "You may offer"
    assert proposal(c).body == ""
    assert proposal(%{c | source: fresh}).body != ""
  end

  test "enablement queues one durable check per transition and disablement removes pending wakes",
       c do
    assert checks(c) == []
    enable(c)
    [[source, "enable", "pending"]] = checks(c)
    assert {:ok, pending} = Dispatches.list_pending(c.user.id, c.channel.id)
    assert Enum.count(pending, &(&1.messageId == source)) == 1
    enable(c)
    Schema.ensure!()
    assert checks(c) == [[source, "enable", "pending"]]
    assert NextSteps.context(c.channel.id, c.member.id, source) =~ "must evaluate"
    assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [0]
    enable(c, false)
    assert {:ok, []} = Dispatches.list_pending(c.user.id, c.channel.id)
    enable(c)
    assert length(checks(c)) == 2
  end

  test "misplaced checkpoint metadata preserves a substantive terminal reply on publication and replay",
       c do
    enable(c)
    body = "Desktop check blocked: no streaming response was visible."

    input = %{
      proposal_input(c)
      | body: body <> "\n\n<!-- fizzer-next-none:sys-mission-review -->"
    }

    {:ok, saved} = Messages.create(c.user, c.vault_id, c.channel.id, input, access: :agent)
    assert saved.body == body
    assert SQL.one("SELECT body FROM chat_messages WHERE id=?", [saved.id]) == [body]

    {:ok, replay} =
      Messages.update(c.user, c.vault_id, c.channel.id, saved.id, %{body: input.body},
        access: :agent
      )

    assert replay.body == body
  end

  test "no-suggestion reasons settle the checkpoint durably and survive projection retries", c do
    enable(c)

    input = %{
      proposal_input(c)
      | body:
          "<!-- fizzer-next-none:#{c.source.id} --> No unresolved need is supported by the available evidence."
    }

    {:ok, saved} = Messages.create(c.user, c.vault_id, c.channel.id, input, access: :agent)
    assert saved.body == "No unresolved need is supported by the available evidence."

    assert SQL.one("SELECT outcome,reason FROM chat_next_step_checks WHERE source_id=?", [
             c.source.id
           ]) == ["none", saved.body]

    Schema.ensure!()
    assert context(c) =~ "already checked"
    assert proposal(c).body == ""
    enable(c, false)

    {:ok, replay} =
      Messages.update(c.user, c.vault_id, c.channel.id, saved.id, %{body: input.body},
        access: :agent
      )

    assert replay.body == saved.body
  end

  test "owner return uses the existing dispatch and deduplicates its checkpoint", c do
    enable(c)
    {:ok, first} = Dispatches.create_for_message(c.user.id, c.channel.id, c.source)
    {:ok, second} = Dispatches.create_for_message(c.user.id, c.channel.id, c.source)
    assert Enum.map(first, & &1.id) == Enum.map(second, & &1.id)

    assert SQL.one("SELECT kind,outcome FROM chat_next_step_checks WHERE source_id=?", [
             c.source.id
           ]) == ["user_return", "pending"]

    agent_message = proposal(c)
    NextSteps.user_return(c.channel.id, c.member.id, agent_message.id)

    assert SQL.one("SELECT 1 FROM chat_next_step_checks WHERE source_id=?", [agent_message.id]) ==
             nil
  end

  test "completion checkpoint is durable, emitted through the scheduler, and has no hour gate",
       c do
    enable(c)

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Finished work"
      })

    # Isolate the scheduling boundary; mission closure evidence is tested by the mission suite.
    SQL.exec(
      "UPDATE chat_missions SET status='completed',summary='Verified the repair' WHERE id=?",
      [mission.mission.id]
    )

    {:ok, update} = Missions.refresh(mission.mission.id)
    receiver = self()
    events = fn event -> send(receiver, {:event, event}) end
    Cascade.Missions.Scheduler.emit_projection(update, events)
    source = "sys-next-completed-#{mission.mission.id}"
    assert_receive {:event, %{message: %{id: ^source}, dispatches: [dispatch]}}
    Cascade.Missions.Scheduler.emit_projection(update, events)

    assert SQL.one("SELECT COUNT(*) FROM chat_agent_dispatches WHERE message_id=?", [source]) == [
             1
           ]

    assert SQL.one("SELECT kind FROM chat_next_step_checks WHERE source_id=?", [source]) == [
             "completion"
           ]

    assert NextSteps.context(c.channel.id, c.member.id, source) =~ "must evaluate"
    assert proposal(%{c | source: %{id: source}}).body != ""
    assert dispatch.registration.id == c.member.id
  end

  test "decline feedback is durable and not cleared by time or unrelated completion", c do
    enable(c)
    first = proposal(c)

    {:ok, declined} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{
        body: "No, keep this stable for the demo."
      })

    reply = feedback(c, first, declined, "declined")
    assert reply.body == "Understood."

    assert SQL.one(
             "SELECT feedback,feedback_message_id FROM chat_next_step_checks WHERE message_id=?",
             [first.id]
           ) == ["declined", declined.id]

    age(first)
    Schema.ensure!()

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Unrelated"
      })

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [mission.mission.id])
    {:ok, fresh} = Messages.create(c.user, c.vault_id, c.channel.id, %{body: "I am back."})
    assert proposal(%{c | source: fresh}).body == ""
    assert NextSteps.context(c.channel.id, c.member.id, fresh.id) =~ "Recorded declined"

    input = %{
      proposal_input(%{c | source: fresh})
      | body:
          "<!-- fizzer-next:#{fresh.id} -->\n\nA separate build failure is blocking release. Should that repair be next?"
    }

    {:ok, unrelated} = Messages.create(c.user, c.vault_id, c.channel.id, input, access: :agent)
    assert unrelated.body == input.body
  end

  test "acceptance and redirect settle proposal feedback without starting work or waiting an hour",
       c do
    for decision <- ["accepted", "redirected"] do
      enable(c)

      {:ok, source} =
        Messages.create(c.user, c.vault_id, c.channel.id, %{
          body: "A new concrete issue blocks my work."
        })

      first = proposal(%{c | source: source})
      assert first.body != ""

      {:ok, accepted} =
        Messages.create(c.user, c.vault_id, c.channel.id, %{
          body: "Yes, only that bounded repair, and keep the editor open."
        })

      assert feedback(c, first, accepted, decision).body == "Understood."

      assert SQL.one("SELECT feedback FROM chat_next_step_checks WHERE message_id=?", [first.id]) ==
               [decision]

      assert SQL.one("SELECT COUNT(*) FROM chat_missions WHERE channel_id=?", [c.channel.id]) == [
               0
             ]
    end
  end

  test "agent evidence, workers and another channel cannot record owner feedback", c do
    enable(c)
    first = proposal(c)
    assert feedback(c, first, first, "accepted").body == ""

    other =
      Store.create_note(c.vault_id, c.user.id, %{
        title: "Other feedback",
        content: "cascade://chat-channel"
      })

    {:ok, foreign} = Messages.create(c.user, c.vault_id, other.id, %{body: "Yes"})
    assert feedback(c, first, foreign, "accepted").body == ""

    assert SQL.one("SELECT feedback FROM chat_next_step_checks WHERE message_id=?", [first.id]) ==
             [nil]

    {:ok, owner} = Messages.create(c.user, c.vault_id, c.channel.id, %{body: "Yes"})

    input =
      Map.put(proposal_input(c), :missionTaskId, "worker")
      |> Map.put(
        :body,
        "<!-- fizzer-next-feedback:#{first.id}:#{owner.id}:accepted --> Understood."
      )

    assert NextSteps.prepare(input, c.channel.id).body == ""
  end

  test "completion never silently resolves an unanswered proposal", c do
    enable(c)
    first = proposal(c)
    age(first)

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Other work"
      })

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [mission.mission.id])
    {:ok, update} = Missions.refresh(mission.mission.id)
    item = NextSteps.completion(update)
    assert proposal(%{c | source: item.message}).body == ""
    assert NextSteps.context(c.channel.id, c.member.id, item.message.id) =~ "outstanding"
  end

  test "one feedback event cannot be reinterpreted on retry and terminal text is preserved", c do
    enable(c)
    first = proposal(c)

    {:ok, owner} =
      Messages.create(c.user, c.vault_id, c.channel.id, %{body: "No, leave it alone."})

    recorded = feedback(c, first, owner, "declined")
    assert feedback(c, first, owner, "accepted").body == ""

    assert SQL.one("SELECT feedback FROM chat_next_step_checks WHERE message_id=?", [first.id]) ==
             ["declined"]

    assert SQL.one("SELECT outcome FROM chat_next_step_checks WHERE source_id=?", [owner.id]) == [
             "feedback"
           ]

    enable(c, false)

    {:ok, replay} =
      Messages.update(
        c.user,
        c.vault_id,
        c.channel.id,
        recorded.id,
        %{body: "<!-- fizzer-next-feedback:#{first.id}:#{owner.id}:declined --> Understood."},
        access: :agent
      )

    assert replay.body == recorded.body
  end

  test "enable HTTP boundary publishes the recoverable dispatch immediately", c do
    token = Cascade.Auth.Token.sign_user(Map.put(c.user, :auth_version, 0))
    receiver = self()

    response =
      Cascade.TestHelpers.json_conn(
        :post,
        "/api/vaults/#{c.vault_id}/channels/#{c.channel.id}/agents/from-vault",
        %{vaultAgentId: c.identity.id, nextStepSuggestions: true},
        token
      )
      |> Plug.Conn.assign(:domain_options,
        events: fn event -> send(receiver, {:enabled, event}) end
      )
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))

    assert response.status == 201
    assert_receive {:enabled, %{event: "vault:chatMessageCreated", dispatches: [dispatch]}}
    assert dispatch.registration.id == c.member.id
    assert String.starts_with?(dispatch.messageId, "sys-next-enable-")
    assert NextSteps.checkpoint_dispatch?(c.user.id, dispatch)
  end

  test "active work defers background checkpoints and records why", c do
    enable(c)
    [[source, "enable", "pending"]] = checks(c)
    {:ok, pending} = Dispatches.list_pending(c.user.id, c.channel.id)
    dispatch = Enum.find(pending, &(&1.messageId == source))
    assert NextSteps.dispatch_ready?(dispatch)

    {:ok, mission} =
      Missions.create(c.user.id, c.vault_id, c.channel.id, %{
        rootMessageId: c.source.id,
        coordinatorRegistrationId: c.member.id,
        title: "Current request"
      })

    refute NextSteps.dispatch_ready?(dispatch)
    assert {:ok, available} = Dispatches.list_pending(c.user.id, c.channel.id)
    refute Enum.any?(available, &(&1.id == dispatch.id))
    assert NextSteps.pending(c.channel.id, c.member.id, source) == nil
    NextSteps.announce_pending(c.member.id, fn event -> send(self(), {:deferred, event}) end)
    refute_receive {:deferred, _}

    assert {:deferred, _} = Dispatches.for_execution(dispatch.id)
    CascadeWeb.OrchestrationController.prepare_dispatch(dispatch.id)
    assert {:error, _} = Messages.get(c.channel.id, c.user.id, "agent-dispatch-#{dispatch.id}")

    assert SQL.one("SELECT outcome,reason FROM chat_next_step_checks WHERE source_id=?", [source]) ==
             ["pending", "Conversation/work state: waiting for active work to finish."]

    assert proposal(c).body == ""

    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [mission.mission.id])
    assert {:ok, available} = Dispatches.list_pending(c.user.id, c.channel.id)
    assert Enum.any?(available, &(&1.id == dispatch.id))
    assert NextSteps.pending(c.channel.id, c.member.id, source).dispatch.id == dispatch.id
  end

  defp checks(c),
    do:
      SQL.all(
        "SELECT source_id,kind,outcome FROM chat_next_step_checks WHERE channel_id=? AND registration_id=? ORDER BY rowid",
        [c.channel.id, c.member.id]
      )

  defp feedback(c, proposed, owner, disposition) do
    input = %{
      proposal_input(c)
      | body:
          "<!-- fizzer-next-feedback:#{proposed.id}:#{owner.id}:#{disposition} --> Understood."
    }

    {:ok, message} = Messages.create(c.user, c.vault_id, c.channel.id, input, access: :agent)
    message
  end

  defp age(message),
    do:
      SQL.exec(
        "UPDATE chat_messages SET created_at=datetime('now','-2 hours'),activity_at=datetime('now','-2 hours') WHERE id=?",
        [message.id]
      )

  defp enable(c, value \\ true) do
    {:ok, _} =
      Agents.add_to_channel(c.user.id, c.vault_id, c.channel.id, c.identity.id, %{
        nextStepSuggestions: value
      })
  end

  defp context(c), do: NextSteps.context(c.channel.id, c.member.id, c.source.id)

  defp proposal_input(c) do
    %{
      id: Ecto.UUID.generate(),
      body:
        "<!-- fizzer-next:#{c.source.id} -->\n\nThis keeps failing and interrupting you. Should fixing it be next?",
      status: "completed",
      registrationId: c.member.id,
      agentId: "codex",
      blocks: []
    }
  end

  defp proposal(c) do
    {:ok, message} =
      Messages.create(c.user, c.vault_id, c.channel.id, proposal_input(c), access: :agent)

    message
  end
end
