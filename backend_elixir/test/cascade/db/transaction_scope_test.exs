defmodule Cascade.DB.TransactionScopeTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.DB.Repo

  setup do
    SQL.exec("CREATE TABLE transaction_scope_probe (id INTEGER PRIMARY KEY)")
    on_exit(fn -> SQL.exec("DROP TABLE transaction_scope_probe") end)
    :ok
  end

  test "immediate outer transaction retains nested commit and rollback semantics" do
    assert :committed ==
             SQL.transaction(
               fn ->
                 SQL.exec("INSERT INTO transaction_scope_probe VALUES(1)")

                 SQL.transaction(fn ->
                   SQL.exec("INSERT INTO transaction_scope_probe VALUES(2)")
                 end)

                 :committed
               end,
               mode: :immediate
             )

    assert SQL.all("SELECT id FROM transaction_scope_probe ORDER BY id") == [[1], [2]]

    assert_raise RuntimeError, ~r/account transaction rolled back/, fn ->
      SQL.transaction(
        fn ->
          SQL.exec("INSERT INTO transaction_scope_probe VALUES(3)")

          SQL.transaction(fn ->
            SQL.exec("INSERT INTO transaction_scope_probe VALUES(4)")
            Repo.rollback(:nested_failure)
          end)
        end,
        mode: :immediate
      )
    end

    assert SQL.all("SELECT id FROM transaction_scope_probe ORDER BY id") == [[1], [2]]

    assert_raise RuntimeError, "fixture exception", fn ->
      SQL.transaction(
        fn ->
          SQL.transaction(fn -> SQL.exec("INSERT INTO transaction_scope_probe VALUES(5)") end)
          raise "fixture exception"
        end,
        mode: :immediate
      )
    end

    assert SQL.all("SELECT id FROM transaction_scope_probe ORDER BY id") == [[1], [2]]
    # Rollback/exception must release both Ecto checkout and the process-local lock.
    assert :after_rollback == SQL.transaction(fn -> :after_rollback end, mode: :immediate)
  end
end
