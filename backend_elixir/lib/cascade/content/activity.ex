defmodule Cascade.Content.Activity do
  @moduledoc "Coordinates durable note activity, wiki maintenance, and realtime notification."

  alias Cascade.Accounts.{CommunityActivity, SQL}
  alias Cascade.Realtime.Events
  alias Cascade.WikiMaintenance

  def install do
    Application.put_env(:cascade_elixir, :note_mutation_sink, &note_mutation/4)
  end

  def note_mutation(note_id, actor_user_id, kind),
    do: note_mutation(note_id, actor_user_id, kind, nil)

  def note_mutation(note_id, actor_user_id, _kind, content_change)
      when is_binary(note_id) and is_integer(actor_user_id) do
    CommunityActivity.record_note_change(
      note_id,
      actor_user_id,
      DateTime.utc_now() |> DateTime.to_iso8601(),
      content_change
    )

    WikiMaintenance.note_changed(note_id)

    case SQL.one("SELECT vault_id FROM notes WHERE id=?", [note_id]) do
      [vault_id] -> Events.community_changed_for_vault(vault_id)
      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  def note_mutation(_note_id, _actor_user_id, _kind, _content_change), do: :ok
end
