defmodule Cascade.Realtime.PresenceDispatcher do
  @moduledoc """
  Coalesces chat-presence refreshes by source channel.

  A joining socket receives its initial snapshot directly from the session. The
  shared room refresh is trailing-edge debounced so a burst of joins produces
  one final snapshot instead of one full-room broadcast per socket. Refreshes
  that arrive while a snapshot is being built schedule another pass, preserving
  the final state when membership changes during a broadcast.
  """

  use GenServer

  @default_debounce_ms 500
  @default_max_concurrency 4
  @cache_table Cascade.Realtime.PresenceDispatcher.Cache

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    server_opts = if name, do: [name: name], else: []
    GenServer.start_link(__MODULE__, opts, server_opts)
  end

  def refresh(source_vault_id, source_channel_id),
    do: refresh(__MODULE__, source_vault_id, source_channel_id)

  def refresh(server, source_vault_id, source_channel_id)
      when is_binary(source_vault_id) and is_binary(source_channel_id) do
    GenServer.cast(server, {:refresh, {source_vault_id, source_channel_id}})
  end

  def refresh_channel(source_channel_id) when is_binary(source_channel_id),
    do: refresh_channel(__MODULE__, source_channel_id)

  def refresh_channel(server, source_channel_id) when is_binary(source_channel_id),
    do: GenServer.cast(server, {:refresh_channel, source_channel_id})

  def remember_source(source_vault_id, source_channel_id)
      when is_binary(source_vault_id) and is_binary(source_channel_id),
      do: GenServer.cast(__MODULE__, {:remember_source, source_vault_id, source_channel_id})

  def cached_user_channels(user_id) when is_integer(user_id) do
    case cache_lookup({:user_channels, user_id}) do
      {:ok, channels} -> {:ok, channels}
      :error -> :miss
    end
  end

  def cached_user_channels(_user_id), do: :miss

  def user_channels_generation do
    if Process.whereis(__MODULE__) do
      GenServer.call(__MODULE__, :user_channels_generation)
    else
      :unavailable
    end
  end

  def remember_user_channels(user_id, channels, generation)
      when is_integer(user_id) and is_list(channels) and is_integer(generation) do
    if Process.whereis(__MODULE__) do
      GenServer.call(__MODULE__, {:remember_user_channels, user_id, channels, generation})
    else
      :unavailable
    end
  end

  def remember_user_channels(_user_id, _channels, _generation), do: :unavailable

  def invalidate_user_channels do
    if Process.whereis(__MODULE__), do: GenServer.call(__MODULE__, :invalidate_user_channels)
    :ok
  end

  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(opts) do
    cache_table = maybe_create_cache(Keyword.get(opts, :name, __MODULE__))

    state = %{
      active: MapSet.new(),
      completed: 0,
      debounce_ms: Keyword.get(opts, :debounce_ms, @default_debounce_ms),
      dirty: MapSet.new(),
      dispatched: 0,
      failed: 0,
      max_concurrency: Keyword.get(opts, :max_concurrency, @default_max_concurrency),
      queue: :queue.new(),
      queued: MapSet.new(),
      refresh:
        Keyword.get(
          opts,
          :refresh,
          &Cascade.Realtime.Events.emit_presence_now(&1, &2, :dispatcher)
        ),
      refresh_channel:
        Keyword.get(
          opts,
          :refresh_channel,
          &Cascade.Realtime.Events.emit_presence_for_channel_now(&1, :dispatcher)
        ),
      refreshed: 0,
      noop: 0,
      task_failed: 0,
      start_failed: 0,
      requested: 0,
      task_supervisor:
        Keyword.get(opts, :task_supervisor, Cascade.Realtime.PresenceTaskSupervisor),
      timers: %{},
      cache_table: cache_table,
      user_channels_generation: 0
    }

    {:ok, state}
  end

  @impl true
  def handle_cast({:refresh, key}, state) do
    {source_vault_id, source_channel_id} = key
    cache_put(state.cache_table, {:source, source_channel_id}, source_vault_id)
    {:noreply, request_refresh(state, key)}
  end

  def handle_cast({:refresh_channel, source_channel_id}, state) do
    key =
      case cache_lookup(state.cache_table, {:source, source_channel_id}) do
        {:ok, source_vault_id} -> {source_vault_id, source_channel_id}
        :error -> {:lookup_channel, source_channel_id}
      end

    {:noreply, request_refresh(state, key)}
  end

  def handle_cast({:remember_source, source_vault_id, source_channel_id}, state) do
    cache_put(state.cache_table, {:source, source_channel_id}, source_vault_id)
    {:noreply, state}
  end

  defp request_refresh(state, key) do
    state = %{state | requested: state.requested + 1}

    cond do
      MapSet.member?(state.active, key) ->
        %{state | dirty: MapSet.put(state.dirty, key)}

      MapSet.member?(state.queued, key) ->
        state

      true ->
        debounce(state, key)
    end
  end

  @impl true
  def handle_call(:stats, _from, state) do
    stats = %{
      active: MapSet.size(state.active),
      completed: state.completed,
      dispatched: state.dispatched,
      failed: state.failed,
      noop: state.noop,
      pending: map_size(state.timers),
      queued: MapSet.size(state.queued),
      refreshed: state.refreshed,
      startFailed: state.start_failed,
      taskFailed: state.task_failed,
      requested: state.requested
    }

    {:reply, stats, state}
  end

  def handle_call(:user_channels_generation, _from, state) do
    {:reply, state.user_channels_generation, state}
  end

  def handle_call(
        {:remember_user_channels, user_id, channels, generation},
        _from,
        %{user_channels_generation: generation} = state
      ) do
    cache_put(state.cache_table, {:user_channels, user_id}, channels)
    {:reply, :ok, state}
  end

  def handle_call({:remember_user_channels, _user_id, _channels, _generation}, _from, state) do
    {:reply, :stale, state}
  end

  def handle_call(:invalidate_user_channels, _from, state) do
    if state.cache_table, do: :ets.match_delete(state.cache_table, {{:user_channels, :_}, :_})

    {:reply, :ok, %{state | user_channels_generation: state.user_channels_generation + 1}}
  end

  @impl true
  def handle_info({:debounce, key, token}, state) do
    case state.timers do
      %{^key => {_timer_ref, ^token}} ->
        state =
          state
          |> Map.update!(:timers, &Map.delete(&1, key))
          |> enqueue(key)
          |> dispatch()

        {:noreply, state}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info({:presence_refresh_done, key, result}, state) do
    {refreshed, noop, task_failed} =
      case result do
        :refreshed -> {1, 0, 0}
        :noop -> {0, 1, 0}
        _ -> {0, 0, 1}
      end

    state = %{
      state
      | active: MapSet.delete(state.active, key),
        completed: state.completed + 1,
        failed: state.failed + task_failed,
        noop: state.noop + noop,
        refreshed: state.refreshed + refreshed,
        task_failed: state.task_failed + task_failed
    }

    state =
      if MapSet.member?(state.dirty, key) do
        state
        |> Map.update!(:dirty, &MapSet.delete(&1, key))
        |> debounce(key)
      else
        state
      end

    {:noreply, dispatch(state)}
  end

  defp debounce(state, key) do
    case Map.get(state.timers, key) do
      {timer_ref, _token} -> Process.cancel_timer(timer_ref, async: true, info: false)
      nil -> :ok
    end

    token = make_ref()
    timer_ref = Process.send_after(self(), {:debounce, key, token}, state.debounce_ms)
    %{state | timers: Map.put(state.timers, key, {timer_ref, token})}
  end

  defp enqueue(state, key) do
    if MapSet.member?(state.queued, key) or MapSet.member?(state.active, key) do
      state
    else
      %{
        state
        | queue: :queue.in(key, state.queue),
          queued: MapSet.put(state.queued, key)
      }
    end
  end

  defp dispatch(state) do
    if MapSet.size(state.active) < state.max_concurrency do
      case :queue.out(state.queue) do
        {{:value, key}, queue} ->
          state = %{state | queue: queue, queued: MapSet.delete(state.queued, key)}
          dispatch(start_refresh(key, state))

        {:empty, _queue} ->
          state
      end
    else
      state
    end
  end

  defp start_refresh({source_vault_id, source_channel_id} = key, state)
       when is_binary(source_vault_id) and is_binary(source_channel_id) do
    coordinator = self()
    refresh = state.refresh

    case Task.Supervisor.start_child(state.task_supervisor, fn ->
           result =
             try do
               normalize_refresh_result(refresh.(source_vault_id, source_channel_id))
             catch
               kind, reason -> {kind, reason}
             end

           send(coordinator, {:presence_refresh_done, key, result})
         end) do
      {:ok, _pid} ->
        %{
          state
          | active: MapSet.put(state.active, key),
            dispatched: state.dispatched + 1
        }

      {:error, _reason} ->
        state
        |> Map.update!(:failed, &(&1 + 1))
        |> Map.update!(:start_failed, &(&1 + 1))
        |> debounce(key)
    end
  end

  defp start_refresh({:lookup_channel, source_channel_id} = key, state) do
    coordinator = self()
    refresh_channel = state.refresh_channel

    case Task.Supervisor.start_child(state.task_supervisor, fn ->
           result =
             try do
               normalize_refresh_result(refresh_channel.(source_channel_id))
             catch
               kind, reason -> {kind, reason}
             end

           send(coordinator, {:presence_refresh_done, key, result})
         end) do
      {:ok, _pid} ->
        %{
          state
          | active: MapSet.put(state.active, key),
            dispatched: state.dispatched + 1
        }

      {:error, _reason} ->
        state
        |> Map.update!(:failed, &(&1 + 1))
        |> Map.update!(:start_failed, &(&1 + 1))
        |> debounce(key)
    end
  end

  defp maybe_create_cache(__MODULE__) do
    :ets.new(@cache_table, [
      :named_table,
      :protected,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])
  end

  defp maybe_create_cache(_name), do: nil

  defp cache_lookup(key), do: cache_lookup(@cache_table, key)

  defp cache_lookup(nil, _key), do: :error

  defp cache_lookup(table, key) do
    case :ets.lookup(table, key) do
      [{^key, value}] -> {:ok, value}
      _ -> :error
    end
  rescue
    ArgumentError -> :error
  end

  defp cache_put(nil, _key, _value), do: :ok
  defp cache_put(table, key, value), do: :ets.insert(table, {key, value})

  defp normalize_refresh_result(:noop), do: :noop
  defp normalize_refresh_result(_result), do: :refreshed
end
