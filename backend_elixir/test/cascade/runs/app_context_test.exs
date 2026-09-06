defmodule Cascade.Runs.AppContextTest do
  use ExUnit.Case, async: false
  import Plug.Conn
  import Plug.Test
  alias Cascade.Accounts.SQL
  alias Cascade.Runs.{AppContext, PromptContext}
  alias Cascade.Auth.Token

  setup do
    users =
      for _ <- 1..2 do
        name = "app-context-#{System.unique_integer([:positive])}"

        SQL.exec(
          "INSERT INTO users(username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,'',0)",
          [name, "x", name]
        )

        %{id: SQL.last_insert_id(), username: name, auth_version: 0}
      end

    on_exit(fn -> Enum.each(users, &SQL.exec("DELETE FROM users WHERE id=?", [&1.id])) end)
    %{user: hd(users), other: List.last(users)}
  end

  test "agent edits are account scoped, bounded, and reject stale or missing revisions", ctx do
    assert request(nil, :get).status == 401
    token = Token.sign_agent(ctx.user)
    original = request(token, :get) |> body()
    assert original["content"] =~ "Act within authorized scope"
    assert original["content"] =~ "task’s vault as shared working knowledge"

    saved =
      request(token, :put, %{
        content: "Finish necessary checks.",
        revision: original["revision"],
        userId: ctx.other.id
      })

    assert saved.status == 200
    assert body(request(token, :get)) == body(saved)
    assert AppContext.get(ctx.other.id).content == AppContext.seed()
    assert request(token, :put, %{content: "stale", revision: original["revision"]}).status == 409
    assert request(token, :put, %{content: "missing"}).status == 400

    assert request(token, :put, %{
             content: String.duplicate("x", 12_001),
             revision: body(saved)["revision"]
           }).status == 400

    assert AppContext.get(ctx.user.id).content == "Finish necessary checks."
    assert request(Token.sign_user(ctx.user), :get).status == 200
  end

  test "simultaneous edits cannot silently overwrite each other", ctx do
    revision = AppContext.get(ctx.user.id).revision

    results =
      1..2
      |> Task.async_stream(fn n -> AppContext.put(ctx.user.id, "edit #{n}", revision) end)
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(results, &match?({:ok, _}, &1)) == 1
    assert Enum.count(results, &(&1 == {:error, :conflict})) == 1
  end

  test "fresh coordinator and worker payloads and resumed contexts load durable account guidance",
       ctx do
    {:ok, saved} =
      AppContext.put(ctx.user.id, "A durable correction.", AppContext.get(ctx.user.id).revision)

    # Re-running startup migrations must preserve the document; there is no in-memory cache.
    Cascade.Accounts.Schema.ensure!()
    assert Task.async(fn -> AppContext.get(ctx.user.id) end) |> Task.await() == saved

    for agent <- ["codex", "claude-code"], resume <- [nil, "continued"] do
      prompt =
        PromptContext.enrich_prompt(
          "unused",
          ctx.user.id,
          "Assigned work",
          agent,
          resume,
          :self_contained
        )

      assert prompt =~ saved.content
      assert prompt =~ "subordinate to current user instructions"

      payload =
        PromptContext.delegate_payload(
          %{id: 1, vault_id: "unused"},
          "/tmp",
          agent,
          prompt,
          %{},
          resume
        )

      assert payload.prompt =~ saved.content
    end

    refute PromptContext.enrich_prompt(
             "unused",
             ctx.other.id,
             "Other account",
             "codex",
             nil,
             :self_contained
           ) =~ saved.content

    assert PromptContext.enrich_prompt("unused", ctx.user.id, "/compact", "claude-code", nil) ==
             "/compact"
  end

  test "document survives application shutdown and startup", ctx do
    {:ok, saved} =
      AppContext.put(ctx.user.id, "Survives restart.", AppContext.get(ctx.user.id).revision)

    :ok = Application.stop(:cascade_elixir)
    {:ok, _} = Application.ensure_all_started(:cascade_elixir)
    assert AppContext.get(ctx.user.id) == saved
  end

  defp body(conn), do: Jason.decode!(conn.resp_body)

  defp request(token, method, params \\ nil) do
    conn = conn(method, "/api/app-context", if(params, do: Jason.encode!(params), else: nil))
    conn = if token, do: put_req_header(conn, "authorization", "Bearer " <> token), else: conn

    conn
    |> put_req_header("content-type", "application/json")
    |> CascadeWeb.ChatRouter.call(CascadeWeb.ChatRouter.init([]))
  end
end
