defmodule Cascade.Auth.Accounts do
  @moduledoc "Raw-SQL account reads that preserve the existing SQLite schema."

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  @select_fields "id, username, password_hash, display_name, avatar_url, auth_version, created_at"

  def fetch_by_username(username) when is_binary(username) do
    case SQL.query!(Repo, "SELECT #{@select_fields} FROM users WHERE username = ?", [username]).rows do
      [row] -> {:ok, from_row(row)}
      [] -> :error
    end
  end

  def fetch_by_id(id) when is_integer(id) do
    case SQL.query!(Repo, "SELECT #{@select_fields} FROM users WHERE id = ?", [id]).rows do
      [row] -> {:ok, from_row(row)}
      [] -> :error
    end
  end

  def fetch_by_ids(ids) when is_list(ids) do
    ids
    |> Enum.filter(&is_integer/1)
    |> Enum.uniq()
    |> Enum.chunk_every(500)
    |> Enum.flat_map(fn chunk ->
      placeholders = Enum.map_join(chunk, ",", fn _ -> "?" end)

      SQL.query!(Repo, "SELECT #{@select_fields} FROM users WHERE id IN (#{placeholders})", chunk).rows
    end)
    |> Map.new(fn row ->
      user = from_row(row)
      {user.id, user}
    end)
  end

  def owner?(user_id) when is_integer(user_id) do
    case SQL.query!(Repo, "SELECT MIN(id) FROM users", []).rows do
      [[^user_id]] -> true
      _ -> false
    end
  end

  def public_user(user) do
    %{
      id: user.id,
      username: user.username,
      displayName: blank_default(user.display_name, user.username),
      avatarUrl: user.avatar_url || ""
    }
  end

  defp from_row([id, username, password_hash, display_name, avatar_url, auth_version, created_at]) do
    %{
      id: id,
      username: username,
      password_hash: password_hash,
      display_name: display_name,
      avatar_url: avatar_url,
      auth_version: auth_version,
      created_at: created_at
    }
  end

  defp blank_default(value, fallback) when value in [nil, ""], do: fallback
  defp blank_default(value, _fallback), do: value
end
