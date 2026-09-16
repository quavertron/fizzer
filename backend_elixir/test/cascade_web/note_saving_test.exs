defmodule CascadeWeb.NoteSavingTest do
  use ExUnit.Case, async: false
  import Cascade.TestHelpers
  alias Cascade.Content.Store
  alias Cascade.Auth.Token
  alias Cascade.Accounts.SQL

  test "revision-aware note PUT persists to disk, and conflict/viewer writes leave it unchanged" do
    owner = owner_vault("note-saving")
    vault = Store.raw_vault(owner.vault_id)
    on_exit(fn -> File.rm_rf!(vault.root_path) end)

    note =
      Store.create_note(vault.id, owner.user_id, %{
        title: "Save fixture",
        content: "original",
        is_listed: true
      })

    token = Token.sign_user(%{id: owner.user_id, username: owner.username, auth_version: 0})
    path = "/api/notes/#{note.id}"
    initial = request(:get, path, nil, token) |> body()
    revision = initial["note"]["revision"]
    assert is_binary(revision)
    saved = request(:put, path, %{content: "persisted edit", expectedRevision: revision}, token)
    assert saved.status == 200
    committed = body(saved)["note"]
    assert committed["revision"] != revision
    assert body(request(:get, path, nil, token))["note"]["content"] == "persisted edit"
    assert File.read!(note.file_path) == "persisted edit"

    assert request(:put, path, %{content: "stale losing edit", expectedRevision: revision}, token).status ==
             409

    SQL.exec("UPDATE vault_members SET role='viewer' WHERE vault_id=? AND user_id=?", [
      vault.id,
      owner.user_id
    ])

    assert request(
             :put,
             path,
             %{content: "forbidden edit", expectedRevision: committed["revision"]},
             token
           ).status == 403

    reread = body(request(:get, path, nil, token))["note"]
    assert reread["content"] == "persisted edit"
    assert reread["revision"] == committed["revision"]
    assert File.read!(note.file_path) == "persisted edit"
  end

  defp body(conn), do: Jason.decode!(conn.resp_body)

  defp request(method, path, body, token),
    do: json_conn(method, path, body, token) |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
end
