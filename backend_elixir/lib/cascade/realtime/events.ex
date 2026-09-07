defmodule Cascade.Realtime.Events do
  @moduledoc """
  Canonical outbound realtime projection for the native backend.

  Domain mutations call this module only after their durable transaction has
  completed. It projects source chat identifiers to every linked local route,
  narrows audiences to current memberships, and publishes the exact Socket.IO
  event names consumed by the existing clients.
  """

  @behaviour Cascade.Chat.Events

  alias Cascade.Accounts.{CommunityActivity, SQL}
  alias Cascade.Chat.Channel
  alias Cascade.Realtime.{Hub, PresenceDispatcher}

  @vault_namespace "/vault"
  @chat_created "vault:chatMessageCreated"
  @chat_updated "vault:chatMessageUpdated"
  @chat_deleted "vault:chatMessageDeleted"
  @chat_agent_upserted "vault:chatAgentMemberUpserted"
  @chat_agent_removed "vault:chatAgentMemberRemoved"

  @doc "Options to mount on CascadeWeb.AccountRouter."
  def account_options do
    [
      on_disconnect_user: &disconnect_user/1,
      on_profile_updated: &profile_updated/1,
      on_visibility_changed: &visibility_changed/1,
      on_vault_members_changed: &members_changed/1,
      on_community_changed: &community_changed/1,
      on_channel_created: &channel_created/1
    ]
  end

  @doc "Options to mount on CascadeWeb.ChatRouter."
  def chat_options, do: [events: __MODULE__, presence: __MODULE__]

  @doc "Options to mount on CascadeWeb.ContentRouter."
  def content_options, do: [events: __MODULE__]

  @doc "Installs the storage-level note activity sink used by folder and tag mutations."
  def install_note_mutation_sink do
    Application.put_env(:cascade_elixir, :note_mutation_sink, &note_mutation/3)
  end

  @impl true
  def emit(intent) when is_map(intent) do
    case field(intent, :event) do
      event when event in [@chat_created, @chat_updated] ->
        message = field(intent, :message) || %{}

        if String.starts_with?(to_string(field(message, :id)), "sys-next-") or
             Cascade.Chat.Messages.terminal_shell?(message) do
          # Background dispatch consumes these durable envelopes. Retract the old
          # visible projection too, including on clients that predate this fix.
          emit_chat_deleted(%{
            vaultId: field(intent, :vaultId),
            channelId: field(intent, :channelId),
            messageId: field(field(intent, :message), :id)
          })
        else
          emit_chat_message(event, intent)
        end

      @chat_deleted ->
        emit_chat_deleted(intent)

      event when event in [@chat_agent_upserted, @chat_agent_removed] ->
        emit_chat_agent(event, intent)

      "vault:chatParticipantLeft" ->
        participant_left(intent)

      "vault:chatParticipantRemoved" ->
        participant_removed(intent)

      event when is_binary(event) ->
        emit_vault_intent(event, intent)

      _ ->
        :ok
    end
  end

  def emit(_intent), do: :ok

  @impl true
  def online_usernames(participants) when is_list(participants) do
    participants
    |> users_for_names()
    |> Enum.filter(fn {id, _username} -> Hub.online_user?(id, @vault_namespace) end)
    |> Enum.map(&elem(&1, 1))
    |> Enum.uniq()
    |> Enum.sort_by(&String.downcase/1)
  end

  def online_usernames(_participants), do: []

  def disconnect_user(user_id) when is_integer(user_id) do
    Hub.disconnect_user_sessions(user_id)
  end

  def disconnect_user(_user_id), do: :ok

  def community_changed(user_id) when is_integer(user_id),
    do: broadcast_user(user_id, "community:changed", %{})

  def community_changed(_user_id), do: :ok

  def community_changed_for_users(user_ids) do
    user_ids
    |> Enum.filter(&is_integer/1)
    |> Enum.uniq()
    |> Enum.each(&community_changed/1)

    :ok
  end

  def community_changed_for_vault(vault_id) when is_binary(vault_id) do
    SQL.all("SELECT user_id FROM vault_members WHERE vault_id=?", [vault_id])
    |> List.flatten()
    |> community_changed_for_users()
  end

  def community_changed_for_vault(_vault_id), do: :ok

  def community_changed_for_channel(source_vault_id, source_channel_id) do
    SQL.all(
      """
      SELECT user_id FROM vault_members WHERE vault_id=?
      UNION
      SELECT membership.user_id FROM chat_channel_links link
      JOIN vault_members membership ON membership.vault_id=link.local_vault_id
      WHERE link.source_channel_id=?
      """,
      [source_vault_id, source_channel_id]
    )
    |> List.flatten()
    |> community_changed_for_users()
  rescue
    _ -> community_changed_for_vault(source_vault_id)
  end

  def profile_updated(payload) when is_map(payload) do
    with user_id when is_integer(user_id) <- field(payload, :userId),
         profile when is_map(profile) <- field(payload, :profile) do
      profile_audience(user_id)
      |> Enum.each(&broadcast_user(&1, "vault:userProfileUpdated", profile))
    else
      _ -> :ok
    end
  end

  def profile_updated(_payload), do: :ok

  def visibility_changed(payload) when is_map(payload) do
    case field(payload, :vaultId) do
      vault_id when is_binary(vault_id) ->
        vault_event(vault_id, "vault:visibilityChanged", payload)

      _ ->
        :ok
    end
  end

  def visibility_changed(_payload), do: :ok

  def members_changed(payload) when is_map(payload) do
    case field(payload, :vaultId) do
      vault_id when is_binary(vault_id) ->
        vault_event(vault_id, "vault:membersChanged", %{vaultId: vault_id})

      _ ->
        :ok
    end
  end

  def members_changed(_payload), do: :ok

  def channel_created(payload) when is_map(payload) do
    PresenceDispatcher.invalidate_user_channels()

    with vault_id when is_binary(vault_id) <- field(payload, :vaultId),
         channel_id when is_binary(channel_id) <- field(payload, :channelId) do
      vault_event(vault_id, "vault:noteCreated", %{
        noteId: channel_id,
        vaultId: vault_id,
        title: field(payload, :title) || ""
      })
    else
      _ -> :ok
    end
  end

  def channel_created(_payload), do: :ok

  def note_mutation(note_id, actor_user_id, _kind)
      when is_binary(note_id) and is_integer(actor_user_id) do
    CommunityActivity.record_note_change(note_id, actor_user_id)
    Cascade.WikiMaintenance.note_changed(note_id)

    case SQL.one("SELECT vault_id FROM notes WHERE id=?", [note_id]) do
      [vault_id] -> community_changed_for_vault(vault_id)
      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  def note_mutation(_note_id, _actor_user_id, _kind), do: :ok

  def vault_event(vault_id, event, payload)
      when is_binary(vault_id) and is_binary(event) and is_map(payload) do
    if event in ["vault:noteDeleted", "vault:membersChanged"],
      do: PresenceDispatcher.invalidate_user_channels()

    if event == "vault:membersChanged", do: reconcile_vault_room(vault_id)
    Hub.broadcast("vault:#{vault_id}", @vault_namespace, event, [payload])

    if event in ["vault:noteDeleted", "vault:membersChanged"],
      do: community_changed_for_vault(vault_id)

    :ok
  end

  def emit_presence(source_vault_id, source_channel_id) do
    if Process.whereis(PresenceDispatcher) do
      PresenceDispatcher.refresh(source_vault_id, source_channel_id)
    else
      emit_presence_now(source_vault_id, source_channel_id, :other)
    end
  end

  @doc false
  def emit_presence_now(source_vault_id, source_channel_id),
    do: emit_presence_now(source_vault_id, source_channel_id, :other)

  @doc false
  def emit_presence_now(source_vault_id, source_channel_id, reason) do
    case presence_payload(source_vault_id, source_channel_id, reason) do
      nil ->
        :noop

      shared ->
        Channel.list_routes(source_vault_id, source_channel_id, reason)
        |> Enum.each(fn route ->
          payload =
            shared
            |> Map.put(:vaultId, route.localVaultId)
            |> Map.put(:channelId, route.localChannelId)

          vault_event(route.localVaultId, "vault:chatPresence", payload)
        end)

        :refreshed
    end
  end

  @doc false
  def emit_presence_for_channel_now(source_channel_id),
    do: emit_presence_for_channel_now(source_channel_id, :other)

  @doc false
  def emit_presence_for_channel_now(source_channel_id, reason)
      when is_binary(source_channel_id) do
    case SQL.one("SELECT vault_id FROM notes WHERE id=?", [source_channel_id]) do
      [source_vault_id] ->
        PresenceDispatcher.remember_source(source_vault_id, source_channel_id)
        emit_presence_now(source_vault_id, source_channel_id, reason)

      _ ->
        :noop
    end
  end

  def emit_presence_for_channel_now(_source_channel_id, _reason), do: :noop

  def initial_presence(local_channel_id, user_id) do
    with {:ok, route} <- Channel.assert_channel(local_channel_id, user_id),
         shared when is_map(shared) <-
           presence_payload(route.sourceVaultId, route.sourceChannelId, :initial) do
      {:ok,
       shared
       |> Map.put(:vaultId, route.localVaultId)
       |> Map.put(:channelId, route.localChannelId), route}
    else
      _ -> {:error, "Chat channel not found"}
    end
  end

  def refresh_user_presence(user_id) when is_integer(user_id) do
    channels = cached_presence_channels(user_id, 3)

    channels
    |> Enum.each(fn [source_vault_id, source_channel_id] ->
      emit_presence(source_vault_id, source_channel_id)
    end)

    :ok
  end

  def refresh_user_presence(_user_id), do: :ok

  def refresh_user_presence_now(user_id) when is_integer(user_id) do
    cached_presence_channels(user_id, 3)
    |> Enum.each(fn [source_vault_id, source_channel_id] ->
      emit_presence_now(source_vault_id, source_channel_id, :direct)
    end)

    :ok
  end

  def refresh_user_presence_now(_user_id), do: :ok

  defp cached_presence_channels(user_id, attempts) do
    case PresenceDispatcher.cached_user_channels(user_id) do
      {:ok, cached} ->
        cached

      :miss when attempts > 0 ->
        generation = PresenceDispatcher.user_channels_generation()
        fresh = presence_channels_for_user(user_id)

        case PresenceDispatcher.remember_user_channels(user_id, fresh, generation) do
          :stale -> cached_presence_channels(user_id, attempts - 1)
          _ -> fresh
        end

      :miss ->
        presence_channels_for_user(user_id)
    end
  end

  def namespace_disconnected(user_id, rooms) when is_integer(user_id) and is_list(rooms) do
    rooms
    |> Enum.each(fn
      "chat:" <> source_channel_id ->
        if Process.whereis(PresenceDispatcher),
          do: PresenceDispatcher.refresh_channel(source_channel_id),
          else: emit_presence_for_channel_now(source_channel_id)

      _ ->
        :ok
    end)

    if not Hub.online_user?(user_id, @vault_namespace), do: refresh_user_presence(user_id)
    :ok
  end

  def namespace_disconnected(_user_id, _rooms), do: :ok

  defp emit_chat_message(event, intent) do
    with channel_id when is_binary(channel_id) <- field(intent, :channelId),
         {source_vault_id, source_channel_id} <- source_route(field(intent, :vaultId), channel_id),
         message when is_map(message) <- field(intent, :message) do
      if countable_message?(message),
        do: community_changed_for_channel(source_vault_id, source_channel_id)

      dispatches = field(intent, :dispatches) || []

      Channel.list_routes(source_vault_id, source_channel_id, :message)
      |> Enum.each(fn route ->
        projected_message = put_field(message, :channelId, route.localChannelId)
        projected_dispatches = project_dispatches(dispatches, route)

        payload = %{
          vaultId: route.localVaultId,
          channelId: route.localChannelId,
          message: projected_message
        }

        payload =
          if projected_dispatches == [],
            do: payload,
            else: Map.put(payload, :dispatches, projected_dispatches)

        vault_event(route.localVaultId, event, payload)
      end)
    else
      _ -> :ok
    end
  end

  defp emit_chat_deleted(intent) do
    with channel_id when is_binary(channel_id) <- field(intent, :channelId),
         message_id when is_binary(message_id) <- field(intent, :messageId),
         {source_vault_id, source_channel_id} <- source_route(field(intent, :vaultId), channel_id) do
      community_changed_for_channel(source_vault_id, source_channel_id)

      Channel.list_routes(source_vault_id, source_channel_id)
      |> Enum.each(fn route ->
        vault_event(route.localVaultId, @chat_deleted, %{
          vaultId: route.localVaultId,
          channelId: route.localChannelId,
          messageId: message_id
        })
      end)
    else
      _ -> :ok
    end
  end

  defp emit_chat_agent(event, intent) do
    with channel_id when is_binary(channel_id) <- field(intent, :channelId),
         {source_vault_id, source_channel_id} <- source_route(field(intent, :vaultId), channel_id) do
      base = drop_fields(intent, [:event, :vaultId, :channelId])

      Channel.list_routes(source_vault_id, source_channel_id)
      |> Enum.each(fn route ->
        payload =
          base
          |> Map.put(:vaultId, route.localVaultId)
          |> Map.put(:channelId, route.localChannelId)

        vault_event(route.localVaultId, event, payload)
      end)
    else
      _ -> :ok
    end
  end

  defp participant_left(intent) do
    case field(intent, :route) do
      route when is_map(route) ->
        user_id = field(intent, :userId)
        source_vault_id = field(route, :sourceVaultId)
        source_channel_id = field(route, :sourceChannelId)
        local_vault_id = field(route, :localVaultId)
        local_channel_id = field(route, :localChannelId)

        if is_integer(user_id),
          do: Hub.evict_user(user_id, @vault_namespace, "chat:#{source_channel_id}")

        vault_event(local_vault_id, "vault:noteDeleted", %{
          noteId: local_channel_id,
          vaultId: local_vault_id
        })

        emit_presence(source_vault_id, source_channel_id)

      _ ->
        :ok
    end
  end

  defp participant_removed(intent) do
    participant = field(intent, :participant) || %{}
    local_channel_id = field(participant, :channelId)
    user_id = field(participant, :userId)

    case {field(participant, :sourceVaultId), field(participant, :sourceChannelId)} do
      {source_vault_id, source_channel_id}
      when is_binary(source_vault_id) and is_binary(source_channel_id) ->
        if is_integer(user_id),
          do: Hub.evict_user(user_id, @vault_namespace, "chat:#{source_channel_id}")

        local_vault_id = field(participant, :localVaultId) || field(intent, :vaultId)

        vault_event(local_vault_id, "vault:noteDeleted", %{
          noteId: local_channel_id,
          vaultId: local_vault_id
        })

        emit_presence(source_vault_id, source_channel_id)

      _ ->
        :ok
    end
  end

  defp emit_vault_intent(event, intent) do
    case field(intent, :vaultId) do
      vault_id when is_binary(vault_id) ->
        vault_event(vault_id, event, drop_fields(intent, [:event]))

      _ ->
        :ok
    end
  end

  defp presence_payload(source_vault_id, source_channel_id, reason) do
    snapshot = Channel.participant_snapshot(source_vault_id, source_channel_id)

    :telemetry.execute(
      [:cascade, :realtime, :presence_snapshot],
      %{count: 1},
      %{reason: reason}
    )

    online =
      snapshot.users
      |> Enum.filter(&Hub.online_user?(&1.id, @vault_namespace))
      |> Enum.map(& &1.username)
      |> Enum.uniq()
      |> Enum.sort_by(&String.downcase/1)

    %{
      online: online,
      participants: snapshot.participants,
      owner: snapshot.owner,
      profiles: snapshot.profiles
    }
  rescue
    _ -> nil
  end

  defp presence_channels_for_user(user_id) do
    SQL.all(
      """
      SELECT n.vault_id,n.id FROM notes n JOIN vaults v ON v.id=n.vault_id
      WHERE v.created_by=? AND n.content LIKE 'cascade://chat-channel%'
      UNION
      SELECT link.source_vault_id,link.source_channel_id FROM chat_channel_links link
      JOIN vaults v ON v.id=link.local_vault_id WHERE v.created_by=?
      """,
      [user_id, user_id]
    )
  rescue
    _ -> []
  end

  defp source_route(vault_id, channel_id) do
    if not is_binary(channel_id), do: throw(:invalid_channel_id)

    case SQL.one(
           """
           SELECT COALESCE(link.source_vault_id,note.vault_id),
                  COALESCE(link.source_channel_id,note.id),note.vault_id
           FROM notes note LEFT JOIN chat_channel_links link ON link.local_channel_id=note.id
           WHERE note.id=? LIMIT 1
           """,
           [channel_id]
         ) do
      [source_vault_id, source_channel_id, local_vault_id]
      when is_nil(vault_id) or vault_id == local_vault_id ->
        {source_vault_id, source_channel_id}

      _ ->
        :error
    end
  rescue
    _ -> :error
  catch
    :invalid_channel_id -> :error
  end

  defp project_dispatches(dispatches, route) when is_list(dispatches) do
    owner_id =
      case SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.localVaultId]) do
        [id] -> id
        _ -> nil
      end

    dispatches
    |> Enum.filter(fn dispatch ->
      registration = field(dispatch, :registration) || %{}

      field(registration, :ownerUserId) == owner_id or
        truthy?(field(registration, :pingableByOthers))
    end)
    |> Enum.map(fn dispatch ->
      projected = put_field(dispatch, :channelId, route.localChannelId)

      case field(dispatch, :message) do
        message when is_map(message) ->
          put_field(projected, :message, put_field(message, :channelId, route.localChannelId))

        _ ->
          projected
      end
    end)
  end

  defp project_dispatches(_dispatches, _route), do: []

  defp countable_message?(message) do
    agent_id = field(message, :agentId)
    status = field(message, :status) |> to_string()
    body = field(message, :body) |> to_string() |> String.trim()

    is_nil(agent_id) or agent_id == "" or
      (status not in ["sending", "running"] and body not in ["", "Thinking..."])
  end

  defp reconcile_vault_room(vault_id) do
    authorized_user_ids =
      SQL.all("SELECT user_id FROM vault_members WHERE vault_id=?", [vault_id])
      |> List.flatten()
      |> MapSet.new()

    Hub.room_members("vault:#{vault_id}", @vault_namespace)
    |> Enum.each(fn sid ->
      case Hub.user_id_for_session(sid, @vault_namespace) do
        user_id when is_integer(user_id) ->
          if not MapSet.member?(authorized_user_ids, user_id),
            do: Hub.leave(sid, @vault_namespace, "vault:#{vault_id}")

        _ ->
          Hub.leave(sid, @vault_namespace, "vault:#{vault_id}")
      end
    end)
  end

  defp profile_audience(user_id) do
    SQL.all(
      """
      WITH my_sources(source_channel_id) AS (
        SELECT DISTINCT COALESCE(link.source_channel_id,local.id)
        FROM notes local
        JOIN vault_members membership ON membership.vault_id=local.vault_id AND membership.user_id=?
        LEFT JOIN chat_channel_links link ON link.local_channel_id=local.id
        WHERE local.content_preview LIKE 'cascade://chat-channel%'
           OR local.content LIKE 'cascade://chat-channel%'
      ), audience_vaults(vault_id) AS (
        SELECT vault_id FROM vault_members WHERE user_id=?
        UNION SELECT source.vault_id FROM notes source JOIN my_sources mine ON mine.source_channel_id=source.id
        UNION SELECT link.local_vault_id FROM chat_channel_links link JOIN my_sources mine ON mine.source_channel_id=link.source_channel_id
      )
      SELECT DISTINCT member.user_id FROM audience_vaults audience
      JOIN vault_members member ON member.vault_id=audience.vault_id
      UNION SELECT ?
      """,
      [user_id, user_id, user_id]
    )
    |> List.flatten()
    |> Enum.filter(&is_integer/1)
    |> Enum.uniq()
  rescue
    _ -> [user_id]
  end

  defp broadcast_user(user_id, event, payload),
    do: Hub.broadcast("user:#{user_id}", @vault_namespace, event, [payload])

  defp users_for_names(participants, full \\ false)
  defp users_for_names([], _full), do: []

  defp users_for_names(participants, full) do
    placeholders = Enum.map_join(participants, ",", fn _ -> "?" end)

    columns =
      if full,
        do: "id,username,display_name,avatar_url",
        else: "id,username"

    SQL.all("SELECT #{columns} FROM users WHERE username IN (#{placeholders})", participants)
    |> Enum.map(fn
      [id, username] -> {id, username}
      [id, username, display_name, avatar_url] -> {id, username, display_name, avatar_url}
    end)
  rescue
    _ -> []
  end

  defp field(map, key) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  defp field(_map, _key), do: nil

  defp put_field(map, key, value) when is_map(map) do
    string = Atom.to_string(key)

    if Map.has_key?(map, string),
      do: map |> Map.delete(key) |> Map.put(string, value),
      else: map |> Map.delete(string) |> Map.put(key, value)
  end

  defp drop_fields(map, keys) do
    Enum.reduce(keys, map, fn key, acc ->
      acc |> Map.delete(key) |> Map.delete(Atom.to_string(key))
    end)
  end

  defp truthy?(value), do: value in [true, 1, "1"]
end
