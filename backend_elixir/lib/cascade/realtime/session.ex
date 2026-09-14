defmodule Cascade.Realtime.Session do
  @moduledoc false
  use GenServer, restart: :temporary

  alias Cascade.Realtime.{Auth, Hub}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}

  @ping_interval 25_000
  @ping_timeout 60_000
  @max_payload 1_000_000
  @poll_timeout 20_000
  @max_queue_packets 256
  @max_queue_bytes 1_000_000
  @max_mailbox 512
  @max_pending_acks 128
  @auth_cache_wave_ms 5_000

  def start_link(opts) do
    sid = Keyword.fetch!(opts, :sid)

    hibernate_after =
      Keyword.get_lazy(opts, :hibernate_after_ms, fn ->
        Application.fetch_env!(:cascade_elixir, :realtime_hibernate_after_ms)
      end)

    GenServer.start_link(__MODULE__, opts, name: via(sid), hibernate_after: hibernate_after)
  end

  def poll(sid, timeout \\ @poll_timeout + 2_000), do: call(sid, :poll, timeout)
  def receive_payload(sid, payload), do: call(sid, {:payload, payload})
  def attach_websocket(sid, pid, mode), do: call(sid, {:attach_websocket, pid, mode})
  def websocket_packet(sid, raw, pid), do: call(sid, {:websocket_packet, raw, pid})
  def websocket_closed(sid, pid), do: cast(sid, {:websocket_closed, pid})

  def emit(sid, namespace, event, args) do
    cast(sid, {:server_event, namespace, event, args})
  end

  def emit_with_ack(sid, namespace, event, args, timeout) do
    call(sid, {:server_event_ack, namespace, event, args, timeout}, timeout + 1_000)
  end

  def disconnect_namespace(sid, namespace, reason),
    do: cast(sid, {:disconnect_namespace, namespace, reason})

  def disconnect(sid, reason), do: cast(sid, {:disconnect, reason})

  @impl true
  def init(opts) do
    sid = Keyword.fetch!(opts, :sid)
    domain = Keyword.get(opts, :domain, configured(:domain, Cascade.Realtime.Domain.FailClosed))
    cookie_token = Keyword.get(opts, :cookie_token)
    transport = Keyword.get(opts, :transport, :polling)
    Hub.track(sid, self())

    open =
      EngineIO.open_packet(
        sid,
        if(transport == :polling, do: ["websocket"], else: []),
        @ping_interval,
        @ping_timeout,
        @max_payload
      )
      |> EngineIO.encode_packet()

    state = %{
      sid: sid,
      domain: domain,
      cookie_token: cookie_token,
      authenticated_identity: nil,
      authenticated_token: nil,
      authenticated_expires_at: nil,
      auth_cache_deadline_ms: nil,
      auth_cache_wave_ms: Keyword.get(opts, :auth_cache_wave_ms, @auth_cache_wave_ms),
      auth_attempted_namespaces: MapSet.new(),
      active_transport: transport,
      websocket: nil,
      upgrade_socket: nil,
      upgrade_probed: false,
      namespaces: %{},
      queue: :queue.in(open, :queue.new()),
      queue_packets: 1,
      queue_bytes: byte_size(open),
      poll_waiter: nil,
      poll_timer: nil,
      heartbeat_timer: Process.send_after(self(), :heartbeat_ping, @ping_interval),
      pong_timer: nil,
      next_ack_id: 0,
      pending_acks: %{},
      max_queue_packets: Keyword.get(opts, :max_queue_packets, @max_queue_packets),
      max_queue_bytes: Keyword.get(opts, :max_queue_bytes, @max_queue_bytes),
      max_mailbox: Keyword.get(opts, :max_mailbox, @max_mailbox),
      max_pending_acks: Keyword.get(opts, :max_pending_acks, @max_pending_acks)
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:poll, from, state) do
    cond do
      state.active_transport == :websocket ->
        {:reply, {:error, :transport_mismatch}, state}

      state.poll_waiter != nil ->
        {:reply, {:error, :overlapping_poll}, state}

      state.queue_packets > 0 ->
        {payload, state} = drain_queue(state)
        {:reply, {:ok, payload}, state}

      state.upgrade_probed ->
        {:reply, {:ok, EngineIO.encode_packet(%{type: :noop})}, state}

      true ->
        timer = Process.send_after(self(), :poll_timeout, @poll_timeout)
        {:noreply, %{state | poll_waiter: from, poll_timer: timer}}
    end
  end

  def handle_call({:payload, payload}, _from, state) do
    with {:ok, packets} <- EngineIO.decode_payload(payload, @max_payload),
         {:ok, state} <- process_engine_packets(packets, :polling, state) do
      {:reply, :ok, state}
    else
      {:close, :client_close, state} -> {:stop, :normal, :ok, state}
      {:close, reason, state} -> {:stop, reason, {:error, reason}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:attach_websocket, pid, :direct}, _from, state) do
    if state.active_transport == :websocket and state.websocket == nil do
      Process.monitor(pid)
      {packets, state} = drain_packets(state)
      {:reply, {:ok, packets}, %{state | websocket: pid}}
    else
      {:reply, {:error, :transport_mismatch}, state}
    end
  end

  def handle_call({:attach_websocket, pid, :upgrade}, _from, state) do
    if state.active_transport == :polling and state.upgrade_socket == nil do
      Process.monitor(pid)
      {:reply, {:ok, []}, %{state | upgrade_socket: pid, upgrade_probed: false}}
    else
      {:reply, {:error, :transport_mismatch}, state}
    end
  end

  def handle_call({:websocket_packet, raw, pid}, _from, state) do
    with {:ok, packet} <- EngineIO.decode_packet(raw),
         {:ok, replies, state} <- process_websocket_packet(packet, pid, state) do
      {:reply, {:ok, replies}, state}
    else
      {:close, reason, state} -> {:stop, reason, {:error, reason}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:server_event_ack, namespace, event, args, timeout}, from, state) do
    cond do
      not Map.has_key?(state.namespaces, namespace) ->
        {:reply, {:error, :namespace_not_connected}, state}

      map_size(state.pending_acks) >= state.max_pending_acks ->
        {:reply, {:error, :ack_backpressure}, state}

      true ->
        id = state.next_ack_id
        raw = engine_message(SocketIO.event(namespace, event, args, id))
        timer = Process.send_after(self(), {:ack_timeout, id}, timeout)
        pending = Map.put(state.pending_acks, id, {from, timer})

        case enqueue(raw, state) do
          {:ok, state} ->
            {:noreply, %{state | pending_acks: pending, next_ack_id: rem(id + 1, 2_147_483_647)}}

          {:error, reason, state} ->
            Process.cancel_timer(timer)
            {:reply, {:error, reason}, state}
        end
    end
  end

  @impl true
  def handle_cast({:server_event, namespace, event, args}, state) do
    if Map.has_key?(state.namespaces, namespace) do
      case enqueue(engine_message(SocketIO.event(namespace, event, args)), state) do
        {:ok, state} -> {:noreply, state}
        {:error, reason, state} -> {:stop, reason, state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_cast({:disconnect_namespace, namespace, reason}, state) do
    {:noreply, disconnect_namespace_state(namespace, reason, true, state)}
  end

  def handle_cast({:disconnect, reason}, state), do: {:stop, {:shutdown, reason}, state}

  def handle_cast({:websocket_closed, pid}, state) do
    cond do
      state.websocket == pid ->
        {:stop, :normal, %{state | websocket: nil}}

      state.upgrade_socket == pid ->
        {:noreply, %{state | upgrade_socket: nil, upgrade_probed: false}}

      true ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:heartbeat_ping, state) do
    state = %{state | heartbeat_timer: nil}

    case enqueue(EngineIO.encode_packet(%{type: :ping}), state) do
      {:ok, state} ->
        timer = Process.send_after(self(), :pong_timeout, @ping_timeout)
        {:noreply, %{state | pong_timer: timer}}

      {:error, reason, state} ->
        {:stop, reason, state}
    end
  end

  def handle_info(:pong_timeout, state), do: {:stop, :heartbeat_timeout, state}

  def handle_info(:poll_timeout, %{poll_waiter: nil} = state),
    do: {:noreply, %{state | poll_timer: nil}}

  def handle_info(:poll_timeout, state) do
    GenServer.reply(state.poll_waiter, {:ok, EngineIO.encode_packet(%{type: :noop})})
    {:noreply, %{state | poll_waiter: nil, poll_timer: nil}}
  end

  def handle_info({:ack_timeout, id}, state) do
    case Map.pop(state.pending_acks, id) do
      {nil, _} ->
        {:noreply, state}

      {{from, _timer}, pending} ->
        GenServer.reply(from, {:error, :ack_timeout})
        {:noreply, %{state | pending_acks: pending}}
    end
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    cond do
      state.websocket == pid ->
        {:stop, :normal, %{state | websocket: nil}}

      state.upgrade_socket == pid ->
        {:noreply, %{state | upgrade_socket: nil, upgrade_probed: false}}

      true ->
        {:noreply, state}
    end
  end

  @impl true
  def terminate(reason, state) do
    cancel_timer(state.heartbeat_timer)
    cancel_timer(state.pong_timer)
    cancel_timer(state.poll_timer)

    Enum.each(state.pending_acks, fn {_id, {from, timer}} ->
      cancel_timer(timer)
      GenServer.reply(from, {:error, :disconnected})
    end)

    Enum.each(Map.keys(state.namespaces), fn namespace ->
      disconnect_namespace_state(namespace, reason, false, state)
    end)

    :ok
  end

  defp process_engine_packets(packets, source, state) do
    Enum.reduce_while(packets, {:ok, state}, fn packet, {:ok, state} ->
      case process_engine_packet(packet, source, state) do
        {:ok, state} -> {:cont, {:ok, state}}
        other -> {:halt, other}
      end
    end)
  end

  defp process_engine_packet(%{type: :pong}, _source, state) do
    cancel_timer(state.pong_timer)
    timer = Process.send_after(self(), :heartbeat_ping, @ping_interval)
    {:ok, %{state | pong_timer: nil, heartbeat_timer: timer}}
  end

  defp process_engine_packet(%{type: :message, data: data}, _source, state),
    do: process_socket_packet(data, state)

  defp process_engine_packet(%{type: :close}, _source, state), do: {:close, :client_close, state}

  defp process_engine_packet(%{type: type}, _source, _state),
    do: {:error, {:unexpected_packet, type}}

  defp process_websocket_packet(%{type: :ping, data: "probe"}, pid, state) do
    if state.upgrade_socket == pid do
      state = state |> release_upgrade_poll() |> Map.put(:upgrade_probed, true)
      {:ok, [EngineIO.encode_packet(%{type: :pong, data: "probe"})], state}
    else
      {:error, :invalid_upgrade_probe}
    end
  end

  defp process_websocket_packet(%{type: :upgrade}, pid, state) do
    if state.upgrade_socket == pid do
      state = release_upgrade_poll(state)
      {queued, state} = drain_packets(%{state | active_transport: :websocket})

      {:ok, queued,
       %{
         state
         | websocket: pid,
           upgrade_socket: nil,
           upgrade_probed: false,
           poll_waiter: nil,
           poll_timer: nil
       }}
    else
      {:error, :invalid_upgrade}
    end
  end

  defp process_websocket_packet(packet, pid, state) do
    if state.websocket == pid do
      case process_engine_packet(packet, :websocket, state) do
        {:ok, state} -> {:ok, [], state}
        other -> other
      end
    else
      {:error, :transport_mismatch}
    end
  end

  defp process_socket_packet(raw, state) do
    case SocketIO.decode(raw) do
      {:ok, %{type: :connect} = packet} ->
        connect_namespace(packet, state)

      {:ok, %{type: :disconnect, namespace: namespace}} ->
        {:ok, disconnect_namespace_state(namespace, :client_disconnect, false, state)}

      {:ok, %{type: :event} = packet} ->
        handle_domain_event(packet, state)

      {:ok, %{type: :ack, id: id} = packet} ->
        handle_ack(id, Map.get(packet, :data, []), state)

      {:ok, %{type: type}} ->
        {:error, {:unexpected_socket_packet, type}}

      error ->
        error
    end
  end

  defp connect_namespace(%{namespace: namespace} = packet, state) do
    metadata = %{sid: state.sid, auth: Map.get(packet, :data, %{})}

    with true <- namespace in ["/vault", "/runs", "/runners"],
         {:ok, identity, state} <-
           authenticate_namespace(namespace, Map.get(packet, :data, %{}), state),
         {:ok, context} <- safe_authorize(state.domain, namespace, identity, metadata) do
      case Hub.join(state.sid, namespace, "user:#{identity.id}") do
        :ok ->
          namespaces =
            Map.put(state.namespaces, namespace, %{identity: identity, context: context})

          reply = %{
            type: :connect,
            namespace: namespace,
            data: %{sid: namespace_sid(state.sid, namespace)}
          }

          case enqueue(engine_message(reply), %{state | namespaces: namespaces}) do
            {:ok, state} ->
              safe_connected(state.domain, namespace, identity, context, metadata)
              {:ok, state}

            {:error, reason, state} ->
              {:close, reason, state}
          end

        {:error, _reason} ->
          connect_error(namespace, "Realtime room capacity reached", state)
      end
    else
      false -> connect_error(namespace, "Invalid namespace", state)
      {:error, message} -> connect_error(namespace, message, state)
      _ -> connect_error(namespace, "Namespace authorization failed", state)
    end
  end

  defp authenticate_namespace(namespace, namespace_auth, state) do
    token = Auth.resolved_token(namespace_auth, state.cookie_token)
    attempted? = MapSet.member?(state.auth_attempted_namespaces, namespace)

    cond do
      is_binary(state.authenticated_token) and token == state.authenticated_token and
        not attempted? and auth_cache_valid?(state) ->
        emit_auth_metric(:cache_hit)

        {:ok, state.authenticated_identity,
         %{
           state
           | auth_attempted_namespaces: MapSet.put(state.auth_attempted_namespaces, namespace)
         }}

      is_binary(state.authenticated_token) ->
        if token == state.authenticated_token do
          full_authenticate(namespace, token, state)
        else
          emit_auth_metric(:conflict)
          {:error, Auth.rejection_message(token)}
        end

      true ->
        full_authenticate(namespace, token, state)
    end
  end

  defp full_authenticate(namespace, token, state) do
    emit_auth_metric(:full)

    case Auth.authenticate_token_with_expiration(token) do
      {:ok, identity, expires_at} ->
        {:ok, identity,
         %{
           state
           | authenticated_token: state.authenticated_token || token,
             authenticated_identity: identity,
             authenticated_expires_at: expires_at,
             auth_cache_deadline_ms:
               System.monotonic_time(:millisecond) + state.auth_cache_wave_ms,
             auth_attempted_namespaces: MapSet.put(state.auth_attempted_namespaces, namespace)
         }}

      error ->
        error
    end
  end

  defp auth_cache_valid?(state) do
    is_integer(state.authenticated_expires_at) and
      System.system_time(:second) < state.authenticated_expires_at and
      is_integer(state.auth_cache_deadline_ms) and
      System.monotonic_time(:millisecond) <= state.auth_cache_deadline_ms
  end

  defp emit_auth_metric(outcome) do
    :telemetry.execute([:cascade, :realtime, :auth], %{count: 1}, %{outcome: outcome})
  end

  defp connect_error(namespace, message, state) do
    packet = %{type: :connect_error, namespace: namespace, data: %{message: message}}

    case enqueue(engine_message(packet), state) do
      {:ok, state} -> {:ok, state}
      {:error, reason, state} -> {:close, reason, state}
    end
  end

  defp handle_domain_event(%{namespace: namespace, data: [event | args]} = packet, state) do
    with %{identity: identity, context: context} <- state.namespaces[namespace],
         {:ok, actions} <-
           safe_domain_event(state.domain, namespace, event, args, identity, context),
         {:ok, state} <- apply_actions(actions, namespace, Map.get(packet, :id), identity, state) do
      {:ok, state}
    else
      nil -> maybe_error_ack(packet, "Namespace is not connected", state)
      {:error, message} -> maybe_error_ack(packet, message, state)
    end
  end

  defp handle_ack(id, data, state) do
    case Map.pop(state.pending_acks, id) do
      {nil, _} ->
        {:ok, state}

      {{from, timer}, pending} ->
        cancel_timer(timer)
        GenServer.reply(from, {:ok, data})
        {:ok, %{state | pending_acks: pending}}
    end
  end

  defp safe_domain_event(domain, namespace, event, args, identity, context) do
    domain.handle_event(namespace, event, args, identity, context)
  rescue
    _ -> {:error, "Realtime domain handler failed"}
  catch
    _, _ -> {:error, "Realtime domain handler failed"}
  end

  defp safe_authorize(domain, namespace, identity, metadata) do
    domain.authorize_namespace(namespace, identity, metadata)
  rescue
    _ -> {:error, "Namespace authorization failed"}
  catch
    _, _ -> {:error, "Namespace authorization failed"}
  end

  defp apply_actions(actions, namespace, ack_id, identity, state) when is_list(actions) do
    Enum.reduce_while(actions, {:ok, state}, fn action, {:ok, state} ->
      case apply_action(action, namespace, ack_id, identity, state) do
        {:ok, state} -> {:cont, {:ok, state}}
        error -> {:halt, error}
      end
    end)
  end

  defp apply_actions(_, _namespace, _ack_id, _identity, _state),
    do: {:error, "Invalid realtime domain result"}

  defp apply_action({:join, room}, namespace, _ack_id, _identity, state) do
    case Hub.join(state.sid, namespace, room) do
      :ok -> {:ok, state}
      {:error, _reason} -> {:error, "Realtime room capacity reached"}
    end
  end

  defp apply_action({:leave, room}, namespace, _ack_id, _identity, state) do
    :ok = Hub.leave(state.sid, namespace, room)
    {:ok, state}
  end

  defp apply_action({:emit, event, args}, namespace, _ack_id, _identity, state),
    do: enqueue_action(SocketIO.event(namespace, event, args), state)

  defp apply_action({:broadcast, room, event, args}, namespace, _ack_id, _identity, state) do
    Hub.broadcast(room, namespace, event, args)
    {:ok, state}
  end

  defp apply_action(
         {:refresh_chat_presence, source_vault_id, source_channel_id},
         _namespace,
         _ack_id,
         _identity,
         state
       ) do
    Cascade.Realtime.Events.emit_presence(source_vault_id, source_channel_id)
    {:ok, state}
  end

  defp apply_action({:ack, data}, namespace, ack_id, _identity, state) when is_integer(ack_id),
    do: enqueue_action(SocketIO.ack(namespace, ack_id, data), state)

  defp apply_action({:ack, _data}, _namespace, nil, _identity, state), do: {:ok, state}

  defp apply_action({:register_runner, metadata}, namespace, _ack_id, identity, state) do
    :ok = Hub.register_runner(identity.id, state.sid, namespace, metadata)
    {:ok, state}
  end

  defp apply_action(_action, _namespace, _ack_id, _identity, _state),
    do: {:error, "Invalid realtime domain action"}

  defp enqueue_action(packet, state) do
    case enqueue(engine_message(packet), state) do
      {:ok, state} -> {:ok, state}
      {:error, _reason, _state} -> {:error, "Realtime client is too slow"}
    end
  end

  defp maybe_error_ack(%{id: id, namespace: namespace}, message, state) do
    data = [%{success: false, error: message}]

    case enqueue(engine_message(SocketIO.ack(namespace, id, data)), state) do
      {:ok, state} -> {:ok, state}
      {:error, reason, state} -> {:close, reason, state}
    end
  end

  defp maybe_error_ack(_packet, _message, state), do: {:ok, state}

  defp disconnect_namespace_state(namespace, reason, notify_client, state) do
    case Map.pop(state.namespaces, namespace) do
      {nil, _} ->
        state

      {%{identity: identity, context: context}, namespaces} ->
        rooms = Hub.rooms_for_session(state.sid, namespace)
        Hub.leave_namespace(state.sid, namespace, reason)

        safe_disconnected(
          state.domain,
          namespace,
          identity,
          put_disconnect_rooms(context, rooms),
          reason
        )

        state = %{state | namespaces: namespaces}

        if notify_client do
          case enqueue(engine_message(%{type: :disconnect, namespace: namespace}), state) do
            {:ok, state} -> state
            {:error, _reason, state} -> state
          end
        else
          state
        end
    end
  end

  defp safe_connected(domain, namespace, identity, context, metadata) do
    if function_exported?(domain, :namespace_connected, 4),
      do: domain.namespace_connected(namespace, identity, context, metadata),
      else: :ok
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp safe_disconnected(domain, namespace, identity, context, reason) do
    domain.namespace_disconnected(namespace, identity, context, reason)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp put_disconnect_rooms(context, rooms) when is_map(context),
    do: Map.put(context, :rooms, rooms)

  defp put_disconnect_rooms(context, rooms), do: %{domain_context: context, rooms: rooms}

  defp enqueue(raw, state) do
    cond do
      state.websocket != nil and state.active_transport == :websocket ->
        case Process.info(state.websocket, :message_queue_len) do
          {:message_queue_len, length} when length >= state.max_mailbox ->
            {:error, :websocket_backpressure, state}

          nil ->
            {:error, :websocket_closed, state}

          _ ->
            send(state.websocket, {:socket_io_packets, [raw]})
            {:ok, state}
        end

      state.poll_waiter != nil ->
        cancel_timer(state.poll_timer)
        GenServer.reply(state.poll_waiter, {:ok, raw})
        {:ok, %{state | poll_waiter: nil, poll_timer: nil}}

      state.queue_packets + 1 > state.max_queue_packets or
          state.queue_bytes + byte_size(raw) > state.max_queue_bytes ->
        {:error, :outbound_backpressure, state}

      true ->
        {:ok,
         %{
           state
           | queue: :queue.in(raw, state.queue),
             queue_packets: state.queue_packets + 1,
             queue_bytes: state.queue_bytes + byte_size(raw)
         }}
    end
  end

  defp drain_queue(state) do
    {packets, state} = drain_packets(state)
    {packets |> Enum.intersperse(<<0x1E>>) |> IO.iodata_to_binary(), state}
  end

  defp drain_packets(state) do
    packets = :queue.to_list(state.queue)
    {packets, %{state | queue: :queue.new(), queue_packets: 0, queue_bytes: 0}}
  end

  defp release_upgrade_poll(%{poll_waiter: nil} = state), do: state

  defp release_upgrade_poll(state) do
    cancel_timer(state.poll_timer)
    GenServer.reply(state.poll_waiter, {:ok, EngineIO.encode_packet(%{type: :noop})})
    %{state | poll_waiter: nil, poll_timer: nil}
  end

  defp engine_message(packet),
    do: EngineIO.encode_packet(%{type: :message, data: SocketIO.encode(packet)})

  defp namespace_sid(sid, namespace), do: sid <> Base.url_encode64(namespace, padding: false)

  defp call(sid, request, timeout \\ 5_000) do
    case Registry.lookup(Cascade.Realtime.Registry, sid) do
      [{pid, _}] -> GenServer.call(pid, request, timeout)
      [] -> {:error, :unknown_sid}
    end
  catch
    :exit, _ -> {:error, :unknown_sid}
  end

  defp cast(sid, request) do
    case Registry.lookup(Cascade.Realtime.Registry, sid) do
      [{pid, _}] ->
        case Process.info(pid, :message_queue_len) do
          {:message_queue_len, length} when length >= @max_mailbox ->
            Process.exit(pid, :backpressure)

          _ ->
            GenServer.cast(pid, request)
        end

      [] ->
        :ok
    end
  end

  defp via(sid), do: {:via, Registry, {Cascade.Realtime.Registry, sid}}
  defp cancel_timer(nil), do: :ok
  defp cancel_timer(timer), do: Process.cancel_timer(timer)

  defp configured(key, default),
    do: Application.get_env(:cascade_elixir, Cascade.Realtime, [])[key] || default
end
