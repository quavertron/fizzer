defmodule CascadeWeb.MissionRouter do
  @moduledoc "Mountable native HTTP surface for missions, task scheduling, and pending dispatches."

  use CascadeWeb.DomainDispatch
  import Plug.Conn

  alias Cascade.Chat.Events
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias CascadeWeb.{Auth, JSON}

  plug :put_domain_options
  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  get "/api/vaults/:vault_id/channels/:channel_id/agent-dispatches/pending" do
    authenticated(conn, nil, fn conn, user ->
      case Dispatches.list_pending(user.id, channel_id) do
        {:ok, dispatches} -> JSON.send(conn, 200, %{dispatches: dispatches})
        _ -> JSON.send(conn, 404, %{error: "Chat channel not found"})
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        rootMessageId: string_body(conn, "rootMessageId"),
        coordinatorRegistrationId: string_body(conn, "coordinatorRegistrationId"),
        title: string_body(conn, "title"),
        objective: string_body(conn, "objective"),
        authorityMessageIds: body(conn, "authorityMessageIds", []),
        reviewRequested: js_truthy?(body(conn, "reviewRequested", false)),
        controlPlane: js_truthy?(body(conn, "controlPlane", false))
      }

      opts =
        [
          agent: conn.assigns.auth_access == "agent",
          control_plane: input.controlPlane
        ] ++
          case run_id(conn) do
            nil -> []
            id -> [current_run_id: id]
          end

      case Store.create(user.id, vault_id, channel_id, input, opts) do
        {:ok, update} ->
          Scheduler.emit_projection(update, callback(conn, :events))
          JSON.send(conn, 201, %{mission: update.mission})

        error ->
          route_error(conn, 400, error, "Could not create mission")
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/missions" do
    authenticated(conn, nil, fn conn, user ->
      current = current_run_mission(conn, user, channel_id)

      result =
        if query(conn, "view") == "compact" do
          Store.list_compact(user.id, channel_id,
            coordinator: if(current, do: nil, else: query(conn, "coordinator")),
            mission_id: current,
            status: query(conn, "status"),
            task_status: query(conn, "taskStatus")
          )
        else
          case current do
            nil ->
              Store.list(user.id, channel_id, query(conn, "coordinator"))

            id ->
              with {:ok, update} <- Store.get(user.id, channel_id, id),
                   do: {:ok, [update.mission]}
          end
        end

      case result do
        {:ok, missions} ->
          JSON.send(conn, 200, %{missions: missions})

        {:error, :invalid_list_status} ->
          JSON.send(conn, 400, %{error: "Invalid mission or task status filter"})

        error ->
          route_error(conn, 404, error, "Missions not found")
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/history" do
    authenticated(conn, nil, fn conn, user ->
      case Store.events(user.id, channel_id, mission_id) do
        {:ok, events} -> JSON.send(conn, 200, %{events: events})
        error -> route_error(conn, 404, error, "Mission history not found")
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id" do
    authenticated(conn, nil, fn conn, user ->
      mission_ref =
        if mission_id == "current",
          do: current_run_mission(conn, user, channel_id) || mission_id,
          else: mission_id

      case Store.get(user.id, channel_id, mission_ref, query(conn, "coordinator")) do
        {:ok, update} -> JSON.send(conn, 200, %{mission: update.mission})
        error -> route_error(conn, 404, error, "Mission not found")
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/continuation" do
    authenticated(conn, nil, fn conn, user ->
      case Cascade.Chat.Continuations.get(user.id, channel_id, run_id(conn)) do
        {:ok, result} -> JSON.send(conn, 200, result)
        error -> route_error(conn, 404, error, "Continuation not found")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/continuation" do
    authenticated(conn, :vault, fn conn, user ->
      case Cascade.Chat.Continuations.record(user.id, channel_id, run_id(conn), conn.body_params) do
        {:ok, result} ->
          Cascade.Missions.DispatchReannouncer.wake()
          JSON.send(conn, 200, result)

        error ->
          route_error(conn, 409, error, "Could not record continuation")
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/interpretation" do
    authenticated(conn, nil, fn conn, user ->
      case Cascade.Missions.Interpretation.get(
             user.id,
             channel_id,
             mission_id,
             query(conn, "coordinator")
           ) do
        {:ok, result} -> JSON.send(conn, 200, result)
        error -> route_error(conn, 404, error, "Interpretation not found")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/interpretation" do
    authenticated(conn, :vault, fn conn, user ->
      case Cascade.Missions.Interpretation.record(
             user,
             channel_id,
             mission_id,
             string_body(conn, "coordinatorRegistrationId"),
             conn.body_params,
             run_id(conn),
             callback(conn, :events)
           ) do
        {:ok, result} ->
          Cascade.Missions.DispatchReannouncer.wake()
          JSON.send(conn, 200, result)

        error ->
          route_error(conn, 409, error, "Could not record interpretation")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/tasks" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        coordinatorRegistrationId: string_body(conn, "coordinatorRegistrationId"),
        title: string_body(conn, "title"),
        assignee: string_body(conn, "assignee"),
        prompt: string_body(conn, "prompt"),
        dependsOn: string_list(body(conn, "dependsOn", [])),
        priority: numeric_body(conn, "priority"),
        reasoningEffort: string_body(conn, "reasoningEffort"),
        anonymous: js_truthy?(body(conn, "anonymous", false)),
        workspaceMode: string_body(conn, "workspaceMode", "shared")
      }

      task_opts = if run_id(conn), do: [current_run_id: run_id(conn)], else: []

      with {:ok, added} <- Store.add_task(user.id, channel_id, mission_id, input, task_opts),
           {:ok, scheduled} <- safe_schedule(added.update.mission.id, conn),
           {:ok, latest} <- Store.get(user.id, channel_id, added.update.mission.id) do
        dispatched =
          Enum.find(scheduled.dispatches, &(&1.message[:missionTaskId] == added.task.id))

        response = %{
          mission: latest.mission,
          task: Enum.find(latest.mission.tasks, &(&1.id == added.task.id)),
          scheduled: not is_nil(dispatched)
        }

        response =
          if dispatched, do: Map.put(response, :message, dispatched.message), else: response

        JSON.send(conn, 201, response)
      else
        error -> route_error(conn, 400, error, "Could not delegate mission task")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/children" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        title: string_body(conn, "title"),
        prompt: string_body(conn, "prompt"),
        reasoningEffort: string_body(conn, "reasoningEffort")
      }

      with {:ok, added} <-
             Cascade.Missions.Children.add(user.id, channel_id, mission_id, input, run_id(conn)),
           {:ok, _} <- safe_schedule(added.update.mission.id, conn),
           {:ok, latest} <- Store.get(user.id, channel_id, added.update.mission.id) do
        JSON.send(conn, 201, %{
          mission: latest.mission,
          task: Enum.find(latest.mission.tasks, &(&1.id == added.task.id))
        })
      else
        error -> route_error(conn, 400, error, "Could not create child task")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/children/join" do
    authenticated(conn, :vault, fn conn, user ->
      case Cascade.Missions.Children.join(user.id, channel_id, run_id(conn)) do
        {:ok, result} -> JSON.send(conn, 200, result)
        error -> route_error(conn, 400, error, "Could not join children")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id/steer" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        coordinatorRegistrationId: string_body(conn, "coordinatorRegistrationId"),
        message: string_body(conn, "message"),
        attempt: body(conn, "attempt", nil),
        runId: body(conn, "runId", nil)
      }

      opts = if run_id(conn), do: [current_run_id: run_id(conn)], else: []

      case Store.request_steering(user.id, channel_id, task_id, input, opts) do
        {:ok, id} ->
          result = Cascade.Missions.Steering.deliver(id)
          JSON.send(conn, 202, %{steering: result})

        error ->
          route_error(conn, 409, error, "Could not steer mission task")
      end
    end)
  end

  patch "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        status: string_body(conn, "status"),
        summary: string_body(conn, "summary"),
        finding: conn.body_params["finding"] == true
      }

      with :ok <-
             Cascade.Missions.Children.authorize_update(
               user.id,
               channel_id,
               task_id,
               run_id(conn)
             ),
           {:ok, update} <- Store.update_task(user.id, channel_id, task_id, input),
           :ok <- cancel_runs(conn, Map.get(update, :canceledTaskRunIds, []), []),
           {:ok, _scheduled} <- safe_schedule(update.mission.id, conn),
           {:ok, latest} <- Store.get(user.id, channel_id, update.mission.id) do
        JSON.send(conn, 200, %{mission: latest.mission})
      else
        error -> route_error(conn, 400, error, "Could not update mission task")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id/recovery-evidence" do
    authenticated(conn, :vault, fn conn, user ->
      input = %{
        coordinatorRegistrationId: string_body(conn, "coordinatorRegistrationId"),
        sourceTaskId: string_body(conn, "sourceTaskId"),
        sourceRunId: numeric_body(conn, "sourceRunId"),
        targetRunId: body(conn, "targetRunId", nil),
        targetAttempt: numeric_body(conn, "targetAttempt"),
        objective: string_body(conn, "objective"),
        verification: string_body(conn, "verification")
      }

      opts = if run_id(conn), do: [current_run_id: run_id(conn)], else: []

      with {:ok, update} <- Store.link_recovery(user.id, channel_id, task_id, input, opts),
           {:ok, _} <- safe_schedule(update.mission.id, conn) do
        Scheduler.emit_projection(update, callback(conn, :events))
        JSON.send(conn, 200, %{mission: update.mission})
      else
        error -> route_error(conn, 400, error, "Could not link recovery evidence")
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/finish" do
    authenticated(conn, :vault, fn conn, user ->
      status =
        if string_body(conn, "status", "completed") == "canceled",
          do: "canceled",
          else: "completed"

      input = %{
        coordinatorRegistrationId: string_body(conn, "coordinatorRegistrationId"),
        status: status,
        summary: string_body(conn, "summary"),
        verification: string_body(conn, "verification")
      }

      opts = if run_id(conn), do: [current_run_id: run_id(conn)], else: []

      case Store.finish(user.id, channel_id, mission_id, input, opts) do
        {:ok, update} ->
          if status == "canceled" do
            canceled_run_ids =
              update.mission.tasks
              |> Enum.filter(&(&1.status == "canceled" and not is_nil(&1[:runId])))
              |> Enum.map(& &1.runId)

            cancel_runs(conn, canceled_run_ids, force: true)
          end

          Scheduler.emit_projection(update, callback(conn, :events))

          Enum.each(Map.get(update, :removedWakeMessageIds, []), fn message_id ->
            Events.emit(callback(conn, :events), %{
              event: "vault:chatMessageDeleted",
              vaultId: update.vaultId,
              channelId: update.channelId,
              messageId: message_id
            })
          end)

          cancel_runs(conn, Map.get(update, :canceledWakeRunIds, []),
            force: true,
            summary: "Mission review wake closed automatically.",
            suppress_chat_body: true
          )

          JSON.send(conn, 200, %{mission: update.mission})

        error ->
          route_error(conn, 400, error, "Could not finish mission")
      end
    end)
  end

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end

  defp authenticated(conn, gate, fun) do
    options =
      [access: :any] ++
        if(gate == :vault,
          do: [mutation_gate: &Cascade.Accounts.VaultMembers.mutation_gate/2],
          else: []
        )

    case Auth.require(conn, options) do
      {:ok, authorized} -> fun.(authorized, authorized.assigns.current_user)
      {:error, rejected} -> rejected
    end
  end

  defp safe_schedule(mission_id, conn) do
    scheduled = Scheduler.schedule(mission_id, events: callback(conn, :events))

    Cascade.Missions.DispatchReannouncer.wake()

    {:ok, scheduled}
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp cancel_runs(conn, run_ids, opts) do
    callback = callback(conn, :cancel_run) || (&Cascade.Runs.Store.cancel/2)

    Enum.each(run_ids, fn id ->
      cond do
        is_function(callback, 2) -> callback.(id, opts)
        is_function(callback, 1) -> callback.(id)
        true -> Cascade.Runs.Store.cancel(id, opts)
      end
    end)

    :ok
  end

  defp route_error(conn, status, {:error, message}, fallback),
    do: JSON.send(conn, status, %{error: if(is_binary(message), do: message, else: fallback)})

  defp route_error(conn, status, _error, fallback),
    do: JSON.send(conn, status, %{error: fallback})

  defp callback(conn, :events),
    do: Keyword.get(conn.assigns.domain_options, :events) || Cascade.Chat.Events.Noop

  defp callback(conn, key), do: Keyword.get(conn.assigns.domain_options, key)

  defp put_domain_options(%{assigns: %{domain_options: _}} = conn, _compiled), do: conn
  defp put_domain_options(conn, options), do: assign(conn, :domain_options, options)
  defp body(conn, key, default), do: Map.get(conn.body_params, key, default)

  defp string_body(conn, key, default \\ "") do
    conn |> body(key, default) |> to_string()
  end

  defp numeric_body(conn, key) do
    case body(conn, key, 0) do
      value when is_number(value) ->
        value

      value ->
        case Float.parse(to_string(value)) do
          {number, _} -> number
          _ -> 0
        end
    end
  end

  defp string_list(value) when is_list(value), do: Enum.map(value, &to_string/1)
  defp string_list(_), do: []
  defp js_truthy?(value) when value in [nil, false, 0, 0.0, ""], do: false
  defp js_truthy?(_value), do: true

  defp query(conn, key) do
    conn = fetch_query_params(conn)
    Map.get(conn.query_params, key)
  end

  defp current_run_mission(conn, user, channel_id) do
    with {:ok, route} <- Cascade.Chat.Channel.assert_channel(channel_id, user.id),
         [id] <-
           Cascade.Accounts.SQL.one(
             """
             SELECT m.id FROM chat_mission_tasks t
             JOIN chat_missions m ON m.id=t.mission_id
             JOIN runs r ON r.id=t.run_id
             WHERE t.run_id=? AND r.owner_user_id=? AND m.created_by=? AND m.channel_id=?
             LIMIT 1
             """,
             [run_id(conn), user.id, user.id, route.sourceChannelId]
           ) do
      id
    else
      _ -> nil
    end
  end

  defp run_id(conn) do
    case get_req_header(conn, "x-cascade-run-id") do
      [value | _] ->
        case Integer.parse(value) do
          {id, ""} when id > 0 -> id
          _ -> nil
        end

      _ ->
        nil
    end
  end
end
