defmodule Cascade.Missions.WorkAvailable do
  @moduledoc "Notification boundary between durable mission changes and their execution worker."

  def notify do
    notify = Application.fetch_env!(:cascade_elixir, :mission_work_available)
    notify.()
  end
end
