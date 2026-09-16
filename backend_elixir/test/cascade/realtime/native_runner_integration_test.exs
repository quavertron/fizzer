defmodule Cascade.Realtime.NativeRunnerRouter do
  use Plug.Router

  plug :match
  plug :dispatch

  match "/socket.io/*_path" do
    CascadeWeb.SocketIOPlug.call(
      conn,
      CascadeWeb.SocketIOPlug.init(domain: Cascade.Realtime.DomainAdapter)
    )
  end

  match _, do: Plug.Conn.send_resp(conn, 404, "not found")
end

defmodule Cascade.Realtime.NativeRunnerIntegrationTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Realtime.{Hub, Session}
  alias Cascade.Runs.{RunnerLifecycle, Store}

  @runner Path.expand("../../support/native_runner_flow.mjs", __DIR__)

  setup_all do
    if is_nil(Process.whereis(Cascade.Missions.DispatchReannouncer)),
      do: start_supervised!({Cascade.Missions.DispatchReannouncer, interval: 20})

    port = available_port()

    start_supervised!(
      {Bandit,
       plug: Cascade.Realtime.NativeRunnerRouter,
       scheme: :http,
       ip: {127, 0, 0, 1},
       port: port,
       thousand_island_options: [num_acceptors: 2, num_connections: 100]}
    )

    {:ok, target: "http://127.0.0.1:#{port}"}
  end

  setup do
    context = Cascade.TestHelpers.owner_vault("native-runner")
    token = Token.sign_user(%{id: context.user_id, username: context.username, auth_version: 0})
    Map.put(context, :token, token)
  end

  @tag timeout: 30_000
  test "real socket.io-client runner registers, completes, ACK-cancels, and prepares workspaces",
       context do
    node = open_node_port([context.target, context.token])
    ready = receive_json(node, 10_000)
    assert ready["ready"]
    assert ready["response"]["ok"]
    assert {:ok, %{sid: sid}} = eventually_runner(context.user_id)

    assert {:ok, completed} = Store.start(context.vault_id, nil, "complete", "codex")

    assert RunnerLifecycle.delegate(context.user_id, %{
             runId: completed.id,
             prompt: "complete",
             probeMode: "complete"
           })

    assert %{status: "completed", session_id: session_id} = eventually_terminal(completed.id)
    assert session_id == "native-session-#{completed.id}"
    assert Enum.map(Store.events(completed.id), & &1.seq) == Enum.to_list(1..4)

    assert {:ok, dropped} = Store.start(context.vault_id, nil, "lost delivery", "codex")

    payload = %{
      runId: dropped.id,
      prompt: "lost delivery",
      probeMode: "drop-first",
      cwd: "/scratch",
      resumeSessionId: "same-session",
      images: [%{data: "test"}],
      reasoningEffort: "low"
    }

    assert RunnerLifecycle.delegate(context.user_id, payload)
    assert %{"dropped" => dropped_id} = receive_json(node, 5_000)
    assert dropped_id == dropped.id
    assert Store.get(dropped.id).status == "queued"
    assert length(Store.events(dropped.id)) == 1
    assert is_list(Store.pending_delivery(dropped.id, context.user_id))

    SQL.exec(
      "UPDATE delegated_runs SET delivery_sent_at=datetime('now','-20 seconds') WHERE run_id=?",
      [dropped.id]
    )

    Cascade.Missions.DispatchReannouncer.wake()
    assert %{status: "completed", id: ^dropped_id} = eventually_terminal(dropped.id)
    assert is_nil(Store.pending_delivery(dropped.id, context.user_id))
    refute RunnerLifecycle.delegate(context.user_id, payload)

    assert {:ok, silent} = Store.start(context.vault_id, nil, "unconfirmed delivery", "codex")

    assert RunnerLifecycle.delegate(context.user_id, %{
             runId: silent.id,
             prompt: "unconfirmed delivery",
             probeMode: "cancel"
           })

    SQL.exec(
      "UPDATE delegated_runs SET delivery_attempts=5,delivery_sent_at=datetime('now','-20 seconds') WHERE run_id=?",
      [silent.id]
    )

    Cascade.Missions.DispatchReannouncer.wake()
    assert %{status: "failed", summary: summary} = eventually_terminal(silent.id)
    assert summary =~ "five attempts"

    assert {:ok, canceled} = Store.start(context.vault_id, nil, "cancel", "codex")

    assert RunnerLifecycle.delegate(context.user_id, %{
             runId: canceled.id,
             prompt: "cancel",
             probeMode: "cancel"
           })

    assert {:error, :active_runner} =
             RunnerLifecycle.register(context.user_id, "contending-desktop", %{
               activeRunIds: [],
               runnerInstanceId: "another-desktop"
             })

    assert {:ok, %{sid: ^sid}} = Hub.runner(context.user_id)
    assert Store.get(canceled.id).status == "queued"

    assert Store.cancel(canceled.id)
    assert Store.get(canceled.id).status == "canceled"

    assert {:ok, workspace} =
             RunnerLifecycle.prepare_workspace(context.user_id, %{workItemId: "native"}, 5_000)

    assert workspace.path == "/tmp/native-worktree"
    assert workspace.baseCommit == "0123456789abcdef0123456789abcdef01234567"

    Session.emit(sid, "/runners", "probe:finish", [])
    assert %{"done" => true} = receive_json(node, 5_000)
    assert_receive {^node, {:exit_status, 0}}, 5_000
  end

  defp open_node_port(args) do
    Port.open(
      {:spawn_executable, System.find_executable("node")},
      [:binary, :exit_status, :stderr_to_stdout, args: [@runner | args], line: 65_536]
    )
  end

  defp receive_json(port, timeout) do
    receive do
      {^port, {:data, {:eol, line}}} -> decode_node_line(line)
      {^port, {:data, {:noeol, line}}} -> decode_node_line(line)
      {^port, {:exit_status, status}} -> flunk("Node runner exited early with #{status}")
    after
      timeout -> flunk("Node runner did not respond within #{timeout}ms")
    end
  end

  defp decode_node_line(line) do
    case Jason.decode(line) do
      {:ok, value} -> value
      {:error, _reason} -> flunk("Node runner emitted non-JSON output: #{line}")
    end
  end

  defp eventually_runner(user_id, attempts \\ 100)
  defp eventually_runner(_user_id, 0), do: :error

  defp eventually_runner(user_id, attempts) do
    case Hub.runner(user_id) do
      {:ok, runner} ->
        {:ok, runner}

      :error ->
        Process.sleep(20)
        eventually_runner(user_id, attempts - 1)
    end
  end

  defp eventually_terminal(run_id, attempts \\ 100)

  defp eventually_terminal(run_id, 0),
    do: flunk("run #{run_id} did not reach a terminal state")

  defp eventually_terminal(run_id, attempts) do
    case Store.get(run_id) do
      %{status: status} = run when status in ["completed", "failed", "canceled"] ->
        run

      _ ->
        Process.sleep(20)
        eventually_terminal(run_id, attempts - 1)
    end
  end

  defp available_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
