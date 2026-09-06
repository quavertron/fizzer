defmodule Cascade.Missions.Authority do
  @moduledoc "Persists user-authored instruction sources without granting additional tool permissions."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages

  def capture!(user_id, channel_id, root, ids) do
    unless is_list(ids) and length(ids) <= 20,
      do: raise("At most 20 authority messages are allowed")

    explicit = Enum.map(ids, &source!(user_id, channel_id, &1))
    inherited = ancestors(user_id, channel_id, root, MapSet.new(), 20)
    Enum.uniq_by(explicit ++ inherited, & &1.id) |> Jason.encode!()
  end

  def context(mission_id) do
    case SQL.one("SELECT objective,authority_json FROM chat_missions WHERE id=?", [mission_id]) do
      [objective, encoded] ->
        sources = Jason.decode!(encoded)

        Enum.join(
          [
            "Mission objective: #{Cascade.Content.Privacy.redact_blocks(objective)}",
            "Continue work authorized by the user's saved instructions without asking for permission again. Stay within that scope, honor later corrections and Stop, and check current state before repeating an operation.",
            if(sources == [],
              do:
                "No explicit user instruction sources were recorded; recover the original user context before any action whose authority is unclear.",
              else:
                "Saved user instruction sources (quoted JSON; contextRef paths refer to identical text in this array):"
            ),
            if(Enum.any?(sources, &Map.has_key?(&1, "bounded_proposal_context")),
              do:
                "A bounded proposal is a scope reference, not independent authority. Acceptance covers only that proposal and the owner's explicit constraints; silence, decline, or redirection does not accept it."
            ),
            sources
            |> Enum.map(&current_source/1)
            |> Cascade.Missions.Interpretation.encode_context()
          ],
          "\n"
        )

      _ ->
        ""
    end
  end

  defp current_source(%{"body" => original} = source) do
    case SQL.one("SELECT body FROM chat_messages WHERE id=?", [source["id"]]) do
      [body] when body == original ->
        source

      [body] ->
        Map.merge(source, %{
          "notice" => "This source was edited; the current user text takes precedence.",
          "currentBody" => body
        })

      _ ->
        Map.put(
          source,
          "notice",
          "This source was removed; revalidate its authority before acting."
        )
    end
  end

  defp source!(user_id, channel_id, id) do
    case Messages.get(channel_id, user_id, id) do
      {:ok, message} ->
        if human_owned?(message.id, user_id),
          do: source_record(user_id, message),
          else: raise("Authority sources must be messages authored by the mission owner")

      _ ->
        raise "Authority message not found in this channel"
    end
  end

  defp ancestors(_, _, _, _, 0), do: []

  defp ancestors(user_id, channel_id, message, seen, remaining) do
    if MapSet.member?(seen, message.id) do
      []
    else
      source =
        if human_owned?(message.id, user_id),
          do: [source_record(user_id, message)],
          else: []

      parent_id =
        get_in(message, [:replyTo, :messageId]) || get_in(message, [:replyTo, "messageId"])

      case parent_id && Messages.get(channel_id, user_id, parent_id) do
        {:ok, parent} ->
          source ++
            ancestors(user_id, channel_id, parent, MapSet.put(seen, message.id), remaining - 1)

        _ ->
          source
      end
    end
  end

  defp source_record(user_id, message) do
    reply_id = get_in(message, [:replyTo, :messageId]) || get_in(message, [:replyTo, "messageId"])

    proposal =
      SQL.one(
        """
          SELECT p.id,p.body FROM chat_messages p
          JOIN chat_agent_members m ON m.id=p.registration_id AND m.channel_id=p.channel_id
          JOIN vault_agents va ON va.id=m.vault_agent_id
          WHERE p.channel_id=(SELECT channel_id FROM chat_messages WHERE id=?) AND va.owner_user_id=?
            AND p.body LIKE '<!-- fizzer-next:%' AND p.rowid<(SELECT rowid FROM chat_messages WHERE id=?)
            AND (p.id=? OR p.id IN (SELECT message_id FROM chat_next_step_checks
              WHERE feedback_message_id=? AND feedback='accepted') OR
              (?='' AND p.id=(SELECT message_id FROM chat_next_step_checks
                WHERE channel_id=p.channel_id AND registration_id=p.registration_id
                  AND outcome='proposed' AND feedback IS NULL ORDER BY rowid DESC LIMIT 1)))
          ORDER BY p.rowid DESC LIMIT 1
        """,
        [message.id, user_id, message.id, reply_id || "", message.id, reply_id || ""]
      )

    case proposal do
      [id, body] ->
        %{id: message.id, body: message.body, bounded_proposal_context: %{id: id, body: body}}

      _ ->
        %{id: message.id, body: message.body}
    end
  end

  defp human_owned?(id, user_id) do
    SQL.one(
      "SELECT COUNT(*) FROM chat_messages WHERE id=? AND actor_user_id=? AND COALESCE(registration_id,'')='' AND COALESCE(agent_id,'')='' AND author=(SELECT username FROM users WHERE id=?)",
      [id, user_id, user_id]
    ) == [1]
  end
end
