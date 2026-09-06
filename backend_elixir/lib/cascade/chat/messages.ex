defmodule Cascade.Chat.Messages do
  @moduledoc "Canonical chat message persistence with linked-channel projection and transactional mutations."

  alias Cascade.Accounts.{DirectMessages, SQL, VaultMembers}
  alias Cascade.Chat.Channel
  alias Cascade.Content.{Privacy, Store}
  alias Cascade.Evolution

  @relationships ~w(builds_on review_request question contradiction decision)
  @list_columns "id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,registration_id,run_id,blocks_json,images_json,attachments_json,reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id,rowid,CASE WHEN harness_log IS NOT NULL AND length(harness_log)>0 THEN 1 ELSE 0 END"
  @full_columns "id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id,rowid,CASE WHEN harness_log IS NOT NULL AND length(harness_log)>0 THEN 1 ELSE 0 END"

  def list(channel_id, user_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      detail = Keyword.get(opts, :detail, :list)
      limit = opts |> Keyword.get(:limit, 120) |> number(120) |> trunc() |> max(1) |> min(500)
      columns = if detail == :full, do: @full_columns, else: @list_columns

      {cutoff, params} =
        case {Keyword.get(opts, :before_seq), Keyword.get(opts, :through_message_id)} do
          {seq, _} when is_integer(seq) and seq > 0 ->
            {" AND rowid < ?", [route.sourceChannelId, seq, limit]}

          {_, nil} ->
            {"", [route.sourceChannelId, limit]}

          {_, id} ->
            {" AND rowid <= (SELECT rowid FROM chat_messages WHERE id=? AND channel_id=?)",
             [route.sourceChannelId, id, route.sourceChannelId, limit]}
        end

      messages =
        SQL.all(
          "SELECT #{columns} FROM chat_messages WHERE channel_id=? AND id NOT LIKE 'sys-next-%'#{cutoff} ORDER BY rowid DESC LIMIT ?",
          params
        )
        |> Enum.reverse()
        |> Enum.map(&row_to_message(&1, detail, route.localChannelId))

      visible = Enum.reject(messages, &terminal_shell?/1)

      if Keyword.get(opts, :page, false) do
        cursor =
          case messages do
            [first | _] -> first.seq
            _ -> nil
          end

        has_more =
          cursor != nil and
            SQL.one(
              "SELECT 1 FROM chat_messages WHERE channel_id=? AND id NOT LIKE 'sys-next-%' AND rowid < ? LIMIT 1",
              [route.sourceChannelId, cursor]
            ) != nil

        {:ok, %{messages: visible, beforeSeq: cursor, hasMore: has_more}}
      else
        {:ok, visible}
      end
    end
  end

  def get(channel_id, user_id, message_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      fetch(route, message_id)
    end
  end

  def create(user, vault_id, channel_id, input, opts \\ []) do
    access = Keyword.get(opts, :access, :user)

    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         :ok <- dm_allowed(route.sourceChannelId, user.id),
         {:ok, attribution} <- attribution(user, route, input, access),
         :ok <- relationship_allowed(input) do
      message = normalized_message(input, route.sourceChannelId, attribution, user.id)

      SQL.transaction(fn ->
        with :ok <- authorize_repost(user, route, message, access),
             :ok <- validate_content(message) do
          insert_message(route, message)
          refresh_note_grants(user.id, vault_id, route.sourceChannelId, message)
          index_backlinks(route, message)
          {:ok, fetch!(route, message.id)}
        end
      end)
    end
  rescue
    error in Exqlite.Error -> {:error, sqlite_message(error)}
  end

  def update(user, vault_id, channel_id, message_id, patch, opts \\ []) do
    access = Keyword.get(opts, :access, :user)

    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id) do
      SQL.transaction(fn ->
        with {:ok, existing} <- fetch(route, message_id),
             :ok <- authorize_edit(user, existing, patch, access) do
          next = merge_patch(existing, patch, access)
          updated = persist!(route, next)
          refresh_note_grants(user.id, vault_id, route.sourceChannelId, next)
          Evolution.tombstone_chat_message_backlinks(message_id)
          index_backlinks(route, next)
          {:ok, updated}
        end
      end)
    end
  end

  def delete(user, vault_id, channel_id, message_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id) do
      SQL.transaction(fn ->
        with {:ok, message} <- fetch(route, message_id),
             :ok <- authorize_delete(user, route, message),
             :ok <-
               if(Keyword.get(opts, :queued_only, false) and message[:status] != "queued",
                 do: {:error, "Run already started; use Stop run."},
                 else: :ok
               ),
             :ok <- cancel_pending_reply(message) do
          SQL.exec("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
            message_id,
            route.sourceChannelId
          ])

          Evolution.tombstone_chat_message_backlinks(message_id)
          {:ok, route}
        end
      end)
    end
  end

  def forward(user, from_channel_id, message_id, to_vault_id, to_channel_id, comment \\ "") do
    with {:ok, source} <- get(from_channel_id, user.id, message_id),
         {:ok, _target} <- Channel.assert_vault_channel(to_vault_id, to_channel_id, user.id),
         false <- from_channel_id == to_channel_id,
         true <- forwardable?(source) do
      name =
        case SQL.one("SELECT title FROM notes WHERE id=?", [from_channel_id]) do
          [title] -> title
          _ -> "channel"
        end

      body =
        if String.trim(to_string(comment)) == "",
          do: source.body,
          else: String.trim(to_string(comment)) <> "\n\n" <> source.body

      create(user, to_vault_id, to_channel_id, %{
        body: body,
        images: source[:images],
        attachments: source[:attachments],
        forwardedFrom: %{
          messageId: source.id,
          channelId: from_channel_id,
          channelName: name,
          author: source.author,
          createdAt: source.createdAt
        }
      })
    else
      true -> {:error, "Cannot forward a message into the same channel"}
      false -> {:error, "Nothing to forward"}
      {:error, _} = error -> error
    end
  end

  def embeds(channel_id, user_id, message_id, opts \\ []) do
    agent? = Keyword.get(opts, :access) == :agent

    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, _message} <- fetch(route, message_id) do
      notes =
        SQL.all(
          """
          SELECT g.note_id,COALESCE(g.title_snapshot,n.title),g.content_snapshot,
            COALESCE(g.preview_snapshot,n.content_preview),n.vault_id
          FROM chat_note_grants g JOIN notes n ON n.id=g.note_id
          WHERE g.channel_id=? AND g.message_id=? ORDER BY 2 COLLATE NOCASE
          """,
          [route.sourceChannelId, message_id]
        )
        |> Enum.map(fn [id, title, snapshot, preview, note_vault_id] ->
          note =
            cond do
              is_binary(snapshot) and snapshot != "" ->
                %{id: id, title: title, content: snapshot, content_preview: preview || ""}

              VaultMembers.role(note_vault_id, user_id) ->
                live_or_preview(id, title, preview)

              true ->
                %{id: id, title: title, content: preview || "", content_preview: preview || ""}
            end

          Privacy.redact_note(note, agent?)
        end)

      {:ok, notes}
    end
  end

  def approve(user_id, channel_id, message_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         request when is_map(request) <- message[:changeRequest],
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      approvals =
        request
        |> map_value("approvals", [])
        |> Enum.reject(&(map_value(&1, "userId") == user_id))

      next =
        Map.put(
          request,
          key_style(request, "approvals"),
          approvals ++ [%{userId: user_id, username: username}]
        )

      updated = Map.put(message, :changeRequest, next)
      persist(route, updated)
    else
      nil -> {:error, "Message is not a change request"}
      _ -> {:error, "Change request not found"}
    end
  end

  def merge(user_id, channel_id, message_id, merger \\ &default_merge/2) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         [^user_id, root] <-
           SQL.one("SELECT created_by,root_path FROM vaults WHERE id=?", [route.sourceVaultId]),
         {:ok, message} <- fetch(route, message_id),
         request when is_map(request) <- message[:changeRequest],
         :ok <- merge_available(request),
         {:ok, ref} <- valid_ref(request),
         cwd <- channel_cwd(route.sourceChannelId, root),
         :ok <- normalize_merge_result(merger.(cwd, ref)),
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      request = request |> put_flexible("mergedAt", now()) |> put_flexible("mergedBy", username)
      updated = Map.put(message, :changeRequest, request)
      persist(route, updated)
    else
      [_other, _root] -> {:error, "Only the repository owner can merge"}
      {:error, _} = error -> error
      nil -> {:error, "Change request is unavailable"}
      _ -> {:error, "Change request not found"}
    end
  end

  def answer_clarification(user_id, channel_id, message_id, answers) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         clarification when is_map(clarification) <- message[:clarification],
         "pending" <- map_value(clarification, "status", "pending") do
      by_id =
        Map.new(answers || [], fn item ->
          {to_string(map_value(item, "id", "")),
           item
           |> map_value("answer", "")
           |> to_string()
           |> String.trim()
           |> String.slice(0, 4000)}
        end)

      questions =
        clarification
        |> map_value("questions", [])
        |> Enum.map(fn question ->
          id = to_string(map_value(question, "id", ""))

          if Map.has_key?(by_id, id),
            do: put_flexible(question, "answer", by_id[id]),
            else: question
        end)

      next = put_flexible(clarification, "questions", questions)
      updated = Map.put(message, :clarification, next)
      persist(route, updated)
    else
      nil -> {:error, "Message is not a clarification"}
      "accepted" -> {:error, "Clarification is already closed"}
      "canceled" -> {:error, "Clarification is already closed"}
      {:error, _} = error -> error
      _ -> {:error, "Message not found"}
    end
  end

  def accept_clarification(user_id, channel_id, message_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         clarification when is_map(clarification) <- message[:clarification],
         :ok <- clarification_open(clarification),
         {:ok, contract} <- clarification_contract(clarification),
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      title =
        opts
        |> Keyword.get(:title, map_value(clarification, "title", "Contract"))
        |> to_string()
        |> String.trim()
        |> String.slice(0, 240)
        |> nonblank("Contract")

      token_budget =
        opts
        |> Keyword.get(:token_budget, map_value(clarification, "tokenBudget", 0))
        |> number(0)
        |> trunc()
        |> max(0)

      work_item_id = Ecto.UUID.generate()

      updated =
        clarification
        |> put_flexible("status", "accepted")
        |> put_flexible("workItemId", work_item_id)
        |> put_flexible("tokenBudget", token_budget)
        |> put_flexible("acceptedAt", now())
        |> put_flexible("acceptedBy", username)

      result =
        SQL.transaction(fn ->
          SQL.exec(
            """
            INSERT INTO work_items(id,vault_id,channel_id,title,brief,source_kind,source_id,
              assignee_registration_id,branch,workspace_mode,verification,contract,token_budget,created_by)
            VALUES(?,?,?,?,?,'contract',?,?,?,'isolated',?,?,?,?)
            """,
            [
              work_item_id,
              route.sourceVaultId,
              route.sourceChannelId,
              title,
              message.body || "",
              message_id,
              blank_to_nil(map_value(clarification, "assigneeRegistrationId", "")),
              "cascade/contract/" <> String.slice(message_id, 0, 8),
              "Drive until completed, token budget hit, or manually stopped.",
              contract,
              token_budget,
              user_id
            ]
          )

          persist!(route, Map.put(message, :clarification, updated))
        end)

      {:ok,
       %{
         message: result,
         workItemId: work_item_id,
         missionId: nil,
         contract: contract,
         title: title,
         tokenBudget: token_budget
       }}
    else
      nil -> {:error, "Message is not a clarification"}
      {:error, _} = error -> error
      _ -> {:error, "Message not found"}
    end
  end

  def refresh_note_grants(user_id, local_vault_id, source_channel_id, message) do
    SQL.exec("DELETE FROM chat_note_grants WHERE message_id=? AND granted_by=?", [
      message.id,
      user_id
    ])

    ~r/!\[\[([^\]\n]+)\]\]/u
    |> Regex.scan(message.body || "", capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(fn raw ->
      raw
      |> String.split("|", parts: 2)
      |> hd()
      |> String.split("#", parts: 2)
      |> hd()
      |> String.trim()
    end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq_by(&String.downcase/1)
    |> Enum.each(fn title ->
      case SQL.one(
             "SELECT id,title,content,content_preview FROM notes WHERE vault_id=? AND title=? COLLATE NOCASE AND is_archived=0 ORDER BY updated_at DESC LIMIT 1",
             [local_vault_id, title]
           ) do
        [id, stored_title, content, preview] ->
          note = Store.get_note(id)

          SQL.exec(
            """
            INSERT OR IGNORE INTO chat_note_grants(message_id,channel_id,note_id,granted_by,title_snapshot,content_snapshot,preview_snapshot)
            VALUES(?,?,?,?,?,?,?)
            """,
            [
              message.id,
              source_channel_id,
              id,
              user_id,
              (note && note.title) || stored_title,
              (note && note.content) || content || "",
              String.slice((note && note.content_preview) || preview || "", 0, 400)
            ]
          )

        _ ->
          :ok
      end
    end)

    :ok
  end

  defp insert_message(route, message) do
    message = Cascade.Chat.NextSteps.prepare(message, route.sourceChannelId)
    activity = if countable?(message), do: now(), else: nil

    SQL.exec(
      """
      INSERT INTO chat_messages(id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,
        status,agent_id,registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,
        reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        author=excluded.author,body=excluded.body,created_at=excluded.created_at,
        activity_at=COALESCE(chat_messages.activity_at,excluded.activity_at),actor_user_id=excluded.actor_user_id,
        status=excluded.status,agent_id=excluded.agent_id,registration_id=excluded.registration_id,run_id=excluded.run_id,
        blocks_json=excluded.blocks_json,harness_log=excluded.harness_log,images_json=excluded.images_json,
        attachments_json=excluded.attachments_json,reply_to_json=excluded.reply_to_json,
        forwarded_from_json=excluded.forwarded_from_json,change_request_json=excluded.change_request_json,
        clarification_json=excluded.clarification_json,mission_json=excluded.mission_json,mission_task_id=excluded.mission_task_id
      """,
      message_params(route, message, activity)
    )
  end

  defp persist(route, message) do
    message = Cascade.Chat.NextSteps.prepare(message, route.sourceChannelId)
    activity = if countable?(message), do: now(), else: nil

    rows =
      SQL.exec(
        """
        UPDATE chat_messages SET author=?,body=?,created_at=?,activity_at=COALESCE(activity_at,?),status=?,agent_id=?,
          registration_id=?,run_id=?,blocks_json=?,harness_log=?,images_json=?,attachments_json=?,reply_to_json=?,
          forwarded_from_json=?,change_request_json=?,clarification_json=?,mission_json=?,mission_task_id=?
        WHERE id=? AND channel_id=?
        RETURNING #{@full_columns}
        """,
        [
          message.author,
          message.body,
          message.createdAt,
          activity,
          message[:status],
          message[:agentId],
          message[:registrationId],
          message[:runId],
          encode(message[:blocks]),
          message[:harnessLog],
          encode(message[:images]),
          encode(message[:attachments]),
          encode(message[:replyTo]),
          encode(message[:forwardedFrom]),
          encode(message[:changeRequest]),
          encode(message[:clarification]),
          encode(message[:mission]),
          message[:missionTaskId],
          message.id,
          route.sourceChannelId
        ]
      )
      |> Map.fetch!(:rows)

    case rows do
      [row] -> {:ok, row_to_message(row, :full, route.localChannelId)}
      [] -> {:error, "Message not found"}
    end
  end

  defp persist!(route, message) do
    case persist(route, message) do
      {:ok, value} -> value
      {:error, reason} -> raise reason
    end
  end

  defp message_params(route, message, activity) do
    [
      message.id,
      route.sourceChannelId,
      route.sourceVaultId,
      message.author,
      message.body,
      message.createdAt,
      activity,
      message[:actorUserId],
      message[:status],
      message[:agentId],
      message[:registrationId],
      message[:runId],
      encode(message[:blocks]),
      message[:harnessLog],
      encode(message[:images]),
      encode(message[:attachments]),
      encode(message[:replyTo]),
      encode(message[:forwardedFrom]),
      encode(message[:changeRequest]),
      encode(message[:clarification]),
      encode(message[:mission]),
      message[:missionTaskId]
    ]
  end

  defp normalized_message(input, source_channel_id, attribution, actor_user_id) do
    change = normalize_change(map_value(input, "changeRequest"))
    clarification = normalize_clarification(map_value(input, "clarification"))

    %{
      id:
        map_value(input, "id", "")
        |> to_string()
        |> String.trim()
        |> nonblank(Ecto.UUID.generate()),
      channelId: source_channel_id,
      author: attribution.author,
      body: map_value(input, "body", "") |> to_string(),
      createdAt: map_value(input, "createdAt", "") |> to_string() |> nonblank(now()),
      actorUserId: actor_user_id,
      status: nilable(map_value(input, "status")),
      agentId: attribution.agent_id,
      registrationId: attribution.registration_id,
      runId: map_value(input, "runId"),
      blocks: map_value(input, "blocks"),
      harnessLog: nilable(map_value(input, "harnessLog")),
      images: list_or_nil(map_value(input, "images")),
      attachments: list_or_nil(map_value(input, "attachments")),
      replyTo: normalize_reply(map_value(input, "replyTo")),
      forwardedFrom: map_value(input, "forwardedFrom"),
      changeRequest: change,
      clarification: clarification,
      mission: map_value(input, "mission"),
      missionTaskId: nilable(map_value(input, "missionTaskId"))
    }
  end

  defp attribution(user, route, input, :agent) do
    registration_id = map_value(input, "registrationId", "") |> to_string() |> String.trim()
    user_id = user.id

    if registration_id == "" do
      author = input |> map_value("author", "") |> to_string() |> String.trim()
      agent_id = input |> map_value("agentId") |> nilable() || "agent"

      if author == "" do
        {:error, "Author is required"}
      else
        {:ok, %{author: author, agent_id: agent_id, registration_id: nil}}
      end
    else
      case SQL.one(
             """
               SELECT m.display_name,m.agent_id,va.owner_user_id FROM chat_agent_members m
               JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=? AND m.channel_id=?
             """,
             [registration_id, route.sourceChannelId]
           ) do
        [display_name, agent_id, ^user_id] ->
          {:ok,
           %{
             author: nonblank(String.trim(display_name || ""), agent_id),
             agent_id: agent_id,
             registration_id: registration_id
           }}

        [_name, _agent, _owner] ->
          {:error, "Only an agent owner can post as that agent"}

        _ ->
          {:error, "Agent registration is required"}
      end
    end
  end

  defp attribution(_user, _route, input, :system) do
    author = input |> map_value("author", "Cascade") |> to_string() |> String.trim()
    {:ok, %{author: nonblank(author, "Cascade"), agent_id: nil, registration_id: nil}}
  end

  defp attribution(user, _route, _input, _access),
    do: {:ok, %{author: user.username, agent_id: nil, registration_id: nil}}

  defp authorize_repost(user, route, message, access) do
    case SQL.one(
           "SELECT channel_id,author,actor_user_id,agent_id,registration_id FROM chat_messages WHERE id=?",
           [message.id]
         ) do
      nil ->
        :ok

      [channel_id, author, actor_user_id, agent_id, registration_id] ->
        existing = %{
          id: message.id,
          author: author,
          actorUserId: actor_user_id,
          agentId: agent_id,
          registrationId: registration_id
        }

        cond do
          channel_id != route.sourceChannelId ->
            {:error, "Message ID belongs to another channel"}

          not owned_message?(user, existing) ->
            {:error, "You can only edit your own messages"}

          access == :agent and is_nil(existing[:agentId]) and is_nil(existing[:registrationId]) ->
            {:error, "Agents cannot edit human messages"}

          Enum.any?([:author, :agentId, :registrationId], &(message[&1] != existing[&1])) ->
            {:error, "Cannot reassign message identity"}

          true ->
            :ok
        end
    end
  end

  defp owned_message?(user, message) do
    cond do
      not is_nil(message[:actorUserId]) ->
        message.actorUserId == user.id

      not is_nil(message[:registrationId]) ->
        SQL.one(
          """
          SELECT va.owner_user_id FROM chat_agent_members m
          JOIN vault_agents va ON va.id=m.vault_agent_id
          JOIN chat_messages cm ON cm.channel_id=m.channel_id AND cm.registration_id=m.id
          WHERE cm.id=? AND (cm.agent_id IS NULL OR cm.agent_id=m.agent_id)
          """,
          [message.id]
        ) == [user.id]

      is_nil(message[:agentId]) ->
        message.author == user.username

      true ->
        false
    end
  end

  defp authorize_edit(user, existing, patch, :agent) do
    cond do
      is_nil(existing[:agentId]) and is_nil(existing[:registrationId]) ->
        {:error, "Agents cannot edit human messages"}

      not owned_message?(user, existing) ->
        {:error, "You can only edit your own messages"}

      Enum.any?([:author, :agentId, :registrationId, :actorUserId], fn key ->
        case fetch_value(patch, Atom.to_string(key)) do
          {:ok, value} -> value != existing[key]
          :error -> false
        end
      end) ->
        {:error, "Agents cannot reassign message identity"}

      true ->
        :ok
    end
  end

  defp authorize_edit(user, existing, _patch, _access),
    do:
      if(existing.author == user.username and owned_message?(user, existing),
        do: :ok,
        else: {:error, "You can only edit your own messages"}
      )

  defp cancel_pending_reply(%{id: "agent-dispatch-" <> id, status: "queued"} = message) do
    if SQL.changes(
         "UPDATE chat_agent_dispatches SET failed_at=datetime('now'),error='Canceled before startup.' WHERE id=? AND run_id IS NULL AND NOT EXISTS (SELECT 1 FROM runs WHERE chat_dispatch_id=chat_agent_dispatches.id)",
         [id]
       ) > 0 or
         (is_nil(message[:runId]) and
            is_nil(SQL.one("SELECT 1 FROM chat_agent_dispatches WHERE id=?", [id])) and
            is_nil(SQL.one("SELECT 1 FROM runs WHERE chat_dispatch_id=?", [id]))),
       do: :ok,
       else: {:error, "Run already started; use Stop run."}
  end

  defp cancel_pending_reply(_message), do: :ok

  defp authorize_delete(user, route, message) do
    host =
      case SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.sourceVaultId]) do
        [id] -> id
        _ -> nil
      end

    pending_requester =
      case message.id do
        "agent-dispatch-" <> id when message.status == "queued" ->
          SQL.one(
            "SELECT requester_user_id FROM chat_agent_dispatches WHERE id=? AND run_id IS NULL",
            [id]
          ) == [user.id]

        _ ->
          false
      end

    if host == user.id or owned_message?(user, message) or pending_requester,
      do: :ok,
      else: {:error, "You can only delete your own messages"}
  end

  defp merge_patch(existing, patch, :agent) do
    Enum.reduce(
      [
        "body",
        "createdAt",
        "status",
        "runId",
        "blocks",
        "harnessLog",
        "images",
        "attachments",
        "replyTo",
        "changeRequest",
        "clarification"
      ],
      existing,
      fn key, acc ->
        case fetch_value(patch, key) do
          {:ok, value} -> Map.put(acc, atom_key(key), value)
          :error -> acc
        end
      end
    )
  end

  defp merge_patch(existing, patch, _access) do
    Enum.reduce(["body", "images", "attachments", "replyTo"], existing, fn key, acc ->
      case fetch_value(patch, key) do
        {:ok, value} -> Map.put(acc, atom_key(key), value)
        :error -> acc
      end
    end)
  end

  defp row_to_message(
         [
           id,
           _channel,
           _vault,
           author,
           body,
           created_at,
           activity_at,
           actor_user_id,
           status,
           agent_id,
           registration_id,
           run_id,
           blocks,
           harness_log,
           images,
           attachments,
           reply_to,
           forwarded,
           change,
           clarification,
           mission,
           mission_task_id,
           rowid,
           has_harness
         ],
         :full,
         local_channel_id
       ) do
    build_message(
      %{
        id: id,
        author: author,
        body: body,
        created_at: created_at,
        activity_at: activity_at,
        actor_user_id: actor_user_id,
        status: status,
        agent_id: agent_id,
        registration_id: registration_id,
        run_id: run_id,
        blocks: blocks,
        harness_log: harness_log,
        images: images,
        attachments: attachments,
        reply_to: reply_to,
        forwarded: forwarded,
        change: change,
        clarification: clarification,
        mission: mission,
        mission_task_id: mission_task_id,
        rowid: rowid,
        has_harness: has_harness
      },
      :full,
      local_channel_id
    )
  end

  defp row_to_message(
         [
           id,
           _channel,
           _vault,
           author,
           body,
           created_at,
           activity_at,
           actor_user_id,
           status,
           agent_id,
           registration_id,
           run_id,
           blocks,
           images,
           attachments,
           reply_to,
           forwarded,
           change,
           clarification,
           mission,
           mission_task_id,
           rowid,
           has_harness
         ],
         :list,
         local_channel_id
       ) do
    build_message(
      %{
        id: id,
        author: author,
        body: body,
        created_at: created_at,
        activity_at: activity_at,
        actor_user_id: actor_user_id,
        status: status,
        agent_id: agent_id,
        registration_id: registration_id,
        run_id: run_id,
        blocks: blocks,
        harness_log: nil,
        images: images,
        attachments: attachments,
        reply_to: reply_to,
        forwarded: forwarded,
        change: change,
        clarification: clarification,
        mission: mission,
        mission_task_id: mission_task_id,
        rowid: rowid,
        has_harness: has_harness
      },
      :list,
      local_channel_id
    )
  end

  defp build_message(row, detail, local_channel_id) do
    images = decode(row.images, [])

    blocks = decode(row.blocks)

    %{
      id: row.id,
      channelId: local_channel_id,
      author: row.author,
      body: row.body,
      createdAt: row.created_at,
      activityAt: row.activity_at,
      actorUserId: row.actor_user_id,
      status: row.status,
      agentId: row.agent_id,
      registrationId: row.registration_id,
      runId: row.run_id,
      blocks: if(detail == :list, do: truncate_blocks(blocks), else: blocks),
      harnessLog: row.harness_log,
      attachments: nil_if_empty(decode(row.attachments, [])),
      replyTo: decode(row.reply_to),
      forwardedFrom: decode(row.forwarded),
      changeRequest: decode(row.change),
      clarification: decode(row.clarification),
      mission: decode(row.mission),
      missionTaskId: row.mission_task_id,
      seq: row.rowid
    }
    |> reject_nil_values()
    |> maybe_put(:hasHarness, row.has_harness != 0, true)
    |> put_images(images, detail)
  end

  defp put_images(message, [], _detail), do: message

  defp put_images(message, images, :full), do: Map.put(message, :images, images)

  defp put_images(message, images, :list) do
    light =
      Enum.filter(images, fn image ->
        is_binary(image) and not String.starts_with?(image, "data:") and byte_size(image) < 2_048
      end)

    cond do
      length(light) == length(images) -> Map.put(message, :images, light)
      light == [] -> Map.put(message, :hasImages, true)
      true -> message |> Map.put(:images, light) |> Map.put(:hasImages, true)
    end
  end

  defp maybe_put(message, key, actual, expected) do
    if actual == expected, do: Map.put(message, key, actual), else: message
  end

  defp normalize_reply(nil), do: nil

  defp normalize_reply(reply) when is_map(reply) do
    relationship = map_value(reply, "relationship")

    if relationship in @relationships,
      do: reply,
      else: if(is_nil(relationship), do: reply, else: nil)
  end

  defp normalize_reply(_), do: nil

  defp relationship_allowed(input) do
    case map_value(map_value(input, "replyTo", %{}), "relationship") do
      nil -> :ok
      relationship when relationship in @relationships -> :ok
      _ -> {:error, "Invalid chat relationship"}
    end
  end

  defp normalize_change(nil), do: nil

  defp normalize_change(value) when is_map(value) do
    files =
      value
      |> map_value("files", [])
      |> Enum.take(100)
      |> Enum.map(fn file ->
        %{
          path: file |> map_value("path", "") |> to_string() |> String.slice(0, 500),
          additions: file |> map_value("additions", 0) |> number(0) |> floor_nonnegative(),
          deletions: file |> map_value("deletions", 0) |> number(0) |> floor_nonnegative()
        }
      end)
      |> Enum.reject(&(&1.path == ""))

    %{files: files, approvals: []}
    |> maybe_put(:commit, value |> map_value("commit", "") |> to_string() |> String.slice(0, 80))
    |> maybe_put(:ref, value |> map_value("ref", "") |> to_string() |> String.slice(0, 200))
  end

  defp normalize_change(_), do: nil

  defp normalize_clarification(nil), do: nil

  defp normalize_clarification(value) when is_map(value) do
    questions =
      value
      |> map_value("questions", [])
      |> Enum.take(3)
      |> Enum.with_index()
      |> Enum.map(fn {question, index} ->
        kind = map_value(question, "kind", map_value(question, "type", "text")) |> to_string()
        kind = if kind in ~w(text single multi), do: kind, else: "text"

        options =
          map_value(question, "options", [])
          |> List.wrap()
          |> Enum.map(&(to_string(&1) |> String.trim() |> String.slice(0, 200)))
          |> Enum.reject(&(&1 == ""))
          |> Enum.take(8)

        answer =
          map_value(question, "answer", map_value(question, "default", ""))
          |> to_string()
          |> String.trim()
          |> String.slice(0, 4000)

        answer =
          if answer == "" and kind == "single" and options != [], do: hd(options), else: answer

        %{
          id: map_value(question, "id", "q#{index + 1}") |> to_string() |> String.slice(0, 80),
          prompt: map_value(question, "prompt", "") |> to_string() |> String.slice(0, 2000),
          kind: kind,
          options: options,
          answer: answer
        }
      end)

    %{
      title: map_value(value, "title", "Clarification") |> to_string() |> String.slice(0, 240),
      status: "pending",
      questions: questions,
      tokenBudget: map_value(value, "tokenBudget", 0) |> number(0) |> trunc() |> max(0)
    }
    |> maybe_put(
      :assigneeRegistrationId,
      map_value(value, "assigneeRegistrationId", "") |> to_string() |> String.slice(0, 80)
    )
  end

  defp normalize_clarification(_), do: nil

  defp index_backlinks(route, message) do
    Evolution.index_chat_message_backlinks(route.sourceVaultId, route.sourceChannelId, %{
      id: message.id,
      author: message.author,
      body: message.body,
      createdAt: message.createdAt
    })
  rescue
    _ -> :ok
  end

  defp live_or_preview(id, title, preview) do
    case Store.get_note(id) do
      nil ->
        %{id: id, title: title, content: preview || "", content_preview: preview || ""}

      note ->
        %{
          id: note.id,
          title: note.title,
          content: note.content || "",
          content_preview: note.content_preview || ""
        }
    end
  end

  defp dm_allowed(channel_id, user_id) do
    case DirectMessages.assert_send_allowed(channel_id, user_id) do
      :ok -> :ok
      {:error, message} -> {:error, message}
    end
  rescue
    _ -> :ok
  end

  defp merge_available(request) do
    cond do
      map_value(request, "mergedAt") -> {:error, "Change request is unavailable"}
      map_value(request, "approvals", []) == [] -> {:error, "At least one approval is required"}
      true -> :ok
    end
  end

  defp valid_ref(request) do
    ref =
      map_value(request, "ref", map_value(request, "commit", "")) |> to_string() |> String.trim()

    if ref != "" and not String.starts_with?(ref, "-") and not String.contains?(ref, "..") and
         Regex.match?(~r{^[A-Za-z0-9_./-]+$}, ref),
       do: {:ok, ref},
       else: {:error, "Change request has an invalid git ref"}
  end

  defp channel_cwd(channel_id, root) do
    case SQL.one("SELECT cwd FROM chat_channel_settings WHERE channel_id=?", [channel_id]) do
      [cwd] when is_binary(cwd) and cwd != "" -> String.trim(cwd)
      _ -> root
    end
  end

  defp default_merge(cwd, ref) do
    case System.cmd("git", ["-C", cwd, "merge", "--ff-only", ref], stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {output, _} -> {:error, String.trim(output)}
    end
  end

  defp normalize_merge_result(:ok), do: :ok
  defp normalize_merge_result({:ok, _}), do: :ok
  defp normalize_merge_result({:error, reason}), do: {:error, to_string(reason)}
  defp normalize_merge_result(other), do: {:error, "Merge failed: #{inspect(other)}"}

  defp clarification_open(value) do
    status = map_value(value, "status", "pending")
    work_item_id = map_value(value, "workItemId")

    case status do
      "accepted" when not is_nil(work_item_id) ->
        {:error, "Clarification is already accepted"}

      "canceled" ->
        {:error, "Clarification was canceled"}

      _ ->
        :ok
    end
  end

  defp clarification_contract(value) do
    questions = map_value(value, "questions", [])

    unanswered =
      Enum.count(questions, &(String.trim(to_string(map_value(&1, "answer", ""))) == ""))

    if unanswered > 0,
      do: {:error, "Answer all questions first (#{unanswered} remaining)"},
      else:
        {:ok,
         questions
         |> Enum.with_index(1)
         |> Enum.map_join("\n\n", fn {q, i} ->
           "Q#{i}: #{map_value(q, "prompt", "")}\nA#{i}: #{String.trim(to_string(map_value(q, "answer", "")))}"
         end)}
  end

  defp countable?(message),
    do:
      not String.starts_with?(message.id, "sys-next-") and
        (is_nil(message[:agentId]) or
           (message[:status] not in ["sending", "running"] and
              String.trim(message.body || "") not in ["", "Thinking..."]))

  @doc false
  def terminal_shell?(message) do
    body =
      message
      |> map_value("body", "")
      |> to_string()
      |> String.replace(~r/<!--\s*fizzer-next(?:-none|-feedback)?:[^<>]*?(?:-->|$)/, "")
      |> String.trim()

    agent? =
      Enum.any?(~w(agentId registrationId runId), &(map_value(message, &1) not in [nil, ""]))

    map_value(message, "status") not in ~w(queued sending running failed) and
      (body == "" or (agent? and body in ["Thinking...", "Thinking…", "Queued..."])) and
      not Enum.any?(
        ~w(mission clarification changeRequest images attachments hasImages hasHarness),
        &(map_value(message, &1) not in [nil, false, [], %{}])
      ) and
      String.trim(to_string(map_value(message, "harnessLog", ""))) == "" and
      not Enum.any?(List.wrap(map_value(message, "blocks")), fn block ->
        map_value(block, "type") in ~w(tool_use tool_result) or
          map_value(block, "redacted") == true or
          String.trim(to_string(map_value(block, "text", ""))) != ""
      end)
  end

  defp validate_content(message) do
    # Internal carriers retain identity for linked system work; they are not prose.
    if terminal_shell?(message) and not String.starts_with?(message.id, ["sys-", "agent-trace-"]),
      do: {:error, "Message must contain text, media or a card"},
      else: :ok
  end

  defp forwardable?(message),
    do:
      String.trim(message.body || "") != "" or List.wrap(message[:images]) != [] or
        List.wrap(message[:attachments]) != []

  defp fetch(route, message_id) do
    case SQL.one("SELECT #{@full_columns} FROM chat_messages WHERE id=? AND channel_id=?", [
           message_id,
           route.sourceChannelId
         ]) do
      nil -> {:error, "Message not found"}
      row -> {:ok, row_to_message(row, :full, route.localChannelId)}
    end
  end

  defp fetch!(route, message_id) do
    case fetch(route, message_id) do
      {:ok, value} -> value
      {:error, message} -> raise message
    end
  end

  defp encode(nil), do: nil
  defp encode(value), do: Jason.encode!(value)
  defp decode(value, fallback \\ nil)
  defp decode(nil, fallback), do: fallback
  defp decode("", fallback), do: fallback

  defp decode(value, fallback) do
    case Jason.decode(value) do
      {:ok, decoded} -> decoded
      _ -> fallback
    end
  end

  defp truncate_blocks(nil), do: nil

  defp truncate_blocks(blocks) when is_list(blocks),
    do:
      Enum.map(blocks, fn block ->
        if is_binary(map_value(block, "text")) and String.length(map_value(block, "text")) > 2_000,
          do:
            put_flexible(block, "text", String.slice(map_value(block, "text"), 0, 1_999) <> "…"),
          else: block
      end)

  defp truncate_blocks(value), do: value
  defp nil_if_empty([]), do: nil
  defp nil_if_empty(value), do: value
  defp reject_nil_values(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
  defp list_or_nil(value) when is_list(value), do: value
  defp list_or_nil(_), do: nil
  defp nilable(nil), do: nil
  defp nilable(""), do: nil
  defp nilable(value), do: value
  defp map_value(value, key, fallback \\ nil)
  defp map_value(nil, _key, fallback), do: fallback

  defp map_value(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp map_value(_value, _key, fallback), do: fallback

  defp fetch_value(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} -> {:ok, value}
      :error -> Map.fetch(map, String.to_atom(key))
    end
  end

  defp fetch_value(_, _), do: :error
  defp atom_key("createdAt"), do: :createdAt
  defp atom_key("runId"), do: :runId
  defp atom_key("harnessLog"), do: :harnessLog
  defp atom_key("replyTo"), do: :replyTo
  defp atom_key("changeRequest"), do: :changeRequest
  defp atom_key(key), do: String.to_atom(key)
  defp key_style(map, key), do: if(Map.has_key?(map, key), do: key, else: String.to_atom(key))
  defp put_flexible(map, key, value), do: Map.put(map, key_style(map, key), value)
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp number(value, _fallback) when is_number(value), do: value

  defp number(value, fallback) when is_binary(value) do
    case Float.parse(value) do
      {number, _} -> number
      :error -> fallback
    end
  end

  defp number(_, fallback), do: fallback
  defp floor_nonnegative(value), do: value |> Float.floor() |> trunc() |> max(0)
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value
  defp blank_to_nil(""), do: nil
  defp blank_to_nil(value), do: value
  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp sqlite_message(error), do: Exception.message(error)
end
