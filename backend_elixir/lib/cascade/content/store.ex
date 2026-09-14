defmodule Cascade.Content.Store do
  @moduledoc "Node-compatible vault, folder, note, tag, link, graph, and filesystem storage."

  import Bitwise

  alias Cascade.Content.Query

  @chat_channel_marker "cascade://chat-channel"

  @vault_fields [
    :id,
    :name,
    :root_path,
    :created_by,
    :created_at,
    :visibility,
    :public_join_role,
    :public_summary,
    :public_topics,
    :public_guidelines,
    :public_home_note_id,
    :public_join_policy
  ]
  @folder_fields [:id, :vault_id, :parent_id, :name, :position, :created_at]
  @note_summary_fields [
    :id,
    :vault_id,
    :folder_id,
    :title,
    :content_preview,
    :is_pinned,
    :is_archived,
    :is_listed,
    :position,
    :word_count,
    :created_at,
    :updated_at
  ]

  def vaults_base_dir do
    case System.get_env("CASCADE_VAULTS_BASE_DIR", "") |> String.trim() do
      "" -> Path.join([System.user_home!(), ".cascade", "vaults"])
      configured -> Path.expand(configured)
    end
  end

  def sanitize_filename(title) do
    value =
      title
      |> to_string()
      |> String.replace(~r{[<>:"/\\|?*\x00-\x1f]}u, "_")
      |> String.replace(~r/\s+/u, " ")
      |> String.trim()

    if value == "", do: "Untitled", else: value
  end

  def sanitize_path_segment(name) do
    raw = name |> to_string() |> String.trim()

    if raw == "" or raw in [".", ".."] or String.contains?(raw, ["/", "\\"]) do
      raise ArgumentError, "Invalid folder or file name"
    end

    cleaned =
      raw
      |> sanitize_filename()
      |> String.replace(~r/^\.+/u, "")
      |> String.trim()

    if cleaned == "" or cleaned in [".", ".."] or String.starts_with?(cleaned, "..") do
      raise ArgumentError, "Invalid folder or file name"
    end

    cleaned
  end

  def resolve_under_vault(vault_root, parts) when is_list(parts) do
    root = Path.expand(vault_root)
    resolved = Path.expand(Path.join([root | parts]))

    if resolved == root or String.starts_with?(resolved, root <> "/") do
      resolved
    else
      raise ArgumentError, "Path escapes vault root"
    end
  end

  def extract_links(content) do
    ~r/\[\[([^\]]+)\]\]/u
    |> Regex.scan(to_string(content), capture: :all_but_first)
    |> Enum.map(fn [title] -> String.trim(title) end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  def list_vaults(user_id) do
    hide_direct_messages =
      if Query.one(
           "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_dm_vaults'"
         ),
         do: "AND NOT EXISTS (SELECT 1 FROM user_dm_vaults dm WHERE dm.vault_id = v.id)",
         else: ""

    try do
      Query.maps(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy,
               m.role,
               (SELECT COUNT(*) FROM vault_members c WHERE c.vault_id = v.id) AS memberCount
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE m.user_id = ?
          #{hide_direct_messages}
        ORDER BY v.created_at DESC
        """,
        [user_id],
        @vault_fields ++ [:role, :memberCount]
      )
    rescue
      _ ->
        Query.maps(
          "SELECT v.id, v.name, v.root_path, v.created_by, v.created_at, v.visibility, v.public_join_role, v.public_summary, v.public_topics, v.public_guidelines, v.public_home_note_id, v.public_join_policy FROM vaults v WHERE v.created_by = ? #{hide_direct_messages} ORDER BY v.created_at DESC",
          [user_id],
          @vault_fields
        )
        |> Enum.map(&Map.merge(&1, %{role: "owner", memberCount: 1}))
    end
  end

  def get_vault(vault_id, user_id) do
    try do
      Query.map(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE v.id = ? AND m.user_id = ?
        """,
        [vault_id, user_id],
        @vault_fields
      )
    rescue
      _ ->
        Query.map(
          "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ? AND created_by = ?",
          [vault_id, user_id],
          @vault_fields
        )
    end
  end

  def get_writable_vault(vault_id, user_id) do
    try do
      Query.map(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE v.id = ? AND m.user_id = ? AND m.role IN ('owner', 'editor')
        """,
        [vault_id, user_id],
        @vault_fields
      )
    rescue
      _ -> get_vault(vault_id, user_id)
    end
  end

  def vault_role(vault_id, user_id) do
    case Query.one("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?", [
           vault_id,
           user_id
         ]) do
      [role] -> role
      nil -> nil
    end
  end

  def create_vault(user_id, opts) do
    id = Ecto.UUID.generate()
    name = default_string(value(opts, :name), "My Vault")
    root_path = unique_vault_root_path(user_id, id, name)

    if vault_root_taken?(root_path),
      do: raise(ArgumentError, "Vault storage path is already in use")

    File.mkdir_p!(root_path)

    Query.execute("INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)", [
      id,
      name,
      root_path,
      user_id
    ])

    try do
      Query.execute(
        """
        INSERT INTO vault_members (vault_id, user_id, role, invited_by)
        VALUES (?, ?, 'owner', ?)
        ON CONFLICT(vault_id, user_id) DO UPDATE SET role = 'owner'
        """,
        [id, user_id, user_id]
      )
    rescue
      _ -> :ok
    end

    vault = raw_vault(id)

    try do
      entries = File.ls!(root_path) |> Enum.reject(&(&1 == ".DS_Store"))

      if entries == [],
        do:
          create_note(id, user_id, %{
            title: "General",
            content: "cascade://chat-channel",
            is_listed: true
          })

      rescan_vault(id, user_id)
    rescue
      error ->
        require Logger
        Logger.error("Failed to prepopulate vault walkthrough: #{Exception.message(error)}")
    end

    vault
  end

  def rename_vault(vault_id, name) do
    next = name |> to_string() |> String.trim()
    if next == "", do: raise(ArgumentError, "Vault name is required")

    if String.length(next) > 80,
      do: raise(ArgumentError, "Vault name must be 80 characters or fewer")

    if is_nil(raw_vault(vault_id)), do: raise(ArgumentError, "Vault not found")
    Query.execute("UPDATE vaults SET name = ? WHERE id = ?", [next, vault_id])
    raw_vault(vault_id)
  end

  def delete_vault(vault_id, user_id) do
    case Query.map(
           "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ? AND created_by = ?",
           [vault_id, user_id],
           @vault_fields
         ) do
      nil ->
        false

      vault ->
        root = Path.expand(vault.root_path || "")
        base = Path.expand(vaults_base_dir())

        unless String.starts_with?(root, base <> "/") do
          raise ArgumentError, "Vault storage path is outside the managed vault directory"
        end

        Query.execute("DELETE FROM vaults WHERE id = ? AND created_by = ?", [vault_id, user_id])
        File.rm_rf!(root)
        true
    end
  end

  def enforce_storage_isolation do
    vaults =
      Query.maps(
        "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults ORDER BY created_at ASC, rowid ASC",
        [],
        @vault_fields
      )

    groups =
      vaults
      |> Enum.reject(fn vault -> Path.expand(vault.root_path || "") == Path.expand("/") end)
      |> Enum.group_by(fn vault -> Path.expand(vault.root_path || "") end)

    rehomed =
      Enum.reduce(groups, 0, fn {_root, group}, count ->
        case group do
          [_single] ->
            count

          [_canonical | intruders] ->
            Enum.each(intruders, fn vault ->
              next_root =
                unique_vault_root_path(vault.created_by, vault.id, vault.name || "My Vault")

              File.mkdir_p!(next_root)
              purge_vault_index(vault.id)
              Query.execute("UPDATE vaults SET root_path = ? WHERE id = ?", [next_root, vault.id])

              try do
                create_note(vault.id, vault.created_by, %{
                  title: "General",
                  content: "cascade://chat-channel",
                  is_listed: true
                })

                rescan_vault(vault.id, vault.created_by)
              rescue
                _ -> :ok
              end
            end)

            count + length(intruders)
        end
      end)

    Enum.each(vaults, fn vault ->
      resolved = Path.expand(vault.root_path || "")

      if resolved != vault.root_path and not vault_root_taken?(resolved, vault.id) do
        Query.execute("UPDATE vaults SET root_path = ? WHERE id = ?", [resolved, vault.id])
      end
    end)

    try do
      Query.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS vaults_root_path_uidx ON vaults(root_path)"
      )
    rescue
      _ -> :ok
    end

    %{rehomed: rehomed}
  end

  def list_folders(vault_id) do
    Query.maps(
      "SELECT id, vault_id, parent_id, name, position, created_at FROM folders WHERE vault_id = ? ORDER BY position ASC, name ASC",
      [vault_id],
      @folder_fields
    )
  end

  def get_folder(folder_id) do
    Query.map(
      "SELECT id, vault_id, parent_id, name, position, created_at FROM folders WHERE id = ?",
      [folder_id],
      @folder_fields
    )
  end

  def create_folder(vault_id, opts) do
    id = Ecto.UUID.generate()
    name = value(opts, :name) |> default_string("New Folder") |> sanitize_path_segment()
    parent_id = blank_nil(value(opts, :parent_id))

    [next_position] =
      Query.one(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE vault_id = ? AND parent_id IS ?",
        [vault_id, parent_id]
      )

    Query.execute(
      "INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)",
      [id, vault_id, parent_id, name, next_position]
    )

    if vault = raw_vault(vault_id), do: folder_path(vault, id) |> File.mkdir_p!()
    get_folder(id)
  end

  def update_folder(folder_id, opts) do
    folder = get_folder(folder_id) || raise(ArgumentError, "Folder not found")
    vault = raw_vault(folder.vault_id)
    old_path = folder_path(vault, folder_id)

    name =
      if has_key?(opts, :name) do
        opts
        |> value(:name)
        |> to_string()
        |> String.trim()
        |> default_string(folder.name)
        |> sanitize_path_segment()
      else
        folder.name
      end

    parent_id = if has_key?(opts, :parent_id), do: value(opts, :parent_id), else: folder.parent_id

    requested_position =
      case value(opts, :position) do
        position when is_integer(position) -> max(0, position)
        position when is_float(position) -> max(0, trunc(position))
        _ -> nil
      end

    position = requested_position || folder.position

    if parent_id do
      if parent_id == folder_id, do: raise(ArgumentError, "Cannot move a folder into itself")
      parent = get_folder(parent_id)

      if is_nil(parent) or parent.vault_id != folder.vault_id,
        do: raise(ArgumentError, "Parent folder not found")

      if descendant_folder?(folder_id, parent_id),
        do: raise(ArgumentError, "Cannot move a folder into its own subfolder")
    end

    Query.execute("UPDATE folders SET name = ?, parent_id = ?, position = ? WHERE id = ?", [
      name,
      parent_id,
      position,
      folder_id
    ])

    if parent_id != folder.parent_id or not is_nil(requested_position) do
      target_ids = sibling_folder_ids(folder.vault_id, parent_id, folder_id)

      insert_at =
        if is_nil(requested_position),
          do: length(target_ids),
          else: min(requested_position, length(target_ids))

      target_ids |> List.insert_at(insert_at, folder_id) |> resequence_folders()

      if folder.parent_id != parent_id,
        do: sibling_folder_ids(folder.vault_id, folder.parent_id, nil) |> resequence_folders()
    end

    new_path = folder_path(vault, folder_id)

    if old_path != new_path and File.exists?(old_path) do
      File.mkdir_p!(Path.dirname(new_path))
      File.rename!(old_path, new_path)
    end

    get_folder(folder_id)
  end

  def delete_folder(folder_id, actor_user_id \\ nil) do
    folder = get_folder(folder_id) || raise(ArgumentError, "Folder not found")

    moved_note_ids =
      Query.all("SELECT id FROM notes WHERE folder_id = ?", [folder_id]) |> List.flatten()

    Query.execute("UPDATE notes SET folder_id = ? WHERE folder_id = ?", [
      folder.parent_id,
      folder_id
    ])

    Enum.each(moved_note_ids, &notify_mutation(&1, actor_user_id, :move))

    Query.execute("UPDATE folders SET parent_id = ? WHERE parent_id = ?", [
      folder.parent_id,
      folder_id
    ])

    Query.execute("DELETE FROM folders WHERE id = ?", [folder_id])

    # Preserve Node's cleanup ordering: resolving after deletion points at the vault root.
    if vault = raw_vault(folder.vault_id) do
      folder_path = folder_path(vault, folder_id)

      with true <- File.dir?(folder_path),
           {:ok, []} <- File.ls(folder_path) do
        File.rmdir(folder_path)
      else
        _ -> :ok
      end
    end

    :ok
  end

  def list_notes(vault_id, opts \\ %{}) do
    {clauses, params} = note_filters(opts)

    rows =
      Query.maps(
        """
        SELECT n.id, n.vault_id, n.folder_id, n.title, n.content_preview,
               n.is_pinned, n.is_archived, n.is_listed, n.position, n.word_count,
               n.created_at, n.updated_at
        FROM notes n
        WHERE n.vault_id = ? #{Enum.join(clauses, "")}
        ORDER BY n.is_pinned DESC, n.updated_at DESC
        """,
        [vault_id | params],
        @note_summary_fields
      )

    tags = tags_by_note(Enum.map(rows, & &1.id))
    Enum.map(rows, &Map.put(&1, :tags, Map.get(tags, &1.id, [])))
  end

  def get_note(note_id) do
    row =
      Query.map(
        """
        SELECT id, vault_id, folder_id, title, content_preview,
               is_pinned, is_archived, is_listed, position, word_count, created_at, updated_at
        FROM notes WHERE id = ?
        """,
        [note_id],
        @note_summary_fields
      )

    with row when not is_nil(row) <- row,
         file_path when not is_nil(file_path) <- resolve_note_path(note_id) do
      content =
        case File.read(file_path) do
          {:ok, body} ->
            body

          _ ->
            case Query.one("SELECT content FROM notes WHERE id = ?", [note_id]) do
              [body] -> body || ""
              nil -> ""
            end
        end

      row
      |> Map.put(:tags, tags_for_note(note_id))
      |> Map.put(:content, content)
      |> Map.put(:file_path, file_path)
    else
      _ -> nil
    end
  end

  def create_note(vault_id, user_id, opts) do
    id = Ecto.UUID.generate()

    content =
      case value(opts, :content) do
        nil -> ""
        body -> to_string(body)
      end
      |> normalize_backticks()

    folder_id = blank_nil(value(opts, :folder_id))
    is_listed = if value(opts, :is_listed) == false, do: 0, else: 1
    requested_title = value(opts, :title) |> default_string("Untitled")
    title = unique_note_title(vault_id, folder_id, is_listed, requested_title)

    next_position =
      if is_listed == 1 do
        Query.one(
          "SELECT COALESCE(MAX(position), -1) + 1 FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1",
          [vault_id, folder_id]
        )
        |> hd()
      else
        0
      end

    vault = raw_vault(vault_id) || raise(ArgumentError, "Vault not found")
    file_path = note_path_for(vault, folder_id, title, is_listed)
    File.mkdir_p!(Path.dirname(file_path))
    File.write!(file_path, content)

    Query.execute(
      """
      INSERT INTO notes
        (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, is_listed, position, word_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      """,
      [
        id,
        vault_id,
        folder_id,
        title,
        preview(content),
        is_listed,
        next_position,
        word_count(content),
        user_id
      ]
      |> List.insert_at(4, content)
    )

    reindex_links(id, vault_id, content)
    notify_mutation(id, user_id, :create)
    maybe_invalidate_presence_channels(nil, content)
    get_note(id)
  end

  def update_note(note_id, content, actor_user_id \\ nil) do
    existing =
      Query.map(
        "SELECT id, vault_id, folder_id, title, content FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :content]
      )

    existing = existing || raise(ArgumentError, "Note not found")
    normalized = normalize_backticks(content)

    if normalized == existing.content do
      get_note(note_id)
    else
      if file_path = resolve_note_path(note_id) do
        File.mkdir_p!(Path.dirname(file_path))
        File.write!(file_path, normalized)
      end

      Query.execute(
        "UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?",
        [normalized, preview(normalized), word_count(normalized), note_id]
      )

      reindex_links(note_id, existing.vault_id, normalized)
      notify_mutation(note_id, actor_user_id, :content)
      maybe_invalidate_presence_channels(existing.content, normalized)
      get_note(note_id)
    end
  end

  def rename_note(note_id, new_title_raw, actor_user_id \\ nil) do
    existing =
      Query.map("SELECT id, vault_id, title FROM notes WHERE id = ?", [note_id], [
        :id,
        :vault_id,
        :title
      ])

    existing = existing || raise(ArgumentError, "Note not found")
    new_title = new_title_raw |> to_string() |> String.trim()
    if new_title == "", do: raise(ArgumentError, "Title cannot be empty")

    if new_title == existing.title do
      get_note(note_id)
    else
      if Query.one(
           "SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE AND id != ?",
           [existing.vault_id, new_title, note_id]
         ) do
        raise ArgumentError, "A note with that title already exists"
      end

      old_path = resolve_note_path(note_id)

      Query.execute("UPDATE notes SET title = ?, updated_at = datetime('now') WHERE id = ?", [
        new_title,
        note_id
      ])

      new_path = resolve_note_path(note_id)

      if old_path && new_path && old_path != new_path do
        try do
          File.mkdir_p!(Path.dirname(new_path))
          if File.exists?(old_path), do: File.rename!(old_path, new_path)
        rescue
          _ -> :ok
        end
      end

      update_wikilink_targets(existing.vault_id, existing.title, new_title, actor_user_id)
      notify_mutation(note_id, actor_user_id, :rename)
      get_note(note_id)
    end
  end

  def delete_note(note_id) do
    # These tables exist in the full Node schema. Their eager cleanup preserves
    # the current FTS/shared-channel deletion ordering.
    Query.execute("DELETE FROM chat_agent_members WHERE channel_id = ?", [note_id])
    Query.execute("DELETE FROM chat_messages WHERE channel_id = ?", [note_id])

    Query.execute(
      "DELETE FROM chat_channel_links WHERE local_channel_id = ? OR source_channel_id = ?",
      [note_id, note_id]
    )

    if file_path = resolve_note_path(note_id) do
      try do
        if File.exists?(file_path), do: File.rm!(file_path)
      rescue
        _ -> :ok
      end
    end

    Query.execute("DELETE FROM notes WHERE id = ?", [note_id])
    Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    :ok
  end

  def move_note(note_id, folder_id, requested_position \\ nil, actor_user_id \\ nil) do
    note =
      Query.map(
        "SELECT id, vault_id, folder_id, title, is_listed, position FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :is_listed, :position]
      )

    note = note || raise(ArgumentError, "Note not found")

    if folder_id do
      folder = Query.map("SELECT vault_id FROM folders WHERE id = ?", [folder_id], [:vault_id])

      if is_nil(folder) or folder.vault_id != note.vault_id,
        do: raise(ArgumentError, "Folder not found")
    end

    old_path = resolve_note_path(note_id)

    target_ids =
      Query.all(
        """
        SELECT id FROM notes
        WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1 AND id != ?
        ORDER BY position ASC, updated_at DESC, id ASC
        """,
        [note.vault_id, folder_id, note_id]
      )
      |> List.flatten()

    position =
      cond do
        not is_number(requested_position) and note.is_listed == 1 and note.folder_id == folder_id ->
          min(note.position, length(target_ids))

        not is_number(requested_position) ->
          length(target_ids)

        true ->
          requested_position |> trunc() |> max(0) |> min(length(target_ids))
      end

    Query.execute(
      """
      UPDATE notes
      SET folder_id = ?, is_listed = 1, position = ?,
          updated_at = CASE WHEN folder_id IS NOT ? OR is_listed = 0 THEN datetime('now') ELSE updated_at END
      WHERE id = ?
      """,
      [folder_id, position, folder_id, note_id]
    )

    target_ids |> List.insert_at(position, note_id) |> resequence_notes()

    if note.is_listed == 1 and note.folder_id != folder_id do
      Query.all(
        """
        SELECT id FROM notes
        WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1
        ORDER BY position ASC, updated_at DESC, id ASC
        """,
        [note.vault_id, note.folder_id]
      )
      |> List.flatten()
      |> resequence_notes()
    end

    new_path = resolve_note_path(note_id)
    best_effort_move(old_path, new_path)
    notify_mutation(note_id, actor_user_id, :move)
    :ok
  end

  def unlist_note(note_id, actor_user_id \\ nil) do
    if is_nil(Query.one("SELECT id FROM notes WHERE id = ?", [note_id])),
      do: raise(ArgumentError, "Note not found")

    old_path = resolve_note_path(note_id)

    Query.execute(
      "UPDATE notes SET folder_id = NULL, is_listed = 0, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    best_effort_move(old_path, resolve_note_path(note_id))
    notify_mutation(note_id, actor_user_id, :unlist)
    :ok
  end

  def toggle_pin(note_id, actor_user_id \\ nil) do
    Query.execute(
      "UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    notify_mutation(note_id, actor_user_id, :pin)
    :ok
  end

  def toggle_archive(note_id, actor_user_id \\ nil) do
    Query.execute(
      "UPDATE notes SET is_archived = CASE WHEN is_archived = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    notify_mutation(note_id, actor_user_id, :archive)
    :ok
  end

  def get_backlinks(note_id) do
    case Query.one("SELECT id, title FROM notes WHERE id = ?", [note_id]) do
      nil ->
        []

      [_id, title] ->
        Query.maps(
          """
          SELECT DISTINCT n.id, n.title, nl.context
          FROM note_links nl
          JOIN notes n ON n.id = nl.source_id
          WHERE nl.target_id = ? OR nl.target_title = ? COLLATE NOCASE
          """,
          [note_id, title],
          [:id, :title, :context]
        )
    end
  end

  def list_chat_backlinks(note_id, opts \\ %{}) do
    note =
      Query.map("SELECT id, title, vault_id FROM notes WHERE id = ?", [note_id], [
        :id,
        :title,
        :vault_id
      ])

    if is_nil(note) do
      []
    else
      reresolve_chat_backlinks(note.vault_id, note.id, note.title)
      limit = opts |> value(:limit) |> numeric_default(50) |> max(1) |> min(200)
      offset = opts |> value(:offset) |> numeric_default(0) |> max(0)
      deleted_clause = if value(opts, :include_deleted), do: "", else: "AND deleted = 0"

      Query.maps(
        """
        SELECT id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted
        FROM chat_note_backlinks
        WHERE (note_id = ? OR (note_id IS NULL AND target_title = ? COLLATE NOCASE AND vault_id = ?))
          #{deleted_clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        [note_id, note.title, note.vault_id, limit, offset],
        [
          :id,
          :vault_id,
          :note_id,
          :target_title,
          :message_id,
          :channel_id,
          :author,
          :snippet,
          :created_at,
          :deleted
        ]
      )
      |> Enum.map(fn row ->
        %{
          id: row.id,
          vaultId: row.vault_id,
          noteId: row.note_id,
          targetTitle: row.target_title,
          messageId: row.message_id,
          channelId: row.channel_id,
          author: row.author,
          snippet: row.snippet,
          createdAt: row.created_at,
          deleted: row.deleted != 0
        }
      end)
    end
  end

  def reresolve_chat_backlinks(vault_id, note_id, title) do
    try do
      Query.execute(
        """
        UPDATE chat_note_backlinks SET note_id = ?
        WHERE vault_id = ? AND note_id IS NULL AND target_title = ? COLLATE NOCASE AND deleted = 0
        """,
        [note_id, vault_id, title]
      ).num_rows
    rescue
      _ -> 0
    end
  end

  def list_tags(vault_id) do
    Query.maps(
      """
      SELECT t.id, t.name, t.color, COUNT(nt.note_id) AS count
      FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id
      WHERE t.vault_id = ? GROUP BY t.id ORDER BY t.name ASC
      """,
      [vault_id],
      [:id, :name, :color, :count]
    )
  end

  def add_tag(note_id, vault_id, name, color \\ nil, actor_user_id \\ nil) do
    tag_name = name |> to_string() |> String.trim() |> String.downcase()
    if tag_name == "", do: raise(ArgumentError, "Tag name is required")

    tag_id =
      case Query.one("SELECT id FROM tags WHERE vault_id = ? AND name = ?", [vault_id, tag_name]) do
        [id] ->
          if color, do: Query.execute("UPDATE tags SET color = ? WHERE id = ?", [color, id])
          id

        nil ->
          id = Ecto.UUID.generate()

          Query.execute("INSERT INTO tags (id, vault_id, name, color) VALUES (?, ?, ?, ?)", [
            id,
            vault_id,
            tag_name,
            color
          ])

          id
      end

    Query.execute("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)", [
      note_id,
      tag_id
    ])

    notify_mutation(note_id, actor_user_id, :tag)
    :ok
  end

  def remove_tag(note_id, tag_id, actor_user_id \\ nil) do
    Query.execute("DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?", [note_id, tag_id])
    [[count]] = Query.all("SELECT COUNT(*) FROM note_tags WHERE tag_id = ?", [tag_id])
    if count == 0, do: Query.execute("DELETE FROM tags WHERE id = ?", [tag_id])
    notify_mutation(note_id, actor_user_id, :tag)
    :ok
  end

  def graph(vault_id) do
    notes =
      Query.maps(
        """
        SELECT id, title, word_count, is_archived,
          CASE WHEN trim(COALESCE(content_preview, content, '')) LIKE 'cascade://chat-channel%'
            THEN 'chat' ELSE 'note' END AS kind
        FROM notes
        WHERE vault_id = ?
        """,
        [vault_id],
        [:id, :title, :wordCount, :archived, :kind]
      )

    resolved =
      Query.maps(
        """
        SELECT nl.source_id, nl.target_id
        FROM note_links nl
        JOIN notes n ON n.id = nl.source_id
        WHERE n.vault_id = ? AND nl.target_id IS NOT NULL
        """,
        [vault_id],
        [:source, :target]
      )
      |> Enum.map(&Map.put(&1, :kind, "wikilink"))

    unresolved =
      Query.maps(
        """
        SELECT nl.source_id, nl.target_title
        FROM note_links nl
        JOIN notes n ON n.id = nl.source_id
        WHERE n.vault_id = ? AND nl.target_id IS NULL AND trim(nl.target_title) != ''
        """,
        [vault_id],
        [:source, :title]
      )

    {chat_edges, chat_missing} = chat_graph_links(vault_id)
    missing = missing_nodes(unresolved ++ chat_missing)

    unresolved_edges =
      Enum.map(unresolved, fn row ->
        %{source: row.source, target: missing_id(row.title), kind: "wikilink"}
      end)

    %{
      nodes: notes ++ missing,
      edges: resolved ++ unresolved_edges ++ chat_edges
    }
  end

  defp chat_graph_links(vault_id) do
    rows =
      try do
        Query.maps(
          """
          SELECT channel_id, note_id, target_title
          FROM chat_note_backlinks
          WHERE vault_id = ? AND COALESCE(deleted, 0) = 0
          """,
          [vault_id],
          [:channelId, :noteId, :title]
        )
      rescue
        _ -> []
      end

    edges =
      rows
      |> Enum.filter(&(is_binary(&1.channelId) and &1.channelId != ""))
      |> Enum.map(fn row ->
        target =
          if is_binary(row.noteId) and row.noteId != "",
            do: row.noteId,
            else: missing_id(row.title)

        %{source: row.channelId, target: target, kind: "chat"}
      end)
      |> Enum.uniq()

    missing =
      rows
      |> Enum.filter(&(is_nil(&1.noteId) or &1.noteId == ""))
      |> Enum.map(&%{source: &1.channelId, title: &1.title})

    {edges, missing}
  end

  defp missing_id(title), do: "missing:" <> String.downcase(String.trim(to_string(title || "")))

  defp missing_nodes(rows) do
    rows
    |> Enum.map(& &1.title)
    |> Enum.reject(&(is_nil(&1) or String.trim(to_string(&1)) == ""))
    |> Enum.uniq_by(&String.downcase(String.trim(to_string(&1))))
    |> Enum.map(fn title ->
      %{id: missing_id(title), title: title, kind: "missing", wordCount: 0, archived: 0}
    end)
  end

  def search(vault_id, query, opts \\ %{}) do
    scope = value(opts, :scope) || "notes"
    limit = opts |> value(:limit) |> numeric_default(40) |> max(1) |> min(100)
    fts_query = search_terms(query)
    redact_private? = value(opts, :redact_private) == true

    if fts_query == "" do
      []
    else
      note_hits =
        if scope in ["notes", "all"],
          do: search_notes(vault_id, fts_query, query, limit, redact_private?),
          else: []

      chat_hits =
        if scope in ["chat", "all"],
          do: search_chat(vault_id, fts_query, query, limit, redact_private?),
          else: []

      (note_hits ++ chat_hits)
      |> Enum.sort_by(& &1.score, :desc)
      |> Enum.take(limit)
    end
  end

  def rescan_vault(vault_id, user_id) do
    vault = raw_vault(vault_id)

    if vault && not vault_root_taken?(vault.root_path, vault.id) do
      disk_files = scan_markdown(vault.root_path)

      Query.maps("SELECT id, title FROM notes WHERE vault_id = ?", [vault_id], [:id, :title])
      |> Enum.each(fn note ->
        file_path = resolve_note_path(note.id)

        if is_nil(file_path) or not File.exists?(file_path),
          do: Query.execute("DELETE FROM notes WHERE id = ?", [note.id])
      end)

      Enum.each(disk_files, &rescan_file(vault, &1, user_id))
    end

    Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    :ok
  end

  def resolve_note_path(note_id) do
    note =
      Query.map(
        "SELECT id, vault_id, folder_id, title, is_listed FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :is_listed]
      )

    with note when not is_nil(note) <- note,
         vault when not is_nil(vault) <- raw_vault(note.vault_id) do
      cond do
        note.is_listed == 0 ->
          resolve_under_vault(vault.root_path, [
            ".cascade-unlisted",
            sanitize_path_segment(note.title) <> ".md"
          ])

        note.folder_id ->
          resolve_under_vault(folder_path(vault, note.folder_id), [
            sanitize_path_segment(note.title) <> ".md"
          ])

        true ->
          resolve_under_vault(vault.root_path, [sanitize_path_segment(note.title) <> ".md"])
      end
    else
      _ -> nil
    end
  end

  def raw_vault(vault_id) do
    Query.map(
      "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ?",
      [vault_id],
      @vault_fields
    )
  end

  defp note_filters(opts) do
    {clauses, params} =
      if has_key?(opts, :folder_id) do
        case value(opts, :folder_id) do
          "" -> {[" AND n.folder_id IS NULL"], []}
          folder_id -> {[" AND n.folder_id = ?"], [folder_id]}
        end
      else
        {[], []}
      end

    {clauses, params} =
      if has_key?(opts, :is_archived) do
        {clauses ++ [" AND n.is_archived = ?"],
         params ++ [if(value(opts, :is_archived), do: 1, else: 0)]}
      else
        {clauses, params}
      end

    {clauses, params} =
      case value(opts, :tag) do
        tag when is_binary(tag) and tag != "" ->
          {clauses ++
             [
               " AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ? COLLATE NOCASE)"
             ], params ++ [tag]}

        _ ->
          {clauses, params}
      end

    {clauses, params} =
      if has_key?(opts, :title) do
        {clauses ++ [" AND n.title = ? COLLATE NOCASE"], params ++ [value(opts, :title)]}
      else
        {clauses, params}
      end

    case value(opts, :title_contains) do
      title when is_binary(title) and title != "" ->
        escaped = String.replace(title, ~r/[\\%_]/u, fn char -> "\\" <> char end)

        {clauses ++ [" AND n.title LIKE ? ESCAPE '\\' COLLATE NOCASE"],
         params ++ ["%#{escaped}%"]}

      _ ->
        {clauses, params}
    end
  end

  defp tags_by_note([]), do: %{}

  defp tags_by_note(note_ids) do
    placeholders = Enum.map_join(note_ids, ",", fn _ -> "?" end)

    try do
      Query.all(
        "SELECT nt.note_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id IN (#{placeholders}) ORDER BY t.name ASC",
        note_ids
      )
      |> Enum.reduce(%{}, fn [note_id, name], acc ->
        Map.update(acc, note_id, [name], &(&1 ++ [name]))
      end)
    rescue
      _ -> %{}
    end
  end

  defp tags_for_note(note_id) do
    Query.all(
      "SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ? ORDER BY t.name ASC",
      [note_id]
    )
    |> List.flatten()
  end

  defp raw_folder(folder_id) do
    Query.map("SELECT id, parent_id, name FROM folders WHERE id = ?", [folder_id], [
      :id,
      :parent_id,
      :name
    ])
  end

  defp folder_path(vault, folder_id) do
    parts = folder_parts(folder_id, [], MapSet.new())
    resolve_under_vault(vault.root_path, parts)
  end

  defp folder_parts(nil, parts, _seen), do: parts

  defp folder_parts(folder_id, parts, seen) do
    if MapSet.member?(seen, folder_id), do: raise(ArgumentError, "Invalid folder hierarchy")

    case raw_folder(folder_id) do
      nil ->
        parts

      folder ->
        folder_parts(
          folder.parent_id,
          [sanitize_path_segment(folder.name) | parts],
          MapSet.put(seen, folder_id)
        )
    end
  end

  defp descendant_folder?(folder_id, candidate_id) do
    case raw_folder(candidate_id) do
      nil -> false
      %{parent_id: nil} -> false
      %{parent_id: ^folder_id} -> true
      %{parent_id: parent_id} -> descendant_folder?(folder_id, parent_id)
    end
  end

  defp sibling_folder_ids(vault_id, parent_id, excluded_id) do
    sql =
      if excluded_id do
        "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND id != ? ORDER BY position ASC, name ASC, id ASC"
      else
        "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? ORDER BY position ASC, name ASC, id ASC"
      end

    params = if excluded_id, do: [vault_id, parent_id, excluded_id], else: [vault_id, parent_id]
    Query.all(sql, params) |> List.flatten()
  end

  defp resequence_folders(ids) do
    {:ok, _} =
      Query.transaction(fn ->
        Enum.with_index(ids, fn id, position ->
          Query.execute("UPDATE folders SET position = ? WHERE id = ?", [position, id])
        end)
      end)

    :ok
  end

  defp resequence_notes(ids) do
    {:ok, _} =
      Query.transaction(fn ->
        Enum.with_index(ids, fn id, position ->
          Query.execute("UPDATE notes SET position = ? WHERE id = ?", [position, id])
        end)
      end)

    :ok
  end

  defp note_path_for(vault, folder_id, title, is_listed) do
    cond do
      is_listed == 0 ->
        resolve_under_vault(vault.root_path, [
          ".cascade-unlisted",
          sanitize_path_segment(title) <> ".md"
        ])

      folder_id ->
        resolve_under_vault(folder_path(vault, folder_id), [sanitize_path_segment(title) <> ".md"])

      true ->
        resolve_under_vault(vault.root_path, [sanitize_path_segment(title) <> ".md"])
    end
  end

  defp unique_note_title(vault_id, folder_id, is_listed, desired) do
    desired = desired |> to_string() |> String.trim() |> default_string("Untitled")

    taken =
      Query.all(
        "SELECT title FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = ?",
        [vault_id, folder_id, is_listed]
      )
      |> List.flatten()
      |> Enum.map(&(sanitize_path_segment(&1) |> String.downcase()))
      |> MapSet.new()

    if not MapSet.member?(taken, sanitize_path_segment(desired) |> String.downcase()) do
      desired
    else
      Enum.find_value(2..999, fn number ->
        candidate = "#{desired} #{number}"

        if not MapSet.member?(taken, sanitize_path_segment(candidate) |> String.downcase()),
          do: candidate
      end) || "#{desired} #{String.slice(Ecto.UUID.generate(), 0, 8)}"
    end
  end

  defp reindex_links(note_id, vault_id, content) do
    Query.execute("DELETE FROM note_links WHERE source_id = ?", [note_id])

    Enum.each(extract_links(content), fn title ->
      target_id =
        case Query.one("SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE", [
               vault_id,
               title
             ]) do
          [id] -> id
          nil -> nil
        end

      marker = "[[#{title}]]"
      context = link_context(content, marker)

      Query.execute(
        "INSERT OR REPLACE INTO note_links (source_id, target_id, target_title, context) VALUES (?, ?, ?, ?)",
        [note_id, target_id, title, context]
      )
    end)
  end

  defp link_context(content, marker) do
    case :binary.match(content, marker) do
      :nomatch ->
        nil

      {index, length} ->
        start = max(0, index - 40)
        finish = min(byte_size(content), index + length + 40)

        content
        |> binary_part(start, finish - start)
        |> String.replace("\n", " ")
        |> String.trim()
    end
  end

  defp update_wikilink_targets(vault_id, old_title, new_title, actor_user_id) do
    regex = Regex.compile!("(\\[\\[)#{Regex.escape(old_title)}(?=[\\]|#])", "iu")

    Query.maps("SELECT id, content FROM notes WHERE vault_id = ?", [vault_id], [:id, :content])
    |> Enum.each(fn note ->
      if String.contains?(note.content, "[[") do
        updated = Regex.replace(regex, note.content, "\\1#{new_title}")
        if updated != note.content, do: update_note(note.id, updated, actor_user_id)
      end
    end)
  end

  defp preview(content) do
    stripped =
      content
      |> normalize_backticks()
      |> String.replace(~r/^[#]{1,6}\s+/mu, "")
      |> String.replace(~r/\*\*([^*]+)\*/u, "\\1")
      |> String.replace(~r/\*([^*]+)\*/u, "\\1")
      |> String.replace(~r/__([^_]+)__/u, "\\1")
      |> String.replace(~r/_([^_]+)_/u, "\\1")
      |> String.replace(~r/~~([^~]+)~~/u, "\\1")
      |> String.replace(~r/`([^`]+)`/u, "\\1")
      |> String.replace(~r/```[\s\S]*?```/u, "")
      |> String.replace(~r/\[([^\]]+)\]\([^)]+\)/u, "\\1")
      |> String.replace(~r/!\[([^\]]*)\]\([^)]+\)/u, "\\1")
      |> String.replace(~r/\[\[([^\]]+)\]\]/u, "\\1")
      |> String.replace(~r/[-*+]\s+/u, "")
      |> String.replace(~r/>\s+/u, "")
      |> String.replace(~r/\n{2,}/u, " ")
      |> String.replace("\n", " ")
      |> String.trim()

    String.slice(stripped, 0, 200)
  end

  defp word_count(content) do
    case String.trim(content) do
      "" -> 0
      trimmed -> trimmed |> String.split(~r/\s+/u, trim: true) |> length()
    end
  end

  defp normalize_backticks(content), do: content |> to_string() |> String.replace(~r/\\+`/u, "`")

  defp best_effort_move(old_path, new_path) do
    if old_path && new_path && old_path != new_path do
      try do
        if File.exists?(old_path) do
          File.mkdir_p!(Path.dirname(new_path))
          File.rename!(old_path, new_path)
        end
      rescue
        _ -> :ok
      end
    end
  end

  defp purge_vault_index(vault_id) do
    for {sql, params} <- [
          {"DELETE FROM note_links WHERE source_id IN (SELECT id FROM notes WHERE vault_id = ?) OR target_id IN (SELECT id FROM notes WHERE vault_id = ?)",
           [vault_id, vault_id]},
          {"DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE vault_id = ?)",
           [vault_id]}
        ] do
      try do
        Query.execute(sql, params)
      rescue
        _ -> :ok
      end
    end

    Query.execute("DELETE FROM notes WHERE vault_id = ?", [vault_id])
    Query.execute("DELETE FROM folders WHERE vault_id = ?", [vault_id])
  end

  defp unique_vault_root_path(user_id, vault_id, name) do
    Path.expand(
      Path.join([vaults_base_dir(), to_string(user_id), vault_id, sanitize_filename(name)])
    )
  end

  defp vault_root_taken?(root_path, except_vault_id \\ nil) do
    resolved = Path.expand(root_path)

    Query.maps("SELECT id, root_path FROM vaults", [], [:id, :root_path])
    |> Enum.any?(fn row ->
      row.id != except_vault_id and Path.expand(row.root_path || "") == resolved
    end)
  end

  defp scan_markdown(root) do
    case File.ls(root) do
      {:ok, entries} ->
        Enum.flat_map(entries, fn entry ->
          path = Path.join(root, entry)

          cond do
            File.dir?(path) and String.starts_with?(entry, ".") -> []
            File.dir?(path) -> scan_markdown(path)
            File.regular?(path) and String.ends_with?(entry, ".md") -> [path]
            true -> []
          end
        end)

      _ ->
        []
    end
  end

  defp rescan_file(vault, file_path, user_id) do
    relative = Path.relative_to(Path.expand(file_path), Path.expand(vault.root_path))
    parts = Path.split(relative)
    {folder_parts, [filename]} = Enum.split(parts, max(length(parts) - 1, 0))

    folder_id =
      Enum.reduce(folder_parts, nil, fn folder_name, parent_id ->
        case Query.one(
               "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND name = ?",
               [vault.id, parent_id, folder_name]
             ) do
          [id] ->
            id

          nil ->
            id = Ecto.UUID.generate()

            Query.execute(
              "INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, 0)",
              [id, vault.id, parent_id, folder_name]
            )

            id
        end
      end)

    title =
      if String.ends_with?(filename, ".md"),
        do: String.slice(filename, 0, String.length(filename) - 3),
        else: filename

    content = File.read!(file_path)

    existing =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND title = ? AND (folder_id IS ? OR folder_id = ?)",
        [vault.id, title, folder_id, folder_id],
        [:id, :content]
      )

    if existing do
      if existing.content != content do
        Query.execute(
          "UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?",
          [content, preview(content), word_count(content), existing.id]
        )

        reindex_links(existing.id, vault.id, content)
        notify_mutation(existing.id, user_id, :rescan)
      end
    else
      id = Ecto.UUID.generate()

      [position] =
        Query.one(
          "SELECT COALESCE(MAX(position), -1) + 1 FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1",
          [vault.id, folder_id]
        )

      Query.execute(
        """
        INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, position, word_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        """,
        [
          id,
          vault.id,
          folder_id,
          title,
          content,
          preview(content),
          position,
          word_count(content),
          user_id
        ]
      )

      reindex_links(id, vault.id, content)
      notify_mutation(id, user_id, :rescan)
    end
  end

  defp search_terms(query) do
    ~r/[a-z0-9_@#\.\/:-]{2,}/u
    |> Regex.scan(query |> to_string() |> String.downcase())
    |> List.flatten()
    |> Enum.uniq()
    |> Enum.map_join(" OR ", &"\"#{String.replace(&1, "\"", "\"\"")}\"")
  end

  defp search_notes(vault_id, fts_query, query, limit, redact_private?) do
    Query.maps(
      """
      SELECT n.id, n.title, n.content, -bm25(notes_fts)
      FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ? AND n.vault_id = ? AND n.is_archived = 0
      ORDER BY bm25(notes_fts) LIMIT ?
      """,
      [fts_query, vault_id, limit],
      [:id, :title, :body, :score]
    )
    |> Enum.map(fn hit ->
      body =
        if redact_private?, do: Cascade.Content.Privacy.redact_blocks(hit.body), else: hit.body

      hit
      |> Map.drop([:body])
      |> Map.put(:snippet, search_snippet(body, query))
      |> Map.put(:type, "note")
    end)
  end

  defp search_chat(vault_id, fts_query, query, limit, redact_private?) do
    try do
      Query.maps(
        """
        SELECT m.id, m.author, m.channel_id, m.body, -bm25(chat_messages_fts), m.created_at
        FROM chat_messages_fts JOIN chat_messages m ON m.rowid = chat_messages_fts.rowid
        WHERE chat_messages_fts MATCH ? AND m.vault_id = ? AND m.body != '' AND m.status IS NULL
          AND m.id NOT LIKE 'sys-next-%'
        ORDER BY bm25(chat_messages_fts) LIMIT ?
        """,
        [fts_query, vault_id, limit],
        [:id, :title, :channelId, :body, :score, :timestamp]
      )
      |> Enum.map(fn hit ->
        body =
          if redact_private?, do: Cascade.Content.Privacy.redact_blocks(hit.body), else: hit.body

        hit
        |> Map.drop([:body])
        |> Map.put(:snippet, search_snippet(body, query))
        |> Map.put(:type, "chat")
      end)
    rescue
      _ -> []
    end
  end

  defp search_snippet(text, query) do
    clean = text |> String.replace(~r/\s+/u, " ") |> String.trim()

    terms =
      ~r/[a-z0-9_@#\.\/:-]{2,}/u
      |> Regex.scan(query |> to_string() |> String.downcase())
      |> List.flatten()

    lower = String.downcase(clean)

    at =
      terms
      |> Enum.map(fn term ->
        case :binary.match(lower, term) do
          :nomatch -> -1
          {index, _length} -> index
        end
      end)
      |> Enum.reject(&(&1 < 0))
      |> Enum.min(fn -> -1 end)

    start = max(0, if(at < 0, do: 0, else: at) - 70)
    requested_length = min(240, byte_size(clean) - start)
    value = safe_binary_slice(clean, start, requested_length)
    prefix = if start > 0, do: "…", else: ""
    suffix = if start + requested_length < byte_size(clean), do: "…", else: ""
    prefix <> value <> suffix
  end

  defp safe_binary_slice(value, start, length) do
    start = advance_to_utf8_boundary(value, min(start, byte_size(value)))
    finish = retreat_to_utf8_boundary(value, min(start + length, byte_size(value)))
    binary_part(value, start, max(0, finish - start))
  end

  defp advance_to_utf8_boundary(value, index) when index >= byte_size(value), do: byte_size(value)

  defp advance_to_utf8_boundary(value, index) do
    if (:binary.at(value, index) &&& 0xC0) == 0x80,
      do: advance_to_utf8_boundary(value, index + 1),
      else: index
  end

  defp retreat_to_utf8_boundary(_value, 0), do: 0
  defp retreat_to_utf8_boundary(value, index) when index >= byte_size(value), do: byte_size(value)

  defp retreat_to_utf8_boundary(value, index) do
    if (:binary.at(value, index) &&& 0xC0) == 0x80,
      do: retreat_to_utf8_boundary(value, index - 1),
      else: index
  end

  def notify_note_mutation(note_id, actor_user_id, kind) do
    notify_mutation(note_id, actor_user_id, kind)
  end

  defp notify_mutation(note_id, actor_user_id, kind) do
    case Application.get_env(:cascade_elixir, :note_mutation_sink) do
      function when is_function(function, 3) and is_integer(actor_user_id) ->
        function.(note_id, actor_user_id, kind)

      _ ->
        :ok
    end
  end

  defp maybe_invalidate_presence_channels(before, after_content) do
    if chat_channel_content?(before) != chat_channel_content?(after_content) do
      Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    end

    :ok
  end

  defp chat_channel_content?(content),
    do: String.starts_with?(String.trim(to_string(content || "")), @chat_channel_marker)

  defp numeric_default(value, _default) when is_integer(value), do: value
  defp numeric_default(value, _default) when is_float(value), do: trunc(value)

  defp numeric_default(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {number, _} -> number
      :error -> default
    end
  end

  defp numeric_default(_, default), do: default

  defp default_string(nil, fallback), do: fallback
  defp default_string("", fallback), do: fallback

  defp default_string(value, _fallback),
    do: value |> to_string() |> String.trim() |> then(&if(&1 == "", do: "", else: &1))

  defp blank_nil(nil), do: nil
  defp blank_nil(""), do: nil
  defp blank_nil(value), do: value

  defp has_key?(map, key) when is_map(map),
    do: Map.has_key?(map, key) or Map.has_key?(map, Atom.to_string(key))

  defp has_key?(_, _), do: false
  defp value(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp value(_, _), do: nil
end
