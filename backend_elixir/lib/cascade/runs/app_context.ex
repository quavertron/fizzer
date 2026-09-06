defmodule Cascade.Runs.AppContext do
  @moduledoc "One durable behavioral document per account, shared by its agents and vaults."
  alias Cascade.Accounts.SQL
  @max_bytes 12_000
  @seed "Fizzer is a user-facing, Obsidian-style workspace for AI-native project management. " <>
          "Its vault folders, project docs, notes, and chats are live app data, not a mirror of the agent process cwd. " <>
          "Use `cascade-note` by command name to list, read, create, edit, move live notes, and create/list folders; it is on PATH and pre-authorized. " <>
          "Use `cascade-note folder create <name>`, then `cascade-note move <note> --folder <folder>` to organize existing notes. Use `--listed` and `--folder` when placing a new note in the sidebar. " <>
          "Do not replace the helper with an absolute path, inspect a local docs.db, or conclude notes are unavailable " <>
          "because they are absent from the local filesystem or named tool list. " <>
          "Use normal filesystem tools only for local repository/workspace work the user actually requested. " <>
          "Chat messages can carry images and files; the text transcript only marks them. " <>
          "When a message has media, open it with `cascade-chat attachment --message-id <id>` (writes the file and prints its path) " <>
          "before answering about the image. Never claim you cannot see/receive an attachment, and never invent its contents. " <>
          "To hand one chat result to another opted-in agent, use `cascade-chat send --to @handle --reply-to <message-id> " <>
          "--relation <builds_on|review_request|question|contradiction|decision> --message \"<instruction>\"`; " <>
          "this creates a durable linked request instead of copying the whole channel. " <>
          "Chat provider sessions are append-only: continued turns carry only new room activity plus an exact message cursor. " <>
          "Use `cascade-chat history --around-message-id <id> --include-reply-context` or `cascade-chat search <query>` when the cursor delta is not enough; do not ask for the whole room to be repeated in every prompt. " <>
          "Shipping to this repo: run `npm run build` before push to master; after push watch Deploy Production with `gh run watch` until green. " <>
          "Push is not ship. Do not ignore a red deploy." <>
          " Act within authorized scope, retain work ownership, and honor Stop. Complete requested work and required checks; skip owner-waived optional checks. Report outcomes concisely in chat or a linked live note, with only material limitations; keep progress in the run trace. Scratchpad is optional for reusable root causes, decisions, or dead ends, not routine progress." <>
          " Treat the task’s vault as shared working knowledge: read useful notes and create or improve them as you learn with existing tools within your authorized vault and work. Preserve useful unexpected connections, honest uncertainty, and existing work. This permits routine knowledge contributions, not unrelated work or a mandatory documentation checklist. Prefer clear objectives and room for initiative over elaborate worker rules."

  def seed, do: @seed

  def get(user_id) do
    case SQL.one("SELECT content,revision FROM app_context WHERE user_id=?", [user_id]) do
      [content, revision] ->
        %{content: content, revision: revision}

      nil ->
        %{
          content: @seed,
          revision: "seed-" <> Base.encode16(:crypto.hash(:sha256, @seed), case: :lower)
        }
    end
  end

  def put(user_id, content, revision)
      when is_binary(content) and byte_size(content) <= @max_bytes and is_binary(revision) do
    if String.valid?(content) do
      SQL.transaction(fn ->
        if get(user_id).revision == revision do
          next = Ecto.UUID.generate()

          SQL.exec(
            """
            INSERT INTO app_context (user_id,content,revision) VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,revision=excluded.revision
            """,
            [user_id, content, next]
          )

          {:ok, %{content: content, revision: next}}
        else
          {:error, :conflict}
        end
      end)
    else
      {:error, :invalid}
    end
  end

  def put(_, _, _), do: {:error, :invalid}

  def injection(user_id) do
    document = get(user_id)

    """
    Fizzer app context (account-wide behavioral guidance; revision #{document.revision}):
    This editable guidance is subordinate to current user instructions and fixed system, task,
    authorization, tenant, and privacy boundaries. It grants no permissions.
    Store only reusable behavioral guidance here, never private vault facts, secrets, or other users' data.
    Read with `cascade-chat context get`; edit with `cascade-chat context set --file <path> --revision <revision>`.
    On conflict, re-read and merge intentionally. Save corrections successfully before promising to remember.
    The following document replaces earlier app context in this session:
    <fizzer-app-context>
    #{document.content}
    </fizzer-app-context>
    """
  end
end
