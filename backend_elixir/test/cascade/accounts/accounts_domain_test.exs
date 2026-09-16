defmodule Cascade.AccountsDomainTest do
  use ExUnit.Case, async: false

  import Cascade.TestHelpers

  alias Cascade.Accounts.{
    AndroidBattery,
    CommunityActivity,
    DirectMessages,
    Moderation,
    PublicVaults,
    SQL,
    VaultMembers
  }

  alias Cascade.Auth.Token
  alias Cascade.Content.Store
  alias Cascade.Realtime.PresenceDispatcher

  @node_vault_member_columns [
    ["vault_id", "TEXT", 1, nil, 1],
    ["user_id", "INTEGER", 1, nil, 2],
    ["role", "TEXT", 1, "'editor'", 0],
    ["invited_by", "INTEGER", 0, nil, 0],
    ["created_at", "TEXT", 1, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", 0]
  ]

  @node_vault_member_foreign_keys [
    ["invited_by", "users", "id", "NO ACTION", "NO ACTION", "NONE"],
    ["user_id", "users", "id", "NO ACTION", "CASCADE", "NONE"],
    ["vault_id", "vaults", "id", "NO ACTION", "CASCADE", "NONE"]
  ]

  @router_options CascadeWeb.AccountRouter.init(require_invite: false)

  setup do
    root =
      Path.join(
        System.tmp_dir!(),
        "cascade-elixir-accounts-#{System.unique_integer([:positive])}"
      )

    previous_root = System.get_env("CASCADE_VAULTS_BASE_DIR")
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)

    reset_database()

    SQL.exec("""
    INSERT INTO users (id,username,password_hash,display_name,avatar_url,auth_version) VALUES
      (1,'alice','x','Alice','',0),(2,'bob','x','Bob','',0),(3,'carol','x','Carol','',0)
    """)

    on_exit(fn ->
      File.rm_rf!(root)

      if previous_root,
        do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous_root),
        else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)

    :ok
  end

  test "semantic schema upgrade converts legacy admin roles and repairs creator ownership" do
    vault = Store.create_vault(1, %{name: "Legacy"})
    SQL.exec("DROP TABLE vault_members")

    SQL.exec("""
    CREATE TABLE vault_members (
      vault_id TEXT NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL DEFAULT 'editor'
        CHECK(role IN ('owner','admin','editor','viewer')),PRIMARY KEY(vault_id,user_id)
    )
    """)

    SQL.exec(
      "INSERT INTO vault_members (rowid,vault_id,user_id,role) VALUES (39,?,1,'admin'),(40,?,2,'admin'),(41,?,3,'viewer')",
      [vault.id, vault.id, vault.id]
    )

    Cascade.Accounts.Schema.ensure_vault_members!()

    assert VaultMembers.role(vault.id, 1) == "owner"
    assert VaultMembers.role(vault.id, 2) == "editor"
    assert VaultMembers.role(vault.id, 3) == "viewer"

    assert [41] ==
             SQL.one("SELECT rowid FROM vault_members WHERE vault_id=? AND user_id=3", [vault.id])

    definition = SQL.table_sql("vault_members")
    assert definition =~ "'owner','editor','viewer'"
    refute definition =~ "'admin'"
    assert_node_vault_members_schema()
  end

  test "fresh and existing Node vault membership schemas remain exact and preserve rows" do
    vault = Store.create_vault(1, %{name: "Node memberships"})
    SQL.exec("DROP TABLE vault_members")

    Cascade.Accounts.Schema.ensure_vault_members!()
    assert_node_vault_members_schema()

    SQL.exec(
      "INSERT OR REPLACE INTO vault_members(vault_id,user_id,role,invited_by,created_at) VALUES(?,2,'viewer',1,'2026-08-10T13:00:00.000Z')",
      [vault.id]
    )

    Cascade.Accounts.Schema.ensure_vault_members!()
    assert_node_vault_members_schema()

    assert ["viewer", 1, "2026-08-10T13:00:00.000Z"] ==
             SQL.one(
               "SELECT role,invited_by,created_at FROM vault_members WHERE vault_id=? AND user_id=2",
               [vault.id]
             )

    assert [] = SQL.all("PRAGMA foreign_key_check(vault_members)")
  end

  test "DM identity is pair-idempotent, isolated in dedicated vaults, and blocked without enumeration" do
    opened = DirectMessages.open(1, "@Bob")
    assert {:ok, first} = opened
    assert first.created
    assert DirectMessages.direct_message_vault?(first.vaultId)
    assert DirectMessages.vault_holds_direct_messages?(first.vaultId)
    assert DirectMessages.direct_message_channel?(first.channelId)
    assert Store.list_vaults(1) == []
    assert Store.list_vaults(2) == []

    assert {:ok, reverse} = DirectMessages.open(2, "alice")
    refute reverse.created
    assert reverse.user.username == "alice"
    assert reverse.channelId != first.channelId
    assert length(DirectMessages.list(1)) == 1
    assert length(DirectMessages.list(2)) == 1

    assert {:ok, block} = DirectMessages.block(2, 1)
    assert block.username == "alice"
    assert {:error, "This user is not accepting direct messages"} = DirectMessages.open(1, "bob")
    assert {:error, "Unblock @alice to start a direct message"} = DirectMessages.open(2, "alice")

    assert {:error, "Direct message unavailable"} =
             DirectMessages.assert_send_allowed(first.channelId, 1)

    assert {:error, "This user is not accepting direct messages"} =
             DirectMessages.open(1, "does_not_exist")
  end

  test "direct-message mirror link insertion invalidates a cache warmed after note creation" do
    create_note = fn vault_id, user_id, title, content ->
      note = Store.create_note(vault_id, user_id, %{title: title, content: content})

      if String.contains?(content, "shared_from=") do
        generation = PresenceDispatcher.user_channels_generation()

        assert :ok =
                 PresenceDispatcher.remember_user_channels(
                   99_999,
                   [["stale", "stale"]],
                   generation
                 )
      end

      note
    end

    assert {:ok, _conversation} = DirectMessages.open(1, "bob", create_note: create_note)
    assert PresenceDispatcher.cached_user_channels(99_999) == :miss
  end

  test "public discovery normalizes topics, sanitizes previews, and honors request plus ban gates" do
    vault = Store.create_vault(1, %{name: "Community"})

    home =
      Store.create_note(vault.id, 1, %{
        title: "Welcome",
        content: "file:///home/alice/private\n:::private\nsecret\n:::"
      })

    assert {:ok, settings} =
             PublicVaults.update(vault.id, 1, %{
               "visibility" => "public",
               "topics" => [" Elixir ", "ＥＬＩＸＩＲ", "OTP"],
               "homeNoteId" => home.id,
               "joinPolicy" => "request"
             })

    assert settings.topics == ["elixir", "otp"]
    assert [summary] = PublicVaults.list(2, query: "community")
    assert summary.id == vault.id
    detail = PublicVaults.detail(vault.id, 2)
    assert detail.homeNote.preview =~ "[path omitted]"
    refute detail.homeNote.preview =~ "secret"

    assert {:ok, %{requestStatus: "pending"}} = PublicVaults.join(vault.id, 2)
    [request] = elem(PublicVaults.join_requests(vault.id, 1), 1)
    assert {:ok, %{role: "viewer"}} = PublicVaults.review_join(vault.id, request.id, 1, "approve")

    assert {:ok, _ban} = Moderation.ban(vault.id, 1, 2, "spam")
    assert VaultMembers.role(vault.id, 2) == nil
    assert {:error, "This user is banned from this vault"} = PublicVaults.join(vault.id, 2)
  end

  test "reports remain anonymous to vault owners, attributable to server owner, and can unlist" do
    vault = Store.create_vault(1, %{name: "Listed"})

    assert {:ok, _} =
             PublicVaults.update(vault.id, 1, %{"visibility" => "public", "topics" => ["open"]})

    assert {:ok, report} =
             Moderation.create_report(%{
               vault_id: vault.id,
               reporter_user_id: 2,
               target_type: "vault",
               target_id: vault.id,
               reason: "other",
               detail: "Review"
             })

    assert {:ok, global} = Moderation.list_global_reports(1)
    assert hd(global).reporterUsername == "bob"
    assert {:error, "Owner only"} = Moderation.list_global_reports(2)

    assert {:ok, %{unlistedVaultId: vault_id, report: reviewed}} =
             Moderation.review_global_report(report.id, 1, "unlist")

    assert vault_id == vault.id
    assert reviewed.status == "resolved"
    assert PublicVaults.settings(vault.id).visibility == "private"
  end

  test "community inbox canonicalizes mirrors, bounds counts, and shares read state" do
    source = Store.create_vault(1, %{name: "Source"})
    local = Store.create_vault(2, %{name: "Bob"})

    source_channel =
      Store.create_note(source.id, 1, %{title: "Shared", content: "cascade://chat-channel"})

    local_channel =
      Store.create_note(local.id, 2, %{
        title: "Mirror",
        content: "cascade://chat-channel\nshared_from=#{source_channel.id}"
      })

    SQL.exec(
      """
      INSERT INTO chat_channel_links
        (local_channel_id,local_vault_id,source_channel_id,source_vault_id,created_by,created_at)
      VALUES (?,?,?,?,1,'2020-01-01T00:00:00Z')
      """,
      [local_channel.id, local.id, source_channel.id, source.id]
    )

    SQL.exec(
      """
      INSERT INTO chat_messages
        (id,channel_id,vault_id,author,body,status,created_at,activity_at,actor_user_id)
      VALUES ('m1',?,?, 'alice','hello @bob','complete','2099-01-01T00:00:00Z','2099-01-01T00:00:00Z',1)
      """,
      [source_channel.id, source.id]
    )

    updates = CommunityActivity.list(%{id: 2, username: "bob"})
    assert updates.counts.total == 1
    assert updates.counts.byTarget[local_channel.id] == 1
    assert [%{items: [%{kind: "mention", sourceId: source_id}]}] = updates.groups
    assert source_id == source_channel.id

    # Joining the source vault changes the canonical inbox target, but the
    # already-open linked tab must retain a count so the client marks it read.
    assert {:ok, _} = VaultMembers.add(source.id, 1, 2, "editor")
    updates = CommunityActivity.list(%{id: 2, username: "bob"})
    assert updates.counts.total == 1
    assert updates.counts.byTarget[source_channel.id] == 1
    assert updates.counts.byTarget[local_channel.id] == 1
    assert map_size(updates.counts.byTarget) == 2
    assert Enum.sum(Map.values(updates.counts.byVault)) == 1
    assert [%{items: [_]}] = updates.groups

    assert CommunityActivity.mark_read(2, local_channel.id, "2100-01-01T00:00:00Z")
    assert CommunityActivity.list(%{id: 2, username: "bob"}).counts.total == 0
  end

  test "battery validation is user-scoped and purges samples beyond 30 days" do
    valid = %{
      "sessionId" => "session-a",
      "reason" => "interval",
      "foreground" => true,
      "capturedAt" => 1000,
      "elapsedRealtimeMs" => 900,
      "processCpuMs" => 12,
      "uidRxBytes" => -1,
      "uidTxBytes" => 2,
      "powerSave" => false,
      "levelPercent" => 75,
      "charging" => true
    }

    assert {:ok, sample} = AndroidBattery.parse(valid)
    assert :ok = AndroidBattery.record(1, sample)
    SQL.exec("UPDATE android_battery_samples SET received_at=datetime('now','-31 days')")
    assert :ok = AndroidBattery.record(2, %{sample | sessionId: "session-b"})
    assert AndroidBattery.list(1, 30) == []
    assert [%{userId: 2, charging: true}] = AndroidBattery.list(2, 7)

    assert {:error, "levelPercent is out of range"} =
             AndroidBattery.parse(Map.put(valid, "levelPercent", 101))
  end

  test "mountable router preserves authenticated response shapes and anti-enumeration statuses" do
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    settings = request(:get, "/api/me/dm-settings", nil, token)
    assert settings.status == 200
    assert Jason.decode!(settings.resp_body) == %{"allowDirectMessages" => true}

    unknown = request(:post, "/api/direct-messages", %{username: "nobody"}, token)
    assert unknown.status == 403

    assert Jason.decode!(unknown.resp_body) == %{
             "error" => "This user is not accepting direct messages"
           }

    battery = request(:post, "/api/diagnostics/android-battery", %{"sessionId" => "bad"}, token)
    assert battery.status == 400
    assert Jason.decode!(battery.resp_body) == %{"error" => "Invalid reason"}
  end

  test "route catalog exposes every account and community contract exactly once" do
    routes = CascadeWeb.AccountRoutes.catalog()
    assert length(routes) == 45
    assert length(Enum.uniq(routes)) == 45
    assert {"POST", "/api/auth/register"} in routes
    assert {"DELETE", "/api/vaults/:id/members/:user_id"} in routes
    assert {"POST", "/api/direct-messages"} in routes
    assert {"POST", "/api/product-feedback"} in routes
    assert {"GET", "/api/diagnostics/android-battery"} in routes
  end

  defp request(method, path, body, token) do
    json_conn(method, path, body, token)
    |> CascadeWeb.AccountRouter.call(@router_options)
  end

  defp reset_database do
    for table <- ~w(
      android_battery_samples community_note_activity community_read_state content_reports vault_bans
      public_vault_join_requests direct_message_channels user_dm_vaults user_blocks user_dm_settings
      chat_messages chat_agent_members chat_channel_links vault_agents note_versions note_links note_tags
      tags notes folders vault_members vaults registration_invites_used users
    ) do
      if SQL.table_exists?(table), do: SQL.exec("DELETE FROM #{table}")
    end

    File.rm_rf!(Store.vaults_base_dir())
  end

  defp assert_node_vault_members_schema do
    actual =
      SQL.all("PRAGMA table_info(vault_members)")
      |> Enum.map(fn [_cid | definition] -> definition end)

    assert actual == @node_vault_member_columns
    assert SQL.table_sql("vault_members") =~ "CHECK(role IN ('owner','editor','viewer'))"

    foreign_keys =
      SQL.all("PRAGMA foreign_key_list(vault_members)")
      |> Enum.map(fn [_id, _seq, target, source, destination, on_update, on_delete, match] ->
        [source, target, destination, on_update, on_delete, match]
      end)
      |> Enum.sort()

    assert foreign_keys == Enum.sort(@node_vault_member_foreign_keys)
  end
end
