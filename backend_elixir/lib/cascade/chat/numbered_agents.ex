defmodule Cascade.Chat.NumberedAgents do
  @moduledoc "Persistent numbered profiles. Only original profiles reserve numeric prefixes."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Schema}

  def annotate(agents) do
    ids = Enum.map(agents, &Map.get(&1, :vaultAgentId, &1.id))
    placeholders = Enum.map_join(ids, ",", fn _ -> "?" end)

    parents =
      SQL.all(
        "SELECT identity_id,base_identity_id FROM chat_agent_instances WHERE identity_id IN (#{placeholders})",
        ids
      )
      |> Map.new(fn [id, base] -> {id, base} end)

    Enum.map(
      agents,
      &Map.put(&1, :instanceOf, Map.get(parents, Map.get(&1, :vaultAgentId, &1.id)))
    )
  end

  # Called inside the profile-write transaction. Rename generated identities,
  # never reuse them: their registrations, provider sessions and messages stay
  # attached to their original IDs while the new original gets fresh IDs.
  def reserve_original(user_id, vault_id, id, mention, opts) do
    if opts[:instance] || SQL.one("SELECT 1 FROM chat_agent_instances WHERE identity_id=?", [id]) do
      :ok
    else
      with {:ok, profiles} <- Agents.list_vault(user_id, vault_id) do
        profiles = Enum.map(profiles, &Map.put(&1, :vaultAgentId, &1.id))
        originals = profiles |> Enum.reject(&(&1[:instanceOf] || &1.id == id))
        new = %{id: id, vaultAgentId: id, mention: mention, agentId: mention, instanceOf: nil}
        originals = [new | originals]

        displaced =
          Enum.filter(profiles, fn profile ->
            if profile[:instanceOf] do
              case resolve(profile.mention, originals) do
                {:instance, base, _} -> base.id != profile.instanceOf
                :unknown -> false
                _ -> true
              end
            else
              false
            end
          end)

        if Enum.any?(profiles, &(&1.id != id && &1.mention == mention && !&1[:instanceOf])) ||
             Enum.any?(displaced, &(&1.ownerUserId != user_id)) do
          {:error, "Mention @#{mention} is already used by another agent"}
        else
          occupied = MapSet.new([mention | Enum.map(profiles, & &1.mention)])

          Enum.reduce(displaced, occupied, fn profile, used ->
            base =
              Enum.find(originals, &(&1.id == profile.instanceOf)) ||
                Enum.find(profiles, &(&1.id == profile.instanceOf))

            if base do
              number =
                Stream.iterate(2, &(&1 + 1))
                |> Enum.find(fn n ->
                  handle = base.mention <> Integer.to_string(n)

                  case resolve(handle, originals) do
                    {:instance, candidate, _} ->
                      candidate.id == base.id && !MapSet.member?(used, handle) &&
                        is_nil(
                          SQL.one(
                            "SELECT 1 FROM chat_agent_instances WHERE base_identity_id=? AND instance_number=? AND identity_id!=?",
                            [base.id, Integer.to_string(n), profile.id]
                          )
                        )

                    _ ->
                      false
                  end
                end)

              handle = base.mention <> Integer.to_string(number)

              SQL.exec(
                "UPDATE vault_agents SET mention=?,updated_at=datetime('now') WHERE id=?",
                [handle, profile.id]
              )

              SQL.exec(
                "UPDATE chat_agent_members SET mention=?,updated_at=datetime('now') WHERE vault_agent_id=?",
                [handle, profile.id]
              )

              SQL.exec("UPDATE chat_agent_instances SET instance_number=? WHERE identity_id=?", [
                Integer.to_string(number),
                profile.id
              ])

              MapSet.put(used, handle)
            else
              used
            end
          end)

          :ok
        end
      end
    end
  end

  def ensure(user_id, channel_id, text) do
    SQL.transaction(fn ->
      with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
           {:ok, members} <- Agents.list_members(channel_id, user_id) do
        handles =
          Regex.scan(~r/(?<![\w@])@\s*([a-z0-9_-]+)(?=$|[\s.,:;!?\])}])/iu, text,
            capture: :all_but_first
          )
          |> List.flatten()
          |> Enum.map(&String.downcase/1)
          |> Enum.uniq()

        Enum.reduce_while(handles, {:ok, members}, fn handle, {:ok, current} ->
          case resolve(handle, current) do
            {:instance, base, number} when base.ownerUserId == user_id ->
              case materialize(user_id, route, base, number, handle) do
                {:ok, member} -> {:cont, {:ok, current ++ [member]}}
                error -> {:halt, error}
              end

            {:unavailable, _base} ->
              {:halt, {:error, "@#{handle} is unavailable; numbered agents start at 2"}}

            _ ->
              {:cont, {:ok, current}}
          end
        end)
      end
    end)
  end

  def resolve(handle, members) do
    originals = Enum.reject(members, & &1[:instanceOf])
    exact = Enum.find(members, &(Schema.normalize_mention(&1.mention, &1.agentId) == handle))

    if exact && !exact[:instanceOf] do
      {:existing, exact}
    else
      candidate =
        originals
        |> Enum.sort_by(&(-String.length(&1.mention)))
        |> Enum.find(fn member ->
          prefix = Schema.normalize_mention(member.mention, member.agentId)

          String.starts_with?(handle, prefix) &&
            Regex.match?(~r/^[1-9][0-9]*$/, String.replace_prefix(handle, prefix, ""))
        end)

      case candidate do
        nil ->
          if exact, do: {:existing, exact}, else: :unknown

        base ->
          number =
            String.replace_prefix(
              handle,
              Schema.normalize_mention(base.mention, base.agentId),
              ""
            )

          cond do
            number == "1" -> {:unavailable, base}
            exact && exact[:instanceOf] == base.vaultAgentId -> {:existing, exact}
            exact -> {:unavailable, base}
            true -> {:instance, base, number}
          end
      end
    end
  end

  defp materialize(user_id, route, base, number, handle) do
    with {:ok, profiles} <- Agents.list_vault(user_id, route.localVaultId) do
      existing = Enum.find(profiles, &(&1.ownerUserId == user_id && &1.mention == handle))

      identity =
        if existing do
          {:ok, existing}
        else
          input =
            Map.take(base, [
              :agentId,
              :avatarUrl,
              :color,
              :model,
              :cwd,
              :contextPrompt,
              :hermesProfile,
              :hermesSafeMode
            ])
            |> Map.merge(%{
              mention: handle,
              displayName: "#{base.displayName} #{number}",
              identityScope: "vault"
            })

          with {:ok, profile} <-
                 Agents.upsert_identity(user_id, route.localVaultId, input, instance: true) do
            SQL.exec(
              "INSERT INTO chat_agent_instances(identity_id,base_identity_id,instance_number) VALUES(?,?,?)",
              [profile.id, base.vaultAgentId, number]
            )

            {:ok, profile}
          end
        end

      with {:ok, profile} <- identity do
        # Each instance gets a new provider conversation. Automatic room-wide
        # coordinator/ambient roles remain on the original; copies are invoked by name.
        flags =
          Map.take(base, [
            :reasoningEffort,
            :priorityServiceTier,
            :taggableByAgents,
            :pingableByOthers,
            :finalReplyOnly,
            :yolo
          ])

        Agents.add_to_channel(
          user_id,
          route.localVaultId,
          route.localChannelId,
          profile.id,
          flags
        )
      end
    end
  end
end
