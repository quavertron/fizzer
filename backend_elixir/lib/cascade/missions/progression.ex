defmodule Cascade.Missions.Progression do
  @moduledoc "Durable bounded repair of enrolled workflows, independent of coordinator acknowledgment."
  alias Cascade.Accounts.SQL
  alias Cascade.Missions.{ExecutionAdmission, Store}

  # Runs inside the scheduler transaction. Existing task/work-item ownership,
  # dependency checks and outbox are reused; no independent run or model call.
  def reconcile(mission_id) do
    recover_startup(mission_id)
    SQL.all("""
      SELECT DISTINCT m.id,m.created_by,m.channel_id,m.coordinator_registration_id,
        r.id,r.assignee_registration_id,r.summary,p.assignee_registration_id,r.anonymous,p.anonymous
      FROM chat_missions m JOIN chat_mission_tasks r ON r.mission_id=m.id
      JOIN json_each(r.depends_on_json) dep
      JOIN chat_mission_tasks p ON p.id=dep.value AND p.mission_id=m.id
      WHERE m.phase='executing' AND m.status NOT IN ('completed','canceled')
        AND NOT EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.stopped=1)
        AND r.status='completed' AND r.purpose='review' AND r.review_outcome='changes_requested'
        AND p.purpose IN ('implementation','fix') AND p.status='completed'
        AND (r.anonymous=1 OR r.assignee_registration_id<>p.assignee_registration_id)
        AND (SELECT COUNT(DISTINCT source.assignee_registration_id) FROM json_each(r.depends_on_json) rd
          JOIN chat_mission_tasks source ON source.id=rd.value AND source.mission_id=m.id
          WHERE source.purpose IN ('implementation','fix'))=1
        AND (? IS NULL OR m.id=?)
        AND NOT EXISTS (SELECT 1 FROM chat_mission_tasks f JOIN json_each(f.depends_on_json) d
          WHERE f.mission_id=m.id AND f.purpose='fix' AND d.value=r.id)
      ORDER BY r.created_at,r.id
      """, [mission_id, mission_id])
    |> Enum.each(fn [mission, owner, channel, coordinator, review, reviewer, summary, implementer, review_anonymous, implementation_anonymous] ->
      if Cascade.Chat.Delegation.mission_enabled?(mission) and ExecutionAdmission.workflow_allowed?(mission) and not Cascade.Missions.Interpretation.migration_decision_pending?(mission) do
        [count] = SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='automatic_review_repair'", [mission])
        if count < 2 do
          {:ok, fix} = Store.add_task(owner, channel, mission, %{
            coordinatorRegistrationId: coordinator, title: "Resolve review #{review}",
            assignee: implementer, anonymous: implementation_anonymous == 1, purpose: "fix", workspaceMode: "isolated", dependsOn: [review],
            prompt: "Resolve this independent review in the inherited candidate workspace. Stay within the original owner scope; no new deployment or permission authority. Review #{review}:\n#{summary}"
          })
          {:ok, check} = Store.add_task(owner, channel, mission, %{
            coordinatorRegistrationId: coordinator, title: "Re-review #{review}",
            assignee: reviewer, anonymous: review_anonymous == 1, purpose: "review", workspaceMode: "isolated", dependsOn: [fix.task.id],
            prompt: "Independently verify the correction to review #{review}. Record reviewOutcome=accepted or changes_requested with actual evidence. Do not implement or deploy."
          })
          # Only untouched downstream integrations may be rewired. Preserve the
          # rejected review in ancestry; completion still requires fix + re-review.
          SQL.all("SELECT id,work_item_id,depends_on_json FROM chat_mission_tasks WHERE mission_id=? AND purpose='integration' AND status='pending' AND dispatch_id IS NULL", [mission])
          |> Enum.each(fn [id, item, encoded] ->
            deps = Jason.decode!(encoded)
            if review in deps do
              deps = Enum.map(deps, &if(&1 == review, do: check.task.id, else: &1))
              SQL.exec("UPDATE chat_mission_tasks SET depends_on_json=?,updated_at=datetime('now') WHERE id=?", [Jason.encode!(deps), id])
              items = Enum.map(deps, fn dependency ->
                [work] = SQL.one("SELECT work_item_id FROM chat_mission_tasks WHERE id=? AND mission_id=?", [dependency, mission])
                work
              end)
              {:ok, _} = Cascade.WorkItems.update(owner, item, %{dependsOn: items})
            end
          end)
          Store.record_event(mission, %{task_id: review, kind: "automatic_review_repair", title: "Review correction scheduled", summary: "Original implementation owner and independent reviewer retained; at most two automatic correction rounds."})
        else
          # A durable terminal blocker, not an unbounded retry or false completion.
          SQL.all("SELECT id FROM chat_mission_events WHERE mission_id=? AND task_id=? AND kind='automatic_review_repair_exhausted'", [mission, review])
          |> case do
            [] -> Store.record_event(mission, %{task_id: review, kind: "automatic_review_repair_exhausted", title: "Review correction needs owner attention", summary: "Two automatic correction rounds exhausted. The request is not delivered; coordinator must report this blocker, not retry indefinitely."})
            _ -> :ok
          end
        end
      end
    end)
  end

  # Only Execution's persisted never-delegated startup observation qualifies.
  # Arbitrary failed summaries/permission pauses never become retry authority.
  # Same task/work item/session, one automatic startup retry, normal admission.
  defp recover_startup(mission_id) do
    SQL.all("""
      SELECT m.id,m.created_by,m.channel_id,t.id,r.id
      FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
      JOIN runs r ON r.id=t.run_id
      JOIN chat_mission_events e ON e.task_id=t.id AND e.run_id=r.id
        AND e.kind='startup_interrupted' AND e.source_key='startup-interrupted:' || r.id
      WHERE t.status='failed' AND r.status='failed'
        AND m.phase IN ('planning','executing') AND m.status NOT IN ('completed','canceled')
        AND (? IS NULL OR m.id=?)
        AND NOT EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.stopped=1)
        AND NOT EXISTS (SELECT 1 FROM chat_mission_events done WHERE done.task_id=t.id AND done.kind='startup_recovered')
      """, [mission_id, mission_id])
    |> Enum.each(fn [mission, owner, channel, task, run] ->
      if Cascade.Chat.Delegation.task_enabled?(task) and ExecutionAdmission.workflow_allowed?(mission) and
           not Cascade.Missions.Interpretation.migration_decision_pending?(mission) do
        case Store.update_task(owner, channel, task, %{status: "pending",
          summary: "Recover confirmed pre-provider startup interruption; preserve existing workspace and accepted scope."}) do
          {:ok, _} -> Store.record_event(mission, %{task_id: task, run_id: run,
            kind: "startup_recovered", source_key: "startup-recovered:#{task}",
            summary: "One automatic retry of a never-delegated startup; same durable task and work item."})
          _ -> :ok
        end
      end
    end)
  end
end
