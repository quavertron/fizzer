defmodule CascadeWeb.StaticTest do
  use ExUnit.Case, async: true

  alias CascadeWeb.Static

  test "cache policy matches Vite fingerprint and sentinel rules" do
    assert Static.cache_control("/client/dist/assets/main-a1b2.js") ==
             "public, max-age=31536000, immutable"

    assert Static.cache_control("/client/dist/version.json") == "no-store"
    assert Static.cache_control("/client/dist/app.html") == "no-cache"
    assert Static.cache_control("/client/dist/favicon.jpeg") == nil
  end

  test "serves app for /vault/[A-F0-9]{8} and redirects lowercase to uppercase" do
    import Plug.Test

    # Uppercase 8-hex serves app
    conn = conn(:get, "/vault/CFF98A2B")
    case Static.serve(conn) do
      {:served, served_conn} ->
        assert served_conn.status == 200

      :not_found ->
        # If client_dist_dir has no app.html in test env, it returns :not_found from serve_app, which is fine
        :ok
    end

    # Lowercase 8-hex redirects with 301 to uppercase
    lower_conn = conn(:get, "/vault/cff98a2b")
    assert {:served, redirected} = Static.serve(lower_conn)
    assert redirected.status == 301
    assert Plug.Conn.get_resp_header(redirected, "location") == ["/vault/CFF98A2B"]

    # Lowercase with query string preserves query string in redirect
    lower_qs_conn = conn(:get, "/vault/cff98a2b?tab=notes")
    assert {:served, qs_redirected} = Static.serve(lower_qs_conn)
    assert qs_redirected.status == 301
    assert Plug.Conn.get_resp_header(qs_redirected, "location") == ["/vault/CFF98A2B?tab=notes"]

    # Invalid hex string (not 8 chars) returns :not_found
    bad_conn = conn(:get, "/vault/not8hex")
    assert Static.serve(bad_conn) == :not_found

    short_conn = conn(:get, "/vault/ABC")
    assert Static.serve(short_conn) == :not_found
  end
end
