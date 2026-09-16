defmodule Cascade.DB.Migrations.V2NoteRevisionCounter do
  @moduledoc false

  use Cascade.DB.Migration

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  @impl true
  def version, do: 2

  @impl true
  def name, do: "note_revision_counter"

  @impl true
  def checksum_material, do: {:v2, :note_revision_counter, statements()}

  @impl true
  def statements, do: []

  @impl true
  def after_up do
    ensure_column("notes", "revision_counter", "INTEGER NOT NULL DEFAULT 1")
    :ok
  end

  defp ensure_column(table, column, definition) do
    columns = SQL.query!(Repo, "PRAGMA table_info(#{table})", []).rows

    unless Enum.any?(columns, fn [_cid, name | _rest] -> name == column end) do
      SQL.query!(Repo, "ALTER TABLE #{table} ADD COLUMN #{column} #{definition}", [])
      :added
    else
      :present
    end
  end
end
