defmodule Cascade.Missions.RepositoryBinding do
  @moduledoc "SELECT-only repository recovery preview and atomic exact-chain binding."
  alias Cascade.Accounts.SQL
  alias Cascade.Missions.ExecutionAdmission
  alias Cascade.WorkItems

  def preview(owner, id) do
    with {:ok, item} <- WorkItems.get(owner, id, true),
         true <- item.createdBy == owner and item.sourceKind == "mission" and
           item.workspaceMode == "isolated" and item.status == "open" and
           item.runIds == [] and item.leaseHolder in [nil, ""] and
           item.repository in [nil, ""] and item.worktreePath in [nil, ""] and item.baseCommit in [nil, ""],
         %{"ownerId" => ^owner, "workItemId" => ^id} = binding <- ExecutionAdmission.task_binding(item.sourceId),
         ["pending", nil] <- SQL.one("SELECT status,run_id FROM chat_mission_tasks WHERE id=?", [item.sourceId]),
         true <- ExecutionAdmission.task_allowed?(item.sourceId),
         {:ok, %{yolo: false} = execution} <- Cascade.Chat.RegistrationSettings.execution(owner, item.vaultId, item.channelId, item.assigneeRegistrationId),
         false <- has_run?(id, binding["dispatchId"]) do
      state = %{item: item, binding: binding, execution: execution}
      revision = :crypto.hash(:sha256, :erlang.term_to_binary(state)) |> Base.encode16(case: :lower)
      {:ok, Map.merge(state, %{contract: "repository_binding_atomic_v1", revision: revision})}
    else
      _ -> {:error, "Repository binding precondition changed or is not authorized"}
    end
  end

  def bind(owner, id, input) do
    with true <- is_map(input) and Enum.sort(Map.keys(input)) == ["expectedRevision", "repository"],
         path when is_binary(path) <- input["repository"],
         true <- String.length(path) in 1..500 and Path.type(path) == :absolute and
           Path.expand(path) == path and not String.contains?(path, <<0>>) do
      SQL.transaction(fn ->
        with {:ok, before} <- preview(owner, id),
             true <- before.revision == input["expectedRevision"] do
          SQL.exec("UPDATE work_items SET repository=?,updated_at=datetime('now') WHERE id=?", [path, id])
          WorkItems.get(owner, id)
        else
          _ -> {:error, "Repository binding revision conflict"}
        end
      end, mode: :immediate)
    else
      _ -> {:error, "Invalid repository binding"}
    end
  end

  defp has_run?(id, dispatch) do
    SQL.one("SELECT 1 FROM work_item_runs WHERE work_item_id=? LIMIT 1", [id]) != nil or
      (not is_nil(dispatch) and SQL.one("SELECT 1 FROM runs WHERE chat_dispatch_id=? LIMIT 1", [dispatch]) != nil)
  end
end
