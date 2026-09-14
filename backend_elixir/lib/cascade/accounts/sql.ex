defmodule Cascade.Accounts.SQL do
  @moduledoc false

  alias Cascade.DB.Repo
  alias Cascade.DB.WriteCoordinator
  alias Ecto.Adapters.SQL, as: EctoSQL

  @last_insert_id_key {__MODULE__, :last_insert_id}

  def all(statement, params \\ []) do
    WriteCoordinator.assert_read_only!(statement)
    EctoSQL.query!(Repo, statement, params).rows
  end

  def one(statement, params \\ []) do
    case all(statement, params) do
      [row] -> row
      [] -> nil
    end
  end

  def exec(statement, params \\ []) do
    WriteCoordinator.with_lock(fn ->
      Repo.checkout(
        fn ->
          result = EctoSQL.query!(Repo, statement, params)

          if insert_statement?(statement) do
            [[id]] = EctoSQL.query!(Repo, "SELECT last_insert_rowid()", []).rows
            Process.put(@last_insert_id_key, id)
          end

          result
        end,
        timeout: :infinity
      )
    end)
  end

  def changes(statement, params \\ []), do: exec(statement, params).num_rows

  def transaction(fun) do
    WriteCoordinator.with_lock(fn ->
      case Repo.transaction(fun, timeout: :infinity) do
        {:ok, result} -> result
        {:error, reason} -> raise "account transaction rolled back: #{inspect(reason)}"
      end
    end)
  end

  def last_insert_id do
    case Process.get(@last_insert_id_key) do
      id when is_integer(id) ->
        id

      nil ->
        [[id]] = all("SELECT last_insert_rowid()")
        id
    end
  end

  def table_exists?(name) do
    one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil
  end

  def table_sql(name) do
    case one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) do
      [sql] -> sql || ""
      nil -> nil
    end
  end

  def columns(table) do
    all("PRAGMA table_info(#{safe_identifier!(table)})")
    |> Enum.map(fn [_cid, name | _rest] -> name end)
  end

  def ensure_column(table, column, definition) do
    table = safe_identifier!(table)
    column = safe_identifier!(column)

    if column in columns(table) do
      :present
    else
      exec("ALTER TABLE #{table} ADD COLUMN #{column} #{definition}")
      :added
    end
  end

  defp safe_identifier!(value) when is_binary(value) do
    if Regex.match?(~r/^[a-z][a-z0-9_]*$/, value), do: value, else: raise("unsafe SQL identifier")
  end

  defp insert_statement?(statement) do
    Regex.match?(~r/^\s*(INSERT|REPLACE)\b/i, statement)
  end
end
