defmodule Cascade.Missions.InterpretationTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Missions.{Dispatches, Interpretation, Scheduler, Store}
  alias Cascade.Runs.Store, as: Runs

  setup do
    owner = Cascade.TestHelpers.owner_vault("interpretation")
    user = %{id: owner.user_id, username: owner.username}

    channel =
      Cascade.Content.Store.create_note(owner.vault_id, user.id, %{
        title: "Interpretation",
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
        body: "Implement and deliver the agreed behavior."
      })

    {:ok, update} =
      Store.create(
        user.id,
        owner.vault_id,
        channel.id,
        %{
          rootMessageId: root.id,
          coordinatorRegistrationId: coordinator.id,
          title: "Deliver behavior"
        },
        control_plane: true
      )

    {:ok, task} =
      Store.add_task(user.id, channel.id, update.mission.id, %{
        title: "Implementation",
        assignee: worker.id,
        coordinatorRegistrationId: coordinator.id
      })

    %{
      user: user,
      vault: owner.vault_id,
      channel: channel.id,
      coordinator: coordinator,
      mission: update.mission.id,
      task: task.task.id,
      worker: worker
    }
  end

  defp finding(c, summary, status \\ "running") do
    {:ok, _} =
      Store.update_task(c.user.id, c.channel, c.task, %{status: status, summary: summary})
  end

  defp run(c, dispatch) do
    {:ok, run} =
      Runs.start(c.vault, nil, "Interpret", "codex",
        owner_user_id: c.user.id,
        chat_dispatch_id: dispatch.id,
        conversation_id: dispatch.conversationId
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    run
  end

  defp state(c) do
    {:ok, state} = Interpretation.get(c.user.id, c.channel, c.mission, c.coordinator.id)
    state
  end

  defp record(c, run, fields, events \\ Cascade.Chat.Events.Noop) do
    current = state(c)

    input =
      Map.merge(%{"revision" => current.revision, "fingerprint" => current.fingerprint}, fields)

    result =
      Interpretation.record(c.user, c.channel, c.mission, c.coordinator.id, input, run.id, events)

    {result, input}
  end

  test "meaningful findings coalesce at admission while workers continue; quiet decisions stay quiet",
       c do
    [worker] = Scheduler.schedule(c.mission).dispatches
    worker_run = run(c, worker.dispatch)
    {:ok, _} = Store.attach_run(worker.dispatch.id, worker_run.id)
    assert Scheduler.schedule(c.mission).wakeDispatches == []
    Runs.publish(worker_run.id, "output", %{text: "routine tool activity"})
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    finding(c, "Found the missing publication acknowledgment; evidence: handler.ex")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    finding(c, "Publication and retry need the same durable message id; evidence: handler.ex")
    assert Scheduler.schedule(c.mission).wakeDispatches == []
    prompt = Interpretation.dispatch_prompt(wake.dispatch.id)
    assert prompt =~ "retry need the same durable message id"
    assert prompt =~ "workers keep running"
    refute Runs.get(worker_run.id).status in ~w(completed failed canceled)
    assert state(c).evidence["eventCursor"] > 0

    review = run(c, wake.dispatch)

    {{:ok, result}, _} =
      record(c, review, %{
        "assessment" => "Existing delivery already covers this finding",
        "noMaterialChange" => true
      })

    assert result.messageId == nil
    assert result.handledEventId > 0
    :ok = Runs.finish(review.id, "completed", "Nothing material to add")
    finding(c, "Publication and retry need the same durable message id; evidence: handler.ex")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    assert SQL.one("SELECT COUNT(*) FROM chat_messages WHERE id LIKE ?", [
             "mission-explanation-#{c.mission}-%"
           ]) == [0]
  end

  test "fresh and resumed interpretation share selective publication defaults", c do
    finding(c, "Local checks passed; worker is retrying delivery")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches

    for prompt <- [
          wake.message.body,
          Interpretation.dispatch_prompt(wake.dispatch.id),
          Interpretation.context(c.user.id, c.channel, c.coordinator.id)
        ] do
      assert prompt =~
               "Routine progress, retries and intermediate verification belong in the run trace"

      assert prompt =~ "direct answers, actionable owner blockers, significant findings"
      assert prompt =~ "already published the outcome"
      assert prompt =~ "noMaterialChange:true even when the saved assessment or evidence changes"
      assert prompt =~ "end with [no-reply]"
      assert prompt =~ "Do not hide real failures or leave owner questions unanswered"

      refute prompt =~
               "when the assessment, blocker, result or promised delivery materially changes"
    end

    review = run(c, wake.dispatch)

    {{:ok, result}, _} =
      record(c, review, %{
        "assessment" => "Checks passed; authorized retry continues without owner action",
        "evidenceReferences" => ["check:passed", "retry:running"],
        "questions" => [
          %{"id" => "delivery", "question" => "Is it deployed?", "status" => "open"}
        ],
        "noMaterialChange" => true
      })

    assert result.messageId == nil
    assert state(c).understanding["assessment"] =~ "authorized retry"
    assert state(c).understanding["evidenceReferences"] == ["check:passed", "retry:running"]
    assert [%{"id" => "delivery", "status" => "open"}] = state(c).understanding["questions"]
    assert state(c).fingerprint == ""
  end

  test "publication survives a lost fanout acknowledgment, retries once, preserves answers and links corrections",
       c do
    finding(c, "First evidence")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    review = run(c, wake.dispatch)

    {{:error, "interrupted fanout"}, input} =
      record(
        c,
        review,
        %{
          "assessment" => "Local implementation ready; delivery still open",
          "questions" => [
            %{
              "id" => "delivery",
              "question" => "Is it deployed?",
              "answer" => "Local only",
              "status" => "answered"
            }
          ],
          "evidenceReferences" => ["commit:abc"],
          "commitments" => [
            %{"id" => "ship", "summary" => "Report deployment result", "status" => "open"}
          ],
          "body" => "Implemented locally; deployment is still pending."
        },
        fn _ -> raise "interrupted fanout" end
      )

    [message_id] =
      SQL.one("SELECT publication_pending FROM chat_mission_interpretations WHERE mission_id=?", [
        c.mission
      ])

    assert is_binary(message_id)
    parent = self()

    assert {:ok, %{messageId: ^message_id}} =
             Interpretation.record(
               c.user,
               c.channel,
               c.mission,
               c.coordinator.id,
               input,
               review.id,
               fn event -> send(parent, {:published, event}) end
             )

    assert_receive {:published, %{message: %{id: ^message_id}}}

    assert [nil] ==
             SQL.one(
               "SELECT publication_pending FROM chat_mission_interpretations WHERE mission_id=?",
               [c.mission]
             )

    assert {:ok, _} =
             Interpretation.record(
               c.user,
               c.channel,
               c.mission,
               c.coordinator.id,
               input,
               review.id,
               fn event -> send(parent, {:published, event}) end
             )

    refute_receive {:published, _}

    assert {:error, _} =
             Interpretation.record(
               c.user,
               c.channel,
               c.mission,
               c.coordinator.id,
               Map.put(input, "assessment", "Conflicting stale write"),
               review.id,
               Cascade.Chat.Events.Noop
             )

    :ok = Runs.finish(review.id, "completed", "Published")

    finding(c, "Delivery failed due to missing capacity", "blocked")
    [next] = Scheduler.schedule(c.mission).wakeDispatches
    next_run = run(c, next.dispatch)

    {{:ok, corrected}, _} =
      record(c, next_run, %{
        "assessment" => "Delivery is now blocked",
        "body" => "Correction to my earlier assessment: delivery is blocked by capacity.",
        "correctsMessageId" => message_id,
        "questions" => [
          %{"id" => "next", "question" => "What clears capacity?", "status" => "open"}
        ]
      })

    assert state(c).understanding["questions"] |> Enum.any?(&(&1["answer"] == "Local only"))
    assert state(c).understanding["commitments"] |> length() == 1
    {:ok, message} = Messages.get(c.channel, c.user.id, corrected.messageId)
    assert message.replyTo["messageId"] == message_id
    assert message.replyTo["relationship"] == "contradiction"
    {:ok, original} = Messages.get(c.channel, c.user.id, message_id)
    assert original.body == "Implemented locally; deployment is still pending."
  end

  test "unacknowledged completed or failed interpretation retries with bounded backoff; Stop prevents retry and publication",
       c do
    finding(c, "Meaningful result")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    review = run(c, wake.dispatch)
    :ok = Runs.finish(review.id, "completed", "Ended without acknowledgment")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    SQL.exec(
      "UPDATE chat_mission_interpretations SET retry_after=datetime('now','-1 second') WHERE mission_id=?",
      [c.mission]
    )

    [retry] = Scheduler.schedule(c.mission).wakeDispatches
    refute retry.dispatch.id == wake.dispatch.id
    assert state(c).revision == 0
    rerun = run(c, retry.dispatch)
    :ok = Runs.finish(rerun.id, "failed", "Interrupted")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    SQL.exec(
      "UPDATE chat_mission_interpretations SET retry_after=datetime('now','-1 second') WHERE mission_id=?",
      [c.mission]
    )

    [last] = Scheduler.schedule(c.mission).wakeDispatches
    stopped = run(c, last.dispatch)
    Interpretation.stop_run(stopped.id)
    {{:error, _}, _} = record(c, stopped, %{"body" => "Must not be published"})
    :ok = Runs.finish(stopped.id, "canceled", "Explicit Stop")
    finding(c, "New finding after Stop")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    assert SQL.one("SELECT COUNT(*) FROM chat_messages WHERE id LIKE ?", [
             "mission-explanation-#{c.mission}-%"
           ]) == [0]
  end

  test "automatic completion leaves pending explanation dispatch executable and objective assessment independent",
       c do
    [worker] = Scheduler.schedule(c.mission).dispatches
    worker_run = run(c, worker.dispatch)
    {:ok, _} = Store.attach_run(worker.dispatch.id, worker_run.id)
    finding(c, "Build passed; delivery evidence pending")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    :ok = Runs.finish(worker_run.id, "completed", "Implemented and delivered")
    {:ok, _} = Scheduler.settle_run(worker_run.id, "completed", "Implemented and delivered")
    {:ok, update} = Store.get(c.user.id, c.channel, c.mission)
    assert update.mission.status == "completed"
    assert Interpretation.keep_wake?(wake.dispatch.id)
    assert {:ok, _} = Dispatches.for_execution(wake.dispatch.id)
    assert CascadeWeb.OrchestrationController.prepare_dispatch(wake.dispatch.id) != :discarded

    assert SQL.one("SELECT id FROM chat_agent_dispatches WHERE id=?", [wake.dispatch.id]) == [
             wake.dispatch.id
           ]

    prompt = Interpretation.dispatch_prompt(wake.dispatch.id)
    assert prompt =~ "Task completion is distinct from objective fulfillment"
    assert state(c).evidence["delivery"]["status"] == "completed"
    review = run(c, wake.dispatch)

    {{:ok, published}, _} =
      record(c, review, %{
        "assessment" => "Objective delivered with the stated limitation",
        "body" => "Delivered. Optional desktop QA was waived."
      })

    assert published.messageId != nil
    :ok = Runs.finish(review.id, "completed", "Explained")
    assert Scheduler.schedule(c.mission).wakeDispatches == []
  end

  test "overdue commitments trigger interpretation once and owner/worker boundaries stay authoritative",
       c do
    finding(c, "Work underway")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    review = run(c, wake.dispatch)

    {{:ok, _}, _} =
      record(c, review, %{
        "noMaterialChange" => true,
        "commitments" => [
          %{
            "id" => "report",
            "summary" => "Report the rollout",
            "status" => "open",
            "dueAt" => "2000-01-01T00:00:00Z"
          }
        ]
      })

    :ok = Runs.finish(review.id, "completed", "Saved")
    [overdue] = Scheduler.schedule(c.mission).wakeDispatches
    assert overdue.message.body =~ "Report the rollout"
    assert state(c).evidence["overdueCommitments"] |> length() == 1
    overdue_run = run(c, overdue.dispatch)
    {{:ok, _}, _} = record(c, overdue_run, %{"noMaterialChange" => true})
    :ok = Runs.finish(overdue_run.id, "completed", "Nothing new to explain")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    assert {:error, _} =
             Interpretation.get(c.user.id + 100_000, c.channel, c.mission, c.coordinator.id)

    assert {:error, _} = Interpretation.get(c.user.id, c.channel, c.mission, c.worker.id)

    {:ok, _} =
      Store.add_task(c.user.id, c.channel, c.mission, %{
        title: "Anonymous coordinator worker",
        assignee: c.coordinator.id,
        coordinatorRegistrationId: c.coordinator.id,
        anonymous: true
      })

    [worker] = Scheduler.schedule(c.mission).dispatches
    worker_run = run(c, worker.dispatch)
    {:ok, _} = Store.attach_run(worker.dispatch.id, worker_run.id)

    {{:error, _}, _} =
      record(c, worker_run, %{"assessment" => "Worker impersonating coordinator"})
  end

  test "retried interpretation reuses its persisted steering request instead of another worker side effect",
       c do
    finding(c, "Needs narrower scope")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    review = run(c, wake.dispatch)

    input = %{
      coordinatorRegistrationId: c.coordinator.id,
      message: "Use the existing artifact",
      attempt: 0,
      runId: nil
    }

    assert {:ok, id} =
             Store.request_steering(c.user.id, c.channel, c.task, input,
               current_run_id: review.id
             )

    :ok = Runs.finish(review.id, "failed", "Interrupted after steering")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    SQL.exec(
      "UPDATE chat_mission_interpretations SET retry_after=datetime('now','-1 second') WHERE mission_id=?",
      [c.mission]
    )

    [retry] = Scheduler.schedule(c.mission).wakeDispatches
    rerun = run(c, retry.dispatch)

    assert {:ok, ^id} =
             Store.request_steering(c.user.id, c.channel, c.task, input, current_run_id: rerun.id)

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='steering_requested'",
             [c.mission]
           ) == [1]
  end

  test "private objective, saved authority and evidence blocks are redacted before JSON enters a prompt",
       c do
    private = "Public intent\n:::private\nprivate-intent\n:::"

    SQL.exec(
      "UPDATE chat_missions SET objective=?,authority_json=? WHERE id=?",
      [private, Jason.encode!([%{id: "removed", body: private}]), c.mission]
    )

    finding(c, "Evidence\n:::private\nprivate-evidence\n:::")
    [wake] = Scheduler.schedule(c.mission).wakeDispatches
    refute wake.message.body =~ "private-intent"
    refute wake.message.body =~ "private-evidence"
    prompt = Interpretation.dispatch_prompt(wake.dispatch.id)
    refute prompt =~ "private-intent"
    refute prompt =~ "private-evidence"
    assert prompt =~ "Private block hidden from agents"
  end
end
