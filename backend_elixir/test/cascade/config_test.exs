defmodule Cascade.ConfigTest do
  use ExUnit.Case, async: false

  alias Cascade.Runs.{RunnerLifecycle, Supervisor}

  @runtime Path.expand("../../config/runtime.exs", __DIR__)
  @variable "CASCADE_RUNNER_ORPHAN_RECLAIM_MS"
  @hibernate_variable "CASCADE_REALTIME_HIBERNATE_AFTER_MS"

  setup do
    previous = Map.new([@variable, @hibernate_variable], &{&1, System.get_env(&1)})

    on_exit(fn ->
      Enum.each(previous, fn {variable, value} ->
        if value, do: System.put_env(variable, value), else: System.delete_env(variable)
      end)
    end)
  end

  test "runtime requires explicit finite or unlimited admission capacity and retains binding validation" do
    variable = "CASCADE_DATA_DIR"
    previous = System.get_env(variable)
    dir = Path.join(System.tmp_dir!(), "admission-config-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    System.put_env(variable, dir)
    on_exit(fn ->
      if previous, do: System.put_env(variable, previous), else: System.delete_env(variable)
      File.rm_rf!(dir)
    end)
    owner = %{"ownerId" => 1, "tasks" => [], "retainedRuns" => []}
    write = fn entry ->
      File.write!(Path.join(dir, "execution-admission.json"), Jason.encode!(%{"version" => 1, "owners" => [entry]}))
    end
    for limit <- [1, 2, "unlimited"] do
      entry = Map.put(owner, "maxConcurrent", limit)
      write.(entry)
      assert runtime_value(:execution_admission)["owners"] == [entry]
    end
    for entry <- [owner | Enum.map([nil, 0, -1, 3, "2", "Unlimited", false], &Map.put(owner, "maxConcurrent", &1))] do
      write.(entry)
      assert_raise RuntimeError, "Invalid execution admission bindings", fn -> runtime_value(:execution_admission) end
    end
    for entry <- [Map.put(owner, "ownerId", 0), Map.put(owner, "tasks", [%{}]), Map.put(owner, "retainedRuns", [%{}])] do
      write.(Map.put(entry, "maxConcurrent", "unlimited"))
      assert_raise RuntimeError, "Invalid execution admission bindings", fn -> runtime_value(:execution_admission) end
    end
  end

  test "runtime keeps the 120-second reclaim parity default" do
    System.delete_env(@variable)
    assert runtime_reclaim_ms() == 120_000
  end

  test "runtime accepts the production ten-minute reclaim window" do
    System.put_env(@variable, "600000")
    assert runtime_reclaim_ms() == 600_000
  end

  test "runtime rejects unsafe or malformed reclaim windows" do
    for value <- ["119999", "3600001", "not-a-duration"] do
      System.put_env(@variable, value)

      assert_raise RuntimeError, ~r/CASCADE_RUNNER_ORPHAN_RECLAIM_MS must be an integer/, fn ->
        runtime_reclaim_ms()
      end
    end
  end

  test "runtime bounds the realtime idle hibernation window" do
    System.delete_env(@hibernate_variable)
    assert runtime_value(:realtime_hibernate_after_ms) == 5_000

    System.put_env(@hibernate_variable, "10000")
    assert runtime_value(:realtime_hibernate_after_ms) == 10_000

    for value <- ["999", "60001", "not-a-duration"] do
      System.put_env(@hibernate_variable, value)

      assert_raise RuntimeError, ~r/CASCADE_REALTIME_HIBERNATE_AFTER_MS must be an integer/, fn ->
        runtime_value(:realtime_hibernate_after_ms)
      end
    end
  end

  test "the run supervisor propagates the configured reclaim window to the lifecycle timer" do
    previous = Application.fetch_env!(:cascade_elixir, :runner_orphan_reclaim_ms)
    Application.put_env(:cascade_elixir, :runner_orphan_reclaim_ms, 600_000)

    on_exit(fn ->
      Application.put_env(:cascade_elixir, :runner_orphan_reclaim_ms, previous)
    end)

    assert {:ok, {_flags, [child]}} = Supervisor.init([])
    assert child.start == {RunnerLifecycle, :start_link, [[orphan_reclaim_ms: 600_000]]}

    assert {:ok, state} = RunnerLifecycle.init(orphan_reclaim_ms: 600_000)
    assert state.orphan_reclaim == 600_000
    assert is_integer(Process.read_timer(state.orphan_timer))
    Process.cancel_timer(state.orphan_timer)
  end

  defp runtime_reclaim_ms do
    runtime_value(:runner_orphan_reclaim_ms)
  end

  defp runtime_value(key),
    do: @runtime |> Config.Reader.read!(env: :prod) |> get_in([:cascade_elixir, key])
end
