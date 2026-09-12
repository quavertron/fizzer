defmodule Cascade.Runs.Cancellation do
  @moduledoc "Coordinates owner-wide cancellation across runs and orchestration backlogs."
  alias Cascade.Accounts.SQL
  alias Cascade.Realtime.OrderedPublisher

  @doc "Stops the owner's current sessions and orchestration backlog, without changing agent settings."
  def cancel_all(owner_id) do
    {run_ids, updates, pending_count} =
      OrderedPublisher.mutate(fn ->
        SQL.transaction(fn ->
          registrations =
            "SELECT cm.id FROM chat_agent_members cm JOIN vault_agents va ON va.id=cm.vault_agent_id WHERE va.owner_user_id=?"

          updates =
            SQL.all(
              "SELECT id,channel_id,coordinator_registration_id FROM chat_missions WHERE created_by=? AND status NOT IN ('completed','canceled') AND coordinator_registration_id IN (#{registrations})",
              [owner_id, owner_id]
            )
            |> Enum.map(fn [id, channel, coordinator] ->
              {:ok, update} =
                Cascade.Missions.Store.finish(owner_id, channel, id, %{
                  coordinatorRegistrationId: coordinator,
                  status: "canceled",
                  summary: "Stopped all work by user."
                })

              update
            end)

          SQL.exec(
            "UPDATE chat_mission_interpretations SET stopped=1 WHERE mission_id IN (SELECT id FROM chat_missions WHERE coordinator_registration_id IN (#{registrations}))",
            [owner_id]
          )

          SQL.exec(
            "UPDATE chat_coordinator_continuations SET status='canceled',revision=revision+1 WHERE owner_user_id=? AND status IN ('pending','waiting')",
            [owner_id]
          )

          SQL.exec(
            "UPDATE chat_next_step_checks SET outcome='canceled',reason='Stopped all work by user.' WHERE outcome='pending' AND registration_id IN (#{registrations})",
            [owner_id]
          )

          pending =
            SQL.all(
              "SELECT id FROM chat_agent_dispatches WHERE run_id IS NULL AND failed_at IS NULL AND COALESCE(target_owner_user_id,(SELECT va.owner_user_id FROM chat_agent_members cm JOIN vault_agents va ON va.id=cm.vault_agent_id WHERE cm.id=registration_id))=?",
              [owner_id]
            )

          Enum.each(pending, fn [id] ->
            Cascade.Missions.Dispatches.fail(id, "Stopped all work by user.")
            Cascade.Missions.Dispatches.retract_pending_reply(id)
          end)

          runs =
            SQL.all(
              "SELECT id FROM runs WHERE owner_user_id=? AND status IN ('queued','running')",
              [owner_id]
            )
            |> List.flatten()

          {runs, updates, length(pending)}
        end)
      end)

    # Desktop cancellation must happen outside the database/publisher lock.
    stopped = Enum.count(run_ids, &Cascade.Runs.Store.cancel(&1, force: true))

    Enum.each(updates, fn update ->
      Cascade.Missions.Scheduler.emit_projection(update, Cascade.Realtime.Events)

      Enum.each(Map.get(update, :removedWakeMessageIds, []), fn id ->
        Cascade.Realtime.Events.emit(%{
          event: "vault:chatMessageDeleted",
          vaultId: update.vaultId,
          channelId: update.channelId,
          messageId: id
        })
      end)
    end)

    %{
      stopped: stopped,
      missions: length(updates),
      pending: pending_count,
      failed: length(run_ids) - stopped
    }
  end

end
