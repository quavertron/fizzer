defmodule Cascade.Chat.RegistrationSettings do
  @moduledoc "Exact owner registration settings; SELECT-only read, narrow transactional revision patch."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.RegistrationLookup
  @columns %{"model" => "model", "reasoningEffort" => "reasoning_effort", "contextPrompt" => "context_prompt", "finalReplyOnly" => "final_reply_only"}

  def execution(user_id, vault_id, channel_id, registration_id) do
    with {:ok, route} <- Cascade.Chat.Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [id, identity, agent, profile, model, prompt, cwd, yolo] <- SQL.one("SELECT m.id,va.id,m.agent_id,va.hermes_profile,m.model,m.context_prompt,m.cwd,m.yolo FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=? AND m.channel_id=? AND m.vault_id=? AND va.owner_user_id=? AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now')) AND NOT EXISTS(SELECT 1 FROM vault_agent_exclusions x WHERE x.vault_id=m.vault_id AND x.vault_agent_id=va.id)", [registration_id, route.sourceChannelId, route.sourceVaultId, user_id]) do
      {:ok, %{contract: "registration_execution_select_only_v1", registrationId: id, vaultAgentId: identity, ownerUserId: user_id, vaultId: vault_id, channelId: channel_id, agentId: agent, hermesProfile: profile, model: model, contextPrompt: prompt, cwd: cwd, yolo: yolo == 1, missionsEnabled: Cascade.Chat.Delegation.enabled?(id)}}
    else
      _ -> {:error, 404, "Registration not found"}
    end
  end

  def get(user_id, vault_id, channel_id, registration_id, params) do
    with {:ok, binding} <- RegistrationLookup.get(user_id, vault_id, channel_id, registration_id, params),
         [model, effort, prompt, final, yolo, taggable, reply, orchestrator, pingable, ambient, suggestions, cwd, conversation] <-
           SQL.one("SELECT model,reasoning_effort,context_prompt,final_reply_only,yolo,taggable_by_agents,reply_to_every_message,orchestrator,pingable_by_others,ambient_group_chat,next_step_suggestions,cwd,conversation_id FROM chat_agent_members WHERE id=? AND channel_id=?", [binding.id, binding.sourceChannelId]) do
      settings = %{"model" => model || "", "reasoningEffort" => effort || "", "contextPrompt" => prompt || "", "finalReplyOnly" => final == 1}
      protected = %{missionsEnabled: Cascade.Chat.Delegation.enabled?(registration_id), yolo: yolo == 1, taggableByAgents: taggable == 1, replyToEveryMessage: reply == 1, orchestrator: orchestrator == 1, pingableByOthers: pingable == 1, ambientGroupChat: ambient == 1, nextStepSuggestions: suggestions == 1, cwd: cwd, conversationId: conversation}
      revision = :crypto.hash(:sha256, :erlang.term_to_binary({binding, settings, protected})) |> Base.encode16(case: :lower)
      {:ok, %{contract: "registration_settings_v1", registration: binding, settings: settings, protected: protected, revision: revision}}
    else
      _ -> {:error, 404, "Registration not found"}
    end
  end

  def update(user_id, vault_id, channel_id, registration_id, params, input) do
    with true <- is_map(input) and Enum.sort(Map.keys(input)) == ["expectedRevision", "patch"],
         patch when is_map(patch) and map_size(patch) > 0 <- input["patch"],
         true <- Enum.all?(patch, &valid_field/1) do
      SQL.transaction(fn ->
        with {:ok, before} <- get(user_id, vault_id, channel_id, registration_id, params),
             true <- before.revision == input["expectedRevision"] do
          # Fixed column vocabulary, never upsert or materialize; preserve every unrequested field.
          pairs = Enum.sort(patch)
          setters = Enum.map_join(pairs, ",", fn {key, _} -> Map.fetch!(@columns, key) <> "=?" end)
          values = Enum.map(pairs, fn {_, value} -> if is_boolean(value), do: if(value, do: 1, else: 0), else: value end)
          SQL.exec("UPDATE chat_agent_members SET " <> setters <> ",updated_at=datetime('now') WHERE id=? AND channel_id=?", values ++ [before.registration.id, before.registration.sourceChannelId])
          get(user_id, vault_id, channel_id, registration_id, params)
        else
          false -> {:error, 409, "Settings revision conflict"}
          error -> error
        end
      end)
    else
      _ -> {:error, 400, "Invalid settings patch"}
    end
  end

  defp valid_field({"finalReplyOnly", value}), do: is_boolean(value)
  defp valid_field({"reasoningEffort", value}), do: value in ["", "low", "medium", "high", "xhigh"]
  defp valid_field({"model", value}), do: is_binary(value) and byte_size(value) > 0 and byte_size(value) <= 160 and String.trim(value) == value
  defp valid_field({"contextPrompt", value}), do: is_binary(value) and byte_size(value) <= 8000
  defp valid_field(_), do: false
end
