defmodule Cascade.Chat.Delegation do
  @moduledoc "Live identity-level admission for new delegated work, independent of its destination."
  alias Cascade.Accounts.SQL

  @reason "Missions and delegation are disabled for the source agent. Existing work and results are preserved."
  def reason, do: @reason

  def guidance,
    do:
      "Missions and delegation are disabled for this agent. Do authorized direct work and converse; do not open missions, delegate, invoke other agents or use native subagent tools. Preserve task facts, report progress/results, inspect history and honor Stop. Existing child results may still be joined and integrated."

  # Legacy credentials prove the owner, not a particular agent. They retain
  # delegation only while every identity for that owner permits it. Carry this
  # trusted source into queued dispatches so disabling later also fences replay.
  def legacy_source(owner), do: "legacy-owner:#{owner}"

  def enabled?("legacy-owner:" <> owner) do
    SQL.one("SELECT 1 FROM vault_agents WHERE owner_user_id=? AND missions_enabled=0 LIMIT 1", [
      owner
    ]) == nil
  end

  def enabled?(registration) do
    SQL.one(
      "SELECT va.missions_enabled FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=?",
      [registration]
    ) == [1]
  end

  def check(registration), do: if(enabled?(registration), do: :ok, else: {:error, @reason})

  def check!(registration) do
    case check(registration) do
      :ok -> :ok
      {:error, reason} -> raise ArgumentError, reason
    end
  end

  # HTTP callers pass only the source authenticated by Auth; internal scheduler
  # operations use the persisted coordinator/parent source instead.
  def check_actor!(opts) do
    case Keyword.fetch(opts, :source_registration) do
      {:ok, registration} -> check!(registration)
      :error -> :ok
    end
  end

  def source(coordinator, nil), do: coordinator

  def source(_coordinator, parent) do
    case SQL.one("SELECT assignee_registration_id FROM chat_mission_tasks WHERE id=?", [parent]) do
      [registration] -> registration
      _ -> nil
    end
  end

  def mission_enabled?(mission) do
    case SQL.one("SELECT coordinator_registration_id FROM chat_missions WHERE id=?", [mission]) do
      [registration] -> enabled?(registration)
      _ -> false
    end
  end

  def task_enabled?(task) do
    case SQL.one(
           """
           SELECT m.coordinator_registration_id,t.parent_task_id FROM chat_mission_tasks t
           JOIN chat_missions m ON m.id=t.mission_id WHERE t.id=?
           """,
           [task]
         ) do
      [coordinator, parent] -> enabled?(source(coordinator, parent))
      _ -> false
    end
  end

  # A resumed parent integrates already-started work; it is not a new delegation.
  def task_admitted?(task) do
    task_enabled?(task) or
      SQL.one(
        "SELECT 1 FROM chat_mission_events e JOIN chat_mission_tasks t ON t.id=e.task_id WHERE t.id=? AND e.kind='child_results_resume' AND e.source_key='child-results-resume:' || t.id || ':' || t.attempt LIMIT 1",
        [task]
      ) == [1]
  end

  def task_ready?(task) do
    if task_admitted?(task) do
      true
    else
      case SQL.one(
             "SELECT mission_id,attempt FROM chat_mission_tasks WHERE id=? AND status='pending'",
             [task]
           ) do
        [mission, attempt] ->
          key = "delegation-deferred:#{task}:#{attempt}"

          unless SQL.one("SELECT 1 FROM chat_mission_events WHERE source_key=?", [key]) do
            Cascade.Missions.Store.record_event(mission, %{
              task_id: task,
              kind: "delegation_deferred",
              summary: @reason,
              source_key: key
            })
          end

        _ ->
          :ok
      end

      false
    end
  end

  def message_check(message) do
    cond do
      present?(field(message, :missionTaskId)) ->
        if task_admitted?(field(message, :missionTaskId)), do: :ok, else: {:error, @reason}

      present?(field(message, :registrationId)) ->
        check(field(message, :registrationId))

      present?(field(message, :agentId)) ->
        {:error, "Delegated invocation requires a registered source agent"}

      true ->
        :ok
    end
  end

  def dispatch_source(message, existing_work) do
    cond do
      existing_work ->
        ""

      present?(field(message, :missionTaskId)) ->
        nil

      present?(field(message, :registrationId)) ->
        registration = field(message, :registrationId)

        if is_binary(registration) and String.starts_with?(registration, "legacy-owner:") do
          registration
        else
          case SQL.one("SELECT vault_agent_id FROM chat_agent_members WHERE id=?", [
                 field(message, :registrationId)
               ]) do
            [identity] -> identity
            _ -> nil
          end
        end

      true ->
        ""
    end
  end

  def dispatch_enabled?(id) do
    case SQL.one(
           """
           SELECT msg.mission_task_id,msg.registration_id,msg.agent_id,d.delegating_identity_id FROM chat_agent_dispatches d
           JOIN chat_messages msg ON msg.id=d.message_id WHERE d.id=?
           """,
           [id]
         ) do
      [task, registration, agent, source] ->
        cond do
          present?(task) ->
            task_admitted?(task)

          source == "" ->
            true

          is_binary(source) and String.starts_with?(source, "legacy-owner:") ->
            enabled?(source) and
              message_check(%{missionTaskId: task, registrationId: registration, agentId: agent}) ==
                :ok

          is_binary(source) ->
            SQL.one("SELECT missions_enabled FROM vault_agents WHERE id=?", [source]) == [1]

          existing_dispatch?(id) ->
            true

          true ->
            message_check(%{missionTaskId: task, registrationId: registration, agentId: agent}) ==
              :ok
        end

      _ ->
        false
    end
  end

  # A queued transport packet has not been acknowledged as running. Recheck
  # on both enqueue and drain; already-running work is never canceled here.
  def delivery_enabled?(run) do
    case SQL.one("SELECT status,chat_dispatch_id FROM runs WHERE id=?", [run]) do
      ["running", _] -> true
      ["queued", dispatch] when dispatch in [nil, ""] -> true
      ["queued", dispatch] -> dispatch_enabled?(dispatch)
      _ -> false
    end
  end

  def defer_delivery(run) do
    SQL.exec(
      """
      UPDATE chat_agent_dispatches SET error=?
      WHERE run_id=? AND failed_at IS NULL AND error IS NOT ?
        AND EXISTS(SELECT 1 FROM runs r WHERE r.id=? AND r.status='queued')
      """,
      [@reason, run, @reason, run]
    )
  end

  # Legacy server-created continuations are recognized by durable ownership,
  # never by a caller-controlled system-looking message id.
  defp existing_dispatch?(id) do
    SQL.one(
      """
      SELECT 1 WHERE EXISTS(SELECT 1 FROM chat_mission_events WHERE kind='coordinator_dispatch' AND summary=?)
        OR EXISTS(SELECT 1 FROM chat_mission_interpretations WHERE dispatch_id=?)
        OR EXISTS(SELECT 1 FROM chat_coordinator_continuations WHERE dispatch_id=?)
      """,
      [id, id, id]
    ) == [1]
  end

  # Bound claims are minted only from an owned, persisted run/dispatch, never
  # from a requested registration. Generic helper credentials remain unbound.
  def run_source(owner, run) do
    case SQL.one(
           """
           SELECT a.id,va.id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
           JOIN chat_agent_members a ON a.id=d.registration_id
           JOIN vault_agents va ON va.id=a.vault_agent_id
           WHERE r.id=? AND r.owner_user_id=? AND va.owner_user_id=?
             AND d.target_identity_id=va.id AND d.target_owner_user_id=va.owner_user_id
           """,
           [run, owner, owner]
         ) do
      [registration, identity] ->
        %{"runId" => run, "registrationId" => registration, "vaultAgentId" => identity}

      _ ->
        nil
    end
  end

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp present?(value), do: value not in [nil, ""]
end
