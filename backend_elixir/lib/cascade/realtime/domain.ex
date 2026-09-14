defmodule Cascade.Realtime.Domain do
  @moduledoc """
  Boundary between the wire-compatible realtime transport and Cascade domain logic.

  Implementations must authorize every namespace and persist/authorize domain events before
  returning transport actions. The realtime edge deliberately has no built-in successful
  implementation for vault, run, or runner mutations.
  """

  @type namespace :: String.t()
  @type identity :: %{required(:id) => integer(), required(:username) => binary()}
  @type action ::
          {:join, binary()}
          | {:leave, binary()}
          | {:emit, binary(), list()}
          | {:broadcast, binary(), binary(), list()}
          | {:refresh_chat_presence, binary(), binary()}
          | {:ack, term()}
          | {:register_runner, term()}

  @callback authorize_namespace(namespace(), identity(), map()) ::
              {:ok, term()} | {:error, binary()}
  @callback handle_event(namespace(), binary(), list(), identity(), term()) ::
              {:ok, [action()]} | {:error, binary()}
  @callback namespace_connected(namespace(), identity(), term(), map()) :: any()
  @callback namespace_disconnected(namespace(), identity(), term(), term()) :: any()

  @optional_callbacks namespace_connected: 4
end

defmodule Cascade.Realtime.Domain.FailClosed do
  @moduledoc "Default domain adapter: authenticated sockets may connect, but actions fail closed."
  @behaviour Cascade.Realtime.Domain

  @impl true
  def authorize_namespace(namespace, _identity, _metadata)
      when namespace in ["/vault", "/runs", "/runners"],
      do: {:ok, %{}}

  def authorize_namespace(_namespace, _identity, _metadata), do: {:error, "Invalid namespace"}

  @impl true
  def handle_event(_namespace, _event, _args, _identity, _context),
    do: {:error, "Realtime domain handler is unavailable"}

  @impl true
  def namespace_disconnected(_namespace, _identity, _context, _reason), do: :ok
end
