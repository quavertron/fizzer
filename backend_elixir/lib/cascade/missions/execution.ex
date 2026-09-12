defmodule Cascade.Missions.Execution do
  @moduledoc "Prepares and executes admitted dispatches independently of HTTP."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Dispatches
  alias Cascade.Missions.Store, as: MissionStore
  alias Cascade.Realtime.{Events, OrderedPublisher}
  alias Cascade.Runs.{PromptContext, RunnerLifecycle, Store}
  alias Cascade.WorkItems

  def prepare_dispatch(dispatch_id) do
    with nil <- Store.find_by_chat_dispatch(dispatch_id),
         {:ok, dispatch} <- Dispatches.for_execution(dispatch_id),
         {:ok, execution} <-
           resolve_chat_execution(dispatch) do
      ensure_agent_message(
        execution,
        "agent-dispatch-#{dispatch.id}",
        dispatch_message_value(dispatch, :missionTaskId, ""),
        %{id: nil, status: "queued"},
        if(String.starts_with?(dispatch.messageId, "sys-mission-"),
          do: %{
            messageId: dispatch.messageId,
            author: "",
            preview: "Mission interpretation",
            relationship: "builds_on"
          }
        )
      )
    else
      {:deferred, _} -> retract_deferred_reply(dispatch_id)
      _ -> :ok
    end
  end

  defp retract_deferred_reply(dispatch_id) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        with nil <- Store.find_by_chat_dispatch(dispatch_id),
             {:deferred, _} <- Dispatches.for_execution(dispatch_id) do
          Dispatches.retract_pending_reply(dispatch_id)
        else
          _ -> :ok
        end
      end)
    end)
  end

  @doc "Executes one admitted turn; called only by the serialized dispatch scheduler."
  def execute_dispatch(dispatch_id) do
    case Store.find_by_chat_dispatch(dispatch_id) do
      nil ->
        execute_pending_dispatch(dispatch_id)

      run ->
        attach_dispatch(dispatch_id, run.id)

        SQL.exec(
          "UPDATE chat_messages SET run_id=? WHERE id=? AND run_id IS NULL AND registration_id=(SELECT registration_id FROM chat_agent_dispatches WHERE id=?)",
          [run.id, "agent-dispatch-#{dispatch_id}", dispatch_id]
        )

        if run.status == "queued" and is_nil(Store.delegated_owner(run.id)) and
             SQL.one(
               "SELECT 1 FROM runs WHERE id=? AND started_at < datetime('now','-30 seconds')",
               [run.id]
             ) == [1] do
          error = "Server interrupted run startup before desktop delegation."
          Store.finish(run.id, "failed", error)
          Store.publish(run.id, "status", %{status: "failed", summary: error})
        end

        if Store.terminal?(Store.get(run.id).status), do: Cascade.Runs.ChatProjection.sync(run.id)
        {:ok, Store.get(run.id)}
    end
  end

  defp execute_pending_dispatch(dispatch_id) do
    with {:ok, dispatch} <- Dispatches.for_execution(dispatch_id),
         :kept <-
           discard_terminal_mission_wake(
             dispatch.requesterUserId,
             dispatch.requesterChannelId,
             dispatch
           ),
         {:ok, execution} <- resolve_chat_execution(dispatch) do
      with true <- RunnerLifecycle.online?(execution.runner_user_id),
           :ok <- release_sticky_registration(dispatch),
           {:ok, _refreshed, execution} <- refresh_execution(dispatch_id),
           {:ok, prepared} <- prepare_work_item(execution),
           {:ok, dispatch, execution} <- refresh_execution(dispatch_id),
           :ok <- workspace_unchanged(prepared, execution) do
        resume =
          Store.find_conversation_session(%{
            vault_id: execution.vault.id,
            note_id: nil,
            agent: execution.agent,
            conversation_id: dispatch.conversationId
          })

        built =
          SQL.transaction(fn ->
            with {:ok, current, current_execution} <- refresh_execution(dispatch.id),
                 true <- current_execution == execution do
              Cascade.Chat.DispatchPrompt.build(current, current_execution, resume)
            else
              false -> {:retry, "Agent settings changed during prompt preparation."}
              error -> error
            end
          end)

        with %{prompt: _} = built <- built do
          {context, inline_svgs} =
            chat_context(
              execution,
              dispatch.registration.id,
              "agent-dispatch-#{dispatch.id}",
              dispatch.messageId,
              resume
            )

          prompt =
            PromptContext.enrich_prompt(
              execution.vault.id,
              execution.runner_user_id,
              built.prompt,
              execution.agent,
              resume
            )
            |> PromptContext.append_context(context)
            |> PromptContext.append_mission_context(dispatch, execution.runner_user_id)

          start_dispatch(dispatch, execution, %{built | prompt: prompt}, resume, inline_svgs)
        else
          {:deferred, message} -> {:busy, message}
          error -> error
        end
      else
        {:deferred, message} ->
          {:busy, message}

        false ->
          {:retry, "Waiting for the agent owner's desktop runner."}

        {:error, _id, :busy} ->
          {:busy, "Agent session is busy; this turn remains queued."}

        {:error, _id, reason} when is_atom(reason) ->
          {:retry, "Agent session is #{reason}; this turn remains queued."}

        {:error, 409, reason} ->
          {:retry, reason}

        {:error, reason} ->
          {:error, reason}
      end
    else
      {:deferred, message} -> {:busy, message}
      :discarded -> :discarded
      {:error, _status, message} -> {:error, message}
      {:error, message} -> {:error, message}
    end
  end

  defp refresh_execution(dispatch_id) do
    with {:ok, dispatch} <- Dispatches.for_execution(dispatch_id),
         {:ok, execution} <-
           resolve_chat_execution(dispatch) do
      {:ok, dispatch, execution}
    else
      {:error, _status, reason} -> {:error, reason}
      error -> error
    end
  end

  defp workspace_unchanged(prepared, execution) do
    if prepared.cwd == execution.cwd and prepared.work_item_id == execution.work_item_id,
      do: :ok,
      else:
        {:error, 409, "Workspace settings changed during preparation; this turn remains queued."}
  end

  defp start_dispatch(dispatch, execution, built, resume, inline_svgs) do
    result =
      OrderedPublisher.mutate(fn ->
        SQL.transaction(fn ->
          with {:ok, _current, current_execution} <- refresh_execution(dispatch.id),
               true <- current_execution == execution,
               {:ok, run} <-
                 start_chat_run(
                   execution,
                   nil,
                   built.prompt,
                   dispatch.conversationId,
                   resume,
                   dispatch.id
                 ) do
            attach_dispatch(dispatch.id, run.id)

            ensure_agent_message(
              execution,
              "agent-dispatch-#{dispatch.id}",
              dispatch_message_value(dispatch, :missionTaskId, ""),
              run,
              built.reply_to
            )

            {:ok, run}
          else
            false -> {:retry, "Agent settings changed during startup; this turn remains queued."}
            error -> error
          end
        end)
      end)

    case result do
      {:reused, run} ->
        attach_dispatch(dispatch.id, run.id)
        {:ok, run}

      {:ok, run} ->
        message_id = "agent-dispatch-#{dispatch.id}"

        payload =
          chat_delegate_payload(
            execution,
            run,
            built.prompt,
            resume,
            %{"images" => built.images},
            message_id,
            dispatch.messageId,
            inline_svgs
          )

        if RunnerLifecycle.delegate(execution.runner_user_id, payload) do
          {:ok, run}
        else
          error = "Desktop agent runner disconnected before the run could start."
          Store.finish(run.id, "failed", error)
          Store.publish(run.id, "status", %{status: "failed", summary: error})
          {:error, error}
        end

      {:deferred, message} ->
        {:busy, message}

      {:retry, _} = retry ->
        retry

      {:error, message} ->
        {:error, message}
    end
  end

  defp discard_terminal_mission_wake(user_id, channel_id, dispatch) do
    message_id = dispatch_value(dispatch, :messageId, "")

    with [_, mission_id] <- Regex.run(~r/^sys-mission-([0-9a-f-]{36})-/i, message_id),
         [status] when status in ["completed", "canceled"] <-
           SQL.one("SELECT status FROM chat_missions WHERE id=?", [mission_id]),
         false <- Cascade.Missions.Interpretation.keep_wake?(dispatch_value(dispatch, :id, "")),
         {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      Dispatches.retract_pending_reply(dispatch_value(dispatch, :id, ""))

      SQL.exec("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
        message_id,
        route.sourceChannelId
      ])

      Events.emit(%{
        event: "vault:chatMessageDeleted",
        vaultId: route.sourceVaultId,
        channelId: route.sourceChannelId,
        messageId: message_id
      })

      :discarded
    else
      _ -> :kept
    end
  end

  defp resolve_chat_execution(dispatch) do
    user_id = dispatch.requesterUserId
    registration = dispatch.registration

    with {:ok, projection} <-
           Agents.resolve_owner_projection(user_id, dispatch.requesterChannelId, registration.id),
         true <- Dispatches.allowed?(user_id, registration, dispatch.message),
         vault when not is_nil(vault) <-
           ContentStore.get_vault(projection.ownerVaultId, projection.ownerId) do
      requester_is_owner = user_id == projection.ownerId

      agent =
        if Store.valid_agent?(registration.agentId),
          do: registration.agentId,
          else: "claude-code"

      work_item_id = dispatch_work_item_id(dispatch)

      cwd =
        registration.cwd
        |> PromptContext.normalize_cwd()
        |> authoritative_channel_cwd(projection, projection.ownerId)
        |> authoritative_work_item_cwd(projection.ownerId, work_item_id)

      effort =
        if agent in ["codex", "claude-code"],
          do:
            nonblank(
              dispatch_value(dispatch, :reasoningEffort, ""),
              registration.reasoningEffort
            ),
          else: ""

      memory_key =
        if agent == "akron-grok",
          do: "akron",
          else:
            nonblank(
              registration.mention,
              registration.vaultAgentId || registration.agentId || agent
            )

      {:ok,
       %{
         vault: vault,
         runner_user_id: projection.ownerId,
         target_channel_id: projection.ownerChannelId,
         registration_id: registration.id,
         registration: registration,
         agent: agent,
         model: PromptContext.normalize_model(registration.model),
         reasoning_effort: blank_nil(effort),
         priority_service_tier: agent == "codex" and registration.priorityServiceTier,
         cwd: cwd,
         yolo: requester_is_owner and registration.yolo,
         hermes_profile: registration.hermesProfile,
         hermes_safe_mode: registration.hermesSafeMode,
         chat_author: nonblank(registration.displayName, registration.agentId),
         memory_key: memory_key,
         work_item_id: work_item_id
       }}
    else
      {:error, status, message} -> {:error, status, message}
      _ -> {:error, 404, "Agent not found"}
    end
  end

  defp authoritative_channel_cwd(cwd, projection, owner_id) do
    source_owned =
      SQL.one("SELECT created_by FROM vaults WHERE id=?", [projection.route.sourceVaultId])

    if source_owned == [owner_id] do
      case Channel.settings(projection.ownerChannelId, owner_id) do
        {:ok, %{cwd: channel_cwd}} -> PromptContext.normalize_cwd(channel_cwd) || cwd
        _ -> cwd
      end
    else
      cwd
    end
  end

  defp authoritative_work_item_cwd(cwd, _owner_id, work_item_id) when work_item_id in [nil, ""],
    do: cwd

  defp authoritative_work_item_cwd(cwd, owner_id, work_item_id) do
    case WorkItems.get(owner_id, work_item_id) do
      {:ok, %{worktreePath: path}} when path not in [nil, ""] -> path
      _ -> cwd
    end
  end

  defp prepare_work_item(%{work_item_id: work_item_id} = execution)
       when work_item_id in [nil, ""],
       do: {:ok, execution}

  defp prepare_work_item(execution) do
    with {:ok, item} <- WorkItems.get(execution.runner_user_id, execution.work_item_id) do
      if item.workspaceMode == "isolated" do
        preparation_dir =
          workspace_source(item, execution)

        if preparation_dir == "" do
          {:error, 409,
           "Mission task needs a repository cwd before its isolated workspace can be prepared."}
        else
          payload = %{
            workItemId: item.id,
            dir: preparation_dir,
            branch: item.branch,
            baseBranch: field(field(item, :gitState, %{}), :baseBranch),
            channelId: execution.target_channel_id
          }

          case RunnerLifecycle.prepare_workspace(execution.runner_user_id, payload) do
            {:ok, prepared} ->
              case WorkItems.bind_workspace(execution.runner_user_id, item.id, %{
                     repository: prepared.repository,
                     baseCommit: prepared.baseCommit,
                     branch: prepared.branch,
                     worktreePath: prepared.path
                   }) do
                {:ok, _item} -> {:ok, %{execution | cwd: prepared.path}}
                {:error, message} -> {:error, 409, message}
              end

            {:error, message} ->
              {:error, 409, message}
          end
        end
      else
        {:ok, execution}
      end
    else
      {:error, message} -> {:error, 409, message}
    end
  end

  defp workspace_source(item, execution) do
    fallback = nonblank(item.worktreePath, nonblank(item.repository, execution.cwd || ""))

    case SQL.one(
           """
           SELECT p.worktree_path,p.repository,p.workspace_mode
           FROM chat_mission_tasks child
           JOIN chat_mission_tasks parent ON parent.id=child.parent_task_id
           JOIN work_items p ON p.id=parent.work_item_id
           WHERE child.work_item_id=? AND p.created_by=?
           """,
           [item.id, execution.runner_user_id]
         ) do
      [path, _, _] when path not in [nil, ""] -> path
      [_, _, "isolated"] -> ""
      [_, repository, _] -> nonblank(repository, fallback)
      _ -> fallback
    end
  end

  defp chat_context(_execution, _registration_id, _message_id, "sys-mission-wiki-" <> _, _resume),
    do: {[], []}

  defp chat_context(execution, registration_id, message_id, triggering_message_id, resume) do
    if execution.target_channel_id == "" do
      {[], []}
    else
      worker? =
        case Messages.get(
               execution.target_channel_id,
               execution.runner_user_id,
               triggering_message_id
             ) do
          {:ok, message} -> message[:missionTaskId] not in [nil, ""]
          _ -> false
        end

      room =
        if worker? do
          %{
            text:
              "Task source: `cascade-chat history --around-message-id #{triggering_message_id} --include-reply-context`; use `cascade-chat search <query>` for older evidence.",
            inlineSvgs: []
          }
        else
          with {:ok, messages} <-
                 Messages.list(execution.target_channel_id, execution.runner_user_id,
                   limit: 64,
                   through_message_id: triggering_message_id
                 ),
               {:ok, registrations} <-
                 Agents.list_members(execution.target_channel_id, execution.runner_user_id) do
            RoomContext.build_context_payload(%{
              messages: messages,
              registrations: registrations,
              targetRegistrationId: registration_id,
              excludeMessageIds: [message_id, triggering_message_id],
              continuation: not is_nil(resume),
              cursorMessageId: triggering_message_id,
              maxChars: if(resume, do: 1_200, else: 2_800)
            })
          else
            _ -> %{text: "", inlineSvgs: []}
          end
        end

      suggestions =
        Cascade.Chat.NextSteps.context(
          execution.target_channel_id,
          registration_id,
          triggering_message_id,
          worker?
        )

      {[room.text, suggestions], room.inlineSvgs}
    end
  rescue
    _ -> {[], []}
  end

  defp start_chat_run(execution, note_id, prompt, conversation_id, resume, dispatch_id) do
    case Store.start(execution.vault.id, note_id, prompt, execution.agent,
           owner_user_id: execution.runner_user_id,
           conversation_id: conversation_id,
           model: execution.model,
           session_id: resume,
           chat_dispatch_id: blank_nil(dispatch_id)
         ) do
      {:ok, run} ->
        {:ok, run}

      {:error, message} ->
        case if(dispatch_id == "", do: nil, else: Store.find_by_chat_dispatch(dispatch_id)) do
          nil -> {:error, message}
          existing -> {:reused, existing}
        end
    end
  end

  defp release_sticky_registration(dispatch) do
    if dispatch_message_value(dispatch, :missionTaskId, "") != "" do
      :ok
    else
      case Store.find_open_for_chat_registration(dispatch.registration.id, dispatch.id) do
        nil ->
          :ok

        occupied ->
          owner_id = Store.delegated_owner(occupied.id)

          cond do
            is_nil(owner_id) or not Dispatches.human?(dispatch) ->
              {:error, occupied.id, :busy}

            not RunnerLifecycle.online?(owner_id) ->
              {:error, occupied.id, :reconnecting}

            interrupt_coordinator(occupied.id, dispatch.id) ->
              :ok

            true ->
              {:error, occupied.id, :stopping}
          end
      end
    end
  end

  defp interrupt_coordinator(run_id, next_dispatch_id) do
    Cascade.Chat.Continuations.interrupt(run_id, next_dispatch_id)
    Store.cancel(run_id, steering: true)
  end

  defp attach_dispatch("", _run_id), do: :ok

  defp attach_dispatch(dispatch_id, run_id) do
    OrderedPublisher.mutate(fn ->
      SQL.transaction(fn ->
        :ok = Dispatches.attach_run(dispatch_id, run_id)
        _ = MissionStore.attach_run(dispatch_id, run_id)
        :ok
      end)
    end)
  end

  defp ensure_agent_message(execution, message_id, mission_task_id, run, reply_to)
       when message_id != "" and execution.target_channel_id != "" do
    OrderedPublisher.mutate(fn ->
      with [username] <-
             SQL.one("SELECT username FROM users WHERE id=?", [execution.runner_user_id]),
           owner <- %{id: execution.runner_user_id, username: username},
           {:ok, message, existed} <-
             upsert_agent_message(
               owner,
               execution,
               message_id,
               mission_task_id,
               run,
               reply_to
             ),
           {:ok, route} <-
             Channel.assert_channel(execution.target_channel_id, execution.runner_user_id) do
        event = if(existed, do: "vault:chatMessageUpdated", else: "vault:chatMessageCreated")

        intent = %{
          event: event,
          vaultId: route.sourceVaultId,
          channelId: route.sourceChannelId,
          message: message
        }

        case existed do
          :unchanged -> :ok
          true -> Events.emit(intent)
          false -> OrderedPublisher.chat(Events, intent)
        end
      else
        _ -> :ok
      end
    end)
  rescue
    _ -> :ok
  end

  defp ensure_agent_message(_execution, _message_id, _mission_task_id, _run, _reply_to), do: :ok

  defp upsert_agent_message(owner, execution, message_id, mission_task_id, run, reply_to) do
    case Messages.get(execution.target_channel_id, execution.runner_user_id, message_id) do
      {:ok, %{status: "queued"}} when is_nil(run.id) ->
        {:ok, %{}, :unchanged}

      {:ok, _existing} ->
        case Messages.update(
               owner,
               execution.vault.id,
               execution.target_channel_id,
               message_id,
               %{
                 runId: run.id,
                 status: if(run.id, do: "running", else: "queued"),
                 replyTo: reply_to,
                 body: if(run.id, do: "Thinking...", else: "Queued...")
               },
               access: :agent
             ) do
          {:ok, message} -> {:ok, message, true}
          {:error, _} = error -> error
        end

      _ ->
        case Messages.create(
               owner,
               execution.vault.id,
               execution.target_channel_id,
               %{
                 id: message_id,
                 author: execution.chat_author,
                 agentId: execution.agent,
                 registrationId: blank_nil(execution.registration_id),
                 missionTaskId: blank_nil(mission_task_id),
                 runId: run.id,
                 body: if(run.id, do: "Thinking...", else: "Queued..."),
                 status: if(run.id, do: "running", else: "queued"),
                 replyTo: reply_to
               },
               access: :agent
             ) do
          {:ok, message} -> {:ok, message, false}
          {:error, _} = error -> error
        end
    end
  end

  defp chat_delegate_payload(
         execution,
         run,
         prompt,
         resume,
         params,
         message_id,
         triggering_message_id,
         inline_svgs
       ) do
    PromptContext.delegate_payload(
      run,
      execution.vault.root_path,
      execution.agent,
      prompt,
      params,
      resume,
      %{
        cwd: execution.cwd,
        model: execution.model,
        reasoning_effort: execution.reasoning_effort,
        priority_service_tier: execution.priority_service_tier,
        chat_channel_id: execution.target_channel_id,
        chat_message_id: message_id,
        chat_triggering_message_id: triggering_message_id,
        chat_author: execution.chat_author,
        agent_memory_key: execution.memory_key,
        chat_registration_id: execution.registration_id,
        work_item_id: execution.work_item_id,
        inline_svgs: inline_svgs,
        yolo: execution.yolo,
        hermes_profile: execution.hermes_profile,
        hermes_safe_mode: execution.hermes_safe_mode
      }
    )
  end

  defp dispatch_work_item_id(dispatch) do
    case dispatch_message_value(dispatch, :missionTaskId, "") do
      "" ->
        nil

      task_id ->
        case SQL.one("SELECT work_item_id FROM chat_mission_tasks WHERE id=?", [task_id]) do
          [work_item_id] -> blank_nil(work_item_id)
          _ -> nil
        end
    end
  end

  defp dispatch_value(nil, _key, fallback), do: fallback
  defp dispatch_value(dispatch, key, fallback), do: field(dispatch, key, fallback)

  defp dispatch_message_value(nil, _key, fallback), do: fallback

  defp dispatch_message_value(dispatch, key, fallback),
    do: field(field(dispatch, :message, %{}), key, fallback)

  defp blank_nil(value) when value in [nil, ""], do: nil
  defp blank_nil(value), do: value
  defp nonblank(value, fallback) when value in [nil, ""], do: fallback
  defp nonblank(value, _fallback), do: value

  defp field(map, key, fallback \\ nil)

  defp field(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))

  defp field(_map, _key, fallback), do: fallback

end
