defmodule Cascade.Chat.Agents do
  @moduledoc "Owner-scoped agent identities and vault/channel membership lifecycle."

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Chat.{Avatars, Channel, Schema}

  @codex_efforts ~w(low medium high xhigh max ultra)
  @claude_efforts ~w(low medium high xhigh max)
  @identity_scopes ~w(vault session)

  def list_vault(user_id, vault_id) do
    if VaultMembers.role(vault_id, user_id) do
      purge_expired_sessions!()

      agents =
        SQL.all(
          """
          SELECT va.id,va.vault_id,va.agent_id,va.display_name,va.avatar_url,va.mention,
            va.model,va.cwd,va.context_prompt,va.hermes_profile,va.hermes_safe_mode,
            va.identity_scope,va.expires_at,
            va.owner_user_id,u.username,va.created_at,va.updated_at
          FROM vault_agents va LEFT JOIN users u ON u.id=va.owner_user_id
          WHERE (
            (
              (va.vault_id=? OR EXISTS(
                SELECT 1 FROM chat_agent_members m
                WHERE m.vault_agent_id=va.id AND m.vault_id=?
              )) AND NOT EXISTS(
                SELECT 1 FROM vault_agent_exclusions x
                WHERE x.vault_id=? AND (x.vault_agent_id=va.id OR x.vault_agent_id=va.imported_from_agent_id)
              )
            ) OR (
              va.owner_user_id=? AND va.vault_id=? AND NOT EXISTS(
                SELECT 1 FROM vault_agent_exclusions x
                WHERE x.vault_id=? AND (x.vault_agent_id=va.id OR x.vault_agent_id=va.imported_from_agent_id)
              )
            )
          ) AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now'))
          ORDER BY va.display_name COLLATE NOCASE,va.mention COLLATE NOCASE
          """,
          [vault_id, vault_id, vault_id, user_id, vault_id, vault_id]
        )
        |> Enum.map(&identity/1)
        |> Enum.map(&Map.put(&1, :channelIds, channel_ids(&1.id, vault_id)))

      {:ok, agents}
    else
      {:error, "Vault not found"}
    end
  end

  @doc "Lists the current user's active identities that are not linked to this vault."
  def list_owned_elsewhere(user_id, vault_id) do
    if VaultMembers.role(vault_id, user_id) do
      purge_expired_sessions!()

      agents =
        SQL.all(
          """
          SELECT va.id,va.vault_id,va.agent_id,va.display_name,va.avatar_url,va.mention,
            va.model,va.cwd,va.context_prompt,va.hermes_profile,va.hermes_safe_mode,
            va.identity_scope,va.expires_at,
            va.owner_user_id,u.username,va.created_at,va.updated_at
          FROM vault_agents va LEFT JOIN users u ON u.id=va.owner_user_id
          WHERE va.owner_user_id=? AND va.vault_id!=?
            AND NOT EXISTS(
              SELECT 1 FROM chat_agent_members m
              WHERE m.vault_agent_id=va.id AND m.vault_id=?
            ) AND NOT EXISTS(
              SELECT 1 FROM vault_agents imported
              WHERE imported.imported_from_agent_id=va.id AND imported.vault_id=?
            ) AND NOT EXISTS(
              SELECT 1 FROM vault_agent_exclusions x
              WHERE x.vault_id=? AND x.vault_agent_id=va.id
            ) AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now'))
          ORDER BY va.display_name COLLATE NOCASE,va.mention COLLATE NOCASE
          """,
          [user_id, vault_id, vault_id, vault_id, vault_id]
        )
        |> Enum.map(&identity/1)

      {:ok, agents}
    else
      {:error, "Vault not found"}
    end
  end

  def list_for_vault(user_id, vault_id) do
    with {:ok, agents} <- list_vault(user_id, vault_id),
         {:ok, my_agents} <- list_owned_elsewhere(user_id, vault_id) do
      {:ok, %{agents: agents, myAgents: my_agents}}
    end
  end

  def get(user_id, vault_id, identity_id) do
    with {:ok, agents} <- list_vault(user_id, vault_id) do
      case Enum.find(agents, &(&1.id == identity_id)) do
        nil -> {:error, "Vault agent not found"}
        agent -> {:ok, agent}
      end
    end
  end

  def upsert_identity(user_id, vault_id, input) do
    source_id = value(input, "sourceAgentId", "") |> to_string() |> String.trim()

    if source_id != "" do
      import_identity(user_id, vault_id, source_id)
    else
      if VaultMembers.role(vault_id, user_id) do
        agent_id = input |> value("agentId", "") |> to_string() |> String.trim()

        id =
          input
          |> value("id", "")
          |> to_string()
          |> String.trim()
          |> nonblank(Ecto.UUID.generate())

        mention = Schema.normalize_mention(value(input, "mention", ""), agent_id)

        existing =
          SQL.one(
            "SELECT owner_user_id,avatar_url,identity_scope,expires_at FROM vault_agents WHERE id=? AND (owner_user_id=? OR vault_id=?)",
            [id, user_id, vault_id]
          )

        cond do
          agent_id == "" ->
            {:error, "agentId is required"}

          existing && hd(existing) not in [nil, user_id] ->
            {:error, "Only the agent owner can edit it"}

          identity_clash?(id, mention, user_id, vault_id) ->
            {:error, "Mention @#{mention} is already used by another agent"}

          true ->
            persist_identity(user_id, vault_id, id, agent_id, mention, input, existing)
        end
      else
        {:error, "Vault not found"}
      end
    end
  rescue
    error in Exqlite.Error -> {:error, Exception.message(error)}
  end

  @doc "Copies an owned identity into a different vault without carrying private or channel state."
  defp import_identity(user_id, vault_id, source_id) do
    with true <- not is_nil(VaultMembers.role(vault_id, user_id)),
         {:ok, id} <-
           SQL.transaction(fn ->
             case SQL.one(
                    "SELECT id FROM vault_agents WHERE vault_id=? AND imported_from_agent_id=?",
                    [vault_id, source_id]
                  ) do
               [id] ->
                 if source_excluded?(vault_id, id),
                   do: {:error, "Agent was removed from this vault"},
                   else: {:ok, id}

               nil ->
                 case SQL.one(
                        """
                        SELECT va.id,va.vault_id,va.agent_id,va.display_name,va.avatar_url,va.mention,va.model
                        FROM vault_agents va
                        WHERE va.id=? AND va.owner_user_id=? AND va.vault_id!=?
                          AND NOT EXISTS(
                            SELECT 1 FROM chat_agent_members m
                            WHERE m.vault_agent_id=va.id AND m.vault_id=?
                          ) AND NOT EXISTS(
                            SELECT 1 FROM vault_agents imported
                            WHERE imported.imported_from_agent_id=va.id AND imported.vault_id=?
                          ) AND NOT EXISTS(
                            SELECT 1 FROM vault_agent_exclusions x
                            WHERE x.vault_id=? AND x.vault_agent_id=va.id
                          ) AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now'))
                        """,
                        [source_id, user_id, vault_id, vault_id, vault_id, vault_id]
                      ) do
                   [
                     _source_identity,
                     _source_vault,
                     agent_id,
                     display_name,
                     _avatar_url,
                     source_mention,
                     model
                   ] ->
                     id = Ecto.UUID.generate()
                     mention = import_mention(vault_id, source_mention, user_id, id)

                     SQL.exec(
                       """
                       INSERT OR IGNORE INTO vault_agents(id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,
                         hermes_profile,hermes_safe_mode,identity_scope,expires_at,owner_user_id,imported_from_agent_id)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       """,
                       [
                         id,
                         vault_id,
                         agent_id,
                         display_name || agent_id,
                         "",
                         mention,
                         model || "",
                         "",
                         "",
                         "",
                         0,
                         "vault",
                         nil,
                         user_id,
                         source_id
                       ]
                     )

                     case SQL.one(
                            "SELECT id FROM vault_agents WHERE vault_id=? AND imported_from_agent_id=?",
                            [vault_id, source_id]
                          ) do
                       [saved_id] -> {:ok, saved_id}
                       nil -> {:error, "Agent is not available to import"}
                     end

                   _ ->
                     {:error, "Agent is not available to import"}
                 end
             end
           end) do
      get(user_id, vault_id, id)
    else
      false -> {:error, "Vault not found"}
      {:error, _} = error -> error
      _ -> {:error, "Agent is not available to import"}
    end
  end

  @doc "Unlinks an agent from one vault; the owner-scoped profile and other vault memberships survive."
  def unlink_from_vault(user_id, vault_id, identity_id) do
    with true <- not is_nil(VaultMembers.role(vault_id, user_id)),
         [owner_id, imported_from] <-
           SQL.one(
             """
             SELECT va.owner_user_id,va.imported_from_agent_id
             FROM vault_agents va
             WHERE va.id=? AND (
               va.vault_id=? OR EXISTS(
                 SELECT 1 FROM chat_agent_members m
                 WHERE m.vault_agent_id=va.id AND m.vault_id=?
               )
             )
             """,
             [identity_id, vault_id, vault_id]
           ),
         true <- owner_id in [nil, user_id] do
      SQL.transaction(fn ->
        SQL.exec(
          "INSERT OR IGNORE INTO vault_agent_exclusions(vault_id,vault_agent_id) VALUES(?,?)",
          [vault_id, identity_id]
        )

        if imported_from do
          SQL.exec(
            "INSERT OR IGNORE INTO vault_agent_exclusions(vault_id,vault_agent_id) VALUES(?,?)",
            [vault_id, imported_from]
          )
        end

        SQL.exec("DELETE FROM chat_agent_members WHERE vault_agent_id=? AND vault_id=?", [
          identity_id,
          vault_id
        ])
      end)

      {:ok, true}
    else
      nil -> {:error, "Vault agent not found"}
      false -> {:error, "Vault not found"}
      [_other, _imported] -> {:error, "Only the agent owner can remove it"}
      _ -> {:error, "Vault agent not found"}
    end
  end

  @doc "Explicitly retires an owner-scoped profile and every membership."
  def delete_profile(user_id, vault_id, identity_id) do
    with true <- not is_nil(VaultMembers.role(vault_id, user_id)),
         [owner_id, imported_from] <-
           SQL.one(
             "SELECT owner_user_id,imported_from_agent_id FROM vault_agents WHERE id=?",
             [identity_id]
           ),
         true <- owner_id in [nil, user_id] do
      deleted =
        SQL.transaction(fn ->
          if imported_from do
            SQL.exec(
              "DELETE FROM vault_agent_exclusions WHERE vault_id=? AND vault_agent_id=?",
              [vault_id, imported_from]
            )
          end

          SQL.exec("DELETE FROM chat_agent_members WHERE vault_agent_id=?", [identity_id])
          SQL.changes("DELETE FROM vault_agents WHERE id=?", [identity_id]) > 0
        end)

      if deleted, do: Avatars.purge(identity_id)

      {:ok, deleted}
    else
      false -> {:error, "Vault not found"}
      [_other, _imported] -> {:error, "Only the agent owner can delete it"}
      _ -> {:error, "Vault agent not found"}
    end
  end

  def list_members(channel_id, user_id) do
    purge_expired_sessions!()

    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      members =
        SQL.all(
          """
            SELECT m.id,m.vault_agent_id,va.owner_user_id,m.agent_id,m.display_name,m.avatar_url,
              m.mention,m.model,m.reasoning_effort,m.priority_service_tier,m.cwd,m.context_prompt,
              m.taggable_by_agents,m.reply_to_every_message,m.orchestrator,m.pingable_by_others,
              m.ambient_group_chat,m.final_reply_only,m.yolo,m.conversation_id,va.hermes_profile,va.hermes_safe_mode,m.next_step_suggestions FROM chat_agent_members m
            JOIN vault_agents va ON va.id=m.vault_agent_id
            WHERE m.channel_id=? AND m.vault_id=? ORDER BY m.created_at,m.rowid
          """,
          [route.sourceChannelId, route.localVaultId]
        )
        |> Enum.map(&member/1)

      {:ok, members}
    end
  end

  def add_to_channel(
        user_id,
        vault_id,
        channel_id,
        identity_id,
        flags \\ %{},
        restore_excluded \\ false
      ) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [
           id,
           _home_vault,
           agent_id,
           display_name,
           avatar_url,
           default_mention,
           default_model,
           default_cwd,
           default_prompt,
           owner_id | _
         ] <-
           SQL.one(
             "SELECT id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,owner_user_id,created_at,updated_at FROM vault_agents WHERE id=? AND (vault_id=? OR EXISTS(SELECT 1 FROM chat_agent_members m WHERE m.vault_agent_id=vault_agents.id AND m.vault_id=?)) AND (identity_scope!='session' OR julianday(expires_at)>julianday('now'))",
             [identity_id, route.localVaultId, route.localVaultId]
           ),
         :ok <- manage_identity(owner_id, user_id),
         :ok <- allow_vault_link(route.localVaultId, identity_id, restore_excluded),
         existing <-
           SQL.one(
             "SELECT id,reasoning_effort,priority_service_tier,taggable_by_agents,reply_to_every_message,orchestrator,pingable_by_others,ambient_group_chat,final_reply_only,yolo,conversation_id,next_step_suggestions,mention,model,cwd,context_prompt FROM chat_agent_members WHERE vault_agent_id=? AND channel_id=? AND vault_id=? ORDER BY rowid LIMIT 1",
             [identity_id, route.sourceChannelId, route.localVaultId]
           ),
         mention <-
           Schema.normalize_mention(
             value(
               flags,
               "mention",
               nonblank(to_string(existing_value(existing, 12, "")), default_mention)
             ),
             agent_id
           ),
         model <-
           value(flags, "model", existing_value(existing, 13, default_model))
           |> to_string()
           |> String.trim(),
         cwd <- value(flags, "cwd", existing_value(existing, 14, default_cwd)) |> to_string(),
         prompt <-
           value(flags, "contextPrompt", existing_value(existing, 15, default_prompt))
           |> to_string(),
         :ok <-
           member_handle_available(
             route.sourceChannelId,
             route.localVaultId,
             identity_id,
             mention
           ) do
      registration_id = if existing, do: hd(existing), else: Ecto.UUID.generate()

      effort =
        supported_effort(
          agent_id,
          value(flags, "reasoningEffort", existing_value(existing, 1, ""))
        )

      priority =
        agent_id == "codex" and
          boolean(flags, "priorityServiceTier", existing_value(existing, 2, 0) != 0)

      taggable = boolean(flags, "taggableByAgents", existing_value(existing, 3, 0) != 0)
      orchestrator = boolean(flags, "orchestrator", existing_value(existing, 5, 0) != 0)

      next_step_suggestions =
        orchestrator and
          boolean(flags, "nextStepSuggestions", existing_value(existing, 11, 0) != 0)

      reply_every =
        orchestrator or boolean(flags, "replyToEveryMessage", existing_value(existing, 4, 0) != 0)

      pingable = boolean(flags, "pingableByOthers", existing_value(existing, 6, 0) != 0)
      ambient = boolean(flags, "ambientGroupChat", existing_value(existing, 7, 0) != 0)

      final_reply_only =
        boolean(flags, "finalReplyOnly", existing_value(existing, 8, 0) != 0)

      yolo = boolean(flags, "yolo", existing_value(existing, 9, 0) != 0)

      conversation_id =
        value(flags, "conversationId", existing_value(existing, 10, ""))
        |> to_string()
        |> String.trim()
        |> nonblank(Ecto.UUID.generate())

      with :ok <-
             coordinator_available(
               route.sourceChannelId,
               route.localVaultId,
               registration_id,
               owner_id,
               orchestrator
             ) do
        SQL.transaction(fn ->
          was_enabled =
            SQL.one(
              "SELECT next_step_suggestions FROM chat_agent_members WHERE channel_id=? AND vault_id=? AND id=?",
              [route.sourceChannelId, route.localVaultId, registration_id]
            ) == [1]

          if restore_excluded do
            clear_vault_exclusions(route.localVaultId, identity_id)
          end

          SQL.exec(
            """
            INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,avatar_url,
              mention,model,reasoning_effort,priority_service_tier,cwd,context_prompt,taggable_by_agents,
              reply_to_every_message,orchestrator,pingable_by_others,ambient_group_chat,final_reply_only,yolo,conversation_id,next_step_suggestions)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(vault_id,channel_id,vault_agent_id) DO UPDATE SET
              agent_id=excluded.agent_id,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
              mention=excluded.mention,model=excluded.model,reasoning_effort=excluded.reasoning_effort,
              priority_service_tier=excluded.priority_service_tier,cwd=excluded.cwd,
              context_prompt=excluded.context_prompt,taggable_by_agents=excluded.taggable_by_agents,
              reply_to_every_message=excluded.reply_to_every_message,orchestrator=excluded.orchestrator,
              pingable_by_others=excluded.pingable_by_others,ambient_group_chat=excluded.ambient_group_chat,
              final_reply_only=excluded.final_reply_only,yolo=excluded.yolo,
              next_step_suggestions=excluded.next_step_suggestions,
              conversation_id=excluded.conversation_id,updated_at=datetime('now')
            """,
            [
              registration_id,
              route.sourceChannelId,
              route.localVaultId,
              id,
              agent_id,
              display_name,
              avatar_url || "",
              mention,
              model || "",
              effort,
              bool_int(priority),
              cwd || "",
              prompt || "",
              bool_int(taggable),
              bool_int(reply_every),
              bool_int(orchestrator),
              bool_int(pingable),
              bool_int(ambient),
              bool_int(final_reply_only),
              bool_int(yolo),
              conversation_id,
              bool_int(next_step_suggestions)
            ]
          )

          if next_step_suggestions and not was_enabled do
            Cascade.Chat.NextSteps.enqueue(
              route.sourceChannelId,
              registration_id,
              "sys-next-enable-#{Ecto.UUID.generate()}",
              "enable",
              "The owner enabled next-step suggestions for this coordinator in this channel."
            )
          end

          if not next_step_suggestions do
            SQL.exec(
              """
              DELETE FROM chat_agent_dispatches WHERE registration_id=? AND run_id IS NULL
                AND message_id IN (SELECT source_id FROM chat_next_step_checks
                  WHERE channel_id=? AND registration_id=? AND kind IN ('enable','completion'))
              """,
              [registration_id, route.sourceChannelId, registration_id]
            )
          end
        end)

        [saved_registration_id] =
          SQL.one(
            "SELECT id FROM chat_agent_members WHERE vault_agent_id=? AND channel_id=? AND vault_id=?",
            [identity_id, route.sourceChannelId, route.localVaultId]
          )

        if route.localVaultId == route.sourceVaultId do
          backfill_legacy_messages(
            route.sourceChannelId,
            saved_registration_id,
            agent_id,
            mention,
            display_name
          )
        end

        list_members(channel_id, user_id) |> map_ok_find(saved_registration_id)
      end
    else
      nil -> {:error, "Vault agent not found"}
      {:error, _} = error -> error
      _ -> {:error, "Vault agent not found"}
    end
  end

  defp allow_vault_link(_vault_id, _identity_id, true), do: :ok

  defp allow_vault_link(vault_id, identity_id, false) do
    if source_excluded?(vault_id, identity_id),
      do: {:error, "Agent was removed from this vault"},
      else: :ok
  end

  defp source_excluded?(vault_id, identity_id) do
    not is_nil(
      SQL.one(
        """
        SELECT 1 FROM vault_agent_exclusions x
        WHERE x.vault_id=? AND (
          x.vault_agent_id=? OR x.vault_agent_id=(
            SELECT imported_from_agent_id FROM vault_agents WHERE id=?
          )
        )
        LIMIT 1
        """,
        [vault_id, identity_id, identity_id]
      )
    )
  end

  defp clear_vault_exclusions(vault_id, identity_id) do
    SQL.exec(
      """
      DELETE FROM vault_agent_exclusions
      WHERE vault_id=? AND (
        vault_agent_id=? OR vault_agent_id=(
          SELECT imported_from_agent_id FROM vault_agents WHERE id=?
        )
      )
      """,
      [vault_id, identity_id, identity_id]
    )
  end

  defp backfill_legacy_messages(channel_id, registration_id, agent_id, mention, display_name) do
    SQL.exec(
      """
      UPDATE chat_messages SET agent_id=?,registration_id=?
      WHERE channel_id=? AND SUBSTR(id,1,6)='agent-'
        AND COALESCE(agent_id,'')='' AND COALESCE(registration_id,'')=''
        AND (LOWER(author)=LOWER(?) OR LOWER(author)=LOWER(?))
      """,
      [agent_id, registration_id, channel_id, mention, display_name]
    )
  end

  def upsert_member(user_id, vault_id, channel_id, input) do
    case value(input, "vaultAgentId", "") |> to_string() |> String.trim() do
      "" ->
        with {:ok, identity} <- upsert_identity(user_id, vault_id, input) do
          add_to_channel(user_id, vault_id, channel_id, identity.id, input)
        end

      identity_id ->
        add_to_channel(user_id, vault_id, channel_id, identity_id, input)
    end
  end

  def remove_member(user_id, vault_id, channel_id, registration_id) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [identity_id, owner_id] <-
           SQL.one(
             """
               SELECT m.vault_agent_id,va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
               WHERE m.id=? AND m.channel_id=? AND m.vault_id=?
             """,
             [registration_id, route.sourceChannelId, route.localVaultId]
           ),
         :ok <- manage_identity(owner_id, user_id) do
      unlink_from_vault(user_id, route.localVaultId, identity_id)
    else
      nil -> {:error, "Agent member not found"}
      {:error, _} = error -> error
    end
  end

  def set_avatar(user_id, vault_id, channel_id, registration_id, avatar_url) do
    url = avatar_url |> to_string() |> String.trim()

    with true <-
           url == "" or String.starts_with?(url, "data:") or Regex.match?(~r{^https?://}i, url),
         true <- String.starts_with?(url, "data:") or String.length(url) <= 2_048,
         {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [identity_id, ^user_id] <-
           SQL.one(
             """
               SELECT m.vault_agent_id,va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
               WHERE m.id=? AND m.channel_id=? AND m.vault_id=?
             """,
             [registration_id, route.sourceChannelId, route.localVaultId]
           ),
         {:ok, stored_url} <- Avatars.persist(user_id, identity_id, url) do
      SQL.transaction(fn ->
        SQL.exec("UPDATE vault_agents SET avatar_url=?,updated_at=datetime('now') WHERE id=?", [
          stored_url,
          identity_id
        ])

        SQL.exec(
          "UPDATE chat_agent_members SET avatar_url=?,updated_at=datetime('now') WHERE vault_agent_id=?",
          [stored_url, identity_id]
        )
      end)

      list_members(channel_id, user_id) |> map_ok_find(registration_id)
    else
      false when byte_size(url) > 2_048 -> {:error, "Profile picture URL is too long"}
      false -> {:error, "Profile picture must be an http(s) URL"}
      [_id, _owner] -> {:error, "Only the agent owner can update its profile picture"}
      {:error, _} = error -> error
      _ -> {:error, "Agent not found"}
    end
  end

  def ensure_vault_wide(user_id, vault_id, channel_id) do
    with {:ok, available} <- list_vault(user_id, vault_id),
         linked <- linked_identity_ids(vault_id),
         :ok <-
           Enum.reduce_while(available, :ok, fn identity, :ok ->
             if MapSet.member?(linked, identity.id) do
               case add_to_channel(user_id, vault_id, channel_id, identity.id) do
                 {:ok, _} -> {:cont, :ok}
                 {:error, _} = error -> {:halt, error}
               end
             else
               {:cont, :ok}
             end
           end) do
      list_members(channel_id, user_id)
    end
  end

  defp linked_identity_ids(vault_id) do
    SQL.all(
      """
      SELECT va.id FROM vault_agents va
      WHERE (va.vault_id=? OR EXISTS(
        SELECT 1 FROM chat_agent_members m WHERE m.vault_agent_id=va.id AND m.vault_id=?
      )) AND NOT EXISTS(
        SELECT 1 FROM vault_agent_exclusions x
        WHERE x.vault_id=? AND (x.vault_agent_id=va.id OR x.vault_agent_id=va.imported_from_agent_id)
      )
      """,
      [vault_id, vault_id, vault_id]
    )
    |> List.flatten()
    |> MapSet.new()
  end

  def resolve_owner_projection(user_id, channel_id, registration_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <-
           SQL.one(
             """
               SELECT m.id,m.vault_agent_id,va.owner_user_id FROM chat_agent_members m
               JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=? AND m.channel_id=? AND m.vault_id=?
               AND (va.identity_scope!='session' OR julianday(va.expires_at)>julianday('now'))
             """,
             [registration_id, route.sourceChannelId, route.localVaultId]
           ) do
      [_registration, _identity, owner_id] = row

      owner_route =
        Enum.find(Channel.list_routes(route.sourceVaultId, route.sourceChannelId), fn candidate ->
          SQL.one("SELECT created_by FROM vaults WHERE id=?", [candidate.localVaultId]) == [
            owner_id
          ]
        end) || direct_owner_route(route, owner_id)

      if owner_route do
        {:ok,
         %{
           route: route,
           ownerId: owner_id,
           ownerChannelId: owner_route.localChannelId,
           ownerVaultId: owner_route.localVaultId
         }}
      else
        {:error, "Agent not found"}
      end
    else
      _ -> {:error, "Agent not found"}
    end
  end

  defp persist_identity(user_id, vault_id, id, agent_id, mention, input, existing) do
    display_name =
      value(input, "displayName", "") |> to_string() |> String.trim() |> nonblank(agent_id)

    avatar =
      value(input, "avatarUrl", if(existing, do: Enum.at(existing, 1) || "", else: ""))
      |> to_string()
      |> String.trim()

    model = value(input, "model", "") |> to_string()
    cwd = value(input, "cwd", "") |> to_string()
    prompt = value(input, "contextPrompt", "") |> to_string()
    hermes_profile = value(input, "hermesProfile", "") |> to_string() |> String.trim()
    hermes_safe_mode = boolean(input, "hermesSafeMode", false)

    identity_scope =
      identity_scope(value(input, "identityScope", existing_value(existing, 2, "vault")))

    expires_at =
      expiry(identity_scope, value(input, "expiresAt", existing_value(existing, 3, nil)))

    SQL.transaction(fn ->
      SQL.exec(
        """
        INSERT INTO vault_agents(id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,
          hermes_profile,hermes_safe_mode,identity_scope,expires_at,owner_user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          agent_id=excluded.agent_id,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
          mention=excluded.mention,model=excluded.model,cwd=excluded.cwd,context_prompt=excluded.context_prompt,
          hermes_profile=excluded.hermes_profile,hermes_safe_mode=excluded.hermes_safe_mode,
          identity_scope=excluded.identity_scope,expires_at=excluded.expires_at,
          updated_at=datetime('now')
        """,
        [
          id,
          vault_id,
          agent_id,
          display_name,
          avatar,
          mention,
          model,
          cwd,
          prompt,
          hermes_profile,
          bool_int(hermes_safe_mode),
          identity_scope,
          expires_at,
          user_id
        ]
      )

      SQL.exec(
        """
        UPDATE chat_agent_members SET agent_id=?,display_name=?,avatar_url=?,mention=?,updated_at=datetime('now')
        WHERE vault_agent_id=?
        """,
        [agent_id, display_name, avatar, mention, id]
      )

      clear_vault_exclusions(vault_id, id)
    end)

    get(user_id, vault_id, id)
  end

  defp identity([
         id,
         vault_id,
         agent_id,
         display_name,
         avatar,
         mention,
         model,
         cwd,
         prompt,
         hermes_profile,
         hermes_safe_mode,
         identity_scope,
         expires_at,
         owner_id,
         owner_username,
         created_at,
         updated_at
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      agentId: agent_id,
      displayName: display_name,
      avatarUrl: avatar || "",
      mention: mention,
      model: model || "",
      cwd: cwd || "",
      contextPrompt: prompt || "",
      hermesProfile: hermes_profile || "",
      hermesSafeMode: hermes_safe_mode != 0,
      identityScope: identity_scope || "vault",
      expiresAt: expires_at,
      ownerUserId: owner_id,
      ownerUsername: owner_username || "",
      createdAt: created_at,
      updatedAt: updated_at
    }
  end

  defp member([
         id,
         identity_id,
         owner_id,
         agent_id,
         name,
         avatar,
         mention,
         model,
         effort,
         priority,
         cwd,
         prompt,
         taggable,
         reply_every,
         orchestrator,
         pingable,
         ambient,
         final_reply_only,
         yolo,
         conversation_id,
         hermes_profile,
         hermes_safe_mode,
         next_step_suggestions
       ]) do
    %{
      id: id,
      vaultAgentId: identity_id,
      ownerUserId: owner_id || 0,
      agentId: agent_id,
      displayName: name,
      avatarUrl: avatar || "",
      mention: mention,
      model: model || "",
      reasoningEffort: effort || "",
      priorityServiceTier: priority != 0,
      cwd: cwd || "",
      contextPrompt: prompt || "",
      taggableByAgents: taggable != 0,
      replyToEveryMessage: reply_every != 0,
      orchestrator: orchestrator != 0,
      nextStepSuggestions: next_step_suggestions != 0,
      pingableByOthers: pingable != 0,
      ambientGroupChat: ambient != 0,
      finalReplyOnly: final_reply_only != 0,
      yolo: yolo != 0,
      hermesProfile: hermes_profile || "",
      hermesSafeMode: hermes_safe_mode != 0,
      conversationId: conversation_id || ""
    }
  end

  defp channel_ids(id, vault_id),
    do:
      SQL.all(
        "SELECT DISTINCT channel_id FROM chat_agent_members WHERE vault_agent_id=? AND vault_id=? ORDER BY channel_id",
        [id, vault_id]
      )
      |> List.flatten()

  defp identity_clash?(id, mention, user_id, vault_id),
    do:
      not is_nil(
        SQL.one(
          """
          SELECT 1 FROM vault_agents va
          WHERE va.mention=? COLLATE NOCASE AND va.id!=? AND (
            va.owner_user_id=? OR va.vault_id=? OR EXISTS(
              SELECT 1 FROM chat_agent_members m WHERE m.vault_agent_id=va.id AND m.vault_id=?
            )
          ) LIMIT 1
          """,
          [mention, id, user_id, vault_id, vault_id]
        )
      )

  defp import_mention(vault_id, source_mention, user_id, identity_id) do
    base = Schema.normalize_mention(source_mention, "agent")
    import_mention(vault_id, base, user_id, identity_id, 0)
  end

  defp import_mention(vault_id, base, user_id, identity_id, suffix) do
    mention = if suffix == 0, do: base, else: "#{base}_#{suffix + 1}"

    if identity_clash?(identity_id, mention, user_id, vault_id) do
      import_mention(vault_id, base, user_id, identity_id, suffix + 1)
    else
      mention
    end
  end

  defp identity_scope(value) do
    normalized = value |> to_string() |> String.trim() |> String.downcase()
    if normalized in @identity_scopes, do: normalized, else: "vault"
  end

  defp expiry("session", value) do
    case DateTime.from_iso8601(to_string(value || "")) do
      {:ok, expiry, _offset} ->
        if DateTime.compare(expiry, DateTime.utc_now()) == :gt,
          do: DateTime.to_iso8601(expiry),
          else: DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.to_iso8601()

      _ ->
        DateTime.utc_now() |> DateTime.add(3600, :second) |> DateTime.to_iso8601()
    end
  end

  defp expiry(_scope, _value), do: nil

  defp purge_expired_sessions! do
    expired =
      SQL.all(
        "SELECT id FROM vault_agents WHERE identity_scope='session' AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday('now')"
      )
      |> List.flatten()

    SQL.transaction(fn ->
      SQL.exec(
        "DELETE FROM chat_agent_members WHERE vault_agent_id IN (SELECT id FROM vault_agents WHERE identity_scope='session' AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday('now'))"
      )

      SQL.exec(
        "DELETE FROM vault_agent_exclusions WHERE vault_agent_id IN (SELECT id FROM vault_agents WHERE identity_scope='session' AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday('now'))"
      )

      SQL.exec(
        "DELETE FROM vault_agents WHERE identity_scope='session' AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday('now')"
      )
    end)

    Enum.each(expired, &Avatars.purge/1)
  end

  defp member_handle_available(channel_id, vault_id, identity_id, mention),
    do:
      if(
        SQL.one(
          "SELECT 1 FROM chat_agent_members WHERE channel_id=? AND vault_id=? AND mention=? COLLATE NOCASE AND vault_agent_id!=?",
          [channel_id, vault_id, mention, identity_id]
        ),
        do: {:error, "@#{mention} is already used by another agent in this channel"},
        else: :ok
      )

  defp manage_identity(owner_id, user_id),
    do:
      if(owner_id in [nil, user_id],
        do: :ok,
        else: {:error, "You can only manage assistants in your own roster"}
      )

  defp coordinator_available(_channel, _vault_id, _registration, _owner, false), do: :ok

  defp coordinator_available(channel, vault_id, registration, owner, true) do
    case SQL.one(
           """
             SELECT m.display_name,m.mention FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
             WHERE m.channel_id=? AND m.vault_id=? AND m.orchestrator!=0 AND m.id!=? AND va.owner_user_id=? LIMIT 1
           """,
           [channel, vault_id, registration, owner]
         ) do
      [name, mention] ->
        {:error, "#{nonblank(name || "", "@#{mention}")} already coordinates this channel"}

      _ ->
        :ok
    end
  end

  defp supported_effort("codex", effort),
    do: if(to_string(effort) in @codex_efforts, do: to_string(effort), else: "")

  defp supported_effort("claude-code", effort),
    do: if(to_string(effort) in @claude_efforts, do: to_string(effort), else: "")

  defp supported_effort(_, _), do: ""
  defp existing_value(nil, _index, fallback), do: fallback
  defp existing_value(row, index, _fallback), do: Enum.at(row, index)

  defp boolean(map, key, fallback) do
    case fetch(map, key) do
      {:ok, value} -> value == true
      :error -> fallback
    end
  end

  defp fetch(map, key) do
    case Map.fetch(map, key) do
      {:ok, value} -> {:ok, value}
      :error -> Map.fetch(map, String.to_atom(key))
    end
  end

  defp value(map, key, fallback),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp bool_int(true), do: 1
  defp bool_int(_), do: 0
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value

  defp map_ok_find({:ok, values}, id) do
    case Enum.find(values, &(&1.id == id)) do
      nil -> {:error, "Agent not found"}
      value -> {:ok, value}
    end
  end

  defp map_ok_find(error, _id), do: error

  defp direct_owner_route(route, owner_id) do
    case Channel.assert_channel(route.sourceChannelId, owner_id) do
      {:ok, owner_route} -> owner_route
      _ -> nil
    end
  end
end
