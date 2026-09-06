defmodule CascadeWeb.ChatRouter do
  @moduledoc "Mountable native HTTP surface for messages, linked channels, invitations, and chat agents."

  use CascadeWeb.DomainDispatch
  import Plug.Conn

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Chat.{Agents, Channel, Collaborations, Messages, RoomContext}
  alias Cascade.Missions.Dispatches
  alias Cascade.Realtime.OrderedPublisher
  alias CascadeWeb.{Auth, JSON}

  plug :put_domain_options
  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  get "/api/app-context" do
    authenticated(conn, :any, nil, fn conn, user ->
      JSON.send(conn, 200, Cascade.Runs.AppContext.get(user.id))
    end)
  end

  put "/api/app-context" do
    authenticated(conn, :any, :account, fn conn, user ->
      case Cascade.Runs.AppContext.put(
             user.id,
             conn.body_params["content"],
             conn.body_params["revision"]
           ) do
        {:ok, document} ->
          JSON.send(conn, 200, document)

        {:error, :conflict} ->
          JSON.send(conn, 409, %{error: "Context changed; read again and merge before saving"})

        {:error, :invalid} ->
          JSON.send(conn, 400, %{
            error: "Provide UTF-8 content up to 12000 bytes and the current revision"
          })
      end
    end)
  end

  get "/api/vaults/:vault_id/vault-agents" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(conn, Agents.list_vault(user.id, vault_id), :agents)
    end)
  end

  put "/api/vaults/:vault_id/vault-agents" do
    authenticated(conn, :any, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn -> Agents.upsert_identity(user.id, vault_id, conn.body_params) end,
             fn agent ->
               %{event: "vault:vaultAgentUpserted", vaultId: vault_id, agent: agent}
             end
           ) do
        {:ok, agent} ->
          JSON.send(conn, 200, %{agent: agent})

        error ->
          domain_error(conn, error)
      end
    end)
  end

  get "/api/vaults/:vault_id/vault-agents/:agent_id" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(conn, Agents.get(user.id, vault_id, agent_id), :agent)
    end)
  end

  delete "/api/vaults/:vault_id/vault-agents/:agent_id/profile" do
    authenticated(conn, :user, :vault, fn conn, user ->
      mutation_result(conn, fn -> Agents.delete_profile(user.id, vault_id, agent_id) end, %{
        event: "vault:vaultAgentDeleted",
        vaultId: vault_id,
        agentId: agent_id
      })
    end)
  end

  delete "/api/vaults/:vault_id/vault-agents/:agent_id" do
    authenticated(conn, :any, :vault, fn conn, user ->
      mutation_result(conn, fn -> Agents.unlink_from_vault(user.id, vault_id, agent_id) end, %{
        event: "vault:vaultAgentRemoved",
        vaultId: vault_id,
        agentId: agent_id
      })
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/messages" do
    authenticated(conn, :any, nil, fn conn, user ->
      detail = if query(conn, "detail") == "full", do: :full, else: :list
      limit = parse_number(query(conn, "limit"))

      case Messages.list(channel_id, user.id,
             detail: detail,
             limit: limit || 120,
             before_seq: parse_number(query(conn, "beforeSeq")),
             page: true
           ) do
        {:ok, page} -> JSON.send(conn, 200, page)
        error -> domain_error(conn, error)
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages" do
    authenticated(conn, :any, :vault, fn conn, user ->
      with {:ok, result} <-
             serialized_create_and_emit(
               conn,
               fn ->
                 with {:ok, prior} <- Messages.list(channel_id, user.id, limit: 48),
                      {:ok, members} <- Agents.ensure_vault_wide(user.id, vault_id, channel_id) do
                   case Dispatches.clear_targets(body(conn, "body", ""), members) do
                     nil ->
                       input = RoomContext.infer_natural_link(conn.body_params, prior, members)

                       with {:ok, message} <-
                              Messages.create(user, vault_id, channel_id, input,
                                access: access(conn)
                              ),
                            {:ok, dispatches} <-
                              Dispatches.create_for_message(user.id, channel_id, message) do
                         {:ok, %{message: message, agents: members, dispatches: dispatches}}
                       end

                     targets ->
                       clear_sessions(conn, user, vault_id, channel_id, targets)
                   end
                 end
               end,
               fn result ->
                 event = %{
                   event: "vault:chatMessageCreated",
                   vaultId: source(result.message, :vault, vault_id),
                   channelId: source(result.message, :channel, channel_id),
                   message: result.message,
                   dispatches: result.dispatches
                 }

                 if result[:notice] do
                   OrderedPublisher.chat(callback(conn, :events), event)

                   for agent <- result.agents do
                     OrderedPublisher.chat(callback(conn, :events), %{
                       event: "vault:chatAgentMemberUpserted",
                       vaultId: vault_id,
                       channelId: channel_id,
                       registration: agent
                     })
                   end

                   %{event | message: result.notice}
                 else
                   event
                 end
               end
             ) do
        JSON.send(conn, 201, %{
          message: result.message,
          agents: result.agents,
          dispatches: result.dispatches,
          notice: result[:notice]
        })
      else
        error -> domain_error(conn, error)
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/embeds" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(
        conn,
        Messages.embeds(channel_id, user.id, message_id, access: access(conn)),
        :notes
      )
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(conn, Messages.get(channel_id, user.id, message_id), :message)
    end)
  end

  patch "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id" do
    authenticated(conn, :any, :vault, fn conn, user ->
      result = fn ->
        with {:ok, message} <-
               Messages.update(user, vault_id, channel_id, message_id, conn.body_params,
                 access: access(conn)
               ),
             {:ok, all_dispatches} <-
               Dispatches.create_for_message(user.id, channel_id, message) do
          {:ok,
           %{
             message: message,
             dispatches: Enum.filter(all_dispatches, &is_nil(&1.runId))
           }}
        end
      end

      case serialized_mutation_and_emit(conn, result, fn result ->
             %{
               event: "vault:chatMessageUpdated",
               vaultId: vault_id,
               channelId: channel_id,
               message: result.message,
               dispatches: result.dispatches
             }
           end) do
        {:ok, value} -> JSON.send(conn, 200, value)
        error -> domain_error(conn, error)
      end
    end)
  end

  delete "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id" do
    authenticated(conn, :user, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn ->
               Messages.delete(user, vault_id, channel_id, message_id,
                 queued_only: query(conn, "queuedOnly") == "true"
               )
             end,
             fn _route ->
               %{
                 event: "vault:chatMessageDeleted",
                 vaultId: vault_id,
                 channelId: channel_id,
                 messageId: message_id
               }
             end
           ) do
        {:ok, _route} ->
          JSON.send(conn, 200, %{ok: true})

        error ->
          domain_error(conn, error)
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/forward" do
    authenticated(conn, :user, :vault, fn conn, user ->
      target_channel = body(conn, "targetChannelId", "") |> to_string() |> String.trim()
      target_vault = body(conn, "targetVaultId", vault_id) |> to_string() |> String.trim()

      create = fn ->
        if target_channel == "" do
          {:error, "targetChannelId is required"}
        else
          Messages.forward(
            user,
            channel_id,
            message_id,
            target_vault,
            target_channel,
            body(conn, "comment", "")
          )
        end
      end

      case serialized_create_and_emit(conn, create, fn message ->
             %{
               event: "vault:chatMessageCreated",
               vaultId: target_vault,
               channelId: target_channel,
               message: message
             }
           end) do
        {:ok, message} ->
          JSON.send(conn, 201, %{message: message})

        error ->
          JSON.send(conn, 400, %{error: error_message(error)})
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/approve" do
    authenticated(conn, :user, :vault, fn conn, user ->
      updated(
        conn,
        fn -> Messages.approve(user.id, channel_id, message_id) end,
        vault_id,
        channel_id
      )
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/merge" do
    authenticated(conn, :user, :vault, fn conn, user ->
      updated(
        conn,
        fn -> Messages.merge(user.id, channel_id, message_id, merger(conn)) end,
        vault_id,
        channel_id
      )
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/clarification/answer" do
    authenticated(conn, :user, :vault, fn conn, user ->
      updated(
        conn,
        fn ->
          Messages.answer_clarification(
            user.id,
            channel_id,
            message_id,
            body(conn, "answers", [])
          )
        end,
        vault_id,
        channel_id
      )
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/clarification/accept" do
    authenticated(conn, :user, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn ->
               Messages.accept_clarification(user.id, channel_id, message_id,
                 title: body(conn, "title", nil),
                 token_budget: body(conn, "tokenBudget", 0)
               )
             end,
             fn result ->
               %{
                 event: "vault:chatMessageUpdated",
                 vaultId: vault_id,
                 channelId: channel_id,
                 message: result.message
               }
             end
           ) do
        {:ok, result} ->
          JSON.send(conn, 201, result)

        error ->
          domain_error(conn, error)
      end
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/collaborate" do
    authenticated(conn, :any, :vault, fn conn, user ->
      case serialized_create_and_emit(
             conn,
             fn ->
               Collaborations.create(
                 user,
                 vault_id,
                 channel_id,
                 message_id,
                 conn.body_params,
                 access: access(conn),
                 dispatch: callback(conn, :dispatch)
               )
             end,
             fn result ->
               %{
                 event: "vault:chatMessageCreated",
                 vaultId: vault_id,
                 channelId: channel_id,
                 message: result.message,
                 dispatches: [result.dispatch]
               }
             end
           ) do
        {:ok, result} ->
          JSON.send(conn, 201, result)

        error ->
          domain_error(conn, error)
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/agents" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(conn, Agents.ensure_vault_wide(user.id, vault_id, channel_id), :agents)
    end)
  end

  put "/api/vaults/:vault_id/channels/:channel_id/agents" do
    authenticated(conn, :any, :vault, fn conn, user ->
      registration(
        conn,
        fn -> Agents.upsert_member(user.id, vault_id, channel_id, conn.body_params) end,
        vault_id,
        channel_id,
        200
      )
    end)
  end

  post "/api/vaults/:vault_id/channels/:channel_id/agents/from-vault" do
    authenticated(conn, :any, :vault, fn conn, user ->
      registration(
        conn,
        fn ->
          Agents.add_to_channel(
            user.id,
            vault_id,
            channel_id,
            body(conn, "vaultAgentId", body(conn, "agentId", "")),
            conn.body_params,
            true
          )
        end,
        vault_id,
        channel_id,
        201
      )
    end)
  end

  put "/api/vaults/:vault_id/channels/:channel_id/agents/:registration_id/avatar" do
    authenticated(conn, :any, :vault, fn conn, user ->
      registration(
        conn,
        fn ->
          with :ok <- authorize_self_avatar(conn, user.id, registration_id) do
            Agents.set_avatar(
              user.id,
              vault_id,
              channel_id,
              registration_id,
              body(conn, "avatarUrl", "")
            )
          end
        end,
        vault_id,
        channel_id,
        200
      )
    end)
  end

  delete "/api/vaults/:vault_id/channels/:channel_id/agents/:registration_id" do
    authenticated(conn, :any, :vault, fn conn, user ->
      mutation_result(
        conn,
        fn -> Agents.remove_member(user.id, vault_id, channel_id, registration_id) end,
        %{
          event: "vault:chatAgentMemberRemoved",
          vaultId: vault_id,
          channelId: channel_id,
          registrationId: registration_id
        }
      )
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/settings" do
    authenticated(conn, :any, nil, fn conn, user ->
      respond(conn, Channel.settings(channel_id, user.id), :settings)
    end)
  end

  put "/api/vaults/:vault_id/channels/:channel_id/settings" do
    authenticated(conn, :user, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn -> Channel.update_settings(channel_id, user.id, conn.body_params) end,
             fn settings ->
               %{
                 event: "vault:chatChannelSettings",
                 vaultId: vault_id,
                 channelId: channel_id,
                 settings: settings
               }
             end
           ) do
        {:ok, settings} ->
          JSON.send(conn, 200, %{settings: settings})

        error ->
          domain_error(conn, error)
      end
    end)
  end

  get "/api/vaults/:vault_id/channels/:channel_id/presence" do
    authenticated(conn, :any, nil, fn conn, user ->
      case Channel.presence(channel_id, user.id, callback(conn, :presence)) do
        {:ok, presence} -> JSON.send(conn, 200, presence)
        error -> domain_error(conn, error)
      end
    end)
  end

  delete "/api/vaults/:vault_id/channels/:channel_id/members/me" do
    authenticated(conn, :user, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn -> Channel.leave(channel_id, user.id) end,
             fn route ->
               %{event: "vault:chatParticipantLeft", route: route, userId: user.id}
             end
           ) do
        {:ok, _route} ->
          JSON.send(conn, 200, %{ok: true})

        error ->
          domain_error(conn, error)
      end
    end)
  end

  delete "/api/vaults/:vault_id/channels/:channel_id/members/:username" do
    authenticated(conn, :user, :vault, fn conn, user ->
      case serialized_mutation_and_emit(
             conn,
             fn -> Channel.remove_participant(channel_id, user.id, username) end,
             fn result ->
               %{
                 event: "vault:chatParticipantRemoved",
                 vaultId: vault_id,
                 channelId: channel_id,
                 participant: result
               }
             end
           ) do
        {:ok, _result} ->
          JSON.send(conn, 200, %{ok: true})

        error ->
          domain_error(conn, error)
      end
    end)
  end

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end

  defp authorize_self_avatar(%{assigns: %{auth_access: "user"}}, _user_id, _registration_id),
    do: :ok

  defp authorize_self_avatar(conn, user_id, registration_id) do
    with [run_id] <- get_req_header(conn, "x-cascade-run-id"),
         {run_id, ""} <- Integer.parse(run_id),
         [^registration_id] <-
           Cascade.Accounts.SQL.one(
             """
             SELECT d.registration_id FROM runs r
             JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
             WHERE r.id=? AND r.owner_user_id=? AND r.status IN ('queued','running')
             """,
             [run_id, user_id]
           ) do
      :ok
    else
      _ -> {:error, "Agents can only update their own running identity's profile picture"}
    end
  end

  defp authenticated(conn, required, gate, fun) do
    options = [access: required] ++ mutation_option(gate)

    case Auth.require(conn, options) do
      {:ok, authorized} ->
        fun.(authorized, authorized.assigns.current_user)

      {:error, rejected} ->
        rejected
    end
  end

  defp mutation_option(nil), do: []
  defp mutation_option(:account), do: [mutation_gate: :not_vault_scoped]
  defp mutation_option(:vault), do: [mutation_gate: &VaultMembers.mutation_gate/2]

  defp clear_sessions(_conn, _user, _vault_id, _channel_id, []),
    do: {:error, "No agents in this channel to clear."}

  defp clear_sessions(conn, user, vault_id, channel_id, targets) do
    if Enum.any?(targets, &(&1.ownerUserId != user.id)) do
      {:error, "You can only manage assistants in your own roster"}
    else
      Cascade.DB.WriteCoordinator.with_lock(fn ->
        Cascade.DB.Repo.transaction(fn ->
          result =
            with {:ok, message} <-
                   Messages.create(user, vault_id, channel_id, conn.body_params,
                     access: access(conn)
                   ) do
              notice_id = "sys-clear-#{message.id}"

              case Messages.get(channel_id, user.id, notice_id) do
                {:ok, notice} ->
                  {:ok, agents} = Agents.list_members(channel_id, user.id)
                  {:ok, %{message: message, agents: agents, dispatches: [], notice: notice}}

                {:error, _} ->
                  cleared =
                    Enum.reduce_while(targets, :ok, fn target, :ok ->
                      case Agents.upsert_member(
                             user.id,
                             vault_id,
                             channel_id,
                             Map.put(target, :conversationId, Ecto.UUID.generate())
                           ) do
                        {:ok, _} -> {:cont, :ok}
                        error -> {:halt, error}
                      end
                    end)

                  names = Enum.map_join(targets, ", ", &"@#{&1.mention}")

                  with :ok <- cleared,
                       {:ok, notice} <-
                         Messages.create(
                           user,
                           vault_id,
                           channel_id,
                           %{
                             id: notice_id,
                             # Legacy system-message discriminator.
                             author: "Cascade",
                             body:
                               "🧹 Cleared the session for #{names}. The next message starts a fresh conversation."
                           },
                           access: :system
                         ),
                       {:ok, agents} <- Agents.list_members(channel_id, user.id) do
                    {:ok, %{message: message, agents: agents, dispatches: [], notice: notice}}
                  end
              end
            end

          case result do
            {:ok, result} -> result
            {:error, error} -> Cascade.DB.Repo.rollback(error)
          end
        end)
      end)
    end
  end

  defp access(conn), do: if(conn.assigns.auth_access == "agent", do: :agent, else: :user)
  defp respond(conn, {:ok, value}, key), do: JSON.send(conn, 200, %{key => value})
  defp respond(conn, error, _key), do: domain_error(conn, error)

  defp mutation_result(conn, mutation, intent) when is_function(mutation, 0) do
    case serialized_mutation_and_emit(conn, mutation, fn
           true -> intent
           false -> nil
         end) do
      {:ok, true} -> JSON.send(conn, 200, %{success: true})
      {:ok, false} -> JSON.send(conn, 404, %{error: "Not found"})
      error -> domain_error(conn, error)
    end
  end

  defp updated(conn, mutation, vault_id, channel_id) when is_function(mutation, 0) do
    case serialized_mutation_and_emit(conn, mutation, fn message ->
           %{
             event: "vault:chatMessageUpdated",
             vaultId: vault_id,
             channelId: channel_id,
             message: message
           }
         end) do
      {:ok, message} -> JSON.send(conn, 200, %{message: message})
      error -> domain_error(conn, error)
    end
  end

  defp registration(conn, mutation, vault_id, channel_id, status)
       when is_function(mutation, 0) do
    case serialized_mutation_and_emit(conn, mutation, fn value ->
           Cascade.Chat.NextSteps.announce_pending(value.id, callback(conn, :events))

           %{
             event: "vault:chatAgentMemberUpserted",
             vaultId: vault_id,
             channelId: channel_id,
             registration: value
           }
         end) do
      {:ok, value} -> JSON.send(conn, status, %{registration: value})
      error -> domain_error(conn, error)
    end
  end

  defp serialized_create_and_emit(conn, create, intent)
       when is_function(create, 0) and is_function(intent, 1),
       do: serialized_mutation_and_emit(conn, create, intent)

  defp serialized_mutation_and_emit(conn, mutation, intent)
       when is_function(mutation, 0) and is_function(intent, 1) do
    OrderedPublisher.mutate(fn ->
      case mutation.() do
        {:ok, value} = result ->
          case intent.(value) do
            %{} = event -> OrderedPublisher.chat(callback(conn, :events), event)
            nil -> :ok
          end

          result

        error ->
          error
      end
    end)
  end

  defp callback(conn, key), do: Keyword.get(conn.assigns.domain_options, key)

  defp merger(conn),
    do:
      callback(conn, :merger) ||
        fn cwd, ref ->
          case System.cmd("git", ["-C", cwd, "merge", "--ff-only", ref], stderr_to_stdout: true) do
            {_out, 0} -> :ok
            {out, _} -> {:error, out}
          end
        end

  defp domain_error(conn, {:error, message}), do: domain_error(conn, message)

  defp domain_error(conn, message) do
    status =
      cond do
        database_unavailable?(message) ->
          503

        message in [
          "Message not found",
          "Chat channel not found",
          "Vault agent not found",
          "Agent member not found",
          "Invite not found"
        ] ->
          404

        String.starts_with?(message, "Only ") or String.contains?(message, "can only") or
            String.contains?(message, "cannot edit") ->
          403

        message == "Agent dispatch integration is unavailable" ->
          503

        true ->
          400
      end

    JSON.send(conn, status, %{error: message})
  end

  defp database_unavailable?(message) do
    normalized = message |> to_string() |> String.downcase()

    Enum.any?(
      ["database is locked", "database is busy", "connection not available"],
      &String.contains?(normalized, &1)
    )
  end

  defp error_message({:error, message}), do: to_string(message)
  defp error_message(message), do: to_string(message)

  defp source(_message, _kind, fallback), do: fallback
  defp put_domain_options(%{assigns: %{domain_options: _}} = conn, _compiled), do: conn
  defp put_domain_options(conn, options), do: assign(conn, :domain_options, options)
  defp body(conn, key, default), do: Map.get(conn.body_params, key, default)

  defp query(conn, key),
    do: conn |> fetch_query_params() |> Map.get(:query_params) |> Map.get(key)

  defp parse_number(nil), do: nil

  defp parse_number(value) do
    case Integer.parse(value) do
      {number, _} -> number
      _ -> nil
    end
  end
end
