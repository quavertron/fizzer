defmodule Cascade.Evolution do
  @moduledoc "Chat backlinks, chat-to-note distillation, and agent memory."

  alias Cascade.Content.{Privacy, Query, Store, Versions}

  @chat_marker "cascade://chat-channel"
  @agent_root "_agent"
  @memory "memory"

  def ensure_schema do
    Enum.each(
      [
        """
        CREATE TABLE IF NOT EXISTS chat_note_backlinks (
          id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, note_id TEXT,
          target_title TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          author TEXT NOT NULL, snippet TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted INTEGER NOT NULL DEFAULT 0,
          UNIQUE(message_id, target_title)
        )
        """,
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_note_idx ON chat_note_backlinks(note_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_msg_idx ON chat_note_backlinks(message_id)",
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_unresolved_idx ON chat_note_backlinks(vault_id, note_id, target_title)",
        """
        CREATE TABLE IF NOT EXISTS vault_settings (
          vault_id TEXT PRIMARY KEY, agent_memory_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS distill_jobs (
          id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', note_id TEXT,
          message_ids_json TEXT NOT NULL DEFAULT '[]', created_by INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), fingerprint TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS distill_jobs_fp_idx ON distill_jobs(vault_id, fingerprint)"
      ],
      &Query.execute/1
    )

    backlink_schema =
      case Query.one(
             "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_note_backlinks'"
           ) do
        [sql] -> sql || ""
        _ -> ""
      end

    unless Regex.match?(
             ~r/UNIQUE\s*\(\s*message_id\s*,\s*target_title\s*\)/i,
             backlink_schema
           ) do
      Query.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS chat_note_backlinks_message_title_unique ON chat_note_backlinks(message_id, target_title)"
      )
    end

    :ok
  end

  def extract_wiki_titles(body) do
    ~r/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u
    |> Regex.scan(to_string(body), capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce({MapSet.new(), []}, fn title, {seen, titles} ->
      key = String.downcase(title)

      if MapSet.member?(seen, key),
        do: {seen, titles},
        else: {MapSet.put(seen, key), [title | titles]}
    end)
    |> elem(1)
    |> Enum.reverse()
  end

  def index_chat_message_backlinks(vault_id, channel_id, message) do
    titles = extract_wiki_titles(value(message, :body, ""))
    snippet = truncate_snippet(value(message, :body, ""))
    created_at = value(message, :created_at, nil) || value(message, :createdAt, nil) || now()

    Enum.each(titles, fn title ->
      resolved = resolve_note_by_title(vault_id, title)

      Query.execute(
        """
        INSERT INTO chat_note_backlinks
          (id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(message_id, target_title) DO UPDATE SET
          note_id = excluded.note_id, author = excluded.author, snippet = excluded.snippet, deleted = 0
        """,
        [
          uuid(),
          vault_id,
          resolved && resolved.id,
          title,
          value(message, :id),
          channel_id,
          value(message, :author, ""),
          snippet,
          created_at
        ]
      )
    end)

    length(titles)
  end

  def tombstone_chat_message_backlinks(message_id) do
    Query.execute("UPDATE chat_note_backlinks SET deleted = 1 WHERE message_id = ?", [message_id])
    :ok
  end

  def reresolve_chat_backlinks(vault_id, note_id, title) do
    Query.execute(
      "UPDATE chat_note_backlinks SET note_id = ? WHERE vault_id = ? AND note_id IS NULL AND target_title = ? COLLATE NOCASE AND deleted = 0",
      [note_id, vault_id, title]
    ).num_rows
  end

  def list_chat_note_backlinks(note_id, opts \\ []) do
    limit = opts |> Keyword.get(:limit, 50) |> bounded(1, 200)
    offset = opts |> Keyword.get(:offset, 0) |> bounded(0, 2_147_483_647)
    note = Store.get_note(note_id)

    if note do
      reresolve_chat_backlinks(note.vault_id, note.id, note.title)
      deleted = if Keyword.get(opts, :include_deleted, false), do: "", else: "AND deleted = 0"

      Query.maps(
        """
        SELECT id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted
        FROM chat_note_backlinks
        WHERE (note_id = ? OR (note_id IS NULL AND target_title = ? COLLATE NOCASE AND vault_id = ?))
          #{deleted}
        ORDER BY created_at DESC LIMIT ? OFFSET ?
        """,
        [note_id, note.title, note.vault_id, limit, offset],
        [
          :id,
          :vaultId,
          :noteId,
          :targetTitle,
          :messageId,
          :channelId,
          :author,
          :snippet,
          :createdAt,
          :deleted
        ]
      )
      |> Enum.map(&Map.update!(&1, :deleted, fn value -> value != 0 end))
    else
      []
    end
  end

  def backfill_chat_note_backlinks(vault_id, opts \\ []) do
    limit = opts |> Keyword.get(:limit, 500) |> bounded(1, 5_000)
    after_rowid = opts |> Keyword.get(:after_rowid, 0) |> number(0) |> trunc()

    rows =
      Query.maps(
        """
        SELECT rowid, id, channel_id, author, body, created_at FROM chat_messages
        WHERE vault_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?
        """,
        [vault_id, after_rowid, limit],
        [:rowid, :id, :channel_id, :author, :body, :created_at]
      )

    indexed =
      Enum.reduce(rows, 0, fn row, count ->
        count + index_chat_message_backlinks(vault_id, row.channel_id, row)
      end)

    next = if length(rows) == limit, do: List.last(rows).rowid, else: nil
    %{processed: length(rows), indexed: indexed, nextAfterRowid: next}
  end

  def distill_chat_to_note(user_id, vault_id, channel_id, input) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    route = assert_chat_channel(channel_id, user_id)
    if route.local_vault_id != vault.id, do: raise(ArgumentError, "Chat channel not found")

    selected = route.source_channel_id |> list_chat_messages() |> select_messages(input)
    if selected == [], do: raise(ArgumentError, "No messages to distill")

    message_ids = Enum.map(selected, & &1.id)

    fingerprint =
      :crypto.hash(:sha256, Enum.join(message_ids, "\n"))
      |> Base.encode16(case: :lower)
      |> String.slice(0, 24)

    mode = value(input, :mode, "create") |> to_string()

    if mode == "create" do
      prior =
        Query.one(
          "SELECT note_id FROM distill_jobs WHERE vault_id = ? AND fingerprint = ? AND mode = 'create' AND note_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [vault_id, fingerprint]
        )

      if prior do
        case Store.get_note(hd(prior)) do
          nil ->
            :ok

          note ->
            throw(
              {:distill_result,
               %{
                 status: "exists",
                 mode: mode,
                 note: note,
                 messageIds: message_ids,
                 priorNoteId: note.id
               }}
            )
        end
      end
    end

    do_distill(mode, selected, route, user_id, vault_id, input, message_ids, fingerprint)
  catch
    {:distill_result, result} -> result
  end

  def ensure_agent_memory_folders(vault_id, user_id) do
    root = get_or_create_folder(vault_id, @agent_root, nil)
    memory = get_or_create_folder(vault_id, @memory, root.id)
    ensure_index(vault_id, user_id, memory.id, "Agent memory index (shared)")
    %{rootId: root.id, memoryId: memory.id}
  end

  def ensure_agent_named_memory_folders(vault_id, user_id, agent_key) do
    root = get_or_create_folder(vault_id, @agent_root, nil)
    key = sanitize_agent_folder(agent_key)

    if key in ["", "memory"] do
      shared = ensure_agent_memory_folders(vault_id, user_id)
      %{rootId: shared.rootId, agentRootId: shared.rootId, memoryId: shared.memoryId}
    else
      agent_root = get_or_create_folder(vault_id, key, root.id)
      memory = get_or_create_folder(vault_id, @memory, agent_root.id)
      ensure_index(vault_id, user_id, memory.id, "Agent memory — @#{key}")
      %{rootId: root.id, agentRootId: agent_root.id, memoryId: memory.id}
    end
  end

  def agent_memory_enabled?(vault_id) do
    case Query.one("SELECT agent_memory_enabled FROM vault_settings WHERE vault_id = ?", [
           vault_id
         ]) do
      [value] -> value != 0
      _ -> true
    end
  end

  def set_agent_memory_enabled(vault_id, enabled) do
    Query.execute(
      """
      INSERT INTO vault_settings (vault_id, agent_memory_enabled, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(vault_id) DO UPDATE SET agent_memory_enabled = excluded.agent_memory_enabled, updated_at = datetime('now')
      """,
      [vault_id, if(enabled, do: 1, else: 0)]
    )

    :ok
  end

  def build_agent_memory_injection(vault_id, opts \\ []) do
    if not agent_memory_enabled?(vault_id) do
      %{enabled: false, text: "", noteIds: [], truncated: false}
    else
      max_chars = opts |> Keyword.get(:max_chars, 4_000) |> bounded(500, 12_000)
      folders = Store.list_folders(vault_id)

      root =
        Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

      shared =
        root &&
          Enum.find(folders, &(&1.parent_id == root.id and String.downcase(&1.name) == @memory))

      key = sanitize_agent_folder(Keyword.get(opts, :agent_key, ""))

      named_root =
        root && key != "" &&
          Enum.find(
            folders,
            &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
          )

      named =
        named_root &&
          Enum.find(
            folders,
            &(&1.parent_id == named_root.id and String.downcase(&1.name) == @memory)
          )

      folder_ids = [named && named.id, shared && shared.id] |> Enum.reject(&is_nil/1)

      if folder_ids == [] do
        %{enabled: true, text: "", noteIds: [], truncated: false}
      else
        notes = memory_notes(vault_id, folder_ids)
        ranked = Keyword.get(opts, :ranked_note_ids, []) |> Enum.with_index() |> Map.new()
        topic_terms = query_terms(Keyword.get(opts, :channel_topic, ""))
        index = Enum.find(notes, &(String.downcase(&1.title) == "index"))
        # Named POLICIES is injected by Scratchpad; keep it out of knowledge excerpts.
        others =
          Enum.reject(notes, fn note ->
            String.downcase(note.title) == "index" or
              (not is_nil(named) and note.folder_id == named.id and
                 String.downcase(note.title) == "policies")
          end)

        semantic =
          others
          |> Enum.filter(&Map.has_key?(ranked, &1.id))
          |> Enum.sort_by(&Map.fetch!(ranked, &1.id))

        seen = MapSet.new(Enum.map(semantic, & &1.id))

        keyword =
          if topic_terms == [] do
            []
          else
            Enum.filter(others, fn note ->
              not MapSet.member?(seen, note.id) and
                Enum.any?(
                  topic_terms,
                  &String.contains?(String.downcase("#{note.title}\n#{note.content}"), &1)
                )
            end)
          end

        matched =
          if semantic == [] and keyword == [], do: Enum.take(others, 8), else: semantic ++ keyword

        ordered = if(index, do: [index], else: []) ++ Enum.take(matched, 12)
        inject_notes(ordered, max_chars, Keyword.get(opts, :note_stats, %{}))
      end
    end
  end

  def create_agent_memory_note(user_id, vault_id, input) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    agent_key = value(input, :agent_key, nil)

    memory_id =
      if agent_key,
        do: ensure_agent_named_memory_folders(vault_id, user_id, agent_key).memoryId,
        else: ensure_agent_memory_folders(vault_id, user_id).memoryId

    body = input |> value(:body, "") |> to_string() |> String.trim()
    if body == "", do: raise(ArgumentError, "Memory body is required")

    title =
      input
      |> value(:title, String.split(body, "\n") |> List.first() || "Memory")
      |> to_string()
      |> String.slice(0, 80)

    note =
      Store.create_note(vault_id, user_id, %{
        title: title,
        folder_id: memory_id,
        content: body <> "\n",
        is_listed: value(input, :listed, false) == true
      })

    prepend_index_pointer(vault_id, memory_id, note, body, user_id)
    note
  end

  defp do_distill(mode, selected, route, user_id, vault_id, input, message_ids, fingerprint) do
    summary = extractive_summary(selected)
    transcript = format_transcript(selected)
    by = value(input, :by, "distill")
    at = now()

    provenance =
      [
        "",
        "---",
        "",
        "## Sources",
        "",
        "distilled_from:",
        "- channel_id: `#{route.source_channel_id}`",
        "- at: #{at}",
        "- by: #{by}",
        "- mode: #{mode}",
        "- message_ids:"
      ] ++
        Enum.map(message_ids, &"  - `#{&1}`") ++
        ["", Enum.map_join(message_ids, "\n", &"- `#{&1}`"), ""]

    provenance = Enum.join(provenance, "\n")
    body_core = "#{summary}\n\n## Transcript\n\n#{transcript}#{provenance}"

    case mode do
      "merge" ->
        target =
          required_target(vault_id, value(input, :note_ref, nil), "merge mode requires --note")

        draft =
          [
            String.trim_trailing(target.content),
            "",
            "---",
            "",
            "## Distilled update (#{at})",
            "",
            summary,
            "",
            "### Incoming transcript",
            "",
            transcript,
            provenance
          ]
          |> Enum.join("\n")

        if value(input, :confirm, false) != true do
          %{
            status: "needs_confirm",
            mode: mode,
            draft: draft,
            messageIds: message_ids,
            priorNoteId: target.id
          }
        else
          note = Store.update_note(target.id, draft, user_id)
          Versions.create(note.id, draft, "distill-merge")

          completed_distill(
            note,
            mode,
            selected,
            route,
            user_id,
            vault_id,
            message_ids,
            fingerprint
          )
        end

      "append" ->
        target =
          required_target(vault_id, value(input, :note_ref, nil), "append mode requires --note")

        content =
          [
            String.trim_trailing(target.content),
            "",
            "---",
            "",
            "## Distilled from chat (#{at})",
            "",
            body_core
          ]
          |> Enum.join("\n")

        note = Store.update_note(target.id, content, user_id)
        Versions.create(note.id, content, "distill-append")

        completed_distill(
          note,
          mode,
          selected,
          route,
          user_id,
          vault_id,
          message_ids,
          fingerprint
        )

      _ ->
        title =
          input
          |> value(:title, "Chat distill #{String.slice(at, 0, 10)}")
          |> to_string()
          |> String.trim()

        note =
          Store.create_note(vault_id, user_id, %{
            title: title,
            content: "# #{title}\n\n#{body_core}\n",
            is_listed: false
          })

        Versions.create(note.id, note.content, "distill-create")

        completed_distill(
          note,
          "create",
          selected,
          route,
          user_id,
          vault_id,
          message_ids,
          fingerprint
        )
    end
  end

  defp completed_distill(note, mode, selected, route, user_id, vault_id, message_ids, fingerprint) do
    Enum.each(selected, fn message ->
      index_chat_message_backlinks(vault_id, route.source_channel_id, %{
        id: message.id,
        author: message.author,
        body: "#{message.body}\n![[#{note.title}]]",
        created_at: message.created_at
      })
    end)

    job_id = uuid()

    Query.execute(
      "INSERT INTO distill_jobs (id, vault_id, channel_id, mode, status, note_id, message_ids_json, created_by, fingerprint) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)",
      [
        job_id,
        vault_id,
        route.source_channel_id,
        mode,
        note.id,
        Jason.encode!(message_ids),
        user_id,
        fingerprint
      ]
    )

    %{status: "completed", mode: mode, note: note, messageIds: message_ids, jobId: job_id}
  end

  defp assert_chat_channel(channel_id, user_id) do
    note = Store.get_note(channel_id)

    if is_nil(note) or not chat_note?(note) or is_nil(Store.get_vault(note.vault_id, user_id)) do
      raise ArgumentError, "Chat channel not found"
    end

    link =
      if table_exists?("chat_channel_links") do
        Query.map(
          "SELECT local_channel_id, local_vault_id, source_channel_id, source_vault_id FROM chat_channel_links WHERE local_channel_id = ?",
          [channel_id],
          [:local_channel_id, :local_vault_id, :source_channel_id, :source_vault_id]
        )
      end

    link ||
      %{
        local_channel_id: note.id,
        local_vault_id: note.vault_id,
        source_channel_id: note.id,
        source_vault_id: note.vault_id
      }
  end

  defp list_chat_messages(channel_id) do
    Query.maps(
      """
      SELECT id, author, body, created_at FROM (
        SELECT id, author, body, created_at, rowid FROM chat_messages
        WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500
      ) ORDER BY created_at ASC, rowid ASC
      """,
      [channel_id],
      [:id, :author, :body, :created_at]
    )
  end

  defp select_messages(messages, input) do
    last_n = value(input, :last_n, nil) |> number(nil)
    from = value(input, :from_message_id, nil)
    to = value(input, :to_message_id, nil)

    cond do
      is_number(last_n) and last_n > 0 -> Enum.take(messages, -min(trunc(last_n), 500))
      from -> select_range(messages, from, to)
      true -> Enum.take(messages, -30)
    end
  end

  defp select_range(messages, from, to) do
    start = Enum.find_index(messages, &(&1.id == from))
    if is_nil(start), do: raise(ArgumentError, "from message not found: #{from}")

    if to do
      finish = Enum.find_index(messages, &(&1.id == to))
      if is_nil(finish), do: raise(ArgumentError, "to message not found: #{to}")
      {first, last} = if finish < start, do: {finish, start}, else: {start, finish}
      Enum.slice(messages, first..last)
    else
      Enum.slice(messages, start, 200)
    end
  end

  defp extractive_summary(messages) do
    authors = messages |> Enum.map(& &1.author) |> Enum.uniq() |> Enum.join(", ")

    lines = [
      "## Summary",
      "",
      "- **Participants:** #{if authors == "", do: "—", else: authors}",
      "- **Messages:** #{length(messages)}",
      "- **Span:** #{List.first(messages).created_at} → #{List.last(messages).created_at}",
      "",
      "## Highlights",
      ""
    ]

    candidates =
      messages
      |> Enum.filter(
        &(String.length(String.trim(&1.body)) > 40 and
            not Regex.match?(~r/^thinking\.\.\.?$/iu, &1.body))
      )
      |> Enum.take(-12)

    highlights =
      if candidates == [] do
        ["_No long messages to highlight — see transcript._"]
      else
        Enum.map(candidates, fn message ->
          body = message.body |> String.replace(~r/\s+/u, " ") |> String.slice(0, 220)

          "- **#{message.author}:** #{body}#{if String.length(message.body) > 220, do: "…", else: ""}"
        end)
      end

    decisions =
      messages
      |> Enum.filter(
        &Regex.match?(~r/\b(decid|action|todo|ship|fix|deploy|agree|will|should)\b/iu, &1.body)
      )
      |> Enum.take(-10)

    decision_lines =
      if decisions == [],
        do: ["_None auto-detected — review transcript._"],
        else:
          Enum.map(
            decisions,
            &"- (#{&1.author}) #{String.slice(String.replace(&1.body, ~r/\s+/u, " "), 0, 200)}"
          )

    Enum.join(
      lines ++ highlights ++ ["", "## Decisions / action items", ""] ++ decision_lines,
      "\n"
    )
  end

  defp format_transcript(messages) do
    Enum.map_join(messages, "\n\n", fn message ->
      timestamp = if message.created_at in [nil, ""], do: "", else: " — #{message.created_at}"

      "### #{message.author} (#{message.id})#{timestamp}\n\n#{if message.body == "", do: "(empty)", else: message.body}"
    end)
  end

  defp required_target(_vault_id, nil, error), do: raise(ArgumentError, error)

  defp required_target(vault_id, ref, _error) do
    resolve_note_ref(vault_id, ref) || raise(ArgumentError, "Note not found: #{ref}")
  end

  defp resolve_note_ref(vault_id, ref) do
    case Store.get_note(to_string(ref)) do
      %{vault_id: ^vault_id} = note -> note
      _ -> resolve_note_by_title(vault_id, ref) |> then(&(&1 && Store.get_note(&1.id)))
    end
  end

  defp resolve_note_by_title(vault_id, title) do
    Query.map(
      "SELECT id, title FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE LIMIT 1",
      [vault_id, title],
      [:id, :title]
    )
  end

  defp get_or_create_folder(vault_id, name, parent_id) do
    existing =
      if parent_id do
        Query.map(
          "SELECT id, name FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE",
          [vault_id, parent_id, name],
          [:id, :name]
        )
      else
        Query.map(
          "SELECT id, name FROM folders WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE",
          [vault_id, name],
          [:id, :name]
        )
      end

    existing || Store.create_folder(vault_id, %{name: name, parent_id: parent_id})
  end

  defp ensure_index(vault_id, user_id, folder_id, heading) do
    index =
      Query.map(
        "SELECT id, is_listed FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, folder_id],
        [:id, :is_listed]
      )

    cond do
      index && index.is_listed == 0 ->
        Query.execute("UPDATE notes SET is_listed = 1 WHERE id = ?", [index.id])
        Store.notify_note_mutation(index.id, user_id, :move)

      is_nil(index) ->
        Store.create_note(vault_id, user_id, %{
          title: "INDEX",
          folder_id: folder_id,
          is_listed: true,
          content:
            "# #{heading}\n\nOne-line pointers to memory notes in this folder. Higher lines = higher priority when trimming injection.\n\n## Pointers\n\n- (add bullets as agents learn facts)\n"
        })

      true ->
        :ok
    end
  end

  defp memory_notes(vault_id, folder_ids) do
    placeholders = Enum.map_join(folder_ids, ",", fn _ -> "?" end)

    Query.maps(
      "SELECT id, title, content, folder_id, updated_at FROM notes WHERE vault_id = ? AND folder_id IN (#{placeholders}) AND is_archived = 0 ORDER BY CASE WHEN title = 'INDEX' COLLATE NOCASE THEN 0 ELSE 1 END, updated_at DESC",
      [vault_id | folder_ids],
      [:id, :title, :content, :folder_id, :updated_at]
    )
    |> Enum.map(&Map.update!(&1, :content, fn body -> Privacy.redact_blocks(body) end))
  end

  defp inject_notes(notes, max_chars, stats) do
    initial = "Agent memory (vault):"

    {parts, ids, _used, truncated} =
      Enum.reduce_while(notes, {[initial], [], String.length(initial), false}, fn note,
                                                                                  {parts, ids,
                                                                                   used, _} ->
        body =
          note.content
          |> String.replace(~r/^---[\s\S]*?---\n/u, "")
          |> String.replace(~r/\s+/u, " ")
          |> String.trim()
          |> String.slice(0, 600)

        record = stats_record(Map.get(stats, note.id))
        chunk = "\n- [[#{note.title}]]#{record}: #{body}"

        if used + String.length(chunk) > max_chars do
          {:halt, {parts, ids, used, true}}
        else
          {:cont, {parts ++ [chunk], ids ++ [note.id], used + String.length(chunk), false}}
        end
      end)

    %{
      enabled: true,
      text: if(ids == [], do: "", else: Enum.join(parts)),
      noteIds: ids,
      truncated: truncated
    }
  end

  defp prepend_index_pointer(vault_id, memory_id, note, body, user_id) do
    index =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, memory_id],
        [:id, :content]
      )

    if index do
      pointer_body =
        body
        |> Privacy.redact_blocks()
        |> String.replace(~r/\s+/u, " ")
        |> String.slice(0, 120)

      pointer = "- [[#{note.title}]] — #{pointer_body}"

      next =
        if String.contains?(index.content, "## Pointers\n"),
          do:
            String.replace(index.content, "## Pointers\n", "## Pointers\n\n#{pointer}\n",
              global: false
            ),
          else: String.trim_trailing(index.content) <> "\n\n#{pointer}\n"

      Store.update_note(index.id, next, user_id)
    end
  end

  defp stats_record(nil), do: ""

  defp stats_record(stats) do
    uses = value(stats, :uses, 0)
    wins = value(stats, :wins, 0)
    losses = value(stats, :losses, 0)
    decided = wins + losses

    cond do
      uses <= 0 -> ""
      decided > 0 -> " [won #{wins}/#{decided}]"
      true -> " [used #{uses}×]"
    end
  end

  defp sanitize_agent_folder(name) do
    name
    |> to_string()
    |> String.replace(~r/^@+/u, "")
    |> String.trim()
    |> String.replace(~r|[<>:"/\\\|?*\x00-\x1f]+|u, "-")
    |> String.replace(~r/\s+/u, "-")
    |> String.slice(0, 64)
    |> case do
      "" -> "agent"
      value -> value
    end
  end

  defp chat_note?(note),
    do:
      String.starts_with?(String.trim(note.content_preview), @chat_marker) or
        String.starts_with?(String.trim(note.content), @chat_marker)

  defp truncate_snippet(value),
    do:
      value |> to_string() |> String.replace(~r/\s+/u, " ") |> String.trim() |> clip_ellipsis(500)

  defp clip_ellipsis(value, limit),
    do:
      if(String.length(value) > limit, do: String.slice(value, 0, limit - 1) <> "…", else: value)

  defp query_terms(query),
    do: Regex.scan(~r/[a-z0-9_]{3,}/u, String.downcase(to_string(query))) |> List.flatten()

  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp uuid, do: Ecto.UUID.generate()

  defp table_exists?(name),
    do: Query.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil

  defp bounded(value, low, high), do: value |> number(low) |> trunc() |> max(low) |> min(high)
  defp number(nil, fallback), do: fallback
  defp number(value, _fallback) when is_integer(value) or is_float(value), do: value

  defp number(value, fallback),
    do:
      case(Float.parse(to_string(value)),
        do: (
          {parsed, _} -> parsed
          :error -> fallback
        )
      )

  defp value(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), default))
end
