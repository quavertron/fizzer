defmodule Cascade.Accounts.CommunityActivity do
  @moduledoc "Canonical membership-scoped activity inbox and per-source read watermarks."

  alias Cascade.Accounts.SQL

  @marker "cascade://chat-channel"
  @default_limit 60
  @max_limit 100
  @count_cap 99
  @total_cap 999
  @max_channels 200

  def seed_existing_as_read! do
    if SQL.table_exists?("chat_channel_links") do
      at = DateTime.utc_now() |> DateTime.to_iso8601()

      SQL.transaction(fn ->
        Enum.each(SQL.all("SELECT id FROM users"), fn [user_id] ->
          Enum.each(accessible_routes(user_id), fn route ->
            write_read_state(user_id, "channel", route.source_channel_id, at)
          end)
        end)
      end)
    end

    :ok
  end

  def record_note_change(
        note_id,
        actor_user_id,
        changed_at \\ DateTime.utc_now() |> DateTime.to_iso8601(),
        content_change \\ nil
      ) do
    mentioned = added_mentions(note_id, actor_user_id, content_change)

    SQL.exec(
      "INSERT INTO community_note_activity (note_id,actor_user_id,changed_at,mentioned_user_ids) VALUES (?,?,?,?)",
      [note_id, actor_user_id, changed_at, Jason.encode!(mentioned)]
    )

    :ok
  end

  defp added_mentions(note_id, actor_user_id, {before, after_content}) do
    added = MapSet.difference(mention_names(after_content), mention_names(before))

    SQL.all(
      """
      SELECT member.user_id,u.username FROM notes n
      JOIN vault_members member ON member.vault_id=n.vault_id
      JOIN users u ON u.id=member.user_id
      JOIN vault_members actor ON actor.vault_id=n.vault_id AND actor.user_id=?
      WHERE n.id=? AND member.user_id!=? AND n.is_archived=0
        AND n.content NOT LIKE 'cascade://chat-channel%'
      """,
      [actor_user_id, note_id, actor_user_id]
    )
    |> Enum.filter(fn [_id, username] -> MapSet.member?(added, String.downcase(username)) end)
    |> Enum.map(&hd/1)
  end

  defp added_mentions(_, _, _), do: []

  # Use the existing Markdown parser so code and link destinations never become mentions.
  defp mention_names(content) do
    content
    |> String.replace(~r/\\@/, " ")
    |> String.replace(~r/\[\[[^\]\n]*\]\]/, " ")
    |> MDEx.parse_document!()
    |> mention_text()
    |> Enum.flat_map(fn text ->
      text = String.replace(text, ~r/https?:\/\/[^\s<>]+/, " ")

      Regex.scan(
        ~r/(?<![\p{L}\p{N}_@\\.\/:+%?=&#-])@([A-Za-z0-9_][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/u,
        text
      )
      |> Enum.map(fn [_, name] -> String.downcase(name) end)
    end)
    |> MapSet.new()
  end

  defp mention_text(%MDEx.Text{literal: text}), do: [text]
  defp mention_text(%MDEx.Image{}), do: []
  defp mention_text(%MDEx.Link{}), do: []
  defp mention_text(%{nodes: nodes}), do: Enum.flat_map(nodes, &mention_text/1)
  defp mention_text(_), do: []

  def list(user, requested_limit \\ @default_limit, include_agent_memory \\ false) do
    limit = bounded_limit(requested_limit)

    {channel_items, channel_counts} = channel_updates(user)
    {note_items, note_counts} = note_updates(user, include_agent_memory)

    items =
      Enum.sort_by(channel_items ++ note_items, &{timestamp_millis(&1.timestamp), &1.id}, :desc)

    counts = merge_counts(channel_counts, note_counts)
    visible = Enum.take(items, limit)

    groups =
      Enum.reduce(visible, [], fn item, groups ->
        case Enum.find_index(groups, &(&1.vaultId == item.vaultId)) do
          nil ->
            groups ++
              [
                %{
                  vaultId: item.vaultId,
                  vaultName: item.vaultName,
                  unreadCount: Map.get(counts.byVault, item.vaultId, 0),
                  items: [item]
                }
              ]

          index ->
            List.update_at(groups, index, fn group -> %{group | items: group.items ++ [item]} end)
        end
      end)

    %{
      groups: groups,
      counts: counts,
      truncated: length(items) > length(visible) or length(items) >= @max_limit
    }
  end

  def mark_read(user_id, target_id, at \\ DateTime.utc_now() |> DateTime.to_iso8601()) do
    channel =
      accessible_routes(user_id, false)
      |> Enum.find(&(&1.local_channel_id == target_id or &1.source_channel_id == target_id))

    cond do
      channel ->
        write_read_state(user_id, "channel", channel.source_channel_id, at)
        true

      accessible_note?(user_id, target_id) ->
        write_read_state(user_id, "note", target_id, at)
        true

      true ->
        false
    end
  end

  def mark_all_read(user_id, at \\ DateTime.utc_now() |> DateTime.to_iso8601()) do
    SQL.transaction(fn ->
      Enum.each(accessible_routes(user_id), fn route ->
        write_read_state(user_id, "channel", route.source_channel_id, at)
      end)

      SQL.all(
        """
        SELECT n.id FROM notes n JOIN vault_members membership ON membership.vault_id=n.vault_id
          AND membership.user_id=? WHERE n.is_archived=0 AND n.is_listed=1
          AND (SELECT COUNT(*) FROM vault_members members WHERE members.vault_id=n.vault_id)>1
          AND n.content_preview NOT LIKE 'cascade://chat-channel%'
          AND n.content NOT LIKE 'cascade://chat-channel%'
        """,
        [user_id]
      )
      |> Enum.each(fn [note_id] -> write_read_state(user_id, "note", note_id, at) end)
    end)

    :ok
  end

  def accessible_routes(user_id, canonical_only \\ true) do
    if SQL.table_exists?("chat_channel_links") do
      rows =
        SQL.all(
          """
          SELECT local.id,local.vault_id,local.title,local_vault.name,
            COALESCE(link.source_channel_id,local.id),
            CASE WHEN julianday(COALESCE(link.created_at,membership.created_at))>julianday(membership.created_at)
              THEN link.created_at ELSE membership.created_at END,
            (SELECT COUNT(*) FROM vault_members source_members
              WHERE source_members.vault_id=COALESCE(link.source_vault_id,local.vault_id)),
            (SELECT COUNT(*) FROM chat_channel_links siblings
              WHERE siblings.source_channel_id=COALESCE(link.source_channel_id,local.id)),
            local.content_preview,local.content,source.content_preview,source.content
          FROM notes local JOIN vaults local_vault ON local_vault.id=local.vault_id
          JOIN vault_members membership ON membership.vault_id=local.vault_id AND membership.user_id=?
          LEFT JOIN chat_channel_links link ON link.local_channel_id=local.id
          JOIN notes source ON source.id=COALESCE(link.source_channel_id,local.id)
          WHERE local.is_archived=0 AND source.is_archived=0
            AND (local.content_preview LIKE 'cascade://chat-channel%' OR local.content LIKE 'cascade://chat-channel%')
            AND (source.content_preview LIKE 'cascade://chat-channel%' OR source.content LIKE 'cascade://chat-channel%')
          ORDER BY (local.id=COALESCE(link.source_channel_id,local.id)) DESC,
            julianday(COALESCE(link.created_at,membership.created_at)) ASC,local.id ASC LIMIT ?
          """,
          [user_id, @max_channels * 4]
        )
        |> Enum.map(&map_route/1)
        |> Enum.filter(
          &(chat_marker?(&1.local_preview, &1.local_content) and
              chat_marker?(&1.source_preview, &1.source_content))
        )
        |> Enum.filter(&(&1.member_count > 1 or &1.link_count > 0))

      if canonical_only, do: canonicalize(rows), else: rows
    else
      []
    end
  end

  defp channel_updates(user) do
    routes = accessible_routes(user.id, false)
    targets = Enum.group_by(routes, & &1.source_channel_id, & &1.local_channel_id)

    Enum.reduce(canonicalize(routes), {[], empty_counts()}, fn route, {items, counts} ->
      watermark = read_at(user.id, "channel", route.source_channel_id, route.subscribed_at)

      unread =
        SQL.all(
          """
          SELECT message.id,message.author,COALESCE(NULLIF(author_user.display_name,''),message.author),
            message.body,COALESCE(message.activity_at,message.created_at),message.reply_to_json
          FROM chat_messages message
          LEFT JOIN users author_user ON author_user.username=message.author COLLATE NOCASE
          LEFT JOIN chat_agent_members member ON member.id=message.registration_id
          LEFT JOIN vault_agents agent ON agent.id=member.vault_agent_id
          WHERE message.channel_id=?
            AND julianday(COALESCE(message.activity_at,message.created_at))>julianday(?)
            AND message.author!=? COLLATE NOCASE
            AND COALESCE(message.actor_user_id,agent.owner_user_id,-1)!=?
            AND NOT (COALESCE(message.agent_id,'')!='' AND COALESCE(message.status,'') IN ('sending','running'))
            AND NOT (COALESCE(message.agent_id,'')!='' AND trim(message.body) IN ('','Thinking...'))
          ORDER BY julianday(COALESCE(message.activity_at,message.created_at)) DESC,message.rowid DESC LIMIT ?
          """,
          [route.source_channel_id, watermark, user.username, user.id, @count_cap + 1]
        )

      unread_count = min(length(unread), @count_cap)

      if unread_count == 0 do
        {items, counts}
      else
        # Every linked tab must be able to acknowledge the shared unread state.
        # Inbox items and totals still count each source only once.
        counts =
          Enum.reduce(
            Map.fetch!(targets, route.source_channel_id),
            increment_channel_counts(counts, route, unread_count),
            fn target_id, acc -> put_target(acc, target_id, unread_count) end
          )

        new_items =
          unread |> Enum.take(@max_limit) |> Enum.map(&map_message(&1, route, user.username))

        {items ++ new_items, counts}
      end
    end)
  end

  defp note_updates(user, include_agent_memory) do
    rows =
      SQL.all(
        """
        SELECT n.id,n.vault_id,v.name,n.title,n.content_preview,u.username,
          COALESCE(NULLIF(u.display_name,''),u.username),activity.changed_at,activity.id,
          EXISTS (SELECT 1 FROM json_each(activity.mentioned_user_ids) WHERE value=membership.user_id)
        FROM community_note_activity activity JOIN notes n ON n.id=activity.note_id
        JOIN vaults v ON v.id=n.vault_id
        JOIN vault_members membership ON membership.vault_id=n.vault_id AND membership.user_id=?
        JOIN users u ON u.id=activity.actor_user_id
        LEFT JOIN community_read_state state ON state.user_id=? AND state.source_type='note' AND state.source_id=n.id
        WHERE activity.actor_user_id!=? AND n.is_archived=0 AND n.is_listed=1
          AND (?=1 OR n.folder_id NOT IN (
            WITH RECURSIVE agent_folders(id) AS (
              SELECT id FROM folders WHERE vault_id=n.vault_id AND parent_id IS NULL AND name='_agent'
              UNION ALL SELECT child.id FROM folders child JOIN agent_folders parent ON child.parent_id=parent.id
            ) SELECT id FROM agent_folders))
          AND (SELECT COUNT(*) FROM vault_members members WHERE members.vault_id=n.vault_id)>1
          AND activity.id=(SELECT newer.id FROM community_note_activity newer
            WHERE newer.note_id=n.id AND newer.actor_user_id!=?
            ORDER BY (julianday(newer.changed_at)>julianday(COALESCE(state.read_at,membership.created_at))
              AND EXISTS (SELECT 1 FROM json_each(newer.mentioned_user_ids) WHERE value=membership.user_id)) DESC,
              julianday(newer.changed_at) DESC,newer.id DESC LIMIT 1)
          AND julianday(activity.changed_at)>julianday(COALESCE(state.read_at,membership.created_at))
          AND n.content_preview NOT LIKE 'cascade://chat-channel%'
          AND n.content NOT LIKE 'cascade://chat-channel%'
        ORDER BY julianday(activity.changed_at) DESC,activity.id DESC LIMIT ?
        """,
        [
          user.id,
          user.id,
          user.id,
          if(include_agent_memory, do: 1, else: 0),
          user.id,
          @max_limit + 1
        ]
      )

    Enum.reduce(rows, {[], empty_counts()}, fn
      [
        note_id,
        vault_id,
        vault_name,
        title,
        preview,
        actor,
        actor_name,
        changed_at,
        activity_id,
        mentioned
      ],
      {items, counts} ->
        item = %{
          id: "note:#{note_id}:#{activity_id}",
          kind: if(mentioned == 1, do: "mention", else: "note"),
          vaultId: vault_id,
          vaultName: vault_name,
          targetId: note_id,
          targetTitle: title,
          sourceId: note_id,
          actor: actor,
          actorDisplayName: actor_name,
          preview: compact_preview(preview, "Note changed"),
          timestamp: changed_at
        }

        counts =
          counts
          |> increment_total(1)
          |> increment_map(:byVault, vault_id, 1)
          |> put_target(note_id, 1)

        {items ++ [item], counts}
    end)
  end

  defp map_message([id, author, actor_name, body, activity_at, reply_json], route, username) do
    reply = decode_map(reply_json)

    kind =
      cond do
        mentions?(body, username) -> "mention"
        reply_to_user?(reply, username) -> "reply"
        true -> "message"
      end

    %{
      id: "message:#{id}",
      kind: kind,
      vaultId: route.local_vault_id,
      vaultName: route.vault_name,
      targetId: route.local_channel_id,
      targetTitle: route.local_title,
      sourceId: route.source_channel_id,
      messageId: id,
      actor: author,
      actorDisplayName: actor_name || author,
      preview: compact_preview(body, "Shared an update"),
      timestamp: activity_at
    }
  end

  defp increment_channel_counts(counts, route, amount) do
    counts
    |> increment_total(amount)
    |> maybe_increment_dm(route, amount)
    |> increment_map(:byVault, route.local_vault_id, amount)
    |> put_target(route.local_channel_id, amount)
  end

  defp maybe_increment_dm(counts, route, amount) do
    if dm_route?(route),
      do: %{counts | directMessages: min(@count_cap, counts.directMessages + amount)},
      else: counts
  end

  defp increment_total(counts, amount),
    do: %{counts | total: min(@total_cap, counts.total + amount)}

  defp increment_map(counts, key, id, amount) do
    updated = Map.update(counts[key], id, min(@count_cap, amount), &min(@count_cap, &1 + amount))
    Map.put(counts, key, updated)
  end

  defp put_target(counts, id, amount),
    do: put_in(counts, [:byTarget, id], min(@count_cap, amount))

  defp merge_counts(left, right) do
    %{
      total: min(@total_cap, left.total + right.total),
      directMessages: min(@count_cap, left.directMessages + right.directMessages),
      byVault: merge_count_maps(left.byVault, right.byVault),
      byTarget: merge_count_maps(left.byTarget, right.byTarget)
    }
  end

  defp merge_count_maps(left, right) do
    Map.merge(left, right, fn _key, a, b -> min(@count_cap, a + b) end)
  end

  defp empty_counts, do: %{total: 0, directMessages: 0, byVault: %{}, byTarget: %{}}

  defp accessible_note?(user_id, note_id) do
    case SQL.one(
           """
           SELECT n.content_preview,n.content FROM notes n
           JOIN vault_members membership ON membership.vault_id=n.vault_id AND membership.user_id=?
           WHERE n.id=? AND n.is_archived=0 AND n.is_listed=1
           """,
           [user_id, note_id]
         ) do
      [preview, content] -> not chat_marker?(preview, content)
      nil -> false
    end
  end

  defp write_read_state(user_id, type, source_id, at) do
    SQL.exec(
      """
      INSERT INTO community_read_state (user_id,source_type,source_id,read_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id,source_type,source_id) DO UPDATE SET read_at=CASE
        WHEN julianday(excluded.read_at)>julianday(read_at) THEN excluded.read_at ELSE read_at END
      """,
      [user_id, type, source_id, at]
    )
  end

  defp read_at(user_id, type, source_id, fallback) do
    case SQL.one(
           "SELECT read_at FROM community_read_state WHERE user_id=? AND source_type=? AND source_id=?",
           [user_id, type, source_id]
         ) do
      [read_at] when read_at not in [nil, ""] -> read_at
      _ -> fallback
    end
  end

  defp canonicalize(routes) do
    routes
    |> Enum.reduce({[], MapSet.new()}, fn route, {result, seen} ->
      cond do
        MapSet.size(seen) >= @max_channels -> {result, seen}
        MapSet.member?(seen, route.source_channel_id) -> {result, seen}
        true -> {result ++ [route], MapSet.put(seen, route.source_channel_id)}
      end
    end)
    |> elem(0)
  end

  defp map_route([
         local_id,
         local_vault_id,
         local_title,
         vault_name,
         source_id,
         subscribed_at,
         member_count,
         link_count,
         local_preview,
         local_content,
         source_preview,
         source_content
       ]) do
    %{
      local_channel_id: local_id,
      local_vault_id: local_vault_id,
      local_title: local_title,
      vault_name: vault_name,
      source_channel_id: source_id,
      subscribed_at: subscribed_at,
      member_count: member_count,
      link_count: link_count,
      local_preview: local_preview || "",
      local_content: local_content || "",
      source_preview: source_preview || "",
      source_content: source_content || ""
    }
  end

  defp chat_marker?(preview, content) do
    String.starts_with?(String.trim(preview || ""), @marker) or
      String.starts_with?(String.trim(content || ""), @marker)
  end

  defp dm_route?(route) do
    Enum.any?(
      [route.local_preview, route.local_content, route.source_preview, route.source_content],
      &Regex.match?(~r/(?:^|\n)dm_with=/, &1)
    )
  end

  defp mentions?(body, username) do
    escaped = Regex.escape(username)
    Regex.match?(Regex.compile!("(^|[^a-z0-9_])@#{escaped}(?![a-z0-9_])", "i"), body || "")
  end

  defp reply_to_user?(reply, username) do
    normalized = String.downcase(username)
    author = reply |> Map.get("author", "") |> to_string() |> String.downcase()

    mention =
      reply
      |> Map.get("mention", "")
      |> to_string()
      |> String.replace(~r/^@/, "")
      |> String.downcase()

    author == normalized or mention == normalized
  end

  defp decode_map(nil), do: %{}

  defp decode_map(value) do
    case Jason.decode(value) do
      {:ok, map} when is_map(map) -> map
      _ -> %{}
    end
  end

  defp compact_preview(value, fallback) do
    compact = value |> to_string() |> String.replace(~r/\s+/, " ") |> String.trim()
    if(compact == "", do: fallback, else: compact) |> String.slice(0, 180)
  end

  defp bounded_limit(value) when is_integer(value), do: value |> max(1) |> min(@max_limit)
  defp bounded_limit(value) when is_float(value), do: value |> trunc() |> bounded_limit()
  defp bounded_limit(_value), do: @default_limit

  defp timestamp_millis(value) do
    normalized =
      if Regex.match?(~r/^\d{4}-\d{2}-\d{2} \d{2}:/, value || ""),
        do: String.replace(value, " ", "T") <> "Z",
        else: value

    case DateTime.from_iso8601(normalized || "") do
      {:ok, datetime, _offset} -> DateTime.to_unix(datetime, :millisecond)
      _ -> 0
    end
  end
end
