defmodule CascadeWeb.RouterTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  import Cascade.TestHelpers

  alias Cascade.Auth.{Password, Token}
  alias Cascade.DB.Repo
  alias CascadeWeb.{Auth, JSON}
  alias Ecto.Adapters.SQL

  @options CascadeWeb.Router.init([])
  @username "router-sol"
  @user_id -9_000_000_000

  setup_all do
    {:ok, hash} = Password.hash("correct horse battery staple")

    SQL.query!(
      Repo,
      """
      INSERT INTO users (id, username, password_hash, display_name, avatar_url)
      VALUES (?, ?, ?, ?, ?)
      """,
      [@user_id, @username, hash, "Sol", ""]
    )

    on_exit(fn ->
      SQL.query!(Repo, "DELETE FROM users WHERE id = ? AND username = ?", [@user_id, @username])
    end)

    {:ok, user_id: @user_id}
  end

  test "health checks SQLite and preserves the response body contract" do
    conn = request(:get, "/api/health")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"status" => "ok"}
  end

  test "login issues the legacy-compatible bearer and HttpOnly cookie", %{user_id: user_id} do
    conn =
      request(:post, "/api/auth/login", %{
        username: "ROUTER-SOL",
        password: "correct horse battery staple"
      })

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    assert body["user"] == %{
             "id" => user_id,
             "username" => @username,
             "displayName" => "Sol",
             "avatarUrl" => ""
           }

    assert body["owner"]
    assert is_binary(body["token"])

    assert [cookie] = get_resp_header(conn, "set-cookie")
    assert cookie =~ "cascade_session="
    assert cookie =~ "HttpOnly"
    assert cookie =~ "SameSite=Lax"
    assert cookie =~ "Priority=High"

    me =
      conn(:get, "/api/me")
      |> put_req_header("authorization", "Bearer #{body["token"]}")
      |> CascadeWeb.Router.call(@options)

    assert me.status == 200
    assert Jason.decode!(me.resp_body)["user"]["username"] == @username
  end

  test "browser login keeps the bearer out of JSON" do
    conn =
      conn(
        :post,
        "/api/auth/login",
        Jason.encode!(%{username: @username, password: "correct horse battery staple"})
      )
      |> put_req_header("content-type", "application/json")
      |> put_req_header("x-cascade-browser", "1")
      |> CascadeWeb.Router.call(@options)

    refute Map.has_key?(Jason.decode!(conn.resp_body), "token")
  end

  test "session is false for an invalid token" do
    conn =
      conn(:get, "/api/session")
      |> put_req_header("authorization", "Bearer invalid")
      |> CascadeWeb.Router.call(@options)

    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"authenticated" => false}
  end

  test "cookie-authenticated mutations require the browser CSRF header" do
    conn =
      conn(:post, "/api/auth/logout")
      |> put_req_header("cookie", "cascade_session=not-even-valid")
      |> CascadeWeb.Router.call(@options)

    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["error"] =~ "CSRF"
  end

  test "mounted API routes enforce their boundary while unknown routes are absent" do
    mounted = request(:get, "/api/vaults")
    assert mounted.status == 401

    conn = request(:get, "/api/not-yet-ported")
    assert conn.status == 404
    assert Jason.decode!(conn.resp_body) == %{"error" => "Not found"}
  end

  test "native Engine.IO rejects old clients before namespace handling" do
    conn = request(:get, "/socket.io/?EIO=3&transport=polling")
    assert conn.status == 400

    assert Jason.decode!(conn.resp_body) == %{
             "code" => 5,
             "message" => "Unsupported protocol version"
           }
  end

  test "shared auth boundary assigns identity and redacts agent JSON", %{user_id: user_id} do
    token = Token.sign_agent(%{id: user_id, username: @username, auth_version: 0})

    conn =
      conn(:get, "/api/vaults")
      |> put_req_header("authorization", "Bearer #{token}")

    assert {:ok, authenticated} = Auth.require(conn)
    assert authenticated.assigns.current_user.id == user_id
    assert authenticated.assigns.auth_access == "agent"
    assert authenticated.assigns.auth_source == :bearer

    response =
      JSON.send(authenticated, 200, %{
        content: "before\n:::private\nsecret 🚀\n:::\nafter",
        content_preview: "visible :::private secret"
      })

    body = Jason.decode!(response.resp_body)
    refute body["content"] =~ "secret"
    assert body["content"] =~ "id=p105qmdv-1"
    assert body["content_preview"] == "visible [Private block hidden from agents]"
  end

  test "shared auth boundary denies agent routes outside its capability list", %{user_id: user_id} do
    token = Token.sign_agent(%{id: user_id, username: @username, auth_version: 0})

    conn =
      conn(:get, "/api/me")
      |> put_req_header("authorization", "Bearer #{token}")

    assert {:error, rejected} = Auth.require(conn)
    assert rejected.status == 403
  end

  test "agent credentials can manage a vault-local agent roster but cannot delete global profiles",
       %{
         user_id: user_id
       } do
    token = Token.sign_agent(%{id: user_id, username: @username, auth_version: 0})

    for {method, path} <- [
          {:get, "/api/vaults/v1/vault-agents"},
          {:put, "/api/vaults/v1/vault-agents"},
          {:delete, "/api/vaults/v1/vault-agents/a1"},
          {:put, "/api/vaults/v1/channels/c1/agents"},
          {:post, "/api/vaults/v1/channels/c1/agents/from-vault"},
          {:delete, "/api/vaults/v1/channels/c1/agents/r1"}
        ] do
      conn = conn(method, path) |> put_req_header("authorization", "Bearer #{token}")

      options =
        if method == :get,
          do: [],
          else: [mutation_gate: fn _session, _request -> :ok end]

      assert {:ok, _authorized} = Auth.require(conn, options)
    end

    profile =
      conn(:delete, "/api/vaults/v1/vault-agents/a1/profile")
      |> put_req_header("authorization", "Bearer #{token}")

    assert {:error, rejected} =
             Auth.require(profile, mutation_gate: fn _session, _request -> :ok end)

    assert rejected.status == 403
  end

  test "shared auth boundary requires an explicit mutation policy", %{user_id: user_id} do
    token = Token.sign_user(%{id: user_id, username: @username, auth_version: 0})

    conn =
      conn(:post, "/api/vaults/v1/folders")
      |> put_req_header("authorization", "Bearer #{token}")

    assert {:error, missing_policy} = Auth.require(conn)
    assert missing_policy.status == 500

    assert {:error, viewer_denied} =
             Auth.require(conn,
               mutation_gate: fn _session, _request ->
                 {:error, 403, "Viewer role cannot modify this vault"}
               end
             )

    assert viewer_denied.status == 403
  end

  test "serves fingerprinted assets and SPA routes with compatible caching" do
    root = Path.join(System.tmp_dir!(), "cascade-static-#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(root, "assets"))
    File.write!(Path.join(root, "app.html"), "<main>app</main>")
    File.write!(Path.join(root, "landing.html"), "<main>landing</main>")
    File.write!(Path.join(root, "assets/main-abc.js"), "console.log('ok')")

    previous = Application.fetch_env!(:cascade_elixir, :client_dist_dir)
    Application.put_env(:cascade_elixir, :client_dist_dir, root)

    on_exit(fn ->
      Application.put_env(:cascade_elixir, :client_dist_dir, previous)
      File.rm_rf!(root)
    end)

    landing = request(:get, "/")
    assert landing.status == 200
    assert landing.resp_body == "<main>landing</main>"
    assert get_resp_header(landing, "cache-control") == ["no-cache"]

    asset = request(:get, "/assets/main-abc.js")
    assert asset.status == 200
    assert get_resp_header(asset, "cache-control") == ["public, max-age=31536000, immutable"]

    spa = request(:get, "/app/channel/123")
    assert spa.status == 200
    assert spa.resp_body == "<main>app</main>"
  end

  test "serves an isolated beta SPA without changing production assets" do
    root = Path.join(System.tmp_dir!(), "cascade-static-#{System.unique_integer([:positive])}")

    beta_root =
      Path.join(System.tmp_dir!(), "cascade-beta-static-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(root, "assets"))
    File.mkdir_p!(Path.join(beta_root, "assets"))
    File.write!(Path.join(root, "app.html"), "<main>production</main>")
    File.write!(Path.join(beta_root, "app.html"), "<main>beta</main>")
    File.write!(Path.join(beta_root, "assets/main-beta.js"), "console.log('beta')")

    previous_root = Application.fetch_env!(:cascade_elixir, :client_dist_dir)
    previous_beta = Application.get_env(:cascade_elixir, :beta_client_dist_dir)
    Application.put_env(:cascade_elixir, :client_dist_dir, root)
    Application.put_env(:cascade_elixir, :beta_client_dist_dir, beta_root)

    on_exit(fn ->
      Application.put_env(:cascade_elixir, :client_dist_dir, previous_root)
      Application.put_env(:cascade_elixir, :beta_client_dist_dir, previous_beta)
      File.rm_rf!(root)
      File.rm_rf!(beta_root)
    end)

    assert request(:get, "/app").resp_body == "<main>production</main>"
    assert request(:get, "/beta/").resp_body == "<main>beta</main>"
    assert request(:get, "/beta/channel/123").resp_body == "<main>beta</main>"

    asset = request(:get, "/beta/assets/main-beta.js")
    assert asset.resp_body == "console.log('beta')"
    assert get_resp_header(asset, "cache-control") == ["public, max-age=31536000, immutable"]
  end

  defp request(method, path, body \\ nil) do
    json_conn(method, path, body) |> CascadeWeb.Router.call(@options)
  end
end
