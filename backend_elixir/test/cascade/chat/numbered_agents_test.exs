defmodule Cascade.Chat.NumberedAgentsTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages, NumberedAgents}
  alias Cascade.Content.Store
  alias Cascade.Missions.Dispatches

  setup do
    fixture = Cascade.TestHelpers.owner_vault("numbered")

    channel =
      Store.create_note(fixture.vault_id, fixture.user_id, %{
        title: "Chat",
        content: "cascade://chat-channel"
      })

    {:ok, profile} =
      Agents.upsert_identity(fixture.user_id, fixture.vault_id, %{
        agentId: "codex",
        mention: "codex",
        displayName: "Codex",
        model: "base-model",
        contextPrompt: "base instructions"
      })

    {:ok, base} =
      Agents.add_to_channel(fixture.user_id, fixture.vault_id, channel.id, profile.id, %{
        reasoningEffort: "high",
        priorityServiceTier: true,
        yolo: true
      })

    {:ok, Map.merge(fixture, %{channel: channel, base: base})}
  end

  test "original numbered profile owns its prefix, except suffix zero", f do
    {:ok, profile} =
      Agents.upsert_identity(f.user_id, f.vault_id, %{
        agentId: "codex",
        mention: "codex2",
        displayName: "Other",
        model: "other-model"
      })

    {:ok, original2} = Agents.add_to_channel(f.user_id, f.vault_id, f.channel.id, profile.id)

    {:ok, members} =
      NumberedAgents.ensure(f.user_id, f.channel.id, "@codex2 @codex3 @codex20 @codex22 @codex29")

    by_name = Map.new(members, &{&1.mention, &1})
    assert by_name["codex2"].id == original2.id
    assert by_name["codex3"].instanceOf == f.base.vaultAgentId
    assert by_name["codex20"].instanceOf == f.base.vaultAgentId
    assert by_name["codex22"].instanceOf == original2.vaultAgentId
    assert by_name["codex22"].model == "other-model"
    assert by_name["codex29"].instanceOf == original2.vaultAgentId
    assert {:error, message} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex21 hello")
    assert message =~ "unavailable"
  end

  test "generated codex2 does not reserve codex21 through codex29", f do
    {:ok, members} =
      NumberedAgents.ensure(f.user_id, f.channel.id, "@codex2 @codex21 @codex22 @codex29")

    for handle <- ~w(codex2 codex21 codex22 codex29) do
      member = Enum.find(members, &(&1.mention == handle))
      assert member.instanceOf == f.base.vaultAgentId
    end

    {:ok, reloaded} = Agents.list_members(f.channel.id, f.user_id)
    assert {:existing, _} = NumberedAgents.resolve("codex21", reloaded)
    assert {:error, _} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex1")
  end

  test "profiles and independent conversations persist across repeated dispatches", f do
    user = %{id: f.user_id, username: f.username}

    {:ok, message} =
      Messages.create(user, f.vault_id, f.channel.id, %{body: "@codex @codex2 @codex3 work"})

    {:ok, dispatches} = Dispatches.create_for_message(f.user_id, f.channel.id, message)
    assert length(dispatches) == 3
    {:ok, members} = Agents.list_members(f.channel.id, f.user_id)
    assert MapSet.size(MapSet.new(members, & &1.conversationId)) == 3
    second = Enum.find(members, &(&1.mention == "codex2"))
    assert second.model == "base-model"
    assert second.reasoningEffort == "high"
    assert second.priorityServiceTier
    assert second.yolo
    assert second.contextPrompt == "base instructions"
    assert {:ok, profile} = Agents.get(f.user_id, f.vault_id, second.vaultAgentId)
    assert profile.identityScope == "vault"

    {:ok, _} =
      Agents.add_to_channel(f.user_id, f.vault_id, f.channel.id, profile.id, %{
        model: "edited-model"
      })

    {:ok, again} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex2 continue")
    reloaded = Enum.find(again, &(&1.mention == "codex2"))
    assert reloaded.id == second.id
    assert reloaded.conversationId == second.conversationId
    assert reloaded.model == "edited-model"
    {:ok, repeated} = Dispatches.create_for_message(f.user_id, f.channel.id, message)
    assert Enum.map(repeated, & &1.id) == Enum.map(dispatches, & &1.id)

    assert SQL.one("SELECT count(*) FROM chat_agent_instances WHERE base_identity_id=?", [
             f.base.vaultAgentId
           ]) == [2]
  end

  test "simultaneous first mentions create one durable profile", f do
    results =
      1..4
      |> Enum.map(fn _ ->
        Task.async(fn -> NumberedAgents.ensure(f.user_id, f.channel.id, "@codex22") end)
      end)
      |> Enum.map(&Task.await(&1, 10_000))

    ids =
      Enum.map(results, fn {:ok, members} -> Enum.find(members, &(&1.mention == "codex22")).id end)

    assert length(Enum.uniq(ids)) == 1
  end

  test "new original displaces generated names without inheriting their histories", f do
    {:ok, generated} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex2 @codex21 @codex22")
    old = Enum.filter(generated, & &1[:instanceOf])
    user = %{id: f.user_id, username: f.username}
    old_second = Enum.find(old, &(&1.mention == "codex2"))

    {:ok, message} =
      Messages.create(user, f.vault_id, f.channel.id, %{body: "@codex2 old conversation"})

    {:ok, [old_dispatch]} = Dispatches.create_for_message(f.user_id, f.channel.id, message)

    {:ok, original} =
      Agents.upsert_identity(f.user_id, f.vault_id, %{
        agentId: "codex",
        mention: "codex2",
        displayName: "New original",
        model: "new-model"
      })

    {:ok, fresh} = Agents.add_to_channel(f.user_id, f.vault_id, f.channel.id, original.id)
    assert fresh.vaultAgentId != old_second.vaultAgentId
    assert fresh.id != old_second.id
    assert fresh.conversationId != old_second.conversationId
    assert fresh.instanceOf == nil
    {:ok, members} = Agents.list_members(f.channel.id, f.user_id)

    for prior <- old do
      moved = Enum.find(members, &(&1.id == prior.id))
      refute moved.mention in ~w(codex2 codex21 codex22)
      assert moved.conversationId == prior.conversationId
      assert moved.vaultAgentId == prior.vaultAgentId
    end

    assert SQL.one("SELECT registration_id FROM chat_agent_dispatches WHERE id=?", [
             old_dispatch.id
           ]) == [old_second.id]

    assert {:error, _} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex21")
    {:ok, new_members} = NumberedAgents.ensure(f.user_id, f.channel.id, "@codex22")
    new_second = Enum.find(new_members, &(&1.mention == "codex22"))
    assert new_second.instanceOf == fresh.vaultAgentId
    assert new_second.model == "new-model"
    refute new_second.conversationId in Enum.map(old, & &1.conversationId)
  end

  test "HTTP first mention returns a persistent member and profile creation starts fresh", f do
    token = Cascade.Auth.Token.sign_user(%{id: f.user_id, username: f.username, auth_version: 0})

    request = fn method, path, body ->
      Cascade.TestHelpers.json_conn(method, path, body, token)
      |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))
    end

    response =
      request.(:post, "/api/vaults/#{f.vault_id}/channels/#{f.channel.id}/messages", %{
        body: "@codex2 begin"
      })

    assert response.status == 201, response.resp_body
    body = Jason.decode!(response.resp_body)
    generated = Enum.find(body["agents"], &(&1["mention"] == "codex2"))
    assert generated["instanceOf"] == f.base.vaultAgentId
    assert length(body["dispatches"]) == 1

    response =
      request.(:put, "/api/vaults/#{f.vault_id}/vault-agents", %{
        agentId: "codex",
        mention: "codex2",
        displayName: "Original 2"
      })

    assert response.status == 200, response.resp_body
    original = Jason.decode!(response.resp_body)["agent"]
    assert original["id"] != generated["vaultAgentId"]
    assert original["instanceOf"] == nil

    response =
      request.(:post, "/api/vaults/#{f.vault_id}/channels/#{f.channel.id}/messages", %{
        body: "@codex2 fresh"
      })

    assert response.status == 201, response.resp_body
    fresh = Enum.find(Jason.decode!(response.resp_body)["agents"], &(&1["mention"] == "codex2"))
    assert fresh["conversationId"] != generated["conversationId"]
    assert :ok = Cascade.Chat.Schema.ensure!()
    {:ok, profiles} = Agents.list_vault(f.user_id, f.vault_id)

    assert Enum.find(profiles, &(&1.id == generated["vaultAgentId"])).instanceOf ==
             f.base.vaultAgentId
  end
end
