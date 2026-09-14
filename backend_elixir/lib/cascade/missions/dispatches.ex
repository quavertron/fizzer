defmodule Cascade.Missions.Dispatches do
  @moduledoc "Durable, idempotent chat-to-agent dispatch outbox used by mission scheduling."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext, Schema}
  alias Cascade.Realtime.{Events, OrderedPublisher}
  alias Cascade.Runs.RunnerLifecycle

  @ambient_hops 15

  def create_for_message(user_id, channel_id, message) do
    if String.starts_with?(to_string(field(message, :id, "")), "sys-") do
      {:ok, []}
    else
      with {:ok, _route} <- Channel.assert_channel(channel_id, user_id),
           {:ok, members} <- Agents.list_members(channel_id, user_id) do
        targets =
          if clear_targets(field(message, :body, ""), members),
            do: [],
            else: resolve_targets(user_id, channel_id, message, members)

        Enum.reduce_while(targets, {:ok, []}, fn registration, {:ok, dispatches} ->
          case create(user_id, channel_id, message, registration.id) do
            {:ok, dispatch} -> {:cont, {:ok, dispatches ++ [dispatch]}}
            {:error, _} = error -> {:halt, error}
          end
        end)
      end
    end
  end

  def retract_pending_reply(dispatch_id) do
    SQL.transaction(fn ->
      reply_id = "agent-dispatch-#{dispatch_id}"

      with nil <- Cascade.Runs.Store.find_by_chat_dispatch(dispatch_id),
           [vault_id, channel_id] <-
             SQL.one(
               "SELECT vault_id,channel_id FROM chat_messages WHERE id=? AND run_id IS NULL",
               [reply_id]
             ) do
        SQL.exec("DELETE FROM chat_messages WHERE id=?", [reply_id])

        Events.emit(%{
          event: "vault:chatMessageDeleted",
          vaultId: vault_id,
          channelId: channel_id,
          messageId: reply_id
        })
      else
        _ -> :ok
      end
    end)
  end

  def create(user_id, channel_id, message, registration_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, members} <- Agents.list_members(channel_id, user_id),
         registration when not is_nil(registration) <-
           Enum.find(members, &(&1.id == registration_id)),
         true <- allowed?(user_id, registration, message) do
      Cascade.Chat.NextSteps.user_return(route.sourceChannelId, registration.id, message.id)

      effort = opts |> Keyword.get(:reasoning_effort, "") |> clean(20) |> String.downcase()

      SQL.transaction(fn ->
        conversation_id = admission_conversation(registration.id, message)

        SQL.exec(
          """
          INSERT OR IGNORE INTO chat_agent_dispatches
            (id,message_id,channel_id,registration_id,reasoning_effort,
             requester_user_id,requester_channel_id,conversation_id,target_owner_user_id,target_identity_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          """,
          [
            Ecto.UUID.generate(),
            message.id,
            route.sourceChannelId,
            registration.id,
            effort,
            user_id,
            channel_id,
            conversation_id,
            registration.ownerUserId,
            registration.vaultAgentId
          ]
        )
      end)

      Cascade.Missions.DispatchReannouncer.wake()

      case SQL.one(
             "SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at FROM chat_agent_dispatches WHERE message_id=? AND registration_id=?",
             [message.id, registration.id]
           ) do
        nil ->
          {:error, "Could not create chat agent dispatch"}

        row ->
          with {:ok, dispatch} <- hydrate(user_id, channel_id, row) do
            Cascade.Chat.Continuations.user_return(dispatch)
            {:ok, dispatch}
          end
      end
    else
      false -> {:error, "Agent not accepting this request"}
      nil -> {:error, "Agent not found"}
      {:error, _} = error -> error
    end
  rescue
    error in Exqlite.Error -> {:error, Exception.message(error)}
  end

  def list_pending(user_id, channel_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      dispatches =
        SQL.all(
          """
          SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at
          FROM chat_agent_dispatches
          WHERE channel_id=? AND run_id IS NULL AND failed_at IS NULL
          ORDER BY (SELECT rowid FROM chat_messages WHERE id=message_id),rowid
          """,
          [route.sourceChannelId]
        )
        |> Enum.reduce([], fn row, acc ->
          case hydrate(user_id, channel_id, row) do
            {:ok, dispatch}
            when dispatch.registration.ownerUserId == user_id or
                   dispatch.registration.pingableByOthers ->
              if Cascade.Chat.NextSteps.dispatch_ready?(dispatch),
                do: [dispatch | acc],
                else: acc

            _ ->
              acc
          end
        end)
        |> Enum.reverse()

      {:ok, dispatches}
    end
  end

  def get(user_id, channel_id, dispatch_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <-
           SQL.one(
             "SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at FROM chat_agent_dispatches WHERE id=? AND channel_id=?",
             [dispatch_id, route.sourceChannelId]
           ) do
      hydrate(user_id, channel_id, row)
    else
      nil -> {:error, "Chat dispatch not found"}
      {:error, _} = error -> error
    end
  end

  @doc "Returns durable pending work in message sequence, then admission order."
  def pending do
    SQL.all("""
    SELECT d.id,d.registration_id,m.mission_task_id,COALESCE(d.target_owner_user_id,va.owner_user_id)
    FROM chat_agent_dispatches d JOIN chat_messages m ON m.id=d.message_id
    JOIN chat_agent_members member ON member.id=d.registration_id
    JOIN vault_agents va ON va.id=member.vault_agent_id
    LEFT JOIN runs r ON r.chat_dispatch_id=d.id
    LEFT JOIN delegated_runs lease ON lease.run_id=r.id
    WHERE d.failed_at IS NULL AND
      ((d.run_id IS NULL AND (r.id IS NULL OR r.status<>'queued' OR lease.run_id IS NOT NULL)) OR
       (r.status='queued' AND lease.run_id IS NULL AND r.started_at < datetime('now','-30 seconds')))
    ORDER BY m.rowid,d.rowid
    """)
    |> Enum.map(fn [id, registration_id, task_id, owner_id] ->
      %{
        id: id,
        owner: owner_id,
        group:
          if(task_id in [nil, ""],
            do: {:registration, registration_id},
            else: {:mission, task_id}
          )
      }
    end)
  end

  def for_execution(dispatch_id) do
    with [nil, nil] <-
           SQL.one("SELECT failed_at,run_id FROM chat_agent_dispatches WHERE id=?", [dispatch_id]),
         {:ok, user_id, channel_id} <- requester(dispatch_id),
         {:ok, dispatch} <- get(user_id, channel_id, dispatch_id),
         true <- allowed?(user_id, dispatch.registration, dispatch.message),
         true <- target_unchanged?(dispatch),
         true <- present?(dispatch.conversationId),
         true <- mission_pending?(dispatch),
         true <- Cascade.Chat.Continuations.ready?(dispatch) do
      cond do
        interpretation_waiting_for_human?(dispatch) ->
          {:deferred, "Mission interpretation is waiting for queued human input to settle"}

        Cascade.Chat.NextSteps.dispatch_ready?(dispatch) ->
          {:ok, dispatch}

        true ->
          {:deferred, "Next-step checkpoint is waiting for idle work state or was disabled"}
      end
    else
      _ -> {:error, "Dispatch requester no longer has access to this agent or channel."}
    end
  end

  # A queued human turn would immediately steer this review. Let that turn
  # reconcile the same durable batch first; only acknowledgment retires the wake.
  # Check every execution refresh, including the transaction that starts the run.
  defp interpretation_waiting_for_human?(dispatch) do
    SQL.one(
      """
      SELECT 1 FROM chat_mission_interpretations i
      JOIN chat_agent_dispatches d ON d.registration_id=?
      JOIN chat_messages m ON m.id=d.message_id
      LEFT JOIN runs r ON r.chat_dispatch_id=d.id
      WHERE i.dispatch_id=? AND d.failed_at IS NULL
        AND COALESCE(m.registration_id,'')='' AND COALESCE(m.agent_id,'')=''
        AND COALESCE(m.mission_task_id,'')='' AND m.id NOT LIKE 'sys-%'
        AND ((d.run_id IS NULL AND r.id IS NULL) OR r.status IN ('queued','running'))
      LIMIT 1
      """,
      [dispatch.registration.id, dispatch.id]
    ) == [1]
  end

  defp target_unchanged?(dispatch) do
    owner = dispatch.registration.ownerUserId
    identity = dispatch.registration.vaultAgentId

    SQL.transaction(fn ->
      SQL.exec(
        "UPDATE chat_agent_dispatches SET target_owner_user_id=?,target_identity_id=? WHERE id=? AND target_owner_user_id IS NULL AND target_identity_id IS NULL",
        [owner, identity, dispatch.id]
      )

      SQL.one(
        "SELECT target_owner_user_id,target_identity_id FROM chat_agent_dispatches WHERE id=?",
        [dispatch.id]
      ) == [owner, identity]
    end)
  end

  defp mission_pending?(dispatch) do
    case field(dispatch.message, :missionTaskId) do
      task_id when is_binary(task_id) and task_id != "" ->
        SQL.one(
          "SELECT 1 FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id WHERE t.id=? AND t.dispatch_id=? AND t.status='pending' AND m.status NOT IN ('completed','canceled')",
          [task_id, dispatch.id]
        ) == [1]

      _ ->
        if String.contains?(dispatch.messageId, "-interpret-") and
             String.starts_with?(dispatch.messageId, "sys-mission-"),
           do: Cascade.Missions.Interpretation.keep_wake?(dispatch.id),
           else: true
    end
  end

  def allowed?(user_id, registration, message) do
    if present?(field(message, :registrationId)) or present?(field(message, :agentId)),
      do: registration.ownerUserId == user_id or registration.taggableByAgents,
      else: registration.ownerUserId == user_id or registration.pingableByOthers
  end

  def human?(dispatch) do
    not present?(field(dispatch.message, :registrationId)) and
      not present?(field(dispatch.message, :agentId)) and
      not present?(field(dispatch.message, :missionTaskId)) and
      not String.starts_with?(dispatch.messageId, "sys-")
  end

  def fail(dispatch_id, error) do
    OrderedPublisher.mutate(fn ->
      SQL.exec(
        "UPDATE chat_agent_dispatches SET error=?,failed_at=datetime('now') WHERE id=? AND run_id IS NULL",
        [error, dispatch_id]
      )

      message_id = "agent-dispatch-#{dispatch_id}"

      case SQL.one(
             "SELECT m.vault_id,m.channel_id,m.actor_user_id FROM chat_messages m JOIN chat_agent_dispatches d ON d.id=? AND d.channel_id=m.channel_id AND d.registration_id=m.registration_id WHERE m.id=? AND m.run_id IS NULL",
             [dispatch_id, message_id]
           ) do
        [vault_id, channel_id, owner_id] ->
          SQL.exec(
            "UPDATE chat_messages SET status='failed',body=? WHERE id=? AND run_id IS NULL",
            [error, message_id]
          )

          with {:ok, route} <- Cascade.Missions.Store.owner_route(owner_id, vault_id, channel_id),
               {:ok, message} <- Messages.get(route.localChannelId, owner_id, message_id) do
            Events.emit(%{
              event: "vault:chatMessageUpdated",
              vaultId: vault_id,
              channelId: channel_id,
              message: message
            })
          end

        _ ->
          :ok
      end
    end)
  end

  def retry(dispatch_id, error) do
    SQL.exec("UPDATE chat_agent_dispatches SET error=? WHERE id=? AND run_id IS NULL", [
      error,
      dispatch_id
    ])
  end

  defp requester(dispatch_id) do
    case SQL.one(
           "SELECT requester_user_id,requester_channel_id,message_id,channel_id,registration_id FROM chat_agent_dispatches WHERE id=?",
           [dispatch_id]
         ) do
      [user_id, channel_id, _, _, _] when is_integer(user_id) and is_binary(channel_id) ->
        {:ok, user_id, channel_id}

      [nil, nil, message_id, source_id, registration_id] ->
        # Only authenticated message provenance can repair a legacy admission.
        with [user_id] when is_integer(user_id) <-
               SQL.one("SELECT actor_user_id FROM chat_messages WHERE id=?", [message_id]),
             channel_id when not is_nil(channel_id) <- legacy_channel(user_id, source_id),
             {:ok, message} <- Messages.get(channel_id, user_id, message_id) do
          SQL.transaction(fn ->
            conversation_id = admission_conversation(registration_id, message)

            SQL.exec(
              "UPDATE chat_agent_dispatches SET requester_user_id=?,requester_channel_id=?,conversation_id=COALESCE(conversation_id,?) WHERE id=? AND requester_user_id IS NULL",
              [user_id, channel_id, conversation_id, dispatch_id]
            )
          end)

          {:ok, user_id, channel_id}
        else
          _ -> {:error, :unknown_requester}
        end

      _ ->
        {:error, :unknown_requester}
    end
  end

  defp legacy_channel(user_id, source_id) do
    [
      source_id
      | SQL.all(
          "SELECT local_channel_id FROM chat_channel_links WHERE source_channel_id=? ORDER BY rowid",
          [source_id]
        )
        |> List.flatten()
    ]
    |> Enum.find(&match?({:ok, _}, Channel.assert_channel(&1, user_id)))
  end

  defp admission_conversation(registration_id, message) do
    case field(message, :missionTaskId) do
      task_id when is_binary(task_id) and task_id != "" ->
        "mission:#{task_id}"

      _ when is_map(message) ->
        if String.starts_with?(message.id, ["sys-mission-", "sys-next-"]) do
          "mission-review:#{message.id}"
        else
          member_conversation(registration_id)
        end
    end
  end

  defp member_conversation(registration_id) do
    SQL.exec(
      "UPDATE chat_agent_members SET conversation_id=? WHERE id=? AND (conversation_id IS NULL OR trim(conversation_id)='')",
      [Ecto.UUID.generate(), registration_id]
    )

    case SQL.one("SELECT conversation_id FROM chat_agent_members WHERE id=?", [
           registration_id
         ]) do
      [id] -> id
      _ -> nil
    end
  end

  def attach_run(dispatch_id, run_id) when is_integer(run_id) and run_id > 0 do
    SQL.exec("UPDATE chat_agent_dispatches SET run_id=COALESCE(run_id,?),error=NULL WHERE id=?", [
      run_id,
      dispatch_id
    ])

    :ok
  end

  def attach_run(_dispatch_id, _run_id), do: {:error, "Invalid run id"}

  defp resolve_targets(user_id, channel_id, message, registrations) do
    from_agent = present?(field(message, :registrationId)) or present?(field(message, :agentId))

    if from_agent and is_map(field(message, :replyTo)) and
         present?(field(field(message, :replyTo), :relationship)) and
         RoomContext.relationship_depth(user_id, channel_id, message) > RoomContext.max_hops() do
      []
    else
      do_resolve_targets(user_id, channel_id, message, registrations, from_agent)
    end
  end

  defp do_resolve_targets(user_id, channel_id, message, registrations, from_agent) do
    reply = field(message, :replyTo) || %{}

    replied =
      case field(reply, :messageId) do
        id when is_binary(id) and id != "" ->
          case Messages.get(channel_id, user_id, id) do
            {:ok, item} -> item
            _ -> nil
          end

        _ ->
          nil
      end

    implicit_reply =
      if not from_agent and present?(field(reply, :mention)) and
           (is_nil(replied) or present?(field(replied, :registrationId))),
         do: "@#{field(reply, :mention)}",
         else: ""

    direct_source = message_source(message)
    has_direct_mention = Enum.any?(registrations, &mentions?(direct_source, &1))

    source =
      Enum.join(
        Enum.reject(
          [if(has_direct_mention, do: "", else: implicit_reply), direct_source],
          &(&1 == "")
        ),
        " "
      )

    explicit_ids =
      registrations
      |> Enum.filter(&mentions?(source, &1))
      |> MapSet.new(& &1.id)

    if compact_command?(direct_source, registrations) do
      compact_targets(user_id, channel_id, registrations, explicit_ids, from_agent)
    else
      normal_targets(user_id, message, registrations, explicit_ids, from_agent)
    end
  end

  defp normal_targets(user_id, message, registrations, explicit_ids, from_agent) do
    calls_specialist =
      Enum.any?(registrations, &(not &1.orchestrator and MapSet.member?(explicit_ids, &1.id)))

    selected =
      registrations
      |> Enum.reduce({[], MapSet.new()}, fn registration, {selected, seen} ->
        explicit = MapSet.member?(explicit_ids, registration.id)

        always =
          not from_agent and registration.ownerUserId == user_id and
            registration.replyToEveryMessage and
            not calls_specialist and
            reply_to_all_available?(registration)

        identity = registration.vaultAgentId || registration.id

        allowed =
          registration.id != field(message, :registrationId) and
            if(from_agent,
              do: registration.taggableByAgents,
              else: registration.ownerUserId == user_id or registration.pingableByOthers
            ) and
            (explicit or always) and not MapSet.member?(seen, identity)

        if allowed,
          do: {selected ++ [registration], MapSet.put(seen, identity)},
          else: {selected, seen}
      end)
      |> elem(0)

    if selected == [] and MapSet.size(explicit_ids) == 0 do
      ambient_target(user_id, message, registrations, from_agent)
    else
      selected
    end
  end

  defp ambient_target(user_id, message, registrations, from_agent) do
    chain = ambient_chain(field(message, :id), @ambient_hops)

    if length(chain) >= @ambient_hops do
      []
    else
      current = field(message, :registrationId)

      registrations
      |> Enum.with_index()
      |> Enum.filter(fn {registration, _index} ->
        registration.ambientGroupChat and registration.id != current and
          if(from_agent,
            do: registration.taggableByAgents,
            else: registration.ownerUserId == user_id or registration.pingableByOthers
          )
      end)
      |> Enum.min_by(
        fn {registration, index} ->
          {Enum.count(chain, &(&1 == registration.id)), index}
        end,
        fn -> nil end
      )
      |> case do
        {registration, _index} -> [registration]
        nil -> []
      end
    end
  end

  defp ambient_chain(message_id, remaining, registrations \\ [])
  defp ambient_chain(_message_id, 0, registrations), do: Enum.reverse(registrations)

  defp ambient_chain(message_id, remaining, registrations) do
    case SQL.one(
           "SELECT registration_id,run_id FROM chat_messages WHERE id=? LIMIT 1",
           [message_id]
         ) do
      [registration_id, run_id] ->
        next =
          if present?(registration_id), do: [registration_id | registrations], else: registrations

        case SQL.one(
               "SELECT d.message_id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id WHERE r.id=? LIMIT 1",
               [run_id]
             ) do
          [parent_id] -> ambient_chain(parent_id, remaining - 1, next)
          _ -> Enum.reverse(next)
        end

      _ ->
        Enum.reverse(registrations)
    end
  end

  # Explicit mentions remain authoritative. This only suppresses the automatic
  # reply-to-every-human-message path when the local provider account cannot run.
  defp reply_to_all_available?(%{agentId: agent_id, ownerUserId: owner_id})
       when agent_id in ["claude-code", "codex"] do
    usage = RunnerLifecycle.plan_usage(owner_id)[agent_id] || %{}

    not (field(usage, :usedPercent, 0) >= 100 and
           field(usage, :extraUsageAvailable) == false)
  rescue
    _ -> true
  end

  defp reply_to_all_available?(_registration), do: true

  def clear_targets(text, registrations) do
    if Regex.match?(~r/^\s*\/(clear|reset)\s*$/iu, strip_mentions(text, registrations)) do
      case Enum.filter(registrations, &mentions?(to_string(text), &1)) do
        [] -> registrations
        targets -> targets
      end
    end
  end

  defp compact_command?(text, registrations),
    do: Regex.match?(~r/^\s*\/compact\s*$/iu, strip_mentions(text, registrations))

  defp strip_mentions(text, registrations) do
    Enum.reduce(registrations, to_string(text), fn registration, acc ->
      mention = Schema.normalize_mention(registration.mention, registration.agentId)

      if mention == "" do
        acc
      else
        Regex.replace(
          Regex.compile!("@\\s*" <> Regex.escape(mention) <> "(?=$|[\\s.,:;!?\\])}])", "i"),
          acc,
          " "
        )
      end
    end)
  end

  defp compact_targets(user_id, channel_id, registrations, explicit_ids, from_agent) do
    candidates =
      if MapSet.size(explicit_ids) > 0 do
        Enum.filter(registrations, &MapSet.member?(explicit_ids, &1.id))
      else
        latest_agent =
          case Messages.list(channel_id, user_id, limit: 48) do
            {:ok, messages} ->
              messages
              |> Enum.reverse()
              |> Enum.find(
                &(present?(field(&1, :registrationId)) or present?(field(&1, :agentId)))
              )

            _ ->
              nil
          end

        case latest_agent do
          nil ->
            []

          message ->
            Enum.filter(registrations, fn registration ->
              registration.id == field(message, :registrationId) or
                (registration.agentId == field(message, :agentId) and
                   String.downcase(registration.displayName) ==
                     String.downcase(to_string(field(message, :author, ""))))
            end)
        end
      end

    candidates
    |> Enum.filter(fn registration ->
      registration.agentId == "claude-code" and
        registration.id != nil and
        if(from_agent,
          do: registration.taggableByAgents,
          else: registration.ownerUserId == user_id or registration.pingableByOthers
        )
    end)
    |> Enum.uniq_by(&(&1.vaultAgentId || &1.id))
  end

  defp message_source(message) do
    attachments =
      message
      |> field(:attachments, [])
      |> List.wrap()
      |> Enum.map(&field(&1, :name, ""))

    [field(message, :body, "") | attachments]
    |> Enum.map(&to_string/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join(" ")
  end

  defp mentions?(text, registration) do
    mention = Schema.normalize_mention(registration.mention, registration.agentId)

    mention != "" and
      Regex.match?(
        Regex.compile!("@\\s*" <> Regex.escape(mention) <> "(?=$|[\\s.,:;!?\\])}])", "i"),
        text
      )
  end

  defp hydrate(user_id, local_channel_id, [
         id,
         message_id,
         _source_channel_id,
         registration_id,
         run_id,
         reasoning_effort,
         created_at
       ]) do
    with {:ok, members} <- Agents.list_members(local_channel_id, user_id),
         registration when not is_nil(registration) <-
           Enum.find(members, &(&1.id == registration_id)),
         {:ok, message} <- Messages.get(local_channel_id, user_id, message_id),
         [requester_user_id, requester_channel_id, conversation_id, error] <-
           SQL.one(
             "SELECT requester_user_id,requester_channel_id,conversation_id,error FROM chat_agent_dispatches WHERE id=?",
             [id]
           ) do
      {:ok,
       %{
         id: id,
         messageId: message_id,
         channelId: local_channel_id,
         registration: registration,
         message: message,
         runId: run_id,
         reasoningEffort: reasoning_effort || "",
         createdAt: created_at,
         requesterUserId: requester_user_id,
         requesterChannelId: requester_channel_id,
         conversationId: conversation_id,
         error: error
       }}
    else
      _ -> {:error, "Chat dispatch not found"}
    end
  end

  defp clean(value, max) do
    value |> to_string() |> String.trim() |> String.slice(0, max)
  end

  defp field(map, key, fallback \\ nil)

  defp field(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))

  defp field(_map, _key, fallback), do: fallback
  defp present?(value), do: not is_nil(value) and String.trim(to_string(value)) != ""
end
