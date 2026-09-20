defmodule CascadeWeb.AlockRouterTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  alias Cascade.Auth.Token
  alias Cascade.Content.{Query, Store}
  @owner -8_810_001
  @other -8_810_002

  setup do
    Query.execute(
      "INSERT INTO users (id, username, password_hash, display_name, auth_version) VALUES (?, 'alock-owner', 'x', 'Owner', 0), (?, 'alock-other', 'x', 'Other', 0)",
      [@owner, @other]
    )

    vault = Store.create_vault(@owner, %{name: "Alock test"})

    on_exit(fn ->
      Store.delete_vault(vault.id, @owner)
      Query.execute("DELETE FROM users WHERE id IN (?, ?)", [@owner, @other])
    end)

    {:ok, vault: vault}
  end

  defp request(vault, user, access \\ :user) do
    identity = %{
      id: user,
      username: if(user == @owner, do: "alock-owner", else: "alock-other"),
      auth_version: 0
    }

    token = if access == :agent, do: Token.sign_agent(identity), else: Token.sign_user(identity)

    conn(:post, "/api/vaults/#{vault.id}/alock/lock", "invalid-dtob")
    |> put_req_header("authorization", "Bearer " <> token)
    |> put_req_header("content-type", "application/vnd.dtob")
    |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
  end

  test "write capability and vault membership are required before forwarding", %{vault: vault} do
    assert request(vault, @other).status == 403
    assert request(vault, @owner, :agent).status == 403

    unauthorized =
      conn(:post, "/api/vaults/#{vault.id}/alock/lock", "invalid-dtob")
      |> put_req_header("content-type", "application/vnd.dtob")
      |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))

    assert unauthorized.status == 401
  end

  @tag skip: is_nil(System.get_env("FIZZER_ALOCK_BIN"))
  test "DTOB requests reach the same persistent native HTTP daemon", %{vault: vault} do
    first = request(vault, @owner)
    assert first.status == 400
    assert get_resp_header(first, "content-type") == ["application/vnd.dtob; charset=utf-8"]
    endpoint = :sys.get_state(Cascade.Alock)[vault.id]
    assert is_port(endpoint.port)
    assert request(vault, @owner).status == 400
    assert :sys.get_state(Cascade.Alock)[vault.id].port == endpoint.port
    assert Port.info(endpoint.port, :os_pid)
  end
end
