defmodule Cascade.Realtime.OutboundIntegrationRouter do
  use Plug.Router

  plug :match
  plug :dispatch

  match "/socket.io/*_path" do
    CascadeWeb.SocketIOPlug.call(
      conn,
      CascadeWeb.SocketIOPlug.init(domain: Cascade.Realtime.DomainAdapter)
    )
  end

  match _ do
    CascadeWeb.ChatRouter.call(
      conn,
      CascadeWeb.ChatRouter.init(events: Cascade.Chat.Events.Noop)
    )
  end
end

defmodule Cascade.Realtime.OutboundEventIntegrationTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Channel, Messages}
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Events, Hub, PresenceDispatcher}
  alias Cascade.Runs.Store, as: RunStore

  @probe Path.expand("../../support/realtime_event_probe.mjs", __DIR__)

  setup_all do
    {:ok, _applications} = Application.ensure_all_started(:inets)
    port = available_port()

    start_supervised!(
      {Bandit,
       plug: Cascade.Realtime.OutboundIntegrationRouter,
       scheme: :http,
       ip: {127, 0, 0, 1},
       port: port,
       thousand_island_options: [num_acceptors: 2, num_connections: 100]}
    )

    {:ok, target: "http://127.0.0.1:#{port}"}
  end

  setup do
    Enum.each(1..3, &Events.disconnect_user/1)

    assert eventually(fn ->
             Enum.all?(1..3, &(Hub.room_members("user:#{&1}", "/vault") == []))
           end)

    Cascade.Accounts.Schema.ensure!()
    Cascade.Runs.Schema.ensure!()
    Cascade.Chat.Schema.ensure!()
    reset_database()
    PresenceDispatcher.invalidate_user_channels()

    root =
      Path.join(
        System.tmp_dir!(),
        "cascade-elixir-realtime-#{System.unique_integer([:positive])}"
      )

    previous_root = System.get_env("CASCADE_VAULTS_BASE_DIR")
    previous_sink = Application.get_env(:cascade_elixir, :note_mutation_sink)
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)

    SQL.exec("""
    INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES
      (1,'alice','x','Alice','alice.png',0),
      (2,'bob','x','Bob','bob.png',0),
      (3,'eve','x','Eve','eve.png',0)
    """)

    on_exit(fn ->
      if previous_sink,
        do: Application.put_env(:cascade_elixir, :note_mutation_sink, previous_sink),
        else: Application.delete_env(:cascade_elixir, :note_mutation_sink)

      reset_database()
      File.rm_rf!(root)

      if previous_root,
        do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous_root),
        else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)

    :ok
  end

  @tag timeout: 60_000
  test "initial presence resolves authorization, participants, profiles, owner, and online state in two reads" do
    {source, _source_channel, local, local_channel} = linked_chat()
    handler_id = "initial-presence-query-count-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, _config ->
          if self() == test_pid do
            query = metadata[:query] |> to_string() |> String.replace(~r/\s+/u, " ")
            send(test_pid, {:initial_presence_query, query})
          end
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, payload, route} = Events.initial_presence(local_channel.id, 2)
    assert route.sourceVaultId == source.id
    assert route.localVaultId == local.id
    assert payload.participants == ["alice", "bob"]
    assert payload.owner == "alice"
    assert payload.profiles["alice"].displayName == "Alice"

    queries = collect_presence_queries([])
    assert length(queries) == 2
    assert Enum.count(queries, &String.contains?(&1, "JOIN vault_members member")) == 1
    assert Enum.count(queries, &String.contains?(&1, "WITH source AS")) == 1
    refute Enum.any?(queries, &String.contains?(&1, "sqlite_master"))
  end

  test "presence never embeds profile avatars" do
    {source, source_channel, _local, _local_channel} = linked_chat()
    inline_avatar = "data:image/jpeg;base64," <> String.duplicate("A", 300_000)
    SQL.exec("UPDATE users SET avatar_url=? WHERE username='alice'", [inline_avatar])

    snapshot = Channel.participant_snapshot(source.id, source_channel.id)

    refute Map.has_key?(snapshot.profiles["alice"], :avatarUrl)
    refute Map.has_key?(Enum.find(snapshot.users, &(&1.username == "alice")), :avatarUrl)
  end

  test "presence snapshots and route reads emit exact reason telemetry" do
    {source, source_channel, _local, _local_channel} = linked_chat()
    handler_id = "presence-reason-count-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach_many(
        handler_id,
        [
          [:cascade, :realtime, :presence_snapshot],
          [:cascade, :chat, :list_routes]
        ],
        fn event, measurements, metadata, _config ->
          send(test_pid, {:presence_reason, event, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, _payload, _route} = Events.initial_presence(source_channel.id, 1)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :initial}}

    assert :refreshed = Events.emit_presence_now(source.id, source_channel.id, :direct)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :direct}}

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :direct}}

    assert :refreshed = Events.emit_presence_now(source.id, source_channel.id, :dispatcher)

    assert_receive {:presence_reason, [:cascade, :realtime, :presence_snapshot], %{count: 1},
                    %{reason: :dispatcher}}

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :dispatcher}}

    _routes = Channel.list_routes(source.id, source_channel.id)

    assert_receive {:presence_reason, [:cascade, :chat, :list_routes], %{count: 1},
                    %{reason: :other}}
  end

  test "participant snapshots preserve exact mixed-case author identity" do
    {source, source_channel, _local, _local_channel} = linked_chat()

    SQL.exec(
      "INSERT INTO chat_messages(id,channel_id,vault_id,author,body) VALUES(?,?,?,?,?)",
      ["mixed-case", source_channel.id, source.id, "ALICE", "legacy casing"]
    )

    snapshot = Channel.participant_snapshot(source.id, source_channel.id)
    assert "ALICE" in snapshot.participants
    assert "alice" in snapshot.participants
    assert Map.has_key?(snapshot.profiles, "alice")
    refute Map.has_key?(snapshot.profiles, "ALICE")
  end

  test "participant snapshots do not promote legacy agent authors to people" do
    {source, source_channel, _local, _local_channel} = linked_chat()

    SQL.exec(
      "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES(?,?,?,?,?,?,?)",
      [
        "builder-registration",
        source_channel.id,
        source.id,
        "builder-agent",
        "codex",
        "Builder",
        "builder"
      ]
    )

    SQL.exec(
      "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES(?,?,?,?,?,?,?)",
      ["sol-registration", source_channel.id, source.id, "sol-agent", "codex", "Sol", "sol"]
    )

    SQL.exec(
      "INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,mention) VALUES(?,?,?,?,?,?,?)",
      ["eve-registration", source_channel.id, source.id, "eve-agent", "codex", "Eve", "eve"]
    )

    legacy_local = Store.create_vault(3, %{name: "Legacy agent vault"})

    legacy_channel =
      Store.create_note(legacy_local.id, 3, %{
        title: "Legacy mirror",
        content: "cascade://chat-channel"
      })

    assert {:ok, _route} =
             Channel.link(source.id, source_channel.id, legacy_local.id, legacy_channel.id, 1)

    for {id, author} <- [{"legacy-builder", "builder"}, {"legacy-sol", "Sol"}] do
      SQL.exec(
        "INSERT INTO chat_messages(id,channel_id,vault_id,author,body) VALUES(?,?,?,?,?)",
        [id, source_channel.id, source.id, author, "legacy agent message"]
      )
    end

    snapshot = Channel.participant_snapshot(source.id, source_channel.id)

    assert "alice" in snapshot.participants
    refute "builder" in snapshot.participants
    refute "Sol" in snapshot.participants
    refute "eve" in snapshot.participants
  end

  test "real Bandit keeps mutation responses in the stream owner", %{target: target} do
    {vault, channel, _local, _local_channel} = linked_chat()
    authorization = "Bearer #{token(1, "alice")}"

    assert {201, created} =
             http_json(
               :post,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages",
               authorization,
               %{id: "bandit-owner-message", body: "created over real Bandit"}
             )

    assert created["message"]["id"] == "bandit-owner-message"
    assert created["message"]["body"] == "created over real Bandit"

    assert {200, updated} =
             http_json(
               :patch,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages/bandit-owner-message",
               authorization,
               %{body: "patched over real Bandit"}
             )

    assert updated["message"]["id"] == "bandit-owner-message"
    assert updated["message"]["body"] == "patched over real Bandit"

    assert {200, %{"ok" => true}} =
             http_json(
               :delete,
               "#{target}/api/vaults/#{vault.id}/channels/#{channel.id}/messages/bandit-owner-message",
               authorization
             )
  end

  test "vault General and every chat-marker lifecycle mutation invalidate presence indexes" do
    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    _vault = Store.create_vault(1, %{name: "General invalidation"})
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    vault = Store.create_vault(1, %{name: "Marker transitions"})
    note = Store.create_note(vault.id, 1, %{title: "Plain", content: "plain"})
    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.update_note(note.id, "cascade://chat-channel", 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.update_note(note.id, "plain again", 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.delete_note(note.id)
    assert PresenceDispatcher.cached_user_channels(1) == :miss

    generation = PresenceDispatcher.user_channels_generation()
    assert :ok = PresenceDispatcher.remember_user_channels(1, [["old", "old"]], generation)
    Store.rescan_vault(vault.id, 1)
    assert PresenceDispatcher.cached_user_channels(1) == :miss
  end

  @tag timeout: 60_000
  test "real clients receive linked local projections while an unauthorized socket receives nothing",
       %{
         target: target
       } do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    eve = open_probe(target, token(3, "eve"), "eve")
    close_on_exit([alice, bob, eve])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    command(eve, "vault", "joinVault", [source.id])
    refute eventually_joined?("vault:#{source.id}", 3)

    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    flush_probe(alice)
    flush_probe(bob)
    flush_probe(eve)

    {:ok, message} =
      Messages.create(%{id: 1, username: "alice"}, source.id, source_channel.id, %{
        id: "linked-message",
        body: "persisted first"
      })

    assert Messages.get(source_channel.id, 1, message.id) == {:ok, message}

    Events.emit(%{
      event: "vault:chatMessageCreated",
      vaultId: source.id,
      channelId: source_channel.id,
      message: message,
      dispatches: [
        %{id: "alice-dispatch", registration: %{ownerUserId: 1, pingableByOthers: false}},
        %{id: "bob-dispatch", registration: %{ownerUserId: 2, pingableByOthers: false}}
      ]
    })

    alice_event = await_event(alice, "vault", "vault:chatMessageCreated")
    bob_event = await_event(bob, "vault", "vault:chatMessageCreated")

    assert get_in(alice_event, ["args", Access.at(0), "vaultId"]) == source.id
    assert get_in(alice_event, ["args", Access.at(0), "channelId"]) == source_channel.id

    assert get_in(alice_event, ["args", Access.at(0), "message", "channelId"]) ==
             source_channel.id

    assert get_in(alice_event, ["args", Access.at(0), "dispatches", Access.at(0), "id"]) ==
             "alice-dispatch"

    assert get_in(bob_event, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(bob_event, ["args", Access.at(0), "channelId"]) == local_channel.id
    assert get_in(bob_event, ["args", Access.at(0), "message", "channelId"]) == local_channel.id

    assert get_in(bob_event, ["args", Access.at(0), "dispatches", Access.at(0), "id"]) ==
             "bob-dispatch"

    for event <- ["vault:chatMessageCreated", "vault:chatMessageUpdated"],
        {id, body} <- [
          {"sys-next-completed-hidden", "Internal checkpoint instructions"},
          {"empty-completed-hidden", " \n"}
        ] do
      Events.emit(%{
        event: event,
        vaultId: source.id,
        channelId: source_channel.id,
        message: %{
          message
          | id: id,
            body: body
        },
        dispatches: [%{id: "internal-dispatch", registration: %{ownerUserId: 1}}]
      })

      for client <- [alice, bob] do
        retraction =
          receive_matching(
            client,
            fn packet ->
              refute packet["event"] in ["vault:chatMessageCreated", "vault:chatMessageUpdated"]
              packet["event"] == "vault:chatMessageDeleted"
            end,
            5_000
          )

        payload = get_in(retraction, ["args", Access.at(0)])
        assert payload["messageId"] == id
        refute Map.has_key?(payload, "message")
        refute Map.has_key?(payload, "dispatches")
      end
    end

    refute_receive {^eve, {:data, _}}, 400
  end

  @tag timeout: 60_000
  test "presence is app-wide, linked-route local, and remains online until the final window closes",
       %{
         target: target
       } do
    {source, source_channel, local, local_channel} = linked_chat()
    alice_one = open_probe(target, token(1, "alice"), "alice-one")
    alice_two = open_probe(target, token(1, "alice"), "alice-two")
    bob = open_probe(target, token(2, "bob"), "bob")
    close_on_exit([alice_one, alice_two, bob])

    join_vault(alice_one, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice_one, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)

    initial = await_presence(bob, ["alice", "bob"])
    assert get_in(initial, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(initial, ["args", Access.at(0), "channelId"]) == local_channel.id

    assert get_in(initial, ["args", Access.at(0), "profiles", "alice"]) == %{
             "id" => 1,
             "username" => "alice",
             "displayName" => "Alice"
           }

    disconnect_namespace(alice_one, "vault")
    still_online = await_presence(bob, ["alice", "bob"])
    assert get_in(still_online, ["args", Access.at(0), "online"]) == ["alice", "bob"]

    disconnect_namespace(alice_two, "vault")
    offline = await_presence(bob, ["bob"])
    assert get_in(offline, ["args", Access.at(0), "online"]) == ["bob"]
  end

  @tag timeout: 60_000
  test "a presence burst reaches a real room client as one final refresh", %{target: target} do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    close_on_exit([alice, bob])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    assert await_presence(bob, ["alice", "bob"])
    assert eventually(&presence_dispatcher_idle?/0)
    flush_probe(bob)
    before = PresenceDispatcher.stats()

    Enum.each(1..25, fn _ -> Events.emit_presence(source.id, source_channel.id) end)

    refresh = await_presence(bob, ["alice", "bob"])
    assert get_in(refresh, ["args", Access.at(0), "vaultId"]) == local.id
    assert get_in(refresh, ["args", Access.at(0), "channelId"]) == local_channel.id
    assert eventually(&presence_dispatcher_idle?/0)
    after_refresh = PresenceDispatcher.stats()

    assert after_refresh.requested - before.requested == 25
    assert after_refresh.dispatched - before.dispatched == 1
    refute_receive {^bob, {:data, _line}}, 400
  end

  @tag timeout: 60_000
  test "final namespace disconnect reuses warmed presence indexes before broadcasting offline",
       %{target: target} do
    {source, source_channel, local, local_channel} = linked_chat()
    alice = open_probe(target, token(1, "alice"), "alice-index")
    bob = open_probe(target, token(2, "bob"), "bob-index")
    close_on_exit([alice, bob])

    join_vault(alice, source.id, 1)
    join_vault(bob, local.id, 2)
    join_chat(alice, source_channel.id, source_channel.id, 1)
    join_chat(bob, local_channel.id, source_channel.id, 2)
    assert await_presence(bob, ["alice", "bob"])
    assert eventually(&presence_dispatcher_idle?/0)

    assert eventually(fn ->
             match?({:ok, _channels}, PresenceDispatcher.cached_user_channels(1))
           end)

    flush_probe(bob)

    handler_id = "presence-disconnect-query-#{System.unique_integer([:positive])}"
    test_pid = self()

    :ok =
      :telemetry.attach(
        handler_id,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, _config ->
          query = metadata[:query] |> to_string() |> String.replace(~r/\s+/u, " ")

          if String.contains?(query, "SELECT vault_id FROM notes WHERE id=?") or
               String.contains?(query, "SELECT n.vault_id,n.id FROM notes n JOIN vaults") do
            send(test_pid, {:avoidable_disconnect_query, query})
          end
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    disconnect_namespace(alice, "vault")
    assert await_presence(bob, ["bob"])
    refute_receive {:avoidable_disconnect_query, _query}, 300

    stale_generation = PresenceDispatcher.user_channels_generation()
    Events.members_changed(%{vaultId: source.id})
    assert eventually(fn -> PresenceDispatcher.cached_user_channels(1) == :miss end)

    assert PresenceDispatcher.remember_user_channels(1, [["stale", "stale"]], stale_generation) ==
             :stale

    assert PresenceDispatcher.cached_user_channels(1) == :miss

    current_generation = PresenceDispatcher.user_channels_generation()

    assert PresenceDispatcher.remember_user_channels(
             1,
             [[source.id, source_channel.id]],
             current_generation
           ) ==
             :ok

    assert PresenceDispatcher.cached_user_channels(1) ==
             {:ok, [[source.id, source_channel.id]]}
  end

  @tag timeout: 60_000
  test "profile, visibility, member, community, note, folder, and tag events use current audiences",
       %{
         target: target
       } do
    vault = Store.create_vault(1, %{name: "Shared"})
    {:ok, _member} = Cascade.Accounts.VaultMembers.add(vault.id, 1, 2, "editor")
    alice = open_probe(target, token(1, "alice"), "alice")
    bob = open_probe(target, token(2, "bob"), "bob")
    eve = open_probe(target, token(3, "eve"), "eve")
    close_on_exit([alice, bob, eve])
    join_vault(alice, vault.id, 1)
    join_vault(bob, vault.id, 2)
    flush_probe(alice)
    flush_probe(bob)
    flush_probe(eve)

    profile = %{id: 1, username: "alice", displayName: "Alice Prime", avatarUrl: "new.png"}
    Events.profile_updated(%{userId: 1, profile: profile})

    assert get_in(await_event(bob, "vault", "vault:userProfileUpdated"), ["args", Access.at(0)]) ==
             stringify(profile)

    refute_receive {^eve, {:data, _}}, 250

    settings = %{vaultId: vault.id, visibility: "public", topics: ["software"]}
    Events.visibility_changed(settings)

    assert get_in(await_event(bob, "vault", "vault:visibilityChanged"), ["args", Access.at(0)]) ==
             stringify(settings)

    Events.install_note_mutation_sink()
    note = Store.create_note(vault.id, 1, %{title: "Realtime note", content: "body"})
    assert Store.get_note(note.id).id == note.id
    assert await_event(bob, "vault", "community:changed")

    Events.emit(%{
      event: "vault:noteCreated",
      noteId: note.id,
      vaultId: vault.id,
      title: note.title
    })

    assert get_in(await_event(bob, "vault", "vault:noteCreated"), ["args", Access.at(0), "noteId"]) ==
             note.id

    Store.add_tag(note.id, vault.id, "realtime", nil, 1)
    assert await_event(bob, "vault", "community:changed")

    folder = Store.create_folder(vault.id, %{name: "Temporary"})
    Store.move_note(note.id, folder.id, nil, 1)
    assert await_event(bob, "vault", "community:changed")
    Store.delete_folder(folder.id, 1)
    assert await_event(bob, "vault", "community:changed")

    SQL.exec("DELETE FROM vault_members WHERE vault_id=? AND user_id=2", [vault.id])

    Events.vault_event(vault.id, "vault:chatPresence", %{
      vaultId: vault.id,
      online: ["alice"]
    })

    assert await_event(bob, "vault", "vault:chatPresence")
    assert joined?("vault:#{vault.id}", 2)

    Events.members_changed(%{vaultId: vault.id})
    assert await_event(alice, "vault", "vault:membersChanged")
    assert eventually(fn -> not joined?("vault:#{vault.id}", 2) end)
    refute_receive {^bob, {:data, _}}, 350
  end

  @tag timeout: 60_000
  test "run events are durable before a real subscribed client observes them", %{target: target} do
    vault = Store.create_vault(1, %{name: "Runs"})
    client = open_probe(target, token(1, "alice"), "alice")
    close_on_exit([client])

    {:ok, run} =
      RunStore.start(vault.id, nil, "prove ordering", "codex", owner_user_id: 1)

    command(client, "runs", "joinRun", [run.id])
    assert eventually(fn -> joined?("run:#{run.id}", 1, "/runs") end)
    flush_probe(client)

    event = RunStore.publish(run.id, "trace", %{text: "persisted"})
    assert Enum.any?(RunStore.events(run.id), &(&1.id == event.id and &1.seq == event.seq))

    observed = await_event(client, "runs", "event")
    assert get_in(observed, ["args", Access.at(0), "id"]) == event.id
    assert get_in(observed, ["args", Access.at(0), "seq"]) == event.seq

    assert get_in(observed, ["args", Access.at(0), "payload_json"]) ==
             Jason.encode!(%{text: "persisted"})

    1..40
    |> Task.async_stream(
      fn value -> RunStore.publish(run.id, "trace", %{value: value}) end,
      max_concurrency: 8,
      ordered: false,
      timeout: 5_000
    )
    |> Enum.each(fn result ->
      assert {:ok, event} = result
      assert event.run_id == run.id
    end)

    observed_sequences =
      Enum.map(1..40, fn _ ->
        event = await_event(client, "runs", "event")
        get_in(event, ["args", Access.at(0), "seq"])
      end)

    assert observed_sequences == Enum.to_list(3..42)

    Events.disconnect_user(1)
    assert await_disconnect(client, "vault")
    assert await_disconnect(client, "runs")
    assert eventually(fn -> Hub.room_members("user:1", "/vault") == [] end)
    assert eventually(fn -> Hub.room_members("user:1", "/runs") == [] end)
  end

  defp linked_chat do
    source = Store.create_vault(1, %{name: "Source"})

    source_channel =
      Store.create_note(source.id, 1, %{title: "Room", content: "cascade://chat-channel"})

    local = Store.create_vault(2, %{name: "Local"})

    local_channel =
      Store.create_note(local.id, 2, %{title: "Mirror", content: "cascade://chat-channel"})

    assert {:ok, _route} =
             Channel.link(source.id, source_channel.id, local.id, local_channel.id, 1)

    {source, source_channel, local, local_channel}
  end

  defp token(id, username), do: Token.sign_user(%{id: id, username: username, auth_version: 0})

  defp http_json(method, url, authorization, body \\ nil) do
    headers = [
      {~c"authorization", String.to_charlist(authorization)},
      {~c"content-type", ~c"application/json"}
    ]

    request =
      if is_nil(body) do
        {String.to_charlist(url), headers}
      else
        {String.to_charlist(url), headers, ~c"application/json",
         body |> Jason.encode!() |> String.to_charlist()}
      end

    {:ok, {{_version, status, _reason}, _response_headers, response_body}} =
      :httpc.request(method, request, [], body_format: :binary)

    {status, Jason.decode!(response_body)}
  end

  defp open_probe(target, token, label) do
    port =
      Port.open(
        {:spawn_executable, System.find_executable("node")},
        [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          args: [@probe, target, token, label],
          line: 65_536
        ]
      )

    assert %{"type" => "ready"} = receive_probe(port, 10_000)
    port
  end

  defp close_on_exit(ports) do
    on_exit(fn ->
      Enum.each(ports, &close_probe/1)
    end)
  end

  defp close_probe(port) do
    if Port.info(port) do
      Port.command(port, Jason.encode!(%{action: "close"}) <> "\n")
      await_probe_exit(port, System.monotonic_time(:millisecond) + 2_000)
    end
  end

  defp await_probe_exit(port, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {^port, {:exit_status, _status}} -> :ok
      {^port, {:data, _line}} -> await_probe_exit(port, deadline)
    after
      remaining ->
        if Port.info(port), do: Port.close(port)
        :ok
    end
  end

  defp join_vault(port, vault_id, user_id) do
    command(port, "vault", "joinVault", [vault_id])
    assert eventually(fn -> joined?("vault:#{vault_id}", user_id) end)
  end

  defp join_chat(port, local_channel_id, source_channel_id, user_id) do
    command(port, "vault", "joinChatChannel", [local_channel_id])
    assert eventually(fn -> joined?("chat:#{source_channel_id}", user_id) end)
  end

  defp command(port, namespace, event, args) do
    id = System.unique_integer([:positive])

    Port.command(
      port,
      Jason.encode!(%{
        action: "emit",
        namespace: namespace,
        event: event,
        args: args,
        id: id
      }) <> "\n"
    )

    assert %{"type" => "command", "id" => ^id} =
             receive_matching(port, &(&1["type"] == "command" and &1["id"] == id), 5_000)
  end

  defp disconnect_namespace(port, namespace) do
    id = System.unique_integer([:positive])

    Port.command(
      port,
      Jason.encode!(%{action: "disconnect", namespace: namespace, id: id}) <> "\n"
    )

    assert %{"type" => "command", "id" => ^id} =
             receive_matching(port, &(&1["type"] == "command" and &1["id"] == id), 5_000)
  end

  defp await_event(port, namespace, event) do
    receive_matching(
      port,
      &(&1["type"] == "event" and &1["namespace"] == namespace and &1["event"] == event),
      5_000
    )
  end

  defp await_presence(port, online) do
    receive_matching(
      port,
      fn message ->
        message["type"] == "event" and message["event"] == "vault:chatPresence" and
          get_in(message, ["args", Access.at(0), "online"]) == online
      end,
      5_000
    )
  end

  defp await_disconnect(port, namespace) do
    receive_matching(
      port,
      &(&1["type"] == "disconnect" and &1["namespace"] == namespace),
      5_000
    )
  end

  defp receive_matching(port, predicate, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_receive_matching(port, predicate, deadline)
  end

  defp do_receive_matching(port, predicate, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    case receive_probe(port, remaining) do
      %{} = message ->
        if predicate.(message), do: message, else: do_receive_matching(port, predicate, deadline)

      nil ->
        flunk("Socket.IO probe did not emit the expected event")
    end
  end

  defp receive_probe(port, timeout) do
    receive do
      {^port, {:data, {:eol, line}}} -> decode_probe(line)
      {^port, {:data, {:noeol, line}}} -> decode_probe(line)
      {^port, {:exit_status, status}} -> flunk("Socket.IO probe exited early with #{status}")
    after
      timeout -> nil
    end
  end

  defp decode_probe(line) do
    case Jason.decode(line) do
      {:ok, message} -> message
      {:error, _} -> flunk("Socket.IO probe emitted non-JSON output: #{line}")
    end
  end

  defp flush_probe(port) do
    receive do
      {^port, {:data, _line}} -> flush_probe(port)
    after
      50 -> :ok
    end
  end

  defp joined?(room, user_id, namespace \\ "/vault") do
    Hub.room_members(room, namespace)
    |> Enum.any?(&(Hub.user_id_for_session(&1, namespace) == user_id))
  end

  defp presence_dispatcher_idle? do
    stats = PresenceDispatcher.stats()
    stats.active == 0 and stats.pending == 0 and stats.queued == 0
  end

  defp eventually_joined?(room, user_id), do: eventually(fn -> joined?(room, user_id) end, 20)

  defp eventually(fun, attempts \\ 100)
  defp eventually(_fun, 0), do: false

  defp eventually(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(20)
      eventually(fun, attempts - 1)
    end
  end

  defp stringify(map), do: map |> Jason.encode!() |> Jason.decode!()

  defp reset_database do
    for table <-
          ~w(run_events delegated_runs runs community_note_activity community_read_state direct_message_channels user_dm_vaults user_blocks vault_join_requests vault_bans community_reports chat_note_grants chat_channel_settings vault_agent_exclusions chat_agent_members chat_channel_links chat_messages work_item_dependencies work_item_runs work_item_reviews work_items vault_agents note_versions note_links note_tags tags notes folders vault_members vaults registration_invites_used users) do
      if SQL.table_exists?(table), do: SQL.exec("DELETE FROM #{table}")
    end

    File.rm_rf!(Store.vaults_base_dir())
  end

  defp available_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, port} = :inet.port(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  defp collect_presence_queries(queries) do
    receive do
      {:initial_presence_query, query} -> collect_presence_queries([query | queries])
    after
      50 -> Enum.reverse(queries)
    end
  end
end
