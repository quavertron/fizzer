defmodule Cascade.Runs.ChatProjection do
  @moduledoc """
  Folds durable runner events into the authoritative chat reply and mission state.

  Live sync keeps a per-run fold cursor (last seq + accumulator) so each tick
  applies only new events. A seq gap or missing cursor rebuilds from the log.
  """

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages
  alias Cascade.Missions.{Dispatches, Scheduler}
  alias Cascade.Missions.Store, as: MissionStore
  alias Cascade.Realtime.Events
  alias Cascade.Runs.Store

  @harness_max 512_000
  @cursor_table :cascade_chat_projection

  def build(events, final_reply_only \\ false) do
    {content, _cursor} = project(events, nil, final_reply_only)
    content
  end

  @doc """
  Fold `events` onto an optional cursor from a previous `project/3` call.

  `build/2` is this from an empty cursor. Live sync keeps the cursor so each
  tick only applies `seq > last_seq` instead of rereading the whole log.
  """
  def project(events, cursor \\ nil, final_reply_only \\ false) do
    {state, last_seq} = advance(cursor || new_cursor(), events)
    {content(state, final_reply_only), %{state: state, last_seq: last_seq}}
  end

  def sync(run_id, owner_id \\ nil) when is_integer(run_id) do
    cursor = fetch_cursor(run_id)
    events = Store.events(run_id, cursor.last_seq)

    {state, last_seq} =
      cond do
        gap?(events, cursor.last_seq) ->
          advance(new_cursor(), Store.events(run_id))

        events == [] and cursor_seq_missing?(run_id, cursor.last_seq) ->
          advance(new_cursor(), Store.events(run_id))

        true ->
          advance(cursor, events)
      end

    target = target(run_id, owner_id) || restore_target(run_id, owner_id)
    projection = content(state, not is_nil(target) and target.final_reply_only)
    persisted = cursor.persisted
    fingerprint = persist_fingerprint(projection)

    persisted =
      if target && fingerprint != persisted do
        case persist_target(target, run_id, projection) do
          :ok -> fingerprint
          :error -> persisted
        end
      else
        persisted
      end

    if projection.done do
      drop_cursor(run_id)
      run = Store.get(run_id)
      summary = nonblank(projection.body, if(run, do: run.summary || "", else: ""))
      status = projection.terminal_status || if(run, do: run.status, else: "completed")

      if status in ["completed", "failed", "canceled"] do
        _ = Scheduler.settle_run(run_id, status, summary, events: Events)
      end
    else
      # last_seq 0 means events had no seq (or none applied). Caching that
      # accumulator would double-fold on the next full fetch.
      if last_seq > 0 do
        put_cursor(run_id, %{state: state, last_seq: last_seq, persisted: persisted})
      end
    end

    projection
  rescue
    _ -> %{body: "", blocks: [], harnessLog: "", status: "running", done: false}
  end

  defp empty_state do
    %{
      assistant_text: "",
      latest_assistant_text: "",
      blocks: [],
      harness_log: "",
      status: "running",
      terminal_status: nil,
      terminal_summary: "",
      suppress_chat_body: false,
      visible_text: false
    }
  end

  defp new_cursor, do: %{state: empty_state(), last_seq: 0, persisted: nil}

  defp advance(%{state: state, last_seq: last_seq}, events) do
    Enum.reduce(events, {state, last_seq}, fn event, {state, last_seq} ->
      next_state =
        case Jason.decode(event.payload_json || "") do
          {:ok, payload} -> fold(state, event.type, payload)
          _ -> state
        end

      {next_state, max(last_seq, event_seq(event))}
    end)
  end

  defp gap?(_events, 0), do: false
  defp gap?([], _last_seq), do: false
  defp gap?([first | _], last_seq), do: event_seq(first) != last_seq + 1

  defp cursor_seq_missing?(_run_id, 0), do: false

  defp cursor_seq_missing?(run_id, last_seq) do
    is_nil(
      SQL.one("SELECT 1 FROM run_events WHERE run_id=? AND seq=? LIMIT 1", [run_id, last_seq])
    )
  end

  defp event_seq(event) when is_map(event) do
    case value(event, "seq", 0) do
      seq when is_integer(seq) and seq > 0 -> seq
      _ -> 0
    end
  end

  defp persist_fingerprint(projection) do
    {projection.body, projection.status, projection.harnessLog, projection.blocks}
  end

  defp fetch_cursor(run_id) do
    case :ets.lookup(ensure_cursor_table(), run_id) do
      [{^run_id, cursor}] -> cursor
      _ -> new_cursor()
    end
  rescue
    ArgumentError -> new_cursor()
  end

  defp put_cursor(run_id, cursor) do
    :ets.insert(ensure_cursor_table(), {run_id, cursor})
    :ok
  rescue
    ArgumentError -> :ok
  end

  defp drop_cursor(run_id) do
    :ets.delete(ensure_cursor_table(), run_id)
    :ok
  rescue
    ArgumentError -> :ok
  end

  defp ensure_cursor_table do
    case :ets.whereis(@cursor_table) do
      :undefined ->
        try do
          :ets.new(@cursor_table, [
            :named_table,
            :public,
            :set,
            read_concurrency: true
          ])
        rescue
          ArgumentError -> @cursor_table
        end

      _tid ->
        @cursor_table
    end
  end

  defp fold(state, "text", payload) do
    content = value(value(payload, "message", %{}), "content")
    text = text_content(content)

    %{
      state
      | assistant_text: state.assistant_text <> text,
        latest_assistant_text: if(trim(text) == "", do: state.latest_assistant_text, else: text),
        blocks: append_blocks(state.blocks, normalize_blocks(content)),
        visible_text:
          state.visible_text or (value(payload, "chatVisible") == true and trim(text) != "")
    }
  end

  defp fold(state, "user", payload) do
    content = value(value(payload, "message", %{}), "content")
    %{state | blocks: append_blocks(state.blocks, normalize_blocks(content))}
  end

  defp fold(state, "harness", payload) do
    chunk = value(payload, "data", "")

    if is_binary(chunk) and chunk != "" do
      next = state.harness_log <> chunk

      next =
        if String.length(next) > @harness_max,
          do: String.slice(next, -@harness_max, @harness_max),
          else: next

      %{state | harness_log: next}
    else
      state
    end
  end

  defp fold(state, "status", payload) do
    state =
      if value(payload, "suppressChatBody") == true,
        do: %{state | suppress_chat_body: true},
        else: state

    case value(payload, "status") do
      "completed" ->
        %{
          state
          | status: nil,
            terminal_status: "completed",
            terminal_summary: to_string(value(payload, "summary", ""))
        }

      "failed" ->
        %{
          state
          | status: "failed",
            terminal_status: "failed",
            terminal_summary: to_string(value(payload, "summary", "Agent failed."))
        }

      "canceled" ->
        %{
          state
          | status: "canceled",
            terminal_status: "canceled",
            terminal_summary: to_string(value(payload, "summary", "Run canceled by user."))
        }

      _ ->
        state
    end
  end

  defp fold(state, _type, _payload), do: state

  defp content(state, final_reply_only) do
    text =
      if final_reply_only,
        do: trim(state.latest_assistant_text),
        else: trim(state.assistant_text)

    done = state.status != "running"

    body =
      cond do
        not done ->
          if not final_reply_only and state.visible_text and text != "",
            do: text,
            else: "Thinking..."

        state.suppress_chat_body ->
          ""

        state.status in ["failed", "canceled"] ->
          fallback =
            if state.status == "canceled", do: "Run canceled by user.", else: "Agent failed."

          reason = nonblank(trim(state.terminal_summary), fallback)
          useful = if text != "" and not generic_summary?(text), do: text, else: ""
          if useful == "", do: reason, else: useful <> "\n\n> ⚠️ " <> reason

        trim(state.terminal_summary) != "" and not generic_summary?(state.terminal_summary) ->
          trim(state.terminal_summary)

        text != "" and not generic_summary?(text) ->
          text

        true ->
          ""
      end

    %{
      body: if(final_reply_only and no_reply?(body), do: "", else: body),
      blocks: if(final_reply_only, do: [], else: state.blocks),
      harnessLog: if(final_reply_only, do: "", else: state.harness_log),
      status: state.status,
      terminal_status: state.terminal_status,
      done: done
    }
  end

  defp target(run_id, owner_id) do
    case SQL.one(
           """
           SELECT cm.id,cm.vault_id,cm.channel_id,cm.actor_user_id,COALESCE(m.final_reply_only,0)
           FROM chat_messages cm
           LEFT JOIN chat_agent_members m ON m.id=cm.registration_id
           WHERE cm.run_id=? ORDER BY cm.created_at DESC,cm.rowid DESC LIMIT 1
           """,
           [run_id]
         ) do
      [message_id, source_vault_id, source_channel_id, actor_user_id, final_reply_only] ->
        owner_id = owner_id || actor_user_id

        with owner when is_integer(owner) <- owner_id,
             [username] <- SQL.one("SELECT username FROM users WHERE id=?", [owner]),
             {:ok, route} <- MissionStore.owner_route(owner, source_vault_id, source_channel_id) do
          %{
            user: %{id: owner, username: username},
            vault_id: route.localVaultId,
            channel_id: route.localChannelId,
            source_vault_id: route.sourceVaultId,
            source_channel_id: route.sourceChannelId,
            message_id: message_id,
            final_reply_only: final_reply_only != 0
          }
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  # The client normally creates the durable reply shell before delegation. If
  # that request races, fails, or an old client omits it, terminal run output
  # must still have an authoritative chat destination.
  defp restore_target(run_id, owner_id) do
    case SQL.one(
           """
           SELECT r.chat_dispatch_id,d.channel_id,m.id,m.display_name,m.agent_id,
                  va.owner_user_id,n.vault_id,m.final_reply_only
           FROM runs r
           JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
           JOIN chat_agent_members m ON m.id=d.registration_id AND m.channel_id=d.channel_id
           JOIN vault_agents va ON va.id=m.vault_agent_id
           JOIN notes n ON n.id=d.channel_id
           WHERE r.id=?
           """,
           [run_id]
         ) do
      [
        dispatch_id,
        source_channel_id,
        registration_id,
        display_name,
        agent_id,
        agent_owner_id,
        source_vault_id,
        final_reply_only
      ] ->
        owner_id = owner_id || agent_owner_id

        with ^agent_owner_id <- owner_id,
             [username] <- SQL.one("SELECT username FROM users WHERE id=?", [owner_id]),
             {:ok, route} <-
               MissionStore.owner_route(owner_id, source_vault_id, source_channel_id),
             message_id = "agent-dispatch-#{dispatch_id}",
             {:ok, message} <-
               Messages.create(
                 %{id: owner_id, username: username},
                 route.localVaultId,
                 route.localChannelId,
                 %{
                   id: message_id,
                   author: display_name,
                   agentId: agent_id,
                   registrationId: registration_id,
                   runId: run_id,
                   body: "Thinking...",
                   status: "running"
                 },
                 access: :agent
               ) do
          Events.emit(%{
            event: "vault:chatMessageCreated",
            vaultId: route.sourceVaultId,
            channelId: route.sourceChannelId,
            message: message
          })

          %{
            user: %{id: owner_id, username: username},
            vault_id: route.localVaultId,
            channel_id: route.localChannelId,
            source_vault_id: route.sourceVaultId,
            source_channel_id: route.sourceChannelId,
            message_id: message_id,
            final_reply_only: final_reply_only != 0
          }
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp persist_target(target, run_id, projection) do
    patch = %{body: projection.body, status: projection.status, runId: run_id}

    patch =
      if projection.blocks == [], do: patch, else: Map.put(patch, :blocks, projection.blocks)

    patch =
      if projection.harnessLog == "",
        do: patch,
        else: Map.put(patch, :harnessLog, projection.harnessLog)

    case Messages.update(
           target.user,
           target.vault_id,
           target.channel_id,
           target.message_id,
           patch,
           access: :agent
         ) do
      {:ok, message} ->
        dispatches =
          if projection.done and trim(projection.body) != "" do
            case Dispatches.create_for_message(target.user.id, target.channel_id, message) do
              {:ok, created} -> created
              _ -> []
            end
          else
            []
          end

        emit_message(target, message, dispatches)

        if projection.done and Messages.terminal_shell?(message) do
          SQL.exec("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
            target.message_id,
            target.source_channel_id
          ])

          Events.emit(%{
            event: "vault:chatMessageDeleted",
            vaultId: target.source_vault_id,
            channelId: target.source_channel_id,
            messageId: target.message_id
          })
        end

        :ok

      _ ->
        :error
    end
  end

  defp no_reply?(body) do
    Regex.match?(~r/^(?:\[no-reply\]|<no-reply\s*\/?>|NO_REPLY)$/i, trim(body))
  end

  defp emit_message(target, message, dispatches) do
    Events.emit(%{
      event: "vault:chatMessageUpdated",
      vaultId: target.source_vault_id,
      channelId: target.source_channel_id,
      message: message,
      dispatches: dispatches
    })
  end

  defp text_content(content) when is_binary(content), do: content

  defp text_content(content) when is_list(content) do
    Enum.map_join(content, "", fn block ->
      if value(block, "type") == "text" and is_binary(value(block, "text")),
        do: value(block, "text"),
        else: ""
    end)
  end

  defp text_content(_content), do: ""

  defp normalize_blocks(content) when is_binary(content) do
    if trim(content) == "", do: [], else: [%{type: "text", text: content}]
  end

  defp normalize_blocks(content) when is_list(content) do
    Enum.flat_map(content, fn block ->
      type = value(block, "type")
      text = value(block, "text")

      case type do
        "text" ->
          if is_binary(text), do: [%{type: "text", text: text}], else: []

        "thinking" ->
          [
            %{
              type: "thinking",
              text: to_string(value(block, "thinking", value(block, "text", "")))
            }
          ]

        "redacted_thinking" ->
          [%{type: "thinking", text: "", redacted: true}]

        "tool_use" ->
          [
            %{
              type: "tool_use",
              id: value(block, "id"),
              name: value(block, "name", "tool"),
              input: value(block, "input")
            }
            |> reject_nil()
          ]

        "tool_result" ->
          result = tool_result_text(value(block, "content"))

          [
            %{
              type: "tool_result",
              toolUseId: value(block, "tool_use_id", value(block, "toolUseId")),
              content: result,
              text: result,
              isError: value(block, "is_error") == true or value(block, "isError") == true
            }
            |> reject_nil()
          ]

        _ ->
          []
      end
    end)
  end

  defp normalize_blocks(_content), do: []

  defp append_blocks(existing, blocks) do
    Enum.reduce(blocks, existing, fn block, acc ->
      last = List.last(acc)

      cond do
        not is_nil(last) and value(last, "type") == value(block, "type") and
            value(block, "type") in ["text", "thinking"] ->
          List.replace_at(
            acc,
            -1,
            Map.put(
              last,
              :text,
              to_string(value(last, "text", "")) <> to_string(value(block, "text", ""))
            )
          )

        value(block, "type") == "tool_use" and value(block, "id") not in [nil, ""] ->
          case Enum.find_index(
                 acc,
                 &(value(&1, "type") == "tool_use" and value(&1, "id") == value(block, "id"))
               ) do
            nil -> acc ++ [block]
            index -> List.replace_at(acc, index, Map.merge(Enum.at(acc, index), block))
          end

        true ->
          acc ++ [block]
      end
    end)
  end

  defp tool_result_text(value) when is_binary(value), do: value

  defp tool_result_text(value) when is_list(value) do
    value
    |> Enum.map(&value(&1, "text", ""))
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
  end

  defp tool_result_text(nil), do: ""
  defp tool_result_text(value), do: Jason.encode!(value)

  defp generic_summary?(value) do
    text = trim(value)
    standalone = not String.contains?(text, "\n\n")

    Regex.match?(~r/^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i, text) or
      (standalone and
         (Regex.match?(~r/^I will\b/i, text) or
            Regex.match?(~r/^I(?:'ll| am going to)\b/i, text) or
            Regex.match?(~r/^Let me\b/i, text)))
  end

  defp value(map, key, fallback \\ nil)

  defp value(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp value(_other, _key, fallback), do: fallback
  defp reject_nil(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
  defp trim(value), do: value |> to_string() |> String.trim()
  defp nonblank(value, fallback) when value in [nil, ""], do: fallback
  defp nonblank(value, _fallback), do: value
end
