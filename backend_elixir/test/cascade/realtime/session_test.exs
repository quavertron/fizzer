defmodule Cascade.Realtime.SessionTestDomain do
  @behaviour Cascade.Realtime.Domain

  @impl true
  def authorize_namespace(namespace, identity, metadata),
    do: {:ok, %{namespace: namespace, identity: identity, metadata: metadata}}

  @impl true
  def handle_event("/vault", "joinVault", [vault_id], _identity, _context),
    do: {:ok, [{:join, "vault:#{vault_id}"}]}

  def handle_event("/vault", "probe:ack", args, _identity, _context),
    do: {:ok, [{:ack, %{success: true, args: args}}]}

  def handle_event("/runners", "runner:register", [metadata], _identity, _context),
    do: {:ok, [{:register_runner, metadata}, {:emit, "runner:registered", [%{success: true}]}]}

  def handle_event(_namespace, _event, _args, _identity, _context),
    do: {:error, "Unsupported test event"}

  @impl true
  def namespace_disconnected(_namespace, _identity, _context, _reason), do: :ok
end

defmodule Cascade.Realtime.SessionTest do
  use ExUnit.Case, async: false

  alias Cascade.Auth.{Password, Token}
  alias Cascade.DB.Repo
  alias Cascade.Realtime.{Events, Hub, Session}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}
  alias Ecto.Adapters.SQL

  setup_all do
    case Process.whereis(Cascade.Realtime.Supervisor) do
      nil -> start_supervised!({Cascade.Realtime.Supervisor, []})
      _pid -> :ok
    end

    :ok
  end

  setup do
    {:ok, hash} = Password.hash("realtime-test-password")

    SQL.query!(
      Repo,
      """
      INSERT INTO users (username,password_hash,display_name,avatar_url,auth_version)
      VALUES (?,?,?,?,0)
      ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,
        display_name=excluded.display_name,avatar_url=excluded.avatar_url,auth_version=0
      """,
      ["realtime-sol", hash, "Realtime Sol", ""]
    )

    [[id, auth_version]] =
      SQL.query!(Repo, "SELECT id, auth_version FROM users WHERE username = ?", ["realtime-sol"]).rows

    token = Token.sign_user(%{id: id, username: "realtime-sol", auth_version: auth_version})

    on_exit(fn ->
      Hub.disconnect_user(id, ["/vault", "/runs", "/runners"])
      SQL.query!(Repo, "DELETE FROM users WHERE id = ?", [id])
    end)

    {:ok, token: token, user_id: id}
  end

  test "multiplexes namespaces, rooms, domain acknowledgements, and broadcasts", %{token: token} do
    {:ok, sid, _pid} = start_session()
    assert [%{type: :open, data: %{"sid" => ^sid}}] = poll_packets(sid)

    connect(sid, "/vault", token)
    connect(sid, "/runs", token)
    assert_connected(sid, ["/vault", "/runs"])

    send_socket(sid, SocketIO.event("/vault", "joinVault", ["v1"]))
    send_socket(sid, SocketIO.event("/vault", "probe:ack", ["hello"], 9))

    assert [%{type: :ack, namespace: "/vault", id: 9, data: [ack]}] = socket_poll(sid)
    assert ack["success"]
    assert ack["args"] == ["hello"]

    assert :ok = Hub.broadcast("vault:v1", "/vault", "vault:renamed", [%{name: "New"}])
    assert [%{type: :event, data: ["vault:renamed", %{"name" => "New"}]}] = socket_poll(sid)
  end

  test "cookie token authenticates namespaces and agent tokens fail closed", %{
    token: token,
    user_id: id
  } do
    {:ok, cookie_sid, _pid} = start_session(cookie_token: token)
    _open = poll_packets(cookie_sid)
    send_socket(cookie_sid, %{type: :connect, namespace: "/vault"})
    assert [%{type: :connect, namespace: "/vault"}] = socket_poll(cookie_sid)

    agent_token = Token.sign_agent(%{id: id, username: "realtime-sol", auth_version: 0})
    {:ok, sid, _pid} = start_session()
    _open = poll_packets(sid)
    connect(sid, "/vault", agent_token)

    assert [%{type: :connect_error, data: %{"message" => message}}] = socket_poll(sid)
    assert message == "This operation requires user access"
  end

  test "authenticates once per Engine.IO session and rejects a conflicting namespace token", %{
    token: token,
    user_id: id
  } do
    handler_id = "session-auth-cache-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, _config ->
          query = metadata[:query] |> to_string() |> String.replace(~r/\s+/u, " ")

          if String.contains?(query, "FROM users WHERE id = ?") or
               String.contains?(query, "FROM users WHERE id IN (?)"),
             do: send(test_pid, :auth_query)
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    {:ok, sid, _pid} = start_session()
    _open = poll_packets(sid)
    connect(sid, "/vault", token)
    connect(sid, "/runs", token)
    connect(sid, "/runners", token)
    assert_connected(sid, ["/vault", "/runs", "/runners"])
    assert_receive :auth_query, 500
    refute_receive :auth_query, 100

    send_socket(sid, %{type: :disconnect, namespace: "/vault"})
    connect(sid, "/vault", token)
    assert_connected(sid, ["/vault"])
    assert_receive :auth_query, 500
    refute_receive :auth_query, 100

    conflicting = Token.sign_agent(%{id: id, username: "realtime-sol", auth_version: 0})
    send_socket(sid, %{type: :connect, namespace: "/runs", data: %{"token" => conflicting}})

    assert [%{type: :connect_error, data: %{"message" => message}}] = socket_poll(sid)
    assert message == "This operation requires user access"
    refute_receive :auth_query, 100

    conflicting_user =
      Token.sign_user(%{id: id + 1, username: "different-user", auth_version: 0})

    send_socket(sid, %{type: :connect, namespace: "/runs", data: %{"token" => conflicting_user}})
    assert [%{type: :connect_error, data: %{"message" => message}}] = socket_poll(sid)
    assert message == "Invalid or expired token"

    send_socket(sid, %{type: :connect, namespace: "/runs", data: %{"token" => "invalid"}})
    assert [%{type: :connect_error, data: %{"message" => message}}] = socket_poll(sid)
    assert message == "Invalid or expired token"
    refute_receive :auth_query, 100

    {:ok, second_sid, _pid} = start_session()
    _open = poll_packets(second_sid)
    connect(second_sid, "/vault", token)
    assert_connected(second_sid, ["/vault"])
    assert_receive :auth_query, 500
  end

  test "each new Engine.IO session revalidates auth version and cached-token expiry", %{
    token: token,
    user_id: id
  } do
    {:ok, cached_sid, _pid} = start_session()
    _open = poll_packets(cached_sid)
    connect(cached_sid, "/vault", token)
    assert_connected(cached_sid, ["/vault"])

    SQL.query!(Repo, "UPDATE users SET auth_version=auth_version+1 WHERE id=?", [id])

    send_socket(cached_sid, %{type: :disconnect, namespace: "/vault"})
    connect(cached_sid, "/vault", token)

    assert [%{type: :connect_error, data: %{"message" => "Invalid or expired token"}}] =
             socket_poll(cached_sid)

    {:ok, revoked_sid, _pid} = start_session()
    _open = poll_packets(revoked_sid)
    connect(revoked_sid, "/vault", token)

    assert [%{type: :connect_error, data: %{"message" => "Invalid or expired token"}}] =
             socket_poll(revoked_sid)

    now = System.system_time(:second)
    expires_at = now + 1

    claims = %{
      "id" => id,
      "username" => "realtime-sol",
      "authVersion" => 1,
      "access" => "user",
      "iat" => now,
      "exp" => expires_at
    }

    {:ok, short_lived, _claims} =
      Joken.encode_and_sign(
        claims,
        Joken.Signer.create("HS256", Cascade.Config.jwt_secret!())
      )

    {:ok, priming_sid, _pid} = start_session()
    _open = poll_packets(priming_sid)
    connect(priming_sid, "/vault", short_lived)
    assert_connected(priming_sid, ["/vault"])

    Process.sleep(max((expires_at - System.system_time(:second)) * 1_000 + 100, 100))

    {:ok, expired_sid, _pid} = start_session()
    _open = poll_packets(expired_sid)
    connect(expired_sid, "/vault", short_lived)

    assert [%{type: :connect_error, data: %{"message" => "Invalid or expired token"}}] =
             socket_poll(expired_sid)
  end

  test "an initial multiplex cache wave is bounded and never crosses token expiry", %{
    token: token,
    user_id: id
  } do
    {:ok, bounded_sid, _pid} = start_session(auth_cache_wave_ms: 0)
    _open = poll_packets(bounded_sid)
    connect(bounded_sid, "/vault", token)
    assert_connected(bounded_sid, ["/vault"])
    Process.sleep(2)
    SQL.query!(Repo, "UPDATE users SET auth_version=auth_version+1 WHERE id=?", [id])
    connect(bounded_sid, "/runs", token)

    assert [%{type: :connect_error, data: %{"message" => "Invalid or expired token"}}] =
             socket_poll(bounded_sid)

    SQL.query!(Repo, "UPDATE users SET auth_version=0 WHERE id=?", [id])
    now = System.system_time(:second)

    claims = %{
      "id" => id,
      "username" => "realtime-sol",
      "authVersion" => 0,
      "access" => "user",
      "iat" => now,
      "exp" => now + 1
    }

    {:ok, short_lived, _claims} =
      Joken.encode_and_sign(
        claims,
        Joken.Signer.create("HS256", Cascade.Config.jwt_secret!())
      )

    {:ok, expiring_sid, _pid} = start_session()
    _open = poll_packets(expiring_sid)
    connect(expiring_sid, "/vault", short_lived)
    assert_connected(expiring_sid, ["/vault"])
    Process.sleep(1_100)
    connect(expiring_sid, "/runs", short_lived)

    assert [%{type: :connect_error, data: %{"message" => "Invalid or expired token"}}] =
             socket_poll(expiring_sid)
  end

  test "account revocation stops the whole Engine.IO manager including runners", %{
    token: token,
    user_id: id
  } do
    {:ok, sid, pid} = start_session()
    monitor = Process.monitor(pid)
    _open = poll_packets(sid)
    connect(sid, "/vault", token)
    connect(sid, "/runs", token)
    connect(sid, "/runners", token)
    assert_connected(sid, ["/vault", "/runs", "/runners"])
    register_runner(sid, "revoked")
    _registered = socket_poll(sid)
    assert {:ok, %{sid: ^sid}} = Hub.runner(id)

    assert :ok = Events.disconnect_user(id)
    assert_receive {:DOWN, ^monitor, :process, ^pid, {:shutdown, :session_revoked}}, 1_000
    assert eventually(fn -> Cascade.Realtime.lookup(sid) == :error end)
    assert Hub.runner(id) == :error
  end

  test "correlates server events with client acknowledgements", %{token: token} do
    {:ok, sid, _pid} = start_session()
    _open = poll_packets(sid)
    connect(sid, "/runners", token)
    assert_connected(sid, ["/runners"])

    task =
      Task.async(fn ->
        Session.emit_with_ack(sid, "/runners", "run:cancel", [%{runId: 42}], 2_000)
      end)

    assert [%{type: :event, namespace: "/runners", id: ack_id, data: ["run:cancel", _]}] =
             socket_poll(sid)

    send_socket(sid, SocketIO.ack("/runners", ack_id, [%{success: true}]))
    assert {:ok, [%{"success" => true}]} = Task.await(task)
  end

  test "websocket probe releases an outstanding poll before the final upgrade packet", %{
    token: token
  } do
    {:ok, sid, _pid} = start_session()
    _open = poll_packets(sid)

    connect(sid, "/vault", token)
    assert_connected(sid, ["/vault"])

    poll = Task.async(fn -> Session.poll(sid) end)
    assert Task.yield(poll, 25) == nil

    assert {:ok, []} = Session.attach_websocket(sid, self(), :upgrade)
    assert {:ok, ["3probe"]} = Session.websocket_packet(sid, "2probe", self())

    assert {:ok, {:ok, "6"}} = Task.yield(poll, 500)
    assert {:ok, []} = Session.websocket_packet(sid, "5", self())

    for namespace <- ["/runs", "/runners"] do
      raw =
        %{type: :connect, namespace: namespace, data: %{"token" => token}}
        |> SocketIO.encode()
        |> then(&EngineIO.encode_packet(%{type: :message, data: &1}))

      assert {:ok, []} = Session.websocket_packet(sid, raw, self())
      assert_receive {:socket_io_packets, [reply]}, 500
      assert {:ok, %{type: :message, data: encoded}} = EngineIO.decode_packet(reply)
      assert {:ok, %{type: :connect, namespace: ^namespace}} = SocketIO.decode(encoded)
    end
  end

  test "one runner per owner is replaced without killing other namespaces", %{token: token} do
    {:ok, sid1, _pid} = start_session()
    _open = poll_packets(sid1)
    connect(sid1, "/vault", token)
    connect(sid1, "/runners", token)
    assert_connected(sid1, ["/vault", "/runners"])
    register_runner(sid1, "old")
    _registered = socket_poll(sid1)

    {:ok, sid2, _pid} = start_session()
    _open = poll_packets(sid2)
    connect(sid2, "/runners", token)
    assert_connected(sid2, ["/runners"])
    register_runner(sid2, "new")
    _registered = socket_poll(sid2)

    assert {:ok, %{sid: ^sid2}} = Hub.runner(repo_user_id())
    assert :ets.lookup(Cascade.Realtime.Hub.RunnerSessions, sid1) == []

    assert [{^sid2, owner_id, "/runners"}] =
             :ets.lookup(Cascade.Realtime.Hub.RunnerSessions, sid2)

    assert owner_id == repo_user_id()
    assert [%{type: :disconnect, namespace: "/runners"}] = socket_poll(sid1)

    Cascade.Realtime.emit(sid1, "/vault", "vault:renamed", [%{name: "still alive"}])
    assert [%{type: :event, namespace: "/vault"}] = socket_poll(sid1)
  end

  test "namespace cleanup only removes runners owned by that session" do
    target_sid = "runner-target-#{System.unique_integer([:positive])}"
    other_sid = "runner-other-#{System.unique_integer([:positive])}"
    target_owner = -System.unique_integer([:positive])
    other_owner = -System.unique_integer([:positive])

    on_exit(fn ->
      Hub.unregister_runner(target_owner, target_sid)
      Hub.unregister_runner(other_owner, other_sid)
    end)

    assert :ok = Hub.register_runner(target_owner, target_sid, "/runners", %{name: "target"})
    assert :ok = Hub.register_runner(other_owner, other_sid, "/runners", %{name: "other"})

    assert :ok = Hub.leave_namespace(target_sid, "/vault", :normal)
    assert {:ok, %{sid: ^target_sid}} = Hub.runner(target_owner)

    assert :ok = Hub.leave_namespace(target_sid, "/runners", :normal)
    assert :error = Hub.runner(target_owner)
    assert :ets.lookup(Cascade.Realtime.Hub.RunnerSessions, target_sid) == []
    assert {:ok, %{sid: ^other_sid}} = Hub.runner(other_owner)
  end

  test "authenticated idle sessions hibernate and wake without losing rooms", %{token: token} do
    {:ok, sid, pid} = start_session(hibernate_after_ms: 20)
    _open = poll_packets(sid)
    connect(sid, "/vault", token)
    assert_connected(sid, ["/vault"])
    send_socket(sid, SocketIO.event("/vault", "joinVault", ["hibernate-vault"]))

    assert eventually(fn ->
             Process.info(pid, :current_function) ==
               {:current_function, {:gen_server, :loop_hibernate, 4}}
           end)

    assert :ok = Hub.broadcast("vault:hibernate-vault", "/vault", "vault:renamed", [%{}])
    assert [%{type: :event, namespace: "/vault", data: ["vault:renamed", %{}]}] = socket_poll(sid)
  end

  defp start_session(opts \\ []) do
    Cascade.Realtime.start_session(
      Keyword.merge([domain: Cascade.Realtime.SessionTestDomain], opts)
    )
  end

  defp connect(sid, namespace, token),
    do: send_socket(sid, %{type: :connect, namespace: namespace, data: %{"token" => token}})

  defp register_runner(sid, instance),
    do:
      send_socket(
        sid,
        SocketIO.event("/runners", "runner:register", [
          %{"activeRunIds" => [], "runnerInstanceId" => instance}
        ])
      )

  defp send_socket(sid, socket_packet) do
    payload = EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(socket_packet)}])
    assert :ok = Session.receive_payload(sid, payload)
  end

  defp poll_packets(sid) do
    assert {:ok, payload} = Session.poll(sid)
    assert {:ok, packets} = EngineIO.decode_payload(payload)
    packets
  end

  defp socket_poll(sid) do
    sid
    |> poll_packets()
    |> Enum.filter(&(&1.type == :message))
    |> Enum.map(fn packet ->
      {:ok, decoded} = SocketIO.decode(packet.data)
      decoded
    end)
  end

  defp assert_connected(sid, namespaces) do
    connected = socket_poll(sid)
    assert Enum.map(connected, & &1.namespace) == namespaces
    assert Enum.all?(connected, &(&1.type == :connect and is_binary(&1.data["sid"])))
  end

  defp repo_user_id do
    [[id]] = SQL.query!(Repo, "SELECT id FROM users WHERE username = ?", ["realtime-sol"]).rows
    id
  end

  defp eventually(assertion, attempts \\ 20)
  defp eventually(assertion, 0), do: assertion.()

  defp eventually(assertion, attempts) do
    if assertion.() do
      true
    else
      Process.sleep(10)
      eventually(assertion, attempts - 1)
    end
  end
end
