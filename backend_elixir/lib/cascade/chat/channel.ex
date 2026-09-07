defmodule Cascade.Chat.Channel do
  @moduledoc "Authorization, local/source projection, participants, presence, settings, and channel membership."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Events
  alias Cascade.Content.{Assets, Store}

  @marker "cascade://chat-channel"
  def assert_channel(channel_id, user_id) do
    row =
      SQL.one(
        """
        SELECT local.id,local.vault_id,local.content,local.content_preview,
          link.source_channel_id,link.source_vault_id,source.content,source.content_preview
        FROM notes local
        JOIN vault_members member
          ON member.vault_id=local.vault_id AND member.user_id=?
        LEFT JOIN chat_channel_links link ON link.local_channel_id=local.id
        LEFT JOIN notes source
          ON source.id=link.source_channel_id AND source.vault_id=link.source_vault_id
          AND source.is_archived=0
        WHERE local.id=? AND local.is_archived=0
        LIMIT 1
        """,
        [user_id, channel_id]
      )

    case row do
      [local_id, local_vault_id, content, preview, nil, nil, _source_content, _source_preview] ->
        if chat_note?(content, preview) do
          {:ok,
           %{
             localVaultId: local_vault_id,
             localChannelId: local_id,
             sourceVaultId: local_vault_id,
             sourceChannelId: local_id
           }}
        else
          {:error, "Chat channel not found"}
        end

      [
        local_id,
        local_vault_id,
        content,
        preview,
        source_channel_id,
        source_vault_id,
        source_content,
        source_preview
      ] ->
        if chat_note?(content, preview) and chat_note?(source_content, source_preview) do
          {:ok,
           %{
             localVaultId: local_vault_id,
             localChannelId: local_id,
             sourceVaultId: source_vault_id,
             sourceChannelId: source_channel_id
           }}
        else
          {:error, "Chat channel not found"}
        end

      _ ->
        {:error, "Chat channel not found"}
    end
  end

  def assert_vault_channel(vault_id, channel_id, user_id) do
    case assert_channel(channel_id, user_id) do
      {:ok, %{localVaultId: ^vault_id} = route} -> {:ok, route}
      _ -> {:error, "Chat channel not found"}
    end
  end

  def list_routes(source_vault_id, source_channel_id),
    do: list_routes(source_vault_id, source_channel_id, :other)

  def list_routes(source_vault_id, source_channel_id, reason) do
    :telemetry.execute(
      [:cascade, :chat, :list_routes],
      %{count: 1},
      %{reason: reason}
    )

    own = [
      %{
        localVaultId: source_vault_id,
        localChannelId: source_channel_id,
        sourceVaultId: source_vault_id,
        sourceChannelId: source_channel_id
      }
    ]

    linked =
      SQL.all(
        "SELECT local_vault_id,local_channel_id FROM chat_channel_links WHERE source_vault_id=? AND source_channel_id=? ORDER BY created_at,local_channel_id",
        [source_vault_id, source_channel_id]
      )
      |> Enum.map(fn [vault_id, channel_id] ->
        %{
          localVaultId: vault_id,
          localChannelId: channel_id,
          sourceVaultId: source_vault_id,
          sourceChannelId: source_channel_id
        }
      end)

    own ++ linked
  end

  def link(source_vault_id, source_channel_id, local_vault_id, local_channel_id, created_by) do
    if not source_chat?(source_channel_id, source_vault_id),
      do: {:error, "Chat channel not found"},
      else:
        SQL.transaction(fn ->
          SQL.exec(
            """
            INSERT INTO chat_channel_links(local_channel_id,local_vault_id,source_channel_id,source_vault_id,created_by)
            VALUES(?,?,?,?,?) ON CONFLICT(local_channel_id) DO UPDATE SET
              local_vault_id=excluded.local_vault_id,source_channel_id=excluded.source_channel_id,
              source_vault_id=excluded.source_vault_id,created_by=excluded.created_by
            """,
            [local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by]
          )

          {:ok,
           %{
             localVaultId: local_vault_id,
             localChannelId: local_channel_id,
             sourceVaultId: source_vault_id,
             sourceChannelId: source_channel_id
           }}
        end)
        |> tap(fn
          {:ok, _route} -> Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
          _ -> :ok
        end)
  end

  def participants(channel_id, user_id) do
    with {:ok, route} <- assert_channel(channel_id, user_id) do
      {:ok, participant_usernames(route.sourceVaultId, route.sourceChannelId)}
    end
  end

  def participant_usernames(source_vault_id, source_channel_id) do
    participant_snapshot(source_vault_id, source_channel_id).participants
  end

  def participant_snapshot(source_vault_id, source_channel_id, opts \\ []) do
    # Inline photos belong in the HTTP response, never in realtime presence events.
    include_avatars = Keyword.get(opts, :include_avatars, false)
    avatar_column = if include_avatars, do: "u.avatar_url", else: "NULL"

    rows =
      SQL.all(
        """
        WITH source AS (
          SELECT v.created_by,u.username AS owner_username
          FROM vaults v JOIN users u ON u.id=v.created_by WHERE v.id=?
        ), participant_names(username) AS (
          SELECT u.username FROM source s JOIN users u ON u.id=s.created_by
          UNION
          SELECT u.username FROM vault_members m JOIN users u ON u.id=m.user_id
            WHERE m.vault_id=?
          UNION
          SELECT u.username FROM chat_channel_links l
            JOIN vaults v ON v.id=l.local_vault_id
            JOIN users u ON u.id=v.created_by WHERE l.source_channel_id=?
              AND NOT EXISTS (
                SELECT 1 FROM chat_agent_members agent
                WHERE agent.channel_id=? AND (
                  agent.display_name=u.username COLLATE NOCASE OR
                  agent.mention=u.username COLLATE NOCASE OR
                  agent.agent_id=u.username COLLATE NOCASE
                )
              )
          UNION
          SELECT legacy.author FROM (
            SELECT DISTINCT author FROM chat_messages
            WHERE channel_id=? AND COALESCE(agent_id,'')=''
              AND author NOT IN ('','Cascade') LIMIT 200
          ) legacy
          WHERE NOT EXISTS (
            SELECT 1 FROM chat_agent_members agent
            WHERE agent.channel_id=? AND (
              agent.display_name=legacy.author COLLATE NOCASE OR
              agent.mention=legacy.author COLLATE NOCASE OR
              agent.agent_id=legacy.author COLLATE NOCASE
            )
          )
        )
        SELECT u.id,n.username,u.username,
          COALESCE(NULLIF(u.display_name,''),u.username),s.owner_username,#{avatar_column}
        FROM participant_names n CROSS JOIN source s
        LEFT JOIN users u ON u.username=n.username
        WHERE n.username IS NOT NULL AND n.username != ''
        ORDER BY LOWER(n.username),n.username
        """,
        [
          source_vault_id,
          source_vault_id,
          source_channel_id,
          source_channel_id,
          source_channel_id,
          source_channel_id
        ]
      )

    users =
      Enum.flat_map(rows, fn
        [id, participant_username, username, display_name, _owner, avatar_url]
        when is_integer(id) and is_binary(username) ->
          [
            %{
              id: id,
              participantUsername: participant_username,
              username: username,
              displayName: display_name || username
            }
            |> then(&if(include_avatars, do: Map.put(&1, :avatarUrl, avatar_url || ""), else: &1))
          ]

        _ ->
          []
      end)

    %{
      participants: Enum.map(rows, &Enum.at(&1, 1)),
      owner: rows |> List.first() |> then(&if(&1, do: Enum.at(&1, 4), else: "")),
      profiles:
        Map.new(users, fn user ->
          {user.username, Map.drop(user, [:participantUsername])}
        end),
      users: users
    }
  rescue
    _ -> %{participants: [], owner: "", profiles: %{}, users: []}
  end

  def presence(channel_id, user_id, callback \\ Cascade.Chat.Events.Noop) do
    with {:ok, route} <- assert_channel(channel_id, user_id) do
      snapshot =
        participant_snapshot(route.sourceVaultId, route.sourceChannelId, include_avatars: true)

      online =
        Events.online(callback, snapshot.participants)
        |> Enum.filter(&(&1 in snapshot.participants))
        |> Enum.uniq()

      {:ok,
       %{
         participants: snapshot.participants,
         online: online,
         owner: snapshot.owner,
         profiles: snapshot.profiles
       }}
    end
  end

  def settings(channel_id, user_id) do
    with {:ok, route} <- assert_channel(channel_id, user_id) do
      row =
        SQL.one(
          "SELECT cwd,COALESCE(kanban_note_id,'') FROM chat_channel_settings WHERE channel_id=?",
          [route.sourceChannelId]
        ) || ["", ""]

      [cwd, kanban_note_id] = row
      {:ok, %{cwd: String.trim(cwd || ""), kanbanNoteId: live_kanban_id(kanban_note_id)}}
    end
  end

  def update_settings(channel_id, user_id, params) do
    with {:ok, route} <- assert_channel(channel_id, user_id),
         [^user_id] <- SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.sourceVaultId]),
         {:ok, current} <- settings(channel_id, user_id),
         kanban <-
           value(params, "kanbanNoteId", current.kanbanNoteId) |> to_string() |> String.trim(),
         :ok <- validate_kanban(route.sourceVaultId, kanban) do
      cwd = value(params, "cwd", current.cwd) |> to_string() |> String.trim()

      SQL.exec(
        """
        INSERT INTO chat_channel_settings(channel_id,cwd,kanban_note_id,updated_at) VALUES(?,?,NULLIF(?,''),datetime('now'))
        ON CONFLICT(channel_id) DO UPDATE SET cwd=excluded.cwd,kanban_note_id=excluded.kanban_note_id,updated_at=excluded.updated_at
        """,
        [route.sourceChannelId, cwd, kanban]
      )

      settings(channel_id, user_id)
    else
      nil -> {:error, "Only the channel owner can change the shared working directory"}
      false -> {:error, "Only the channel owner can change the shared working directory"}
      [_] -> {:error, "Only the channel owner can change the shared working directory"}
      {:error, _} = error -> error
      _ -> {:error, "Only the channel owner can change the shared working directory"}
    end
  end

  def leave(channel_id, user_id) do
    with {:ok, route} <- assert_channel(channel_id, user_id),
         false <- route.localChannelId == route.sourceChannelId,
         [owner_id] <- SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.localVaultId]),
         true <- owner_id == user_id do
      Assets.delete_all(route.localChannelId)
      Store.delete_note(route.localChannelId)
      {:ok, route}
    else
      true -> {:error, "The channel owner cannot leave their own channel"}
      _ -> {:error, "Chat channel not found"}
    end
  end

  def remove_participant(channel_id, actor_id, username) do
    with {:ok, route} <- assert_channel(channel_id, actor_id),
         [^actor_id] <- SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.sourceVaultId]),
         [target_id] <-
           SQL.one("SELECT id FROM users WHERE username=? COLLATE NOCASE", [
             String.trim(to_string(username))
           ]),
         true <- target_id != actor_id,
         [local_channel_id, local_vault_id] <-
           SQL.one(
             """
               SELECT l.local_channel_id,l.local_vault_id FROM chat_channel_links l
               JOIN vaults v ON v.id=l.local_vault_id
               WHERE l.source_channel_id=? AND v.created_by=? ORDER BY l.created_at LIMIT 1
             """,
             [route.sourceChannelId, target_id]
           ) do
      Assets.delete_all(local_channel_id)
      Store.delete_note(local_channel_id)

      {:ok,
       %{
         username: username,
         channelId: local_channel_id,
         userId: target_id,
         localVaultId: local_vault_id,
         sourceVaultId: route.sourceVaultId,
         sourceChannelId: route.sourceChannelId
       }}
    else
      _ -> {:error, "Participant not found"}
    end
  end

  defp source_chat?(channel_id, vault_id) do
    case SQL.one(
           "SELECT content,content_preview FROM notes WHERE id=? AND vault_id=? AND is_archived=0",
           [channel_id, vault_id]
         ) do
      [content, preview] -> chat_note?(content, preview)
      _ -> false
    end
  end

  defp chat_note?(content, preview),
    do: String.starts_with?(String.trim(to_string(content || preview || "")), @marker)

  defp live_kanban_id(""), do: ""
  defp live_kanban_id(nil), do: ""

  defp live_kanban_id(id),
    do: if(SQL.one("SELECT 1 FROM notes WHERE id=? AND is_archived=0", [id]), do: id, else: "")

  defp validate_kanban(_vault_id, ""), do: :ok
  defp validate_kanban(_vault_id, nil), do: :ok

  defp validate_kanban(vault_id, note_id) do
    case SQL.one(
           "SELECT content,content_preview FROM notes WHERE id=? AND vault_id=? AND is_archived=0",
           [note_id, vault_id]
         ) do
      [content, preview] ->
        if Regex.match?(~r/kanban-plugin\s*:/i, to_string(content || preview || "")),
          do: :ok,
          else: {:error, "That note is not a Kanban board"}

      _ ->
        {:error, "Kanban board note not found in this vault"}
    end
  end

  defp value(map, key, fallback),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))
end
