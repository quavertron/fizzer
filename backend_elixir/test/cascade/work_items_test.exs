defmodule Cascade.WorkItemsTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.WorkItems

  setup do
    Cascade.TestHelpers.owner_vault("work-items")
  end

  test "list batches relations and matches get hydration without changing order", context do
    assert {:ok, first} =
             WorkItems.create(context.user_id, context.vault_id, %{title: "First", priority: 10})

    assert {:ok, second} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Second",
               dependsOn: [first.id]
             })

    assert {:ok, third} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Third",
               priority: -10,
               dependsOn: [second.id, first.id]
             })

    for {id, run_id, date} <- [
          {second.id, 11, "2026-01-02"},
          {third.id, 33, "2026-01-01"},
          {second.id, 22, "2026-01-01"}
        ] do
      SQL.exec("INSERT INTO work_item_runs (work_item_id,run_id,linked_at) VALUES (?,?,?)", [
        id,
        run_id,
        date
      ])
    end

    expected =
      Enum.map([first, second, third], fn item ->
        assert {:ok, hydrated} = WorkItems.get(context.user_id, item.id)
        hydrated
      end)

    key = {__MODULE__, make_ref()}

    :ok =
      :telemetry.attach(
        key,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, {owner, key} ->
          if self() == owner and
               Regex.match?(~r/\bFROM work_item_(dependencies|runs)\b/, metadata.query),
             do: Process.put(key, Process.get(key, 0) + 1)
        end,
        {self(), key}
      )

    try do
      assert {:ok, ^expected} = WorkItems.list(context.user_id, context.vault_id)
      assert Process.get(key, 0) == 2
      assert Enum.map(expected, & &1.runIds) == [[], [22, 11], [33]]

      assert Enum.map(expected, &Enum.sort(&1.dependsOn)) ==
               [[], [first.id], Enum.sort([first.id, second.id])]

      Process.put(key, 0)
      assert {:ok, []} = WorkItems.list(context.user_id, context.vault_id, status: "done")
      assert Process.get(key) == 0
    after
      :telemetry.detach(key)
      Process.delete(key)
    end
  end

  test "dependencies, immutable workspace binding, leases, and token stops are durable",
       context do
    assert {:ok, dependency} =
             WorkItems.create(context.user_id, context.vault_id, %{title: "Dependency"})

    assert {:ok, item} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Candidate",
               dependsOn: [dependency.id],
               workspaceMode: "isolated",
               tokenBudget: 100
             })

    assert item.dependsOn == [dependency.id]

    assert {:error, "A work item cannot depend on itself"} =
             WorkItems.update(context.user_id, item.id, %{dependsOn: [item.id]})

    binding = %{
      repository: "org/repo",
      baseCommit: String.duplicate("a", 40),
      branch: "work/candidate",
      worktreePath: "/tmp/candidate"
    }

    assert {:ok, bound} = WorkItems.bind_workspace(context.user_id, item.id, binding)
    assert bound.repository == "org/repo"

    assert {:error, "Prepared branch does not match this work item"} =
             WorkItems.bind_workspace(context.user_id, item.id, %{binding | branch: "other"})

    assert {:ok, leased} =
             WorkItems.acquire_lease(context.user_id, item.id, "worker-a", 60_000)

    assert leased.status == "in_progress"

    assert {:error, lease_error} =
             WorkItems.acquire_lease(context.user_id, item.id, "worker-b", 60_000)

    assert lease_error =~ "Work item is leased by worker-a until "

    assert {:ok, %{budgetExceeded: true, item: stopped}} =
             WorkItems.add_token_usage(context.user_id, item.id, 100)

    assert stopped.status == "canceled"
    assert stopped.stopReason == "token_budget"
    assert stopped.leaseHolder == nil
  end

  test "unused isolated workspaces can rebind onto a newer base commit", context do
    assert {:ok, item} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Fresh worker",
               workspaceMode: "isolated"
             })

    old = String.duplicate("d", 40)
    new = String.duplicate("e", 40)

    binding = %{
      repository: "org/repo",
      baseCommit: old,
      branch: "cascade/fresh-worker",
      worktreePath: "/tmp/fresh-worker"
    }

    assert {:ok, bound} = WorkItems.bind_workspace(context.user_id, item.id, binding)
    assert bound.baseCommit == old

    assert {:ok, moved} =
             WorkItems.bind_workspace(context.user_id, item.id, %{binding | baseCommit: new})

    assert moved.baseCommit == new
  end

  test "review evidence is tied to the bound base and reported head", context do
    base = String.duplicate("b", 40)
    head = String.duplicate("c", 40)

    assert {:ok, item} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Reviewable",
               baseCommit: base,
               branch: "work/review",
               verification: "mix test"
             })

    state = %{
      branch: "work/review",
      headCommit: head,
      baseBranch: "main",
      ahead: 1,
      behind: 0,
      dirty: false,
      changedFiles: 1,
      hasUpstream: true
    }

    assert {:ok, reported} =
             WorkItems.report_git_state(context.user_id, item.id, %{
               baseCommit: base,
               branch: "work/review",
               state: state
             })

    assert reported.reviewReadiness.ready

    assert {:ok, review} =
             WorkItems.review(context.user_id, item.id, %{
               kind: "comment",
               note: "Looks correct",
               baseCommit: base,
               headCommit: head
             })

    assert review.status == "done"

    assert {:error, "Review head does not match the latest desktop Git evidence"} =
             WorkItems.review(context.user_id, item.id, %{
               kind: "comment",
               note: "Stale",
               baseCommit: base,
               headCommit: String.duplicate("d", 40)
             })
  end
end
