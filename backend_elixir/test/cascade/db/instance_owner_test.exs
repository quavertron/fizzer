defmodule Cascade.DB.InstanceOwnerTest do
  use ExUnit.Case, async: false
  alias Cascade.DB.InstanceOwner

  test "network-mode deployment keeps rolling startup coordination" do
    previous = Application.fetch_env!(:cascade_elixir, :network_mode)
    try do
      Application.put_env(:cascade_elixir, :network_mode, true)
      assert InstanceOwner.children() == []
      Application.put_env(:cascade_elixir, :network_mode, false)
      assert InstanceOwner.children() == [InstanceOwner]
    after
      Application.put_env(:cascade_elixir, :network_mode, previous)
    end
  end

  test "only one backend can own a database and stopping releases ownership" do
    Process.flag(:trap_exit, true)
    directory = Path.join(System.tmp_dir!(), "fizzer-owner-#{System.unique_integer([:positive])}")
    File.mkdir_p!(directory)
    on_exit(fn -> File.rm_rf!(directory) end)
    database = Path.join(directory, "docs.db")
    {:ok, first} = InstanceOwner.start_link(database: database, name: :test_first_owner)
    try do
      assert {:error, reason} = InstanceOwner.start_link(database: database, name: :test_duplicate_owner)
      assert reason =~ "Another backend owns"
      # Ownership is per database, not a machine-wide singleton.
      {:ok, other} = InstanceOwner.start_link(database: Path.join(directory, "other.db"), name: :test_other_owner)
      GenServer.stop(other)
    after
      GenServer.stop(first)
    end
    {:ok, replacement} = InstanceOwner.start_link(database: database, name: :test_replacement_owner)
    GenServer.stop(replacement)
  end

  test "a crashed owner does not leave a stale filesystem lock" do
    directory = Path.join(System.tmp_dir!(), "fizzer-owner-crash-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(directory) end)
    database = Path.join(directory, "docs.db")
    {:ok, first} = InstanceOwner.start_link(database: database, name: :test_crashed_owner)
    Process.unlink(first)
    monitor = Process.monitor(first)
    Process.exit(first, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^first, :killed}
    {:ok, replacement} = InstanceOwner.start_link(database: database, name: :test_crash_replacement)
    GenServer.stop(replacement)
  end
end
