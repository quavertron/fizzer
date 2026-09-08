defmodule Cascade.Missions.Schema do
  @moduledoc "SQLite schema and compatibility repairs for durable missions, dispatches, and migration replays."

  alias Cascade.Accounts.SQL

  @task_columns [
    {"parent_task_id", "TEXT"},
    {"child_result_delivered", "INTEGER NOT NULL DEFAULT 0"},
    {"joining_children", "INTEGER NOT NULL DEFAULT 0"},
    {"prompt", "TEXT NOT NULL DEFAULT ''"},
    {"depends_on_json", "TEXT NOT NULL DEFAULT '[]'"},
    {"priority", "INTEGER NOT NULL DEFAULT 0"},
    {"reasoning_effort", "TEXT NOT NULL DEFAULT ''"},
    {"anonymous", "INTEGER NOT NULL DEFAULT 0"},
    {"workspace_mode", "TEXT NOT NULL DEFAULT 'shared'"},
    {"dispatch_id", "TEXT"},
    {"run_id", "INTEGER"},
    {"attempt", "INTEGER NOT NULL DEFAULT 0"},
    {"work_item_id", "TEXT"}
  ]

  @mission_columns [
    {"phase", "TEXT NOT NULL DEFAULT 'planning'"},
    {"approved_at", "TEXT"},
    {"approved_by", "INTEGER REFERENCES users(id)"},
    {"approved_revisions_json", "TEXT NOT NULL DEFAULT '{}'"},
    {"creation_fingerprint", "TEXT"}
  ]

  @contract_task_columns [
    {"purpose", "TEXT NOT NULL DEFAULT 'implementation'"},
    {"brief_note_id", "TEXT"},
    {"brief_revisions_json", "TEXT NOT NULL DEFAULT '{}'"},
    {"review_outcome", "TEXT"},
    {"verification_passed", "INTEGER"}
  ]

  @doc "Ensures the Node-compatible tables and upgrades legacy mission rows idempotently."
  def ensure! do
    # Exqlite executes only the first statement in a multi-statement query. Keep
    # every table, index, repair, and backfill as its own call.
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_agent_dispatches (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      registration_id TEXT NOT NULL,
      run_id INTEGER,
      reasoning_effort TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, registration_id)
    )
    """)

    SQL.ensure_column(
      "chat_agent_dispatches",
      "reasoning_effort",
      "TEXT NOT NULL DEFAULT ''"
    )

    for {name, definition} <- [
          {"requester_user_id", "INTEGER REFERENCES users(id)"},
          {"requester_channel_id", "TEXT"},
          {"target_owner_user_id", "INTEGER REFERENCES users(id)"},
          {"target_identity_id", "TEXT"},
          {"conversation_id", "TEXT"},
          {"error", "TEXT"},
          {"failed_at", "TEXT"}
        ] do
      SQL.ensure_column("chat_agent_dispatches", name, definition)
    end

    SQL.exec("""
    CREATE INDEX IF NOT EXISTS chat_agent_dispatches_pending_idx
    ON chat_agent_dispatches(channel_id, run_id, created_at)
    """)

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_coordinator_continuations (
      registration_id TEXT NOT NULL REFERENCES chat_agent_members(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      after_dispatch_id TEXT,
      dispatch_id TEXT,
      PRIMARY KEY (registration_id, conversation_id)
    )
    """)

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_missions (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      root_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      coordinator_registration_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT NOT NULL DEFAULT '',
      wake_sent INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel_id, root_message_id)
    )
    """)

    SQL.ensure_column("chat_missions", "authority_json", "TEXT NOT NULL DEFAULT '[]'")
    SQL.ensure_column("chat_missions", "verification", "TEXT NOT NULL DEFAULT ''")
    Enum.each(@mission_columns, fn {name, definition} ->
      SQL.ensure_column("chat_missions", name, definition)
    end)


    SQL.exec("""
    CREATE INDEX IF NOT EXISTS chat_missions_channel_idx
    ON chat_missions(channel_id, status, updated_at)
    """)

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_tasks (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      assignee_registration_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT NOT NULL DEFAULT '',
      anonymous INTEGER NOT NULL DEFAULT 0,
      dispatch_id TEXT,
      run_id INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      work_item_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)
    Enum.each(@contract_task_columns, fn {name, definition} ->
      SQL.ensure_column("chat_mission_tasks", name, definition)
    end)

    Enum.each(@task_columns, fn {name, definition} ->
      SQL.ensure_column("chat_mission_tasks", name, definition)
    end)

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_recovery_evidence (
      task_id TEXT PRIMARY KEY REFERENCES chat_mission_tasks(id) ON DELETE CASCADE,
      source_task_id TEXT NOT NULL REFERENCES chat_mission_tasks(id) ON DELETE CASCADE,
      target_snapshot TEXT NOT NULL,
      source_snapshot TEXT NOT NULL,
      verification TEXT NOT NULL,
      coordinator_registration_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)

    SQL.exec("""
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_mission_idx
    ON chat_mission_tasks(mission_id, created_at)
    """)

    SQL.exec("""
    CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_tasks_dispatch_idx
    ON chat_mission_tasks(dispatch_id) WHERE dispatch_id IS NOT NULL
    """)

    SQL.exec("""
    CREATE INDEX IF NOT EXISTS chat_mission_tasks_run_idx
    ON chat_mission_tasks(run_id) WHERE run_id IS NOT NULL
    """)

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      task_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      from_status TEXT NOT NULL DEFAULT '',
      to_status TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      run_id INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      source_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
    """)

    SQL.ensure_column("chat_mission_events", "source_key", "TEXT")

    SQL.exec("""
    CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_events_source_key_idx
    ON chat_mission_events(source_key) WHERE source_key IS NOT NULL
    """)

    SQL.exec("""
    CREATE INDEX IF NOT EXISTS chat_mission_events_mission_idx
    ON chat_mission_events(mission_id, id)
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS chat_mission_tasks_parent_idx ON chat_mission_tasks(parent_task_id)"
    )

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_interpretations (
      mission_id TEXT PRIMARY KEY REFERENCES chat_missions(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0,
      handled_fingerprint TEXT NOT NULL DEFAULT '',
      pending_fingerprint TEXT NOT NULL DEFAULT '',
      pending_context_json TEXT NOT NULL DEFAULT '{}',
      dispatch_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      stopped INTEGER NOT NULL DEFAULT 0,
      publication_pending TEXT
    )
    """)

    SQL.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS chat_mission_interpretations_dispatch_idx ON chat_mission_interpretations(dispatch_id) WHERE dispatch_id IS NOT NULL"
    )
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_notes (
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      parent_note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mission_id, note_id)
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS chat_mission_notes_parent_idx ON chat_mission_notes(mission_id,parent_note_id,position)"
    )

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_mission_cancellation_replays (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      mission_id TEXT NOT NULL REFERENCES chat_missions(id) ON DELETE CASCADE,
      dispatch_id TEXT,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL DEFAULT 'Historical mission work fenced during migration.',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS chat_mission_cancellation_replays_mission_idx ON chat_mission_cancellation_replays(mission_id,run_id)"
    )

    migrate_contract!()
    backfill_note_revisions!()

    repair_legacy_dependencies!()
    backfill_history!()
    repair_worker_evidence!()
    :ok
  end

  defp migrate_contract! do
    migration = "mission-workspace-fence-v2"

    case SQL.one(
           "SELECT 1 FROM chat_mission_migrations WHERE name=?",
           [migration]
         ) do
      [1] ->
        :ok

      _ ->
        SQL.transaction(fn ->
          SQL.exec("""
          UPDATE chat_missions
          SET phase=CASE WHEN status IN ('completed','canceled') THEN 'closed' ELSE 'planning' END,
              approved_at=CASE WHEN status IN ('completed','canceled') THEN approved_at ELSE NULL END,
              approved_by=CASE WHEN status IN ('completed','canceled') THEN approved_by ELSE NULL END,
              approved_revisions_json=CASE WHEN status IN ('completed','canceled') THEN approved_revisions_json ELSE '{}' END
          """)

          SQL.exec("""
          INSERT OR IGNORE INTO chat_mission_events(mission_id,task_id,kind,summary,source_key,attempt)
          SELECT mission_id,id,'historical_task_fenced',
                 'Historical task retained as evidence; fresh approval requires a new delivery chain.',
                 'migration:task:' || id || ':fenced',attempt
          FROM chat_mission_tasks
          """)

          # Keep every task/event row, but make all pre-migration pending work
          # terminal before a scheduler can admit it under the new contract.
          SQL.exec("""
          UPDATE chat_mission_tasks
          SET status='canceled',
              summary=CASE WHEN TRIM(COALESCE(summary,''))='' THEN 'Historical dispatch fenced during mission migration.' ELSE summary END,
              updated_at=datetime('now')
          WHERE status IN ('pending','running')
          """)

          persist_task_cancellation_replays!()
          persist_coordinator_cancellation_replays!()
          fence_historical_dispatches!()
          supersede_interpretation_claims!()
          backfill_briefs!()
          request_migration_decisions!()

          SQL.exec(
            "INSERT OR IGNORE INTO chat_mission_migrations(name) VALUES(?)",
            [migration]
          )
        end)
    end

    # Replay is deliberately outside the transaction: the durable rows above
    # survive a crash, and every subsequent startup can retry provider
    # cancellation without admitting the old dispatch.
    unless Cascade.DB.Repo.in_transaction?() do
      Cascade.Missions.Recovery.replay_cancellations()
    end
    :ok
  end

  defp request_migration_decisions! do
    SQL.all("SELECT id FROM chat_missions WHERE phase='planning' AND status<>'canceled'")
    |> Enum.each(fn [id] ->
      SQL.exec("INSERT OR IGNORE INTO chat_mission_interpretations(mission_id) VALUES(?)", [id])
      [encoded] = SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [id])
      state = Jason.decode!(encoded || "{}")
      question = %{
        "id" => "migration-resumption",
        "status" => "open",
        "question" => "This unfinished mission was paused during the workspace upgrade. Should we resume it with a newly approved brief, revise the plan, or close it? Ask the owner once, preserve the answer, and do not resume historical work automatically."
      }
      state = Map.update(state, "questions", [question], &(&1 ++ [question]))
      SQL.exec("UPDATE chat_mission_interpretations SET state_json=?,revision=revision+1 WHERE mission_id=?", [Jason.encode!(state), id])
    end)
  end

  defp backfill_note_revisions! do
    rows =
      SQL.all(
        """
        SELECT mn.mission_id,mn.note_id,n.revision_counter
        FROM chat_mission_notes mn
        JOIN notes n ON n.id=mn.note_id
        """
      )

    note_tokens =
      Map.new(rows, fn [_mission_id, note_id, revision_counter] ->
        {to_string(note_id),
         Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter})}
      end)

    Enum.each(rows, fn [mission_id, note_id, revision_counter] ->
      revision = Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter})

      SQL.exec(
        "UPDATE chat_mission_notes SET revision=? WHERE mission_id=? AND note_id=?",
        [revision, mission_id, note_id]
      )
    end)

    backfill_revision_snapshots!("chat_mission_tasks", "brief_revisions_json", note_tokens)
    backfill_revision_snapshots!("chat_missions", "approved_revisions_json", note_tokens)
  end

  defp backfill_revision_snapshots!(table, column, note_tokens) do
    SQL.all("SELECT rowid,#{column} FROM #{table}")
    |> Enum.each(fn [rowid, encoded] ->
      case Jason.decode(encoded || "{}") do
        {:ok, revisions} when is_map(revisions) ->
          refreshed =
            Map.new(revisions, fn {note_id, revision} ->
              {to_string(note_id), Map.get(note_tokens, to_string(note_id), revision)}
            end)
            |> Jason.encode!()

          if refreshed != encoded do
            SQL.exec("UPDATE #{table} SET #{column}=? WHERE rowid=?", [refreshed, rowid])
          end

        _ ->
          :ok
      end
    end)
  end

  defp persist_task_cancellation_replays! do
    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_cancellation_replays
      (run_id,mission_id,dispatch_id,owner_user_id,reason)
    SELECT DISTINCT r.id,t.mission_id,COALESCE(t.dispatch_id,d.id),m.created_by,
      'Historical mission worker run fenced during migration.'
    FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id=t.mission_id
    JOIN chat_agent_dispatches d
      ON d.id=t.dispatch_id OR d.message_id IN (
        SELECT id FROM chat_messages WHERE mission_task_id=t.id
      )
    JOIN runs r ON r.id=t.run_id OR r.chat_dispatch_id=d.id
    WHERE t.status='canceled' AND r.status IN ('queued','running')
    """)
  end

  defp persist_coordinator_cancellation_replays! do
    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_cancellation_replays
      (run_id,mission_id,dispatch_id,owner_user_id,reason)
    SELECT DISTINCT r.id,m.id,d.id,COALESCE(r.owner_user_id,m.created_by),
      'Historical mission coordinator run fenced during migration.'
    FROM chat_missions m
    JOIN chat_agent_dispatches d
      ON (
        (d.channel_id=m.channel_id AND d.registration_id=m.coordinator_registration_id)
        OR EXISTS (
          SELECT 1 FROM chat_mission_interpretations i
          WHERE i.mission_id=m.id AND i.dispatch_id=d.id
        )
      )
    JOIN runs r ON r.id=d.run_id OR r.chat_dispatch_id=d.id
    WHERE r.status IN ('queued','running')
      AND (
        d.message_id=m.root_message_id
        OR d.message_id LIKE 'sys-mission-' || m.id || '-%'
        OR EXISTS (
          SELECT 1 FROM chat_mission_interpretations i
          WHERE i.mission_id=m.id AND i.dispatch_id=d.id
        )
      )
    """)
  end

  defp fence_historical_dispatches! do
    SQL.exec("""
    UPDATE chat_agent_dispatches
    SET failed_at=COALESCE(failed_at,datetime('now')),
        error=COALESCE(error,'Historical mission dispatch fenced during migration.')
    WHERE id IN (
      SELECT d.id
      FROM chat_agent_dispatches d
      JOIN chat_mission_tasks t ON t.dispatch_id=d.id
      WHERE t.status='canceled'
      UNION
      SELECT d.id
      FROM chat_agent_dispatches d
      JOIN chat_messages message ON message.id=d.message_id
      JOIN chat_mission_tasks t ON t.id=message.mission_task_id
      WHERE t.status='canceled'
      UNION
      SELECT d.id
      FROM chat_missions m
      JOIN chat_agent_dispatches d
        ON (
          (d.channel_id=m.channel_id AND d.registration_id=m.coordinator_registration_id)
          OR EXISTS (
            SELECT 1 FROM chat_mission_interpretations i
            WHERE i.mission_id=m.id AND i.dispatch_id=d.id
          )
        )
      WHERE d.message_id=m.root_message_id
         OR d.message_id LIKE 'sys-mission-' || m.id || '-%'
         OR EXISTS (
           SELECT 1 FROM chat_mission_interpretations i
           WHERE i.mission_id=m.id AND i.dispatch_id=d.id
         )
    )
      AND (run_id IS NULL OR EXISTS (
        SELECT 1 FROM runs r WHERE r.id=chat_agent_dispatches.run_id AND r.status IN ('queued','running')
      ))
    """)
  end
  defp supersede_interpretation_claims! do
    SQL.all(
      """
      SELECT mission_id,dispatch_id
      FROM chat_mission_interpretations
      WHERE dispatch_id IS NOT NULL
      """
    )
    |> Enum.each(fn [mission_id, dispatch_id] ->
      SQL.exec(
        """
        INSERT OR IGNORE INTO chat_mission_events
          (mission_id,kind,summary,run_id,source_key)
        VALUES(?,?,?,?,?)
        """,
        [
          mission_id,
          "interpretation_claim_superseded",
          Jason.encode!(%{dispatchId: dispatch_id}),
          dispatch_run_id(dispatch_id),
          "migration:mission:#{mission_id}:interpretation-superseded"
        ]
      )

      SQL.exec(
        """
        UPDATE chat_mission_interpretations
        SET pending_fingerprint='',pending_context_json='{}',dispatch_id=NULL,
            attempt=0,retry_after=NULL,publication_pending=NULL
        WHERE mission_id=?
        """,
        [mission_id]
      )
    end)
  end

  defp dispatch_run_id(dispatch_id) do
    case SQL.one("SELECT run_id FROM chat_agent_dispatches WHERE id=?", [dispatch_id]) do
      [run_id] -> run_id
      _ -> nil
    end
  end
  defp backfill_briefs! do
    SQL.all("""
    SELECT m.id,m.vault_id,m.title,m.objective,m.root_message_id,m.created_by,
           COALESCE(root.body,'')
    FROM chat_missions m
    LEFT JOIN chat_messages root ON root.id=m.root_message_id
    ORDER BY m.rowid
    """)
    |> Enum.each(&backfill_brief!/1)
  end

  defp backfill_brief!([mission_id, vault_id, title, objective, _root_id, created_by, root_body]) do
    case SQL.one(
           """
           SELECT mn.note_id
           FROM chat_mission_notes mn
           JOIN notes n ON n.id=mn.note_id AND n.vault_id=?
           WHERE mn.mission_id=? AND mn.kind='mission'
           ORDER BY mn.position,mn.created_at,mn.note_id
           LIMIT 1
           """,
           [vault_id, mission_id]
         ) do
      [note_id] ->
        ensure_brief_relation!(mission_id, note_id)

      nil ->
        content = first_nonblank(objective, root_body, title)
        note_id = choose_brief_id!(mission_id, vault_id)
        ensure_brief_note!(note_id, vault_id, title, content, created_by)
        ensure_brief_relation!(mission_id, note_id)
    end
  end

  defp choose_brief_id!(mission_id, vault_id),
    do: choose_brief_id!(mission_id, vault_id, 0)

  defp choose_brief_id!(mission_id, vault_id, attempt) do
    candidate =
      case attempt do
        0 -> "mission-brief-#{mission_id}"
        1 -> "mission-migration-brief-#{mission_id}"
        _ -> "mission-migration-brief-#{mission_id}-#{short_digest("#{mission_id}:#{attempt}")}"
      end

    case SQL.one("SELECT vault_id FROM notes WHERE id=?", [candidate]) do
      nil -> candidate
      [^vault_id] -> candidate
      [_foreign_vault] -> choose_brief_id!(mission_id, vault_id, attempt + 1)
    end
  end

  defp ensure_brief_note!(note_id, vault_id, title, content, created_by) do
    note_title = brief_note_title(vault_id, title)
    preview = content |> to_string() |> String.replace(~r/\s+/u, " ") |> String.trim() |> String.slice(0, 200)
    words = if String.trim(to_string(content)) == "", do: 0, else: content |> to_string() |> String.split(~r/\s+/u, trim: true) |> length()

    SQL.exec(
      """
      INSERT OR IGNORE INTO notes
        (id,vault_id,folder_id,title,content,content_preview,is_pinned,is_archived,is_listed,position,word_count,created_by)
      VALUES(?,?,NULL,?,?,?,0,0,1,
        COALESCE((SELECT MAX(position)+1 FROM notes WHERE vault_id=? AND folder_id IS NULL AND is_listed=1),0),
        ?,?)
      """,
      [note_id, vault_id, note_title, content, preview, vault_id, words, created_by]
    )

    case SQL.one("SELECT vault_id FROM notes WHERE id=?", [note_id]) do
      [^vault_id] -> :ok
      _ -> raise "Could not create mission brief without claiming a foreign note"
    end
  end

  defp brief_note_title(vault_id, title), do: brief_note_title(vault_id, title, 0)

  defp brief_note_title(vault_id, title, attempt) do
    base = "#{first_nonblank(title, "Mission", nil)} brief"
    candidate = if attempt == 0, do: base, else: "#{base} #{attempt + 1}"

    if SQL.one(
         "SELECT 1 FROM notes WHERE vault_id=? AND folder_id IS NULL AND is_listed=1 AND title=? COLLATE NOCASE LIMIT 1",
         [vault_id, candidate]
       ) == nil do
      candidate
    else
      brief_note_title(vault_id, title, attempt + 1)
    end
  end

  defp ensure_brief_relation!(mission_id, note_id) do
    revision_counter =
      case SQL.one("SELECT revision_counter FROM notes WHERE id=?", [note_id]) do
        [counter] -> counter
        _ -> raise "Could not find mission brief note"
      end

    revision =
      Cascade.Content.Privacy.note_revision(%{revision_counter: revision_counter})

    inserted =
      SQL.changes(
        """
        INSERT OR IGNORE INTO chat_mission_notes
          (mission_id,note_id,kind,parent_note_id,position,revision)
        VALUES(?,?, 'mission',NULL,0,?)
        """,
        [mission_id, note_id, revision]
      )

    SQL.exec(
      "UPDATE chat_mission_notes SET revision=? WHERE mission_id=? AND note_id=? AND kind='mission'",
      [revision, mission_id, note_id]
    )

    if inserted > 0 do
      SQL.exec(
        """
        INSERT OR IGNORE INTO chat_mission_events
          (mission_id,kind,summary,source_key)
        VALUES(?,?,?,?)
        """,
        [
          mission_id,
          "mission_brief_backfilled",
          Jason.encode!(%{"noteId" => note_id, "revision" => revision}),
          "migration:mission:#{mission_id}:brief"
        ]
      )
    end

    :ok
  end

  defp first_nonblank(first, second, third) do
    Enum.find_value([first, second, third], fn value ->
      value = to_string(value || "") |> String.trim()
      if value == "", do: nil, else: value
    end) || ""
  end

  defp short_digest(value) do
    :crypto.hash(:sha256, to_string(value)) |> Base.encode16(case: :lower) |> binary_part(0, 12)
  end

  defp repair_legacy_dependencies! do

    SQL.exec("""
    UPDATE chat_missions SET status='active'
    WHERE status='blocked' AND NOT EXISTS (
      SELECT 1 FROM chat_mission_tasks t
      WHERE t.mission_id=chat_missions.id AND t.status IN ('failed','blocked')
    )
    """)

    SQL.exec("UPDATE chat_missions SET status='attention' WHERE status='blocked'")
  end

  defp backfill_history! do
    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_events
      (mission_id,kind,title,to_status,summary,attempt,created_at,source_key)
    SELECT id,'mission_created',title,'active',objective,0,created_at,
      'backfill:mission:' || id || ':created'
    FROM chat_missions m
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_mission_events e
      WHERE e.mission_id=m.id AND e.kind='mission_created'
    )
    """)

    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_events
      (mission_id,kind,title,to_status,summary,attempt,created_at,source_key)
    SELECT id,'mission_snapshot',title,status,summary,0,updated_at,
      'backfill:mission:' || id || ':snapshot'
    FROM chat_missions m
    WHERE (status<>'active' OR summary<>'' OR updated_at<>created_at)
      AND EXISTS (
        SELECT 1 FROM chat_mission_events e
        WHERE e.source_key='backfill:mission:' || m.id || ':created'
      )
    """)

    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_events
      (mission_id,task_id,kind,title,to_status,summary,attempt,created_at,source_key)
    SELECT mission_id,id,'task_added',title,'pending',prompt,attempt,created_at,
      'backfill:task:' || id || ':created'
    FROM chat_mission_tasks t
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_mission_events e
      WHERE e.task_id=t.id AND e.kind='task_added'
    )
    """)

    SQL.exec("""
    INSERT OR IGNORE INTO chat_mission_events
      (mission_id,task_id,kind,title,to_status,summary,run_id,attempt,created_at,source_key)
    SELECT mission_id,id,'task_snapshot',title,status,summary,run_id,attempt,updated_at,
      'backfill:task:' || id || ':snapshot'
    FROM chat_mission_tasks t
    WHERE (status<>'pending' OR summary<>'' OR run_id IS NOT NULL OR updated_at<>created_at)
      AND EXISTS (
        SELECT 1 FROM chat_mission_events e
        WHERE e.source_key='backfill:task:' || t.id || ':created'
      )
    """)
  end

  defp repair_worker_evidence! do
    if "mission_task_id" in SQL.columns("chat_messages") do
      SQL.exec("""
      UPDATE chat_messages
      SET mission_task_id=(
        SELECT task.id FROM chat_mission_tasks task
        WHERE task.run_id=chat_messages.run_id
        ORDER BY task.rowid
        LIMIT 1
      )
      WHERE mission_task_id IS NULL
        AND run_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM chat_mission_tasks task WHERE task.run_id=chat_messages.run_id
        )
      """)
    end
  end
end
