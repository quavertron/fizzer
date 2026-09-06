defmodule Cascade.Accounts.Schema do
  @moduledoc "Idempotent semantic migrations for account, social, and community tables."

  alias Cascade.Accounts.SQL

  @node_vault_member_columns [
    [0, "vault_id", "TEXT", 1, nil, 1],
    [1, "user_id", "INTEGER", 1, nil, 2],
    [2, "role", "TEXT", 1, "'editor'", 0],
    [3, "invited_by", "INTEGER", 0, nil, 0],
    [4, "created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0]
  ]

  @node_vault_member_foreign_keys [
    ["invited_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
    ["user_id", "users", "id", "NO ACTION", "CASCADE", "NONE"],
    ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
  ]

  def ensure! do
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS app_context (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      revision TEXT NOT NULL
    )
    """)

    ensure_vault_members!()
    ensure_public_vaults!()
    ensure_direct_messages!()
    ensure_moderation!()
    ensure_community_activity!()
    ensure_android_battery!()
    ensure_product_feedback!()
    :ok
  end

  def ensure_vault_members! do
    case SQL.table_sql("vault_members") do
      nil -> create_vault_members!("vault_members")
      definition -> repair_vault_members!(definition)
    end

    SQL.exec("CREATE INDEX IF NOT EXISTS idx_vault_members_user ON vault_members(user_id)")

    SQL.exec("""
    INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, invited_by)
    SELECT id, created_by, 'owner', created_by FROM vaults
    """)

    SQL.exec("""
    UPDATE vault_members SET role = 'owner'
    WHERE (vault_id, user_id) IN (SELECT id, created_by FROM vaults) AND role != 'owner'
    """)
  end

  def ensure_public_vaults! do
    SQL.ensure_column("vaults", "visibility", "TEXT NOT NULL DEFAULT 'private'")
    SQL.ensure_column("vaults", "public_join_role", "TEXT NOT NULL DEFAULT 'viewer'")
    SQL.ensure_column("vaults", "public_summary", "TEXT NOT NULL DEFAULT ''")
    SQL.ensure_column("vaults", "public_topics", "TEXT NOT NULL DEFAULT '[]'")
    SQL.ensure_column("vaults", "public_guidelines", "TEXT NOT NULL DEFAULT ''")
    SQL.ensure_column("vaults", "public_home_note_id", "TEXT")
    SQL.ensure_column("vaults", "public_join_policy", "TEXT NOT NULL DEFAULT 'open'")
    SQL.exec("CREATE INDEX IF NOT EXISTS idx_vaults_visibility ON vaults(visibility)")

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS public_vault_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vault_id, user_id)
    )
    """)

    SQL.exec("""
    CREATE INDEX IF NOT EXISTS idx_public_join_requests_owner
    ON public_vault_join_requests(vault_id, status, created_at)
    """)

    SQL.exec(
      "UPDATE vaults SET visibility = 'private' WHERE visibility IS NULL OR visibility NOT IN ('private','public')"
    )

    SQL.exec(
      "UPDATE vaults SET public_join_role = 'viewer' WHERE public_join_role IS NULL OR public_join_role != 'viewer'"
    )

    SQL.exec("""
    UPDATE vaults SET public_join_policy = 'invite'
    WHERE public_join_policy IS NULL OR public_join_policy NOT IN ('open','request','invite')
    """)

    SQL.exec(
      "UPDATE public_vault_join_requests SET status = 'rejected' WHERE status NOT IN ('pending','approved','rejected')"
    )

    normalize_topics!()
  end

  def ensure_direct_messages! do
    statements = [
      """
      CREATE TABLE IF NOT EXISTS user_dm_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        allow_direct_messages INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS user_blocks (
        blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (blocker_user_id, blocked_user_id),
        CHECK (blocker_user_id != blocked_user_id)
      )
      """,
      "CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id)",
      """
      CREATE TABLE IF NOT EXISTS direct_message_channels (
        user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_a_id, user_b_id),
        CHECK (user_a_id < user_b_id)
      )
      """,
      "CREATE INDEX IF NOT EXISTS idx_dm_channels_source ON direct_message_channels(source_channel_id)",
      """
      CREATE TABLE IF NOT EXISTS user_dm_vaults (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_dm_vaults_vault ON user_dm_vaults(vault_id)"
    ]

    Enum.each(statements, &SQL.exec/1)
    backfill_dm_vaults!()
  end

  def ensure_moderation! do
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS vault_bans (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    )
    """)

    SQL.exec("CREATE INDEX IF NOT EXISTS idx_vault_bans_user ON vault_bans(user_id)")

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vault_id, target_type, target_id, reporter_user_id)
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS idx_content_reports_vault ON content_reports(vault_id, status, created_at)"
    )

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status, created_at)"
    )

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports(reporter_user_id, created_at)"
    )

    SQL.exec("""
    DELETE FROM vault_bans
    WHERE user_id IN (SELECT created_by FROM vaults WHERE vaults.id = vault_bans.vault_id)
    """)

    SQL.exec(
      "UPDATE content_reports SET status = 'open' WHERE status NOT IN ('open','dismissed','resolved')"
    )
  end

  def ensure_community_activity! do
    read_state_existed? = SQL.table_exists?("community_read_state")

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS community_read_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK(source_type IN ('channel','note')),
      source_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_type, source_id)
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS community_read_state_source_idx ON community_read_state(source_type, source_id)"
    )

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS community_note_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS community_note_activity_note_idx ON community_note_activity(note_id, changed_at DESC, id DESC)"
    )

    if not read_state_existed?, do: Cascade.Accounts.CommunityActivity.seed_existing_as_read!()
  end

  def ensure_android_battery! do
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS android_battery_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('launch','interval','background','resume')),
      foreground INTEGER NOT NULL, captured_at INTEGER NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      elapsed_realtime_ms INTEGER NOT NULL, process_cpu_ms INTEGER NOT NULL,
      uid_rx_bytes INTEGER NOT NULL, uid_tx_bytes INTEGER NOT NULL,
      power_save INTEGER NOT NULL, thermal_status INTEGER, level_percent INTEGER,
      charge_counter_uah INTEGER, current_now_ua INTEGER, current_average_ua INTEGER,
      charging INTEGER
    )
    """)

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS android_battery_samples_user_time_idx ON android_battery_samples(user_id, captured_at DESC)"
    )

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS android_battery_samples_session_idx ON android_battery_samples(session_id, captured_at ASC)"
    )
  end

  defp create_vault_members!(name) do
    unless name in ["vault_members", "vault_members_next"], do: raise("invalid membership table")

    SQL.exec("""
    CREATE TABLE #{name} (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role IN ('owner','editor','viewer')),
      invited_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (vault_id, user_id)
    )
    """)
  end

  defp repair_vault_members!(definition) do
    columns = SQL.columns("vault_members")

    foreign_keys =
      SQL.all("PRAGMA foreign_key_list(vault_members)")
      |> Enum.map(fn [_id, _seq, target, source, destination, on_update, on_delete, match] ->
        [source, target, destination, on_update, on_delete, match]
      end)
      |> Enum.sort()

    exact? =
      SQL.all("PRAGMA table_info(vault_members)") == @node_vault_member_columns and
        foreign_keys == Enum.sort(@node_vault_member_foreign_keys)

    three_roles? =
      Regex.match?(
        ~r/CHECK\s*\(\s*role\s+IN\s*\(\s*'owner'\s*,\s*'editor'\s*,\s*'viewer'\s*\)\s*\)/i,
        definition
      )

    unless exact? and three_roles? do
      role =
        if "role" in columns,
          do: "CASE role WHEN 'owner' THEN 'owner' WHEN 'viewer' THEN 'viewer' ELSE 'editor' END",
          else:
            "CASE WHEN user_id = (SELECT created_by FROM vaults WHERE id = vault_id) THEN 'owner' ELSE 'editor' END"

      invited = if "invited_by" in columns, do: "invited_by", else: "NULL"

      created =
        if "created_at" in columns,
          do: "COALESCE(NULLIF(created_at,''),datetime('now'))",
          else: "datetime('now')"

      SQL.transaction(fn ->
        SQL.exec("DROP TABLE IF EXISTS vault_members_next")
        create_vault_members!("vault_members_next")

        SQL.exec(
          "INSERT OR REPLACE INTO vault_members_next (rowid,vault_id,user_id,role,invited_by,created_at) SELECT rowid,vault_id,user_id,#{role},#{invited},#{created} FROM vault_members"
        )

        SQL.exec("DROP TABLE vault_members")
        SQL.exec("ALTER TABLE vault_members_next RENAME TO vault_members")
      end)
    end
  end

  defp normalize_topics! do
    Enum.each(SQL.all("SELECT id, public_topics FROM vaults"), fn [id, raw] ->
      normalized = raw |> Cascade.Accounts.PublicVaults.parse_topics() |> Jason.encode!()

      if normalized != to_string(raw || ""),
        do: SQL.exec("UPDATE vaults SET public_topics = ? WHERE id = ?", [normalized, id])
    end)
  end

  defp backfill_dm_vaults! do
    if SQL.table_exists?("chat_channel_links") do
      SQL.exec("""
      INSERT OR IGNORE INTO user_dm_vaults (user_id, vault_id)
      SELECT user_id, vault_id FROM (
        SELECT v.created_by AS user_id, v.id AS vault_id, v.created_at
        FROM vaults v
        WHERE (SELECT COUNT(*) FROM vault_members m WHERE m.vault_id = v.id) <= 1
          AND COALESCE(v.visibility, 'private') = 'private'
          AND EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = v.id)
          AND NOT EXISTS (
            SELECT 1 FROM notes n WHERE n.vault_id = v.id
              AND n.id NOT IN (SELECT source_channel_id FROM direct_message_channels)
              AND n.id NOT IN (
                SELECT l.local_channel_id FROM chat_channel_links l
                JOIN direct_message_channels d ON d.source_channel_id = l.source_channel_id
              )
          )
      ) ORDER BY created_at ASC, vault_id ASC
      """)
    end
  end

  def ensure_product_feedback! do
    SQL.exec("""
    CREATE TABLE IF NOT EXISTS product_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'documentation-assistant',
      surface TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)

    SQL.exec(
      "UPDATE product_feedback SET status = 'open' WHERE status IS NULL OR status NOT IN ('open','dismissed','resolved')"
    )

    SQL.exec(
      "CREATE INDEX IF NOT EXISTS idx_product_feedback_status_created ON product_feedback(status, created_at)"
    )
  end
end
