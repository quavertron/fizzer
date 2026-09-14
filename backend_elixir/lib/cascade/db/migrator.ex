defmodule Cascade.DB.Migrator do
  @moduledoc "Checksum-verified raw SQL migrations for the shared Cascade SQLite database."

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  @migrations [Cascade.DB.Migrations.V1CoreCompatibility]

  def run! do
    SQL.query!(Repo, "PRAGMA foreign_keys = ON", [])

    SQL.query!(
      Repo,
      """
      CREATE TABLE IF NOT EXISTS cascade_elixir_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      []
    )

    Enum.each(@migrations, &apply_migration!/1)
    :ok
  end

  defp apply_migration!(migration) do
    version = migration.version()
    checksum = checksum(migration)

    case SQL.query!(
           Repo,
           "SELECT name, checksum FROM cascade_elixir_schema_migrations WHERE version = ?",
           [version]
         ).rows do
      [] ->
        migrate!(migration, checksum)

      [[_name, ^checksum]] ->
        :ok

      [[name, recorded]] ->
        raise "migration #{version} (#{name}) checksum drift: recorded #{recorded}, current #{checksum}"
    end
  end

  defp migrate!(migration, checksum) do
    Repo.transaction(
      fn ->
        Enum.each(migration.statements(), &SQL.query!(Repo, &1, []))
        :ok = migration.after_up()

        SQL.query!(
          Repo,
          "INSERT INTO cascade_elixir_schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
          [migration.version(), migration.name(), checksum]
        )
      end,
      timeout: :infinity
    )
  end

  defp checksum(migration) do
    migration.checksum_material()
    |> :erlang.term_to_binary()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end
end
