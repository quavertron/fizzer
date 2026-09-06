defmodule Cascade.Missions.Scheduler do
  @moduledoc "Materializes ready mission tasks and idempotent coordinator review wakes into the dispatch outbox."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Events, Messages}
  alias Cascade.Missions.{Dispatches, Store}
  alias Cascade.Realtime.OrderedPublisher

  def schedule(mission_id \\ nil, opts \\ []) do
    OrderedPublisher.mutate(fn -> do_schedule(mission_id, opts) end)
  end

  defp do_schedule(mission_id, opts) do
    result =
      SQL.transaction(fn ->
        Cascade.Missions.Recovery.reconcile(mission_id)
        Cascade.Missions.Children.resume_ready(mission_id)
        scheduled = Store.schedulable(mission_id)
        dispatches = Enum.map(scheduled.candidates, &materialize_candidate!/1)

        affected =
          (Enum.map(scheduled.updates, & &1.mission.id) ++
             Enum.map(scheduled.candidates, & &1.missionId) ++
             if(mission_id,
               do: [mission_id],
               else:
                 SQL.all(
                   "SELECT id FROM chat_missions WHERE status<>'canceled' AND (status<>'completed' OR EXISTS (SELECT 1 FROM chat_mission_interpretations i WHERE i.mission_id=chat_missions.id AND i.stopped=0))"
                 )
                 |> Enum.map(&hd/1)
             ))
          |> Enum.uniq()

        wakes =
          Enum.flat_map(affected, fn id ->
            case Store.claim_wake(id) do
              {:ok, nil} -> []
              {:ok, wake} -> [wake]
              _ -> []
            end
          end)

        wake_dispatches = Enum.map(wakes, &materialize_wake!/1)

        final_update =
          if mission_id do
            case Store.refresh(mission_id) do
              {:ok, update} -> update
              _ -> nil
            end
          end

        Map.merge(scheduled, %{
          dispatches: dispatches,
          wakes: wakes,
          wakeDispatches: wake_dispatches,
          finalUpdate: final_update
        })
      end)

    events = Keyword.get(opts, :events) || Cascade.Chat.Events.Noop
    Enum.each(result.updates, &emit_projection(&1, events))

    Enum.each(result.dispatches, fn item ->
      emit_message(item.update, "vault:chatMessageCreated", item.message, [item.dispatch], events)
      emit_projection(item.update, events)
    end)

    Enum.zip(result.wakes, result.wakeDispatches)
    |> Enum.each(fn {wake, item} -> emit_wake(wake, item, events) end)

    if result.finalUpdate, do: emit_projection(result.finalUpdate, events)

    ids =
      if mission_id,
        do: [mission_id],
        else:
          SQL.all(
            "SELECT mission_id FROM chat_mission_interpretations WHERE publication_pending IS NOT NULL"
          )
          |> List.flatten()

    Enum.each(ids, &Cascade.Missions.Interpretation.flush(&1, events))
    result
  end

  def emit_projection(update, events \\ Cascade.Chat.Events.Noop) do
    events = events || Cascade.Chat.Events.Noop

    case Store.root_message(update) do
      {:ok, message} -> emit_message(update, "vault:chatMessageUpdated", message, [], events)
      _ -> :ok
    end
  end

  @doc "Settles a terminal worker run and schedules newly-ready work and durable review wakes."
  def settle_run(run_id, status, summary, opts \\ []) do
    OrderedPublisher.mutate(fn ->
      with {:ok, settled} <- Store.settle_run(run_id, status, summary) do
        if is_nil(settled) do
          {:ok, nil}
        else
          scheduled = do_schedule(settled.update.mission.id, opts)

          {:ok,
           %{
             settled: settled,
             scheduled: scheduled,
             wakeDispatch: List.first(scheduled.wakeDispatches)
           }}
        end
      end
    end)
  end

  @doc "Atomically materializes a ready coordinator review wake, ignoring stale or repeated requests."
  def enqueue_wake(wake, opts \\ []) do
    OrderedPublisher.mutate(fn ->
      result =
        SQL.transaction(fn ->
          case Store.claim_wake(wake.mission.id) do
            {:ok, current} when not is_nil(current) ->
              if current.generation == wake.generation,
                do: {current, materialize_wake!(current)}

            _ ->
              nil
          end
        end)

      case result do
        {current, item} ->
          emit_wake(current, item, Keyword.get(opts, :events) || Cascade.Chat.Events.Noop)
          {:ok, item}

        nil ->
          {:ok, nil}
      end
    end)
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp materialize_candidate!(candidate) do
    user = user!(candidate.createdBy)
    {:ok, route} = Store.owner_route(candidate.createdBy, candidate.vaultId, candidate.channelId)

    assignee_mention =
      assignee_mention(
        route.localChannelId,
        candidate.createdBy,
        candidate.assigneeRegistrationId
      )

    message_id =
      if candidate.attempt > 0,
        do: "mission-task-#{candidate.taskId}-#{candidate.attempt}",
        else: "mission-task-#{candidate.taskId}"

    {:ok, message} =
      Messages.create(
        user,
        route.localVaultId,
        route.localChannelId,
        %{
          id: message_id,
          body:
            "@#{assignee_mention} #{candidate.prompt}\n\n#{Cascade.Missions.Authority.context(candidate.missionId)}",
          createdAt: now(),
          registrationId: candidate.coordinatorRegistrationId,
          missionTaskId: candidate.taskId
        },
        access: :agent
      )

    {:ok, dispatch} =
      Dispatches.create(
        candidate.createdBy,
        route.localChannelId,
        message,
        candidate.assigneeRegistrationId,
        reasoning_effort: candidate.reasoningEffort
      )

    {:ok, update} = Store.link_dispatch(candidate.taskId, dispatch.id)
    %{message: message, dispatch: dispatch, update: update}
  end

  defp materialize_wake!(wake) do
    SQL.exec(
      "UPDATE chat_missions SET wake_sent=1,updated_at=datetime('now') WHERE id=?",
      [wake.mission.id]
    )

    carrier_id = "agent-trace-#{wake.mission.id}-#{wake.generation}"
    message_id = "sys-mission-#{wake.mission.id}-#{wake.generation}"
    user = user!(wake.createdBy)
    {:ok, route} = Store.owner_route(wake.createdBy, wake.vaultId, wake.channelId)

    body =
      if Map.has_key?(wake, :interpretation) do
        Cascade.Missions.Interpretation.prompt(wake)
      else
        """
        @#{wake.mission.coordinatorMention} Mission #{wake.mission.id} (“#{wake.mission.title}”) was started but no tasks were delegated. Its coordinator turn ended; recover the interrupted setup.
        #{Cascade.Missions.Authority.context(wake.mission.id)}
        Continue this existing mission; do not create a replacement. Read the latest owner messages first. If still authorized, delegate the missing implementation tasks and continue delivery. Honor Stop and changed scope. Inspect existing artifacts and work before retrying any operation; do not duplicate side effects. This is one setup recovery attempt, not permission to keep retrying.
        """
      end

    with {:ok, carrier} <-
           Messages.create(
             user,
             route.localVaultId,
             route.localChannelId,
             %{
               id: carrier_id,
               body: "",
               createdAt: now(),
               registrationId: wake.coordinatorRegistrationId
             },
             access: :agent
           ),
         {:ok, message} <-
           Messages.create(
             user,
             route.localVaultId,
             route.localChannelId,
             %{
               id: message_id,
               body: body,
               createdAt: now(),
               registrationId: wake.coordinatorRegistrationId,
               replyTo: %{
                 messageId: wake.rootMessageId,
                 author: "",
                 preview: wake.mission.title,
                 relationship: "builds_on"
               }
             },
             access: :agent
           ),
         {:ok, dispatch} <-
           Dispatches.create(
             wake.createdBy,
             route.localChannelId,
             message,
             wake.coordinatorRegistrationId
           ) do
      if Map.has_key?(wake, :interpretation),
        do: Cascade.Missions.Interpretation.admitted(wake.mission.id, dispatch.id)

      %{carrier: carrier, message: message, dispatch: dispatch}
    else
      {:error, reason} -> raise "Mission coordinator wake could not be materialized: #{reason}"
    end
  end

  defp emit_wake(wake, item, events) do
    emit_message(wake, "vault:chatMessageCreated", item.carrier, [], events)
    emit_message(wake, "vault:chatMessageCreated", item.message, [item.dispatch], events)
  end

  defp emit_message(update, event, message, dispatches, events) do
    payload = %{
      event: event,
      vaultId: update.vaultId,
      channelId: update.channelId,
      message: message
    }

    payload = if dispatches == [], do: payload, else: Map.put(payload, :dispatches, dispatches)

    if event == "vault:chatMessageCreated",
      do: OrderedPublisher.chat(events, payload),
      else: Events.emit(events, payload)
  end

  defp user!(user_id) do
    case SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      [username] -> %{id: user_id, username: username}
      _ -> raise "Mission owner not found"
    end
  end

  defp assignee_mention(channel_id, user_id, registration_id) do
    case Cascade.Chat.Agents.list_members(channel_id, user_id) do
      {:ok, members} ->
        case Enum.find(members, &(&1.id == registration_id)) do
          nil -> "agent"
          member -> nonblank(member.mention, "agent")
        end

      _ ->
        "agent"
    end
  end

  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp nonblank(nil, fallback), do: fallback
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value
end
