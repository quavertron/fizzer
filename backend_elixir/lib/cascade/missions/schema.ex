defmodule Cascade.Missions.Schema do
  @moduledoc "SQLite schema and compatibility repairs for durable missions and agent dispatches."

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

    repair_legacy_dependencies!()
    backfill_history!()
    repair_worker_evidence!()
    :ok
  end

  defp repair_legacy_dependencies! do
    SQL.exec("""
    UPDATE chat_mission_tasks
    SET status='pending', summary='', updated_at=datetime('now')
    WHERE status='blocked'
      AND dispatch_id IS NULL
      AND run_id IS NULL
      AND summary LIKE 'Dependency “%” ended %.'
    """)

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
