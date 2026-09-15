defmodule Cascade.DB.Migrator do
  @moduledoc "Checksum-verified raw SQL migrations for the shared Cascade SQLite database."

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  @migrations [
    Cascade.DB.Migrations.V1CoreCompatibility,
    Cascade.DB.Migrations.V2NoteRevisionCounter,
    Cascade.DB.Migrations.V3ProfileColors
  ]

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

      # A local desktop build added color directly to v1 before v3 existed.
      # Accept only that exact known variant; retain its audit record and let
      # v3 perform the additive upgrade. All other checksum drift still fails.
      [["core_node_schema_compatibility", "aa0c4bced8a63120f9dc7ac8e3a4a6361f0cd0565e91835b38698aafef85e113"]]
      when version == 1 and checksum == "b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a" ->
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
