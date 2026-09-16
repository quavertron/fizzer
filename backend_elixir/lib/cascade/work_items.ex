defmodule Cascade.WorkItems do
  @moduledoc "Durable work contracts, leases, workspace evidence, dependencies, and reviews."

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Runs.Store

  @statuses ~w(open leased in_progress review blocked done canceled)
  @modes ~w(shared isolated existing)
  @source_kinds ~w(message note kanban manual mission contract)
  @stop_reasons ~w(completed token_budget manual failed)
  @lease_default 30 * 60 * 1_000

  @select """
  id,vault_id,channel_id,title,brief,status,priority,source_kind,source_id,
  assignee_registration_id,lease_holder,lease_expires_at,repository,base_commit,branch,
  workspace_mode,worktree_path,pr_number,pr_url,pr_state,summary,verification,
  git_state_json,git_state_updated_at,contract,token_budget,tokens_used,stop_reason,
  created_by,created_at,updated_at
  """

  def list(user_id, vault_id, opts \\ []) do
    with :ok <- access(vault_id, user_id, false) do
      {where, params} = list_filters(vault_id, opts)

      items =
        SQL.all(
          "SELECT #{@select} FROM work_items #{where} ORDER BY priority DESC,updated_at DESC,rowid DESC",
          params
        )
        |> hydrate()

      {:ok, items}
    end
  end

  def get(user_id, id, write? \\ false) do
    case row(id) do
      nil ->
        {:error, "Work item not found"}

      row ->
        with :ok <- access(Enum.at(row, 1), user_id, write?) do
          {:ok, hd(hydrate([row]))}
        end
    end
  end

  def create(user_id, vault_id, input) when is_map(input) do
    with :ok <- access(vault_id, user_id, true),
         title when title != "" <- clean(field(input, :title), 240),
         dependencies <- clean_ids(field(input, :dependsOn)),
         :ok <- validate_dependencies(vault_id, dependencies, nil) do
      id = Ecto.UUID.generate()
      priority = clamp(integer(field(input, :priority)), -100, 100)
      source_kind = enum(field(input, :sourceKind), @source_kinds, "manual")
      mode = enum(field(input, :workspaceMode), @modes, "shared")

      SQL.transaction(fn ->
        SQL.exec(
          """
          INSERT INTO work_items (
            id,vault_id,channel_id,title,brief,contract,priority,source_kind,source_id,
            assignee_registration_id,repository,base_commit,branch,workspace_mode,
            worktree_path,verification,token_budget,created_by
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          """,
          [
            id,
            vault_id,
            nil_if_blank(field(input, :channelId)),
            title,
            clean(field(input, :brief), 8_000),
            clean(field(input, :contract), 16_000),
            priority,
            source_kind,
            clean(field(input, :sourceId), 120),
            nil_if_blank(field(input, :assigneeRegistrationId)),
            clean(field(input, :repository), 500),
            clean(field(input, :baseCommit), 80),
            clean(field(input, :branch), 200),
            mode,
            clean(field(input, :worktreePath), 1_000),
            clean(field(input, :verification), 8_000),
            max(0, integer(field(input, :tokenBudget))),
            user_id
          ]
        )

        replace_dependencies(id, dependencies)
      end)

      get(user_id, id)
    else
      "" -> {:error, "Title is required"}
      {:error, _} = error -> error
    end
  end

  def update(user_id, id, patch) when is_map(patch) do
    with {:ok, current} <- get(user_id, id, true),
         {:ok, values} <- update_values(current, patch),
         dependencies <- optional_dependencies(patch),
         :ok <- validate_optional_dependencies(current.vaultId, dependencies, id) do
      SQL.transaction(fn ->
        SQL.exec(
          """
          UPDATE work_items SET title=?,brief=?,contract=?,status=?,priority=?,
            assignee_registration_id=?,repository=?,base_commit=?,branch=?,workspace_mode=?,
            worktree_path=?,pr_number=?,pr_url=?,pr_state=?,summary=?,verification=?,
            token_budget=?,tokens_used=?,stop_reason=?,updated_at=datetime('now') WHERE id=?
          """,
          values ++ [id]
        )

        if is_list(dependencies), do: replace_dependencies(id, dependencies)
      end)

      get(user_id, id)
    end
  end

  def report_git_state(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         base when base != "" <- clean(field(input, :baseCommit), 80),
         branch when branch != "" <- clean(field(input, :branch), 200),
         {:ok, state} <- clean_git_state(field(input, :state)),
         :ok <-
           same_or_blank(
             item.baseCommit,
             base,
             "Reported base commit does not match this work item"
           ),
         :ok <-
           same_or_blank(item.branch, branch, "Reported branch does not match this work item"),
         true <- state.branch == branch do
      SQL.exec(
        """
        UPDATE work_items SET
          base_commit=CASE WHEN base_commit='' THEN ? ELSE base_commit END,
          branch=CASE WHEN branch='' THEN ? ELSE branch END,
          git_state_json=?,git_state_updated_at=datetime('now'),updated_at=datetime('now')
        WHERE id=?
        """,
        [base, branch, Jason.encode!(state), id]
      )

      get(user_id, id)
    else
      "" -> {:error, "A complete Git state, base commit, and branch are required"}
      false -> {:error, "Reported Git branch does not match the workspace branch"}
      {:error, _} = error -> error
    end
  end

  def bind_workspace(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         true <- item.workspaceMode in ["isolated", "existing"],
         values <- %{
           repository: clean(field(input, :repository), 500),
           baseCommit: clean(field(input, :baseCommit), 80),
           branch: clean(field(input, :branch), 200),
           worktreePath: clean(field(input, :worktreePath), 1_000)
         },
         true <- Enum.all?(values, fn {_key, value} -> value != "" end),
         :ok <-
           same_or_blank(
             item.repository,
             values.repository,
             "Prepared repository does not match this work item"
           ),
         :ok <-
           same_or_blank(
             item.baseCommit,
             values.baseCommit,
             "Prepared base commit does not match this work item",
             rebindable_base?(item)
           ),
         :ok <-
           same_or_blank(
             item.branch,
             values.branch,
             "Prepared branch does not match this work item"
           ),
         :ok <-
           same_or_blank(
             item.worktreePath,
             values.worktreePath,
             "Prepared path does not match this work item"
           ) do
      base_commit =
        if item.baseCommit in [nil, ""] or rebindable_base?(item),
          do: values.baseCommit,
          else: item.baseCommit

      SQL.exec(
        """
        UPDATE work_items SET
          repository=CASE WHEN repository='' THEN ? ELSE repository END,
          base_commit=?,
          branch=CASE WHEN branch='' THEN ? ELSE branch END,
          worktree_path=CASE WHEN worktree_path='' THEN ? ELSE worktree_path END,
          updated_at=datetime('now') WHERE id=?
        """,
        [values.repository, base_commit, values.branch, values.worktreePath, id]
      )

      get(user_id, id)
    else
      false -> {:error, "Work item does not permit a managed workspace"}
      {:error, _} = error -> error
    end
  end

  def acquire_lease(user_id, id, holder, ttl_ms \\ @lease_default) do
    with {:ok, item} <- get(user_id, id, true),
         who when who != "" <- clean(holder, 120),
         false <- item.status in ["done", "canceled"],
         :ok <- lease_available(item, who) do
      expiry =
        DateTime.utc_now()
        |> DateTime.add(max(60_000, integer(ttl_ms)), :millisecond)
        |> DateTime.to_iso8601()

      status = if item.status in ["open", "leased"], do: "in_progress", else: item.status

      SQL.exec(
        "UPDATE work_items SET lease_holder=?,lease_expires_at=?,status=?,updated_at=datetime('now') WHERE id=?",
        [who, expiry, status, id]
      )

      get(user_id, id)
    else
      "" -> {:error, "Lease holder is required"}
      true -> {:error, "Work item is closed"}
      {:error, _} = error -> error
    end
  end

  def release_lease(user_id, id, holder \\ nil) do
    with {:ok, item} <- get(user_id, id, true),
         :ok <- holder_can_release(item, holder) do
      status = if item.status in ["in_progress", "leased"], do: "open", else: item.status

      SQL.exec(
        "UPDATE work_items SET lease_holder=NULL,lease_expires_at=NULL,status=?,updated_at=datetime('now') WHERE id=?",
        [status, id]
      )

      get(user_id, id)
    end
  end

  def reap_expired_leases(now \\ DateTime.utc_now() |> DateTime.to_iso8601()) do
    SQL.changes(
      """
      UPDATE work_items SET lease_holder=NULL,lease_expires_at=NULL,
        status=CASE WHEN status IN ('leased','in_progress') THEN 'open' ELSE status END,
        updated_at=datetime('now')
      WHERE lease_expires_at IS NOT NULL AND lease_expires_at<?
        AND status NOT IN ('done','canceled')
      """,
      [now]
    )
  end

  def link_run(user_id, id, run_id) do
    with {:ok, item} <- get(user_id, id, true),
         true <- is_integer(run_id) and run_id > 0,
         false <- item.status in ["done", "canceled"] or item.stopReason != "" do
      SQL.exec("INSERT OR IGNORE INTO work_item_runs (work_item_id,run_id) VALUES (?,?)", [
        id,
        run_id
      ])

      status = if item.status in ["open", "leased"], do: "in_progress", else: item.status

      SQL.exec("UPDATE work_items SET status=?,updated_at=datetime('now') WHERE id=?", [
        status,
        id
      ])

      get(user_id, id)
    else
      false -> {:error, "Invalid run id"}
      true -> {:error, "Work item is stopped"}
      {:error, _} = error -> error
    end
  end

  def stop(user_id, id, reason, summary \\ "") do
    with {:ok, item} <- get(user_id, id, true),
         true <- reason in @stop_reasons do
      if item.status in ["done", "canceled"] and item.stopReason != "" do
        {:ok, item}
      else
        status = if reason == "completed", do: "done", else: "canceled"
        summary = clean(summary, 4_000)

        SQL.exec(
          """
          UPDATE work_items SET status=?,stop_reason=?,
            summary=CASE WHEN ?!='' THEN ? ELSE summary END,
            lease_holder=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?
          """,
          [status, reason, summary, summary, id]
        )

        get(user_id, id)
      end
    else
      false -> {:error, "Stop reason is required"}
      {:error, _} = error -> error
    end
  end

  def add_token_usage(user_id, id, tokens) do
    with {:ok, item} <- get(user_id, id, true) do
      delta = max(0, integer(tokens))

      if delta > 0 and item.status not in ["done", "canceled"] do
        SQL.exec(
          "UPDATE work_items SET tokens_used=COALESCE(tokens_used,0)+?,updated_at=datetime('now') WHERE id=?",
          [delta, id]
        )
      end

      {:ok, updated} = get(user_id, id)

      if updated.tokenBudget > 0 and updated.tokensUsed >= updated.tokenBudget and
           updated.status not in ["done", "canceled"] do
        {:ok, stopped} =
          stop(
            user_id,
            id,
            "token_budget",
            "Token budget #{updated.tokenBudget} reached (#{updated.tokensUsed} used)."
          )

        {:ok, %{item: stopped, budgetExceeded: true}}
      else
        {:ok, %{item: updated, budgetExceeded: false}}
      end
    end
  end

  def linked_to_run(run_id) when is_integer(run_id) and run_id > 0 do
    SQL.all("SELECT work_item_id FROM work_item_runs WHERE run_id=?", [run_id]) |> Enum.map(&hd/1)
  end

  def linked_to_run(_), do: []

  def handoff(user_id, id, input) do
    with {:ok, _item} <- get(user_id, id, true),
         target when target != "" <- clean(field(input, :toRegistrationId), 120) do
      review_id = Ecto.UUID.generate()

      SQL.transaction(fn ->
        SQL.exec(
          """
          INSERT INTO work_item_reviews
            (id,work_item_id,from_registration_id,to_registration_id,note,status)
          VALUES (?,?,?,?,?,'requested')
          """,
          [
            review_id,
            id,
            nil_if_blank(field(input, :fromRegistrationId)),
            target,
            clean(field(input, :note), 2_000)
          ]
        )

        SQL.exec(
          """
          UPDATE work_items SET status='review',assignee_registration_id=?,
            lease_holder=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?
          """,
          [target, id]
        )
      end)

      with {:ok, item} <- get(user_id, id),
           {:ok, reviews} <- reviews(user_id, id),
           review when not is_nil(review) <- Enum.find(reviews, &(&1.id == review_id)) do
        {:ok, %{item: item, review: review}}
      else
        _ -> {:error, "Review handoff was not persisted"}
      end
    else
      "" -> {:error, "Handoff target is required"}
      {:error, _} = error -> error
    end
  end

  def review(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         kind when kind in ["comment", "change_request"] <- clean(field(input, :kind), 40),
         note when note != "" <- clean(field(input, :note), 8_000),
         base <- clean(field(input, :baseCommit), 80),
         head <- clean(field(input, :headCommit), 80),
         true <- item.baseCommit != "" and item.baseCommit == base,
         true <- is_map(item.gitState) and item.gitState.headCommit == head do
      review_id = Ecto.UUID.generate()
      status = if kind == "change_request", do: "requested", else: "done"
      line = positive_or_nil(field(input, :line))

      SQL.exec(
        """
        INSERT INTO work_item_reviews
          (id,work_item_id,kind,author_user_id,note,file_path,line,base_commit,head_commit,status)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        [
          review_id,
          id,
          kind,
          user_id,
          note,
          clean(field(input, :filePath), 1_000),
          line,
          base,
          head,
          status
        ]
      )

      {:ok, all} = reviews(user_id, id)
      {:ok, Enum.find(all, &(&1.id == review_id))}
    else
      kind when is_binary(kind) and kind not in ["comment", "change_request"] ->
        {:error, "Invalid review kind"}

      "" ->
        {:error, "Review comment is required"}

      false ->
        review_evidence_error(item_or_nil(user_id, id), input)

      {:error, _} = error ->
        error
    end
  end

  def reviews(user_id, id) do
    with {:ok, _item} <- get(user_id, id) do
      rows =
        SQL.all(
          """
          SELECT r.id,r.work_item_id,r.kind,r.author_user_id,COALESCE(u.username,''),
            r.from_registration_id,r.to_registration_id,r.note,r.file_path,r.line,
            r.base_commit,r.head_commit,r.status,r.created_at
          FROM work_item_reviews r LEFT JOIN users u ON u.id=r.author_user_id
          WHERE r.work_item_id=? ORDER BY r.created_at ASC,r.id ASC
          """,
          [id]
        )

      {:ok, Enum.map(rows, &review_map/1)}
    end
  end

  def siblings(user_id, id) do
    with {:ok, item} <- get(user_id, id) do
      if item.repository == "" do
        {:ok, []}
      else
        {:ok, all} = list(user_id, item.vaultId)

        {:ok,
         Enum.filter(
           all,
           &(&1.id != id and &1.repository == item.repository and
               &1.status not in ["done", "canceled"])
         )}
      end
    end
  end

  def account_terminal_run(run_id) do
    summary =
      case Store.get(run_id) do
        nil -> ""
        run -> run.summary || ""
      end

    estimate = max(800, div(String.length(summary) + 3, 4) + 400)

    Enum.each(linked_to_run(run_id), fn id ->
      case row(id) do
        nil ->
          :ok

        row ->
          user_id = Enum.at(row, 28)

          case add_token_usage(user_id, id, estimate) do
            {:ok, %{item: item, budgetExceeded: true}} ->
              Enum.each(item.runIds, fn linked_run ->
                if linked_run != run_id do
                  case Store.get(linked_run) do
                    %{status: status} when status in ["queued", "running"] ->
                      Store.cancel(linked_run)

                    _ ->
                      :ok
                  end
                end
              end)

            _ ->
              :ok
          end
      end
    end)
  end

  def readiness(input) do
    blockers = []

    blockers =
      if clean(field(input, :baseCommit), 80) == "",
        do: ["workspace base is not bound" | blockers],
        else: blockers

    blockers =
      if clean(field(input, :branch), 200) == "",
        do: ["workspace branch is not bound" | blockers],
        else: blockers

    git = field(input, :gitState)
    blockers = git_blockers(git, field(input, :branch), blockers)

    blockers =
      if clean(field(input, :verification), 8_000) == "",
        do: ["verification evidence is missing" | blockers],
        else: blockers

    blockers = Enum.reverse(blockers)
    %{ready: blockers == [], blockers: blockers}
  end

  defp hydrate([]), do: []

  defp hydrate(rows) do
    ids = Jason.encode!(Enum.map(rows, &hd/1))

    dependencies = related_ids("work_item_dependencies", "depends_on_id", ids, "")
    runs = related_ids("work_item_runs", "run_id", ids, "ORDER BY linked_at ASC")

    Enum.map(rows, &hydrate(&1, dependencies, runs))
  end

  defp related_ids(table, column, ids, order) do
    SQL.all(
      "SELECT work_item_id,#{column} FROM #{table} WHERE work_item_id IN (SELECT value FROM json_each(?)) #{order}",
      [ids]
    )
    |> Enum.group_by(&hd/1, &List.last/1)
  end

  defp hydrate(row, dependencies, runs) do
    [
      id,
      vault_id,
      channel_id,
      title,
      brief,
      status,
      priority,
      source_kind,
      source_id,
      assignee,
      lease_holder,
      lease_expires,
      repository,
      base_commit,
      branch,
      workspace_mode,
      worktree_path,
      pr_number,
      pr_url,
      pr_state,
      summary,
      verification,
      git_json,
      git_updated,
      contract,
      token_budget,
      tokens_used,
      stop_reason,
      created_by,
      created_at,
      updated_at
    ] = row

    git_state = parse_git_state(git_json)

    %{
      id: id,
      vaultId: vault_id,
      channelId: channel_id,
      title: title,
      brief: brief || "",
      contract: contract || "",
      status: enum(status, @statuses, "open"),
      priority: priority || 0,
      sourceKind: enum(source_kind, @source_kinds, ""),
      sourceId: source_id || "",
      assigneeRegistrationId: assignee,
      leaseHolder: lease_holder,
      leaseExpiresAt: lease_expires,
      repository: repository || "",
      baseCommit: base_commit || "",
      branch: branch || "",
      workspaceMode: enum(workspace_mode, @modes, "shared"),
      worktreePath: worktree_path || "",
      prNumber: pr_number,
      prUrl: pr_url || "",
      prState: pr_state || "",
      summary: summary || "",
      verification: verification || "",
      gitState: git_state,
      gitStateUpdatedAt: git_updated,
      reviewReadiness:
        readiness(%{
          baseCommit: base_commit,
          branch: branch,
          verification: verification,
          gitState: git_state
        }),
      tokenBudget: max(0, integer(token_budget)),
      tokensUsed: max(0, integer(tokens_used)),
      stopReason: enum(stop_reason, @stop_reasons, ""),
      dependsOn: Map.get(dependencies, id, []),
      runIds: Map.get(runs, id, []),
      createdBy: created_by,
      createdAt: created_at,
      updatedAt: updated_at
    }
  end

  defp update_values(current, patch) do
    title = if present?(patch, :title), do: clean(field(patch, :title), 240), else: current.title
    status = if present?(patch, :status), do: field(patch, :status), else: current.status

    mode =
      if present?(patch, :workspaceMode),
        do: field(patch, :workspaceMode),
        else: current.workspaceMode

    cond do
      title == "" ->
        {:error, "Title is required"}

      status not in @statuses ->
        {:error, "Invalid status"}

      mode not in @modes ->
        {:error, "Invalid workspace mode"}

      true ->
        {:ok,
         [
           title,
           patch_text(patch, :brief, current.brief, 8_000),
           patch_text(patch, :contract, current.contract, 16_000),
           status,
           patch_integer(patch, :priority, current.priority, -100, 100),
           patch_nullable(patch, :assigneeRegistrationId, current.assigneeRegistrationId),
           patch_text(patch, :repository, current.repository, 500),
           patch_text(patch, :baseCommit, current.baseCommit, 80),
           patch_text(patch, :branch, current.branch, 200),
           mode,
           patch_text(patch, :worktreePath, current.worktreePath, 1_000),
           patch_nullable_integer(patch, :prNumber, current.prNumber),
           patch_text(patch, :prUrl, current.prUrl, 500),
           patch_text(patch, :prState, current.prState, 80),
           patch_text(patch, :summary, current.summary, 4_000),
           patch_text(patch, :verification, current.verification, 8_000),
           patch_integer(patch, :tokenBudget, current.tokenBudget, 0, 9_223_372_036_854_775_807),
           patch_integer(patch, :tokensUsed, current.tokensUsed, 0, 9_223_372_036_854_775_807),
           patch_text(patch, :stopReason, current.stopReason, 40)
         ]}
    end
  end

  defp access(vault_id, user_id, write?) do
    role = VaultMembers.role(vault_id, user_id)

    cond do
      is_nil(role) -> {:error, if(write?, do: "Vault not writable", else: "Vault not found")}
      write? and not VaultMembers.can_write?(role) -> {:error, "Vault not writable"}
      true -> :ok
    end
  end

  defp row(id), do: SQL.one("SELECT #{@select} FROM work_items WHERE id=?", [id])

  defp replace_dependencies(id, dependencies) do
    SQL.exec("DELETE FROM work_item_dependencies WHERE work_item_id=?", [id])

    Enum.each(
      dependencies,
      &SQL.exec("INSERT INTO work_item_dependencies (work_item_id,depends_on_id) VALUES (?,?)", [
        id,
        &1
      ])
    )
  end

  defp validate_dependencies(_vault_id, [], _id), do: :ok

  defp validate_dependencies(vault_id, dependencies, id) do
    cond do
      id in dependencies ->
        {:error, "A work item cannot depend on itself"}

      true ->
        placeholders = Enum.map_join(dependencies, ",", fn _ -> "?" end)

        found =
          SQL.one(
            "SELECT COUNT(*) FROM work_items WHERE vault_id=? AND id IN (#{placeholders})",
            [vault_id | dependencies]
          )
          |> hd()

        if found == length(dependencies),
          do: :ok,
          else: {:error, "Every dependency must be a work item in this vault"}
    end
  end

  defp validate_optional_dependencies(_vault_id, nil, _id), do: :ok

  defp validate_optional_dependencies(vault_id, deps, id),
    do: validate_dependencies(vault_id, deps, id)

  defp optional_dependencies(patch),
    do: if(present?(patch, :dependsOn), do: clean_ids(field(patch, :dependsOn)), else: nil)

  defp clean_ids(values),
    do:
      values |> List.wrap() |> Enum.map(&clean(&1, 80)) |> Enum.reject(&(&1 == "")) |> Enum.uniq()

  defp list_filters(vault_id, opts) do
    channel = Keyword.get(opts, :channel_id)
    status = Keyword.get(opts, :status)
    base = {"WHERE vault_id=?", [vault_id]}

    base =
      if is_binary(channel) and channel != "",
        do: {elem(base, 0) <> " AND channel_id=?", elem(base, 1) ++ [channel]},
        else: base

    if status in @statuses,
      do: {elem(base, 0) <> " AND status=?", elem(base, 1) ++ [status]},
      else: base
  end

  defp clean_git_state(value) when is_map(value) do
    head = clean(field(value, :headCommit), 80)
    base = clean(field(value, :baseBranch), 200)
    branch = clean(field(value, :branch), 200)

    if head == "" or base == "" or branch == "" do
      {:error, "A complete Git state, base commit, and branch are required"}
    else
      {:ok,
       %{
         headCommit: head,
         baseBranch: base,
         branch: branch,
         changedFiles: max(0, integer(field(value, :changedFiles))),
         dirty: field(value, :dirty) == true,
         ahead: max(0, integer(field(value, :ahead))),
         behind: max(0, integer(field(value, :behind))),
         unpushed: max(0, integer(field(value, :unpushed))),
         hasUpstream: field(value, :hasUpstream) == true
       }}
    end
  end

  defp clean_git_state(_),
    do: {:error, "A complete Git state, base commit, and branch are required"}

  defp parse_git_state(value) when is_binary(value) and value != "" do
    with {:ok, decoded} <- Jason.decode(value),
         {:ok, state} <- clean_git_state(decoded) do
      state
    else
      _ -> nil
    end
  end

  defp parse_git_state(_), do: nil

  defp git_blockers(nil, _branch, blockers),
    do: ["Git state has not been reported by a desktop workspace" | blockers]

  defp git_blockers(git, branch, blockers) do
    blockers =
      if field(git, :branch) != branch,
        do: ["reported branch does not match the bound workspace" | blockers],
        else: blockers

    blockers =
      if field(git, :dirty) == true,
        do: ["working tree has uncommitted changes" | blockers],
        else: blockers

    behind = integer(field(git, :behind))

    blockers =
      if behind > 0,
        do: [
          "workspace is #{behind} commit#{if behind == 1, do: "", else: "s"} behind its base"
          | blockers
        ],
        else: blockers

    if integer(field(git, :changedFiles)) == 0,
      do: ["no base-relative changes were found" | blockers],
      else: blockers
  end

  defp review_map([
         id,
         work_item_id,
         kind,
         author_id,
         username,
         from_id,
         to_id,
         note,
         path,
         line,
         base,
         head,
         status,
         created
       ]) do
    %{
      id: id,
      workItemId: work_item_id,
      kind: if(kind in ["comment", "change_request"], do: kind, else: "handoff"),
      authorUserId: author_id,
      authorUsername: username,
      fromRegistrationId: from_id,
      toRegistrationId: to_id,
      note: note,
      filePath: path || "",
      line: line,
      baseCommit: base || "",
      headCommit: head || "",
      status: status,
      createdAt: created
    }
  end

  defp lease_available(item, who) do
    if item.leaseHolder && not lease_expired?(item.leaseExpiresAt) && item.leaseHolder != who,
      do: {:error, "Work item is leased by #{item.leaseHolder} until #{item.leaseExpiresAt}"},
      else: :ok
  end

  defp lease_expired?(nil), do: true

  defp lease_expired?(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} -> DateTime.compare(dt, DateTime.utc_now()) != :gt
      _ -> true
    end
  end

  defp holder_can_release(item, holder)
       when is_binary(holder) and holder != "" and is_binary(item.leaseHolder) and
              item.leaseHolder != holder,
       do: {:error, "Only the lease holder can release this lease"}

  defp holder_can_release(_item, _holder), do: :ok

  defp same_or_blank(existing, next, message, allow_rebind \\ false),
    do:
      if(existing in [nil, ""] or existing == next or allow_rebind,
        do: :ok,
        else: {:error, message}
      )

  defp rebindable_base?(item) do
    item.verification in [nil, ""] and item.status in ~w(open leased in_progress) and
      unused_git_state?(item.gitState)
  end

  defp unused_git_state?(nil), do: true

  defp unused_git_state?(state) when is_map(state) do
    field(state, :dirty) != true and integer(field(state, :ahead)) == 0 and
      integer(field(state, :changedFiles)) == 0
  end

  defp unused_git_state?(_), do: false

  defp review_evidence_error(item, input) do
    base = clean(field(input, :baseCommit), 80)

    if item && (item.baseCommit == "" or base != item.baseCommit),
      do: {:error, "Review base does not match this work item"},
      else: {:error, "Review head does not match the latest desktop Git evidence"}
  end

  defp item_or_nil(user_id, id) do
    case get(user_id, id) do
      {:ok, item} -> item
      _ -> nil
    end
  end

  defp present?(map, key), do: Map.has_key?(map, key) or Map.has_key?(map, Atom.to_string(key))
  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  defp patch_text(patch, key, old, max),
    do: if(present?(patch, key), do: clean(field(patch, key), max), else: old)

  defp patch_nullable(patch, key, old),
    do: if(present?(patch, key), do: nil_if_blank(field(patch, key)), else: old)

  defp patch_nullable_integer(patch, key, old),
    do: if(present?(patch, key), do: positive_or_nil(field(patch, key)), else: old)

  defp patch_integer(patch, key, old, min, max),
    do: if(present?(patch, key), do: clamp(integer(field(patch, key)), min, max), else: old)

  defp positive_or_nil(value), do: if(integer(value) > 0, do: integer(value), else: nil)
  defp integer(value) when is_integer(value), do: value
  defp integer(value) when is_float(value), do: floor(value)
  defp integer(_), do: 0
  defp clamp(value, min, max), do: value |> Kernel.max(min) |> Kernel.min(max)
  defp enum(value, allowed, fallback), do: if(value in allowed, do: value, else: fallback)
  defp clean(nil, _max), do: ""
  defp clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)

  defp nil_if_blank(value) do
    case clean(value, 10_000) do
      "" -> nil
      text -> text
    end
  end
end
