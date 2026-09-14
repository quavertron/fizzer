defmodule Cascade.DomainBootstrap do
  @moduledoc "Runs idempotent domain schema compatibility checks before the network edge starts."

  use GenServer

  def start_link(_options), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    :ok = Cascade.Accounts.Schema.ensure!()
    :ok = Cascade.Runs.Schema.ensure!()
    :ok = Cascade.Chat.Schema.ensure!()
    :ok = Cascade.Missions.Schema.ensure!()
    :ok = Cascade.Publishing.ensure_schema()
    :ok = Cascade.Evolution.ensure_schema()
    :ok = Cascade.Scratchpad.ensure_schema()
    :ok = Cascade.WikiMaintenance.ensure_schema()
    :ok = Cascade.Realtime.Events.install_note_mutation_sink()
    {:ok, %{bootstrapped_at: DateTime.utc_now()}}
  end
end
