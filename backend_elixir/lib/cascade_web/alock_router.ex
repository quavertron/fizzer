defmodule CascadeWeb.AlockRouter do
  @moduledoc "Authenticated DTOB forwarding to persistent native alock HTTP daemons."
  use CascadeWeb.DomainDispatch
  alias Cascade.Content.Store
  alias CascadeWeb.{Auth, JSON}

  plug :match
  plug :dispatch

  post "/api/vaults/:id/alock/:operation" do
    gate = fn session, _ ->
      if Store.vault_role(id, session.user.id) in ["owner", "editor"],
        do: :ok,
        else: {:error, 403, "Vault write access required"}
    end

    case Auth.require(conn, access: :user, mutation_gate: gate) do
      {:ok, conn} ->
        cond do
          operation not in ~w(lock commit conclude heartbeat release activity) ->
            JSON.send(conn, 404, %{error: "Unknown alock operation"})

          get_req_header(conn, "content-type") != ["application/vnd.dtob"] ->
            JSON.send(conn, 415, %{error: "DTOB content type required"})

          true ->
            case read_body(conn,
                   length: 16 * 1_024 * 1_024,
                   read_length: 16 * 1_024 * 1_024,
                   read_timeout: 10_000
                 ) do
              {:ok, body, conn} ->
                vault = Store.get_vault(id, conn.assigns.current_user.id)

                case Cascade.Alock.forward(vault, conn.assigns.current_user.id, operation, body) do
                  {:ok, status, response} ->
                    if operation in ["commit", "conclude"] and status == 200 do
                      Cascade.Realtime.Events.vault_event(id, "vault:filesChanged", %{vaultId: id})
                    end

                    conn
                    |> put_resp_content_type("application/vnd.dtob")
                    |> send_resp(status, response)

                  {:error, _} ->
                    JSON.send(conn, 502, %{
                      error: "Alock daemon unavailable; verify commit outcome before retrying"
                    })
                end

              {:more, _, conn} ->
                JSON.send(conn, 413, %{error: "DTOB request too large"})

              {:error, _} ->
                JSON.send(conn, 400, %{error: "Cannot read DTOB request"})
            end
        end

      {:error, conn} ->
        conn
    end
  end

  match _ do
    JSON.send(conn, 404, %{error: "Not found"})
  end
end
