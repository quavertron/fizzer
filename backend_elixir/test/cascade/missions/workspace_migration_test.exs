defmodule Cascade.Missions.WorkspaceMigrationTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Missions.Schema

  test "domain bootstrap retains cancellations before realtime exists" do
    database = Path.join(System.tmp_dir!(), "cascade-bootstrap-#{System.unique_integer([:positive])}.sqlite3")
    on_exit(fn -> Enum.each([database, database <> "-wal", database <> "-shm"], &File.rm/1) end)
    config = Application.get_all_env(:cascade_elixir) |> :erlang.term_to_binary() |> Base.encode64()
    script = ~S"""
    [encoded, database] = System.argv()
    Application.load(:cascade_elixir)
    for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(), do: Application.put_env(:cascade_elixir, key, value)
    repo = Application.fetch_env!(:cascade_elixir, Cascade.DB.Repo) |> Keyword.put(:database, database)
    Application.put_env(:cascade_elixir, Cascade.DB.Repo, repo)
    for app <- Application.spec(:cascade_elixir, :applications), do: Application.ensure_all_started(app)
    Logger.configure(level: :warning)
    {:ok, _} = Cascade.DB.Repo.start_link()
    {:ok, _} = Cascade.DB.WriteCoordinator.start_link([])
    {:ok, _} = Cascade.DB.Bootstrap.start_link([])
    {:ok, _} = Cascade.DomainBootstrap.start_link([])
    alias Cascade.Accounts.SQL
    SQL.exec("INSERT INTO users(id,username,password_hash,display_name,avatar_url) VALUES(1,'startup','x','Startup','')")
    SQL.exec("INSERT INTO vaults(id,name,root_path,created_by) VALUES('v','Startup','/tmp/startup',1)")
    SQL.exec("INSERT INTO notes(id,vault_id,title,content,created_by) VALUES('c','v','Room','cascade://chat-channel',1)")
    SQL.exec("INSERT INTO chat_messages(id,channel_id,vault_id,author,body,actor_user_id) VALUES('root','c','v','startup','Legacy mission',1)")
    SQL.exec("INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,status,created_by) VALUES('m','v','c','root','coord','Legacy mission','active',1)")
    SQL.exec("INSERT INTO runs(id,vault_id,owner_user_id,prompt,conversation_id,status) VALUES(1,'v',1,'Legacy work','legacy','running')")
    SQL.exec("INSERT INTO chat_mission_cancellation_replays(run_id,mission_id,owner_user_id) VALUES(1,'m',1)")
    nil = Process.whereis(Cascade.Realtime.Hub)
    :ok = Cascade.Missions.Schema.ensure!()
    [["m", 1]] = Cascade.Missions.Scheduler.maintenance_missions()
    ["running"] = SQL.one("SELECT status FROM runs WHERE id=1")
    [1] = SQL.one("SELECT COUNT(*) FROM chat_mission_cancellation_replays WHERE run_id=1")
    IO.puts("bootstrap cancellation retained")
    """
    paths = :code.get_path() |> Enum.flat_map(&["-pa", to_string(&1)])
    {output, status} = System.cmd(System.find_executable("elixir"), paths ++ ["-e", script, "--", config, database], stderr_to_stdout: true)
    assert status == 0, output
    assert output =~ "bootstrap cancellation retained"
  end

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

    preserved = %{"commitments" => [%{"id" => "old-responsibility", "summary" => "Deliver original result", "status" => "open"}], "questions" => [%{"id" => "old-question", "question" => "Which target?", "status" => "open"}]}
    SQL.exec("UPDATE chat_mission_interpretations SET state_json=? WHERE mission_id=?", [Jason.encode!(preserved), mission_id])
    SQL.exec("UPDATE chat_missions SET phase='executing',approved_at='old-approval',approved_by=?,approved_revisions_json='{}' WHERE id=?", [user_id, mission_id])

    # Retain all authoritative links even when projections disagree: worker
    # message linkage, explicit interpretation linkage, and both run pointers.
    SQL.exec("UPDATE chat_messages SET mission_task_id=? WHERE id=?", ["migration-task-#{suffix}", worker_message_id])
    detached_worker_dispatch = "detached-worker-#{suffix}"
    SQL.exec("INSERT INTO chat_agent_dispatches(id,message_id,channel_id,registration_id) VALUES(?,?,?,?)", [detached_worker_dispatch, worker_message_id, channel_id, "detached-worker-#{suffix}"])
    SQL.exec("INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status,chat_dispatch_id) VALUES(?,?,?,?,?,?)", [vault_id, user_id, "Detached worker", "detached-worker-#{suffix}", "running", detached_worker_dispatch])
    detached_worker_run = SQL.last_insert_id()
    SQL.exec("UPDATE runs SET chat_dispatch_id=NULL WHERE id=?", [worker_run_id])
    SQL.exec("UPDATE chat_agent_dispatches SET registration_id=?,run_id=NULL WHERE id=?", ["stale-coordinator-#{suffix}", coordinator_dispatch_id])
    direct_coordinator_dispatch = "direct-coordinator-#{suffix}"
    SQL.exec("INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status) VALUES(?,?,?,?,'running')", [vault_id, user_id, "Direct coordinator", "direct-coordinator-#{suffix}"])
    direct_coordinator_run = SQL.last_insert_id()
    SQL.exec("INSERT INTO chat_agent_dispatches(id,message_id,channel_id,registration_id,run_id) VALUES(?,?,?,?,?)", [direct_coordinator_dispatch, root_id, channel_id, "coordinator-#{suffix}", direct_coordinator_run])

    # The application has already recorded the migration at boot. Removing only
    # this marker makes the test exercise the restart-safe migration path.
    SQL.exec("DELETE FROM chat_mission_migrations WHERE name=?", ["mission-workspace-fence-v2"])

    assert :ok = Schema.ensure!()

    assert ["planning", nil, nil, "{}"] == SQL.one("SELECT phase,approved_at,approved_by,approved_revisions_json FROM chat_missions WHERE id=?", [mission_id])
    assert Cascade.Missions.Interpretation.migration_decision_pending?(mission_id)
    [encoded] = SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [mission_id])
    migrated_state = Jason.decode!(encoded)
    assert migrated_state["commitments"] == preserved["commitments"]
    assert Enum.find(migrated_state["questions"], &(&1["id"] == "old-question")) == hd(preserved["questions"])
    assert Enum.count(migrated_state["questions"], &(&1["id"] == "migration-resumption")) == 1
    assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='historical_task_fenced'", [mission_id])

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

    for run_id <- [detached_worker_run, direct_coordinator_run] do
      assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_cancellation_replays WHERE run_id=?", [run_id])
    end
    for dispatch_id <- [detached_worker_dispatch, direct_coordinator_dispatch] do
      assert is_binary(SQL.one("SELECT failed_at FROM chat_agent_dispatches WHERE id=?", [dispatch_id]) |> hd())
    end

    relation_count = SQL.one("SELECT COUNT(*) FROM chat_mission_notes WHERE mission_id=? AND kind='mission'", [mission_id])
    note_count = SQL.one("SELECT COUNT(*) FROM notes WHERE id=?", ["mission-brief-#{mission_id}"])
    event_count = SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=?", [mission_id])

    assert :ok = Schema.ensure!()
    assert relation_count == SQL.one("SELECT COUNT(*) FROM chat_mission_notes WHERE mission_id=? AND kind='mission'", [mission_id])
    assert note_count == SQL.one("SELECT COUNT(*) FROM notes WHERE id=?", ["mission-brief-#{mission_id}"])
    assert event_count == SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=?", [mission_id])
    assert [encoded] == SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [mission_id])
    assert :ok = Cascade.Missions.Interpretation.resolve_migration_decision(mission_id, user_id)
    refute Cascade.Missions.Interpretation.migration_decision_pending?(mission_id)
    assert :ok = Schema.ensure!()
    refute Cascade.Missions.Interpretation.migration_decision_pending?(mission_id)
    assert ["canceled"] == SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", ["migration-task-#{suffix}"])
    # Simulate a branch installation that already applied the original v2,
    # retaining its immutable migration events but lacking the new questions.
    SQL.exec("DELETE FROM chat_mission_migrations WHERE name='mission-workspace-decisions-v1'")
    SQL.exec("UPDATE chat_mission_interpretations SET state_json=? WHERE mission_id=?", [Jason.encode!(preserved), mission_id])
    SQL.exec("UPDATE chat_missions SET approved_at='legacy-approval',approved_by=? WHERE id=?", [user_id, mission_id])
    SQL.exec("DELETE FROM chat_mission_events WHERE mission_id=? AND kind='historical_task_fenced'", [mission_id])
    for {id, root} <- [{"new-#{suffix}", worker_message_id}, {"resumed-#{suffix}", coordinator_message_id}] do
      SQL.exec("INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,status,phase,created_by,approved_at) VALUES(?,?,?,?,?,?,'active','planning',?,'fresh-approval')", [id, vault_id, channel_id, root, "coordinator-#{suffix}", "New work", user_id])
      SQL.exec("INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status) VALUES(?,?,?,?,'running')", ["task-#{id}", id, "New worker", "worker-#{suffix}"])
    end
    resumed_id = "resumed-#{suffix}"
    SQL.exec("INSERT INTO chat_mission_events(mission_id,kind,source_key) VALUES(?,'mission_brief_backfilled',?)", [resumed_id, "migration:mission:#{resumed_id}:brief"])
    SQL.exec("INSERT INTO chat_mission_events(mission_id,kind) VALUES(?,'mission_approved')", [resumed_id])
    assert :ok = Schema.ensure!()
    assert Cascade.Missions.Interpretation.migration_decision_pending?(mission_id)
    assert [nil, nil] == SQL.one("SELECT approved_at,approved_by FROM chat_missions WHERE id=?", [mission_id])
    assert [1] == SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='historical_task_fenced'", [mission_id])
    for id <- ["new-#{suffix}", resumed_id] do
      refute Cascade.Missions.Interpretation.migration_decision_pending?(id)
      assert ["fresh-approval"] == SQL.one("SELECT approved_at FROM chat_missions WHERE id=?", [id])
      assert ["running"] == SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", ["task-#{id}"])
    end
    [state_after_upgrade] = SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [mission_id])
    assert :ok = Schema.ensure!()
    assert [state_after_upgrade] == SQL.one("SELECT state_json FROM chat_mission_interpretations WHERE mission_id=?", [mission_id])
    raise "rollback migration fixture"
      end)
    end
  end
end
