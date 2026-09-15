defmodule Cascade.Missions.Notifications do
  @moduledoc "Server-owned task receipts using the existing durable mission event outbox; no model dispatch."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages
  alias Cascade.Missions.Store
  alias Cascade.Realtime.OrderedPublisher

  # Do not replay every historical completed mission on deployment. Active backlog
  # is reconciled, and a committed receipt remains drainable after completion.
  def jobs do
    SQL.all("""
    SELECT m.id,m.created_by FROM chat_missions m
    WHERE m.status<>'canceled' AND NOT EXISTS (
      SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.stopped=1
    ) AND (m.status<>'completed' OR EXISTS (
      SELECT 1 FROM chat_mission_events e WHERE e.mission_id=m.id AND e.kind='task_notification'
        AND NOT EXISTS (SELECT 1 FROM chat_mission_events s WHERE s.source_key='task-notification-sent:' || e.id)
    ))
    """)
    |> Map.new(fn [id, owner] -> {{:notification, id}, owner} end)
  end

  def reconcile(id, events \\ Cascade.Realtime.Events) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(
        fn ->
          if allowed?(id) do
            case Store.notification_state(id) do
              %{mission: mission, tasks: tasks} ->
                Enum.each(tasks, fn task ->
                  if notice = notice(task, mission), do: save!(mission, task, notice)
                end)

              _ ->
                :ok
            end
          end
        end,
        mode: :immediate
      )

      flush(id, events)
    end)
  end

  defp allowed?(id) do
    SQL.one(
      """
      SELECT 1 FROM chat_missions m WHERE m.id=? AND m.status<>'canceled'
        AND NOT EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=m.id AND i.stopped=1)
      """,
      [id]
    ) == [1]
  end

  # Temporary capacity/ordinary dependencies remain waiting, never terminal
  # blockers. Only actionable attention warrants an unsolicited channel receipt.
  defp notice(%{evidence_ready: true} = t, _m),
    do:
      {"completed", "Task outcome recorded (not a claim that the whole objective is fulfilled).",
       t.summary}

  defp notice(%{status: status} = t, _m) when status in ~w(blocked failed),
    do:
      {status, "Task #{status}; further action is needed.",
       nonblank(
         t.summary,
         "No actionable reason was recorded; inspect the linked task/run and supply a concrete diagnosis before retrying."
       )}

  defp notice(%{status: "completed"}, _m),
    do:
      {"evidence-missing", "Completion is not verified.",
       "The recorded status lacks the bound execution/delivery evidence required by Fizzer. Review the task and supply real evidence; do not rerun completed actions blindly."}

  defp notice(%{status: "pending", dependency_attention: true} = t, _m),
    do:
      {"dependency-attention", "Waiting for a dependency that needs attention (not terminal).",
       Enum.join(t.waiting_for, ", ")}

  defp notice(%{status: "pending"} = t, m) do
    cond do
      Cascade.Missions.Interpretation.migration_decision_pending?(m.id) ->
        {"approval", "Waiting for the owner's migration decision (not terminal).",
         "Review the existing mission's migration decision before execution can proceed."}

      true ->
        case SQL.one(
               "SELECT error,failed_at FROM chat_agent_dispatches WHERE id=? AND TRIM(COALESCE(error,''))<>''",
               [t.dispatch_id]
             ) do
          [reason, failed] ->
            category = Cascade.Missions.Dispatches.waiting_kind(reason, failed)

            unless category == "capacity" do
              {category,
               "Dispatch #{if failed, do: "needs attention", else: "is waiting/retrying"} (task not marked terminal).",
               reason}
            end

          _ ->
            nil
        end
    end
  end

  defp notice(_, _), do: nil

  defp save!(m, t, {kind, label, detail}) do
    # One immutable receipt per task attempt and outcome category. Repeated
    # diagnostics/recovery sweeps do not become repeated chat posts.
    key = "task-notification:#{t.id}:#{t.attempt}:#{kind}"

    unless SQL.one("SELECT 1 FROM chat_mission_events WHERE source_key=?", [key]) do
      {:ok, route} = Store.owner_route(m.created_by, m.vault_id, m.channel_id)
      [username] = SQL.one("SELECT username FROM users WHERE id=?", [m.created_by])
      message_id = key

      body =
        "Fizzer task follow-up — #{t.title}\n\n#{label}\n#{String.slice(detail || "", 0, 1800)}\n\nTask: #{t.id} · attempt #{t.attempt}" <>
          if(t.run_id, do: " · run #{t.run_id}", else: "")

      {:ok, _} =
        Messages.create(
          %{id: m.created_by, username: username},
          route.localVaultId,
          route.localChannelId,
          %{
            id: message_id,
            author: "Fizzer task status",
            body: body,
            status: "completed",
            missionTaskId: t.id,
            replyTo: %{
              messageId: m.root_message_id,
              author: "",
              preview: "",
              relationship: "builds_on"
            }
          },
          access: :system
        )

      SQL.exec(
        "INSERT INTO chat_mission_events(mission_id,task_id,kind,summary,source_key) VALUES(?,?,'task_notification',?,?)",
        [m.id, t.id, Jason.encode!(%{messageId: message_id, category: kind}), key]
      )
    end
  end

  def flush(_id, Cascade.Chat.Events.Noop), do: :ok

  def flush(id, events) do
    if allowed?(id) do
      SQL.all(
        """
        SELECT e.id,json_extract(e.summary,'$.messageId'),m.created_by,m.vault_id,m.channel_id
        FROM chat_mission_events e JOIN chat_missions m ON m.id=e.mission_id
        WHERE m.id=? AND e.kind='task_notification' AND NOT EXISTS (
          SELECT 1 FROM chat_mission_events s WHERE s.source_key='task-notification-sent:' || e.id)
        ORDER BY e.id
        """,
        [id]
      )
      |> Enum.each(fn [event_id, message_id, owner, vault, channel] ->
        with true <- allowed?(id),
             {:ok, route} <- Store.owner_route(owner, vault, channel),
             {:ok, message} <- Messages.get(route.localChannelId, owner, message_id) do
          result =
            OrderedPublisher.chat(events, %{
              event: "vault:chatMessageCreated",
              vaultId: vault,
              channelId: channel,
              message: message
            })

          if match?({:error, _}, result), do: raise("Task notification fanout failed")

          SQL.exec(
            "INSERT OR IGNORE INTO chat_mission_events(mission_id,kind,summary,source_key) VALUES(?,'task_notification_sent',?,?)",
            [id, message_id, "task-notification-sent:#{event_id}"]
          )
        else
          _ -> :ok
        end
      end)
    end

    :ok
  end

  defp nonblank(value, fallback),
    do: if(String.trim(value || "") == "", do: fallback, else: value)
end
