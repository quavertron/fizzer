defmodule Cascade.Runs.OrchestrationStateTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Runs.{RunnerLifecycle, Store}
  alias CascadeWeb.DomainDispatch

  setup do
    Cascade.TestHelpers.owner_vault("orchestration")
  end

  test "run events remain append-only and strictly ordered under concurrent writers", context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "exercise ordering", "codex")
    assert [%{seq: 1, type: "status"}] = Store.events(run.id)

    1..20
    |> Task.async_stream(
      fn value -> Store.publish(run.id, "trace", %{value: value}) end,
      max_concurrency: 8,
      ordered: false,
      timeout: 5_000
    )
    |> Enum.each(fn result ->
      assert {:ok, %{run_id: run_id}} = result
      assert run_id == run.id
    end)

    events = Store.events(run.id)
    assert Enum.map(events, & &1.seq) == Enum.to_list(1..21)
    assert Enum.all?(tl(events), &(&1.type == "trace"))
  end

  test "terminal settlement is durable, idempotent, and clears a missing CLI session", context do
    assert {:ok, run} =
             Store.start(context.vault_id, nil, "resume", "claude-code", session_id: "stale")

    assert :ok =
             Store.finish(
               run.id,
               "failed",
               "No conversation found with session ID stale",
               "replacement"
             )

    assert %{status: "failed", session_id: nil} = Store.get(run.id)
    assert :already_terminal = Store.finish(run.id, "completed", "must not overwrite")
    assert %{status: "failed", summary: summary} = Store.get(run.id)
    assert summary =~ "No conversation found"
  end

  test "a steering continuation inherits and persists the provider session", context do
    conversation_id = "steering-#{System.unique_integer([:positive])}"

    assert {:ok, prior} =
             Store.start(context.vault_id, nil, "first turn", "codex",
               conversation_id: conversation_id
             )

    assert :ok = Store.persist_session(prior.id, "provider-session")
    assert Store.cancel(prior.id, steering: true)
    assert Store.get(prior.id).session_id == "provider-session"

    query = %{
      vault_id: context.vault_id,
      note_id: nil,
      agent: "codex",
      conversation_id: conversation_id
    }

    assert Store.find_conversation_session(query) == "provider-session"

    assert {:ok, continuation} =
             Store.start(context.vault_id, nil, "second turn", "codex",
               conversation_id: conversation_id,
               session_id: Store.find_conversation_session(query)
             )

    assert continuation.session_id == "provider-session"
  end

  test "runner replacement preserves reclaimed runs and fails only omitted runs", context do
    assert {:ok, kept} = Store.start(context.vault_id, nil, "keep", "codex")
    assert {:ok, omitted} = Store.start(context.vault_id, nil, "omit", "codex")
    :ok = Store.record_delegated(kept.id, context.user_id)
    :ok = Store.record_delegated(omitted.id, context.user_id)

    assert {:ok, [kept_id, omitted_id]} =
             RunnerLifecycle.register(context.user_id, "sid-old", %{
               activeRunIds: [kept.id, omitted.id],
               runnerInstanceId: "desktop-a"
             })

    assert {kept_id, omitted_id} == {kept.id, omitted.id}

    assert {:ok, [reclaimed]} =
             RunnerLifecycle.register(context.user_id, "sid-new", %{
               activeRunIds: [kept.id],
               runnerInstanceId: "desktop-b"
             })

    assert reclaimed == kept.id
    assert Store.get(kept.id).status == "queued"

    assert %{status: "failed", summary: summary} = Store.get(omitted.id)
    assert summary == "Desktop app restarted before this run completed."
  end

  test "runner reconnect storms preserve an active run",
       context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "survive reconnect storm", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)

    assert {:ok, [run_id]} =
             RunnerLifecycle.register(context.user_id, "storm-0", %{
               activeRunIds: [run.id],
               runnerInstanceId: "desktop-storm"
             })

    assert run_id == run.id

    final_sid =
      Enum.reduce(1..50, "storm-0", fn index, previous_sid ->
        RunnerLifecycle.disconnected(context.user_id, previous_sid, %{}, :transport_close)
        next_sid = "storm-#{index}"

        assert {:ok, [^run_id]} =
                 RunnerLifecycle.register(context.user_id, next_sid, %{
                   activeRunIds: [run.id],
                   runnerInstanceId: "desktop-storm"
                 })

        next_sid
      end)

    Process.sleep(80)
    assert Store.get(run.id).status == "queued"
    state = :sys.get_state(RunnerLifecycle)
    assert get_in(state, [:runners, context.user_id, :sid]) == final_sid
  end

  test "transport disconnect preserves a durable run for same-instance reclaim", context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "reclaim after disconnect", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)

    assert {:ok, [run_id]} =
             RunnerLifecycle.register(context.user_id, "gone", %{
               activeRunIds: [run.id],
               runnerInstanceId: "desktop-gone"
             })

    assert run_id == run.id
    RunnerLifecycle.disconnected(context.user_id, "gone", %{}, :transport_close)
    Process.sleep(80)

    assert Store.get(run.id).status == "queued"
    assert Store.delegated_owner(run.id) == context.user_id

    assert {:ok, [^run_id]} =
             RunnerLifecycle.register(context.user_id, "back", %{
               activeRunIds: [run.id],
               runnerInstanceId: "desktop-gone"
             })

    assert Store.get(run.id).status == "queued"
  end

  test "transport disconnect expires an unreclaimed run", context do
    previous_state = :sys.get_state(RunnerLifecycle)
    :sys.replace_state(RunnerLifecycle, &%{&1 | orphan_reclaim: 25})
    on_exit(fn -> :sys.replace_state(RunnerLifecycle, fn _state -> previous_state end) end)

    assert {:ok, run} = Store.start(context.vault_id, nil, "expire after disconnect", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)

    assert {:ok, [run_id]} =
             RunnerLifecycle.register(context.user_id, "expired-runner", %{
               activeRunIds: [run.id],
               runnerInstanceId: "desktop-expired"
             })

    assert run_id == run.id
    RunnerLifecycle.disconnected(context.user_id, "expired-runner", %{}, :transport_close)

    assert %{status: "failed", summary: summary} = eventually_status(run.id, "failed")
    assert summary == "Desktop agent runner disconnected and did not reclaim this run."
  end

  test "an enrolled run expires when its worker heartbeat stops", context do
    previous_state = :sys.get_state(RunnerLifecycle)
    :sys.replace_state(RunnerLifecycle, &%{&1 | run_lease: 25})
    on_exit(fn -> :sys.replace_state(RunnerLifecycle, fn _state -> previous_state end) end)

    assert {:ok, run} = Store.start(context.vault_id, nil, "expire heartbeat", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)
    RunnerLifecycle.heartbeat(run.id, context.user_id)
    Process.sleep(30)
    send(RunnerLifecycle, :lease_sweep)

    assert %{status: "failed", summary: summary} = eventually_status(run.id, "failed")
    assert summary == "Agent worker heartbeat expired before the run completed."
  end

  test "mass transport disconnects do not scan or settle delegated runs", context do
    previous_state = :sys.get_state(RunnerLifecycle)
    :sys.replace_state(RunnerLifecycle, &%{&1 | runners: %{}})
    on_exit(fn -> :sys.replace_state(RunnerLifecycle, fn _state -> previous_state end) end)

    assert {:ok, run} = Store.start(context.vault_id, nil, "batch runner expiry", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)
    owners = [context.user_id | Enum.to_list(-1_000..-2)]

    Enum.each(owners, fn owner_id ->
      sid = "batch-#{owner_id}"

      assert {:ok, []} =
               RunnerLifecycle.register(owner_id, sid, %{
                 activeRunIds: [],
                 runnerInstanceId: "batch"
               })

      RunnerLifecycle.disconnected(owner_id, sid, %{}, :transport_close)
    end)

    handler_id = "runner-batch-query-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, _config ->
          query = metadata[:query] |> to_string() |> String.replace(~r/\s+/u, " ")

          # Pending-delivery polling is separate from a full active-run snapshot.
          if String.contains?(query, "SELECT d.run_id,d.owner_user_id FROM delegated_runs") and
               String.contains?(query, "WHERE r.status IN ('queued','running')") do
            send(test_pid, :delegated_snapshot_query)
          end
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    Process.sleep(100)
    assert Store.get(run.id).status == "queued"
    refute_receive :delegated_snapshot_query, 150

    state = :sys.get_state(RunnerLifecycle)
    assert map_size(state.runners) == length(owners)
    refute Map.has_key?(state.last_error, context.user_id)
  end

  test "undelivered payload survives restart recovery and stays unchanged while its owner is offline",
       context do
    {:ok, run} = Store.start(context.vault_id, nil, "durable delivery", "codex")

    :ok =
      Store.record_delegated(run.id, context.user_id, %{
        runId: run.id,
        prompt: "original",
        cwd: "/scratch"
      })

    SQL.exec(
      "UPDATE delegated_runs SET delivery_sent_at=datetime('now','-20 seconds') WHERE run_id=?",
      [run.id]
    )

    before = SQL.one("SELECT * FROM delegated_runs WHERE run_id=?", [run.id])
    RunnerLifecycle.replay_delivery(run.id, context.user_id)
    assert SQL.one("SELECT * FROM delegated_runs WHERE run_id=?", [run.id]) == before
    send(RunnerLifecycle, :orphan_reclaim)
    :sys.get_state(RunnerLifecycle)
    assert Store.get(run.id).status == "queued"

    assert Store.pending_delivery(run.id, context.user_id) == [
             Jason.encode!(%{runId: run.id, prompt: "original", cwd: "/scratch"}),
             1
           ]
  end

  test "startup orphan recovery fails delegated runs that no desktop reclaims", context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "orphan after restart", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)

    send(RunnerLifecycle, :orphan_reclaim)

    assert %{
             status: "failed",
             summary: "Desktop agent runner did not reclaim this run after server restart."
           } = eventually_status(run.id, "failed")
  end

  test "runner callback registration is intentionally single-owned by DomainAdapter", context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "single registration", "codex")
    :ok = Store.record_delegated(run.id, context.user_id)

    assert {:ok, [run_id]} =
             RunnerLifecycle.register(context.user_id, "sid-domain", %{
               activeRunIds: [run.id],
               runnerInstanceId: "desktop-single"
             })

    assert run_id == run.id
    assert :ok = RunnerLifecycle.registered(context.user_id, "sid-hub", %{}, nil)

    health = RunnerLifecycle.health(context.user_id)
    assert health.activeRuns == 1
    assert Store.get(run.id).status == "queued"
  end

  test "session viewer and trace access are owner-only across vaults", context do
    suffix = System.unique_integer([:positive])
    second_vault = "session-home-#{suffix}"
    other_username = "session-other-#{suffix}"

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [other_username, "x", other_username, ""]
    )

    other_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      second_vault,
      "Home",
      "/tmp/#{second_vault}",
      context.user_id
    ])

    SQL.exec(
      "INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)",
      [second_vault, context.user_id, "owner", context.user_id]
    )

    SQL.exec(
      "INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)",
      [context.vault_id, other_id, "editor", context.user_id]
    )

    on_exit(fn ->
      SQL.exec("DELETE FROM runs WHERE owner_user_id=?", [other_id])
      SQL.exec("DELETE FROM vaults WHERE id=?", [second_vault])
      SQL.exec("DELETE FROM users WHERE id=?", [other_id])
    end)

    assert {:ok, work} =
             Store.start(context.vault_id, nil, "my work run", "codex",
               owner_user_id: context.user_id
             )

    assert {:ok, home} =
             Store.start(second_vault, nil, "my home run", "codex",
               owner_user_id: context.user_id
             )

    assert {:ok, foreign} =
             Store.start(context.vault_id, nil, "other person's run", "codex",
               owner_user_id: other_id
             )

    assert Enum.map(Store.active_sessions(context.user_id), & &1.id) == [home.id, work.id]

    assert Enum.map(Store.active_sessions(context.user_id), & &1.vault_name) == [
             "Home",
             "Orchestration"
           ]

    assert Store.owned?(work.id, context.user_id)
    refute Store.owned?(foreign.id, context.user_id)

    assert {:ok, [{:join, room}]} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runs",
               "joinRun",
               [work.id],
               %{id: context.user_id},
               %{}
             )

    assert room == "run:#{work.id}"

    assert {:error, "Run not found"} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runs",
               "joinRun",
               [foreign.id],
               %{id: context.user_id},
               %{}
             )

    token =
      Token.sign_user(%{id: context.user_id, username: context.username, auth_version: 0})

    sessions =
      conn(:get, "/api/me/active-sessions")
      |> put_req_header("authorization", "Bearer #{token}")
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert sessions.status == 200

    assert Enum.map(Jason.decode!(sessions.resp_body)["sessions"], & &1["id"]) == [
             home.id,
             work.id
           ]

    denied =
      conn(:get, "/api/runs/#{foreign.id}/events")
      |> put_req_header("authorization", "Bearer #{token}")
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert denied.status == 404
  end

  test "catalog dispatch accepts a body already parsed by the main router", context do
    token =
      Token.sign_user(%{
        id: context.user_id,
        username: context.username,
        auth_version: 0
      })

    conn =
      conn(:post, "/api/vaults/#{context.vault_id}/work-items", %{title: "Preparsed"})
      |> put_req_header("authorization", "Bearer #{token}")

    assert is_map(conn.body_params)

    assert {:handled, response} =
             DomainDispatch.dispatch(conn, [
               {CascadeWeb.OrchestrationRoutes, CascadeWeb.OrchestrationRouter}
             ])

    assert response.status == 201
    assert Jason.decode!(response.resp_body)["item"]["title"] == "Preparsed"
  end

  test "local agent graph has an authenticated cloud fallback", context do
    token =
      Token.sign_user(%{
        id: context.user_id,
        username: context.username,
        auth_version: 0
      })

    response =
      conn(:post, "/api/local-agents", %{template: "Summarize current work"})
      |> put_req_header("authorization", "Bearer #{token}")
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert response.status == 200

    assert %{"nodes" => [], "edges" => [], "scannedAt" => scanned_at} =
             Jason.decode!(response.resp_body)

    assert is_integer(scanned_at)

    unauthorized =
      conn(:post, "/api/local-agents", %{template: ""})
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert unauthorized.status == 401
  end

  defp eventually_status(run_id, expected, attempts \\ 50)

  defp eventually_status(run_id, expected, 0) do
    flunk("run #{run_id} did not reach #{expected}; last state: #{inspect(Store.get(run_id))}")
  end

  defp eventually_status(run_id, expected, attempts) do
    case Store.get(run_id) do
      %{status: ^expected} = run ->
        run

      _ ->
        Process.sleep(10)
        eventually_status(run_id, expected, attempts - 1)
    end
  end
end
