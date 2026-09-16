defmodule Cascade.Runs.Schema do
  @moduledoc "SQLite-compatible run, delegated-run, work-item, and managed-agent schema."

  alias Cascade.Accounts.SQL

  def ensure! do
    ensure_runs!()
    ensure_work_items!()
    ensure_managed_agents!()
    :ok
  end

  def ensure_runs! do
    exec_batch("""
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      owner_user_id INTEGER REFERENCES users(id),
      note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      prompt TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT,
      conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      summary TEXT,
      model TEXT,
      chat_dispatch_id TEXT
    );
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS delegated_runs (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      owner_user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS delegated_runs_owner_idx ON delegated_runs(owner_user_id);
    """)

    SQL.ensure_column("delegated_runs", "delivery_payload_json", "TEXT")
    SQL.ensure_column("delegated_runs", "delivery_sent_at", "TEXT")
    SQL.ensure_column("delegated_runs", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0")

    SQL.ensure_column("runs", "agent", "TEXT NOT NULL DEFAULT 'claude-code'")
    SQL.ensure_column("runs", "session_id", "TEXT")
    SQL.ensure_column("runs", "conversation_id", "TEXT NOT NULL DEFAULT ''")
    SQL.ensure_column("runs", "model", "TEXT")
    SQL.ensure_column("runs", "chat_dispatch_id", "TEXT")
    SQL.ensure_column("runs", "owner_user_id", "INTEGER REFERENCES users(id)")

    SQL.exec("""
    UPDATE runs
    SET owner_user_id=(SELECT d.owner_user_id FROM delegated_runs d WHERE d.run_id=runs.id)
    WHERE owner_user_id IS NULL
      AND EXISTS (SELECT 1 FROM delegated_runs d WHERE d.run_id=runs.id)
    """)

    exec_batch("""
    CREATE UNIQUE INDEX IF NOT EXISTS runs_chat_dispatch_idx
    ON runs(chat_dispatch_id) WHERE chat_dispatch_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS runs_owner_active_idx
    ON runs(owner_user_id,status,started_at DESC,id DESC)
    """)
  end

  def ensure_work_items! do
    exec_batch("""
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      assignee_registration_id TEXT,
      lease_holder TEXT,
      lease_expires_at TEXT,
      repository TEXT NOT NULL DEFAULT '',
      base_commit TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      workspace_mode TEXT NOT NULL DEFAULT 'shared',
      worktree_path TEXT NOT NULL DEFAULT '',
      pr_number INTEGER,
      pr_url TEXT NOT NULL DEFAULT '',
      pr_state TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      verification TEXT NOT NULL DEFAULT '',
      git_state_json TEXT NOT NULL DEFAULT '',
      git_state_updated_at TEXT,
      contract TEXT NOT NULL DEFAULT '',
      token_budget INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS work_items_vault_idx ON work_items(vault_id,status,updated_at);
    CREATE INDEX IF NOT EXISTS work_items_channel_idx ON work_items(channel_id,status,updated_at);
    CREATE INDEX IF NOT EXISTS work_items_lease_idx ON work_items(lease_expires_at)
      WHERE lease_expires_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS work_item_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      PRIMARY KEY (work_item_id, depends_on_id)
    );
    CREATE TABLE IF NOT EXISTS work_item_runs (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL,
      linked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (work_item_id, run_id)
    );
    CREATE INDEX IF NOT EXISTS work_item_runs_run_idx ON work_item_runs(run_id);
    CREATE TABLE IF NOT EXISTS work_item_reviews (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'handoff',
      author_user_id INTEGER,
      from_registration_id TEXT,
      to_registration_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL DEFAULT '',
      line INTEGER,
      base_commit TEXT NOT NULL DEFAULT '',
      head_commit TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'requested',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS work_item_reviews_item_idx ON work_item_reviews(work_item_id,created_at);
    """)

    Enum.each(
      [
        {"contract", "TEXT NOT NULL DEFAULT ''"},
        {"token_budget", "INTEGER NOT NULL DEFAULT 0"},
        {"tokens_used", "INTEGER NOT NULL DEFAULT 0"},
        {"stop_reason", "TEXT NOT NULL DEFAULT ''"},
        {"git_state_json", "TEXT NOT NULL DEFAULT ''"},
        {"git_state_updated_at", "TEXT"}
      ],
      fn {column, definition} -> SQL.ensure_column("work_items", column, definition) end
    )

    Enum.each(
      [
        {"kind", "TEXT NOT NULL DEFAULT 'handoff'"},
        {"author_user_id", "INTEGER"},
        {"file_path", "TEXT NOT NULL DEFAULT ''"},
        {"line", "INTEGER"},
        {"base_commit", "TEXT NOT NULL DEFAULT ''"},
        {"head_commit", "TEXT NOT NULL DEFAULT ''"}
      ],
      fn {column, definition} -> SQL.ensure_column("work_item_reviews", column, definition) end
    )
  end

  def ensure_managed_agents! do
    exec_batch("""
    CREATE TABLE IF NOT EXISTS managed_agent_entitlements (
      vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      monthly_cap_micros INTEGER NOT NULL DEFAULT 0,
      per_run_cap_micros INTEGER NOT NULL DEFAULT 0,
      included_micros INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 1,
      allowed_models_json TEXT NOT NULL DEFAULT '["deepseek-v4-flash"]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS managed_usage_reservations (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
      model TEXT NOT NULL,
      estimated_micros INTEGER NOT NULL,
      checkpointed_micros INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','expired')),
      month_key TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      settled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_usage_reservations_budget_idx
      ON managed_usage_reservations(vault_id,month_key,state);
    CREATE TABLE IF NOT EXISTS managed_usage_ledger (
      id TEXT PRIMARY KEY,
      reservation_id TEXT UNIQUE REFERENCES managed_usage_reservations(id),
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_micros INTEGER NOT NULL,
      settled_micros INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      provider_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS managed_usage_ledger_vault_idx
      ON managed_usage_ledger(vault_id,created_at);
    CREATE TABLE IF NOT EXISTS managed_agent_executions (
      id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE REFERENCES managed_usage_reservations(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      execution_owner TEXT NOT NULL,
      provider TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','claimed','completed','failed','canceled','expired')),
      attempt INTEGER NOT NULL DEFAULT 0,
      dispatch_secret_hash TEXT NOT NULL,
      claim_token_hash TEXT,
      claim_expires_at TEXT,
      last_heartbeat_at TEXT,
      provider_idempotency_key TEXT NOT NULL UNIQUE,
      provider_request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS managed_agent_executions_owner_idx
      ON managed_agent_executions(execution_owner,state,claim_expires_at);
    CREATE TABLE IF NOT EXISTS managed_agent_audit (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      execution_id TEXT REFERENCES managed_agent_executions(id) ON DELETE SET NULL,
      reservation_id TEXT REFERENCES managed_usage_reservations(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS managed_agent_audit_vault_idx
      ON managed_agent_audit(vault_id,created_at DESC);
    """)

    SQL.ensure_column(
      "managed_usage_reservations",
      "checkpointed_micros",
      "INTEGER NOT NULL DEFAULT 0"
    )
  end

  defp exec_batch(sql) do
    sql
    |> String.split(";")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.each(&SQL.exec/1)
  end
end
