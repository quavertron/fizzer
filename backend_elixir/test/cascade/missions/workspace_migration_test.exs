defmodule Cascade.Missions.WorkspaceMigrationTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Missions.Schema

  test "fences historical worker and coordinator work and backfills one durable brief" do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 700_000
    vault_id = "migration-vault-#{suffix}"
    channel_id = "migration-channel-#{suffix}"
    root_id = "migration-root-#{suffix}"
    mission_id = "migration-mission-#{suffix}"
    worker_message_id = "migration-worker-message-#{suffix}"
    coordinator_message_id = "sys-mission-#{mission_id}-1"
    worker_dispatch_id = "migration-worker-dispatch-#{suffix}"
    coordinator_dispatch_id = "migration-coordinator-dispatch-#{suffix}"
    username = "migration_owner_#{suffix}"
    root_path = Path.join(System.tmp_dir!(), "cascade-migration-#{suffix}")
    assert_raise RuntimeError, ~r/rollback migration fixture/, fn ->
      SQL.transaction(fn ->

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,?,0)",
      [user_id, username, "x", username, ""]
    )

    SQL.exec(
      "INSERT INTO vaults(id,name,root_path,created_by) VALUES(?,?,?,?)",
      [vault_id, "Migration vault", root_path, user_id]
    )

    SQL.exec(
      "INSERT INTO notes(id,vault_id,title,content,content_preview,created_by) VALUES(?,?,?,?,?,?)",
      [channel_id, vault_id, "Migration room", "cascade://chat-channel", "cascade://chat-channel", user_id]
    )

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body,actor_user_id) VALUES(?,?,?,?,?,?)",
      [root_id, channel_id, vault_id, username, "Root mission content", user_id]
    )

    SQL.exec(
      """
      INSERT INTO chat_missions
        (id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,status,phase,created_by)
      VALUES(?,?,?,?,?,?,?,'active','planning',?)
      """,
      [mission_id, vault_id, channel_id, root_id, "coordinator-#{suffix}", "Legacy mission", "Preserve this objective", user_id]
    )

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body,registration_id,actor_user_id) VALUES(?,?,?,?,?,?,?)",
      [worker_message_id, channel_id, vault_id, username, "Worker request", "coordinator-#{suffix}", user_id]
    )

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body,registration_id,actor_user_id) VALUES(?,?,?,?,?,?,?)",
      [coordinator_message_id, channel_id, vault_id, username, "Planning assessment", "coordinator-#{suffix}", user_id]
    )

    SQL.exec(
      """
      INSERT INTO chat_agent_dispatches
        (id,message_id,channel_id,registration_id,run_id,requester_user_id,requester_channel_id,conversation_id)
      VALUES(?,?,?,?,NULL,?,?,?)
      """,
      [worker_dispatch_id, worker_message_id, channel_id, "worker-#{suffix}", user_id, channel_id, "worker-conversation-#{suffix}"]
    )

    SQL.exec(
      """
      INSERT INTO chat_agent_dispatches
        (id,message_id,channel_id,registration_id,run_id,requester_user_id,requester_channel_id,conversation_id)
      VALUES(?,?,?,?,NULL,?,?,?)
      """,
      [coordinator_dispatch_id, coordinator_message_id, channel_id, "coordinator-#{suffix}", user_id, channel_id, "coordinator-conversation-#{suffix}"]
    )

    SQL.exec(
      """
      INSERT INTO chat_mission_tasks
        (id,mission_id,title,assignee_registration_id,status,summary,dispatch_id)
      VALUES(?,?,?,?,?,?,?)
      """,
      ["migration-task-#{suffix}", mission_id, "Legacy worker", "worker-#{suffix}", "pending", "", worker_dispatch_id]
    )

    SQL.exec(
      "INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status,chat_dispatch_id) VALUES(?,?,?,?,?,?)",
      [vault_id, user_id, "Legacy worker run", "worker-run-#{suffix}", "queued", worker_dispatch_id]
    )
    worker_run_id = SQL.last_insert_id()
    SQL.exec("UPDATE chat_agent_dispatches SET run_id=? WHERE id=?", [worker_run_id, worker_dispatch_id])
    SQL.exec("UPDATE chat_mission_tasks SET run_id=? WHERE id=?", [worker_run_id, "migration-task-#{suffix}"])

    SQL.exec(
      "INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status,chat_dispatch_id) VALUES(?,?,?,?,?,?)",
      [vault_id, user_id, "Legacy coordinator run", "coordinator-run-#{suffix}", "running", coordinator_dispatch_id]
    )
    coordinator_run_id = SQL.last_insert_id()
    SQL.exec("UPDATE chat_agent_dispatches SET run_id=? WHERE id=?", [coordinator_run_id, coordinator_dispatch_id])

    SQL.exec(
      """
      INSERT INTO chat_mission_interpretations
        (mission_id,pending_fingerprint,pending_context_json,dispatch_id,attempt,publication_pending)
      VALUES(?,?,?,?,?,?)
      """,
      [mission_id, "stale-fingerprint", ~s({"assessment":"stale"}), coordinator_dispatch_id, 2, "stale-publication"]
    )

    # The application has already recorded the migration at boot. Removing only
    # this marker makes the test exercise the restart-safe migration path.
    SQL.exec("DELETE FROM chat_mission_migrations WHERE name=?", ["mission-workspace-fence-v2"])

    assert :ok = Schema.ensure!()

    assert ["canceled"] == SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", ["migration-task-#{suffix}"])
    assert is_binary(SQL.one("SELECT failed_at FROM chat_agent_dispatches WHERE id=?", [worker_dispatch_id]) |> hd())
    assert is_binary(SQL.one("SELECT failed_at FROM chat_agent_dispatches WHERE id=?", [coordinator_dispatch_id]) |> hd())


    assert ["", "{}", nil, nil] ==
             SQL.one(
               "SELECT pending_fingerprint,pending_context_json,dispatch_id,publication_pending FROM chat_mission_interpretations WHERE mission_id=?",
               [mission_id]
             )

    assert ["Preserve this objective"] ==
             SQL.one("SELECT n.content FROM chat_mission_notes mn JOIN notes n ON n.id=mn.note_id WHERE mn.mission_id=? AND mn.kind='mission'", [mission_id])

    assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_cancellation_replays WHERE run_id=?", [worker_run_id])
    assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_cancellation_replays WHERE run_id=?", [coordinator_run_id])

    relation_count = SQL.one("SELECT COUNT(*) FROM chat_mission_notes WHERE mission_id=? AND kind='mission'", [mission_id])
    note_count = SQL.one("SELECT COUNT(*) FROM notes WHERE id=?", ["mission-brief-#{mission_id}"])
    event_count = SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=?", [mission_id])

    assert :ok = Schema.ensure!()
    assert relation_count == SQL.one("SELECT COUNT(*) FROM chat_mission_notes WHERE mission_id=? AND kind='mission'", [mission_id])
    assert note_count == SQL.one("SELECT COUNT(*) FROM notes WHERE id=?", ["mission-brief-#{mission_id}"])
    assert event_count == SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=?", [mission_id])
    raise "rollback migration fixture"
      end)
    end
  end
end
