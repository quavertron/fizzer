defmodule Cascade.Chat.RegistrationLookup do
  @moduledoc "Owner-bound SELECT-only registration lookup; never repairs or expires records."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Channel

  def get(user_id, vault_id, channel_id, registration_id, params) do
    with identity when is_binary(identity) and identity != "" <- params["vaultAgentId"],
         profile when is_binary(profile) and profile != "" <- params["hermesProfile"],
         {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id) do
      rows =
        SQL.all(
          """
          SELECT m.id,va.id,va.vault_id,va.owner_user_id,va.agent_id,va.hermes_profile,
            va.avatar_url,m.avatar_url
          FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
          WHERE m.channel_id=? AND m.vault_id=? AND va.owner_user_id=?
            AND va.id=? AND va.hermes_profile=? AND (?='resolve' OR m.id=?)
            AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now'))
            AND NOT EXISTS(SELECT 1 FROM vault_agent_exclusions x
              WHERE x.vault_id=m.vault_id AND x.vault_agent_id=va.id)
          """,
          [
            route.sourceChannelId,
            route.sourceVaultId,
            user_id,
            identity,
            profile,
            registration_id,
            registration_id
          ]
        )

      case rows do
        [[id, identity, home, owner, agent, profile, avatar, member_avatar]] ->
          {:ok,
           Map.merge(route, %{
             id: id,
             vaultAgentId: identity,
             vaultId: home,
             ownerUserId: owner,
             agentId: agent,
             hermesProfile: profile,
             identityAvatarUrl: avatar,
             avatarUrl: member_avatar,
             contract: "registration_lookup_select_only_v1"
           })}

        _ ->
          {:error, 404, "Registration not found"}
      end
    else
      _ -> {:error, 404, "Registration not found"}
    end
  end
end
