defmodule CascadeWeb.VoiceHtmlFixtureRouter do
  import Plug.Conn
  def init(opts), do: opts

  def call(%{request_path: "/fixture/revoke"} = conn, _) do
    %{key: key, vault: vault, user: user} =
      Application.fetch_env!(:cascade_elixir, :voice_fixture)

    if get_req_header(conn, "x-fixture-key") == [key] do
      Cascade.Accounts.SQL.exec("DELETE FROM vault_members WHERE vault_id=? AND user_id=?", [
        vault,
        user
      ])

      send_resp(conn, 200, "revoked")
    else
      send_resp(conn, 403, "denied")
    end
  end

  def call(conn, _), do: CascadeWeb.Router.call(conn, CascadeWeb.Router.init([]))
end

defmodule CascadeWeb.VoiceHtmlTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Cascade.TestHelpers
  alias Cascade.Content.Store
  alias Cascade.Auth.Token
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Voice

  setup do
    ctx = owner_vault("voice-html")
    other = owner_vault("voice-outsider")
    user = %{id: ctx.user_id, username: ctx.username}
    other_user = %{id: other.user_id, username: other.username}
    File.mkdir_p!("/tmp/#{ctx.vault_id}")

    on_exit(fn ->
      File.rm_rf!("/tmp/#{ctx.vault_id}")
      Application.delete_env(:cascade_elixir, :voice)
      Application.delete_env(:cascade_elixir, :voice_fixture)
    end)

    note =
      Store.create_note(ctx.vault_id, ctx.user_id, %{
        title: "Voice fixture",
        content: "cascade://voice-channel"
      })

    %{
      ctx: ctx,
      user: user,
      other: other_user,
      note: note,
      base: "/api/vaults/#{ctx.vault_id}/channels/#{note.id}"
    }
  end

  test "voice type persists independently of text and cannot grant text rooms voice", c do
    text =
      Store.create_note(c.ctx.vault_id, c.user.id, %{
        title: "Text preserved",
        content: "cascade://chat-channel"
      })

    assert ["cascade://voice-channel"] ==
             SQL.one("SELECT content FROM notes WHERE id=?", [c.note.id])

    assert ["cascade://chat-channel"] ==
             SQL.one("SELECT content FROM notes WHERE id=?", [text.id])

    Application.put_env(:cascade_elixir, :voice, %{})
    assert {:error, :forbidden} = Voice.join(c.user, c.ctx.vault_id, text.id)
    assert {:error, :unavailable} = Voice.join(c.user, c.ctx.vault_id, c.note.id)

    assert request(:get, c.base <> "/voice/participants", nil, Token.sign_agent(c.user)).status ==
             403

    assert request(
             :post,
             c.base <> "/voice/deafen",
             %{identity: "u#{c.other.id}-x", deafened: true},
             Token.sign_user(c.user)
           ).status == 403

    assert {:error, :forbidden} =
             Voice.deafen(c.user, c.ctx.vault_id, c.note.id, "u#{c.user.id}-x", "true")
  end

  test "HTML upload, authenticated guard, safe original download, bounds and scope", c do
    html = "<!doctype html><h1>Fixture</h1><script>window.evil=true</script>"
    input = %{media_type: "text/html", filename: "fixture.html", data: Base.encode64(html)}
    token = Token.sign_agent(c.user)
    assert request(:post, c.base <> "/html-assets-v1", input, nil).status == 401

    assert request(:post, c.base <> "/html-assets-v1", input, Token.sign_agent(c.other)).status in [
             403,
             404
           ]

    assert request(:post, "/api/notes/#{c.note.id}/assets", input, token).status == 403
    uploaded = request(:post, c.base <> "/html-assets-v1", input, token)
    assert uploaded.status == 201
    asset = Jason.decode!(uploaded.resp_body)
    download = request(:get, asset["url"], nil, token)
    assert download.status == 200
    assert download.resp_body == html

    assert get_resp_header(download, "content-disposition")
           |> hd()
           |> String.starts_with?("attachment;")

    preview = "/api/html-previews/#{c.note.id}/#{asset["asset_id"]}"
    assert request(:get, preview, nil, nil).status == 401
    assert request(:get, preview, nil, Token.sign_user(c.other)).status == 404
    guard = request(:get, preview, nil, Token.sign_user(c.user))
    assert guard.status == 200
    assert get_resp_header(guard, "x-frame-options") == []
    assert get_resp_header(guard, "cache-control") == ["no-store"]
    assert hd(get_resp_header(guard, "content-security-policy")) =~ "frame-src 'none'"
    assert hd(get_resp_header(guard, "content-security-policy")) =~ "sandbox allow-scripts"
    assert get_resp_header(request(:get, "/api/health", nil, nil), "x-frame-options") == ["DENY"]
    refute guard.resp_body =~ html

    assert request(
             :post,
             c.base <> "/html-assets-v1",
             %{input | data: Base.encode64(String.duplicate("x", 1_048_577))},
             token
           ).status == 400

    assert request(
             :post,
             c.base <> "/html-assets-v1",
             %{input | data: Base.encode64(<<255>>)},
             token
           ).status == 400

    assert request(:post, c.base <> "/html-assets-v1", %{input | media_type: "image/png"}, token).status ==
             403
  end

  test "voice is human-only, channel-scoped and reports missing SFU honestly", c do
    Application.put_env(:cascade_elixir, :voice, %{})
    assert request(:post, c.base <> "/voice/join", %{}, nil).status == 401
    assert request(:post, c.base <> "/voice/join", %{}, Token.sign_agent(c.user)).status == 403

    assert request(:post, c.base <> "/voice/join", %{}, Token.sign_user(c.other)).status in [
             403,
             404
           ]

    assert request(:post, c.base <> "/voice/join", %{}, Token.sign_user(c.user)).status == 503

    assert {:error, :forbidden} =
             Voice.leave(c.user, c.ctx.vault_id, c.note.id, "u#{c.other.id}-x")

    refute Voice.authorized_peer?("fizzer-wrong", %{
             "metadata" =>
               Jason.encode!(%{user: c.user.id, vault: c.ctx.vault_id, channel: c.note.id}),
             "identity" => "u#{c.user.id}-test"
           })

    {:ok, route} = Cascade.Chat.Channel.assert_vault_channel(c.ctx.vault_id, c.note.id, c.user.id)

    peer = %{
      "metadata" => Jason.encode!(%{user: c.user.id, vault: c.ctx.vault_id, channel: c.note.id}),
      "identity" => "u#{c.user.id}-test"
    }

    assert Voice.authorized_peer?(Voice.room(route), peer)

    SQL.exec("UPDATE vault_members SET role='viewer' WHERE vault_id=? AND user_id=?", [
      c.ctx.vault_id,
      c.user.id
    ])

    refute Voice.authorized_peer?(Voice.room(route), peer)
    assert {:error, :forbidden} = Voice.join(c.user, c.ctx.vault_id, c.note.id)
  end

  test "only the app document gains exact preview frame path and opt-in own-origin microphone",
       _c do
    old = Application.fetch_env!(:cascade_elixir, :client_dist_dir)
    root = Path.join(System.tmp_dir!(), "voice-html-static-#{Ecto.UUID.generate()}")
    File.mkdir_p!(root)
    File.write!(Path.join(root, "app.html"), "<p>fixture</p>")
    Application.put_env(:cascade_elixir, :client_dist_dir, root)

    on_exit(fn ->
      Application.put_env(:cascade_elixir, :client_dist_dir, old)
      File.rm_rf!(root)
    end)

    Application.put_env(:cascade_elixir, :voice, %{})
    doc = request(:get, "/app", nil, nil)
    assert doc.status == 200
    assert hd(get_resp_header(doc, "content-security-policy")) =~ "/api/html-previews/"
    refute hd(get_resp_header(doc, "content-security-policy")) =~ "frame-src 'self'"
    assert hd(get_resp_header(doc, "permissions-policy")) =~ "microphone=()"

    Application.put_env(:cascade_elixir, :voice, %{
      url: "wss://voice.invalid",
      api: "http://127.0.0.1:1",
      key: "test",
      secret: String.duplicate("x", 32)
    })

    assert hd(get_resp_header(request(:get, "/app", nil, nil), "permissions-policy")) =~
             "microphone=(self)"

    assert hd(get_resp_header(request(:get, "/api/health", nil, nil), "permissions-policy")) =~
             "microphone=()"

    assert get_resp_header(request(:get, "/app", nil, nil), "x-frame-options") == ["DENY"]
  end

  if System.get_env("FIZZER_MEDIA_INTEGRATION") == "1" do
    @tag timeout: 240_000
    test "actual SFU audio and hostile preview in isolated headless browsers", c do
      Application.put_env(:cascade_elixir, :voice, %{
        url: System.get_env("FIZZER_TEST_LIVEKIT_WS", "ws://127.0.0.1:17880"),
        api: System.get_env("FIZZER_TEST_LIVEKIT_API", "http://127.0.0.1:17880"),
        key: "fizzer-test-key",
        secret: "fizzer-test-secret-at-least-32-characters"
      })

      assert {:ok, _} = Voice.rpc("ListRooms", %{})
      {:ok, session} = Voice.join(c.user, c.ctx.vault_id, c.note.id)
      {:ok, claims} = Joken.peek_claims(session.token)
      assert (claims["exp"] - System.system_time(:second)) in 29..30
      assert claims["video"]["canPublishSources"] == ["microphone"]
      assert claims["video"]["canPublishData"] == false
      assert claims["video"]["canUpdateOwnMetadata"] == false

      SQL.exec("INSERT INTO vault_members(vault_id,user_id,role,invited_by) VALUES(?,?,?,?)", [
        c.ctx.vault_id,
        c.other.id,
        "editor",
        c.user.id
      ])

      {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
      {:ok, {_, port}} = :inet.sockname(socket)
      :gen_tcp.close(socket)

      start_supervised!(
        {Bandit, plug: CascadeWeb.VoiceHtmlFixtureRouter, ip: {127, 0, 0, 1}, port: port}
      )

      key = Ecto.UUID.generate()

      Application.put_env(:cascade_elixir, :voice_fixture, %{
        key: key,
        vault: c.ctx.vault_id,
        user: c.other.id
      })

      text_note =
        Store.create_note(c.ctx.vault_id, c.user.id, %{
          title: "General",
          content: "cascade://chat-channel"
        })

      document =
        Store.create_note(c.ctx.vault_id, c.user.id, %{
          title: "Project notes",
          content: "Notes remain available during voice."
        })

      second_room =
        Store.create_note(c.ctx.vault_id, c.user.id, %{
          title: "Second room",
          content: "cascade://voice-channel"
        })

      folder = Store.create_folder(c.ctx.vault_id, %{name: "Hangouts"})

      fixture = %{
        upstream: "http://127.0.0.1:#{port}",
        key: key,
        vault: c.ctx.vault_id,
        channel: c.note.id,
        textChannel: text_note.id,
        document: document.id,
        secondRoom: second_room.id,
        folder: folder.id,
        tokens: [Token.sign_user(c.user), Token.sign_user(c.other)],
        agent: Token.sign_agent(c.user)
      }

      runtime = Path.join(System.tmp_dir!(), "voice-html-browser-#{key}")
      File.mkdir_p!(runtime)
      File.chmod!(runtime, 0o700)
      on_exit(fn -> File.rm_rf!(runtime) end)

      {output, status} =
        System.cmd(
          "env",
          [
            "-u",
            "WAYLAND_DISPLAY",
            "-u",
            "DISPLAY",
            "-u",
            "SWAYSOCK",
            "node",
            "scripts/test-voice-html-browser.mjs"
          ],
          cd: Path.expand(".."),
          env: [{"FIZZER_MEDIA_FIXTURE", Jason.encode!(fixture)}, {"XDG_RUNTIME_DIR", runtime}],
          stderr_to_stdout: true
        )

      IO.puts(output)
      assert status == 0
    end
  end

  defp request(method, path, body, token),
    do: json_conn(method, path, body, token) |> CascadeWeb.Router.call(CascadeWeb.Router.init([]))
end
