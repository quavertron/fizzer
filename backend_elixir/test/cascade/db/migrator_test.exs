defmodule Cascade.DB.MigratorTest do
  use ExUnit.Case, async: false

  alias Cascade.DB.{Migrator, Repo}
  alias Ecto.Adapters.SQL

  test "creates the Node-compatible core schema and is idempotent" do
    assert :ok = Migrator.run!()
    assert :ok = Migrator.run!()

    tables =
      SQL.query!(Repo, "SELECT name FROM sqlite_master WHERE type = 'table'", []).rows
      |> List.flatten()

    for table <- [
          "users",
          "registration_invites_used",
          "vaults",
          "folders",
          "notes",
          "tags",
          "note_tags",
          "note_links",
          "note_versions",
          "notes_fts",
          "cascade_elixir_schema_migrations"
        ] do
      assert table in tables
    end

    assert [[1, "core_node_schema_compatibility", checksum, _applied_at]] =
             SQL.query!(
               Repo,
               "SELECT version, name, checksum, applied_at FROM cascade_elixir_schema_migrations",
               []
             ).rows

    assert byte_size(checksum) == 64
  end

  test "enables SQLite foreign keys" do
    assert [[1]] = SQL.query!(Repo, "PRAGMA foreign_keys", []).rows
  end
end
