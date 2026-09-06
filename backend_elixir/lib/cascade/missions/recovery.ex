defmodule Cascade.Missions.Recovery do
  @moduledoc "Reconciles missed worker settlement and cancellation through the existing scheduler."
  alias Cascade.Accounts.SQL

  # The scheduler holds the publisher lock and database transaction.
  def reconcile(mission_id) do
    filter = if mission_id, do: " AND m.id=?", else: ""

    SQL.all(
      """
      SELECT t.dispatch_id,r.id,r.status,COALESCE(r.summary,'')
      FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
      JOIN chat_agent_dispatches d ON d.id=t.dispatch_id
      JOIN runs r ON r.chat_dispatch_id=d.id AND r.id=COALESCE(t.run_id,d.run_id)
      WHERE m.status NOT IN ('completed','canceled') AND t.status IN ('pending','running')
        AND r.status IN ('completed','failed','canceled') #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [dispatch_id, run_id, status, summary] ->
      {:ok, _} = Cascade.Missions.Store.attach_run(dispatch_id, run_id)
      {:ok, _} = Cascade.Missions.Store.settle_run(run_id, status, summary)
    end)
  end

  # Retry provider cancellation after crashes/disconnects, outside SQL locks.
  def replay_cancellations(cancel \\ &cancel_run/2, mission_id \\ nil) do
    filter = if mission_id, do: " AND m.id=?", else: ""

    SQL.all(
      """
      SELECT r.id,m.created_by FROM chat_mission_tasks t
      JOIN chat_missions m ON m.id=t.mission_id JOIN runs r ON r.id=t.run_id
      WHERE t.status='canceled' AND r.status IN ('queued','running') #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [run, user] ->
      if cancel.(user, run) do
        Cascade.Runs.Store.finish(run, "canceled", "Mission task canceled.")

        Cascade.Runs.Store.publish(run, "status", %{
          status: "canceled",
          summary: "Mission task canceled."
        })
      end
    end)
  end

  defp cancel_run(user, run), do: Cascade.Runs.RunnerLifecycle.cancel(user, run, 2_000)
end
