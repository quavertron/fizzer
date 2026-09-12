defmodule Cascade.Chat.SessionImportTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.SessionImport
  alias Cascade.Content.Store

  setup do
    name = "import-#{System.unique_integer([:positive])}"
    SQL.exec("INSERT INTO users(username,password_hash,display_name,avatar_url) VALUES (?,'x',?,'')", [name, name])
    user = %{id: SQL.last_insert_id(), username: name}
    vault = Store.create_vault(user.id, %{name: "Session imports #{name}"})
    %{user: user, vault: vault}
  end

  test "pages are idempotent, preserve authors, and seed the original session without dispatching", %{user: user, vault: vault} do
    session = Ecto.UUID.generate()
    page = %{"id" => session, "title" => "Previous work", "cwd" => "/tmp/project", "messages" => [
      %{"index" => 20, "role" => "user", "body" => "Fix this", "createdAt" => "2026-09-01T12:00:00Z"},
      %{"index" => 40, "role" => "assistant", "body" => "Fixed it", "createdAt" => "2026-09-01T12:00:01Z"}
    ]}
    assert {:ok, imported} = SessionImport.import(user, vault.id, page)
    assert {:ok, ^imported} = SessionImport.import(user, vault.id, page)
    assert [["Fix this", nil], ["Fixed it", "codex"]] == SQL.all("SELECT body,agent_id FROM chat_messages WHERE channel_id=? ORDER BY created_at", [imported.channelId])
    assert [0] == SQL.one("SELECT count(*) FROM chat_agent_dispatches WHERE channel_id=?", [imported.channelId])
    assert [conversation] = SQL.one("SELECT conversation_id FROM chat_agent_members WHERE channel_id=?", [imported.channelId])
    assert session == Cascade.Runs.Store.find_conversation_session(%{vault_id: vault.id, note_id: nil, agent: "codex", conversation_id: conversation})
    payload = Cascade.Runs.PromptContext.delegate_payload(%{id: 1, vault_id: vault.id, conversation_id: conversation}, "/tmp/project", "codex", "Continue", %{}, session)
    assert payload.importedCodexSession
    assert ["/tmp/project"] == SQL.one("SELECT cwd FROM chat_agent_members WHERE channel_id=?", [imported.channelId])
    assert {:error, _} = SessionImport.import(%{user | id: user.id + 999999}, vault.id, page)
    assert {:ok, _} = SessionImport.import(user, vault.id, %{page | "messages" => [%{"index" => 60, "role" => "assistant", "body" => "More work", "createdAt" => "2026-09-01T12:00:02Z"}]})
    assert [3] == SQL.one("SELECT count(*) FROM chat_messages WHERE channel_id=?", [imported.channelId])
    {:ok, request} = Cascade.Chat.Messages.create(user, vault.id, imported.channelId, %{body: "Continue this work"})
    {:ok, [dispatch]} = Cascade.Missions.Dispatches.create_for_message(user.id, imported.channelId, request)
    {:ok, run} = Cascade.Runs.Store.start(vault.id, nil, "Continue", "codex", owner_user_id: user.id, conversation_id: conversation, chat_dispatch_id: dispatch.id)
    next_page = %{page | "messages" => [%{"index" => 80, "role" => "assistant", "body" => "No duplicate output", "createdAt" => "2026-09-01T12:00:03Z"}]}
    assert {:ok, %{following: true, paused: true}} = SessionImport.import(user, vault.id, next_page)
    Cascade.Runs.Store.publish(run.id, "session", %{sessionId: session})
    assert {:ok, %{following: false}} = SessionImport.import(user, vault.id, next_page)
    assert [0] == SQL.one("SELECT count(*) FROM chat_messages WHERE channel_id=? AND body='No duplicate output'", [imported.channelId])
  end

  test "invalid pages cannot create a channel", %{user: user, vault: vault} do
    count = SQL.one("SELECT count(*) FROM notes WHERE vault_id=?", [vault.id])
    assert {:error, _} = SessionImport.import(user, vault.id, %{"id" => Ecto.UUID.generate(), "messages" => [%{"role" => "system"}]})
    assert count == SQL.one("SELECT count(*) FROM notes WHERE vault_id=?", [vault.id])
  end
end
