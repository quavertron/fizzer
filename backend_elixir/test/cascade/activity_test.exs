defmodule Cascade.ActivityTest do
  use ExUnit.Case, async: false
  alias Cascade.Activity
  alias Cascade.Content.{Query, Store}
  alias Cascade.Realtime.DomainAdapter
  alias Cascade.Realtime.{Hub, Session}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}
  @owner -8_910_001
  @other -8_910_002

  setup do
    Query.execute(
      "INSERT INTO users (id, username, password_hash, display_name, auth_version) VALUES (?, 'activity-owner', 'x', 'Owner', 0), (?, 'activity-other', 'x', 'Other', 0)",
      [@owner, @other]
    )

    vault = Store.create_vault(@owner, %{name: "Activity test"})

    on_exit(fn ->
      Store.delete_vault(vault.id, @owner)
      Query.execute("DELETE FROM users WHERE id IN (?, ?)", [@owner, @other])
    end)

    {:ok, vault: vault}
  end

  test "replay deduplicates, bounds history and reports missing cursors", %{vault: vault} do
    event = %{"id" => "one", "kind" => "tool", "tool" => "Write", "timestamp" => 1}
    Activity.publish(vault.id, event)
    Activity.publish(vault.id, event)
    first = Activity.replay(vault.id, %{})
    assert length(first.events) == 1
    cursor = %{"epoch" => first.cursor.epoch, "seq" => first.cursor.seq}
    assert Activity.replay(vault.id, cursor).events == []
    for n <- 1..300, do: Activity.publish(vault.id, %{event | "id" => "event-#{n}"})
    replay = Activity.replay(vault.id, cursor)
    assert replay.gap
    assert length(replay.events) == 256
    assert Activity.replay(vault.id, %{"epoch" => "old", "seq" => 1000}).gap
  end

  test "unauthorized replay contains no file contents", %{vault: vault} do
    Activity.publish(vault.id, %{"kind" => "edit", "old_lines" => ["secret"]})
    assert Activity.allowed?(vault.id, @owner)
    refute Activity.allowed?(vault.id, @other)

    assert {:ok, [{:emit, "vault:activity", [packet]}]} =
             DomainAdapter.handle_event(
               "/vault",
               "awatch:replay",
               [vault.id, %{}],
               %{id: @other},
               %{}
             )

    assert packet.events == []
    assert packet.status == "Vault write access required"
  end

  @tag skip: is_nil(System.get_env("FIZZER_ALOCK_BIN"))
  test "local edits reach the same native feed as remote commits", %{vault: vault} do
    File.mkdir_p!(vault.root_path)
    file = Path.join(vault.root_path, "activity.txt")
    File.write!(file, "before\n")
    assert {:ok, _} = Cascade.Alock.ensure(vault)
    binary = System.fetch_env!("FIZZER_ALOCK_BIN")

    {output, 0} =
      System.cmd(binary, ["stage", "--file", file, "--lines", "1-1", "--agent", "activity-test"])

    stage = Jason.decode!(output)["stage"]
    assert is_binary(stage)
    File.write!(stage, "after\n")

    {_, 0} =
      System.cmd(binary, [
        "commit",
        "--file",
        file,
        "--stage",
        stage,
        "--agent",
        "activity-test",
        "--author",
        "test"
      ])

    events = wait_for_edit(vault.id, 100)
    edit = Enum.find(events, &(&1["kind"] == "edit"))
    assert edit["file"] == "activity.txt"
    assert edit["new_lines"] == ["after"]
    refute Enum.any?(events, &String.starts_with?(&1["file"] || "", "/"))
  end

  test "live activity uses the joined vault connection and stops after membership removal", %{vault: vault} do
    token = Cascade.Auth.Token.sign_user(%{id: @owner, username: "activity-owner", auth_version: 0})
    {:ok, sid, pid} = Cascade.Realtime.start_session(domain: DomainAdapter)
    on_exit(fn -> if Process.alive?(pid), do: GenServer.stop(pid) end)
    assert {:ok, _} = Session.poll(sid)
    send_packet = fn packet ->
      payload = EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(packet)}])
      assert :ok = Session.receive_payload(sid, payload)
    end
    send_packet.(%{type: :connect, namespace: "/vault", data: %{"token" => token}})
    assert {:ok, _} = Session.poll(sid)
    send_packet.(SocketIO.event("/vault", "joinVault", [vault.id]))
    assert sid in Hub.room_members("vault:#{vault.id}", "/vault")
    Activity.publish(vault.id, %{"id" => "live", "kind" => "lock", "file" => "note"})
    assert {:ok, payload} = Session.poll(sid)
    assert payload =~ "vault:activity"
    assert payload =~ "note"
    Query.execute("DELETE FROM vault_members WHERE vault_id=? AND user_id=?", [vault.id, @owner])
    # Remove the creator fallback as well.
    Query.execute("UPDATE vaults SET created_by=? WHERE id=?", [@other, vault.id])
    refute Activity.allowed?(vault.id, @owner)
    Activity.publish(vault.id, %{"id" => "revoked", "kind" => "edit", "file" => "secret"})
    Activity.replay(vault.id, %{})
    Session.emit(sid, "/vault", "probe:barrier", [])
    assert {:ok, payload} = Session.poll(sid)
    assert payload =~ "probe:barrier"
    refute payload =~ "secret"
    Query.execute("UPDATE vaults SET created_by=? WHERE id=?", [@owner, vault.id])
  end

  defp wait_for_edit(vault, attempts) do
    events = Activity.replay(vault, %{}).events

    if Enum.any?(events, &(&1["kind"] == "edit")) or attempts == 0 do
      events
    else
      Process.sleep(20)
      wait_for_edit(vault, attempts - 1)
    end
  end
end
