defmodule CascadeWeb.ExternalAgentAccessTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Cascade.TestHelpers
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.Agents

  test "external API wire contract: browser CSRF mint, agent note shape, attribution and nonping persistence" do
    ctx = owner_vault("external-api")
    user = %{id: ctx.user_id, username: ctx.username}
    cookie = "cascade_session=#{Token.sign_user(user)}"
    root = "/tmp/#{ctx.vault_id}"
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)

    denied =
      json_conn(:post, "/api/auth/agent-token") |> put_req_header("cookie", cookie) |> route()

    assert denied.status == 403

    minted =
      json_conn(:post, "/api/auth/agent-token")
      |> put_req_header("cookie", cookie)
      |> put_req_header("x-cascade-browser", "1")
      |> route()

    assert minted.status == 200
    token = Jason.decode!(minted.resp_body)["token"]
    assert {:ok, %{access: "agent"}} = Token.verify(token)
    base = "/api/vaults/#{ctx.vault_id}"

    created =
      api(
        :post,
        base <> "/notes",
        %{title: "Along fixture", content: "cascade://chat-channel", is_listed: true},
        token
      )

    note = created["note"]
    assert note["vault_id"] == ctx.vault_id
    assert note["is_listed"] in [1, true]
    refute Map.has_key?(note, "listed")
    assert api(:get, "/api/notes/#{note["id"]}", nil, token)["note"] == note
    assert Enum.any?(api(:get, base <> "/notes", nil, token)["notes"], &(&1["id"] == note["id"]))

    {:ok, identity} =
      Agents.upsert_identity(user.id, ctx.vault_id, %{
        agentId: "codex",
        displayName: "Fixture",
        mention: "fixture"
      })

    {:ok, _member} =
      Agents.add_to_channel(user.id, ctx.vault_id, note["id"], identity.id, %{
        replyToEveryMessage: true,
        ambientGroupChat: true,
        orchestrator: true,
        taggableByAgents: false
      })

    channel = base <> "/channels/#{note["id"]}/messages"

    payload = %{
      body: "I am Along, an AI agent. Fixture only.",
      author: "Along (AI agent)",
      agentId: "hermes",
      registrationId: nil,
      status: "completed",
      replyTo: nil,
      images: [],
      attachments: [],
      blocks: nil,
      runId: nil
    }

    sent = api(:post, channel, payload, token)
    assert sent["dispatches"] == []
    message = sent["message"]
    assert message["author"] == "Along (AI agent)"
    assert message["actorUserId"] == user.id
    assert message["agentId"] == "hermes"
    assert message["registrationId"] == nil
    persisted = api(:get, channel <> "/#{message["id"]}", nil, token)["message"]
    assert persisted == message
    history = api(:get, channel <> "?limit=40", nil, token)["messages"]
    assert Enum.any?(history, &(&1["id"] == message["id"] and &1["actorUserId"] == user.id))

    assert [0] ==
             SQL.one("SELECT count(*) FROM chat_agent_dispatches WHERE channel_id=?", [note["id"]])

    # Main differs from beta: a nonmention agent post can enqueue ambient work.
    # No runner is connected; this proves the risk without invoking a model.
    SQL.exec("UPDATE chat_agent_members SET taggable_by_agents=1 WHERE channel_id=?", [note["id"]])

    quiet = base <> "/channels/#{note["id"]}/messages-no-invoke-v1"

    assert api(:get, quiet, nil, token) == %{
             "contract" => "messages_no_invoke_v1",
             "mediaContract" => "channel_png_assets_v1",
             "actorUserId" => user.id,
             "vaultId" => ctx.vault_id,
             "channelId" => note["id"]
           }

    runs_before = SQL.one("SELECT count(*) FROM runs")

    for text <- ["Ambient enabled", "@fixture please respond", "/clear @fixture"] do
      sent =
        api(
          :post,
          quiet,
          Map.merge(payload, %{
            body: text,
            actorUserId: -1,
            replyTo: %{messageId: message["id"], ping: true},
            status: "queued"
          }),
          token
        )

      assert sent["contract"] == "messages_no_invoke_v1"
      assert sent["dispatches"] == []
      assert sent["message"]["actorUserId"] == user.id
      assert sent["message"]["status"] == "completed"
      assert sent["message"]["replyTo"] == nil
      assert sent["message"]["images"] == nil
      assert sent["message"]["attachments"] == nil

      assert api(:get, channel <> "/#{sent["message"]["id"]}", nil, token)["message"] ==
               sent["message"]
    end

    assert [0] ==
             SQL.one("SELECT count(*) FROM chat_agent_dispatches WHERE channel_id=?", [note["id"]])

    assert SQL.one("SELECT count(*) FROM runs") == runs_before

    # The normal authenticated browser upload is reused without weakening CSRF.
    png =
      Base.decode64!(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"
      )

    upload_path = "/api/notes/#{note["id"]}/assets"
    upload_body = %{media_type: "image/png", data: Base.encode64(png)}

    assert (json_conn(:post, upload_path, upload_body)
            |> put_req_header("cookie", cookie)
            |> route()).status == 403

    assert (json_conn(:post, upload_path, upload_body, token) |> route()).status == 403

    uploaded =
      json_conn(:post, upload_path, upload_body)
      |> put_req_header("cookie", cookie)
      |> put_req_header("x-cascade-browser", "1")
      |> route()

    assert uploaded.status == 201
    asset = Jason.decode!(uploaded.resp_body)
    image = %{name: "fixture.png", media_type: "image/png", data: "", url: asset["url"]}
    media_sent = api(:post, quiet, %{payload | images: [image]}, token)
    assert media_sent["dispatches"] == []
    assert media_sent["message"]["images"] == [Jason.decode!(Jason.encode!(image))]

    assert api(:get, channel <> "/#{media_sent["message"]["id"]}", nil, token)["message"] ==
             media_sent["message"]

    downloaded = json_conn(:get, asset["url"]) |> put_req_header("cookie", cookie) |> route()
    assert downloaded.status == 200
    assert downloaded.resp_body == png
    assert (json_conn(:get, asset["url"]) |> route()).status == 401
    before_bad = SQL.one("SELECT count(*) FROM chat_messages")

    for bad <- [
          Map.put(image, :url, "https://example.com/image.png"),
          Map.put(image, :url, "/api/notes/#{Ecto.UUID.generate()}/assets/#{asset["asset_id"]}"),
          Map.put(image, :url, "/api/notes/#{note["id"]}/assets/abcdefghijklmnop"),
          Map.put(image, :data, Base.encode64(png)),
          Map.put(image, :media_type, "image/svg+xml")
        ] do
      assert (json_conn(:post, quiet, %{payload | images: [bad]}, token) |> route()).status == 400
    end

    assert (json_conn(:post, quiet, %{payload | images: List.duplicate(image, 5)}, token)
            |> route()).status == 400

    assert (json_conn(:post, quiet, %{payload | attachments: [image]}, token) |> route()).status ==
             400

    assert SQL.one("SELECT count(*) FROM chat_messages") == before_bad
    assert SQL.one("SELECT count(*) FROM runs") == runs_before

    assert [0] ==
             SQL.one("SELECT count(*) FROM chat_agent_dispatches WHERE channel_id=?", [note["id"]])

    # Concurrent settings writes cannot turn the dedicated operation into dispatch.
    tasks =
      for n <- 1..8 do
        Task.async(fn ->
          SQL.exec("UPDATE chat_agent_members SET taggable_by_agents=? WHERE channel_id=?", [
            rem(n, 2),
            note["id"]
          ])

          sent = api(:post, quiet, %{payload | body: "@fixture concurrent #{n}"}, token)
          assert sent["dispatches"] == []
        end)
      end

    Enum.each(tasks, &Task.await/1)

    SQL.exec("UPDATE chat_agent_members SET taggable_by_agents=1 WHERE channel_id=?", [note["id"]])

    assert [0] ==
             SQL.one("SELECT count(*) FROM chat_agent_dispatches WHERE channel_id=?", [note["id"]])

    assert SQL.one("SELECT count(*) FROM runs") == runs_before

    # An author string does not grant agent access or owner permission.
    assert (json_conn(:post, quiet, payload, Token.sign_user(user)) |> route()).status == 403
    assert (json_conn(:post, quiet, payload) |> route()).status == 401

    SQL.exec("UPDATE vault_members SET role='viewer' WHERE vault_id=? AND user_id=?", [
      ctx.vault_id,
      user.id
    ])

    assert (json_conn(:post, quiet, payload, token) |> route()).status == 403

    SQL.exec("UPDATE vault_members SET role='editor' WHERE vault_id=? AND user_id=?", [
      ctx.vault_id,
      user.id
    ])

    assert (json_conn(:post, quiet, payload, token) |> route()).status == 403

    SQL.exec("UPDATE vault_members SET role='owner' WHERE vault_id=? AND user_id=?", [
      ctx.vault_id,
      user.id
    ])

    foreign = owner_vault("external-foreign")
    wrong_channel = "/api/vaults/#{foreign.vault_id}/channels/#{note["id"]}/messages-no-invoke-v1"
    assert (json_conn(:post, wrong_channel, payload, token) |> route()).status == 403
    foreign_token = Token.sign_agent(%{id: foreign.user_id, username: foreign.username})
    assert (json_conn(:post, wrong_channel, payload, foreign_token) |> route()).status == 404

    unsafe = api(:post, channel, payload, token)
    assert length(unsafe["dispatches"]) == 1
    mentioned = api(:post, channel, %{payload | body: "@fixture normal mention"}, token)
    assert length(mentioned["dispatches"]) == 1
    assert SQL.one("SELECT count(*) FROM runs") == runs_before
  end

  defp route(conn), do: CascadeWeb.Router.call(conn, CascadeWeb.Router.init([]))

  defp api(method, path, body, token) do
    conn = json_conn(method, path, body, token) |> route()
    assert conn.status in [200, 201], "unexpected status #{conn.status}: #{conn.resp_body}"
    Jason.decode!(conn.resp_body)
  end
end
