defmodule Cascade.ApplicationSupervisionTest do
  use ExUnit.Case, async: false

  alias Cascade.DB.WriteCoordinator
  alias Cascade.Realtime.OrderedPublisher

  test "runtime dispatch startup follows the server flag" do
    previous = System.get_env("CASCADE_SERVER")

    try do
      for {value, enabled} <- [{nil, true}, {"true", true}, {"false", false}] do
        if value,
          do: System.put_env("CASCADE_SERVER", value),
          else: System.delete_env("CASCADE_SERVER")

        config = Config.Reader.read!(Path.expand("../../config/runtime.exs", __DIR__), env: :prod)
        assert config[:cascade_elixir][:server] == enabled
        assert config[:cascade_elixir][:dispatch_worker_enabled] == enabled
      end
    after
      if previous,
        do: System.put_env("CASCADE_SERVER", previous),
        else: System.delete_env("CASCADE_SERVER")
    end
  end

  test "offline boot starts the database without dispatch work while tests enable the worker" do
    refute Application.fetch_env!(:cascade_elixir, :server)
    assert Application.fetch_env!(:cascade_elixir, :dispatch_worker_enabled)
    assert is_pid(Process.whereis(Cascade.Missions.DispatchReannouncer))

    try do
      :ok = Application.stop(:cascade_elixir)
      Application.put_env(:cascade_elixir, :dispatch_worker_enabled, false)
      assert {:ok, _} = Application.ensure_all_started(:cascade_elixir)
      assert is_pid(Process.whereis(Cascade.DB.Repo))
      assert %{rows: [[1]]} = Ecto.Adapters.SQL.query!(Cascade.DB.Repo, "SELECT 1", [])
      refute Process.whereis(Cascade.Missions.DispatchReannouncer)

      refute Enum.any?(Supervisor.which_children(Cascade.Supervisor), fn {id, _, _, _} ->
               id == Cascade.Missions.DispatchReannouncer
             end)

      assert :ok = Cascade.Missions.DispatchReannouncer.wake()
      refute Process.whereis(Cascade.Missions.DispatchReannouncer)
    after
      :ok = Application.stop(:cascade_elixir)
      Application.put_env(:cascade_elixir, :dispatch_worker_enabled, true)
      {:ok, _} = Application.ensure_all_started(:cascade_elixir)
    end

    assert is_pid(Process.whereis(Cascade.Missions.DispatchReannouncer))
  end

  test "server boot starts only one dispatch worker" do
    port = Application.fetch_env!(:cascade_elixir, :port)

    try do
      :ok = Application.stop(:cascade_elixir)
      Application.put_env(:cascade_elixir, :server, true)
      Application.put_env(:cascade_elixir, :port, 0)
      assert {:ok, _} = Application.ensure_all_started(:cascade_elixir)

      assert Enum.count(Supervisor.which_children(Cascade.Supervisor), fn {id, _, _, _} ->
               id == Cascade.Missions.DispatchReannouncer
             end) == 1
    after
      :ok = Application.stop(:cascade_elixir)
      Application.put_env(:cascade_elixir, :server, false)
      Application.put_env(:cascade_elixir, :port, port)
      {:ok, _} = Application.ensure_all_started(:cascade_elixir)
    end
  end

  test "an ordered publisher restart replaces dependent run and realtime workers" do
    parent = self()
    publisher = Process.whereis(OrderedPublisher)
    run_supervisor = Process.whereis(Cascade.Runs.Supervisor)
    session_supervisor = Process.whereis(Cascade.Realtime.SessionSupervisor)

    caller =
      spawn(fn ->
        try do
          OrderedPublisher.mutate(fn ->
            send(parent, {:publisher_mutation_entered, self()})
            Process.sleep(:infinity)
            send(parent, :stale_mutation_continued)
          end)
        catch
          :exit, reason -> send(parent, {:publisher_call_failed, reason})
        end
      end)

    caller_monitor = Process.monitor(caller)
    assert_receive {:publisher_mutation_entered, ^publisher}, 1_000

    Process.exit(publisher, :kill)
    assert_receive {:publisher_call_failed, _reason}, 2_000
    assert_receive {:DOWN, ^caller_monitor, :process, ^caller, :normal}, 2_000
    refute_receive :stale_mutation_continued, 100

    wait_until(fn ->
      replacement = Process.whereis(OrderedPublisher)
      is_pid(replacement) and replacement != publisher
    end)

    wait_until(fn ->
      replacement = Process.whereis(Cascade.Runs.Supervisor)
      is_pid(replacement) and replacement != run_supervisor
    end)

    wait_until(fn ->
      replacement = Process.whereis(Cascade.Realtime.SessionSupervisor)
      is_pid(replacement) and replacement != session_supervisor
    end)
  end

  test "a coordinator restart kills downstream lock owners before granting a new lease" do
    parent = self()
    coordinator = Process.whereis(WriteCoordinator)
    session_supervisor = Process.whereis(Cascade.Realtime.SessionSupervisor)

    child_spec = %{
      id: make_ref(),
      start:
        {Task, :start_link,
         [
           fn ->
             WriteCoordinator.with_lock(fn ->
               send(parent, {:old_lease_acquired, self()})
               Process.sleep(:infinity)
             end)
           end
         ]},
      restart: :temporary,
      shutdown: :brutal_kill,
      type: :worker
    }

    {:ok, old_owner} =
      DynamicSupervisor.start_child(Cascade.Realtime.SessionSupervisor, child_spec)

    assert_receive {:old_lease_acquired, ^old_owner}, 1_000
    owner_monitor = Process.monitor(old_owner)
    Process.exit(coordinator, :kill)

    assert_receive {:DOWN, ^owner_monitor, :process, ^old_owner, _reason}, 2_000

    wait_until(fn ->
      replacement = Process.whereis(WriteCoordinator)
      is_pid(replacement) and replacement != coordinator
    end)

    wait_until(fn ->
      replacement = Process.whereis(Cascade.Realtime.SessionSupervisor)
      is_pid(replacement) and replacement != session_supervisor
    end)

    contender =
      Task.async(fn ->
        WriteCoordinator.with_lock(fn ->
          send(parent, {:new_lease_acquired, self(), Process.alive?(old_owner)})
          :ok
        end)
      end)

    assert_receive {:new_lease_acquired, contender_pid, false}, 2_000
    assert contender.pid == contender_pid
    assert :ok = Task.await(contender, 1_000)
  end

  defp wait_until(fun, attempts \\ 500)

  defp wait_until(_fun, 0), do: flunk("supervision tree did not restart")

  defp wait_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, attempts - 1)
    end
  end
end
