defmodule Cascade.DB.Migrations.V3ProfileColors do
  @moduledoc false
  use Cascade.DB.Migration

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  def version, do: 3
  def name, do: "profile_colors"
  def statements, do: []
  def checksum_material, do: {:v3, :profile_colors, ~w(users chat_agent_members vault_agents), "TEXT NOT NULL DEFAULT 'FFFFFF'"}

  def after_up do
    for table <- ~w(users chat_agent_members vault_agents) do
      columns = SQL.query!(Repo, "PRAGMA table_info(#{table})", []).rows

      # Chat tables are created by domain bootstrap on a fresh installation.
      # Existing installations are upgraded here without replacing any rows.
      if columns != [] && !Enum.any?(columns, fn [_cid, name | _] -> name == "color" end) do
        SQL.query!(Repo, "ALTER TABLE #{table} ADD COLUMN color TEXT NOT NULL DEFAULT 'FFFFFF'", [])
      end
    end

    :ok
  end
end
