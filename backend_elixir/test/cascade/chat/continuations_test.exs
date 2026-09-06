defmodule Cascade.Chat.ContinuationsTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Continuations, Messages}
  alias Cascade.Missions.Dispatches
  alias Cascade.Runs.Store, as: Runs

  setup do
    owner = Cascade.TestHelpers.owner_vault("continuation")
    user = %{id: owner.user_id, username: owner.username}

    channel =
      Cascade.Content.Store.create_note(owner.vault_id, user.id, %{
        title: "Continuation",
        content: "cascade://chat-channel"
      })

    {:ok, coordinator} =
      Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "coordinator",
        orchestrator: true
      })

    %{user: user, vault: owner.vault_id, channel: channel.id, coordinator: coordinator}
  end

  defp dispatch(c, body) do
    {:ok, message} = Messages.create(c.user, c.vault, c.channel, %{body: body})
    {:ok, d} = Dispatches.create(c.user.id, c.channel, message, c.coordinator.id)
    d
  end

  defp run(c, d) do
    {:ok, r} =
      Runs.start(c.vault, nil, "Short coordinator turn", "codex",
        owner_user_id: c.user.id,
        chat_dispatch_id: d.id,
        conversation_id: d.conversationId
      )

    :ok = Dispatches.attach_run(d.id, r.id)
    r
  end

  defp state(c, r) do
    {:ok, state} = Continuations.get(c.user.id, c.channel, r.id)
    state
  end

  defp pending(c) do
    SQL.all(
      "SELECT d.id FROM chat_agent_dispatches d WHERE d.registration_id=? AND d.message_id LIKE 'sys-continuation-%' AND d.failed_at IS NULL AND d.run_id IS NULL",
      [c.coordinator.id]
    )
  end

  for outcome <- [:stop, :failed] do
    @outcome outcome
    test "captured mission creation has one recovery owner and #{@outcome} preserves the right fallback",
         c do
      original = dispatch(c, "Start the authorized mission")
      first = run(c, original)

      {:ok, mission} =
        Cascade.Missions.Store.create(
          c.user.id,
          c.vault,
          c.channel,
          %{
            rootMessageId: original.messageId,
            coordinatorRegistrationId: c.coordinator.id,
            title: "Interrupted setup"
          },
          agent: true,
          control_plane: true,
          current_run_id: first.id
        )

      followup = dispatch(c, "A short owner followup")
      Continuations.interrupt(first.id, followup.id)
      Runs.finish(first.id, "canceled", "Steered")
      Runs.publish(first.id, "status", %{status: "canceled", steering: true})
      second = run(c, followup)
      Runs.finish(second.id, "completed", "Answered")

      for _ <- 1..3 do
        Continuations.reconcile()
        assert Cascade.Missions.Scheduler.schedule(mission.mission.id).wakeDispatches == []
      end

      [[id]] = pending(c)
      {:ok, continuation} = Dispatches.get(c.user.id, c.channel, id)
      resumed = run(c, continuation)

      if @outcome == :stop do
        Continuations.stop(resumed.id)
        Runs.finish(resumed.id, "canceled", "Owner Stop")
        assert Cascade.Missions.Scheduler.schedule(mission.mission.id).wakeDispatches == []
      else
        Runs.finish(resumed.id, "failed", "Confirmed provider exit")
        assert Cascade.Missions.Scheduler.schedule(mission.mission.id).wakeDispatches == []
        Continuations.reconcile()
        [[retry_id]] = pending(c)
        {:ok, retry} = Dispatches.get(c.user.id, c.channel, retry_id)
        recovered = run(c, retry)
        Runs.finish(recovered.id, "failed", "Recovery also failed")
        Continuations.reconcile()
        [fallback] = Cascade.Missions.Scheduler.schedule(mission.mission.id).wakeDispatches
        assert fallback.message.body =~ "Continue this existing mission"
        assert Cascade.Missions.Scheduler.schedule(mission.mission.id).wakeDispatches == []
      end
    end
  end

  test "interruption preserves responsibility before cancel and resumes once after handling new message",
       c do
    original = dispatch(c, "Implement accepted work\n:::private\nprivate-responsibility\n:::")
    first = run(c, original)
    followup = dispatch(c, "Answer this brief question")
    Continuations.interrupt(first.id, followup.id)
    assert state(c, first).sources == [original.id]
    Continuations.reconcile()
    assert pending(c) == []
    Runs.finish(first.id, "canceled", "Steered")
    second = run(c, followup)
    Runs.finish(second.id, "completed", "Question answered")
    Continuations.reconcile()
    [[id]] = pending(c)
    Continuations.reconcile()
    assert pending(c) == [[id]]
    {:ok, continuation} = Dispatches.get(c.user.id, c.channel, id)
    prompt = Continuations.context(continuation)
    assert prompt =~ "Implement accepted work"
    refute prompt =~ "private-responsibility"
    assert prompt =~ "already-completed tool actions"
    assert prompt =~ "waiting on workers"
    resumed = run(c, continuation)
    Runs.finish(resumed.id, "completed", "Remaining work handled")
    # A new message arriving before the maintenance tick must not resurrect finished work.
    later = run(c, dispatch(c, "An unrelated new question"))
    assert state(c, later).status == "completed"
    Runs.finish(later.id, "completed", "Answered new question")
    Continuations.reconcile()
    assert state(c, resumed).status == "completed"
    assert pending(c) == []
  end

  test "repeated interruptions coalesce and the latest message supersedes a queued nudge", c do
    original = dispatch(c, "Original work")
    first = run(c, original)
    followup = dispatch(c, "First question")
    Continuations.interrupt(first.id, followup.id)
    Continuations.interrupt(first.id, followup.id)
    assert state(c, first).revision == 1
    Runs.finish(first.id, "canceled", "Steered")
    second = run(c, followup)
    latest = dispatch(c, "Second question")
    Continuations.interrupt(second.id, latest.id)
    Runs.finish(second.id, "canceled", "Steered")
    third = run(c, latest)
    assert state(c, third).sources == [original.id, followup.id]
    Runs.finish(third.id, "completed", "Handled latest")
    Continuations.reconcile()
    [[old]] = pending(c)
    newest = dispatch(c, "One more question")
    assert pending(c) == []
    assert {:error, _} = Dispatches.for_execution(old)
    fourth = run(c, newest)
    Runs.finish(fourth.id, "completed", "Handled newest")
    Continuations.reconcile()
    assert [[id]] = pending(c)
    refute id == old
  end

  for failure <- [:admission, :provider] do
    @failure failure
    test "#{@failure} failure gets one unattended continuation recovery, then exposes remaining responsibility",
         c do
      first = run(c, dispatch(c, "Carry out the accepted bounded request"))
      followup = dispatch(c, "Answer a brief question first")
      Continuations.interrupt(first.id, followup.id)
      Runs.finish(first.id, "canceled", "Steered")
      second = run(c, followup)
      Runs.finish(second.id, "completed", "Question answered")
      Continuations.reconcile()
      [[id]] = pending(c)
      {:ok, continuation} = Dispatches.get(c.user.id, c.channel, id)

      if @failure == :admission do
        Dispatches.fail(id, "Temporary admission failure")
      else
        resumed = run(c, continuation)
        Runs.finish(resumed.id, "failed", "Provider exited")
      end

      for _ <- 1..3, do: Continuations.reconcile()
      assert [[retry_id]] = pending(c)
      refute retry_id == id
      {:ok, retry} = Dispatches.get(c.user.id, c.channel, retry_id)
      assert Continuations.context(retry) =~ "accepted bounded request"
      assert Continuations.context(retry) =~ "already-completed tool actions"
      recovered = run(c, retry)
      Runs.finish(recovered.id, "failed", "Login renewal required")
      for _ <- 1..3, do: Continuations.reconcile()
      assert pending(c) == []
      remaining = state(c, recovered)
      assert remaining.status == "waiting"
      assert remaining.summary =~ "Login renewal required"
      assert remaining.summary =~ "recovery"
    end
  end

  test "explicit Stop cancels queued continuation without interpreting message text", c do
    first = run(c, dispatch(c, "Original work"))
    followup = dispatch(c, "This contains the word stop, but is only quoted evidence")
    Continuations.interrupt(first.id, followup.id)
    Runs.finish(first.id, "canceled", "Steered")
    second = run(c, followup)
    assert state(c, second).status == "pending"
    Runs.finish(second.id, "completed", "Answered")
    Continuations.reconcile()
    assert length(pending(c)) == 1
    assert Runs.cancel(second.id)
    assert state(c, second).status == "canceled"
    Continuations.reconcile()
    assert pending(c) == []
  end

  for outcome <- [:complete, :stop, :new_message] do
    @outcome outcome
    test "continuation recovery honors #{@outcome} without replaying settled work", c do
      first = run(c, dispatch(c, "Accepted finite work"))

      assert {:ok, _} =
               Continuations.record(c.user.id, c.channel, first.id, %{
                 "revision" => 0,
                 "status" => "pending",
                 "summary" => "One remaining action"
               })

      Runs.finish(first.id, "completed", "Checkpointed remaining action")
      Continuations.reconcile()
      [[id]] = pending(c)
      Dispatches.fail(id, "Admission failed")
      Continuations.reconcile()
      [[retry_id]] = pending(c)

      case @outcome do
        :complete ->
          {:ok, retry} = Dispatches.get(c.user.id, c.channel, retry_id)
          resumed = run(c, retry)
          current = state(c, resumed)

          assert {:ok, _} =
                   Continuations.record(c.user.id, c.channel, resumed.id, %{
                     "revision" => current.revision,
                     "status" => "completed",
                     "summary" => "Verified and published"
                   })

          Runs.finish(resumed.id, "completed", "Verified and published")
          assert state(c, resumed).status == "completed"

        :stop ->
          Continuations.stop(first.id)
          assert state(c, first).status == "canceled"
          assert {:error, _} = Dispatches.for_execution(retry_id)

        :new_message ->
          newest = dispatch(c, "Owner redirects the remaining action")
          assert {:error, _} = Dispatches.for_execution(retry_id)
          assert state(c, first).status == "pending"

          assert SQL.one(
                   "SELECT after_dispatch_id FROM chat_coordinator_continuations WHERE registration_id=?",
                   [c.coordinator.id]
                 ) == [newest.id]
      end

      for _ <- 1..3, do: Continuations.reconcile()
      assert pending(c) == []
    end
  end

  test "explicit waiting and completion reconcile existing dispatches without repeating work",
       c do
    first = run(c, dispatch(c, "Delegate implementation"))
    followup = dispatch(c, "Status?")
    Continuations.interrupt(first.id, followup.id)
    Runs.finish(first.id, "canceled", "Delegation already succeeded")
    second = run(c, followup)

    before_count =
      SQL.one("SELECT COUNT(*) FROM chat_agent_dispatches WHERE registration_id=?", [
        c.coordinator.id
      ])

    current = state(c, second)

    assert {:ok, waiting} =
             Continuations.record(c.user.id, c.channel, second.id, %{
               "revision" => current.revision,
               "status" => "waiting",
               "summary" => "Existing worker owns delivery; wait for findings"
             })

    assert {:error, conflict} =
             Continuations.record(c.user.id, c.channel, second.id, %{
               "revision" => current.revision,
               "status" => "pending"
             })

    assert conflict.currentRevision == waiting.revision
    assert conflict.changedFields == ["status"]
    assert conflict.changesSinceRevisionKnown == false
    assert state(c, second) == waiting

    Runs.finish(second.id, "completed", "Worker continues")
    Continuations.reconcile()
    assert pending(c) == []

    assert SQL.one("SELECT COUNT(*) FROM chat_agent_dispatches WHERE registration_id=?", [
             c.coordinator.id
           ]) == before_count

    assert state(c, second).revision == waiting.revision
  end

  test "foreign owners and worker runs cannot change coordinator responsibility", c do
    original = dispatch(c, "Original")
    first = run(c, original)
    followup = dispatch(c, "Question")
    Continuations.interrupt(first.id, followup.id)
    assert {:error, _} = Continuations.get(c.user.id + 1, c.channel, first.id)
    assert {:error, _} = Continuations.record(c.user.id + 1, c.channel, first.id, %{})

    {:ok, mission} =
      Cascade.Missions.Store.create(
        c.user.id,
        c.vault,
        c.channel,
        %{
          rootMessageId: original.messageId,
          coordinatorRegistrationId: c.coordinator.id,
          title: "Existing work"
        },
        control_plane: true
      )

    {:ok, task} =
      Cascade.Missions.Store.add_task(c.user.id, c.channel, mission.mission.id, %{
        coordinatorRegistrationId: c.coordinator.id,
        assignee: c.coordinator.id,
        anonymous: true,
        title: "Worker"
      })

    SQL.exec("UPDATE chat_mission_tasks SET run_id=?,dispatch_id=? WHERE id=?", [
      first.id,
      original.id,
      task.task.id
    ])

    assert {:error, _} =
             Continuations.record(c.user.id, c.channel, first.id, %{
               "revision" => 1,
               "status" => "canceled"
             })

    Continuations.stop(first.id)

    assert SQL.one("SELECT status FROM chat_coordinator_continuations WHERE registration_id=?", [
             c.coordinator.id
           ]) == ["pending"]
  end
end
