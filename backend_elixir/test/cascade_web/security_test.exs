defmodule CascadeWeb.SecurityTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Auth.Session
  alias CascadeWeb.Security

  setup do
    previous_hops = Application.fetch_env!(:cascade_elixir, :trust_proxy_hops)
    previous_network_mode = Application.fetch_env!(:cascade_elixir, :network_mode)
    previous_origins = Application.fetch_env!(:cascade_elixir, :allowed_origins)

    on_exit(fn ->
      Application.put_env(:cascade_elixir, :trust_proxy_hops, previous_hops)
      Application.put_env(:cascade_elixir, :network_mode, previous_network_mode)
      Application.put_env(:cascade_elixir, :allowed_origins, previous_origins)
    end)
  end

  test "uses the configured right-to-left proxy hop without trusting a spoofed prefix" do
    conn =
      conn(:get, "/api/health")
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> put_req_header("x-forwarded-for", "192.0.2.10, 203.0.113.25")

    Application.put_env(:cascade_elixir, :trust_proxy_hops, 1)
    assert Security.peer_key(conn) == "203.0.113.25"

    Application.put_env(:cascade_elixir, :trust_proxy_hops, 2)
    assert Security.peer_key(conn) == "192.0.2.10"
  end

  test "ignores forwarded data when disabled or malformed" do
    conn =
      conn(:get, "/api/health")
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> put_req_header("x-forwarded-for", "not-an-ip")

    Application.put_env(:cascade_elixir, :trust_proxy_hops, 0)
    assert Security.peer_key(conn) == "127.0.0.1"

    Application.put_env(:cascade_elixir, :trust_proxy_hops, 1)
    assert Security.peer_key(conn) == "127.0.0.1"
  end

  test "network mode enforces exact CORS origins and answers allowed preflight" do
    Application.put_env(:cascade_elixir, :network_mode, true)
    Application.put_env(:cascade_elixir, :allowed_origins, ["https://cscd.online"])

    allowed =
      conn(:options, "/api/session")
      |> put_req_header("origin", "https://cscd.online")
      |> Security.call([])

    assert allowed.status == 204
    assert get_resp_header(allowed, "access-control-allow-origin") == ["https://cscd.online"]
    assert get_resp_header(allowed, "access-control-allow-credentials") == ["true"]
    assert get_resp_header(allowed, "vary") == ["Origin"]

    mobile =
      conn(:get, "/api/session")
      |> put_req_header("origin", "capacitor://localhost")
      |> Security.call([])

    assert mobile.status == nil
    assert get_resp_header(mobile, "access-control-allow-origin") == ["capacitor://localhost"]

    rejected =
      conn(:get, "/api/session")
      |> put_req_header("origin", "https://attacker.example")
      |> Security.call([])

    assert rejected.status == 403
    assert rejected.halted
    assert Jason.decode!(rejected.resp_body) == %{"error" => "Origin not allowed"}
  end

  test "network mode emits HSTS and a host-only cross-site secure session cookie" do
    Application.put_env(:cascade_elixir, :network_mode, true)

    secured =
      conn(:get, "/api/health")
      |> Map.put(:scheme, :https)
      |> Security.call([])

    assert get_resp_header(secured, "strict-transport-security") == [
             "max-age=31536000; includeSubDomains"
           ]

    [cookie] =
      conn(:get, "/")
      |> Session.put_user_cookie("signed-token")
      |> get_resp_header("set-cookie")

    assert cookie =~ "__Host-cascade_session=signed-token"
    assert cookie =~ "; Path=/"
    assert cookie =~ "; HttpOnly"
    assert cookie =~ "; Secure"
    assert cookie =~ "; SameSite=None"
    assert cookie =~ "; Priority=High"
    refute cookie =~ "Domain="

    clear_headers =
      conn(:post, "/api/auth/logout")
      |> Session.clear_user_cookies()
      |> get_resp_header("set-cookie")

    assert Enum.any?(clear_headers, &String.starts_with?(&1, "__Host-cascade_session="))
    assert Enum.any?(clear_headers, &String.starts_with?(&1, "cascade_session="))
  end

  test "active browser sessions renew before their seven-day expiry" do
    Application.put_env(:cascade_elixir, :network_mode, true)
    user = %{id: 42, username: "sol", auth_version: 0}
    now = System.system_time(:second)

    near_expiry =
      Session.maybe_renew_user_cookie(conn(:get, "/api/session"), %{
        source: :cookie,
        access: "user",
        expires_at: now + 60,
        user: user
      })

    assert [cookie] = get_resp_header(near_expiry, "set-cookie")
    assert cookie =~ "__Host-cascade_session="
    assert cookie =~ "Max-Age=604800"

    fresh =
      Session.maybe_renew_user_cookie(conn(:get, "/api/session"), %{
        source: :cookie,
        access: "user",
        expires_at: now + 6 * 24 * 60 * 60,
        user: user
      })

    assert get_resp_header(fresh, "set-cookie") == []
  end

  test "network mode refuses the legacy development JWT secret" do
    previous_secret = System.get_env("JWT_SECRET")
    Application.put_env(:cascade_elixir, :network_mode, true)
    System.put_env("JWT_SECRET", "cascade-dev-secret")

    try do
      assert_raise RuntimeError, ~r/Refusing to start in network mode/, fn ->
        Cascade.Config.jwt_secret!()
      end
    after
      System.put_env("JWT_SECRET", previous_secret)
    end
  end
end
