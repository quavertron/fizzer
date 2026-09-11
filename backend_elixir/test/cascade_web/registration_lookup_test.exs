defmodule CascadeWeb.RegistrationLookupTest do
  use ExUnit.Case, async: false
  import Cascade.TestHelpers
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.Agents

  test "actual authenticated endpoint is SELECT-only, owner/profile bound and never repairs missing or expired identities" do
    ctx = owner_vault("lookup")
    token = Token.sign_user(%{id: ctx.user_id, username: ctx.username})
    agent_token = Token.sign_agent(%{id: ctx.user_id, username: ctx.username})
    base = "/api/vaults/#{ctx.vault_id}"

    note =
      request(
        :post,
        base <> "/notes",
        %{title: "Lookup", content: "cascade://chat-channel"},
        token
      )

    assert note.status == 201
    channel = Jason.decode!(note.resp_body)["note"]["id"]

    {:ok, identity} =
      Agents.upsert_identity(ctx.user_id, ctx.vault_id, %{
        agentId: "hermes",
        mention: "along",
        hermesProfile: "along"
      })

    {:ok, member} = Agents.add_to_channel(ctx.user_id, ctx.vault_id, channel, identity.id, %{})

    {:ok, missing} =
      Agents.upsert_identity(ctx.user_id, ctx.vault_id, %{
        agentId: "hermes",
        mention: "missing",
        hermesProfile: "along"
      })

    {:ok, expired} =
      Agents.upsert_identity(ctx.user_id, ctx.vault_id, %{
        agentId: "hermes",
        mention: "expired",
        hermesProfile: "along"
      })

    {:ok, expired_member} =
      Agents.add_to_channel(ctx.user_id, ctx.vault_id, channel, expired.id, %{})

    SQL.exec(
      "UPDATE vault_agents SET identity_scope='session',expires_at='2000-01-01' WHERE id=?",
      [expired.id]
    )

    path = base <> "/channels/#{channel}/agents/"
    query = "?vaultAgentId=#{identity.id}&hermesProfile=along"
    foreign = owner_vault("lookup-foreign")
    foreign_token = Token.sign_user(%{id: foreign.user_id, username: foreign.username})

    SQL.exec("INSERT INTO vault_members(vault_id,user_id,role) VALUES(?,?,'viewer')", [
      ctx.vault_id,
      foreign.user_id
    ])

    before = snapshot()
    # SQLite rejects even attempted writes, not merely changes visible afterward.
    SQL.exec("PRAGMA query_only=ON")

    try do
      for auth <- [token, agent_token], handle <- [member.id, "resolve"] do
        conn = request(:get, path <> handle <> query, nil, auth)
        assert conn.status == 200
        r = Jason.decode!(conn.resp_body)["registration"]
        assert r["id"] == member.id
        assert r["vaultAgentId"] == identity.id
        assert r["ownerUserId"] == ctx.user_id
        assert r["hermesProfile"] == "along"
        assert r["localVaultId"] == ctx.vault_id
        assert r["sourceChannelId"] == channel
        assert r["identityAvatarUrl"] == ""
        assert r["avatarUrl"] == ""
        refute Map.has_key?(r, "contextPrompt")
      end

      assert request(:get, path <> member.id <> query, nil, nil).status == 401
      assert request(:get, path <> member.id <> query, nil, foreign_token).status == 404
      assert request(:get, path <> member.id, nil, token).status == 404

      assert request(
               :get,
               path <> member.id <> String.replace(query, "=along", "=wrong"),
               nil,
               token
             ).status == 404

      assert request(
               :get,
               path <> member.id <> String.replace(query, identity.id, missing.id),
               nil,
               token
             ).status == 404

      assert request(
               :get,
               path <> "resolve?vaultAgentId=#{missing.id}&hermesProfile=along",
               nil,
               token
             ).status == 404

      assert request(
               :get,
               path <> expired_member.id <> "?vaultAgentId=#{expired.id}&hermesProfile=along",
               nil,
               token
             ).status == 404

      assert request(
               :get,
               String.replace(path, ctx.vault_id, foreign.vault_id) <> member.id <> query,
               nil,
               token
             ).status == 404

      assert request(
               :get,
               String.replace(path, channel, "missing-channel") <> member.id <> query,
               nil,
               token
             ).status == 404

      assert snapshot() == before
    after
      SQL.exec("PRAGMA query_only=OFF")
    end
  end

  defp snapshot do
    for [table] <-
          SQL.all(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          ),
        into: %{} do
      {table, SQL.all("SELECT * FROM \"#{table}\"") |> Enum.sort()}
    end
  end

  defp request(method, path, body, token),
    do: json_conn(method, path, body, token) |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
end
