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
    # Linked-note awareness participates in the content transaction. Missing
    # wiring must fail the edit instead of losing a mission revision silently.
    :ok = Application.put_env(:cascade_elixir, :linked_note_revision_observer, &Cascade.Missions.Store.note_changed/4)
    :ok = Application.put_env(:cascade_elixir, :agent_suggestions_observer, &Cascade.Chat.NextSteps.settings_changed/4)
    :ok = Application.put_env(:cascade_elixir, :chat_message_preparer, &Cascade.Chat.NextSteps.prepare/2)
    :ok = Application.put_env(:cascade_elixir, :mission_work_available, &Cascade.Missions.DispatchReannouncer.wake/0)
    :ok = Application.put_env(:cascade_elixir, :run_chat_projector, &Cascade.Runs.ChatProjection.sync/1)
    :ok = Cascade.Content.Activity.install()
    {:ok, %{bootstrapped_at: DateTime.utc_now()}}
  end
end
