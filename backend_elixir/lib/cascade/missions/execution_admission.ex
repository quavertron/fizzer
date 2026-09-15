defmodule Cascade.Missions.ExecutionAdmission do
  @moduledoc "Operator-scoped recovery admission; exact persisted bindings, never date-based."
  alias Cascade.Accounts.SQL

  # Loaded once at boot from the operator's data directory, before any runner or
  # scheduler starts. Missing/malformed configured data must never become allow-all.
  def policy, do: Application.get_env(:cascade_elixir, :execution_admission)

  def restricted?(owner) do
    case policy() do
      nil -> false
      %{"owners" => owners} when is_list(owners) -> Enum.any?(owners, &(&1["ownerId"] == owner))
      _ -> true
    end
  end

  def task_allowed?(id) do
    case SQL.one("SELECT m.created_by FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id WHERE t.id=?", [id]) do
      [owner] -> not restricted?(owner) or scoped_task_allowed?(id)
      _ -> false
    end
  end

  defp scoped_task_allowed?(id) do
    case task_binding(id) do
      nil -> false
      binding ->
        owner = binding["ownerId"]
        not restricted?(owner) or Enum.any?(entries(owner), &matches?(&1, binding)) or
          workflow_allowed?(binding["missionId"])
    end
  end

  # This projection is also the immutable preview for repository-only recovery.
  def task_binding(id) do
    case SQL.one("""
         SELECT t.id,t.mission_id,t.work_item_id,t.assignee_registration_id,t.attempt,
           t.dispatch_id,m.created_by,m.vault_id,m.channel_id,va.id,va.owner_user_id
         FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
         JOIN chat_agent_members a ON a.id=t.assignee_registration_id AND a.channel_id=m.channel_id
         JOIN vault_agents va ON va.id=a.vault_agent_id
         JOIN work_items w ON w.id=t.work_item_id AND w.created_by=m.created_by
           AND w.vault_id=m.vault_id AND w.channel_id=m.channel_id
           AND w.source_kind='mission' AND w.source_id=t.id
         WHERE t.id=?
         """, [id]) do
      [task, mission, item, registration, attempt, dispatch, owner, vault, channel, identity, owner] ->
        %{"taskId" => task, "missionId" => mission, "workItemId" => item,
          "registrationId" => registration, "attempt" => attempt, "dispatchId" => dispatch,
          "ownerId" => owner, "vaultId" => vault, "channelId" => channel, "identityId" => identity}
      _ -> nil
    end
  end

  def dispatch_allowed?(id) do
    if policy() == nil, do: true, else: scoped_dispatch_allowed?(id)
  end

  defp scoped_dispatch_allowed?(id) do
    case SQL.one("""
         SELECT d.target_owner_user_id,msg.vault_id,msg.channel_id,msg.mission_task_id,
           d.target_identity_id,d.registration_id,t.dispatch_id
         FROM chat_agent_dispatches d JOIN chat_messages msg ON msg.id=d.message_id
         LEFT JOIN chat_mission_tasks t ON t.id=msg.mission_task_id
         WHERE d.id=?
         """, [id]) do
      [owner, vault, channel, task, identity, registration, linked] ->
        if restricted?(owner) do
          case task_binding(task) do
            %{"ownerId" => ^owner, "vaultId" => ^vault, "channelId" => ^channel,
              "identityId" => ^identity, "registrationId" => ^registration} ->
              linked == id and task_allowed?(task) and repository_ready?(task) and
                (workflow_task?(task) or SQL.one("SELECT yolo FROM chat_agent_members WHERE id=?", [registration]) == [0])
            _ -> coordinator_or_owner_dispatch?(id, owner, vault, channel, identity, registration)
          end
        else
          # Unpinned historical targets cannot bypass a scoped owner's boundary.
          not is_nil(owner) or policy() == nil
        end
      _ -> false
    end
  end

  def claim(id) do
    case SQL.one("SELECT target_owner_user_id FROM chat_agent_dispatches WHERE id=?", [id]) do
      [owner] ->
        cond do
          not dispatch_allowed?(id) -> {:retry, "Execution admission holds this original dispatch."}
          restricted?(owner) and not recovery_budget_available?(id, owner) -> {:retry, "Bounded recovery qualification start budget is exhausted; original work remains preserved for explicit continuation."}
          restricted?(owner) and active_count(owner) >= limit(owner) -> {:busy, "Waiting for an admitted owner execution slot."}
          true -> :ok
        end
      _ -> {:retry, "Execution admission cannot resolve this original dispatch."}
    end
  end

  def claim_allowed?(id), do: claim(id) == :ok

  # Optional bounded live qualification. This is deliberately separate from
  # concurrency and does not block genuine subsequent owner requests.
  defp recovery_budget_available?(dispatch, owner) do
    p = owner_policy(owner)
    case p["qualificationBudget"] do
      %{"afterRunId" => after_id, "maxStarts" => maximum} ->
        missions = Enum.map(p["workflows"] || [], & &1["missionId"])
        scoped = SQL.one("""
          SELECT m.id FROM chat_agent_dispatches d JOIN chat_messages msg ON msg.id=d.message_id
          JOIN chat_missions m ON m.id IN (SELECT value FROM json_each(?))
          WHERE d.id=? AND (msg.mission_task_id IN (SELECT id FROM chat_mission_tasks WHERE mission_id=m.id)
            OR msg.id LIKE 'sys-mission-' || m.id || '-%') LIMIT 1
          """, [Jason.encode!(missions), dispatch]) != nil
        [started] = SQL.one("SELECT COUNT(*) FROM runs WHERE owner_user_id=? AND id>?", [owner, after_id])
        not scoped or started < maximum
      nil -> true
      _ -> false
    end
  end

  def run_allowed?(id, owner) do
    if restricted?(owner) do
      retained = Enum.any?(owner_policy(owner)["retainedRuns"] || [], fn r ->
        r["runId"] == id and SQL.one("SELECT owner_user_id,vault_id,chat_dispatch_id FROM runs WHERE id=?", [id]) ==
          [owner, r["vaultId"], r["dispatchId"]]
      end)
      retained or case SQL.one("SELECT chat_dispatch_id,owner_user_id FROM runs WHERE id=?", [id]) do
        [dispatch, ^owner] when is_binary(dispatch) -> dispatch_allowed?(dispatch)
        _ -> false
      end
    else
      true
    end
  end

  # Coordinator wakes and unrelated maintenance may allocate fresh work. Existing
  # retained running jobs can settle, but do not confer permission for another run.
  def mission_wake_allowed?(id) do
    case SQL.one("SELECT created_by FROM chat_missions WHERE id=?", [id]) do
      [owner] -> not restricted?(owner) or workflow_allowed?(id)
      _ -> false
    end
  end

  # Admission follows the durable original objective, never a task creation date.
  # The sequence fence is an operator rollout boundary for NEW human requests;
  # old objectives require exact explicit root bindings. It does not grant tools,
  # approval, deployment, or access beyond the existing execution checks.
  def workflow_allowed?(id) do
    case SQL.one("SELECT created_by,vault_id,channel_id,root_message_id FROM chat_missions WHERE id=?", [id]) do
      [owner, vault, channel, root] ->
        explicit = Enum.any?(owner_policy(owner)["workflows"] || [], fn w ->
          w["missionId"] == id and w["vaultId"] == vault and w["channelId"] == channel and w["rootMessageId"] == root
        end)
        enrolled = not restricted?(owner) and SQL.one("SELECT id FROM chat_mission_events WHERE mission_id=? AND kind='workflow_enrolled' AND summary=? LIMIT 1", [id, root]) != nil
        explicit or enrolled or future_owner_message?(root, owner, vault, channel)
      _ -> false
    end
  end

  defp workflow_task?(task) do
    case SQL.one("SELECT mission_id FROM chat_mission_tasks WHERE id=?", [task]) do
      [mission] -> workflow_allowed?(mission)
      _ -> false
    end
  end

  defp future_owner_message?(id, owner, vault, channel) do
    case owner_policy(owner)["futureOwnerMessageAfterSeq"] do
      seq when is_integer(seq) and seq >= 0 ->
        SQL.one("""
        SELECT COUNT(*) FROM chat_messages msg
        WHERE msg.id=? AND msg.actor_user_id=? AND msg.vault_id=? AND msg.channel_id=? AND msg.rowid>?
          AND COALESCE(msg.agent_id,'')='' AND COALESCE(msg.registration_id,'')=''
          AND msg.author=(SELECT username FROM users WHERE id=?)
          AND NOT EXISTS (SELECT 1 FROM chat_mission_events e WHERE e.kind='task_notification'
            AND json_valid(e.summary) AND json_extract(e.summary,'$.messageId')=msg.id)
        """, [id, owner, vault, channel, seq, owner]) == [1]
      _ -> false
    end
  end

  defp coordinator_or_owner_dispatch?(id, owner, vault, channel, identity, registration) do
    binding = SQL.one("""
      SELECT va.owner_user_id FROM chat_agent_members a JOIN vault_agents va ON va.id=a.vault_agent_id
      WHERE a.id=? AND a.channel_id=? AND va.id=?
      """, [registration, channel, identity]) == [owner]
    binding and
      case SQL.one("""
        SELECT m.id FROM chat_missions m
        WHERE m.created_by=? AND m.vault_id=? AND m.channel_id=?
          AND m.coordinator_registration_id=?
          AND NOT EXISTS (SELECT 1 FROM chat_mission_interpretations stopped WHERE stopped.mission_id=m.id AND stopped.stopped=1)
          AND (EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.dispatch_id=?)
            OR EXISTS (SELECT 1 FROM chat_mission_events e WHERE e.mission_id=m.id AND e.kind='coordinator_dispatch' AND e.summary=?))
        """, [owner, vault, channel, registration, id, id]) do
        [mission] -> workflow_allowed?(mission)
        _ ->
          case SQL.one("SELECT message_id FROM chat_agent_dispatches WHERE id=?", [id]) do
            [message] -> future_owner_message?(message, owner, vault, channel)
            _ -> false
          end
      end
  end

  defp matches?(entry, binding) do
    Enum.all?(Map.delete(binding, "dispatchId"), fn {k, v} -> entry[k] == v end) and
      (is_nil(entry["dispatchId"]) or entry["dispatchId"] == binding["dispatchId"])
  end
  defp repository_ready?(task) do
    binding = task_binding(task)
    entry = Enum.find(entries(binding["ownerId"]), %{}, &matches?(&1, binding))
    case entry["requireRepository"] do
      nil -> true
      repository when is_binary(repository) ->
        SQL.one("SELECT repository FROM work_items WHERE id=?", [binding["workItemId"]]) == [repository]
      _ -> false
    end
  end
  defp owner_policy(owner), do: Enum.find((policy() || %{})["owners"] || [], %{}, &(&1["ownerId"] == owner))
  def constrain_prompt(prompt, owner) do
    case owner_policy(owner)["instructions"] do
      text when is_binary(text) and text != "" ->
        prompt <> "\n\n[Operator-scoped recovery constraints; no additional permissions granted]\n" <> text
      _ -> prompt
    end
  end
  defp entries(owner), do: owner_policy(owner)["tasks"] || []
  defp limit(owner), do: owner_policy(owner)["maxConcurrent"] || 0
  defp active_count(owner) do
    [n] = SQL.one("SELECT count(*) FROM runs WHERE owner_user_id=? AND status IN ('queued','running')", [owner])
    n
  end
end
