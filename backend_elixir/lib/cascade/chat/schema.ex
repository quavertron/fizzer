defmodule Cascade.Chat.Schema do
  @moduledoc "SQLite-compatible chat, linked-channel, agent identity, and note-grant schema."

  alias Cascade.Accounts.SQL
  alias Cascade.DB.Repo

  @message_columns [
    {"activity_at", "TEXT"},
    {"actor_user_id", "INTEGER REFERENCES users(id)"},
    {"status", "TEXT"},
    {"agent_id", "TEXT"},
    {"registration_id", "TEXT"},
    {"run_id", "INTEGER"},
    {"blocks_json", "TEXT"},
    {"harness_log", "TEXT"},
    {"images_json", "TEXT"},
    {"attachments_json", "TEXT"},
    {"reply_to_json", "TEXT"},
    {"forwarded_from_json", "TEXT"},
    {"change_request_json", "TEXT"},
    {"clarification_json", "TEXT"},
    {"mission_json", "TEXT"},
    {"mission_task_id", "TEXT"}
  ]

  @member_columns [
    {"vault_id", "TEXT"},
    {"vault_agent_id", "TEXT NOT NULL DEFAULT ''"},
    {"agent_id", "TEXT NOT NULL DEFAULT 'agent'"},
    {"display_name", "TEXT NOT NULL DEFAULT ''"},
    {"avatar_url", "TEXT NOT NULL DEFAULT ''"},
    {"mention", "TEXT NOT NULL DEFAULT ''"},
    {"model", "TEXT NOT NULL DEFAULT ''"},
    {"reasoning_effort", "TEXT NOT NULL DEFAULT ''"},
    {"priority_service_tier", "INTEGER NOT NULL DEFAULT 0"},
    {"cwd", "TEXT NOT NULL DEFAULT ''"},
    {"context_prompt", "TEXT NOT NULL DEFAULT ''"},
    {"taggable_by_agents", "INTEGER NOT NULL DEFAULT 0"},
    {"reply_to_every_message", "INTEGER NOT NULL DEFAULT 0"},
    {"orchestrator", "INTEGER NOT NULL DEFAULT 0"},
    {"next_step_suggestions", "INTEGER NOT NULL DEFAULT 0"},
    {"pingable_by_others", "INTEGER NOT NULL DEFAULT 0"},
    {"ambient_group_chat", "INTEGER NOT NULL DEFAULT 0"},
    {"final_reply_only", "INTEGER NOT NULL DEFAULT 0"},
    {"yolo", "INTEGER NOT NULL DEFAULT 0"},
    {"conversation_id", "TEXT NOT NULL DEFAULT ''"},
    {"created_at", "TEXT"},
    {"updated_at", "TEXT"}
  ]

  @identity_columns [
    {"agent_id", "TEXT NOT NULL DEFAULT 'agent'"},
    {"display_name", "TEXT NOT NULL DEFAULT ''"},
    {"avatar_url", "TEXT NOT NULL DEFAULT ''"},
    {"mention", "TEXT NOT NULL DEFAULT ''"},
    {"model", "TEXT NOT NULL DEFAULT ''"},
    {"cwd", "TEXT NOT NULL DEFAULT ''"},
    {"context_prompt", "TEXT NOT NULL DEFAULT ''"},
    {"hermes_profile", "TEXT NOT NULL DEFAULT ''"},
    {"hermes_safe_mode", "INTEGER NOT NULL DEFAULT 0"},
    {"identity_scope", "TEXT NOT NULL DEFAULT 'network'"},
    {"expires_at", "TEXT"},
    {"owner_user_id", "INTEGER REFERENCES users(id)"},
    {"imported_from_agent_id", "TEXT REFERENCES vault_agents(id) ON DELETE SET NULL"},
    {"created_at", "TEXT"},
    {"updated_at", "TEXT"}
  ]

  @node_table_columns %{
    "chat_messages" => [
      [0, "id", "TEXT", 0, nil, 1],
      [1, "channel_id", "TEXT", 1, nil, 0],
      [2, "vault_id", "TEXT", 1, nil, 0],
      [3, "author", "TEXT", 1, nil, 0],
      [4, "body", "TEXT", 1, "''", 0],
      [5, "created_at", "TEXT", 1, "datetime('now')", 0],
      [6, "activity_at", "TEXT", 0, nil, 0],
      [7, "actor_user_id", "INTEGER", 0, nil, 0],
      [8, "status", "TEXT", 0, nil, 0],
      [9, "agent_id", "TEXT", 0, nil, 0],
      [10, "registration_id", "TEXT", 0, nil, 0],
      [11, "run_id", "INTEGER", 0, nil, 0],
      [12, "blocks_json", "TEXT", 0, nil, 0],
      [13, "harness_log", "TEXT", 0, nil, 0],
      [14, "images_json", "TEXT", 0, nil, 0],
      [15, "attachments_json", "TEXT", 0, nil, 0],
      [16, "reply_to_json", "TEXT", 0, nil, 0],
      [17, "forwarded_from_json", "TEXT", 0, nil, 0],
      [18, "change_request_json", "TEXT", 0, nil, 0],
      [19, "mission_json", "TEXT", 0, nil, 0],
      [20, "mission_task_id", "TEXT", 0, nil, 0],
      [21, "clarification_json", "TEXT", 0, nil, 0]
    ],
    "chat_agent_members" => [
      [0, "id", "TEXT", 0, nil, 1],
      [1, "channel_id", "TEXT", 1, nil, 0],
      [2, "vault_id", "TEXT", 1, nil, 0],
      [3, "agent_id", "TEXT", 1, nil, 0],
      [4, "display_name", "TEXT", 1, "''", 0],
      [5, "avatar_url", "TEXT", 1, "''", 0],
      [6, "mention", "TEXT", 1, "''", 0],
      [7, "model", "TEXT", 1, "''", 0],
      [8, "reasoning_effort", "TEXT", 1, "''", 0],
      [9, "priority_service_tier", "INTEGER", 1, "0", 0],
      [10, "cwd", "TEXT", 1, "''", 0],
      [11, "context_prompt", "TEXT", 1, "''", 0],
      [12, "taggable_by_agents", "INTEGER", 1, "0", 0],
      [13, "reply_to_every_message", "INTEGER", 1, "0", 0],
      [14, "orchestrator", "INTEGER", 1, "0", 0],
      [15, "pingable_by_others", "INTEGER", 1, "0", 0],
      [16, "ambient_group_chat", "INTEGER", 1, "0", 0],
      [17, "final_reply_only", "INTEGER", 1, "0", 0],
      [18, "yolo", "INTEGER", 1, "0", 0],
      [19, "next_step_suggestions", "INTEGER", 1, "0", 0],
      [20, "conversation_id", "TEXT", 1, "''", 0],
      [21, "created_at", "TEXT", 1, "datetime('now')", 0],
      [22, "updated_at", "TEXT", 1, "datetime('now')", 0],
      [23, "vault_agent_id", "TEXT", 1, "''", 0]
    ],
    "chat_channel_links" => [
      [0, "local_channel_id", "TEXT", 0, nil, 1],
      [1, "local_vault_id", "TEXT", 1, nil, 0],
      [2, "source_channel_id", "TEXT", 1, nil, 0],
      [3, "source_vault_id", "TEXT", 1, nil, 0],
      [4, "created_by", "INTEGER", 1, nil, 0],
      [5, "created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0]
    ],
    "chat_note_grants" => [
      [0, "message_id", "TEXT", 1, nil, 1],
      [1, "channel_id", "TEXT", 1, nil, 0],
      [2, "note_id", "TEXT", 1, nil, 2],
      [3, "granted_by", "INTEGER", 1, nil, 0],
      [4, "created_at", "TEXT", 1, "datetime('now')", 0],
      [5, "title_snapshot", "TEXT", 0, nil, 0],
      [6, "content_snapshot", "TEXT", 0, nil, 0],
      [7, "preview_snapshot", "TEXT", 0, nil, 0]
    ]
  }

  @node_foreign_keys %{
    "chat_messages" => [
      ["actor_user_id", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_agent_members" => [
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_channel_links" => [
      ["created_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["local_channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["local_vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"],
      ["source_channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["source_vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
    ],
    "chat_note_grants" => [
      ["channel_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"],
      ["granted_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
      ["message_id", "chat_messages", "id", "NO ACTION", "CASCADE", "NONE"],
      ["note_id", "notes", "id", "NO ACTION", "CASCADE", "NONE"]
    ]
  }

  def ensure! do
    create_tables!()

    SQL.exec("""
    CREATE TABLE IF NOT EXISTS chat_next_step_checks (
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      registration_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'pending',
      message_id TEXT,
      reason TEXT NOT NULL DEFAULT '',
      feedback TEXT,
      feedback_message_id TEXT,
      PRIMARY KEY(channel_id,registration_id,source_id)
    )
    """)

    Enum.each(@message_columns, fn {name, definition} ->
      SQL.ensure_column("chat_messages", name, definition)
    end)

    Enum.each(@member_columns, fn {name, definition} ->
      SQL.ensure_column("chat_agent_members", name, definition)
    end)

    SQL.ensure_column(
      "chat_channel_settings",
      "kanban_note_id",
      "TEXT REFERENCES notes(id) ON DELETE SET NULL"
    )

    Enum.each(@identity_columns, fn {name, definition} ->
      SQL.ensure_column("vault_agents", name, definition)
    end)

    SQL.ensure_column("chat_note_grants", "channel_id", "TEXT")
    SQL.ensure_column("chat_note_grants", "title_snapshot", "TEXT")
    SQL.ensure_column("chat_note_grants", "content_snapshot", "TEXT")
    SQL.ensure_column("chat_note_grants", "preview_snapshot", "TEXT")
    backfill_agent_owners!()
    migrate_agent_identity_scope!()
    backfill_member_identities!()
    reconcile_member_uniqueness!()
    repair_node_schema_parity!()
    create_indexes_and_search!()
    :ok
  end

  defp create_tables! do
    for table <-
          ~w(chat_messages chat_agent_members vault_agents vault_agent_exclusions chat_channel_links chat_channel_settings chat_note_grants) do
      SQL.exec(create_table_sql(table, table))
    end
  end

  defp create_table_sql("chat_messages", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      activity_at TEXT, actor_user_id INTEGER REFERENCES users(id), status TEXT, agent_id TEXT,
      registration_id TEXT, run_id INTEGER, blocks_json TEXT, harness_log TEXT, images_json TEXT,
      attachments_json TEXT, reply_to_json TEXT, forwarded_from_json TEXT, change_request_json TEXT,
      mission_json TEXT, mission_task_id TEXT, clarification_json TEXT
    )
    """
  end

  defp create_table_sql("chat_agent_members", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
      mention TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '',
      priority_service_tier INTEGER NOT NULL DEFAULT 0, cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '', taggable_by_agents INTEGER NOT NULL DEFAULT 0,
      reply_to_every_message INTEGER NOT NULL DEFAULT 0, orchestrator INTEGER NOT NULL DEFAULT 0,
      pingable_by_others INTEGER NOT NULL DEFAULT 0, ambient_group_chat INTEGER NOT NULL DEFAULT 0,
      final_reply_only INTEGER NOT NULL DEFAULT 0, yolo INTEGER NOT NULL DEFAULT 0,
      next_step_suggestions INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), vault_agent_id TEXT NOT NULL DEFAULT ''
    )
    """
  end

  defp create_table_sql("vault_agents", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, display_name TEXT NOT NULL, avatar_url TEXT NOT NULL DEFAULT '',
      mention TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '', hermes_profile TEXT NOT NULL DEFAULT '',
      hermes_safe_mode INTEGER NOT NULL DEFAULT 0, identity_scope TEXT NOT NULL DEFAULT 'network',
      expires_at TEXT, owner_user_id INTEGER REFERENCES users(id),
      imported_from_agent_id TEXT REFERENCES vault_agents(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(owner_user_id,mention)
    )
    """
  end

  defp create_table_sql("vault_agent_exclusions", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      vault_agent_id TEXT NOT NULL REFERENCES vault_agents(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(vault_id,vault_agent_id)
    )
    """
  end

  defp create_table_sql("chat_channel_links", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      local_channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      local_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(local_vault_id,source_channel_id)
    )
    """
  end

  defp create_table_sql("chat_channel_settings", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE, cwd TEXT NOT NULL DEFAULT '',
      kanban_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """
  end

  defp create_table_sql("chat_note_grants", name) do
    """
    CREATE TABLE IF NOT EXISTS #{name} (
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      granted_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      title_snapshot TEXT, content_snapshot TEXT, preview_snapshot TEXT,
      PRIMARY KEY(message_id,note_id)
    )
    """
  end

  defp repair_node_schema_parity! do
    repairs =
      ["chat_messages", "chat_agent_members", "chat_channel_links", "chat_note_grants"]
      |> Enum.reject(&node_schema_exact?/1)

    if repairs != [] do
      Repo.checkout(
        fn ->
          SQL.exec("PRAGMA foreign_keys=OFF")

          try do
            SQL.transaction(fn ->
              if "chat_messages" in repairs do
                Enum.each(~w(chat_messages_ai chat_messages_ad chat_messages_au), fn trigger ->
                  SQL.exec("DROP TRIGGER IF EXISTS #{trigger}")
                end)

                SQL.exec("DROP TABLE IF EXISTS chat_messages_fts")
              end

              Enum.each(repairs, &rebuild_node_table!/1)
            end)
          after
            SQL.exec("PRAGMA foreign_keys=ON")
          end
        end,
        timeout: :infinity
      )
    end
  end

  defp node_schema_exact?(table) do
    columns = SQL.all("PRAGMA table_info(#{table})")

    foreign_keys =
      SQL.all("PRAGMA foreign_key_list(#{table})")
      |> Enum.map(fn [_id, _seq, target, source, destination, on_update, on_delete, match] ->
        [source, target, destination, on_update, on_delete, match]
      end)
      |> Enum.sort()

    constraints? =
      case table do
        "chat_agent_members" ->
          not Regex.match?(
            ~r/UNIQUE\s*\(\s*channel_id\s*,\s*vault_agent_id\s*\)/i,
            SQL.table_sql(table) || ""
          )

        "chat_channel_links" ->
          Regex.match?(
            ~r/UNIQUE\s*\(\s*local_vault_id\s*,\s*source_channel_id\s*\)/i,
            SQL.table_sql(table) || ""
          )

        _ ->
          true
      end

    columns == Map.fetch!(@node_table_columns, table) and
      foreign_keys == Enum.sort(Map.fetch!(@node_foreign_keys, table)) and constraints?
  end

  defp rebuild_node_table!(table) do
    replacement = table <> "_node_compat"
    SQL.exec("DROP TABLE IF EXISTS #{replacement}")
    SQL.exec(create_table_sql(table, replacement))
    target = Enum.map_join(Map.fetch!(@node_table_columns, table), ",", &Enum.at(&1, 1))

    select =
      if table == "chat_agent_members" do
        "id,channel_id,vault_id,COALESCE(agent_id,'agent'),COALESCE(display_name,''),COALESCE(avatar_url,''),COALESCE(mention,''),COALESCE(model,''),COALESCE(reasoning_effort,''),COALESCE(priority_service_tier,0),COALESCE(cwd,''),COALESCE(context_prompt,''),COALESCE(taggable_by_agents,0),COALESCE(reply_to_every_message,0),COALESCE(orchestrator,0),COALESCE(pingable_by_others,0),COALESCE(ambient_group_chat,0),COALESCE(final_reply_only,0),COALESCE(yolo,0),COALESCE(next_step_suggestions,0),COALESCE(conversation_id,''),COALESCE(created_at,datetime('now')),COALESCE(updated_at,datetime('now')),COALESCE(vault_agent_id,'')"
      else
        target
      end

    # `chat_messages.rowid` is the public message sequence used by the HTTP and
    # realtime contracts. Preserve rowids while normalizing the Node table
    # layout; compacting them during an upgrade would silently rewrite every
    # historical cursor even when message order happened to remain unchanged.
    SQL.exec("INSERT INTO #{replacement}(rowid,#{target}) SELECT rowid,#{select} FROM #{table}")

    SQL.exec("DROP TABLE #{table}")
    SQL.exec("ALTER TABLE #{replacement} RENAME TO #{table}")
  end

  defp create_indexes_and_search! do
    [
      "CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages(channel_id,created_at)",
      "CREATE INDEX IF NOT EXISTS chat_messages_activity_idx ON chat_messages(channel_id,activity_at)",
      "CREATE INDEX IF NOT EXISTS chat_messages_run_idx ON chat_messages(run_id)",
      "CREATE INDEX IF NOT EXISTS chat_agent_members_channel_idx ON chat_agent_members(channel_id)",
      "DROP INDEX IF EXISTS chat_agent_members_identity_idx",
      "CREATE UNIQUE INDEX chat_agent_members_identity_idx ON chat_agent_members(vault_id,channel_id,vault_agent_id)",
      "CREATE INDEX IF NOT EXISTS vault_agents_vault_idx ON vault_agents(vault_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS vault_agents_import_source_idx ON vault_agents(vault_id,imported_from_agent_id) WHERE imported_from_agent_id IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS vault_agents_owner_idx ON vault_agents(owner_user_id)",
      "CREATE INDEX IF NOT EXISTS chat_channel_links_source_idx ON chat_channel_links(source_channel_id)",
      "CREATE INDEX IF NOT EXISTS chat_note_grants_channel_idx ON chat_note_grants(channel_id,message_id)",
      "CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(author,body,content='chat_messages',content_rowid='rowid')",
      """
      CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid,author,body) VALUES(NEW.rowid,NEW.author,NEW.body); END
      """,
      """
      CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts,rowid,author,body) VALUES('delete',OLD.rowid,OLD.author,OLD.body); END
      """,
      """
      CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts,rowid,author,body) VALUES('delete',OLD.rowid,OLD.author,OLD.body);
        INSERT INTO chat_messages_fts(rowid,author,body) VALUES(NEW.rowid,NEW.author,NEW.body); END
      """,
      """
      INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('rebuild')
      """
    ]
    |> Enum.each(&SQL.exec/1)
  end

  defp backfill_agent_owners! do
    SQL.exec(
      "UPDATE vault_agents SET agent_id=COALESCE(NULLIF(agent_id,''),'agent'),display_name=COALESCE(NULLIF(display_name,''),agent_id),mention=COALESCE(NULLIF(mention,''),agent_id),created_at=COALESCE(created_at,datetime('now')),updated_at=COALESCE(updated_at,datetime('now'))"
    )

    SQL.exec("""
    UPDATE vault_agents SET owner_user_id=(SELECT created_by FROM vaults WHERE id=vault_agents.vault_id)
    WHERE owner_user_id IS NULL
    """)
  end

  defp migrate_agent_identity_scope! do
    schema = SQL.table_sql("vault_agents") || ""

    unless Regex.match?(~r/UNIQUE\s*\(\s*owner_user_id\s*,\s*mention\s*\)/i, schema) do
      Repo.checkout(
        fn ->
          SQL.exec("PRAGMA foreign_keys=OFF")

          try do
            SQL.transaction(fn ->
              if Regex.match?(
                   ~r/UNIQUE\s*\(\s*channel_id\s*,\s*vault_agent_id\s*\)/i,
                   SQL.table_sql("chat_agent_members") || ""
                 ) do
                rebuild_node_table!("chat_agent_members")
              end

              SQL.exec("DROP INDEX IF EXISTS chat_agent_members_identity_idx")
              merge_duplicate_identities!()

              exclusions =
                if SQL.table_exists?("vault_agent_exclusions"),
                  do:
                    SQL.all(
                      "SELECT vault_id,vault_agent_id,created_at FROM vault_agent_exclusions"
                    ),
                  else: []

              SQL.exec("DROP TABLE IF EXISTS vault_agent_exclusions")

              SQL.exec(create_table_sql("vault_agents", "vault_agents_owner_scoped"))

              SQL.exec(
                "INSERT INTO vault_agents_owner_scoped SELECT id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,hermes_profile,hermes_safe_mode,identity_scope,expires_at,owner_user_id,imported_from_agent_id,created_at,updated_at FROM vault_agents"
              )

              SQL.exec("DROP TABLE vault_agents")
              SQL.exec("ALTER TABLE vault_agents_owner_scoped RENAME TO vault_agents")

              SQL.exec(create_table_sql("vault_agent_exclusions", "vault_agent_exclusions"))

              Enum.each(exclusions, fn [vault_id, agent_id, created_at] ->
                SQL.exec(
                  "INSERT OR IGNORE INTO vault_agent_exclusions(vault_id,vault_agent_id,created_at) VALUES(?,?,?)",
                  [vault_id, agent_id, created_at]
                )
              end)
            end)
          after
            SQL.exec("PRAGMA foreign_keys=ON")
          end
        end,
        timeout: :infinity
      )
    end
  end

  defp merge_duplicate_identities! do
    SQL.all("""
    SELECT owner_user_id,lower(mention) FROM vault_agents WHERE owner_user_id IS NOT NULL
    GROUP BY owner_user_id,lower(mention) HAVING count(*)>1
    """)
    |> Enum.each(fn [owner_id, mention] ->
      [[winner | _] | losers] =
        SQL.all(
          "SELECT id,vault_id,mention FROM vault_agents WHERE owner_user_id=? AND mention=? COLLATE NOCASE ORDER BY created_at,id",
          [owner_id, mention]
        )

      Enum.each(losers, fn [loser | _] ->
        SQL.all(
          "SELECT id,vault_id,channel_id FROM chat_agent_members WHERE vault_agent_id=?",
          [loser]
        )
        |> Enum.each(fn [loser_registration, member_vault, member_channel] ->
          winner_registration =
            SQL.one(
              "SELECT id FROM chat_agent_members WHERE vault_agent_id=? AND vault_id=? AND channel_id=?",
              [winner, member_vault, member_channel]
            )

          case winner_registration do
            [registration] ->
              remap_registration!(loser_registration, registration)
              SQL.exec("DELETE FROM chat_agent_members WHERE id=?", [loser_registration])

            nil ->
              SQL.exec("UPDATE chat_agent_members SET vault_agent_id=? WHERE id=?", [
                winner,
                loser_registration
              ])
          end
        end)

        if SQL.table_exists?("vault_agent_exclusions") do
          SQL.exec(
            "INSERT OR IGNORE INTO vault_agent_exclusions(vault_id,vault_agent_id,created_at) SELECT vault_id,?,created_at FROM vault_agent_exclusions WHERE vault_agent_id=?",
            [winner, loser]
          )

          SQL.exec("DELETE FROM vault_agent_exclusions WHERE vault_agent_id=?", [loser])
        end

        SQL.exec("DELETE FROM vault_agents WHERE id=?", [loser])
      end)
    end)
  end

  defp remap_registration!(loser, winner) do
    SQL.exec(
      """
      DELETE FROM chat_next_step_checks
      WHERE registration_id=?
        AND EXISTS (
          SELECT 1
          FROM chat_next_step_checks AS winner_check
          WHERE winner_check.channel_id=chat_next_step_checks.channel_id
            AND winner_check.source_id=chat_next_step_checks.source_id
            AND winner_check.registration_id=?
        )
      """,
      [loser, winner]
    )

    SQL.exec("UPDATE chat_next_step_checks SET registration_id=? WHERE registration_id=?", [
      winner,
      loser
    ])

    SQL.exec("UPDATE chat_messages SET registration_id=? WHERE registration_id=?", [winner, loser])
  end

  defp backfill_member_identities! do
    SQL.all(
      "SELECT id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt FROM chat_agent_members WHERE vault_agent_id IS NULL OR vault_agent_id='' "
    )
    |> Enum.each(fn [member_id, vault_id, agent_id, name, avatar, mention, model, cwd, prompt] ->
      owner =
        case SQL.one("SELECT created_by FROM vaults WHERE id=?", [vault_id]) do
          [id] -> id
          _ -> nil
        end

      normalized = normalize_mention(mention, agent_id)

      identity =
        SQL.one(
          "SELECT id FROM vault_agents WHERE owner_user_id=? AND mention=? COLLATE NOCASE",
          [owner, normalized]
        ) ||
          begin_identity(vault_id, owner, agent_id, name, avatar, normalized, model, cwd, prompt)

      [identity_id] = identity

      SQL.exec("UPDATE chat_agent_members SET vault_agent_id=?,mention=? WHERE id=?", [
        identity_id,
        normalized,
        member_id
      ])
    end)
  end

  defp reconcile_member_uniqueness! do
    SQL.transaction(fn ->
      SQL.all("""
      SELECT loser.id,winner.id
      FROM chat_agent_members loser
      JOIN chat_agent_members winner
        ON winner.vault_id=loser.vault_id
       AND winner.channel_id=loser.channel_id
       AND winner.vault_agent_id=loser.vault_agent_id
       AND winner.rowid=(
         SELECT MIN(candidate.rowid) FROM chat_agent_members candidate
         WHERE candidate.vault_id=loser.vault_id
           AND candidate.channel_id=loser.channel_id
           AND candidate.vault_agent_id=loser.vault_agent_id
       )
      WHERE loser.rowid>winner.rowid
      """)
      |> Enum.each(fn [loser, winner] ->
        remap_registration!(loser, winner)
        SQL.exec("DELETE FROM chat_agent_members WHERE id=?", [loser])
      end)
    end)
  end

  defp begin_identity(vault_id, owner, agent_id, name, avatar, mention, model, cwd, prompt) do
    id = Ecto.UUID.generate()

    SQL.exec(
      "INSERT INTO vault_agents(id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,owner_user_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        id,
        vault_id,
        agent_id,
        blank(name, agent_id),
        avatar || "",
        mention,
        model || "",
        cwd || "",
        prompt || "",
        owner
      ]
    )

    [id]
  end

  def normalize_mention(value, fallback \\ "agent") do
    normalized =
      value
      |> blank(fallback)
      |> String.trim_leading("@")
      |> String.downcase()
      |> String.replace(~r/[^a-z0-9_-]+/, "-")
      |> String.trim("-")

    if normalized == "", do: "agent", else: normalized
  end

  defp blank(value, fallback),
    do: if(is_binary(value) and String.trim(value) != "", do: String.trim(value), else: fallback)
end
