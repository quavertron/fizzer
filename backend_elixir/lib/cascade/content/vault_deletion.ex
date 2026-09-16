defmodule Cascade.Content.VaultDeletion do
  @moduledoc "Narrow agent deletion authority from a current owner-authored mission instruction."
  alias Cascade.Content.{Query, Store}

  # Deliberately accept only complete imperative requests, never arbitrary prose
  # containing a vault name or the word delete. Other wording fails closed.
  @request ~r/\A(?:please )?(?:add a way to delete vaults and )?delete (?:the )?(.+?) vault(?: for me)?[.!]?\z/iu

  def delete(user_id, run_id, target_id, expected_name, source_id) do
    # Serialize authority/target checks with deletion and all other app writes.
    Cascade.DB.WriteCoordinator.with_lock(fn ->
      with {run_id, ""} <- Integer.parse(to_string(run_id || "")),
           [current_id, channel_id, authority] <-
             Query.one(
               """
               SELECT r.vault_id,m.channel_id,m.authority_json FROM runs r
               JOIN chat_mission_tasks t ON t.run_id=r.id
               JOIN chat_missions m ON m.id=t.mission_id
               WHERE r.id=? AND r.owner_user_id=? AND r.status='running'
                 AND t.status='running' AND m.created_by=? AND m.status='active'
                 AND m.vault_id=r.vault_id
               """,
               [run_id, user_id, user_id]
             ),
           true <- current_id != target_id,
           %{name: ^expected_name, created_by: ^user_id} = target <-
             Store.get_vault(target_id, user_id),
           [body, created_at] <- owner_instruction(user_id, channel_id, source_id),
           {:ok, sources} when is_list(sources) <- Jason.decode(authority),
           true <- Enum.any?(sources, &(&1["id"] == source_id and &1["body"] == body)),
           [_, requested] <- Regex.run(@request, String.trim(body)),
           [^target_id] <- matching_targets(user_id, requested),
           # An old instruction cannot authorize a newly created replacement.
           [1] <-
             Query.one("SELECT julianday(created_at)<=julianday(?) FROM vaults WHERE id=?", [
               created_at,
               target.id
             ]),
           [0] <-
             Query.one(
               "SELECT COUNT(*) FROM runs WHERE vault_id=? AND status IN ('queued','running')",
               [target_id]
             ),
           [0] <-
             Query.one(
               "SELECT COUNT(*) FROM chat_missions WHERE vault_id=? AND status NOT IN ('completed','canceled')",
               [target_id]
             ) do
        if Store.delete_vault(target_id, user_id), do: :ok, else: {:error, :denied}
      else
        _ -> {:error, :denied}
      end
    end)
  end

  defp owner_instruction(user_id, channel_id, source_id) do
    # Any later human instruction invalidates this capability, including Stop.
    Query.one(
      """
      SELECT body,created_at FROM chat_messages
      WHERE id=? AND channel_id=? AND actor_user_id=?
        AND COALESCE(agent_id,'')='' AND COALESCE(registration_id,'')=''
        AND author=(SELECT username FROM users WHERE id=?)
        AND forwarded_from_json IS NULL
        AND rowid=(SELECT MAX(rowid) FROM chat_messages WHERE channel_id=? AND actor_user_id=?
          AND COALESCE(agent_id,'')='' AND COALESCE(registration_id,'')=''
          AND author=(SELECT username FROM users WHERE id=?))
      """,
      [source_id, channel_id, user_id, user_id, channel_id, user_id, user_id]
    )
  end

  defp matching_targets(user_id, requested) do
    requested = String.downcase(requested)

    Store.list_vaults(user_id)
    |> Enum.filter(fn vault ->
      name = String.downcase(vault.name)
      # A unique date-suffixed QA vault may be named without its date.
      name == requested or Regex.replace(~r/ \d{4}-\d{2}-\d{2}\z/, name, "") == requested
    end)
    |> Enum.map(& &1.id)
  end
end
