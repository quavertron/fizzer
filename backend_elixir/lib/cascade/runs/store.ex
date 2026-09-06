defmodule Cascade.Runs.Store do
  @moduledoc "Durable run state and append-only, per-run ordered event log."

  alias Cascade.Accounts.SQL
  alias Cascade.Realtime.OrderedPublisher

  @terminal ~w(completed failed canceled)
  @agents ~w(claude-code codex grok antigravity copilot hermes akron-grok omp pi)
  @run_select """
  id,vault_id,note_id,prompt,agent,session_id,conversation_id,status,started_at,
  finished_at,summary,model,chat_dispatch_id
  """

  def terminal?(status), do: status in @terminal
  def valid_agent?(agent), do: agent in @agents

  def list(vault_id, owner_id) do
    SQL.all(
      "SELECT #{@run_select} FROM runs WHERE vault_id=? AND owner_user_id=? ORDER BY started_at DESC,id DESC",
      [vault_id, owner_id]
    )
    |> Enum.map(&run/1)
  end

  def active_sessions(owner_id, vault_id \\ nil) do
    {vault_filter, params} =
      if is_binary(vault_id) and vault_id != "",
        do: {" AND r.vault_id=?", [owner_id, vault_id]},
        else: {"", [owner_id]}

    if SQL.table_exists?("chat_messages") and SQL.table_exists?("chat_agent_members") do
      SQL.all(
        """
        SELECT #{@run_select |> String.split(",") |> Enum.map_join(",", &("r." <> String.trim(&1)))},
          vault.name, cm.id, cm.channel_id, channel.title, cm.author,
          cm.registration_id, member.mention
        FROM runs r
        LEFT JOIN chat_messages cm ON cm.id=(
          SELECT message.id FROM chat_messages message WHERE message.run_id=r.id
          ORDER BY message.created_at DESC LIMIT 1
        )
        LEFT JOIN notes channel ON channel.id=cm.channel_id
        LEFT JOIN chat_agent_members member ON member.id=cm.registration_id
        JOIN vaults vault ON vault.id=r.vault_id
        WHERE r.owner_user_id=?#{vault_filter} AND r.status IN ('queued','running')
        ORDER BY r.started_at DESC,r.id DESC
        """,
        params
      )
      |> Enum.map(fn row ->
        {base, [vault_name, message_id, channel_id, title, author, registration_id, mention]} =
          Enum.split(row, 13)

        base
        |> run()
        |> Map.merge(%{
          vault_name: vault_name,
          message_id: message_id,
          channel_id: channel_id,
          channel_title: title,
          author: author,
          registration_id: registration_id,
          mention: mention
        })
      end)
    else
      SQL.all(
        "SELECT #{@run_select |> String.split(",") |> Enum.map_join(",", &("r." <> String.trim(&1)))},(SELECT name FROM vaults WHERE id=r.vault_id) FROM runs r WHERE r.owner_user_id=?#{vault_filter} AND r.status IN ('queued','running') ORDER BY r.started_at DESC,r.id DESC",
        params
      )
      |> Enum.map(fn row ->
        {base, [vault_name]} = Enum.split(row, 13)

        base
        |> run()
        |> Map.merge(%{
          vault_name: vault_name,
          message_id: nil,
          channel_id: nil,
          channel_title: nil,
          author: nil,
          registration_id: nil,
          mention: nil
        })
      end)
    end
  end

  def get(id) when is_integer(id) do
    case SQL.one("SELECT #{@run_select} FROM runs WHERE id=?", [id]) do
      nil -> nil
      row -> run(row)
    end
  end

  def owned?(run_id, owner_id) when is_integer(run_id) and is_integer(owner_id) do
    not is_nil(SQL.one("SELECT 1 FROM runs WHERE id=? AND owner_user_id=?", [run_id, owner_id]))
  end

  def owned?(_run_id, _owner_id), do: false

  def events(run_id, after_seq \\ 0) do
    SQL.all(
      "SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq ASC",
      [run_id, max(0, integer(after_seq))]
    )
    |> Enum.map(&event/1)
  end

  def start(vault_id, note_id, prompt, agent \\ "claude-code", opts \\ []) do
    prompt = clean(prompt, 2_000_000)

    cond do
      prompt == "" -> {:error, "Prompt is required"}
      not valid_agent?(agent) -> {:error, "Invalid agent"}
      true -> insert_run(vault_id, note_id, prompt, agent, opts)
    end
  end

  defp insert_run(vault_id, note_id, prompt, agent, opts) do
    owner_id = Keyword.get(opts, :owner_user_id)
    conversation_id = clean(Keyword.get(opts, :conversation_id), 200)
    conversation_id = if conversation_id == "", do: Ecto.UUID.generate(), else: conversation_id
    session_id = nil_if_blank(Keyword.get(opts, :session_id))
    model = nil_if_blank(Keyword.get(opts, :model))
    dispatch = nil_if_blank(Keyword.get(opts, :chat_dispatch_id))

    try do
      OrderedPublisher.mutate(fn ->
        run =
          SQL.transaction(fn ->
            if dispatch &&
                 SQL.one("SELECT failed_at FROM chat_agent_dispatches WHERE id=?", [dispatch]) !=
                   [nil],
               do: raise("Chat dispatch is no longer pending")

            SQL.exec(
              """
              INSERT INTO runs
                (vault_id,owner_user_id,note_id,prompt,agent,conversation_id,status,model,session_id,chat_dispatch_id)
              VALUES (?,?,?,?,?,?,'queued',?,?,?)
              """,
              [
                vault_id,
                owner_id,
                note_id,
                prompt,
                agent,
                conversation_id,
                model,
                session_id,
                dispatch
              ]
            )

            id = SQL.last_insert_id()
            publish_in_transaction(id, "status", %{status: "queued"})
            get(id)
          end)

        broadcast_last(run.id)
        {:ok, run}
      end)
    rescue
      error -> {:error, Exception.message(error)}
    end
  end

  def publish(run_id, type, payload) when is_integer(run_id) and is_binary(type) do
    OrderedPublisher.mutate(fn ->
      result = SQL.transaction(fn -> publish_in_transaction(run_id, type, payload) end)
      broadcast_event(result)
      project_chat(run_id, type)
      result
    end)
  end

  defp publish_in_transaction(run_id, type, payload) do
    SQL.exec(
      """
      INSERT INTO run_events (run_id,seq,type,payload_json)
      SELECT ?,COALESCE(MAX(seq),0)+1,?,? FROM run_events WHERE run_id=?
      """,
      [run_id, clean(type, 120), Jason.encode!(payload), run_id]
    )

    SQL.last_insert_id()
    |> then(&SQL.one("SELECT * FROM run_events WHERE id=?", [&1]))
    |> event()
  end

  def record_delegated(run_id, owner_id, payload \\ nil) do
    SQL.transaction(fn ->
      if SQL.changes(
           "UPDATE runs SET owner_user_id=? WHERE id=? AND status IN ('queued','running') AND (owner_user_id IS NULL OR owner_user_id=?)",
           [owner_id, run_id, owner_id]
         ) > 0 do
        SQL.exec(
          """
          INSERT INTO delegated_runs (run_id,owner_user_id,started_at,delivery_payload_json,delivery_sent_at,delivery_attempts)
          VALUES (?,?,datetime('now'),?,datetime('now'),?)
          ON CONFLICT(run_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
            delivery_payload_json=COALESCE(excluded.delivery_payload_json,delegated_runs.delivery_payload_json),
            delivery_sent_at=CASE WHEN excluded.delivery_payload_json IS NOT NULL THEN excluded.delivery_sent_at ELSE delegated_runs.delivery_sent_at END,
            delivery_attempts=delegated_runs.delivery_attempts+excluded.delivery_attempts
          """,
          [run_id, owner_id, if(payload, do: Jason.encode!(payload)), if(payload, do: 1, else: 0)]
        )

        :ok
      else
        {:error, :run_not_active}
      end
    end)
  end

  def pending_deliveries do
    SQL.all("""
    SELECT d.run_id,d.owner_user_id FROM delegated_runs d JOIN runs r ON r.id=d.run_id
    WHERE r.status='queued' AND d.delivery_payload_json IS NOT NULL
      AND d.delivery_sent_at<datetime('now','-15 seconds')
    """)
    |> Enum.map(fn [id, owner] -> {id, owner} end)
  end

  def pending_delivery(run_id, owner_id) do
    SQL.one(
      """
      SELECT d.delivery_payload_json,d.delivery_attempts FROM delegated_runs d JOIN runs r ON r.id=d.run_id
      WHERE d.run_id=? AND d.owner_user_id=? AND r.status='queued' AND d.delivery_payload_json IS NOT NULL
      """,
      [run_id, owner_id]
    )
  end

  def acknowledge_delivery(run_id) do
    SQL.exec(
      "UPDATE delegated_runs SET delivery_payload_json=NULL WHERE run_id=? AND delivery_payload_json IS NOT NULL",
      [run_id]
    )
  end

  def clear_delegated(run_id) do
    SQL.exec("DELETE FROM delegated_runs WHERE run_id=?", [run_id])
    :ok
  end

  def delegated_owner(run_id) do
    case SQL.one(
           """
           SELECT d.owner_user_id FROM delegated_runs d JOIN runs r ON r.id=d.run_id
           WHERE d.run_id=? AND r.status IN ('queued','running')
           """,
           [run_id]
         ) do
      [owner_id] -> owner_id
      nil -> nil
    end
  end

  def open_delegated do
    SQL.all("""
    SELECT d.run_id,d.owner_user_id FROM delegated_runs d JOIN runs r ON r.id=d.run_id
    WHERE r.status IN ('queued','running')
    """)
    |> Enum.map(fn [run_id, owner_id] -> %{run_id: run_id, owner_user_id: owner_id} end)
  end

  def active_delegated_count(owner_id) do
    case SQL.one(
           """
           SELECT COUNT(*) FROM delegated_runs d JOIN runs r ON r.id=d.run_id
           WHERE d.owner_user_id=? AND r.status IN ('queued','running')
           """,
           [owner_id]
         ) do
      [count] -> count
      _ -> 0
    end
  end

  def persist_session(run_id, session_id) do
    case clean(session_id, 500) do
      "" ->
        :ok

      value ->
        SQL.exec("UPDATE runs SET session_id=? WHERE id=?", [value, run_id])
        :ok
    end
  end

  def finish(run_id, status, summary, session_id \\ nil) when status in @terminal do
    case get(run_id) do
      nil ->
        :not_found

      %{status: status} when status in @terminal ->
        :already_terminal

      _run ->
        missing_session? =
          status == "failed" and
            Regex.match?(~r/no conversation found with session id/i, to_string(summary))

        SQL.exec(
          """
          UPDATE runs SET status=?,finished_at=datetime('now'),summary=?,
            session_id=CASE WHEN ? THEN NULL ELSE COALESCE(?,session_id) END
          WHERE id=? AND status IN ('queued','running')
          """,
          [
            status,
            clean(summary, 20_000),
            if(missing_session?, do: 1, else: 0),
            nil_if_blank(session_id),
            run_id
          ]
        )

        clear_delegated(run_id)
        Cascade.Missions.DispatchReannouncer.wake()
        :ok
    end
  end

  def mark_running(run_id) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        if SQL.changes("UPDATE runs SET status='running' WHERE id=? AND status='queued'", [run_id]) >
             0,
           do: publish(run_id, "status", %{status: "running"})
      end)
    end)
  end

  def cancel(run_id, opts \\ []) do
    unless Keyword.get(opts, :steering, false) do
      Cascade.Missions.Steering.cancel_pending(run_id)
      Cascade.Chat.Continuations.stop(run_id)
    end

    case get(run_id) do
      nil -> false
      %{status: status} when status in @terminal -> true
      _run -> do_cancel(run_id, opts)
    end
  end

  defp do_cancel(run_id, opts) do
    owner_id = delegated_owner(run_id)
    steering? = Keyword.get(opts, :steering, false)
    force? = Keyword.get(opts, :force, false)

    stopped? =
      cond do
        is_nil(owner_id) -> false
        force? -> Cascade.Runs.RunnerLifecycle.request_cancel(owner_id, run_id)
        true -> Cascade.Runs.RunnerLifecycle.cancel(owner_id, run_id)
      end

    if (steering? and not is_nil(owner_id) and not stopped?) or
         (owner_id && not stopped? && Cascade.Runs.RunnerLifecycle.online?(owner_id) &&
            not force?) do
      false
    else
      summary =
        clean(Keyword.get(opts, :summary), 20_000)
        |> case do
          "" when steering? -> "Steered into the continuation below."
          "" -> "Run canceled by user."
          value -> value
        end

      if not steering?, do: Cascade.Missions.Interpretation.stop_run(run_id)
      result = finish(run_id, "canceled", summary)

      if result == :ok or match?(%{status: "canceled"}, get(run_id)) do
        publish(run_id, "status", %{
          status: "canceled",
          summary: summary,
          steering: steering?,
          suppressChatBody: Keyword.get(opts, :suppress_chat_body, false)
        })
      end

      true
    end
  end

  def find_by_chat_dispatch(dispatch_id) do
    case SQL.one("SELECT #{@run_select} FROM runs WHERE chat_dispatch_id=? LIMIT 1", [dispatch_id]) do
      nil -> nil
      row -> run(row)
    end
  end

  @doc "Returns the oldest open sticky-session run for a registration, excluding mission workers."
  def find_open_for_chat_registration(registration_id, except_dispatch_id \\ "") do
    registration_id = clean(registration_id, 120)
    except_dispatch_id = clean(except_dispatch_id, 120)

    if registration_id == "" do
      nil
    else
      case SQL.one(
             """
             SELECT #{@run_select |> String.split(",") |> Enum.map_join(",", &("r." <> String.trim(&1)))}
             FROM runs r
             JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
             LEFT JOIN chat_mission_tasks t ON t.dispatch_id=d.id
             WHERE d.registration_id=?
               AND r.status IN ('queued','running')
               AND (?='' OR d.id<>?)
               AND t.id IS NULL
             ORDER BY r.id ASC LIMIT 1
             """,
             [registration_id, except_dispatch_id, except_dispatch_id]
           ) do
        nil -> nil
        row -> run(row)
      end
    end
  end

  def find_conversation_session(query) do
    params = [query.vault_id]

    {note_sql, params} =
      if query.note_id,
        do: {"note_id=?", params ++ [query.note_id]},
        else: {"note_id IS NULL", params}

    row =
      SQL.one(
        """
        SELECT session_id,started_at FROM runs
        WHERE vault_id=? AND #{note_sql} AND agent=? AND conversation_id=?
        ORDER BY id DESC LIMIT 1
        """,
        params ++ [query.agent, query.conversation_id]
      )

    case row do
      [session_id, _started_at] when is_binary(session_id) and session_id != "" -> session_id
      _ -> nil
    end
  end

  def count_session_runs(query, session_id) do
    params = [query.vault_id]

    {note_sql, params} =
      if query.note_id,
        do: {"note_id=?", params ++ [query.note_id]},
        else: {"note_id IS NULL", params}

    case SQL.one(
           """
           SELECT COUNT(*) FROM runs WHERE vault_id=? AND #{note_sql}
             AND agent=? AND conversation_id=? AND session_id=?
           """,
           params ++ [query.agent, query.conversation_id, session_id]
         ) do
      [count] -> count
      _ -> 0
    end
  end

  defp broadcast_last(run_id), do: run_id |> events() |> List.last() |> broadcast_event()

  defp project_chat(run_id, type) when type in ["text", "user", "harness", "status"] do
    target? =
      type == "status" or
        not is_nil(SQL.one("SELECT 1 FROM chat_messages WHERE run_id=? LIMIT 1", [run_id]))

    if target? and Code.ensure_loaded?(Cascade.Runs.ChatProjection) do
      Cascade.Runs.ChatProjection.sync(run_id)
    end

    :ok
  rescue
    _ -> :ok
  end

  defp project_chat(_run_id, _type), do: :ok

  defp broadcast_event(nil), do: :ok
  defp broadcast_event(event), do: OrderedPublisher.run(event)

  defp run([
         id,
         vault_id,
         note_id,
         prompt,
         agent,
         session_id,
         conversation_id,
         status,
         started_at,
         finished_at,
         summary,
         model,
         chat_dispatch_id
       ]) do
    %{
      id: id,
      vault_id: vault_id,
      note_id: note_id,
      prompt: prompt,
      agent: agent,
      session_id: session_id,
      conversation_id: conversation_id,
      status: status,
      started_at: started_at,
      finished_at: finished_at,
      summary: summary,
      model: model,
      chat_dispatch_id: chat_dispatch_id
    }
  end

  defp event([id, run_id, seq, type, payload_json, ts]) do
    %{id: id, run_id: run_id, seq: seq, type: type, payload_json: payload_json, ts: ts}
  end

  defp integer(value) when is_integer(value), do: value
  defp integer(value) when is_binary(value), do: String.to_integer(value)
  defp integer(_), do: 0
  defp clean(nil, _max), do: ""
  defp clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)

  defp nil_if_blank(value) do
    case clean(value, 10_000) do
      "" -> nil
      text -> text
    end
  end
end
