defmodule CascadeWeb.OrchestrationController do
  @moduledoc false

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Auth.Session
  alias Cascade.Chat.Messages
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.ManagedAgents
  alias Cascade.Missions.Dispatches
  alias Cascade.Runs.{PromptContext, RunnerLifecycle, Store}
  alias Cascade.WorkItems
  alias CascadeWeb.JSON

  # Preserve callers while the execution boundary lives in the mission domain.
  defdelegate prepare_dispatch(dispatch_id), to: Cascade.Missions.Execution
  defdelegate execute_dispatch(dispatch_id), to: Cascade.Missions.Execution

  def list_runs(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{runs: Store.list(vault_id, user.id)})
      end)
    end)
  end

  def active_sessions(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{sessions: Store.active_sessions(user.id, vault_id)})
      end)
    end)
  end

  def my_active_sessions(conn) do
    authenticated(conn, fn conn, user ->
      JSON.send(conn, 200, %{sessions: Store.active_sessions(user.id)})
    end)
  end

  def cancel_all_runs(conn) do
    authenticated(conn, fn conn, user ->
      JSON.send(conn, 200, Cascade.Runs.Cancellation.cancel_all(user.id))
    end)
  end

  def local_agents(conn) do
    authenticated(conn, fn conn, _user ->
      # The production release does not share a host filesystem with desktop
      # Claude/Codex sessions. Match the Node route's documented cloud fallback
      # instead of leaking the request through the parity boundary.
      JSON.send(conn, 200, %{
        nodes: [],
        edges: [],
        scannedAt: System.system_time(:millisecond)
      })
    end)
  end

  def create_run(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      case VaultMembers.accessible_vault(vault_id, user.id) do
        nil -> JSON.send(conn, 404, %{error: "Vault not found"})
        vault -> create_direct_run(conn, user, vault)
      end
    end)
  end

  def get_run(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      with_run_access(conn, raw_id, user.id, fn run -> JSON.send(conn, 200, %{run: run}) end)
    end)
  end

  def run_events(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      with_run_access(conn, raw_id, user.id, fn run ->
        JSON.send(conn, 200, %{events: Store.events(run.id)})
      end)
    end)
  end

  def runner_status(conn) do
    authenticated(conn, fn conn, user -> JSON.send(conn, 200, RunnerLifecycle.health(user.id)) end)
  end

  def cancel_run(conn, raw_id) do
    authenticated(conn, fn conn, user ->
      case parse_id(raw_id) |> then(&if(&1, do: Store.get(&1), else: nil)) do
        nil ->
          JSON.send(conn, 404, %{error: "Run not found"})

        run ->
          if Store.owned?(run.id, user.id) do
            success =
              Store.cancel(run.id,
                steering: body(conn)["steering"] == true,
                force: body(conn)["steering"] != true
              )

            JSON.send(conn, 200, %{success: success})
          else
            JSON.send(conn, 404, %{error: "Run not found"})
          end
      end
    end)
  end

  def managed_entitlement(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{
          entitlement: ManagedAgents.entitlement(vault_id),
          admin: VaultMembers.role(vault_id, user.id) == "owner",
          operator: ManagedAgents.operator_status(vault_id)
        })
      end)
    end)
  end

  def update_managed_entitlement(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      cond do
        is_nil(VaultMembers.accessible_vault(vault_id, user.id)) ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        VaultMembers.role(vault_id, user.id) != "owner" ->
          JSON.send(conn, 403, %{error: "Only the vault owner can manage managed-agent budgets"})

        true ->
          JSON.send(conn, 200, %{entitlement: ManagedAgents.set_entitlement(vault_id, body(conn))})
      end
    end)
  end

  def list_work_items(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      opts =
        []
        |> maybe_option(:channel_id, conn.query_params["channelId"])
        |> maybe_option(:status, conn.query_params["status"])

      respond(conn, WorkItems.list(user.id, vault_id, opts), 200, :items, 404)
    end)
  end

  def create_work_item(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      respond(conn, WorkItems.create(user.id, vault_id, body(conn)), 201, :item)
    end)
  end

  def get_work_item(conn, id) do
    authenticated(conn, fn conn, user ->
      with {:ok, item} <- WorkItems.get(user.id, id),
           {:ok, reviews} <- WorkItems.reviews(user.id, id),
           {:ok, siblings} <- WorkItems.siblings(user.id, id) do
        JSON.send(conn, 200, %{item: item, reviews: reviews, siblings: siblings})
      else
        {:error, message} -> JSON.send(conn, 404, %{error: message})
      end
    end)
  end

  def update_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.update(user.id, id, body(conn)) end, 200, :item)

  def report_git_state(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.report_git_state(user.id, id, body(conn)) end,
        200,
        :item
      )

  def lease_work_item(conn, id) do
    work_action(
      conn,
      fn user ->
        WorkItems.acquire_lease(
          user.id,
          id,
          body(conn)["holder"] || user.username || to_string(user.id),
          body(conn)["ttlMs"] || 30 * 60 * 1_000
        )
      end,
      200,
      :item
    )
  end

  def release_work_item(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.release_lease(user.id, id, body(conn)["holder"]) end,
        200,
        :item
      )

  def link_work_item_run(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.link_run(user.id, id, body(conn)["runId"]) end,
        200,
        :item
      )

  def handoff_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.handoff(user.id, id, body(conn)) end, 201, nil)

  def review_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.review(user.id, id, body(conn)) end, 201, :review)

  def stop_work_item(conn, id) do
    work_action(
      conn,
      fn user ->
        reason =
          if body(conn)["reason"] in ["completed", "token_budget", "failed"],
            do: body(conn)["reason"],
            else: "manual"

        case WorkItems.stop(user.id, id, reason, body(conn)["summary"] || "") do
          {:ok, item} = result ->
            Enum.each(item.runIds, fn run_id ->
              case Store.get(run_id) do
                %{status: status} when status in ["queued", "running"] -> Store.cancel(run_id)
                _ -> :ok
              end
            end)

            result

          error ->
            error
        end
      end,
      200,
      :item
    )
  end

  defp create_direct_run(conn, user, vault) do
    params = body(conn)
    prompt = params["prompt"] |> to_string() |> String.trim()

    cond do
      params["chatDispatchId"] || is_map(params["chat"]) ->
        create_chat_run(conn, user, params)

      prompt == "" ->
        JSON.send(conn, 400, %{error: "Prompt is required"})

      not RunnerLifecycle.wait_online(user.id) ->
        JSON.send(conn, 503, %{
          error:
            "No desktop agent runner is connected. Open Fizzer on your computer (signed in to the same account) to run agents from chat."
        })

      true ->
        agent = if Store.valid_agent?(params["agent"]), do: params["agent"], else: "claude-code"
        note_id = blank_nil(params["note_id"])
        conversation_id = blank_nil(params["conversation_id"])
        model = PromptContext.normalize_model(params["model"])
        context_mode = PromptContext.normalize_context_mode(params["contextMode"])
        sandbox = PromptContext.normalize_sandbox(params["sandbox"])

        resume_session_id =
          if conversation_id do
            Store.find_conversation_session(%{
              vault_id: vault.id,
              note_id: note_id,
              agent: agent,
              conversation_id: conversation_id
            })
          end

        effective_prompt =
          PromptContext.enrich_prompt(
            vault.id,
            user.id,
            prompt,
            agent,
            resume_session_id,
            context_mode
          )

        case Store.start(vault.id, note_id, effective_prompt, agent,
               owner_user_id: user.id,
               conversation_id: conversation_id,
               model: model,
               session_id: resume_session_id
             ) do
          {:ok, run} ->
            delegate_or_fail(
              conn,
              user.id,
              vault.id,
              run,
              agent,
              effective_prompt,
              resume_session_id,
              params,
              %{context_mode: context_mode, sandbox: sandbox}
            )

          {:error, message} ->
            JSON.send(conn, 500, %{error: message})
        end
    end
  end

  defp create_chat_run(conn, user, params) do
    chat = if is_map(params["chat"]), do: params["chat"], else: %{}
    channel_id = clean_string(chat["channelId"])
    dispatch_id = clean_string(params["chatDispatchId"])

    result =
      if dispatch_id == "" do
        with {:ok, message} <-
               Messages.get(channel_id, user.id, clean_string(chat["triggeringMessageId"])),
             [actor] <-
               SQL.one("SELECT actor_user_id FROM chat_messages WHERE id=?", [message.id]),
             true <- actor == user.id do
          Dispatches.create(user.id, channel_id, message, clean_string(params["registrationId"]))
        else
          _ -> {:error, "An admitted chat message is required."}
        end
      else
        Dispatches.get(user.id, channel_id, dispatch_id)
      end

    case result do
      {:ok, dispatch} ->
        Cascade.Missions.DispatchReannouncer.wake()

        case Store.find_by_chat_dispatch(dispatch.id) do
          nil -> JSON.send(conn, 202, %{queued: true, dispatchId: dispatch.id})
          run -> JSON.send(conn, 200, %{run: run, reused: true})
        end

      {:error, message} ->
        JSON.send(conn, 404, %{error: message})
    end
  end

  defp delegate_or_fail(
         conn,
         user_id,
         vault_id,
         run,
         agent,
         prompt,
         resume_session_id,
         params,
         runtime
       ) do
    vault_root = ContentStore.get_vault(vault_id, user_id).root_path

    delegated =
      RunnerLifecycle.delegate(
        user_id,
        PromptContext.delegate_payload(
          run,
          vault_root,
          agent,
          prompt,
          params,
          resume_session_id,
          runtime
        )
      )

    if delegated do
      JSON.send(conn, 200, %{run: run, reused: false})
    else
      error =
        "Desktop agent runner disconnected before the run could start. Open Fizzer on your computer and try again."

      Store.finish(run.id, "failed", error)
      Store.publish(run.id, "status", %{status: "failed", summary: error})
      JSON.send(conn, 503, %{error: error})
    end
  end

  defp with_run_access(conn, raw_id, user_id, callback) do
    case parse_id(raw_id) |> then(&if(&1, do: Store.get(&1), else: nil)) do
      nil ->
        JSON.send(conn, 404, %{error: "Run not found"})

      run ->
        if Store.owned?(run.id, user_id),
          do: callback.(run),
          else: JSON.send(conn, 404, %{error: "Run not found"})
    end
  end

  defp work_action(conn, callback, status, key) do
    authenticated(conn, fn conn, user ->
      case callback.(user) do
        {:ok, value} when is_nil(key) -> JSON.send(conn, status, value)
        {:ok, value} -> JSON.send(conn, status, %{key => value})
        {:error, message} -> JSON.send(conn, 400, %{error: message})
      end
    end)
  end

  defp respond(conn, {:ok, value}, status, key, _error_status),
    do: JSON.send(conn, status, %{key => value})

  defp respond(conn, {:error, message}, _status, _key, error_status),
    do: JSON.send(conn, error_status, %{error: message})

  defp respond(conn, result, status, key), do: respond(conn, result, status, key, 400)

  defp authenticated(conn, callback) do
    case Session.authenticate(conn) do
      {:ok, auth} -> callback.(conn, auth.user)
      _ -> JSON.send(conn, 401, %{error: "Invalid or expired token"})
    end
  end

  defp with_vault(conn, vault_id, user_id, callback) do
    if VaultMembers.accessible_vault(vault_id, user_id),
      do: callback.(),
      else: JSON.send(conn, 404, %{error: "Vault not found"})
  end

  defp parse_id(value) when is_binary(value) do
    case Integer.parse(value) do
      {id, ""} when id > 0 -> id
      _ -> nil
    end
  end

  defp parse_id(value) when is_integer(value) and value > 0, do: value
  defp parse_id(_), do: nil
  defp body(%Plug.Conn{body_params: %Plug.Conn.Unfetched{}}), do: %{}
  defp body(conn) when is_map(conn.body_params), do: conn.body_params
  defp body(_), do: %{}
  defp blank_nil(value) when value in [nil, ""], do: nil
  defp blank_nil(value), do: value
  defp clean_string(value), do: value |> to_string() |> String.trim()
  defp maybe_option(options, _key, value) when value in [nil, ""], do: options
  defp maybe_option(options, key, value), do: Keyword.put(options, key, value)
end
