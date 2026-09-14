defmodule Cascade.WikiMaintenanceTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Agents
  alias Cascade.Content.{Store, Versions, Privacy}
  alias Cascade.WikiMaintenance, as: Wiki

  setup do
    ctx = Cascade.TestHelpers.owner_vault("wiki")

    room =
      Store.create_note(ctx.vault_id, ctx.user_id, %{
        title: "Room",
        content: "cascade://chat-channel"
      })

    {:ok, agent} =
      Agents.upsert_identity(ctx.user_id, ctx.vault_id, %{
        agentId: "codex",
        displayName: "Curator",
        mention: "curator"
      })

    {:ok, member} = Agents.add_to_channel(ctx.user_id, ctx.vault_id, room.id, agent.id, %{})
    params = %{"channelId" => room.id, "registrationId" => member.id, "enabled" => true}
    {:ok, _} = Wiki.configure(ctx.user_id, ctx.vault_id, params)
    Map.merge(ctx, %{room: room, params: params})
  end

  test "coalesces changes into one durable dispatch, preserves in-flight changes, and settles without self triggers",
       ctx do
    note = Store.create_note(ctx.vault_id, ctx.user_id, %{title: "Topic", content: "Old claim"})
    Wiki.note_changed(note.id)
    Wiki.note_changed(note.id)
    assert %{pending: [reference]} = Wiki.status(ctx.user_id, ctx.vault_id)
    assert reference == "note:" <> note.id
    Wiki.prepare(ctx.vault_id)
    assert %{dispatchId: nil} = Wiki.status(ctx.user_id, ctx.vault_id)
    SQL.exec("UPDATE wiki_maintenance SET due_at=1 WHERE vault_id=?", [ctx.vault_id])
    Wiki.prepare(ctx.vault_id)
    %{dispatchId: id} = Wiki.status(ctx.user_id, ctx.vault_id)
    assert is_binary(id)
    Wiki.prepare(ctx.vault_id)
    assert %{dispatchId: ^id, pending: []} = Wiki.status(ctx.user_id, ctx.vault_id)

    {:ok, run} =
      Cascade.Runs.Store.start(ctx.vault_id, nil, "curate", "codex",
        owner_user_id: ctx.user_id,
        chat_dispatch_id: id
      )

    Cascade.Missions.Dispatches.attach_run(id, run.id)
    Wiki.changed(ctx.vault_id, "note:newer")

    summary =
      Jason.encode!(%{
        updates: [
          %{
            noteId: note.id,
            revision: Wiki.revision(note.content),
            content: "Current claim, with [[Evidence]]"
          }
        ]
      })

    assert :ok = Cascade.Runs.Store.finish(run.id, "completed", summary)
    Wiki.tick(ctx.vault_id)
    assert Store.get_note(note.id).content == "Current claim, with [[Evidence]]"
    assert length(Versions.list(note.id)) == 2

    assert %{enabled: true, dispatchId: nil, pending: ["note:newer"]} =
             Wiki.status(ctx.user_id, ctx.vault_id)

    Wiki.settle(run.id, "completed", summary)
    assert length(Versions.list(note.id)) == 2
    Wiki.prepare(ctx.vault_id)
    assert %{dispatchId: nil} = Wiki.status(ctx.user_id, ctx.vault_id)
  end

  test "conflicts reject the whole proposed batch and preserve concurrent and private work",
       ctx do
    first = Store.create_note(ctx.vault_id, ctx.user_id, %{title: "First", content: "Before"})

    second =
      Store.create_note(ctx.vault_id, ctx.user_id, %{title: "Second", content: "User content"})

    Store.update_note(second.id, "Concurrent user edit", ctx.user_id)

    proposal = %{
      updates:
        Enum.map(
          [first, second],
          &%{noteId: &1.id, revision: Wiki.revision(&1.content), content: "Replacement"}
        )
    }

    assert {:error, _} = Wiki.apply_result(ctx.vault_id, ctx.user_id, Jason.encode!(proposal))
    assert Store.get_note(first.id).content == "Before"
    assert Store.get_note(second.id).content == "Concurrent user edit"

    private =
      Store.create_note(ctx.vault_id, ctx.user_id, %{
        title: "Private",
        content: "Public\n:::private\nsecret\n:::"
      })

    assert {:error, _} =
             Wiki.apply_result(
               ctx.vault_id,
               ctx.user_id,
               Jason.encode!(%{
                 updates: [
                   %{
                     noteId: private.id,
                     revision: Wiki.revision(private.content),
                     content: "Lost private block"
                   }
                 ]
               })
             )

    redacted = Privacy.redact_note(private, true)

    assert {:ok, 1} =
             Wiki.apply_result(
               ctx.vault_id,
               ctx.user_id,
               Jason.encode!(%{
                 updates: [
                   %{
                     noteId: private.id,
                     revision: redacted.revision,
                     content: redacted.content <> "\nEvidence"
                   }
                 ]
               })
             )

    assert Store.get_note(private.id).content =~ "secret"
  end

  test "memory writes and trivial completions do not wake the model; disabling revokes an unclaimed dispatch",
       ctx do
    root = Store.create_folder(ctx.vault_id, %{name: "_agent"})
    folder = Store.create_folder(ctx.vault_id, %{name: "memory", parent_id: root.id})

    Store.create_note(ctx.vault_id, ctx.user_id, %{
      title: "Capture",
      content: "Do not create a loop",
      folder_id: folder.id
    })

    {:ok, run} =
      Cascade.Runs.Store.start(ctx.vault_id, nil, "ordinary", "codex", owner_user_id: ctx.user_id)

    Cascade.Runs.Store.finish(run.id, "completed", "Done.")
    assert %{pending: []} = Wiki.status(ctx.user_id, ctx.vault_id)
    Wiki.changed(ctx.vault_id, "note:source")
    SQL.exec("UPDATE wiki_maintenance SET due_at=1 WHERE vault_id=?", [ctx.vault_id])
    Wiki.prepare(ctx.vault_id)
    %{dispatchId: dispatch} = Wiki.status(ctx.user_id, ctx.vault_id)

    assert {:ok, %{enabled: false, dispatchId: nil}} =
             Wiki.configure(ctx.user_id, ctx.vault_id, %{"enabled" => false})

    assert SQL.one("SELECT id FROM chat_agent_dispatches WHERE id=?", [dispatch]) == nil
    assert {:ok, _} = Wiki.configure(ctx.user_id, ctx.vault_id, ctx.params)
    Wiki.tick(ctx.vault_id)
    assert %{dispatchId: nil, pending: []} = Wiki.status(ctx.user_id, ctx.vault_id)
  end

  test "failed dispatches pause without repeated admissions and the status API is owner-only",
       ctx do
    Wiki.changed(ctx.vault_id, "note:source")
    SQL.exec("UPDATE wiki_maintenance SET due_at=1 WHERE vault_id=?", [ctx.vault_id])
    Wiki.prepare(ctx.vault_id)
    %{dispatchId: id} = Wiki.status(ctx.user_id, ctx.vault_id)
    Cascade.Missions.Dispatches.fail(id, "Agent was removed")
    Wiki.tick(ctx.vault_id)

    assert %{enabled: false, lastResult: "Paused before execution: Agent was removed"} =
             Wiki.status(ctx.user_id, ctx.vault_id)

    assert Wiki.status(-1, ctx.vault_id) == nil
    assert Wiki.jobs() == %{}
  end

  test "execution timeout pauses upkeep and the HTTP configuration cannot cross owners", ctx do
    Wiki.changed(ctx.vault_id, "note:source")
    SQL.exec("UPDATE wiki_maintenance SET due_at=1 WHERE vault_id=?", [ctx.vault_id])
    Wiki.prepare(ctx.vault_id)
    %{dispatchId: id} = Wiki.status(ctx.user_id, ctx.vault_id)

    {:ok, run} =
      Cascade.Runs.Store.start(ctx.vault_id, nil, "curate", "codex",
        owner_user_id: ctx.user_id,
        chat_dispatch_id: id
      )

    Cascade.Missions.Dispatches.attach_run(id, run.id)
    SQL.exec("UPDATE runs SET started_at=datetime('now','-11 minutes') WHERE id=?", [run.id])
    Wiki.tick(ctx.vault_id)
    assert Cascade.Runs.Store.get(run.id).status == "canceled"
    assert %{enabled: false} = Wiki.status(ctx.user_id, ctx.vault_id)

    other = Cascade.TestHelpers.owner_vault("wiki-api-other")

    token =
      Cascade.Auth.Token.sign_user(%{
        id: other.user_id,
        username: other.username,
        auth_version: 0
      })

    conn =
      Cascade.TestHelpers.json_conn(
        :put,
        "/api/vaults/#{ctx.vault_id}/wiki-maintenance",
        ctx.params,
        token
      )

    response =
      CascadeWeb.ExtendedContentRouter.call(conn, CascadeWeb.ExtendedContentRouter.init([]))

    assert response.status == 403
    assert %{enabled: false} = Wiki.status(ctx.user_id, ctx.vault_id)
  end

  test "owner scope, channel exclusion, output bounds and canceled runs", ctx do
    other = Cascade.TestHelpers.owner_vault("other-wiki")
    assert {:error, _} = Wiki.configure(other.user_id, ctx.vault_id, ctx.params)
    assert {:error, _} = Wiki.apply_result(ctx.vault_id, ctx.user_id, "not json")

    assert {:error, _} =
             Wiki.apply_result(
               ctx.vault_id,
               ctx.user_id,
               Jason.encode!(%{updates: List.duplicate(%{}, 4)})
             )

    note =
      Store.create_note(other.vault_id, other.user_id, %{title: "Other", content: "Other account"})

    for candidate <- [note, ctx.room] do
      assert {:error, _} =
               Wiki.apply_result(
                 ctx.vault_id,
                 ctx.user_id,
                 Jason.encode!(%{
                   updates: [
                     %{
                       noteId: candidate.id,
                       revision: Wiki.revision(candidate.content),
                       content: "No"
                     }
                   ]
                 })
               )
    end

    Wiki.changed(ctx.vault_id, "note:source")
    SQL.exec("UPDATE wiki_maintenance SET due_at=1 WHERE vault_id=?", [ctx.vault_id])
    Wiki.prepare(ctx.vault_id)
    %{dispatchId: id} = Wiki.status(ctx.user_id, ctx.vault_id)

    {:ok, run} =
      Cascade.Runs.Store.start(ctx.vault_id, nil, "curate", "codex",
        owner_user_id: ctx.user_id,
        chat_dispatch_id: id
      )

    Cascade.Runs.Store.finish(run.id, "canceled", "Stop")
    assert %{enabled: false, dispatchId: nil} = Wiki.status(ctx.user_id, ctx.vault_id)
    Wiki.changed(ctx.vault_id, "note:after-stop")
    assert %{pending: []} = Wiki.status(ctx.user_id, ctx.vault_id)
  end
end
