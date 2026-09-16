defmodule Cascade.Scratchpad do
  @moduledoc "Append-only agent journal, threads, skills, outcomes, promotion, recall, and boot context."

  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.Evolution

  @journal_kinds ~w(observation outcome dead-end decision todo papercut)
  @max_body_chars 4_000
  @max_thread_field 500
  @agent_root "_agent"
  @memory "memory"
  @skills "skills"
  @policies "POLICIES"

  @default_policies """
  # Scratchpad policies

  Use app context for standing behavior; keep only useful agent-specific corrections here.
  Scratchpad is optional: preserve reusable root causes, decisions, or dead ends,
  not routine progress. Recall useful knowledge when it helps; read a note before relying on it.
  Improve existing notes and retain useful unexpected connections within the authorized vault
  and task. Keep uncertainty and prior work intact. No documentation checklist or unrelated work.
  Open threads are private, agent-managed continuity, never questions for the user.
  """
  def ensure_schema do
    Enum.each(
      [
        """
        CREATE TABLE IF NOT EXISTS agent_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL,
          agent_key TEXT NOT NULL DEFAULT '', run_id INTEGER,
          kind TEXT NOT NULL DEFAULT 'observation', body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), consolidated_at TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS agent_journal_vault_idx ON agent_journal(vault_id, agent_key, id)",
        "CREATE INDEX IF NOT EXISTS agent_journal_open_idx ON agent_journal(vault_id, agent_key, consolidated_at)",
        """
        CREATE TABLE IF NOT EXISTS scratchpad_state (
          vault_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT '',
          last_consolidation_at TEXT, PRIMARY KEY (vault_id, agent_key)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS scratchpad_note_stats (
          note_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0, last_result TEXT, last_used_at TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS scratchpad_note_stats_vault_idx ON scratchpad_note_stats(vault_id)",
        """
        CREATE TABLE IF NOT EXISTS agent_open_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL,
          agent_key TEXT NOT NULL DEFAULT '', intent TEXT NOT NULL,
          blocked_on TEXT NOT NULL DEFAULT '', next_try TEXT NOT NULL DEFAULT '',
          pointer TEXT NOT NULL DEFAULT '', run_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT, close_reason TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS agent_open_threads_open_idx ON agent_open_threads(vault_id, agent_key, closed_at, id)"
      ],
      &Query.execute/1
    )

    if table_exists?("notes") do
      Query.execute(
        "DELETE FROM scratchpad_note_stats WHERE note_id NOT IN (SELECT id FROM notes)"
      )
    end

    :ok
  end

  def delete_note_stats(note_id) do
    Query.execute("DELETE FROM scratchpad_note_stats WHERE note_id = ?", [note_id])
    :ok
  end

  def append_journal_entry(user_id, vault_id, input) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    body =
      input
      |> value(:body, "")
      |> to_string()
      |> String.trim()
      |> String.slice(0, @max_body_chars)

    if body == "", do: raise(ArgumentError, "Journal entry body is required")
    raw_kind = input |> value(:kind, "") |> to_string()
    kind = if raw_kind in @journal_kinds, do: raw_kind, else: "observation"
    run_id = positive_number(value(input, :run_id, nil))

    Query.execute(
      "INSERT INTO agent_journal (vault_id, agent_key, run_id, kind, body) VALUES (?, ?, ?, ?, ?)",
      [vault.id, normalize_agent_key(value(input, :agent_key, "")), run_id, kind, body]
    )

    [id] = Query.one("SELECT last_insert_rowid()")
    journal_entry(Query.one("SELECT * FROM agent_journal WHERE id = ?", [id]))
  end

  def list_journal_entries(user_id, vault_id, opts \\ []) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    limit = opts |> Keyword.get(:limit, 100) |> bounded(1, 500)
    key = normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    {clauses, params} =
      [{"vault_id = ?", vault.id}]
      |> maybe_clause(key != "", "agent_key = ?", key)
      |> maybe_clause(
        Keyword.get(opts, :unconsolidated_only, false),
        "consolidated_at IS NULL",
        nil
      )
      |> maybe_clause(
        positive_number(Keyword.get(opts, :since_id)) != nil,
        "id > ?",
        positive_number(Keyword.get(opts, :since_id))
      )
      |> Enum.unzip()

    params = Enum.reject(params, &is_nil/1)

    Query.all(
      "SELECT * FROM agent_journal WHERE #{Enum.join(clauses, " AND ")} ORDER BY id ASC LIMIT ?",
      params ++ [limit]
    )
    |> Enum.map(&journal_entry/1)
  end

  def mark_journal_consolidated(user_id, vault_id, opts) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    through_id =
      positive_number(Keyword.get(opts, :through_id)) ||
        raise(ArgumentError, "throughId is required")

    key = normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    {sql, params} =
      if key == "" do
        {"UPDATE agent_journal SET consolidated_at = datetime('now') WHERE vault_id = ? AND id <= ? AND consolidated_at IS NULL",
         [vault.id, through_id]}
      else
        {"UPDATE agent_journal SET consolidated_at = datetime('now') WHERE vault_id = ? AND agent_key = ? AND id <= ? AND consolidated_at IS NULL",
         [vault.id, key, through_id]}
      end

    result = Query.execute(sql, params)

    Query.execute(
      """
      INSERT INTO scratchpad_state (vault_id, agent_key, last_consolidation_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(vault_id, agent_key) DO UPDATE SET last_consolidation_at = datetime('now')
      """,
      [vault.id, key]
    )

    result.num_rows
  end

  def status(vault_id, agent_key \\ nil) do
    key = normalize_agent_key(agent_key)
    filter = if key == "", do: "", else: "AND agent_key = ?"
    params = if key == "", do: [vault_id], else: [vault_id, key]

    [count, oldest] =
      Query.one(
        "SELECT COUNT(*), MIN(created_at) FROM agent_journal WHERE vault_id = ? #{filter} AND consolidated_at IS NULL",
        params
      )

    state =
      Query.one(
        "SELECT last_consolidation_at FROM scratchpad_state WHERE vault_id = ? AND agent_key = ?",
        [vault_id, key]
      )

    [open] =
      Query.one(
        "SELECT COUNT(*) FROM agent_open_threads WHERE vault_id = ? #{filter} AND closed_at IS NULL",
        params
      )

    %{
      agentKey: key,
      unconsolidated: count || 0,
      oldestUnconsolidatedAt: oldest,
      lastConsolidationAt: if(state, do: hd(state), else: nil),
      openThreads: open || 0
    }
  end

  def list_open_threads(user_id, vault_id, opts \\ []) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    key = normalize_agent_key(Keyword.get(opts, :agent_key, ""))
    limit = opts |> Keyword.get(:limit, 50) |> bounded(1, 200)

    {clauses, params} =
      [{"vault_id = ?", vault.id}]
      |> maybe_clause(key != "", "agent_key = ?", key)
      |> maybe_clause(not Keyword.get(opts, :include_closed, false), "closed_at IS NULL", nil)
      |> Enum.unzip()

    params = Enum.reject(params, &is_nil/1)

    Query.all(
      "SELECT * FROM agent_open_threads WHERE #{Enum.join(clauses, " AND ")} ORDER BY CASE WHEN closed_at IS NULL THEN 0 ELSE 1 END, id DESC LIMIT ?",
      params ++ [limit]
    )
    |> Enum.map(&open_thread/1)
  end

  def open_thread(user_id, vault_id, input) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    key = normalize_agent_key(value(input, :agent_key, ""))
    intent = clip_thread(value(input, :intent, ""), "intent", true)
    blocked = clip_thread(value(input, :blocked_on, ""), "blockedOn")
    next_try = clip_thread(value(input, :next_try, ""), "nextTry")
    pointer = clip_thread(value(input, :pointer, ""), "pointer")

    [open_count] =
      Query.one(
        "SELECT COUNT(*) FROM agent_open_threads WHERE vault_id = ? AND agent_key = ? AND closed_at IS NULL",
        [vault.id, key]
      )

    max_open = env_int("SCRATCHPAD_MAX_OPEN_THREADS", 7, 1, 20)

    if open_count >= max_open do
      raise ArgumentError,
            "already have #{open_count} open threads (max #{max_open}); close one first with cascade-scratchpad close <id>"
    end

    Query.execute(
      "INSERT INTO agent_open_threads (vault_id, agent_key, intent, blocked_on, next_try, pointer, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        vault.id,
        key,
        intent,
        blocked,
        next_try,
        pointer,
        positive_number(value(input, :run_id, nil))
      ]
    )

    [id] = Query.one("SELECT last_insert_rowid()")
    open_thread(Query.one("SELECT * FROM agent_open_threads WHERE id = ?", [id]))
  end

  def close_open_thread(user_id, vault_id, opts) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    thread_id =
      positive_number(Keyword.get(opts, :thread_id)) ||
        raise(ArgumentError, "threadId is required")

    key = normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    row =
      Query.one("SELECT * FROM agent_open_threads WHERE id = ? AND vault_id = ?", [
        thread_id,
        vault.id
      ])

    if is_nil(row), do: raise(ArgumentError, "open thread ##{thread_id} not found")
    thread = open_thread(row)

    if key != "" and thread.agentKey != "" and thread.agentKey != key do
      raise ArgumentError, "open thread ##{thread_id} belongs to @#{thread.agentKey}, not @#{key}"
    end

    if thread.closedAt do
      thread
    else
      reason = clip_thread(Keyword.get(opts, :reason, ""), "reason")
      reason = if reason == "", do: "closed", else: reason

      Query.execute(
        "UPDATE agent_open_threads SET closed_at = datetime('now'), close_reason = ?, updated_at = datetime('now') WHERE id = ?",
        [reason, thread_id]
      )

      Query.one("SELECT * FROM agent_open_threads WHERE id = ?", [thread_id]) |> open_thread()
    end
  end

  def recall(user_id, vault_id, input) do
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    query = input |> value(:query, "") |> to_string() |> String.trim()

    if query == "" do
      []
    else
      limit = input |> value(:limit, 5) |> bounded(1, 20)
      scope = recall_scope(vault.id, normalize_agent_key(value(input, :agent_key, "")))

      if map_size(scope) == 0 do
        []
      else
        recall_scored(vault.id, scope, query, limit, value(input, :ranked_ids, []))
      end
    end
  end

  def ensure_skills_folder(vault_id, user_id, agent_key) do
    key = normalize_agent_key(agent_key)

    parent_id =
      if key == "" do
        Evolution.ensure_agent_memory_folders(vault_id, user_id).rootId
      else
        Evolution.ensure_agent_named_memory_folders(vault_id, user_id, key).agentRootId
      end

    %{skillsId: get_or_create_child(vault_id, @skills, parent_id).id}
  end

  def create_skill_note(user_id, vault_id, input) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    title = input |> value(:title, "") |> to_string() |> String.trim() |> String.slice(0, 120)
    body = input |> value(:body, "") |> to_string() |> String.trim()
    if title == "", do: raise(ArgumentError, "Skill title is required")
    if body == "", do: raise(ArgumentError, "Skill body is required")
    folder_id = ensure_skills_folder(vault_id, user_id, value(input, :agent_key, "")).skillsId

    existing =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, folder_id, title],
        [:id, :content]
      )

    if existing do
      if String.trim(existing.content) != body, do: delete_note_stats(existing.id)
      Store.update_note(existing.id, body <> "\n", user_id)
    else
      Store.create_note(vault_id, user_id, %{
        title: title,
        folder_id: folder_id,
        is_listed: true,
        content: body <> "\n"
      })
    end
  end

  def list_skill_notes(user_id, vault_id, agent_key \\ nil) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    folders = skill_scope(vault_id, normalize_agent_key(agent_key))

    if folders == [] do
      []
    else
      placeholders = Enum.map_join(folders, ",", fn _ -> "?" end)

      Query.maps(
        """
        SELECT n.id, n.title, n.content, n.folder_id, n.updated_at,
               s.uses, s.wins, s.losses
        FROM notes n LEFT JOIN scratchpad_note_stats s ON s.note_id = n.id
        WHERE n.vault_id = ? AND n.folder_id IN (#{placeholders}) AND n.is_archived = 0
        """,
        [vault_id | Enum.map(folders, & &1.id)],
        [:id, :title, :content, :folder_id, :updated_at, :uses, :wins, :losses]
      )
      |> Enum.map(fn row ->
        %{
          id: row.id,
          title: row.title,
          description: skill_description(Privacy.redact_blocks(row.content)),
          shared: Enum.any?(folders, &(&1.id == row.folder_id and &1.shared)),
          updated_at: row.updated_at,
          stats:
            if(is_nil(row.uses),
              do: nil,
              else: %{uses: row.uses, wins: row.wins || 0, losses: row.losses || 0}
            )
        }
      end)
      |> Enum.sort_by(fn skill ->
        {-smoothed_win_rate(skill.stats), -decided(skill.stats), invert_string(skill.updated_at)}
      end)
      |> Enum.map(&Map.drop(&1, [:updated_at]))
      |> Enum.map(fn skill -> if skill.stats, do: skill, else: Map.delete(skill, :stats) end)
    end
  end

  def record_note_outcome(user_id, vault_id, input) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    ref = input |> value(:note_ref, "") |> to_string()

    note =
      resolve_note_ref(vault_id, ref, value(input, :agent_key, "")) ||
        raise(ArgumentError, "Note not found: #{ref}")

    result =
      if value(input, :result, "neutral") in ["win", "loss"],
        do: value(input, :result),
        else: "neutral"

    Query.execute(
      """
      INSERT INTO scratchpad_note_stats (note_id, vault_id, uses, wins, losses, last_result, last_used_at)
      VALUES (?, ?, 1, ?, ?, ?, datetime('now'))
      ON CONFLICT(note_id) DO UPDATE SET uses = uses + 1, wins = wins + excluded.wins,
        losses = losses + excluded.losses, last_result = excluded.last_result, last_used_at = datetime('now')
      """,
      [
        note.id,
        vault_id,
        if(result == "win", do: 1, else: 0),
        if(result == "loss", do: 1, else: 0),
        result
      ]
    )

    [uses, wins, losses] =
      Query.one("SELECT uses, wins, losses FROM scratchpad_note_stats WHERE note_id = ?", [
        note.id
      ])

    %{noteId: note.id, title: note.title, uses: uses, wins: wins, losses: losses}
  end

  def note_stats(vault_id) do
    Query.maps(
      "SELECT note_id, uses, wins, losses FROM scratchpad_note_stats WHERE vault_id = ?",
      [vault_id],
      [:note_id, :uses, :wins, :losses]
    )
    |> Map.new(fn row -> {row.note_id, Map.take(row, [:uses, :wins, :losses])} end)
  end

  def promote_note(user_id, vault_id, input) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    ref = input |> value(:note_ref, "") |> to_string()

    note =
      resolve_note_ref(vault_id, ref, value(input, :agent_key, "")) ||
        raise(ArgumentError, "Note not found: #{ref}")

    if is_nil(note.folder_id), do: raise(ArgumentError, "Note is not in an agent folder")

    folder =
      Query.map("SELECT id, name, parent_id FROM folders WHERE id = ?", [note.folder_id], [
        :id,
        :name,
        :parent_id
      ])

    if is_nil(folder), do: raise(ArgumentError, "Note folder not found")
    folder_name = String.downcase(folder.name)

    if folder_name not in [@memory, @skills] do
      raise ArgumentError, "Only notes in an agent memory or skills folder can be promoted"
    end

    kind = if folder_name == @memory, do: "memory", else: "skill"
    shared = Evolution.ensure_agent_memory_folders(vault_id, user_id)

    target =
      if kind == "memory",
        do: shared.memoryId,
        else: get_or_create_child(vault_id, @skills, shared.rootId).id

    if note.folder_id == target do
      %{note: note, kind: kind}
    else
      Store.move_note(note.id, target, nil, user_id)
      if kind == "memory", do: prepend_shared_pointer(vault_id, shared.memoryId, note, user_id)
      %{note: Store.get_note(note.id), kind: kind}
    end
  end

  def ensure_policies(vault_id, user_id, agent_key) do
    folder = Evolution.ensure_agent_named_memory_folders(vault_id, user_id, agent_key).memoryId

    existing =
      Query.one(
        "SELECT id FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, folder, @policies]
      )

    if existing do
      nil
    else
      Store.create_note(vault_id, user_id, %{
        title: @policies,
        folder_id: folder,
        is_listed: true,
        content: @default_policies
      })
    end
  end

  def build_injection(vault_id, opts \\ []) do
    max_chars = opts |> Keyword.get(:max_chars, 1_600) |> bounded(300, 4_000)
    key = normalize_agent_key(Keyword.get(opts, :agent_key, ""))
    current = status(vault_id, key)

    lines = [
      "Scratchpad is optional persistent memory. Use `cascade-scratchpad jot` only for a reusable root cause, decision, or dead end; skip routine progress and simple Q&A. Use `recall <query>` only when the task looks familiar. Open threads are private: manage them yourself and never ask the user about them.",
      "Journal: #{current.unconsolidated} unconsolidated #{if current.unconsolidated == 1, do: "entry", else: "entries"}#{if current.lastConsolidationAt, do: "; last consolidation #{current.lastConsolidationAt}", else: ""}; open threads: #{current.openThreads}."
    ]

    lines =
      if consolidation_due?(current),
        do:
          lines ++
            ["Consolidation is due, but do not spend this chat run on it unless the user asks."],
        else: lines

    lines = append_thread_injection(lines, vault_id, key, current.openThreads)

    lines =
      if Keyword.has_key?(opts, :user_id) do
        skills = list_skill_notes(Keyword.fetch!(opts, :user_id), vault_id, key) |> Enum.take(8)

        if skills == [],
          do: lines,
          else:
            lines ++
              [
                "Skills (read the full note with `cascade-note get <title>` before applying):\n" <>
                  Enum.map_join(skills, "\n", &skill_line/1)
              ]
      else
        lines
      end

    append_policies(lines, vault_id, key, max_chars)
  end

  def format_win_record(nil), do: ""

  def format_win_record(stats) do
    uses = value(stats, :uses, 0)
    wins = value(stats, :wins, 0)
    losses = value(stats, :losses, 0)
    decided = wins + losses

    cond do
      uses == 0 -> ""
      decided == 0 -> "used #{uses}×"
      true -> "won #{wins}/#{decided}"
    end
  end

  defp recall_scored(vault_id, scope, query, limit, ranked_ids) do
    folder_ids = Map.keys(scope)
    placeholders = Enum.map_join(folder_ids, ",", fn _ -> "?" end)

    notes =
      Query.maps(
        "SELECT id, title, content, folder_id FROM notes WHERE vault_id = ? AND folder_id IN (#{placeholders}) AND is_archived = 0 AND title <> 'INDEX' COLLATE NOCASE",
        [vault_id | folder_ids],
        [:id, :title, :content, :folder_id]
      )

    terms = query_terms(query)
    ranks = ranked_ids |> Enum.with_index() |> Map.new()
    stats = note_stats(vault_id)

    notes
    |> Enum.flat_map(fn note ->
      meta = scope[note.folder_id]
      body = note.content |> Privacy.redact_blocks() |> String.replace(~r/^---[\s\S]*?---\n/u, "")
      auto = meta.kind == "memory" and auto_capture?(note.title, body)
      title_hits = lexical_hits(terms, note.title)
      body_hits = lexical_hits(terms, "#{note.title}\n#{body}")
      minimum = if auto, do: min(2, length(terms)), else: 1

      if terms == [] or body_hits < minimum do
        []
      else
        score =
          body_hits + title_hits * 0.75 + if(meta.kind == "skill", do: 2.5, else: 0.0) +
            if(meta.shared, do: 0.0, else: 0.5) - if(auto, do: 2.0, else: 0.0)

        score =
          score + if(stats[note.id], do: smoothed_win_rate(stats[note.id]) * 0.75, else: 0.0)

        score =
          score +
            if(Map.has_key?(ranks, note.id), do: max(0, 1.2 - ranks[note.id] * 0.08), else: 0.0)

        [%{note: note, meta: meta, score: score}]
      end
    end)
    |> Enum.filter(&(&1.score >= 1.0))
    |> Enum.sort_by(&{-&1.score, &1.note.title})
    |> Enum.take(limit)
    |> Enum.map(fn hit ->
      body =
        hit.note.content
        |> Privacy.redact_blocks()
        |> String.replace(~r/^---[\s\S]*?---\n/u, "")
        |> String.replace(~r/\s+/u, " ")
        |> String.trim()
        |> String.slice(0, 240)

      %{
        id: hit.note.id,
        title: hit.note.title,
        snippet: body,
        kind: hit.meta.kind,
        shared: hit.meta.shared
      }
      |> maybe_put(:stats, stats[hit.note.id])
    end)
  end

  defp recall_scope(vault_id, key) do
    folders = Store.list_folders(vault_id)
    root = Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

    if is_nil(root) do
      %{}
    else
      shared = children_scope(folders, root.id, true)

      agent =
        Enum.find(
          folders,
          &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
        )

      Map.merge(shared, if(agent, do: children_scope(folders, agent.id, false), else: %{}))
    end
  end

  defp children_scope(folders, parent_id, shared) do
    folders
    |> Enum.filter(
      &(&1.parent_id == parent_id and String.downcase(&1.name) in [@memory, @skills])
    )
    |> Map.new(fn folder ->
      {folder.id,
       %{
         kind: if(String.downcase(folder.name) == @memory, do: "memory", else: "skill"),
         shared: shared
       }}
    end)
  end

  defp skill_scope(vault_id, key) do
    folders = Store.list_folders(vault_id)
    root = Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

    if is_nil(root) do
      []
    else
      shared =
        Enum.find(folders, &(&1.parent_id == root.id and String.downcase(&1.name) == @skills))

      agent_root =
        Enum.find(
          folders,
          &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
        )

      own =
        agent_root &&
          Enum.find(
            folders,
            &(&1.parent_id == agent_root.id and String.downcase(&1.name) == @skills)
          )

      [%{folder: shared, shared: true}, %{folder: own, shared: false}]
      |> Enum.reject(&is_nil(&1.folder))
      |> Enum.map(&%{id: &1.folder.id, shared: &1.shared})
    end
  end

  defp resolve_note_ref(vault_id, ref, key) do
    trimmed = String.trim(to_string(ref))
    by_id = Store.get_note(trimmed)

    cond do
      by_id && by_id.vault_id == vault_id -> by_id
      true -> resolve_title(vault_id, trimmed, key)
    end
  end

  defp resolve_title(vault_id, title, key) do
    rows =
      Query.maps(
        "SELECT id, folder_id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, title],
        [:id, :folder_id]
      )

    case rows do
      [] ->
        nil

      [row] ->
        Store.get_note(row.id)

      many ->
        key = normalize_agent_key(key)

        if key != "" do
          scope = recall_scope(vault_id, key)
          own = Enum.filter(many, &(scope[&1.folder_id] && not scope[&1.folder_id].shared))
          shared = Enum.filter(many, &(scope[&1.folder_id] && scope[&1.folder_id].shared))

          cond do
            length(own) == 1 -> Store.get_note(hd(own).id)
            length(own) > 1 -> ambiguous_title(title, many)
            length(shared) == 1 -> Store.get_note(hd(shared).id)
            true -> ambiguous_title(title, many)
          end
        else
          ambiguous_title(title, many)
        end
    end
  end

  defp ambiguous_title(title, rows),
    do:
      raise(
        ArgumentError,
        "Ambiguous title \"#{title}\" matches #{length(rows)} notes — use a note id: #{Enum.map_join(rows, ", ", & &1.id)}"
      )

  defp get_or_create_child(vault_id, name, parent_id) do
    Query.map(
      "SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE",
      [vault_id, parent_id, name],
      [:id]
    ) || Store.create_folder(vault_id, %{name: name, parent_id: parent_id})
  end

  defp prepend_shared_pointer(vault_id, folder_id, note, user_id) do
    index =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, folder_id],
        [:id, :content]
      )

    if index && not String.contains?(index.content, "[[#{note.title}]]") do
      hook =
        note.content
        |> Privacy.redact_blocks()
        |> String.replace(~r/^---[\s\S]*?---\n/u, "")
        |> String.replace(~r/\s+/u, " ")
        |> String.trim()
        |> String.slice(0, 120)

      pointer = "- [[#{note.title}]] — #{hook}"

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

  defp append_thread_injection(lines, vault_id, key, open_count) do
    limit =
      min(
        env_int("SCRATCHPAD_BOOT_OPEN_THREADS", 5, 1, 20),
        env_int("SCRATCHPAD_MAX_OPEN_THREADS", 7, 1, 20)
      )

    filter = if key == "", do: "", else: "AND agent_key = ?"
    params = if key == "", do: [vault_id, limit], else: [vault_id, key, limit]

    rows =
      Query.all(
        "SELECT * FROM agent_open_threads WHERE vault_id = ? #{filter} AND closed_at IS NULL ORDER BY id DESC LIMIT ?",
        params
      )
      |> Enum.map(&open_thread/1)

    if rows == [] do
      lines
    else
      more =
        if open_count > length(rows),
          do: " (+#{open_count - length(rows)} more — cascade-scratchpad open)",
          else: ""

      body = Enum.map_join(rows, "\n", fn thread -> "  - " <> thread_line(thread) end)

      lines ++
        [
          "Your open threads#{more} (private — continue or close yourself; do not ask the user; stale is worse than empty):\n#{body}"
        ]
    end
  end

  defp append_policies(lines, vault_id, key, max_chars) do
    rows =
      Query.maps(
        "SELECT n.id, n.content, f.parent_id FROM notes n JOIN folders f ON f.id = n.folder_id WHERE n.vault_id = ? AND n.title = ? COLLATE NOCASE AND f.name = 'memory' COLLATE NOCASE",
        [vault_id, @policies],
        [:id, :content, :parent_id]
      )

    note =
      cond do
        rows == [] ->
          nil

        length(rows) == 1 or key == "" ->
          hd(rows)

        true ->
          parent =
            Query.map(
              "SELECT id FROM folders WHERE vault_id = ? AND name = ? COLLATE NOCASE",
              [vault_id, key],
              [:id]
            )

          Enum.find(rows, &(&1.parent_id == (parent && parent.id))) || hd(rows)
      end

    if note do
      body =
        note.content |> Privacy.redact_blocks() |> String.replace(~r/\s+/u, " ") |> String.trim()

      budget = max_chars - String.length(Enum.join(lines, "\n")) - 24

      if budget > 120,
        do: Enum.join(lines ++ ["Your POLICIES note: #{String.slice(body, 0, budget)}"], "\n"),
        else: Enum.join(lines, "\n")
    else
      Enum.join(lines, "\n")
    end
  end

  defp consolidation_due?(current) do
    cond do
      current.unconsolidated == 0 ->
        false

      current.unconsolidated >= env_int("SCRATCHPAD_DUE_ENTRIES", 3, 1, 2_147_483_647) ->
        true

      current.oldestUnconsolidatedAt ->
        case NaiveDateTime.from_iso8601(current.oldestUnconsolidatedAt) do
          {:ok, oldest} ->
            NaiveDateTime.diff(NaiveDateTime.utc_now(), oldest, :hour) >=
              env_int("SCRATCHPAD_DUE_AGE_HOURS", 24, 1, 2_147_483_647)

          _ ->
            false
        end

      true ->
        false
    end
  end

  defp journal_entry([id, vault_id, agent_key, run_id, kind, body, created_at, consolidated_at]) do
    %{
      id: id,
      vaultId: vault_id,
      agentKey: agent_key,
      runId: run_id,
      kind: if(kind in @journal_kinds, do: kind, else: "observation"),
      body: body,
      createdAt: created_at,
      consolidatedAt: consolidated_at
    }
  end

  defp open_thread([
         id,
         vault_id,
         agent_key,
         intent,
         blocked_on,
         next_try,
         pointer,
         run_id,
         created_at,
         updated_at,
         closed_at,
         close_reason
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      agentKey: agent_key,
      intent: intent,
      blockedOn: blocked_on || "",
      nextTry: next_try || "",
      pointer: pointer || "",
      runId: run_id,
      createdAt: created_at,
      updatedAt: updated_at,
      closedAt: closed_at,
      closeReason: close_reason
    }
  end

  defp thread_line(thread) do
    [
      "##{thread.id} #{thread.intent}",
      if(thread.blockedOn != "", do: "blocked: #{thread.blockedOn}"),
      if(thread.nextTry != "", do: "next: #{thread.nextTry}"),
      if(thread.pointer != "", do: "ptr: #{thread.pointer}")
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" | ")
  end

  defp skill_line(skill) do
    record = format_win_record(Map.get(skill, :stats))

    "  - [[#{skill.title}]]#{if skill.shared, do: " [shared]", else: ""} — #{skill.description}#{if record == "", do: "", else: " (#{record})"}"
  end

  defp skill_description(content) do
    content
    |> String.replace(~r/^---[\s\S]*?---\n/u, "")
    |> String.split("\n")
    |> Enum.map(&(String.replace(&1, ~r/^#+\s*/u, "") |> String.trim()))
    |> Enum.find("", &(&1 != ""))
    |> String.slice(0, 140)
  end

  defp auto_capture?(title, body),
    do:
      Regex.match?(~r/Captured from completed run/iu, body) or
        (Regex.match?(~r/##\s*Request\b/iu, body) and Regex.match?(~r/##\s*Outcome\b/iu, body)) or
        (Regex.match?(~r/\(\d{2,}\)\s*$/u, title) and Regex.match?(~r/Channel:\s*/iu, body))

  defp query_terms(query),
    do: Regex.scan(~r/[a-z0-9_]{3,}/u, String.downcase(to_string(query))) |> List.flatten()

  defp lexical_hits(terms, haystack),
    do: Enum.count(terms, &String.contains?(String.downcase(haystack), &1))

  defp smoothed_win_rate(nil), do: 0.5

  defp smoothed_win_rate(stats),
    do: (value(stats, :wins, 0) + 1) / (value(stats, :wins, 0) + value(stats, :losses, 0) + 2)

  defp decided(nil), do: 0
  defp decided(stats), do: value(stats, :wins, 0) + value(stats, :losses, 0)

  defp invert_string(value),
    do: value |> to_string() |> String.to_charlist() |> Enum.map(&(0x10FFFF - &1))

  defp clip_thread(value, label, required \\ false) do
    text = value |> to_string() |> String.trim() |> String.slice(0, @max_thread_field)
    if required and text == "", do: raise(ArgumentError, "#{label} is required"), else: text
  end

  defp normalize_agent_key(value),
    do:
      value |> to_string() |> String.replace(~r/^@+/u, "") |> String.trim() |> String.slice(0, 64)

  defp positive_number(value) do
    case number(value, nil) do
      number when is_number(number) and number > 0 -> trunc(number)
      _ -> nil
    end
  end

  defp maybe_clause(items, false, _clause, _param), do: items
  defp maybe_clause(items, true, clause, nil), do: items ++ [{clause, nil}]
  defp maybe_clause(items, true, clause, param), do: items ++ [{clause, param}]
  defp bounded(value, low, high), do: value |> number(low) |> trunc() |> max(low) |> min(high)
  defp number(nil, fallback), do: fallback
  defp number(value, _fallback) when is_integer(value) or is_float(value), do: value

  defp number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      :error -> fallback
    end
  end

  defp env_int(name, default, low, high),
    do: System.get_env(name) |> number(default) |> trunc() |> max(low) |> min(high)

  defp table_exists?(name),
    do: Query.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp value(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), default))
end
