defmodule Cascade.Accounts.VaultMembers do
  @moduledoc "Three-role vault membership with immutable creator ownership."

  alias Cascade.Accounts.{Moderation, SQL}

  @roles ~w(owner editor viewer)

  def role?(role), do: role in @roles
  def can_write?(role), do: role in ["owner", "editor"]
  def can_manage?(role), do: role == "owner"

  def role(vault_id, user_id) do
    case SQL.one("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?", [
           vault_id,
           user_id
         ]) do
      [role] when role in @roles -> role
      _ -> nil
    end
  end

  def accessible_vault(vault_id, user_id) do
    case SQL.one(
           """
           SELECT v.id, v.name, v.created_by, v.created_at FROM vaults v
           JOIN vault_members m ON m.vault_id = v.id AND m.user_id = ? WHERE v.id = ?
           """,
           [user_id, vault_id]
         ) do
      [id, name, created_by, created_at] ->
        %{id: id, name: name, created_by: created_by, created_at: created_at}

      nil ->
        nil
    end
  end

  def list(vault_id) do
    SQL.all(
      """
      SELECT m.user_id, u.username, COALESCE(NULLIF(u.display_name,''),u.username),
        COALESCE(u.avatar_url,''), m.role, m.created_at
      FROM vault_members m JOIN users u ON u.id = m.user_id WHERE m.vault_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
        u.username COLLATE NOCASE
      """,
      [vault_id]
    )
    |> Enum.map(&member/1)
  end

  def add(vault_id, actor_id, target_id, target_role) do
    cond do
      target_role == "owner" ->
        {:error, "Cannot assign a second owner; transfer ownership instead"}

      not can_manage?(role(vault_id, actor_id)) ->
        {:error, "Only the vault owner can invite members"}

      target_id == actor_id ->
        {:error, "You are already a member of this vault"}

      Moderation.banned?(vault_id, target_id) ->
        {:error, "This user is banned from this vault"}

      role(vault_id, target_id) ->
        {:error, "User is already a member of this vault"}

      true ->
        insert_member(vault_id, actor_id, target_id, target_role)
    end
  end

  def set_role(vault_id, actor_id, target_id, target_role) do
    target = role(vault_id, target_id)

    cond do
      target_role == "owner" ->
        {:error, "Cannot promote to owner here; transfer ownership instead"}

      not can_manage?(role(vault_id, actor_id)) ->
        {:error, "Only the vault owner can change roles"}

      is_nil(target) ->
        {:error, "Member not found"}

      target == "owner" ->
        {:error, "Cannot change the vault owner role"}

      true ->
        SQL.exec("UPDATE vault_members SET role = ? WHERE vault_id = ? AND user_id = ?", [
          target_role,
          vault_id,
          target_id
        ])

        {:ok, Enum.find(list(vault_id), &(&1.userId == target_id))}
    end
  end

  def remove(vault_id, actor_id, target_id) do
    actor = role(vault_id, actor_id)
    target = role(vault_id, target_id)

    cond do
      is_nil(actor) ->
        {:error, "Not a vault member"}

      is_nil(target) ->
        {:error, "Member not found"}

      target == "owner" ->
        {:error, "Cannot remove the vault owner"}

      actor_id != target_id and not can_manage?(actor) ->
        {:error, "Only the vault owner can remove members"}

      true ->
        SQL.transaction(fn ->
          SQL.exec("DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?", [
            vault_id,
            target_id
          ])

          Cascade.Chat.Agents.remove_departed_owners(vault_id)
        end)

        :ok
    end
  end

  def mutation_gate(session, conn) do
    case Regex.run(~r<^/api/vaults/([^/]+)(?:/|$)>, conn.request_path) do
      [_, encoded] ->
        vault_id = URI.decode(encoded)

        viewer_exception? =
          (conn.method == "DELETE" and
             Regex.match?(~r<^/api/vaults/[^/]+/members/#{session.user.id}/?$>, conn.request_path)) or
            (conn.method == "POST" and
               Regex.match?(~r<^/api/vaults/[^/]+/reports/?$>, conn.request_path))

        if not viewer_exception? and role(vault_id, session.user.id) == "viewer" do
          {:error, 403, "Viewer role cannot modify this vault"}
        else
          :ok
        end

      _ ->
        :ok
    end
  rescue
    _ -> :ok
  end

  defp insert_member(vault_id, actor_id, target_id, target_role) do
    case SQL.one("SELECT id, username, display_name, avatar_url FROM users WHERE id = ?", [
           target_id
         ]) do
      nil ->
        {:error, "User not found"}

      [id, username, display_name, avatar_url] ->
        now = DateTime.utc_now() |> DateTime.to_iso8601()

        SQL.exec(
          "INSERT INTO vault_members (vault_id,user_id,role,invited_by,created_at) VALUES (?,?,?,?,?)",
          [vault_id, id, target_role, actor_id, now]
        )

        {:ok,
         %{
           userId: id,
           username: username,
           displayName: blank(display_name, username),
           avatarUrl: avatar_url || "",
           role: target_role,
           createdAt: now
         }}
    end
  end

  defp member([user_id, username, display_name, avatar_url, role, created_at]) do
    %{
      userId: user_id,
      username: username,
      displayName: display_name,
      avatarUrl: avatar_url,
      role: role,
      createdAt: created_at
    }
  end

  defp blank(value, fallback) when value in [nil, ""], do: fallback
  defp blank(value, _fallback), do: value
end
