defmodule Cascade.Content.NoteRevisionTest do
  use ExUnit.Case, async: false

  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.DB.Migrator

  setup do
    owner = Cascade.TestHelpers.owner_vault("note-revision")
    vault = Store.raw_vault(owner.vault_id)
    user_id = owner.user_id

    on_exit(fn ->
      File.rm_rf!(vault.root_path)
    end)

    %{vault: vault, user_id: user_id}
  end

  test "private-only human changes invalidate a stale opaque token", %{vault: vault, user_id: user_id} do
    note = Store.create_note(vault.id, user_id, %{title: "Private", content: "public\n:::private\nsecret\n:::", is_listed: true})
    expected = Privacy.note_revision(note)

    changed =
      Store.update_note(
        note.id,
        "public\n:::private\nchanged secret\n:::",
        user_id,
        expected_revision: expected,
        actor_origin: :human
      )

    assert Privacy.note_revision(changed) == "note-v1:2"
    assert changed.content =~ "changed secret"

    assert {:error, %{error: "revision_conflict", note: conflict}} =
             Store.update_note(
               note.id,
               "public\n:::private\nlosing secret\n:::",
               user_id,
               expected_revision: expected,
               actor_origin: :human
             )

    assert Privacy.note_revision(conflict) == "note-v1:2"
    refute Privacy.redact_note(conflict, true).content =~ "secret"
  end

  test "agent and human edits share the same counter token and preserve private blocks", %{vault: vault, user_id: user_id} do
    note =
      Store.create_note(vault.id, user_id, %{
        title: "Shared",
        content: "before\n:::private\nsecret\n:::\nafter",
        is_listed: true
      })

    human =
      Store.update_note(
        note.id,
        "human\n:::private\nsecret\n:::\nafter",
        user_id,
        expected_revision: Privacy.note_revision(note),
        actor_origin: :human
      )

    agent_view = Privacy.redact_note(human, true)
    assert agent_view.revision == Privacy.note_revision(human)
    assert agent_view.content =~ "Private block hidden from agents"

    agent =
      Store.update_note(
        note.id,
        String.replace(agent_view.content, "human", "agent"),
        user_id,
        expected_revision: agent_view.revision,
        actor_origin: :agent
      )

    assert Privacy.note_revision(agent) == "note-v1:3"
    assert agent.content == "agent\n:::private\nsecret\n:::\nafter"
  end

  test "revision counter migration is idempotent and backfills existing notes", %{vault: vault, user_id: user_id} do
    note = Store.create_note(vault.id, user_id, %{title: "Migration", content: "body", is_listed: true})
    assert Query.one("SELECT revision_counter FROM notes WHERE id = ?", [note.id]) == [1]

    Migrator.run!()
    Migrator.run!()

    assert Query.one("SELECT name FROM pragma_table_info('notes') WHERE name = ?", ["revision_counter"]) ==
             ["revision_counter"]

    assert Query.one("SELECT revision_counter FROM notes WHERE id = ?", [note.id]) == [1]
  end
end
