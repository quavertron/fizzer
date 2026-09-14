defmodule Cascade.ContentDomainTest do
  use ExUnit.Case, async: false

  import Bitwise
  import Plug.Conn
  import Plug.Test
  import Cascade.TestHelpers

  alias Cascade.Auth.Token
  alias Cascade.Content.{Assets, Privacy, Query, Store, Versions}

  @router_options CascadeWeb.ContentRouter.init([])

  setup do
    root =
      Path.join(System.tmp_dir!(), "cascade-elixir-content-#{System.unique_integer([:positive])}")

    previous_root = System.get_env("CASCADE_VAULTS_BASE_DIR")
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)
    reset_database()

    Query.execute(
      "INSERT INTO users (id, username, password_hash, display_name, avatar_url, auth_version) VALUES (1, 'alice', 'x', 'Alice', '', 0), (2, 'bob', 'x', 'Bob', '', 0)"
    )

    on_exit(fn ->
      File.rm_rf!(root)

      if previous_root do
        System.put_env("CASCADE_VAULTS_BASE_DIR", previous_root)
      else
        System.delete_env("CASCADE_VAULTS_BASE_DIR")
      end
    end)

    :ok
  end

  test "vault roots are owner isolated, ignore supplied roots, and preserve their path on rename" do
    poison =
      Path.join(System.tmp_dir!(), "cascade-elixir-poison-#{System.unique_integer([:positive])}")

    File.mkdir_p!(poison)
    File.write!(Path.join(poison, "SECRET.md"), "secret")
    on_exit(fn -> File.rm_rf!(poison) end)

    alice = Store.create_vault(1, %{name: "My Vault"})
    bob = Store.create_vault(2, %{name: "My Vault", root_path: poison})

    assert alice.root_path != bob.root_path
    assert String.contains?(alice.root_path, "/1/")
    assert String.contains?(bob.root_path, "/2/")
    refute Path.expand(bob.root_path) == Path.expand(poison)
    assert Enum.map(Store.list_notes(bob.id), & &1.title) == ["General"]
    assert Store.get_note(hd(Store.list_notes(bob.id)).id).content == "cascade://chat-channel"

    renamed = Store.rename_vault(alice.id, "  Team notes  ")
    assert renamed.name == "Team notes"
    assert renamed.root_path == alice.root_path

    assert_raise ArgumentError, "Vault name is required", fn ->
      Store.rename_vault(alice.id, "  ")
    end

    assert_raise ArgumentError, "Vault name must be 80 characters or fewer", fn ->
      Store.rename_vault(alice.id, String.duplicate("x", 81))
    end
  end

  test "only the owner can permanently delete a vault and its isolated files" do
    vault = Store.create_vault(1, %{name: "Disposable"})
    assert File.dir?(vault.root_path)

    refute Store.delete_vault(vault.id, 2)
    assert File.dir?(vault.root_path)
    assert Store.delete_vault(vault.id, 1)
    refute File.exists?(vault.root_path)
    assert Query.one("SELECT id FROM vaults WHERE id = ?", [vault.id]) == nil
  end

  test "agent vault deletion requires current, scoped owner authority and protects active vaults" do
    current = Store.create_vault(1, %{name: "Current"})
    target = Store.create_vault(1, %{name: "Orchestration QA 2026-09-05"})
    channel = hd(Store.list_notes(current.id))
    body = "add a way to delete vaults and delete the orchestration QA vault for me"
    user = %{id: 1, username: "alice", auth_version: 0}
    token = Token.sign_agent(user)
    {:ok, source} = Cascade.Chat.Messages.create(user, current.id, channel.id, %{body: body})
    authority = Jason.encode!([%{id: source.id, body: body}])

    Query.execute(
      "INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,created_by,authority_json) VALUES ('deletion',?,?,?,?,?,1,?)",
      [current.id, channel.id, source.id, "agent", "Delete QA", authority]
    )

    Query.execute(
      "INSERT INTO runs(id,vault_id,owner_user_id,prompt,status) VALUES (99001,?,1,'delete','running')",
      [current.id]
    )

    Query.execute(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status,run_id) VALUES ('delete-task','deletion','Delete','agent','running',99001)"
    )

    delete = fn id, name, source_id, bearer, run ->
      json_conn(
        :delete,
        "/api/vaults/#{id}",
        %{expectedName: name, authorityMessageId: source_id},
        bearer
      )
      |> put_req_header("x-cascade-run-id", run)
      |> CascadeWeb.ContentRouter.call(@router_options)
    end

    deny = fn ->
      assert delete.(target.id, target.name, source.id, token, "99001").status == 403
    end

    assert request(:delete, "/api/vaults/#{target.id}", %{}, token).status == 403
    assert delete.(target.id, "wrong", source.id, token, "99001").status == 403
    assert delete.(target.id, target.name, "missing", token, "99001").status == 403
    assert delete.(target.id, target.name, source.id, token, "99002").status == 403
    assert delete.(current.id, current.name, source.id, token, "99001").status == 403

    assert delete.(
             target.id,
             target.name,
             source.id,
             Token.sign_agent(%{id: 2, username: "bob", auth_version: 0}),
             "99001"
           ).status == 403

    Query.execute("UPDATE vaults SET created_by=2 WHERE id=?", [target.id])
    deny.()
    Query.execute("UPDATE vaults SET created_by=1 WHERE id=?", [target.id])

    for field <- ["agent_id", "registration_id"] do
      Query.execute("UPDATE chat_messages SET #{field}='agent' WHERE id=?", [source.id])
      deny.()
      Query.execute("UPDATE chat_messages SET #{field}=NULL WHERE id=?", [source.id])
    end

    Query.execute(
      "UPDATE chat_messages SET body='do not delete the orchestration QA vault' WHERE id=?",
      [source.id]
    )

    deny.()
    Query.execute("UPDATE chat_messages SET body=? WHERE id=?", [body, source.id])

    for invalid <- [
          "do not delete the orchestration QA vault",
          "can you explain how to delete the orchestration QA vault?",
          "delete the other vault",
          "delete the orchestration QA vault after approval"
        ] do
      Query.execute("UPDATE chat_messages SET body=? WHERE id=?", [invalid, source.id])

      Query.execute("UPDATE chat_missions SET authority_json=? WHERE id='deletion'", [
        Jason.encode!([%{id: source.id, body: invalid}])
      ])

      deny.()
    end

    Query.execute("UPDATE chat_messages SET body=? WHERE id=?", [body, source.id])
    Query.execute("UPDATE chat_missions SET authority_json=? WHERE id='deletion'", [authority])
    Query.execute("UPDATE chat_messages SET forwarded_from_json='{}' WHERE id=?", [source.id])
    deny.()
    Query.execute("UPDATE chat_messages SET forwarded_from_json=NULL WHERE id=?", [source.id])
    Query.execute("UPDATE vaults SET created_at=datetime('now','+1 day') WHERE id=?", [target.id])
    deny.()
    Query.execute("UPDATE vaults SET created_at=datetime('now','-1 day') WHERE id=?", [target.id])
    duplicate = Store.create_vault(1, %{name: "Orchestration QA 2026-09-06"})
    deny.()
    assert Store.delete_vault(duplicate.id, 1)

    Query.execute(
      "INSERT INTO runs(id,vault_id,owner_user_id,prompt,status) VALUES (99002,?,1,'busy','running')",
      [target.id]
    )

    deny.()
    Query.execute("DELETE FROM runs WHERE id=99002")
    Query.execute("UPDATE runs SET status='completed' WHERE id=99001")
    deny.()
    Query.execute("UPDATE runs SET status='running' WHERE id=99001")
    {:ok, stop} = Cascade.Chat.Messages.create(user, current.id, channel.id, %{body: "Stop"})
    deny.()
    Query.execute("DELETE FROM chat_messages WHERE id=?", [stop.id])
    assert File.dir?(target.root_path)
    assert delete.(target.id, target.name, source.id, token, "99001").status == 200
    refute File.exists?(target.root_path)
    assert Store.get_vault(target.id, 1) == nil
    assert Store.get_vault(current.id, 1)
    assert delete.(target.id, target.name, source.id, token, "99001").status == 403
  end

  test "agent-supplied owner names cannot become human deletion authority" do
    vault = Store.create_vault(1, %{name: "Current"})
    channel = hd(Store.list_notes(vault.id))
    user = %{id: 1, username: "alice"}

    assert {:ok, message} =
             Cascade.Chat.Messages.create(
               user,
               vault.id,
               channel.id,
               %{author: "alice", body: "delete the QA vault"},
               access: :agent
             )

    assert message.agentId == "agent"
  end

  test "note CRUD keeps distinct files, dense ordering, unlisted storage, tags, links and graph" do
    vault = Store.create_vault(1, %{name: "Content"})
    folder_a = Store.create_folder(vault.id, %{name: "A"})
    folder_b = Store.create_folder(vault.id, %{name: "B"})
    nested = Store.create_folder(vault.id, %{name: "Nested", parent_id: folder_a.id})

    assert_raise ArgumentError, "Invalid folder or file name", fn ->
      Store.create_folder(vault.id, %{name: "../outside"})
    end

    assert_raise ArgumentError, "Cannot move a folder into its own subfolder", fn ->
      Store.update_folder(folder_a.id, %{parent_id: nested.id})
    end

    first =
      Store.create_note(vault.id, 1, %{
        title: "Untitled Note",
        content: "AAA first",
        folder_id: folder_a.id
      })

    second =
      Store.create_note(vault.id, 1, %{
        title: "Untitled Note",
        content: "BBB second",
        folder_id: folder_a.id
      })

    target = Store.create_note(vault.id, 1, %{title: "Target", content: "target"})

    assert second.title == "Untitled Note 2"
    assert Store.get_note(first.id).content == "AAA first"
    assert File.read!(Path.join([vault.root_path, "A", "Untitled Note.md"])) == "AAA first"

    linking =
      Store.create_note(vault.id, 1, %{title: "Linking", content: "before [[Target]] after"})

    assert Store.get_backlinks(target.id) |> Enum.map(& &1.id) == [linking.id]
    assert %{nodes: nodes, edges: edges} = Store.graph(vault.id)
    assert Enum.any?(nodes, &(&1.id == target.id and &1.kind == "note"))
    assert Enum.any?(nodes, &(&1.kind == "chat"))

    assert Enum.any?(
             edges,
             &(&1.source == linking.id and &1.target == target.id and &1.kind == "wikilink")
           )

    chat =
      Enum.find(
        Store.list_notes(vault.id),
        &String.starts_with?(&1.content_preview, "cascade://chat-channel")
      )

    assert chat

    Query.execute(
      """
      INSERT INTO chat_note_backlinks
        (id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted)
      VALUES ('bl-1', ?, ?, ?, 'msg-1', ?, 'alice', 'see the note', datetime('now'), 0)
      """,
      [vault.id, target.id, target.title, chat.id]
    )

    graph_with_chat = Store.graph(vault.id)

    assert Enum.any?(
             graph_with_chat.edges,
             &(&1.source == chat.id and &1.target == target.id and &1.kind == "chat")
           )

    renamed = Store.rename_note(target.id, "Renamed Target")
    assert renamed.title == "Renamed Target"
    assert Store.get_note(linking.id).content == "before [[Renamed Target]] after"

    Store.move_note(second.id, folder_b.id, 0)
    moved = Store.get_note(second.id)
    assert moved.folder_id == folder_b.id
    assert moved.position == 0
    assert File.exists?(Path.join([vault.root_path, "B", "Untitled Note 2.md"]))

    Store.unlist_note(second.id)
    unlisted = Store.get_note(second.id)
    assert unlisted.is_listed == 0
    assert unlisted.folder_id == nil
    assert File.exists?(Path.join([vault.root_path, ".cascade-unlisted", "Untitled Note 2.md"]))

    Store.toggle_pin(first.id)
    Store.toggle_archive(first.id)
    assert Store.get_note(first.id).is_pinned == 1
    assert Store.get_note(first.id).is_archived == 1

    Store.add_tag(linking.id, vault.id, " Project ", "#fff")
    assert Store.get_note(linking.id).tags == ["project"]
    [tag] = Store.list_tags(vault.id)
    assert tag.count == 1
    Store.remove_tag(linking.id, tag.id)
    assert Store.list_tags(vault.id) == []
  end

  test "rescan refuses shared roots and isolation repair purges a secondary index" do
    shared =
      Path.join(System.tmp_dir!(), "cascade-elixir-shared-#{System.unique_integer([:positive])}")

    File.mkdir_p!(shared)
    File.write!(Path.join(shared, "ALICE SECRET.md"), "secret")
    on_exit(fn -> File.rm_rf!(shared) end)

    Query.execute(
      "INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES ('va', 'A', ?, 1, '2020-01-01')",
      [shared]
    )

    Query.execute(
      "INSERT INTO vaults (id, name, root_path, created_by, created_at) VALUES ('vb', 'B', ?, 2, '2024-01-01')",
      [shared]
    )

    Query.execute(
      "INSERT INTO vault_members (vault_id, user_id, role, invited_by) VALUES ('va', 1, 'owner', 1), ('vb', 2, 'owner', 2)"
    )

    Store.rescan_vault("vb", 2)
    assert Store.list_notes("vb") == []

    Query.execute(
      "INSERT INTO notes (id, vault_id, title, content, content_preview, created_by) VALUES ('leak', 'vb', 'ALICE SECRET', 'secret', 'secret', 2)"
    )

    assert Store.enforce_storage_isolation() == %{rehomed: 1}
    refute Store.raw_vault("vb").root_path == shared
    refute Enum.any?(Store.list_notes("vb"), &(&1.title == "ALICE SECRET"))
  end

  test "versions preserve label whitelist and reproduce the Node LCS diff" do
    vault = Store.create_vault(1, %{name: "Versions"})
    note = Store.create_note(vault.id, 1, %{title: "Plan", content: "one\ntwo"})
    first = Versions.create(note.id, "one\ntwo", "manual")

    Query.execute("UPDATE note_versions SET created_at = '2020-01-01T00:00:00' WHERE id = ?", [
      first.id
    ])

    second = Versions.create(note.id, "one\nthree", "arbitrary")

    assert first.label == "manual"
    assert second.label == nil
    assert Enum.map(Versions.list(note.id), & &1.id) == [second.id, first.id]

    assert Versions.diff_versions(note.id, first.id, second.id) ==
             "--- version-#{String.slice(first.id, 0, 8)}\n+++ version-#{String.slice(second.id, 0, 8)}\n@@\n one\n-two\n+three"
  end

  test "asset decoder, signatures, upload permissions, path validation and modes match Node" do
    assert Assets.decode_data("aGVs bG8=") == "hello"
    assert Assets.decode_data("aGVsbG8") == "hello"

    assert_raise ArgumentError, "Asset data is not valid base64", fn ->
      Assets.decode_data("%%%")
    end

    png = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>
    assert Assets.matches_media_type?("image/png", png)
    refute Assets.matches_media_type?("image/png", "<script>")
    assert Assets.max_bytes() == 64 * 1_024 * 1_024
    assert Assets.matches_media_type?("application/pdf", "%PDF-1.7\n")
    assert Assets.matches_media_type?("text/markdown", "# Notes\n")

    vault = Store.create_vault(1, %{name: "Assets"})
    note = Store.create_note(vault.id, 1, %{title: "Image", content: ""})
    uploaded = Assets.upload(note.id, 1, %{media_type: "image/png", data: Base.encode64(png)})
    path = Assets.resolve_path(note.id, uploaded.asset_id)
    assert File.read!(path) == png
    assert band(File.stat!(Path.dirname(path)).mode, 0o777) == 0o700
    assert band(File.stat!(path).mode, 0o777) == 0o600
    assert Assets.resolve_path(note.id, "../escape") == nil

    pdf =
      Assets.upload(note.id, 1, %{
        media_type: "application/pdf",
        data: Base.encode64("%PDF-1.7\n")
      })

    pdf_path = Assets.resolve_path(note.id, pdf.asset_id)
    assert File.read!(pdf_path) == "%PDF-1.7\n"
    assert Assets.response_metadata(pdf_path).content_disposition =~ "attachment"

    assert_raise ArgumentError, "SVG uploads are not supported", fn ->
      Assets.upload(note.id, 1, %{media_type: "image/svg+xml", data: Base.encode64("<svg/>")})
    end

    assert_raise ArgumentError, "Note not found", fn ->
      Assets.upload(note.id, 2, %{media_type: "image/png", data: Base.encode64(png)})
    end
  end

  test "private blocks preserve stable placeholders across agent edits" do
    existing = "public\n:::private\nsecret 💫\n:::\nafter"
    redacted = Privacy.redact_blocks(existing)
    assert redacted =~ "Private block hidden from agents. id="
    refute redacted =~ "secret"

    assert Privacy.restore_blocks(existing, String.replace(redacted, "public", "changed")) ==
             String.replace(existing, "public", "changed")

    assert_raise ArgumentError,
                 "Agent edits must preserve every private block placeholder exactly once.",
                 fn -> Privacy.restore_blocks(existing, "changed") end
  end

  test "isolated content router preserves auth, response wrappers and viewer errors" do
    owner_token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    viewer_token = Token.sign_user(%{id: 2, username: "bob", auth_version: 0})

    created = request(:post, "/api/vaults", %{name: "HTTP"}, owner_token)
    assert created.status == 201
    vault = Jason.decode!(created.resp_body)["vault"]

    assert Map.keys(vault) |> Enum.sort() ==
             ~w(created_at created_by id name public_guidelines public_home_note_id public_join_policy public_join_role public_summary public_topics root_path visibility)

    assert Plug.Conn.get_resp_header(created, "cache-control") == []

    Query.execute(
      "INSERT INTO vault_members (vault_id, user_id, role, invited_by) VALUES (?, 2, 'viewer', 1)",
      [vault["id"]]
    )

    listed = request(:get, "/api/vaults/#{vault["id"]}/notes", nil, viewer_token)
    assert listed.status == 200
    assert [%{"title" => "General"}] = Jason.decode!(listed.resp_body)["notes"]

    denied = request(:post, "/api/vaults/#{vault["id"]}/notes", %{title: "Nope"}, viewer_token)
    assert denied.status == 403
    assert Jason.decode!(denied.resp_body) == %{"error" => "Viewer role cannot edit this vault"}

    missing = request(:get, "/api/vaults/missing", nil, owner_token)
    assert missing.status == 404
    assert Jason.decode!(missing.resp_body) == %{"error" => "Vault not found"}
  end

  test "mounted diff route only accepts versions belonging to the authorized note" do
    vault = Store.create_vault(1, %{name: "Readable"})
    other_vault = Store.create_vault(2, %{name: "Private"})
    note = Store.create_note(vault.id, 1, %{title: "Plan", content: ""})
    other = Store.create_note(other_vault.id, 2, %{title: "Secret", content: ""})
    first = Versions.create(note.id, "before", "manual")
    second = Versions.create(note.id, "after", "manual")
    secret = Versions.create(other.id, "private secret", "manual")
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})

    for {from, to, status} <- [
          {first.id, second.id, 200},
          {secret.id, second.id, 404},
          {first.id, secret.id, 404},
          {secret.id, secret.id, 404},
          {first.id, "missing", 404}
        ] do
      response =
        conn(:get, "/api/notes/#{note.id}/diff?from=#{from}&to=#{to}")
        |> put_req_header("authorization", "Bearer #{token}")
        |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

      assert response.status == status
      refute response.resp_body =~ "private secret"
    end
  end

  test "mounted router accepts media above the former global JSON limit" do
    vault = Store.create_vault(1, %{name: "Large upload"})
    note = Store.create_note(vault.id, 1, %{title: "Audio", content: ""})
    token = Token.sign_user(%{id: 1, username: "alice", auth_version: 0})
    bytes = "ID3" <> String.duplicate("x", 10 * 1024 * 1024)

    response =
      conn(
        :post,
        "/api/notes/#{note.id}/assets",
        Jason.encode!(%{
          media_type: "audio/mpeg",
          data: Base.encode64(bytes)
        })
      )
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer #{token}")
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert response.status == 201
    asset = Jason.decode!(response.resp_body)
    assert File.read!(Assets.resolve_path(note.id, asset["asset_id"])) == bytes
  end

  defp request(method, path, body, token) do
    json_conn(method, path, body, token)
    |> CascadeWeb.ContentRouter.call(@router_options)
  end

  defp reset_database do
    for table <-
          ~w(chat_note_backlinks chat_agent_members chat_messages chat_channel_links note_versions note_links note_tags tags notes folders vault_members vaults users) do
      Query.execute("DELETE FROM #{table}")
    end

    File.rm_rf!(Store.vaults_base_dir())
  end
end
