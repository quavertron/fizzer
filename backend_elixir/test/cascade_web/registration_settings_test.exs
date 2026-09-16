defmodule CascadeWeb.RegistrationSettingsTest do
  use ExUnit.Case, async: false
  import Cascade.TestHelpers
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.Agents

  test "SELECT-only exact read, narrow atomic patch, no upsert/default resets or permission widening" do
    ctx = owner_vault("settings")
    token = Token.sign_user(%{id: ctx.user_id, username: ctx.username})
    agent = Token.sign_agent(%{id: ctx.user_id, username: ctx.username})
    base = "/api/vaults/#{ctx.vault_id}"
    created = request(:post, base <> "/notes", %{title: "Settings", content: "cascade://chat-channel"}, token)
    channel = Jason.decode!(created.resp_body)["note"]["id"]
    {:ok, identity} = Agents.upsert_identity(ctx.user_id, ctx.vault_id, %{agentId: "hermes", mention: "along", hermesProfile: "along"})
    {:ok, member} = Agents.add_to_channel(ctx.user_id, ctx.vault_id, channel, identity.id, %{model: "old-model", contextPrompt: "keep me", yolo: false, ambientGroupChat: false})
    path = base <> "/channels/#{channel}/agents/#{member.id}/settings-v1?vaultAgentId=#{identity.id}&hermesProfile=along"
    before = tables()
    SQL.exec("PRAGMA query_only=ON")
    read = try do
      response = request(:get, path, nil, token)
      assert response.status == 200
      execution_path = base <> "/channels/#{channel}/agents/#{member.id}/execution-v1"
      execution_response = request(:get, execution_path, nil, token)
      assert execution_response.status == 200
      execution = Jason.decode!(execution_response.resp_body)
      assert execution["contract"] == "registration_execution_select_only_v1"
      assert execution["ownerUserId"] == ctx.user_id
      assert execution["yolo"] == false
      assert request(:get, String.replace(execution_path, member.id, "missing"), nil, token).status == 404
      assert tables() == before
      Jason.decode!(response.resp_body)
    after
      SQL.exec("PRAGMA query_only=OFF")
    end
    assert read["settings"]["model"] == "old-model"
    patch = %{expectedRevision: read["revision"], patch: %{model: "new-model"}}
    assert request(:patch, path, patch, agent).status == 403
    assert request(:patch, path, %{patch | patch: %{yolo: true}}, token).status == 400
    assert request(:patch, path, %{patch | expectedRevision: "wrong"}, token).status == 409
    assert tables() == before
    updated = request(:patch, path, patch, token)
    assert updated.status == 200
    after_read = request(:get, path, nil, token) |> Map.fetch!(:resp_body) |> Jason.decode!()
    assert after_read["settings"] == Map.put(read["settings"], "model", "new-model")
    assert after_read["protected"] == read["protected"]
    assert after_read["registration"] == read["registration"]
    assert after_read["revision"] != read["revision"]
    assert request(:patch, path, patch, token).status == 409
    assert request(:get, String.replace(path, "=along", "=wrong"), nil, token).status == 404
    assert request(:patch, String.replace(path, member.id, "missing"), patch, token).status == 404
    assert SQL.one("SELECT COUNT(*) FROM chat_agent_members WHERE vault_agent_id=?", [identity.id]) == [1]
    # Only the exact membership table can change; no identity writes or scheduler/dispatch effects.
    assert Map.delete(tables(), "chat_agent_members") == Map.delete(before, "chat_agent_members")
  end

  defp tables do
    for [table] <- SQL.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"), into: %{} do
      {table, SQL.all("SELECT * FROM \"#{table}\"") |> Enum.sort()}
    end
  end
  defp request(method, path, body, token), do: json_conn(method, path, body, token) |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
end
