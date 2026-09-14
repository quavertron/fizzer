defmodule Cascade.Realtime.DomainAdapter do
  @moduledoc "Native run, runner, vault-room, and workspace Socket.IO domain adapter."
  @behaviour Cascade.Realtime.Domain

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Chat.Channel
  alias Cascade.Realtime.Events
  alias Cascade.Runs.{RunnerLifecycle, Store}

  @impl true
  def authorize_namespace(namespace, identity, metadata)
      when namespace in ["/vault", "/runs", "/runners"] do
    {:ok, %{identity: identity, sid: metadata.sid}}
  end

  def authorize_namespace(_namespace, _identity, _metadata), do: {:error, "Invalid namespace"}

  @impl true
  def handle_event("/runs", "joinRun", [raw_id], identity, _context) do
    with {:ok, run_id} <- positive_integer(raw_id),
         true <- run_access?(run_id, identity.id) do
      {:ok, [{:join, "run:#{run_id}"}]}
    else
      _ -> {:error, "Run not found"}
    end
  end

  def handle_event("/runs", "leaveRun", [raw_id], _identity, _context) do
    with {:ok, run_id} <- positive_integer(raw_id) do
      {:ok, [{:leave, "run:#{run_id}"}]}
    end
  end

  def handle_event("/vault", "joinVault", [vault_id], identity, _context)
      when is_binary(vault_id) do
    if VaultMembers.accessible_vault(vault_id, identity.id),
      do: {:ok, [{:join, "vault:#{vault_id}"}]},
      else: {:error, "Vault not found"}
  end

  def handle_event("/vault", "leaveVault", [vault_id], _identity, _context)
      when is_binary(vault_id),
      do: {:ok, [{:leave, "vault:#{vault_id}"}]}

  def handle_event("/vault", "joinChatChannel", [channel_id], identity, _context)
      when is_binary(channel_id) do
    case Events.initial_presence(channel_id, identity.id) do
      {:ok, payload, route} ->
        {:ok,
         [
           {:join, "chat:#{route.sourceChannelId}"},
           {:emit, "vault:chatPresence", [payload]},
           {:refresh_chat_presence, route.sourceVaultId, route.sourceChannelId}
         ]}

      _ ->
        {:error, "Chat channel not found"}
    end
  end

  def handle_event("/vault", "leaveChatChannel", [channel_id], identity, _context)
      when is_binary(channel_id) do
    case Channel.assert_channel(channel_id, identity.id) do
      {:ok, route} ->
        {:ok,
         [
           {:leave, "chat:#{route.sourceChannelId}"},
           {:refresh_chat_presence, route.sourceVaultId, route.sourceChannelId}
         ]}

      _ ->
        {:ok, [{:leave, "chat:#{channel_id}"}]}
    end
  end

  def handle_event("/runners", "runner:register", [metadata], identity, context)
      when is_map(metadata) do
    case RunnerLifecycle.register(identity.id, context.sid, metadata) do
      {:ok, reclaimed} ->
        {:ok,
         [
           {:register_runner, metadata},
           {:emit, "runner:registered", [%{ok: true, reclaimed: reclaimed}]}
         ]}

      _ ->
        {:error, "Desktop runner registration failed"}
    end
  end

  def handle_event("/runners", "runner:planUsage", [payload], identity, _context)
      when is_map(payload) do
    RunnerLifecycle.report_plan_usage(identity.id, field(payload, :usage) || %{})
    {:ok, []}
  end

  def handle_event("/runners", "runner:runEvent", [data], identity, _context)
      when is_map(data) do
    payload = field(data, :payload) || %{}

    with {:ok, run_id} <- positive_integer(field(data, :runId)),
         type when is_binary(type) and type != "" <- field(data, :type),
         true <-
           RunnerLifecycle.accept_event?(run_id, identity.id) or
             (terminal_event?(type, payload) and Store.owned?(run_id, identity.id)) do
      Store.acknowledge_delivery(run_id)

      cond do
        terminal_event?(type, payload) ->
          settle_runner_event(run_id, payload, identity.id)

        type == "heartbeat" ->
          Store.mark_running(run_id)
          RunnerLifecycle.heartbeat(run_id, identity.id)

        true ->
          persist_runner_event(run_id, type, payload, identity.id)
      end

      {:ok, if(field(data, :receipt) == true, do: [{:ack, [%{success: true}]}], else: [])}
    else
      _ -> {:error, "Run event rejected"}
    end
  end

  def handle_event(_namespace, _event, _args, _identity, _context),
    do: {:error, "Unsupported realtime event"}

  @impl true
  def namespace_connected("/vault", identity, _context, _metadata),
    do: Events.refresh_user_presence_now(identity.id)

  def namespace_connected(_namespace, _identity, _context, _metadata), do: :ok

  @impl true
  def namespace_disconnected("/vault", identity, context, _reason),
    do: Events.namespace_disconnected(identity.id, Map.get(context, :rooms, []))

  def namespace_disconnected(_namespace, _identity, _context, _reason), do: :ok

  defp persist_runner_event(run_id, "session", payload, _owner_id) when is_map(payload) do
    Store.persist_session(run_id, field(payload, :sessionId))
    Store.publish(run_id, "session", payload)
  end

  defp persist_runner_event(run_id, "status", %{"status" => "running"}, _owner_id),
    do: Store.mark_running(run_id)

  defp persist_runner_event(run_id, "status", %{status: "running"}, _owner_id),
    do: Store.mark_running(run_id)

  defp persist_runner_event(run_id, "status", payload, owner_id) when is_map(payload) do
    status = field(payload, :status)

    if status in ["completed", "failed", "canceled"] do
      summary =
        case field(payload, :summary) do
          value when is_binary(value) and value != "" -> value
          _ when status == "completed" -> "Done."
          _ when status == "canceled" -> "Run canceled by user."
          _ -> "Agent failed."
        end

      Store.finish(run_id, status, summary, field(payload, :sessionId))
      maybe_record_runner_error(owner_id, status, field(payload, :summary))
    end

    Store.publish(run_id, "status", payload)
    maybe_account_work_item(run_id, status)
  end

  defp persist_runner_event(run_id, type, payload, _owner_id),
    do: Store.publish(run_id, type, payload)

  defp terminal_event?("status", payload) when is_map(payload),
    do: field(payload, :status) in ~w(completed failed canceled)

  defp terminal_event?(_, _), do: false

  defp settle_runner_event(run_id, payload, owner_id) do
    Cascade.Realtime.OrderedPublisher.mutate(fn ->
      Cascade.Accounts.SQL.transaction(fn ->
        run = Store.get(run_id)

        if Store.terminal?(run.status) do
          # A lost ACK must not duplicate settlement or overwrite a prior Stop.
          # Also repair the old finish-before-publish crash boundary.
          if is_nil(
               Cascade.Accounts.SQL.one(
                 "SELECT 1 FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload_json,'$.status') IN ('completed','failed','canceled') LIMIT 1",
                 [run_id]
               )
             ) do
            persist_runner_event(
              run_id,
              "status",
              %{status: run.status, summary: run.summary, sessionId: run.session_id},
              owner_id
            )
          end
        else
          persist_runner_event(run_id, "status", payload, owner_id)
        end
      end)
    end)
  end

  defp maybe_record_runner_error(_owner_id, _status, _summary), do: :ok

  defp maybe_account_work_item(run_id, status)
       when status in ["completed", "failed", "canceled"] do
    if Code.ensure_loaded?(Cascade.WorkItems) do
      Cascade.WorkItems.account_terminal_run(run_id)
    end
  rescue
    _ -> :ok
  end

  defp maybe_account_work_item(_run_id, _status), do: :ok

  defp run_access?(run_id, user_id) do
    Store.owned?(run_id, user_id)
  end

  defp positive_integer(value) when is_integer(value) and value > 0, do: {:ok, value}

  defp positive_integer(value) when is_float(value) and value > 0 and trunc(value) == value,
    do: {:ok, trunc(value)}

  defp positive_integer(_), do: {:error, :invalid_id}
  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
end
