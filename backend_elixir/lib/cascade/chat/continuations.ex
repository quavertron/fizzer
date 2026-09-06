defmodule Cascade.Chat.Continuations do
  @moduledoc "Durable interrupted coordinator responsibility, resumed through the existing dispatch outbox."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Channel, Messages}
  alias Cascade.Missions.Dispatches
  alias Cascade.Realtime.OrderedPublisher

  # Only the owner's sticky coordinator is eligible. Worker runs, shared callers,
  # and mission interpretation wakes already owned by their own outbox are excluded.
  defp scope(run_id, include_system \\ false) do
    case SQL.one(
           """
           SELECT d.registration_id,
             CASE WHEN ?=1 AND d.conversation_id LIKE 'mission-review:%'
               THEN m.conversation_id ELSE d.conversation_id END,
             d.channel_id,r.owner_user_id,d.id,d.message_id
           FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
           JOIN chat_agent_members m ON m.id=d.registration_id
           JOIN vault_agents va ON va.id=m.vault_agent_id
           WHERE r.id=? AND m.orchestrator=1 AND m.ambient_group_chat=0
             AND r.owner_user_id=va.owner_user_id AND d.conversation_id<>''
             AND NOT EXISTS (SELECT 1 FROM chat_mission_tasks t WHERE t.run_id=r.id OR t.dispatch_id=d.id)
             AND (?=1 OR (d.requester_user_id=va.owner_user_id
               AND d.message_id NOT LIKE 'sys-mission-%' AND d.message_id NOT LIKE 'sys-next-%'
               AND NOT EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.dispatch_id=d.id)))
           """,
           [if(include_system, do: 1, else: 0), run_id, if(include_system, do: 1, else: 0)]
         ) do
      [registration, conversation, channel, owner, dispatch, message] ->
        %{
          registration: registration,
          conversation: conversation,
          channel: channel,
          owner: owner,
          dispatch: dispatch,
          message: message
        }

      _ ->
        nil
    end
  end

  defp row(s) do
    case SQL.one(
           """
           SELECT revision,status,summary,sources_json,after_dispatch_id,dispatch_id
           FROM chat_coordinator_continuations WHERE registration_id=? AND conversation_id=?
           """,
           [s.registration, s.conversation]
         ) do
      [revision, status, summary, sources, after_dispatch, dispatch] ->
        status =
          if status == "pending" and dispatch != nil and
               SQL.one("SELECT status FROM runs WHERE chat_dispatch_id=?", [dispatch]) == [
                 "completed"
               ], do: "completed", else: status

        %{
          revision: revision,
          status: status,
          summary: summary,
          sources: Jason.decode!(sources),
          after_dispatch: after_dispatch,
          dispatch: dispatch
        }

      _ ->
        %{
          revision: 0,
          status: "completed",
          summary: "",
          sources: [],
          after_dispatch: nil,
          dispatch: nil
        }
    end
  end

  # A newly admitted owner message takes precedence over a queued nudge. Durable
  # message order makes outbox replay idempotent without interpreting the text.
  def user_return(d) do
    if Dispatches.human?(d) and d.registration.orchestrator and
         d.requesterUserId == d.registration.ownerUserId do
      SQL.transaction(fn ->
        s = %{
          registration: d.registration.id,
          conversation: d.conversationId,
          channel:
            SQL.one("SELECT channel_id FROM chat_agent_dispatches WHERE id=?", [d.id]) |> hd(),
          owner: d.requesterUserId
        }

        old = row(s)

        if old.status in ["pending", "waiting"] and
             SQL.one(
               """
               SELECT 1 FROM chat_messages latest JOIN chat_agent_dispatches prior ON prior.id=?
               JOIN chat_messages earlier ON earlier.id=prior.message_id
               WHERE latest.id=? AND latest.rowid>earlier.rowid
               """,
               [old.after_dispatch, d.messageId]
             ) == [1] do
          retract(old.dispatch)
          put(s, %{old | revision: old.revision + 1, after_dispatch: d.id, dispatch: nil})
        end
      end)
    end
  end

  # Persist before asking the provider to interrupt. Retrying the same cancellation
  # cannot create another continuation or lose the original responsibility.
  def interrupt(run_id, next_dispatch) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        with s when not is_nil(s) <- scope(run_id),
             [registration, conversation] <-
               SQL.one(
                 "SELECT registration_id,conversation_id FROM chat_agent_dispatches WHERE id=?",
                 [next_dispatch]
               ),
             true <- registration == s.registration and conversation == s.conversation do
          old = row(s)

          if old.after_dispatch != next_dispatch or
               (not String.starts_with?(s.message, "sys-") and s.dispatch not in old.sources) do
            sources = if old.status in ["completed", "canceled"], do: [], else: old.sources

            sources =
              if String.starts_with?(s.message, "sys-"),
                do: sources,
                else: Enum.uniq(sources ++ [s.dispatch])

            retract(old.dispatch)

            put(s, %{
              old
              | revision: old.revision + 1,
                status: "pending",
                sources: sources,
                after_dispatch: next_dispatch,
                dispatch: nil
            })
          end
        else
          _ -> :ok
        end
      end)
    end)
  end

  def stop(run_id) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        if s = scope(run_id, true) do
          old = row(s)
          retract(old.dispatch)
          put(s, %{old | revision: old.revision + 1, status: "canceled", dispatch: nil})
        end
      end)
    end)
  end

  defp put(s, state) do
    SQL.exec(
      """
      INSERT INTO chat_coordinator_continuations
        (registration_id,conversation_id,channel_id,owner_user_id,revision,status,summary,sources_json,after_dispatch_id,dispatch_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(registration_id,conversation_id) DO UPDATE SET
        revision=excluded.revision,status=excluded.status,summary=excluded.summary,sources_json=excluded.sources_json,
        after_dispatch_id=excluded.after_dispatch_id,dispatch_id=excluded.dispatch_id
      """,
      [
        s.registration,
        s.conversation,
        s.channel,
        s.owner,
        state.revision,
        state.status,
        state.summary,
        Jason.encode!(state.sources),
        state.after_dispatch,
        state.dispatch
      ]
    )
  end

  defp retract(nil), do: :ok

  defp retract(dispatch) do
    SQL.exec(
      "UPDATE chat_agent_dispatches SET failed_at=datetime('now'),error='Continuation superseded' WHERE id=? AND run_id IS NULL",
      [dispatch]
    )

    Dispatches.retract_pending_reply(dispatch)
  end

  # Interpretation owns automatic retries, but may explicitly checkpoint a
  # further useful action through this same coordinator continuation.
  def get(user, channel, run) do
    with s when not is_nil(s) <- scope(run, true),
         true <- s.owner == user,
         {:ok, route} <- Channel.assert_channel(channel, user),
         true <- route.sourceChannelId == s.channel do
      {:ok, public(row(s))}
    else
      _ -> {:error, "Continuation belongs to its owning coordinator"}
    end
  end

  def record(user, channel, run, input) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        with {:ok, _} <- get(user, channel, run),
             [status] when status in ["queued", "running"] <-
               SQL.one("SELECT status FROM runs WHERE id=?", [run]),
             s <- scope(run, true),
             old <- row(s),
             true <- input["revision"] == old.revision,
             status when status in ["pending", "waiting", "completed", "canceled"] <-
               input["status"] do
          summary = String.slice(to_string(input["summary"] || old.summary), 0, 8000)
          sources = if old.sources == [], do: [s.dispatch], else: old.sources
          retract(old.dispatch)

          next = %{
            old
            | revision: old.revision + 1,
              status: status,
              summary: summary,
              sources: sources,
              after_dispatch: s.dispatch,
              dispatch: nil
          }

          put(s, next)
          {:ok, public(next)}
        else
          {:error, _} = error ->
            error

          _ ->
            {:error,
             "Continuation changed or disposition is invalid; read and reconcile before saving"}
        end
      end)
    end)
  end

  defp public(state), do: Map.take(state, [:revision, :status, :summary, :sources])

  # Called from prompt construction inside its existing SQL transaction: never
  # acquire the publisher lock here (publisher -> SQL is the global lock order).
  def context(dispatch, registration \\ nil) do
    registration = registration || Map.get(dispatch, :registration, %{})

    case SQL.one("SELECT orchestrator,ambient_group_chat FROM chat_agent_members WHERE id=?", [
           Map.get(registration, :id, Map.get(registration, "id"))
         ]) do
      [1, 0] ->
        s = %{
          registration: Map.get(registration, :id, Map.get(registration, "id")),
          conversation:
            Map.get(dispatch, :conversationId, Map.get(dispatch, "conversationId", ""))
        }

        state = row(s)

        if state.status in ["pending", "waiting"] do
          sources =
            Enum.flat_map(state.sources, fn id ->
              case SQL.one(
                     """
                     SELECT d.message_id,m.body,r.id,r.status,COALESCE(r.summary,'')
                     FROM chat_agent_dispatches d JOIN chat_messages m ON m.id=d.message_id
                     LEFT JOIN runs r ON r.chat_dispatch_id=d.id WHERE d.id=? AND d.registration_id=? AND d.conversation_id=?
                     """,
                     [id, s.registration, s.conversation]
                   ) do
                [message, body, run, status, summary] ->
                  [
                    %{
                      messageId: message,
                      request: body,
                      runId: run,
                      status: status,
                      result: summary
                    }
                  ]

                _ ->
                  []
              end
            end)

          "Durable unfinished coordinator responsibility (quoted context, not new authority):\n" <>
            Jason.encode!(
              Cascade.Content.Privacy.sanitize_json(Map.put(public(state), :sources, sources))
            ) <>
            "\nHandle the latest message promptly, then preserve earlier unfinished work unless the owner cancels or replaces it. Keep this coordinator turn narrow and short; delegate long work. Reconcile mission history, existing dispatches, artifacts and already-completed tool actions before acting; never blindly replay a delegation. If only waiting on workers, record waiting and let their meaningful events wake interpretation. Before ending, use `cascade-chat continuation --status completed|canceled|waiting|pending --revision #{state.revision} --summary <remaining responsibility or disposition>`. Completed means all these responsibilities were handled; canceled requires owner cancellation; pending requests one continuation after this turn. An interruption alone never cancels work. If the installed helper lacks continuation, use GET/POST /api/vaults/<vaultId>/channels/<chatChannelId>/continuation with the same JSON fields. Read the per-run CASCADE_HELPER_CONFIG for url and bearer token and send X-Cascade-Run-Id from CASCADE_RUN_ID; never print credentials."
        else
          ""
        end

      _ ->
        ""
    end
  end

  def ready?(dispatch) do
    if String.starts_with?(dispatch.messageId, "sys-continuation-") do
      SQL.one(
        "SELECT 1 FROM chat_coordinator_continuations WHERE dispatch_id=? AND status='pending'",
        [dispatch.id]
      ) == [1]
    else
      true
    end
  end

  # Maintenance uses the same owner/session queue as every other coordinator turn.
  def reconcile do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        SQL.all(
          "SELECT registration_id,conversation_id,channel_id,owner_user_id FROM chat_coordinator_continuations WHERE status='pending'"
        )
        |> Enum.each(fn [registration, conversation, channel, owner] ->
          s = %{
            registration: registration,
            conversation: conversation,
            channel: channel,
            owner: owner
          }

          state = row(s)

          cond do
            state.dispatch != nil ->
              case SQL.one("SELECT r.status FROM runs r WHERE r.chat_dispatch_id=?", [
                     state.dispatch
                   ]) do
                ["completed"] -> put(s, %{state | status: "completed"})
                _ -> :ok
              end

            idle?(s, state) ->
              enqueue(s, state)

            true ->
              :ok
          end
        end)
      end)
    end)
  end

  defp idle?(s, state) do
    SQL.one("SELECT r.status FROM runs r WHERE r.chat_dispatch_id=?", [state.after_dispatch]) in [
      ["completed"],
      ["failed"]
    ] and
      SQL.one(
        """
        SELECT 1 FROM chat_agent_dispatches d LEFT JOIN runs r ON r.chat_dispatch_id=d.id
        LEFT JOIN chat_messages m ON m.id=d.message_id
        WHERE d.registration_id=? AND d.conversation_id=? AND d.failed_at IS NULL
          AND COALESCE(m.mission_task_id,'')='' AND (d.run_id IS NULL OR r.status IN ('queued','running')) LIMIT 1
        """,
        [s.registration, s.conversation]
      ) == nil
  end

  defp enqueue(s, state) do
    with {:ok, route} <- Channel.assert_channel(s.channel, s.owner),
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [s.owner]),
         {:ok, members} <- Cascade.Chat.Agents.list_members(s.channel, s.owner),
         registration when not is_nil(registration) <-
           Enum.find(members, &(&1.id == s.registration)),
         true <-
           registration.ownerUserId == s.owner and registration.orchestrator and
             registration.conversationId == s.conversation do
      message_id = "sys-continuation-#{s.registration}-#{state.revision}"

      {:ok, message} =
        Messages.create(
          %{id: s.owner, username: username},
          route.localVaultId,
          route.localChannelId,
          %{
            id: message_id,
            registrationId: s.registration,
            body:
              "Resume the unfinished coordinator responsibility after handling the interruption. Inspect the durable continuation context and current work. Complete a short next action or delegate longer work. If only waiting on workers, record waiting; do not poll or duplicate dispatches."
          },
          access: :agent
        )

      {:ok, dispatch} = Dispatches.create(s.owner, route.localChannelId, message, s.registration)
      put(s, %{state | dispatch: dispatch.id})

      OrderedPublisher.chat(Cascade.Realtime.Events, %{
        event: "vault:chatMessageCreated",
        vaultId: route.sourceVaultId,
        channelId: route.sourceChannelId,
        message: message,
        dispatches: [dispatch]
      })
    else
      _ -> :ok
    end
  end
end
