defmodule Cascade.Missions.PendingSteering do
  @moduledoc "Durable pending steering requests and their disposition, independent of delivery."
  alias Cascade.Accounts.SQL

  @pending """
  SELECT e.id,e.task_id,e.run_id,e.attempt,e.summary,e.mission_id
  FROM chat_mission_events e
  WHERE e.kind='steering_requested' AND NOT EXISTS
    (SELECT 1 FROM chat_mission_events result WHERE result.source_key='steering-result:' || e.id)
  """

  def all(filter, params), do: SQL.all(@pending <> filter, params)
  def get(id), do: SQL.one(@pending <> " AND e.id=?", [id])
  def pending_for_task?(id), do: SQL.one(@pending <> " AND e.task_id=?", [id]) != nil

  def cancel_pending(run_id) do
    all(" AND e.run_id=?", [run_id])
    |> Enum.each(&reject(&1, "Worker stopped; queued steering was canceled"))
  end

  def reject([id, task, run, attempt, _, mission], reason) do
    SQL.exec(
      "INSERT OR IGNORE INTO chat_mission_events (mission_id,task_id,run_id,attempt,kind,source_key,summary) VALUES (?,?,?,?,?,?,?)",
      [mission, task, run, attempt, "steering_rejected", "steering-result:#{id}", reason]
    )
  end

  def interrupting?(run_id) do
    SQL.one(
      @pending <>
        " AND e.run_id=? AND EXISTS (SELECT 1 FROM chat_mission_events i WHERE i.source_key='steering-interrupt:' || e.id)",
      [run_id]
    ) != nil
  end
end
