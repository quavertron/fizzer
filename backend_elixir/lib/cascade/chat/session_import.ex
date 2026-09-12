defmodule Cascade.Chat.SessionImport do
  @moduledoc "Owner-scoped, idempotent import of locally selected Codex conversation pages."
  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Events, OrderedPublisher}

  def import(user, vault_id, input) do
    with true <- VaultMembers.role(vault_id, user.id) in ["owner", "editor"],
         {:ok, session_id} <- Ecto.UUID.cast(input["id"]),
         messages when is_list(messages) and length(messages) <= 1000 <- input["messages"] do
      unless Enum.all?(messages, &valid_message?/1), do: raise("Invalid imported messages")
      key = :crypto.hash(:sha256, "#{user.id}:#{vault_id}:#{session_id}") |> Base.encode16(case: :lower)
      channel_id = "codex-import-#{key}"
      conversation = "codex-import:#{key}"
      OrderedPublisher.mutate(fn ->
        SQL.transaction(fn ->
          {channel, registration} = ensure_channel(user, vault_id, channel_id, conversation, session_id, input)
          following = is_nil(SQL.one("SELECT 1 FROM runs r JOIN run_events e ON e.run_id=r.id WHERE r.conversation_id=? AND r.vault_id=? AND r.chat_dispatch_id IS NOT NULL AND e.type='session' LIMIT 1", [conversation, vault_id]))
          paused = not is_nil(SQL.one("SELECT 1 FROM runs WHERE conversation_id=? AND vault_id=? AND status IN ('queued','running') LIMIT 1", [conversation, vault_id]))
          Enum.each(if(following and not paused, do: messages, else: []), fn item ->
            id = "#{channel_id}:#{item["index"]}"
            unless SQL.one("SELECT 1 FROM chat_messages WHERE id=?", [id]) do
              params = %{id: id, body: item["body"], createdAt: item["createdAt"]}
              params = if item["role"] == "assistant", do: Map.merge(params, %{author: registration.displayName, agentId: "codex", registrationId: registration.id}), else: params
              {:ok, message} = Messages.create(user, vault_id, channel_id, params, access: if(item["role"] == "assistant", do: :agent, else: :user))
              Events.emit(%{event: "vault:chatMessageCreated", vaultId: vault_id, channelId: channel_id, message: message})
            end
          end)
          {:ok, %{channelId: channel.id, title: channel.title, following: following, paused: paused}}
        end)
      end)
    else
      _ -> {:error, "A valid session and an editable vault are required"}
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp valid_message?(m) when is_map(m) do
    is_integer(m["index"]) and m["index"] >= 0 and m["role"] in ["user", "assistant"] and
      is_binary(m["body"]) and byte_size(m["body"]) <= 1_048_576 and
      is_binary(m["createdAt"]) and match?({:ok, _, _}, DateTime.from_iso8601(m["createdAt"]))
  end
  defp valid_message?(_), do: false

  defp ensure_channel(user, vault, id, conversation, session, input) do
    case SQL.one("SELECT title,created_by,vault_id FROM notes WHERE id=?", [id]) do
      [title, owner, ^vault] when owner == user.id ->
        {:ok, members} = Agents.list_members(id, user.id)
        registration = Enum.find(members, &(&1.conversationId == conversation)) || raise("Imported agent was removed")
        {%{id: id, title: title}, registration}
      nil ->
        channel = Store.create_note(vault, user.id, %{id: id, title: String.slice(to_string(input["title"] || "Codex session"), 0, 120), content: "cascade://chat-channel"})
        {:ok, identity} = Agents.upsert_identity(user.id, vault, %{agentId: "codex", displayName: "Codex", mention: "codex-#{String.slice(id, -12, 12)}", cwd: input["cwd"] || ""})
        {:ok, registration} = Agents.add_to_channel(user.id, vault, id, identity.id, %{conversationId: conversation, replyToEveryMessage: true})
        SQL.exec("INSERT INTO runs (vault_id,owner_user_id,prompt,agent,conversation_id,session_id,status,finished_at,summary) VALUES (?,?,?,'codex',?,?,'completed',datetime('now'),?)",
          [vault, user.id, "Imported Codex session", conversation, session, "Imported history; execution remains on the owner's computer."])
        {channel, registration}
      _ -> raise("Imported channel is not owned by this account")
    end
  end
end
