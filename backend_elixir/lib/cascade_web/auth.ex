defmodule CascadeWeb.Auth do
  @moduledoc "Reusable fail-closed authentication boundary for all HTTP domain ports."

  import Plug.Conn

  alias Cascade.Auth.Session
  alias CascadeWeb.{Authorization, JSON}

  def init(options), do: options

  def call(conn, options) do
    case __MODULE__.require(conn, options) do
      {:ok, conn} -> conn
      {:error, conn} -> conn
    end
  end

  @doc """
  Authenticates bearer first, then session cookies, and assigns
  `:current_user`, `:auth_access`, `:auth_source`, and `:auth_token`.

  Mutating controllers must pass `mutation_gate: :not_vault_scoped` or a
  two-argument vault policy function. Omitting it fails closed.
  """
  @spec require(Plug.Conn.t(), keyword()) :: {:ok, Plug.Conn.t()} | {:error, Plug.Conn.t()}
  def require(conn, options \\ []) do
    required_access = Keyword.get(options, :access, :any)

    with {:ok, session} <-
           Session.authenticate(conn, token_renewal: Keyword.get(options, :token_renewal, false)),
         :ok <- authorize_access(session, required_access, conn),
         :ok <- authorize_mutation(session, conn, Keyword.get(options, :mutation_gate)),
         :ok <- authorize_agent_delegation(session, conn) do
      conn =
        conn
        |> assign(:current_user, session.user)
        |> assign(:auth_access, session.access)
        |> assign(:auth_source, session.source)
        |> assign(:auth_token, session.token)
        |> assign(:agent_source, session.agent_source)
        |> bind_agent_run(session)
        |> Session.maybe_renew_user_cookie(session)
        |> maybe_migrate_bearer(session)
        |> maybe_register_agent_redaction(session)

      {:ok, conn}
    else
      {:error, :invalid_or_expired} -> reject(conn, 401, "Invalid or expired token")
      {:error, status, message} -> reject(conn, status, message)
    end
  end

  def source_options(conn) do
    case conn.assigns[:agent_source] do
      %{"registrationId" => registration} -> [source_registration: registration]
      _ -> if(conn.assigns.auth_access == "agent", do: [source_registration: nil], else: [])
    end
  end

  defp authorize_agent_delegation(%{access: "agent"} = session, conn) do
    source = session.agent_source
    params = if is_map(conn.body_params), do: conn.body_params, else: %{}
    mutation = Authorization.mutation?(conn.method)

    invocation =
      mutation and
        (Regex.match?(~r{/missions(?:/[^/]+/(?:tasks|children))?$}, conn.request_path) or
           Regex.match?(~r{/messages(?:/[^/]+(?:/collaborate)?)?$}, conn.request_path) or
           (String.contains?(conn.request_path, "/missions/tasks/") and
              is_binary(params["status"]) and String.trim(params["status"]) == "pending"))

    cond do
      mutation and Regex.match?(~r{/(?:vault-agents|agents)(?:/|$)}, conn.request_path) and
          protected_setting?(params) ->
        {:error, 403,
         "Only the human owner can edit delegation and automatic invocation settings"}

      mutation and String.contains?(conn.request_path, "/messages") and
          params["missionTaskId"] not in [nil, ""] ->
        {:error, 403, "Mission task attribution is server-owned"}

      invocation and not Regex.match?(~r{/messages(?:/[^/]+)?$}, conn.request_path) and
          not is_map(source) ->
        {:error, 403, "Delegated invocation requires a run-bound agent credential"}

      is_map(source) and
          Cascade.Chat.Delegation.run_source(session.user.id, source["runId"]) != source ->
        {:error, 403, "Agent credential source is no longer valid"}

      is_map(source) and not source_matches?(source, conn, params) ->
        {:error, 403, "Agent attribution does not match its credential"}

      invocation and not String.contains?(conn.request_path, "/messages") and
          not Cascade.Chat.Delegation.enabled?(source["registrationId"]) ->
        {:error, 403, Cascade.Chat.Delegation.reason()}

      true ->
        :ok
    end
  end

  defp authorize_agent_delegation(_, _), do: :ok

  defp protected_setting?(map) when is_map(map) do
    Enum.any?(map, fn {key, value} ->
      to_string(key) in ~w(missionsEnabled missions_enabled orchestrator nextStepSuggestions next_step_suggestions) or
        protected_setting?(value)
    end)
  end

  defp protected_setting?(list) when is_list(list), do: Enum.any?(list, &protected_setting?/1)
  defp protected_setting?(_), do: false

  defp source_matches?(source, conn, params) do
    header = get_req_header(conn, "x-cascade-run-id")

    (header == [] or header == [to_string(source["runId"])]) and
      Enum.all?(["registrationId", "coordinatorRegistrationId"], fn key ->
        case params[key] do
          value when value in [nil, ""] ->
            true

          registration ->
            Cascade.Accounts.SQL.one("SELECT vault_agent_id FROM chat_agent_members WHERE id=?", [
              registration
            ]) == [source["vaultAgentId"]]
        end
      end)
  end

  defp bind_agent_run(conn, %{access: "agent", agent_source: %{"runId" => run}}),
    do: put_req_header(conn, "x-cascade-run-id", to_string(run))

  defp bind_agent_run(conn, _), do: conn

  defp authorize_access(%{access: "agent"}, :user, _conn),
    do: {:error, 403, "This operation requires user access"}

  defp authorize_access(%{access: "user"}, :agent, _conn),
    do: {:error, 403, "This operation requires agent access"}

  defp authorize_access(%{access: "agent"}, _required, conn) do
    if Authorization.agent_route_allowed?(conn.method, conn.request_path) do
      :ok
    else
      {:error, 403, "This operation requires user access"}
    end
  end

  defp authorize_access(_session, _required, _conn), do: :ok

  defp authorize_mutation(session, conn, mutation_gate) do
    if Authorization.mutation?(conn.method) do
      Authorization.authorize_mutation(session, conn, mutation_gate)
    else
      :ok
    end
  end

  defp maybe_migrate_bearer(conn, %{source: :bearer, access: "user", token: token}) do
    if get_req_header(conn, "x-cascade-session-migrate") == ["1"] do
      Session.put_user_cookie(conn, token)
    else
      conn
    end
  end

  defp maybe_migrate_bearer(conn, _session), do: conn

  defp maybe_register_agent_redaction(conn, %{access: "agent"}) do
    register_before_send(conn, fn response ->
      case get_resp_header(response, "content-type") do
        ["application/json" <> _parameters] -> redact_json_response(response)
        _ -> response
      end
    end)
  end

  defp maybe_register_agent_redaction(conn, _session), do: conn

  defp redact_json_response(%Plug.Conn{resp_body: body} = conn) when is_binary(body) do
    with {:ok, decoded} <- Jason.decode(body),
         {:ok, encoded} <- Jason.encode(Authorization.sanitize_agent_json(decoded)) do
      conn
      |> delete_resp_header("content-length")
      |> Map.put(:resp_body, encoded)
    else
      _ -> conn
    end
  end

  defp redact_json_response(conn), do: conn

  defp reject(conn, status, message) do
    conn = conn |> JSON.send(status, %{error: message}) |> halt()
    {:error, conn}
  end
end
