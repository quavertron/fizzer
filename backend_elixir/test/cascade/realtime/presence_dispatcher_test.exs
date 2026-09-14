defmodule Cascade.Realtime.PresenceDispatcherTest do
  use ExUnit.Case, async: true

  alias Cascade.Realtime.PresenceDispatcher

  test "collapses a burst for one source channel into one trailing refresh" do
    test_pid = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name()})

    dispatcher =
      start_supervised!(
        {PresenceDispatcher,
         name: nil,
         task_supervisor: task_supervisor,
         debounce_ms: 20,
         refresh: fn vault_id, channel_id ->
           send(test_pid, {:refreshed, vault_id, channel_id})
         end}
      )

    Enum.each(1..25, fn _ -> PresenceDispatcher.refresh(dispatcher, "vault", "channel") end)

    assert_receive {:refreshed, "vault", "channel"}, 200
    refute_receive {:refreshed, "vault", "channel"}, 80

    assert eventually(fn ->
             PresenceDispatcher.stats(dispatcher) == %{
               active: 0,
               completed: 1,
               dispatched: 1,
               failed: 0,
               noop: 0,
               pending: 0,
               queued: 0,
               refreshed: 1,
               startFailed: 0,
               taskFailed: 0,
               requested: 25
             }
           end)
  end

  test "default trailing debounce coalesces a 240ms request train into one refresh" do
    test_pid = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name()})

    dispatcher =
      start_supervised!(
        {PresenceDispatcher,
         name: nil,
         task_supervisor: task_supervisor,
         refresh: fn vault_id, channel_id ->
           send(test_pid, {:train_refreshed, vault_id, channel_id})
         end}
      )

    PresenceDispatcher.refresh(dispatcher, "vault", "channel")
    Process.sleep(240)
    PresenceDispatcher.refresh(dispatcher, "vault", "channel")
    Process.sleep(240)
    PresenceDispatcher.refresh(dispatcher, "vault", "channel")

    refute_receive {:train_refreshed, "vault", "channel"}, 300
    assert_receive {:train_refreshed, "vault", "channel"}, 300
    refute_receive {:train_refreshed, "vault", "channel"}, 100

    assert eventually(fn ->
             stats = PresenceDispatcher.stats(dispatcher)
             stats.requested == 3 and stats.dispatched == 1 and stats.completed == 1
           end)

    PresenceDispatcher.refresh(dispatcher, "vault", "channel")
    assert_receive {:train_refreshed, "vault", "channel"}, 600

    assert eventually(fn ->
             stats = PresenceDispatcher.stats(dispatcher)
             stats.requested == 4 and stats.dispatched == 2 and stats.completed == 2
           end)
  end

  test "bounds concurrent snapshots and reruns a channel changed during refresh" do
    test_pid = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name()})

    dispatcher =
      start_supervised!(
        {PresenceDispatcher,
         name: nil,
         task_supervisor: task_supervisor,
         debounce_ms: 10,
         max_concurrency: 1,
         refresh: fn vault_id, channel_id ->
           send(test_pid, {:started, self(), vault_id, channel_id})

           receive do
             :release -> :ok
           end
         end}
      )

    PresenceDispatcher.refresh(dispatcher, "vault", "one")
    PresenceDispatcher.refresh(dispatcher, "vault", "two")

    assert_receive {:started, first, "vault", "one"}, 200
    refute_receive {:started, _pid, "vault", "two"}, 40

    PresenceDispatcher.refresh(dispatcher, "vault", "one")
    send(first, :release)

    assert_receive {:started, second, "vault", "two"}, 200
    refute_receive {:started, _pid, "vault", "one"}, 40
    send(second, :release)

    assert_receive {:started, rerun, "vault", "one"}, 200
    send(rerun, :release)

    assert eventually(fn ->
             stats = PresenceDispatcher.stats(dispatcher)

             stats.active == 0 and stats.pending == 0 and stats.queued == 0 and
               stats.requested == 3 and stats.dispatched == 3 and stats.completed == 3
           end)
  end

  test "coalesces channel-only disconnect refreshes before the source lookup" do
    test_pid = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name()})

    dispatcher =
      start_supervised!(
        {PresenceDispatcher,
         name: nil,
         task_supervisor: task_supervisor,
         debounce_ms: 20,
         refresh_channel: fn channel_id -> send(test_pid, {:looked_up, channel_id}) end}
      )

    Enum.each(1..1_000, fn _ -> PresenceDispatcher.refresh_channel(dispatcher, "channel") end)

    assert_receive {:looked_up, "channel"}, 300
    refute_receive {:looked_up, "channel"}, 80

    assert eventually(fn ->
             stats = PresenceDispatcher.stats(dispatcher)
             stats.requested == 1_000 and stats.dispatched == 1 and stats.completed == 1
           end)
  end

  test "classifies every completed dispatcher job as refreshed or noop" do
    test_pid = self()
    task_supervisor = start_supervised!({Task.Supervisor, name: unique_name()})

    dispatcher =
      start_supervised!(
        {PresenceDispatcher,
         name: nil,
         task_supervisor: task_supervisor,
         debounce_ms: 5,
         refresh: fn _vault_id, channel_id ->
           send(test_pid, {:attempted, channel_id})
           if channel_id == "missing", do: :noop, else: :refreshed
         end}
      )

    PresenceDispatcher.refresh(dispatcher, "vault", "present")
    PresenceDispatcher.refresh(dispatcher, "vault", "missing")
    assert_receive {:attempted, "present"}, 200
    assert_receive {:attempted, "missing"}, 200

    assert eventually(fn ->
             stats = PresenceDispatcher.stats(dispatcher)

             stats.dispatched == 2 and stats.completed == 2 and stats.refreshed == 1 and
               stats.noop == 1 and stats.failed == 0 and stats.startFailed == 0 and
               stats.taskFailed == 0
           end)
  end

  defp unique_name,
    do: String.to_atom("presence_task_supervisor_#{System.unique_integer([:positive])}")

  defp eventually(fun, attempts \\ 100)
  defp eventually(_fun, 0), do: false

  defp eventually(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(10)
      eventually(fun, attempts - 1)
    end
  end
end
