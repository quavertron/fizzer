defmodule Cascade.DB.MigratorTest do
  use ExUnit.Case, async: false

  alias Cascade.DB.{Migrator, Repo}
  alias Ecto.Adapters.SQL
  alias Cascade.Content.{Privacy, Store}

  setup do
    owner = Cascade.TestHelpers.owner_vault("migrator")
    on_exit(fn -> File.rm_rf!(Store.raw_vault(owner.vault_id).root_path) end)
    %{owner: owner}
  end

  test "creates the Node-compatible core schema and is idempotent", %{owner: owner} do
    assert :ok = Migrator.run!()
    migration_rows = fn ->
      SQL.query!(
        Repo,
        "SELECT version, name, checksum, applied_at FROM cascade_elixir_schema_migrations",
        []
      ).rows
      |> Enum.sort_by(&List.first/1)
    end

    applied = migration_rows.()
    assert :ok = Migrator.run!()
    assert migration_rows.() == applied

    assert Enum.all?(applied, fn [version, name, checksum, applied_at] ->
             is_integer(version) and is_binary(name) and byte_size(checksum) == 64 and
               is_binary(applied_at)
           end)

    assert [1, "core_node_schema_compatibility", v1_checksum, _] =
             Enum.find(applied, fn [version | _] -> version == 1 end)

    assert v1_checksum ==
             "b844b7f41e5377d5ce8ff5dd3c3cc0951cab766773f5bf0816aaec45864d338a"

    assert [2, "note_revision_counter", v2_checksum, _] =
             Enum.find(applied, fn [version | _] -> version == 2 end)

    assert v2_checksum ==
             "c3f35b7730ea9f2780477c1dbdbffe4337ef709da82644fde0810dae2e3060ce"

    note = Store.create_note(owner.vault_id, owner.user_id, %{title: "Counter", content: "body"})
    assert note.revision_counter == 1

    updated =
      Store.update_note(
        note.id,
        "updated",
        owner.user_id,
        expected_revision: Privacy.note_revision(note),
        actor_origin: :human
      )

    assert updated.revision_counter == 2
    assert Privacy.note_revision(updated) == "note-v1:2"

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

  end

  test "enables SQLite foreign keys" do
    assert [[1]] = SQL.query!(Repo, "PRAGMA foreign_keys", []).rows
  end
end
