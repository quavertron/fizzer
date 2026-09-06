defmodule CascadeWeb.Authorization do
  @moduledoc "Shared agent capabilities and mutation-policy hooks for authenticated controllers."

  @safe_methods ["GET", "HEAD", "OPTIONS"]
  @agent_rules [
    {~w(GET PUT), ~r<^/api/app-context$>},
    {~w(GET), ~r<^/api/vaults$>},
    {~w(GET), ~r<^/api/vaults/[^/]+$>},
    {~w(GET), ~r<^/api/vaults/[^/]+/(?:folders|notes|search|tags)$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/folders$>},
    {~w(PATCH), ~r<^/api/folders/[^/]+$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/notes$>},
    {~w(GET PUT), ~r<^/api/vaults/[^/]+/agent-memory$>},
    {~w(GET POST), ~r<^/api/vaults/[^/]+/scratchpad(?:/[^/]+)*(?:/close)?$>},
    {~w(GET POST PATCH), ~r<^/api/vaults/[^/]+/channels/[^/]+/messages(?:/[^/]+)?$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/channels/[^/]+/messages/[^/]+/collaborate$>},
    {~w(GET), ~r<^/api/vaults/[^/]+/channels/[^/]+/agents$>},
    {~w(GET PUT), ~r<^/api/vaults/[^/]+/vault-agents$>},
    {~w(GET DELETE), ~r<^/api/vaults/[^/]+/vault-agents/[^/]+$>},
    {~w(PUT), ~r<^/api/vaults/[^/]+/channels/[^/]+/agents$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/channels/[^/]+/agents/from-vault$>},
    {~w(DELETE), ~r<^/api/vaults/[^/]+/channels/[^/]+/agents/[^/]+$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions$>},
    {~w(GET), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions$>},
    {~w(GET), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/[^/]+$>},
    {~w(GET), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/[^/]+/(?:history|interpretation)$>},
    {~w(POST),
     ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/[^/]+/(?:tasks|finish|children|interpretation)$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/children/join$>},
    {~w(PATCH), ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/tasks/[^/]+$>},
    {~w(POST),
     ~r<^/api/vaults/[^/]+/channels/[^/]+/missions/tasks/[^/]+/(?:steer|recovery-evidence)$>},
    {~w(POST), ~r<^/api/vaults/[^/]+/channels/[^/]+/distill$>},
    {~w(PUT), ~r<^/api/vaults/[^/]+/channels/[^/]+/agents/[^/]+/avatar$>},
    {~w(GET PUT DELETE), ~r<^/api/notes/[^/]+$>},
    {~w(POST), ~r<^/api/notes/[^/]+/(?:rename|move|unlist|pin|archive|orbit-caption)$>},
    {~w(POST DELETE), ~r<^/api/notes/[^/]+/tags(?:/[^/]+)?$>},
    {~w(GET), ~r<^/api/notes/[^/]+/backlinks$>},
    {~w(GET), ~r<^/api/notes/[^/]+/assets/[^/]+$>}
  ]

  def agent_route_allowed?(method, path) do
    method = String.upcase(method)

    Enum.any?(@agent_rules, fn {methods, pattern} ->
      method in methods and Regex.match?(pattern, path)
    end)
  end

  def mutation?(method), do: String.upcase(method) not in @safe_methods

  def authorize_mutation(_session, _conn, :not_vault_scoped), do: :ok

  def authorize_mutation(session, conn, gate) when is_function(gate, 2) do
    case gate.(session, conn) do
      :ok ->
        :ok

      {:error, status, message} when is_integer(status) and is_binary(message) ->
        {:error, status, message}

      unexpected ->
        raise ArgumentError, "mutation gate returned invalid result: #{inspect(unexpected)}"
    end
  end

  def authorize_mutation(_session, _conn, nil),
    do: {:error, 500, "Mutation authorization policy is missing"}

  def sanitize_agent_json(value), do: Cascade.Privacy.sanitize_agent_json(value)
end
