defmodule Cascade.ChatDomainTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext, Schema}
  alias Cascade.Content.{Assets, Store}
  alias Cascade.Missions.Dispatches
  alias Cascade.Runs.Store, as: RunStore
  alias Cascade.Runs.RunnerLifecycle

  @node_column_signatures %{
    "chat_messages" => [
      ["id", "TEXT", 0, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["vault_id", "TEXT", 1, nil, 0],
      ["author", "TEXT", 1, nil, 0],
      ["body", "TEXT", 1, "''", 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["activity_at", "TEXT", 0, nil, 0],
      ["actor_user_id", "INTEGER", 0, nil, 0],
      ["status", "TEXT", 0, nil, 0],
      ["agent_id", "TEXT", 0, nil, 0],
      ["registration_id", "TEXT", 0, nil, 0],
      ["run_id", "INTEGER", 0, nil, 0],
      ["blocks_json", "TEXT", 0, nil, 0],
      ["harness_log", "TEXT", 0, nil, 0],
      ["images_json", "TEXT", 0, nil, 0],
      ["attachments_json", "TEXT", 0, nil, 0],
      ["reply_to_json", "TEXT", 0, nil, 0],
      ["forwarded_from_json", "TEXT", 0, nil, 0],
      ["change_request_json", "TEXT", 0, nil, 0],
      ["mission_json", "TEXT", 0, nil, 0],
      ["mission_task_id", "TEXT", 0, nil, 0],
      ["clarification_json", "TEXT", 0, nil, 0]
    ],
    "chat_agent_members" => [
      ["id", "TEXT", 0, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["vault_id", "TEXT", 1, nil, 0],
      ["agent_id", "TEXT", 1, nil, 0],
      ["display_name", "TEXT", 1, "''", 0],
      ["avatar_url", "TEXT", 1, "''", 0],
      ["mention", "TEXT", 1, "''", 0],
      ["model", "TEXT", 1, "''", 0],
      ["reasoning_effort", "TEXT", 1, "''", 0],
      ["priority_service_tier", "INTEGER", 1, "0", 0],
      ["cwd", "TEXT", 1, "''", 0],
      ["context_prompt", "TEXT", 1, "''", 0],
      ["taggable_by_agents", "INTEGER", 1, "0", 0],
      ["reply_to_every_message", "INTEGER", 1, "0", 0],
      ["orchestrator", "INTEGER", 1, "0", 0],
      ["pingable_by_others", "INTEGER", 1, "0", 0],
      ["ambient_group_chat", "INTEGER", 1, "0", 0],
      ["final_reply_only", "INTEGER", 1, "0", 0],
      ["yolo", "INTEGER", 1, "0", 0],
      ["next_step_suggestions", "INTEGER", 1, "0", 0],
      ["conversation_id", "TEXT", 1, "''", 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["updated_at", "TEXT", 1, "datetime('now')", 0],
      ["vault_agent_id", "TEXT", 1, "''", 0]
    ],
    "chat_channel_links" => [
      ["local_channel_id", "TEXT", 0, nil, 1],
      ["local_vault_id", "TEXT", 1, nil, 0],
      ["source_channel_id", "TEXT", 1, nil, 0],
      ["source_vault_id", "TEXT", 1, nil, 0],
      ["created_by", "INTEGER", 1, nil, 0],
      ["created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0]
    ],
    "chat_note_grants" => [
      ["message_id", "TEXT", 1, nil, 1],
      ["channel_id", "TEXT", 1, nil, 0],
      ["note_id", "TEXT", 1, nil, 2],
      ["granted_by", "INTEGER", 1, nil, 0],
      ["created_at", "TEXT", 1, "datetime('now')", 0],
      ["title_snapshot", "TEXT", 0, nil, 0],
      ["content_snapshot", "TEXT", 0, nil, 0],
      ["preview_snapshot", "TEXT", 0, nil, 0]
    ]
  }

  @node_foreign_key_signatures %{
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

  setup do
    root =
      Path.join(System.tmp_dir!(), "cascade-elixir-chat-#{System.unique_integer([:positive])}")

    previous = System.get_env("CASCADE_VAULTS_BASE_DIR")
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)

    reset_database()

    SQL.exec("""
    INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES
      (1,'alice','x','Alice','',0),(2,'bob','x','Bob','',0),(3,'carol','x','Carol','',0)
    """)

    on_exit(fn ->
      reset_database()
      File.rm_rf!(root)

      if previous,
        do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous),
        else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)

    :ok
  end

  test "fresh schema creates every table, index, FTS table, and trigger explicitly" do
    for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au),
        do: SQL.exec("DROP TRIGGER IF EXISTS #{trigger}")

    SQL.exec("DROP TABLE IF EXISTS chat_messages_fts")

    for table <-
          ~w(chat_note_grants chat_channel_settings chat_channel_links vault_agent_exclusions chat_agent_members vault_agents chat_messages),
        do: SQL.exec("DROP TABLE IF EXISTS #{table}")

    assert :ok = Schema.ensure!()

    for table <-
          ~w(chat_messages chat_agent_members vault_agents vault_agent_exclusions chat_channel_links chat_channel_settings chat_note_grants chat_messages_fts) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table]) == [1]
    end

    for index <-
          ~w(chat_messages_channel_idx chat_messages_activity_idx chat_messages_run_idx chat_agent_members_channel_idx vault_agents_vault_idx vault_agents_owner_idx chat_channel_links_source_idx chat_note_grants_channel_idx) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?", [index]) == [1]
    end

    for table <- Map.keys(@node_column_signatures), do: assert_node_columns(table)

    refute SQL.table_sql("chat_agent_members") =~ "UNIQUE(channel_id,vault_agent_id)"
    assert SQL.table_sql("chat_channel_links") =~ "UNIQUE(local_vault_id,source_channel_id)"
    assert SQL.table_sql("chat_messages") =~ "REFERENCES users(id)"
    assert SQL.table_sql("chat_note_grants") =~ "PRIMARY KEY(message_id,note_id)"

    for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?", [trigger]) ==
               [1]
    end
  end

  test "linking an agent restores legacy identity metadata without relabeling human messages" do
    {vault, channel} = chat_vault(1, "Agents", "General")

    assert {:ok, identity} =
             Agents.upsert_identity(1, vault.id, %{
               agentId: "codex",
               displayName: "Builder",
               mention: "builder"
             })

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body) VALUES(?,?,?,?,?),(?,?,?,?,?)",
      [
        "agent-builder-old",
        channel.id,
        vault.id,
        "builder",
        "legacy agent output",
        "msg-human-builder",
        channel.id,
        vault.id,
        "builder",
        "human output"
      ]
    )

    assert {:ok, member} = Agents.add_to_channel(1, vault.id, channel.id, identity.id)

    assert ["codex", member.id] ==
             SQL.one(
               "SELECT agent_id,registration_id FROM chat_messages WHERE id='agent-builder-old'"
             )

    assert [nil, nil] ==
             SQL.one(
               "SELECT agent_id,registration_id FROM chat_messages WHERE id='msg-human-builder'"
             )
  end

  test "Node upgrade canonicalizes legacy Elixir ordering without losing chat data" do
    {source, source_channel} = chat_vault(1, "Schema source", "Source")
    {local, local_channel} = chat_vault(2, "Schema local", "Local")
    shared_note = Store.create_note(source.id, 1, %{title: "Shared", content: "payload"})

    identity = Ecto.UUID.generate()

    SQL.exec(
      "INSERT INTO vault_agents(id,vault_id,agent_id,display_name,mention,owner_user_id) VALUES(?,?,'codex','Sol','sol',1)",
      [identity, source.id]
    )

    Cascade.DB.Repo.checkout(fn ->
      SQL.exec("PRAGMA foreign_keys=OFF")

      try do
        SQL.transaction(fn ->
          for trigger <- ~w(chat_messages_ai chat_messages_ad chat_messages_au),
              do: SQL.exec("DROP TRIGGER IF EXISTS #{trigger}")

          SQL.exec("DROP TABLE IF EXISTS chat_messages_fts")

          for table <- ~w(chat_note_grants chat_channel_links chat_agent_members chat_messages),
              do: SQL.exec("DROP TABLE #{table}")

          SQL.exec("""
          CREATE TABLE chat_messages (
            id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,author TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
            activity_at TEXT,actor_user_id INTEGER REFERENCES users(id),status TEXT,agent_id TEXT,
            registration_id TEXT,run_id INTEGER,blocks_json TEXT,harness_log TEXT,images_json TEXT,
            attachments_json TEXT,reply_to_json TEXT,forwarded_from_json TEXT,change_request_json TEXT,
            clarification_json TEXT,mission_json TEXT,mission_task_id TEXT)
          """)

          SQL.exec("""
          CREATE TABLE chat_agent_members (
            id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,vault_agent_id TEXT NOT NULL DEFAULT '',
            agent_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',
            mention TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
            priority_service_tier INTEGER NOT NULL DEFAULT 0,cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',
            taggable_by_agents INTEGER NOT NULL DEFAULT 0,reply_to_every_message INTEGER NOT NULL DEFAULT 0,
            orchestrator INTEGER NOT NULL DEFAULT 0,pingable_by_others INTEGER NOT NULL DEFAULT 0,yolo INTEGER NOT NULL DEFAULT 0,
            conversation_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT(datetime('now')),
            updated_at TEXT NOT NULL DEFAULT(datetime('now')),UNIQUE(channel_id,vault_agent_id))
          """)

          SQL.exec("""
          CREATE TABLE chat_channel_links (
            local_channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            local_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(local_vault_id,source_channel_id))
          """)

          SQL.exec("""
          CREATE TABLE chat_note_grants (
            message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
            channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            granted_by INTEGER NOT NULL REFERENCES users(id),title_snapshot TEXT,content_snapshot TEXT,
            preview_snapshot TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')),
            PRIMARY KEY(message_id,note_id))
          """)

          SQL.exec(
            "INSERT INTO chat_messages(rowid,id,channel_id,vault_id,author,body,created_at,clarification_json,mission_json,mission_task_id) VALUES(41,'schema-message',?,?,'alice','preserve me','2026-08-10T12:00:00.000Z','{\"question\":\"q\"}','{\"title\":\"m\"}','task-1')",
            [source_channel.id, source.id]
          )

          SQL.exec(
            "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention,created_at,updated_at) VALUES('schema-member',?,?,?,'codex','Sol','sol','2026-08-10T12:01:00.000Z','2026-08-10T12:02:00.000Z')",
            [source_channel.id, source.id, identity]
          )

          SQL.exec(
            "INSERT INTO chat_channel_links VALUES(?,?,?,?,1,'2026-08-10T12:03:00.000Z')",
            [local_channel.id, local.id, source_channel.id, source.id]
          )

          SQL.exec(
            "INSERT INTO chat_note_grants VALUES('schema-message',?,?,1,'Shared','payload','preview','2026-08-10T12:04:00.000Z')",
            [source_channel.id, shared_note.id]
          )
        end)
      after
        SQL.exec("PRAGMA foreign_keys=ON")
      end
    end)

    assert :ok = Schema.ensure!()
    for table <- Map.keys(@node_column_signatures), do: assert_node_columns(table)

    assert ["preserve me", ~s({"title":"m"}), "task-1", ~s({"question":"q"})] ==
             SQL.one(
               "SELECT body,mission_json,mission_task_id,clarification_json FROM chat_messages WHERE id='schema-message'"
             )

    assert [41] == SQL.one("SELECT rowid FROM chat_messages WHERE id='schema-message'")

    assert [41] ==
             SQL.one(
               "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'preserve' AND rowid=41"
             )

    assert ["schema-member", identity, "2026-08-10T12:01:00.000Z"] ==
             SQL.one(
               "SELECT id,vault_agent_id,created_at FROM chat_agent_members WHERE id='schema-member'"
             )

    assert ["Shared", "payload", "preview", "2026-08-10T12:04:00.000Z"] ==
             SQL.one(
               "SELECT title_snapshot,content_snapshot,preview_snapshot,created_at FROM chat_note_grants WHERE message_id='schema-message'"
             )

    assert [source_channel.id, "2026-08-10T12:03:00.000Z"] ==
             SQL.one(
               "SELECT source_channel_id,created_at FROM chat_channel_links WHERE local_channel_id=?",
               [local_channel.id]
             )

    assert :ok = Schema.ensure!()
    assert [41] == SQL.one("SELECT rowid FROM chat_messages WHERE id='schema-message'")

    SQL.exec("UPDATE chat_messages SET body='updated search token' WHERE id='schema-message'")

    assert [[41]] =
             SQL.all(
               "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'updated'"
             )

    assert [] =
             SQL.all(
               "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'preserve'"
             )

    SQL.exec("DELETE FROM chat_messages WHERE id='schema-message'")

    assert [] =
             SQL.all(
               "SELECT rowid FROM chat_messages_fts WHERE chat_messages_fts MATCH 'updated'"
             )

    assert [] =
             SQL.all("SELECT message_id FROM chat_note_grants WHERE message_id='schema-message'")

    assert [] = SQL.all("PRAGMA foreign_key_check")
  end

  test "legacy per-vault identities upgrade on one checked-out connection and merge by owner handle" do
    {one, first_channel} = chat_vault(1, "Legacy one", "First")
    {two, second_channel} = chat_vault(1, "Legacy two", "Second")

    Cascade.DB.Repo.checkout(fn ->
      SQL.exec("PRAGMA foreign_keys=OFF")

      try do
        SQL.exec("DROP TABLE vault_agent_exclusions")
        SQL.exec("DROP TABLE chat_agent_members")
        SQL.exec("DROP TABLE vault_agents")

        SQL.exec("""
        CREATE TABLE vault_agents (
          id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,agent_id TEXT NOT NULL,display_name TEXT NOT NULL,
          avatar_url TEXT NOT NULL DEFAULT '',mention TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',owner_user_id INTEGER,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(vault_id,mention)
        )
        """)

        SQL.exec("""
        CREATE TABLE chat_agent_members (
          id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,vault_id TEXT NOT NULL,vault_agent_id TEXT NOT NULL DEFAULT '',
          agent_id TEXT NOT NULL,display_name TEXT NOT NULL DEFAULT '',avatar_url TEXT NOT NULL DEFAULT '',
          mention TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',reasoning_effort TEXT NOT NULL DEFAULT '',
          priority_service_tier INTEGER NOT NULL DEFAULT 0,cwd TEXT NOT NULL DEFAULT '',context_prompt TEXT NOT NULL DEFAULT '',
          taggable_by_agents INTEGER NOT NULL DEFAULT 0,reply_to_every_message INTEGER NOT NULL DEFAULT 0,
          orchestrator INTEGER NOT NULL DEFAULT 0,pingable_by_others INTEGER NOT NULL DEFAULT 0,yolo INTEGER NOT NULL DEFAULT 0,
          conversation_id TEXT NOT NULL DEFAULT '',created_at TEXT,updated_at TEXT
        )
        """)

        SQL.exec(
          "INSERT INTO vault_agents VALUES('old-a',?,'codex','Sol','','sol','','','',1,'2020-01-01','2020-01-01')",
          [one.id]
        )

        SQL.exec(
          "INSERT INTO vault_agents VALUES('old-b',?,'codex','Sol','','sol','','','',1,'2021-01-01','2021-01-01')",
          [two.id]
        )

        SQL.exec(
          "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES('member-a',?,?,'old-a','codex','Sol','sol')",
          [first_channel.id, one.id]
        )

        SQL.exec(
          "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES('member-b',?,?,'old-b','codex','Sol','sol')",
          [second_channel.id, two.id]
        )
      after
        SQL.exec("PRAGMA foreign_keys=ON")
      end
    end)

    assert :ok = Schema.ensure!()
    assert [["old-a", 1, "sol"]] = SQL.all("SELECT id,owner_user_id,mention FROM vault_agents")
    assert SQL.all("SELECT DISTINCT vault_agent_id FROM chat_agent_members") == [["old-a"]]
    assert SQL.table_sql("vault_agents") =~ "UNIQUE(owner_user_id,mention)"
  end

  test "linked projections keep chronological rows separate with truthful human and agent attribution" do
    {source, source_channel} = chat_vault(1, "Source", "Room")
    {local, local_channel} = chat_vault(2, "Bob", "Mirror")
    assert {:ok, _} = Channel.link(source.id, source_channel.id, local.id, local_channel.id, 1)

    alice = %{id: 1, username: "alice"}
    bob = %{id: 2, username: "bob"}
    at = "2026-08-10T12:00:00.000Z"

    assert {:ok, first} =
             Messages.create(alice, source.id, source_channel.id, %{
               id: "m-human",
               author: "spoof",
               body: "one",
               createdAt: at
             })

    assert first.author == "alice"
    assert first.actorUserId == alice.id

    assert {:ok, identity} =
             Agents.upsert_identity(1, source.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol"
             })

    assert {:ok, registration} =
             Agents.add_to_channel(1, source.id, source_channel.id, identity.id)

    assert {:ok, second} =
             Messages.create(
               alice,
               source.id,
               source_channel.id,
               %{
                 id: "m-agent",
                 body: "two",
                 createdAt: at,
                 registrationId: registration.id,
                 author: "Terra"
               },
               access: :agent
             )

    assert second.author == "Sol"
    assert second.registrationId == registration.id

    assert {:ok, third} =
             Messages.create(bob, local.id, local_channel.id, %{
               id: "m-bob",
               body: "three",
               createdAt: at
             })

    assert third.channelId == local_channel.id
    assert third.actorUserId == bob.id
    Store.create_note(local.id, bob.id, %{title: "Private plan", content: "private"})

    for id <- [first.id, second.id] do
      assert {:error, _} =
               Messages.create(bob, local.id, local_channel.id, %{
                 id: id,
                 body: "![[Private plan]]",
                 actorUserId: alice.id
               })
    end

    for {user, patch} <- [
          {bob, %{body: "![[Private plan]]"}},
          {alice, %{author: "bob"}},
          {alice, %{agentId: "other"}},
          {alice, %{registrationId: nil}},
          {alice, %{actorUserId: bob.id}}
        ] do
      {vault, channel} =
        if user == bob, do: {local, local_channel}, else: {source, source_channel}

      assert {:error, _} =
               Messages.update(user, vault.id, channel.id, second.id, patch, access: :agent)
    end

    for {user, input} <- [
          {bob, %{id: second.id, author: "Sol", agentId: "codex"}},
          {alice, %{id: second.id, author: "Other", agentId: "codex"}},
          {alice, %{id: first.id, author: "alice"}}
        ] do
      {vault, channel} =
        if user == bob, do: {local, local_channel}, else: {source, source_channel}

      assert {:error, _} =
               Messages.create(user, vault.id, channel.id, input, access: :agent)
    end

    other_channel =
      Store.create_note(source.id, 1, %{title: "Other", content: "cascade://chat-channel"})

    assert {:error, _} =
             Messages.create(alice, source.id, other_channel.id, %{
               id: first.id,
               body: "collision"
             })

    assert {:ok, ^first} = Messages.get(source_channel.id, 1, first.id)
    assert {:ok, ^second} = Messages.get(source_channel.id, 1, second.id)
    assert [] = SQL.all("SELECT message_id FROM chat_note_grants")

    assert [] =
             SQL.all(
               "SELECT message_id FROM chat_note_backlinks WHERE target_title='Private plan'"
             )

    assert {:ok, retried} = Messages.create(bob, local.id, local_channel.id, third)
    assert retried == third

    assert {:ok, retried} =
             Messages.create(alice, source.id, source_channel.id, second, access: :agent)

    assert retried == second

    # Legacy ownership is recoverable only from a human author or a matching registration.
    SQL.exec("UPDATE chat_messages SET actor_user_id=NULL WHERE id IN ('m-human','m-agent')")

    assert {:error, _} =
             Messages.update(bob, local.id, local_channel.id, second.id, %{body: "stolen"},
               access: :agent
             )

    assert {:ok, projected} =
             Messages.update(alice, source.id, source_channel.id, second.id, %{body: "projected"},
               access: :agent
             )

    assert projected.seq == second.seq
    assert {:ok, retried} = Messages.create(alice, source.id, source_channel.id, first)
    assert retried == first

    assert {:ok, retried} =
             Messages.create(alice, source.id, source_channel.id, second, access: :agent)

    assert retried == second

    assert {:ok, messages} = Messages.list(local_channel.id, 2)
    assert Enum.map(messages, & &1.id) == ~w(m-human m-agent m-bob)
    assert Enum.map(messages, & &1.author) == ["alice", "Sol", "bob"]
    assert Enum.all?(messages, &(&1.channelId == local_channel.id))
    assert Enum.sort(Enum.map(messages, & &1.seq)) == Enum.map(messages, & &1.seq)

    assert {:ok, system} =
             Messages.create(
               alice,
               source.id,
               source_channel.id,
               %{id: "sys-mission", body: "Ready"},
               access: :system
             )

    assert {:ok, ^system} =
             Messages.create(alice, source.id, source_channel.id, system, access: :system)
  end

  test "owned agent profiles can be reused across vaults and profile deletion is explicit" do
    {first_vault, first_channel} = chat_vault(1, "One", "A")
    {test_vault, test_channel} = chat_vault(1, "Test", "B")

    test_channel_two =
      Store.create_note(test_vault.id, 1, %{title: "C", content: "cascade://chat-channel"})

    assert {:ok, identity} =
             Agents.upsert_identity(1, first_vault.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol"
             })

    assert {:ok, first_member} =
             Agents.add_to_channel(1, first_vault.id, first_channel.id, identity.id)

    assert {:ok, available} = Agents.list_vault(1, test_vault.id)
    assert Enum.any?(available, &(&1.id == identity.id))

    assert {:ok, []} = Agents.list_members(test_channel.id, 1)

    assert SQL.one(
             "SELECT id FROM chat_agent_members WHERE vault_agent_id=? AND vault_id=?",
             [identity.id, test_vault.id]
           ) == nil

    assert {:ok, second_member} =
             Agents.add_to_channel(1, test_vault.id, test_channel.id, identity.id)

    assert second_member.vaultAgentId == identity.id

    assert {:ok, [projected_member]} =
             Agents.ensure_vault_wide(1, test_vault.id, test_channel_two.id)

    assert projected_member.vaultAgentId == identity.id

    assert {:ok, true} =
             Agents.remove_member(1, test_vault.id, test_channel_two.id, projected_member.id)

    assert {:ok, []} = Agents.list_members(test_channel.id, 1)
    assert {:ok, []} = Agents.ensure_vault_wide(1, test_vault.id, test_channel_two.id)

    assert {:ok, true} = Agents.unlink_from_vault(1, first_vault.id, identity.id)
    assert {:ok, reusable_profile} = Agents.get(1, first_vault.id, identity.id)
    assert reusable_profile.id == identity.id

    assert SQL.one("SELECT id FROM chat_agent_members WHERE id=?", [first_member.id]) == nil

    assert {:error, "Agent was removed from this vault"} =
             Agents.add_to_channel(1, first_vault.id, first_channel.id, identity.id)

    assert {:ok, restored_member} =
             Agents.add_to_channel(1, first_vault.id, first_channel.id, identity.id, %{}, true)

    assert restored_member.vaultAgentId == identity.id

    assert SQL.one("SELECT id FROM chat_agent_members WHERE channel_id=?", [test_channel.id]) ==
             nil

    assert SQL.one("SELECT id FROM vault_agents WHERE id=?", [identity.id]) == [identity.id]

    assert {:ok, true} = Agents.delete_profile(1, first_vault.id, identity.id)
    assert SQL.one("SELECT id FROM vault_agents WHERE id=?", [identity.id]) == nil

    assert SQL.one("SELECT id FROM chat_agent_members WHERE vault_agent_id=?", [identity.id]) ==
             nil
  end

  test "vault agents separate local aliases, leases, and invocation policy" do
    {home, channel} = chat_vault(1, "Agent home", "Room")
    {other, _other_channel} = chat_vault(1, "Other", "Elsewhere")
    {bob_home, _bob_channel} = chat_vault(2, "Bob agents", "Bots")

    assert {:ok, network} =
             Agents.upsert_identity(1, home.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol",
               identityScope: "network"
             })

    assert network.identityScope == "vault"

    assert {:ok, bob_sol} =
             Agents.upsert_identity(2, bob_home.id, %{
               agentId: "codex",
               displayName: "Bob's Sol",
               mention: "sol",
               identityScope: "network"
             })

    assert bob_sol.mention == network.mention

    assert {:ok, member} =
             Agents.add_to_channel(1, home.id, channel.id, network.id, %{
               mention: "room-sol",
               model: "room-model",
               pingableByOthers: false,
               finalReplyOnly: true
             })

    assert member.mention == "sol"
    refute member.pingableByOthers
    assert member.finalReplyOnly

    assert {:ok, renamed} =
             Agents.upsert_identity(1, home.id, %{
               id: network.id,
               agentId: "codex",
               displayName: "Solar",
               mention: "solar",
               model: "new-default",
               identityScope: "network"
             })

    assert renamed.mention == "solar"
    assert {:ok, [local]} = Agents.list_members(channel.id, 1)
    assert local.mention == "solar"
    assert local.model == "room-model"

    assert {:ok, vault_bot} =
             Agents.upsert_identity(1, home.id, %{
               agentId: "codex",
               displayName: "Scratch bot",
               mention: "scratch",
               identityScope: "vault"
             })

    assert {:ok, other_agents} = Agents.list_vault(1, other.id)
    assert Enum.any?(other_agents, &(&1.id == network.id))
    assert Enum.any?(other_agents, &(&1.id == vault_bot.id))

    assert {:ok, session} =
             Agents.upsert_identity(1, home.id, %{
               agentId: "codex",
               displayName: "Temporary",
               mention: "temporary",
               identityScope: "session",
               expiresAt: DateTime.utc_now() |> DateTime.add(60, :second) |> DateTime.to_iso8601()
             })

    assert {:ok, session_member} =
             Agents.add_to_channel(1, home.id, channel.id, session.id, %{mention: "temp-local"})

    assert session_member.mention == "temporary"

    SQL.exec("UPDATE vault_agents SET expires_at='2000-01-01T00:00:00Z' WHERE id=?", [session.id])
    assert {:ok, active_members} = Agents.list_members(channel.id, 1)
    refute Enum.any?(active_members, &(&1.id == session_member.id))
    assert {:ok, home_agents} = Agents.list_vault(1, home.id)
    refute Enum.any?(home_agents, &(&1.id == session.id))
    assert SQL.one("SELECT id FROM vault_agents WHERE id=?", [session.id]) == nil
  end

  test "vault handles are unique across agents controlled by different members" do
    {vault, _channel} = chat_vault(1, "Shared agents", "Room")
    assert {:ok, _member} = VaultMembers.add(vault.id, 1, 2, "editor")

    assert {:ok, _bob_agent} =
             Agents.upsert_identity(2, vault.id, %{
               agentId: "claude-code",
               displayName: "Bob's helper",
               mention: "helper",
               identityScope: "vault"
             })

    assert {:error, "Mention @helper is already used by another agent"} =
             Agents.upsert_identity(1, vault.id, %{
               agentId: "codex",
               displayName: "Alice's helper",
               mention: "helper",
               identityScope: "vault"
             })
  end

  test "concurrent identity adds preserve a single channel registration" do
    {vault, channel} = chat_vault(1, "One", "A")

    assert {:ok, identity} =
             Agents.upsert_identity(1, vault.id, %{
               agentId: "codex",
               displayName: "Codex",
               mention: "codex"
             })

    registrations =
      1..8
      |> Task.async_stream(
        fn _ -> Agents.add_to_channel(1, vault.id, channel.id, identity.id) end,
        max_concurrency: 8,
        ordered: false
      )
      |> Enum.map(fn {:ok, {:ok, registration}} -> registration.id end)

    assert length(Enum.uniq(registrations)) == 1

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_agent_members WHERE channel_id=? AND vault_agent_id=?",
             [channel.id, identity.id]
           ) == [1]
  end

  test "terminal projection preserves mission artifacts and publishes one durable outcome" do
    {vault, channel} = chat_vault(1, "Projection", "Room")
    user = %{id: 1, username: "alice"}
    {:ok, run} = RunStore.start(vault.id, nil, "verify publication", "codex")

    {:ok, shell} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "publication-shell",
          author: "Astra",
          agentId: "codex",
          runId: run.id,
          status: "running",
          body: "",
          mission: %{id: "mission", title: "Fix legibility", status: "active"}
        },
        access: :agent
      )

    RunStore.publish(run.id, "status", %{status: "completed", suppressChatBody: true})
    Cascade.Runs.ChatProjection.sync(run.id)
    assert {:ok, rows} = Messages.list(channel.id, 1)
    assert Enum.any?(rows, &(&1.id == shell.id and &1.mission["id"] == "mission"))

    {:ok, final_run} = RunStore.start(vault.id, nil, "publish outcome", "codex")

    {:ok, final_shell} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "publication-outcome",
          author: "Astra",
          agentId: "codex",
          runId: final_run.id,
          status: "running",
          body: ""
        },
        access: :agent
      )

    RunStore.publish(final_run.id, "status", %{
      status: "completed",
      summary: "Fixed legibility. Checks passed."
    })

    Cascade.Runs.ChatProjection.sync(final_run.id)
    Cascade.Runs.ChatProjection.sync(final_run.id)
    assert {:ok, rows} = Messages.list(channel.id, 1)

    assert [%{body: "Fixed legibility. Checks passed."} = outcome] =
             Enum.filter(rows, &(&1.id == final_shell.id))

    assert is_nil(outcome[:status])
  end

  test "message list strips heavy images while detail hydrates and embeds stay frozen and redact for agents" do
    {vault, channel} = chat_vault(1, "Notes", "Room")
    Store.create_note(vault.id, 1, %{title: "Plan", content: "public\n:::private\nsecret\n:::"})
    user = %{id: 1, username: "alice"}

    assert {:ok, created} =
             Messages.create(user, vault.id, channel.id, %{
               id: "media",
               body: "See ![[Plan|short#part]]",
               images: ["data:image/png;base64,AAAA", "https://example.com/a.png"]
             })

    assert {:ok, [listed]} = Messages.list(channel.id, 1)
    assert listed.hasImages
    assert listed.images == ["https://example.com/a.png"]
    assert {:ok, detailed} = Messages.get(channel.id, 1, created.id)
    assert length(detailed.images) == 2
    assert {:ok, [human]} = Messages.embeds(channel.id, 1, created.id)
    assert human.content =~ "secret"
    assert {:ok, [agent]} = Messages.embeds(channel.id, 1, created.id, access: :agent)
    refute agent.content =~ "secret"
    assert agent.content =~ "Private block hidden"
  end

  test "deleting an offline reply cancels its durable dispatch before run insertion" do
    {vault, channel} = chat_vault(1, "Queued cancellation", "Room")
    user = %{id: 1, username: "alice"}

    {:ok, registration} =
      Agents.upsert_member(1, vault.id, channel.id, %{agentId: "codex", mention: "sol"})

    {:ok, trigger} = Messages.create(user, vault.id, channel.id, %{body: "@sol work"})
    {:ok, dispatch} = Dispatches.create(1, channel.id, trigger, registration.id)

    {:ok, shell} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "agent-dispatch-#{dispatch.id}",
          registrationId: registration.id,
          body: "Queued...",
          status: "queued"
        },
        access: :agent
      )

    assert {:ok, _} = Messages.delete(user, vault.id, channel.id, shell.id)
    assert {:error, _} = Dispatches.for_execution(dispatch.id)

    assert {:error, _} =
             RunStore.start(vault.id, nil, "must not start", "codex",
               chat_dispatch_id: dispatch.id
             )

    assert RunStore.find_by_chat_dispatch(dispatch.id) == nil

    {:ok, running} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{author: "Sol", body: "Working", status: "running", agentId: "codex"},
        access: :agent
      )

    assert {:error, "Run already started; use Stop run."} =
             Messages.delete(user, vault.id, channel.id, running.id, queued_only: true)

    assert {:ok, _} = Messages.get(channel.id, user.id, running.id)
  end

  test "superseded queued replies can be deleted only when no run was ever started" do
    {vault, channel} = chat_vault(1, "Superseded replies", "Room")
    user = %{id: 1, username: "alice"}

    {:ok, registration} =
      Agents.upsert_member(1, vault.id, channel.id, %{agentId: "codex", mention: "sol"})

    for started <- [false, true] do
      {:ok, trigger} = Messages.create(user, vault.id, channel.id, %{body: "@sol work"})
      {:ok, dispatch} = Dispatches.create(1, channel.id, trigger, registration.id)

      {:ok, shell} =
        Messages.create(
          user,
          vault.id,
          channel.id,
          %{
            id: "agent-dispatch-#{dispatch.id}",
            registrationId: registration.id,
            body: "Queued...",
            status: "queued"
          },
          access: :agent
        )

      if started do
        assert {:ok, _} =
                 RunStore.start(vault.id, nil, "started before attachment", "codex",
                   chat_dispatch_id: dispatch.id
                 )
      end

      SQL.exec("DELETE FROM chat_agent_dispatches WHERE id=? AND run_id IS NULL", [dispatch.id])

      if started do
        assert {:error, "Run already started; use Stop run."} =
                 Messages.delete(user, vault.id, channel.id, shell.id, queued_only: true)
      else
        assert {:ok, _} = Messages.delete(user, vault.id, channel.id, shell.id, queued_only: true)
        assert {:error, "Message not found"} = Messages.get(channel.id, user.id, shell.id)
      end
    end
  end

  test "message list follows commit order when client timestamps disagree" do
    {vault, channel} = chat_vault(1, "Ordered messages", "Room")
    user = %{id: 1, username: "alice"}

    assert {:ok, first} =
             Messages.create(user, vault.id, channel.id, %{
               id: "clock-ahead",
               body: "prompt",
               createdAt: "2026-08-27T12:35:00.000Z"
             })

    assert {:ok, second} =
             Messages.create(user, vault.id, channel.id, %{
               id: "clock-behind",
               body: "reply",
               createdAt: "2026-08-27T12:34:00.000Z"
             })

    assert first.seq < second.seq
    assert {:ok, messages} = Messages.list(channel.id, 1)
    assert Enum.map(messages, & &1.id) == ~w(clock-ahead clock-behind)
    assert {:ok, [snapshot]} = Messages.list(channel.id, 1, through_message_id: first.id)
    assert snapshot.id == first.id
    assert {:ok, []} = Messages.list(channel.id, 1, through_message_id: "missing")
  end

  test "message writes authorize and fetch once instead of re-resolving the channel" do
    {vault, channel} = chat_vault(1, "Fast messages", "Room")
    user = %{id: 1, username: "alice"}

    {create_result, create_queries} =
      capture_queries(fn ->
        Messages.create(user, vault.id, channel.id, %{id: "fast-message", body: "one"})
      end)

    assert {:ok, %{id: "fast-message"}} = create_result
    assert Enum.count(create_queries, &route_resolution_query?/1) == 1
    assert Enum.count(create_queries, &message_fetch_query?/1) == 1

    {update_result, update_queries} =
      capture_queries(fn ->
        Messages.update(user, vault.id, channel.id, "fast-message", %{body: "two"})
      end)

    assert {:ok, %{body: "two"}} = update_result
    assert Enum.count(update_queries, &route_resolution_query?/1) == 1
    assert Enum.count(update_queries, &message_fetch_query?/1) == 1
  end

  test "typed ancestry is bounded and natural links point to a specific prior message" do
    input = %{body: "@sol can you review this approach?"}

    prior = [
      %{
        id: "m1",
        author: "alice",
        body: "This is a sufficiently substantive prior proposal for review.",
        createdAt: "2026-01-01",
        status: nil
      }
    ]

    registrations = [%{id: "r1", agentId: "codex", mention: "sol", displayName: "Sol"}]
    linked = RoomContext.infer_natural_link(input, prior, registrations)
    assert linked.replyTo.messageId == "m1"
    assert linked.replyTo.relationship == "review_request"
  end

  test "chat route catalog is complete and has no duplicates" do
    catalog = CascadeWeb.ChatRoutes.catalog()
    assert length(catalog) == 29
    assert length(Enum.uniq(catalog)) == 29
    assert {"DELETE", "/api/vaults/:vault_id/vault-agents/:agent_id/profile"} in catalog

    assert {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/collaborate"} in catalog
  end

  test "isolated router authenticates and serves projected message history" do
    {vault, channel} = chat_vault(1, "HTTP", "Room")
    user = %{id: 1, username: "alice"}

    assert {:ok, _} =
             Messages.create(user, vault.id, channel.id, %{id: "http-message", body: "hello"})

    token = Cascade.Auth.Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    response =
      conn(:get, "/api/vaults/#{vault.id}/channels/#{channel.id}/messages")
      |> put_req_header("authorization", "Bearer " <> token)
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))

    assert response.status == 200

    assert %{"messages" => [%{"id" => "http-message", "author" => "alice"}]} =
             Jason.decode!(response.resp_body)
  end

  test "agent run uploads only its own avatar without note asset privileges" do
    {vault, channel} = chat_vault(1, "Self avatar", "Room")
    {:ok, identity} = Agents.upsert_identity(1, vault.id, %{agentId: "codex", mention: "astra"})
    {:ok, member} = Agents.add_to_channel(1, vault.id, channel.id, identity.id)
    {:ok, other} = Agents.upsert_identity(1, vault.id, %{agentId: "codex", mention: "other"})
    {:ok, other_member} = Agents.add_to_channel(1, vault.id, channel.id, other.id)

    {:ok, message} =
      Messages.create(%{id: 1, username: "alice"}, vault.id, channel.id, %{
        body: "Choose an avatar"
      })

    {:ok, dispatch} = Dispatches.create(1, channel.id, message, member.id)

    {:ok, run} =
      RunStore.start(vault.id, nil, "Choose an avatar", "codex",
        owner_user_id: 1,
        chat_dispatch_id: dispatch.id
      )

    token = Token.sign_agent(%{id: 1, username: "alice", auth_version: 0})
    bytes = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>
    image = "data:image/png;base64," <> Base.encode64(bytes)

    request = fn registration, avatar, run_id ->
      conn(
        :put,
        "/api/vaults/#{vault.id}/channels/#{channel.id}/agents/#{registration}/avatar",
        Jason.encode!(%{avatarUrl: avatar})
      )
      |> put_req_header("authorization", "Bearer " <> token)
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-cascade-run-id", to_string(run_id))
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))
    end

    response = request.(member.id, image, run.id)
    assert response.status == 200
    url = Jason.decode!(response.resp_body)["registration"]["avatarUrl"]
    served = conn(:get, url) |> CascadeWeb.ContentRouter.call(CascadeWeb.ContentRouter.init([]))
    assert served.status == 200
    assert served.resp_body == bytes
    assert request.(other_member.id, image, run.id).status == 403
    assert request.(member.id, image, "").status == 403

    for invalid <- [
          "data:image/png;base64,aGVsbG8=",
          "data:image/svg+xml;base64,aGVsbG8=",
          "data:image/png;base64,???",
          "data:image/png;base64," <> String.duplicate("A", 2_796_208)
        ] do
      assert request.(member.id, invalid, run.id).status == 400
    end

    assert SQL.one("SELECT avatar_url FROM vault_agents WHERE id=?", [other.id]) == [""]

    upload =
      conn(
        :post,
        "/api/notes/#{channel.id}/assets",
        Jason.encode!(%{media_type: "image/png", data: Base.encode64(bytes)})
      )
      |> put_req_header("authorization", "Bearer " <> token)
      |> put_req_header("content-type", "application/json")
      |> CascadeWeb.ContentRouter.call(CascadeWeb.ContentRouter.init([]))

    assert upload.status == 403
    assert request.(member.id, "", run.id).status == 200
  end

  test "agent avatars copy private note assets into a durable public image" do
    {vault, channel} = chat_vault(1, "Avatar", "Room")
    note = Store.create_note(vault.id, 1, %{title: "Source", content: "avatar"})

    asset =
      Assets.upload(note.id, 1, %{
        media_type: "image/png",
        data: Base.encode64(<<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>)
      })

    assert {:ok, identity} =
             Agents.upsert_identity(1, vault.id, %{
               agentId: "codex",
               displayName: "Sol",
               mention: "sol"
             })

    assert {:ok, member} = Agents.add_to_channel(1, vault.id, channel.id, identity.id)

    assert {:ok, updated} =
             Agents.set_avatar(
               1,
               vault.id,
               channel.id,
               member.id,
               "https://example.test#{asset.url}"
             )

    assert updated.avatarUrl =~ "/api/notes/agent-avatars/assets/#{identity.id}-"
    File.rm_rf!(Assets.assets_dir(note.id))

    response =
      conn(:get, updated.avatarUrl)
      |> CascadeWeb.ContentRouter.call(CascadeWeb.ContentRouter.init([]))

    assert response.status == 200
    assert get_resp_header(response, "content-type") == ["image/png"]
    assert response.resp_body == <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>

    assert {:ok, cleared} = Agents.set_avatar(1, vault.id, channel.id, member.id, "")
    assert cleared.avatarUrl == ""

    revoked =
      conn(:get, updated.avatarUrl)
      |> CascadeWeb.ContentRouter.call(CascadeWeb.ContentRouter.init([]))

    assert revoked.status == 404

    assert {:error, "Profile picture must be an uploaded note image"} =
             Agents.set_avatar(
               1,
               vault.id,
               channel.id,
               member.id,
               "https://tracker.example/avatar.png"
             )
  end

  test "concurrent message commits publish created events in rowid order" do
    {vault, channel} = chat_vault(1, "Ordered", "Room")
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    test_pid = self()

    events = fn
      %{event: "vault:chatMessageCreated", message: %{id: "ordered-first"} = message} ->
        send(test_pid, {:first_emit_blocked, self(), message.seq})

        receive do
          :release_first_emit -> :ok
        after
          2_000 -> raise "first ordered event was not released"
        end

        send(test_pid, {:ordered_event, message.id, message.seq})

      %{event: "vault:chatMessageCreated", message: message} ->
        send(test_pid, {:ordered_event, message.id, message.seq})

      _intent ->
        :ok
    end

    path = "/api/vaults/#{vault.id}/channels/#{channel.id}/messages"

    first =
      Task.async(fn ->
        chat_request(:post, path, token, %{id: "ordered-first", body: "first"}, events: events)
      end)

    assert_receive {:first_emit_blocked, first_emitter, first_seq}, 2_000

    second =
      Task.async(fn ->
        chat_request(:post, path, token, %{id: "ordered-second", body: "second"}, events: events)
      end)

    refute_receive {:ordered_event, "ordered-second", _seq}, 200
    assert SQL.one("SELECT id FROM chat_messages WHERE id='ordered-second'") == nil

    send(first_emitter, :release_first_emit)
    assert_receive {:ordered_event, "ordered-first", ^first_seq}, 2_000
    assert_receive {:ordered_event, "ordered-second", second_seq}, 2_000
    assert first_seq < second_seq
    assert Task.await(first, 2_000).status == 201
    assert Task.await(second, 2_000).status == 201
  end

  test "message update and delete mutations publish in execution order" do
    {vault, channel} = chat_vault(1, "Ordered updates", "Room")
    user = %{id: 1, username: "alice"}
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    test_pid = self()

    assert {:ok, _message} =
             Messages.create(user, vault.id, channel.id, %{
               id: "ordered-mutation",
               body: "before"
             })

    events = fn
      %{event: "vault:chatMessageUpdated", message: %{id: "ordered-mutation"}} ->
        send(test_pid, {:update_emit_blocked, self()})

        receive do
          :release_update -> :ok
        after
          2_000 -> raise "update event was not released"
        end

        send(test_pid, {:ordered_mutation_event, :updated})

      %{event: "vault:chatMessageDeleted", messageId: "ordered-mutation"} ->
        send(test_pid, {:ordered_mutation_event, :deleted})

      _intent ->
        :ok
    end

    path = "/api/vaults/#{vault.id}/channels/#{channel.id}/messages/ordered-mutation"

    update =
      Task.async(fn ->
        chat_request(:patch, path, token, %{body: "after"}, events: events)
      end)

    assert_receive {:update_emit_blocked, publisher}, 2_000

    delete = Task.async(fn -> chat_request(:delete, path, token, %{}, events: events) end)

    refute_receive {:ordered_mutation_event, :deleted}, 200
    assert SQL.one("SELECT body FROM chat_messages WHERE id='ordered-mutation'") == ["after"]

    send(publisher, :release_update)
    assert_receive {:ordered_mutation_event, :updated}, 2_000
    assert_receive {:ordered_mutation_event, :deleted}, 2_000
    assert Task.await(update, 2_000).status == 200
    assert Task.await(delete, 2_000).status == 200
    assert SQL.one("SELECT id FROM chat_messages WHERE id='ordered-mutation'") == nil
  end

  test "restricted agent posts retain explicit unregistered attribution and can be forwarded safely" do
    {source_vault, source_channel} = chat_vault(1, "Source", "Agent source")
    {target_vault, target_channel} = chat_vault(1, "Target", "Forward target")
    agent_token = Token.sign_agent(%{id: 1, username: "alice", auth_version: 0})
    user_token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    posted =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages",
        agent_token,
        %{
          id: "restricted-source",
          channelId: source_channel.id,
          author: "Claude",
          body: "the renderer stalled for ~1s",
          createdAt: "2026-08-10T16:00:00.000Z",
          agentId: "claude",
          attachments: [
            %{
              name: "diagram.png",
              media_type: "image/png",
              url: "https://example.test/diagram.png"
            }
          ]
        }
      )

    assert posted.status == 201
    source = Jason.decode!(posted.resp_body)["message"]
    assert source["author"] == "Claude"
    assert source["agentId"] == "claude"
    assert is_nil(source["registrationId"])

    forwarded =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/restricted-source/forward",
        user_token,
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert forwarded.status == 201
    message = Jason.decode!(forwarded.resp_body)["message"]
    assert message["author"] == "alice"
    assert message["forwardedFrom"]["author"] == "Claude"

    assert [%{"name" => "diagram.png", "url" => "https://example.test/diagram.png"}] =
             message["attachments"]

    missing =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/unknown/forward",
        user_token,
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert missing.status == 400
    assert Jason.decode!(missing.resp_body) == %{"error" => "Message not found"}

    outsider =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages/restricted-source/forward",
        Token.sign_user(%{id: 3, username: "carol", auth_version: 0}),
        %{targetVaultId: target_vault.id, targetChannelId: target_channel.id}
      )

    assert outsider.status == 400
    assert Jason.decode!(outsider.resp_body) == %{"error" => "Chat channel not found"}
    assert {:ok, target_messages} = Messages.list(target_channel.id, 1)
    assert Enum.map(target_messages, & &1.forwardedFrom["messageId"]) == ["restricted-source"]
  end

  test "ordinary owner and linked-guest turns persist only their own coordinator dispatch" do
    {source_vault, source_channel} = chat_vault(1, "Source", "Shared room")
    {guest_vault, guest_channel} = chat_vault(2, "Guest", "Guest mirror")

    assert {:ok, _} =
             Channel.link(
               source_vault.id,
               source_channel.id,
               guest_vault.id,
               guest_channel.id,
               1
             )

    {:ok, sol_identity} =
      Agents.upsert_identity(1, source_vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol",
        model: "gpt-5.6-sol"
      })

    {:ok, sol} =
      Agents.add_to_channel(1, source_vault.id, source_channel.id, sol_identity.id, %{
        orchestrator: true,
        pingableByOthers: true
      })

    {:ok, guest_identity} =
      Agents.upsert_identity(2, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Sol",
        mention: "guest_sol",
        model: "gpt-5.6-sol"
      })

    {:ok, guest_coordinator} =
      Agents.add_to_channel(2, guest_vault.id, guest_channel.id, guest_identity.id, %{
        orchestrator: true
      })

    owner_post =
      chat_request(
        :post,
        "/api/vaults/#{source_vault.id}/channels/#{source_channel.id}/messages",
        Token.sign_user(%{id: 1, username: "alice", auth_version: 0}),
        %{
          id: "owner-root",
          channelId: source_channel.id,
          author: "spoofed",
          body: "Investigate and verify multiplayer orchestration.",
          createdAt: "2026-08-10T16:01:00.000Z"
        }
      )

    assert owner_post.status == 201
    assert [owner_dispatch] = Jason.decode!(owner_post.resp_body)["dispatches"]
    assert owner_dispatch["registration"]["id"] == sol.id

    guest_post =
      chat_request(
        :post,
        "/api/vaults/#{guest_vault.id}/channels/#{guest_channel.id}/messages",
        Token.sign_user(%{id: 2, username: "bob", auth_version: 0}),
        %{
          id: "guest-root",
          channelId: guest_channel.id,
          author: "spoofed",
          body: "Coordinate this shared-channel request.",
          createdAt: "2026-08-10T16:02:00.000Z"
        }
      )

    assert guest_post.status == 201
    assert [guest_dispatch] = Jason.decode!(guest_post.resp_body)["dispatches"]
    assert guest_dispatch["registration"]["id"] == guest_coordinator.id

    assert {:ok, owner_pending} = Dispatches.list_pending(1, source_channel.id)
    assert Enum.map(owner_pending, & &1.registration.id) == [sol.id]
    refute Enum.any?(owner_pending, &(&1.registration.id == guest_coordinator.id))

    assert {:ok, guest_pending} = Dispatches.list_pending(2, guest_channel.id)
    assert Enum.any?(guest_pending, &(&1.registration.id == guest_coordinator.id))

    assert SQL.all(
             "SELECT message_id,registration_id FROM chat_agent_dispatches WHERE message_id IN ('owner-root','guest-root') ORDER BY message_id",
             []
           ) == [["guest-root", guest_coordinator.id], ["owner-root", sol.id]]
  end

  test "reply metadata wakes an agent when its optimistic source shell is missing" do
    {vault, channel} = chat_vault(1, "Reply fallback", "Reply fallback room")
    user = %{id: 1, username: "alice"}

    {:ok, identity} =
      Agents.upsert_identity(user.id, vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol"
      })

    {:ok, registration} =
      Agents.add_to_channel(user.id, vault.id, channel.id, identity.id, %{})

    {:ok, reply} =
      Messages.create(user, vault.id, channel.id, %{
        id: "reply-to-missing-agent-shell",
        body: "Please handle this follow-up.",
        createdAt: "2026-08-14T17:00:00.000Z",
        replyTo: %{
          messageId: "missing-optimistic-agent-shell",
          author: "Sol",
          mention: "sol",
          preview: "Thinking..."
        }
      })

    assert {:ok, [dispatch]} = Dispatches.create_for_message(user.id, channel.id, reply)
    assert dispatch.registration.id == registration.id

    {:ok, _human} =
      Messages.create(user, vault.id, channel.id, %{
        id: "persisted-human-source",
        body: "Human source",
        createdAt: "2026-08-14T17:01:00.000Z"
      })

    {:ok, human_reply} =
      Messages.create(user, vault.id, channel.id, %{
        id: "reply-to-persisted-human",
        body: "This must not infer an agent target.",
        createdAt: "2026-08-14T17:02:00.000Z",
        replyTo: %{
          messageId: "persisted-human-source",
          author: "Sol",
          mention: "sol",
          preview: "Human source"
        }
      })

    assert {:ok, []} = Dispatches.create_for_message(user.id, channel.id, human_reply)
  end

  test "ambient five-agent launch persists identities and serializes an idempotent peer exchange" do
    {vault, channel} = chat_vault(1, "Ambient", "Ambient room")
    user = %{id: 1, username: "alice"}

    registrations =
      for {name, mention} <- [
            {"Skeptic", "skeptic"},
            {"Builder", "builder"},
            {"Herald", "herald"},
            {"Warden", "warden"},
            {"Broker", "broker"}
          ] do
        {:ok, identity} =
          Agents.upsert_identity(1, vault.id, %{
            agentId: "codex",
            displayName: name,
            mention: mention
          })

        {:ok, registration} =
          Agents.add_to_channel(1, vault.id, channel.id, identity.id, %{
            ambientGroupChat: true,
            finalReplyOnly: true,
            taggableByAgents: true,
            contextPrompt: "Converse naturally as #{name}."
          })

        assert registration.ambientGroupChat
        assert registration.finalReplyOnly
        registration
      end

    assert Enum.uniq_by(registrations, & &1.vaultAgentId) == registrations
    assert registrations |> Enum.map(& &1.conversationId) |> Enum.uniq() |> length() == 5

    {:ok, root} =
      Messages.create(user, vault.id, channel.id, %{
        id: "ambient-root",
        body: "Begin the experiment."
      })

    replies = [
      "I think the evidence matters.",
      "That evidence needs a falsifier.",
      "Agreed; what observation would disprove it?",
      "A restart losing the transcript would disprove persistence.",
      "Then preserve the transcript and test the restart boundary."
    ]

    final_message =
      Enum.zip(registrations, replies)
      |> Enum.with_index(1)
      |> Enum.reduce(root, fn {{registration, body}, index}, triggering_message ->
        assert {:ok, [dispatch]} =
                 Dispatches.create_for_message(user.id, channel.id, triggering_message)

        assert dispatch.registration.id == registration.id

        assert {:ok, [duplicate]} =
                 Dispatches.create_for_message(user.id, channel.id, triggering_message)

        assert duplicate.id == dispatch.id

        assert {:ok, run} =
                 RunStore.start(vault.id, nil, "ambient turn #{index}", "codex",
                   owner_user_id: user.id,
                   chat_dispatch_id: dispatch.id
                 )

        {:ok, reply} =
          Messages.create(
            user,
            vault.id,
            channel.id,
            %{
              id: "ambient-reply-#{index}",
              body: body,
              registrationId: registration.id,
              runId: run.id
            },
            access: :agent
          )

        reply
      end)

    assert final_message.body == List.last(replies)
    assert {:ok, transcript} = Messages.list(channel.id, user.id, limit: 30)
    transcript = Enum.reject(transcript, &String.starts_with?(&1.id, "agent-dispatch-"))
    assert Enum.map(transcript, & &1.body) == ["Begin the experiment." | replies]
  end

  test "exhausted Claude and Codex skip reply-to-all without blocking explicit mentions" do
    {vault, channel} = chat_vault(1, "Usage gate", "Usage gated room")
    user = %{id: 1, username: "alice"}

    add_reply_to_all = fn agent_id, display_name, mention ->
      {:ok, identity} =
        Agents.upsert_identity(1, vault.id, %{
          agentId: agent_id,
          displayName: display_name,
          mention: mention
        })

      {:ok, registration} =
        Agents.add_to_channel(1, vault.id, channel.id, identity.id, %{
          replyToEveryMessage: true
        })

      registration
    end

    claude = add_reply_to_all.("claude-code", "Claude", "claude")
    codex = add_reply_to_all.("codex", "Codex", "codex")

    RunnerLifecycle.report_plan_usage(1, %{
      "claude-code" => %{
        status: "ok",
        usedPercent: 100,
        extraUsageAvailable: false
      },
      "codex" => %{
        status: "ok",
        usedPercent: 100,
        extraUsageAvailable: false
      }
    })

    {:ok, ordinary} =
      Messages.create(user, vault.id, channel.id, %{
        id: "usage-gated-ordinary",
        body: "This should not wake exhausted reply-to-all agents.",
        createdAt: "2026-08-14T18:00:00.000Z"
      })

    assert {:ok, []} = Dispatches.create_for_message(user.id, channel.id, ordinary)

    {:ok, explicit} =
      Messages.create(user, vault.id, channel.id, %{
        id: "usage-gated-explicit",
        body: "@claude @codex answer explicitly",
        createdAt: "2026-08-14T18:01:00.000Z"
      })

    assert {:ok, dispatches} = Dispatches.create_for_message(user.id, channel.id, explicit)

    assert dispatches |> Enum.map(& &1.registration.id) |> Enum.sort() ==
             Enum.sort([claude.id, codex.id])

    RunnerLifecycle.report_plan_usage(1, %{
      "claude-code" => %{status: "ok", usedPercent: 0, extraUsageAvailable: true},
      "codex" => %{status: "ok", usedPercent: 0, extraUsageAvailable: true}
    })

    _ = RunnerLifecycle.plan_usage(1)
  end

  test "/compact targets the last Claude or the explicitly tagged Claude sessions" do
    {vault, channel} = chat_vault(1, "Compact", "Compact room")
    user = %{id: 1, username: "alice"}

    add_agent = fn agent_id, display_name, mention ->
      {:ok, identity} =
        Agents.upsert_identity(1, vault.id, %{
          agentId: agent_id,
          displayName: display_name,
          mention: mention
        })

      {:ok, registration} =
        Agents.add_to_channel(1, vault.id, channel.id, identity.id, %{pingableByOthers: true})

      registration
    end

    claude_one = add_agent.("claude-code", "Claude One", "claude-one")
    claude_two = add_agent.("claude-code", "Claude Two", "claude-two")
    codex = add_agent.("codex", "Codex", "codex")

    {:ok, _} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "claude-last",
          body: "Finished the prior turn.",
          createdAt: "2026-08-14T18:00:00.000Z",
          registrationId: claude_one.id
        },
        access: :agent
      )

    {:ok, bare} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-bare",
        body: "/compact",
        createdAt: "2026-08-14T18:01:00.000Z"
      })

    assert {:ok, [bare_dispatch]} = Dispatches.create_for_message(user.id, channel.id, bare)
    assert bare_dispatch.registration.id == claude_one.id

    {:ok, _} =
      Messages.create(
        user,
        vault.id,
        channel.id,
        %{
          id: "codex-last",
          body: "I am the newest agent now.",
          createdAt: "2026-08-14T18:02:00.000Z",
          registrationId: codex.id
        },
        access: :agent
      )

    {:ok, wrong_provider} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-after-codex",
        body: "/compact",
        createdAt: "2026-08-14T18:03:00.000Z"
      })

    assert {:ok, []} = Dispatches.create_for_message(user.id, channel.id, wrong_provider)

    {:ok, explicit} =
      Messages.create(user, vault.id, channel.id, %{
        id: "compact-explicit",
        body: "/compact @claude-one @claude-two @codex",
        createdAt: "2026-08-14T18:04:00.000Z"
      })

    assert {:ok, explicit_dispatches} =
             Dispatches.create_for_message(user.id, channel.id, explicit)

    assert explicit_dispatches |> Enum.map(& &1.registration.id) |> Enum.sort() ==
             Enum.sort([claude_one.id, claude_two.id])
  end

  defp chat_request(method, path, token, body, options \\ []) do
    request =
      conn(method, path, Jason.encode!(body))
      |> put_req_header("authorization", "Bearer " <> token)
      |> put_req_header("content-type", "application/json")

    request = if options == [], do: request, else: assign(request, :domain_options, options)
    CascadeWeb.ChatRouter.call(request, CascadeWeb.ChatRouter.init([]))
  end

  defp capture_queries(operation) do
    parent = self()
    ref = make_ref()
    handler_id = "chat-query-count-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, _config ->
          send(parent, {ref, IO.iodata_to_binary(metadata.query)})
        end,
        nil
      )

    try do
      result = operation.()
      :telemetry.detach(handler_id)
      {result, collect_queries(ref, [])}
    after
      :telemetry.detach(handler_id)
    end
  end

  defp collect_queries(ref, queries) do
    receive do
      {^ref, query} -> collect_queries(ref, [query | queries])
    after
      0 -> Enum.reverse(queries)
    end
  end

  defp route_resolution_query?(query),
    do: String.contains?(query, "SELECT local.id,local.vault_id")

  defp message_fetch_query?(query),
    do: String.contains?(query, "FROM chat_messages WHERE id=? AND channel_id=?")

  defp chat_vault(user_id, name, title) do
    vault = Store.create_vault(user_id, %{name: name})

    channel =
      Store.create_note(vault.id, user_id, %{title: title, content: "cascade://chat-channel"})

    {vault, channel}
  end

  defp reset_database do
    for table <-
          ~w(chat_note_grants chat_channel_settings vault_agent_exclusions chat_agent_members chat_channel_links chat_messages work_item_dependencies work_item_runs work_item_reviews work_items vault_agents note_versions note_links note_tags tags notes folders vault_members vaults registration_invites_used users) do
      if SQL.table_exists?(table), do: SQL.exec("DELETE FROM #{table}")
    end

    File.rm_rf!(Store.vaults_base_dir())
  end

  defp assert_node_columns(table) do
    actual =
      SQL.all("PRAGMA table_info(#{table})")
      |> Enum.map(fn [_cid | definition] -> definition end)

    assert actual == Map.fetch!(@node_column_signatures, table)

    foreign_keys =
      SQL.all("PRAGMA foreign_key_list(#{table})")
      |> Enum.map(fn [_id, _seq, target, source, destination, on_update, on_delete, match] ->
        [source, target, destination, on_update, on_delete, match]
      end)
      |> Enum.sort()

    assert foreign_keys == Enum.sort(Map.fetch!(@node_foreign_key_signatures, table))
  end
end
