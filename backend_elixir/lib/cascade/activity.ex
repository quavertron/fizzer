defmodule Cascade.Activity do
  @moduledoc "Bounded vault activity replay over the existing /vault connection."
  use GenServer
  alias Cascade.Content.Store
  alias Cascade.Realtime.{Hub, Session}

  @fields ~w(kind agent author conflict_agent conflict_line_start conflict_line_end result tool detail file line_start line_end old_lines new_lines timestamp truncated)
  @limit 512_000

  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def publish(vault_id, event) when is_binary(vault_id) and is_map(event),
    do: GenServer.cast(__MODULE__, {:publish, vault_id, event})

  def replay(vault_id, cursor), do: GenServer.call(__MODULE__, {:replay, vault_id, cursor})
  def allowed?(vault_id, user_id), do: Store.vault_role(vault_id, user_id) in ["owner", "editor"]

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_cast({:publish, vault_id, raw}, state) do
    event =
      raw
      |> Map.take(@fields)
      |> Enum.filter(fn
        {key, value} when key in ["old_lines", "new_lines"] ->
          is_list(value) and Enum.all?(value, &is_binary/1)

        {key, value} when key in ["timestamp", "line_start", "line_end"] ->
          is_integer(value)

        {"truncated", value} ->
          is_boolean(value)

        {_, value} ->
          is_binary(value)
      end)
      |> Map.new()

    encoded = Jason.encode!(event)
    source = Map.get(raw, "id")

    stream =
      Map.get_lazy(state, vault_id, fn ->
        %{
          epoch: Base.url_encode64(:crypto.strong_rand_bytes(12)),
          seq: 0,
          events: [],
          bytes: 0,
          touched: 0
        }
      end)

    duplicate = is_binary(source) and Enum.any?(stream.events, fn {_, id, _} -> id == source end)

    if event["kind"] in ["edit", "lock", "tool"] and byte_size(encoded) < @limit - 2048 and
         not duplicate do
      seq = stream.seq + 1
      event = Map.put(event, "id", "#{stream.epoch}:#{seq}")
      size = byte_size(Jason.encode!(event))
      entries = stream.events ++ [{event, source, size}]
      {entries, bytes} = trim(entries, stream.bytes + size)

      stream = %{
        stream
        | seq: seq,
          events: entries,
          bytes: bytes,
          touched: System.unique_integer([:monotonic])
      }

      payload = %{vaultId: vault_id, events: [event], cursor: %{epoch: stream.epoch, seq: seq}}
      # Diffs may include unlisted files. Recheck write-level access on every delivery.
      for sid <- Hub.room_members("vault:#{vault_id}", "/vault") do
        user = Hub.user_id_for_session(sid, "/vault")

        if is_integer(user) and allowed?(vault_id, user),
          do: Session.emit(sid, "/vault", "vault:activity", [payload])
      end

      state = Map.put(state, vault_id, stream)

      state =
        if map_size(state) > 32,
          do: Map.delete(state, elem(Enum.min_by(state, fn {_, s} -> s.touched end), 0)),
          else: state

      {:noreply, state}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_call({:replay, vault_id, cursor}, _from, state) do
    cursor = if is_map(cursor), do: cursor, else: %{}

    case state[vault_id] do
      nil ->
        {:reply, %{vaultId: vault_id, events: [], gap: Map.get(cursor, "epoch") not in [nil, ""]},
         state}

      stream ->
        seq = if is_integer(cursor["seq"]), do: cursor["seq"], else: 0
        first = stream.seq - length(stream.events) + 1
        same = cursor["epoch"] == stream.epoch

        gap =
          cursor["epoch"] not in [nil, ""] and (not same or seq + 1 < first or seq > stream.seq)

        events =
          stream.events
          |> Enum.map(&elem(&1, 0))
          |> Enum.filter(fn event ->
            not same or gap or String.to_integer(List.last(String.split(event["id"], ":"))) > seq
          end)

        {:reply,
         %{
           vaultId: vault_id,
           events: events,
           gap: gap,
           cursor: %{epoch: stream.epoch, seq: stream.seq}
         }, state}
    end
  end

  defp trim([first | rest] = events, bytes) when length(events) > 256 or bytes > @limit,
    do: trim(rest, bytes - elem(first, 2))

  defp trim(events, bytes), do: {events, bytes}
end
