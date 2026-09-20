defmodule CascadeWeb.MirrorRouterTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  alias Cascade.Auth.Token
  alias Cascade.Content.{Query, Store}
  @owner -8_820_001
  @other -8_820_002

  setup do
    Query.execute(
      "INSERT INTO users (id, username, password_hash, display_name, auth_version) VALUES (?, 'mirror-owner', 'x', 'Owner', 0), (?, 'mirror-other', 'x', 'Other', 0)",
      [@owner, @other]
    )

    vault = Store.create_vault(@owner, %{name: "Mirror test"})
    File.mkdir_p!(vault.root_path)
    File.write!(Path.join(vault.root_path, "hello & world.txt"), "original\n")
    File.write!(Path.join(vault.root_path, "note.pending-rejected"), "rejected")
    File.mkdir_p!(Path.join(vault.root_path, "folder"))
    File.ln_s!("/etc", Path.join(vault.root_path, "escape"))

    on_exit(fn ->
      Store.delete_vault(vault.id, @owner)
      Query.execute("DELETE FROM users WHERE id IN (?, ?)", [@owner, @other])
    end)

    {:ok, vault: vault}
  end

  defp request(vault, suffix, method \\ :get, user \\ @owner, access \\ :user) do
    identity = %{
      id: user,
      username: if(user == @owner, do: "mirror-owner", else: "mirror-other"),
      auth_version: 0
    }

    token = if access == :agent, do: Token.sign_agent(identity), else: Token.sign_user(identity)

    conn(method, "/api/vaults/#{vault.id}/mirror/" <> suffix)
    |> put_req_header("authorization", "Bearer " <> token)
    |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
  end

  test "rclone can list and read files, including HEAD metadata", %{vault: vault} do
    listing = request(vault, "")
    assert listing.status == 200
    assert listing.resp_body =~ "hello%20%26%20world.txt"
    assert listing.resp_body =~ "folder/"
    refute listing.resp_body =~ "escape"
    refute listing.resp_body =~ "pending"
    assert request(vault, "hello%20%26%20world.txt").resp_body == "original\n"
    head = request(vault, "hello%20%26%20world.txt", :head)
    assert head.status == 200
    assert get_resp_header(head, "content-length") == ["9"]
    assert get_resp_header(head, "last-modified") != []
  end

  test "no uploads, cross-vault access, symlink escape, or rejected proposals", %{vault: vault} do
    assert request(vault, "", :get, @other).status == 403
    assert request(vault, "", :get, @owner, :agent).status == 403
    assert request(vault, "escape/passwd").status == 404
    assert request(vault, "%2E%2E/etc/passwd").status == 404
    assert request(vault, "note.pending-rejected").status == 404
    assert request(vault, "hello%20%26%20world.txt", :put).status == 404
    assert File.read!(Path.join(vault.root_path, "hello & world.txt")) == "original\n"
  end

  @tag skip: is_nil(System.get_env("FIZZER_RCLONE_BIN"))
  @tag timeout: 30_000
  test "real rclone consumes the existing vault socket and catches up after reconnect", %{
    vault: vault
  } do
    File.write!(Path.join(vault.root_path, "mirror-probe.txt"), "one")
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, {_, port}} = :inet.sockname(listener)
    :gen_tcp.close(listener)

    start_supervised!(
      {Bandit, plug: CascadeWeb.Router, scheme: :http, ip: {127, 0, 0, 1}, port: port}
    )

    token = Token.sign_user(%{id: @owner, username: "mirror-owner", auth_version: 0})
    script = Path.expand("../../../scripts/test-vault-mirror.cjs", __DIR__)

    node =
      Port.open({:spawn_executable, System.find_executable("node")}, [
        :binary,
        :exit_status,
        {:line, 8192},
        args: [script, "http://127.0.0.1:#{port}", token, vault.id]
      ])

    on_exit(fn -> if Port.info(node), do: Port.close(node) end)
    assert receive_json(node) == %{"ready" => true}
    File.write!(Path.join(vault.root_path, "mirror-probe.txt"), "two")
    Cascade.Realtime.Events.vault_event(vault.id, "vault:filesChanged", %{vaultId: vault.id})
    assert receive_json(node) == %{"disconnected" => true}
    File.write!(Path.join(vault.root_path, "mirror-probe.txt"), "tri")
    Cascade.Realtime.Events.vault_event(vault.id, "vault:filesChanged", %{vaultId: vault.id})
    Port.command(node, "reconnect\n")
    assert receive_json(node) == %{"done" => true}
  end

  defp receive_json(port) do
    receive do
      {^port, {:data, {:eol, line}}} -> Jason.decode!(line)
      {^port, {:exit_status, status}} -> flunk("Mirror client exited: #{status}")
    after
      15_000 -> flunk("Mirror client did not respond")
    end
  end
end
