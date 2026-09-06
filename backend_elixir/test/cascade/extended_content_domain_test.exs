defmodule Cascade.Search.QMD.TestAdapter do
  @behaviour Cascade.Search.QMD.Adapter

  @impl true
  def search(options) do
    terms =
      options
      |> Keyword.fetch!(:query)
      |> String.downcase()
      |> then(&Regex.scan(~r/[a-z0-9_@#\.\/:-]{2,}/u, &1))
      |> List.flatten()

    scope = Keyword.fetch!(options, :scope)

    paths =
      [{"notes", "notes"}, {"chat", "chats"}]
      |> Enum.filter(fn {kind, _dir} -> scope == "all" or scope == kind end)
      |> Enum.flat_map(fn {_kind, dir} ->
        options
        |> Keyword.fetch!(:root)
        |> Path.join(dir)
        |> then(&Path.wildcard(Path.join(&1, "*.md")))
      end)
      |> Enum.map(fn path ->
        body = path |> File.read!() |> String.downcase()
        {Path.expand(path), Enum.count(terms, &String.contains?(body, &1))}
      end)
      |> Enum.filter(&(elem(&1, 1) > 0))
      |> Enum.sort_by(fn {path, score} -> {-score, path} end)
      |> Enum.take(Keyword.fetch!(options, :limit))
      |> Enum.map(&elem(&1, 0))

    {:ok, %{lexical: paths, vector: Enum.reverse(paths)}}
  end

  def clear, do: :ok
end

defmodule Cascade.ExtendedContentDomainTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import Cascade.TestHelpers

  alias Cascade.Auth.Token
  alias Cascade.Content.{Query, Store}
  alias Cascade.Search.QMD
  alias Cascade.{Evolution, Publishing, Scratchpad}

  @router_options CascadeWeb.ExtendedContentRouter.init([])

  setup do
    suffix = System.unique_integer([:positive])
    root = Path.join(System.tmp_dir!(), "cascade-extended-vaults-#{suffix}")
    qmd = Path.join(System.tmp_dir!(), "cascade-extended-qmd-#{suffix}")
    previous_root = System.get_env("CASCADE_VAULTS_BASE_DIR")
    previous_qmd = System.get_env("CASCADE_QMD_DIR")
    previous_adapter = Application.get_env(:cascade_elixir, :qmd_adapter)
    System.put_env("CASCADE_VAULTS_BASE_DIR", root)
    System.put_env("CASCADE_QMD_DIR", qmd)
    Application.put_env(:cascade_elixir, :qmd_adapter, Cascade.Search.QMD.TestAdapter)
    QMD.clear_cache()

    user_id = suffix + 10_000
    username = "extended_#{suffix}"

    Query.execute(
      "INSERT INTO users (id, username, password_hash, display_name, avatar_url, auth_version) VALUES (?, ?, 'x', ?, '', 0)",
      [user_id, username, username]
    )

    on_exit(fn ->
      File.rm_rf!(root)
      File.rm_rf!(qmd)
      restore_env("CASCADE_VAULTS_BASE_DIR", previous_root)
      restore_env("CASCADE_QMD_DIR", previous_qmd)
      restore_application_env(:qmd_adapter, previous_adapter)
      QMD.clear_cache()
    end)

    %{
      user_id: user_id,
      username: username,
      token: Token.sign_user(%{id: user_id, username: username, auth_version: 0})
    }
  end

  test "bootstrapped domain reads do not repeat schema or maintenance queries" do
    assert Process.whereis(Cascade.DomainBootstrap)
    key = {__MODULE__, make_ref()}

    :ok =
      :telemetry.attach(
        key,
        [:cascade, :db, :repo, :query],
        fn _event, _measurements, metadata, {owner, key} ->
          if self() == owner, do: Process.put(key, [metadata.query | Process.get(key, [])])
        end,
        {self(), key}
      )

    try do
      Publishing.get_info("missing")
      Publishing.get_by_slug("missing")
      Evolution.index_chat_message_backlinks("missing", "missing", %{body: ""})
      Evolution.agent_memory_enabled?("missing")
      Scratchpad.status("missing")
      Scratchpad.note_stats("missing")
      queries = Process.get(key)
      assert queries != []
      assert Enum.all?(queries, &Regex.match?(~r/^\s*SELECT\b/i, &1)), inspect(queries)
    after
      :telemetry.detach(key)
      Process.delete(key)
    end
  end

  test "MDEx plus sanitizer is DOM-equivalent to marked plus sanitize-html golden fixtures" do
    fixtures =
      __DIR__
      |> Path.join("../fixtures/publishing_marked_sanitize_golden.json")
      |> File.read!()
      |> Jason.decode!()

    Enum.each(fixtures, fn fixture ->
      actual = Publishing.render_markdown(fixture["markdown"])

      assert canonical_html(actual) == canonical_html(fixture["html"]),
             "publishing fixture drifted: #{fixture["name"]}\nactual=#{actual}\nexpected=#{fixture["html"]}"
    end)

    xss =
      Publishing.render_markdown(
        "[x](java%2561script:alert(1)) ![svg](data:image/svg+xml;base64,PHN2Zz4=)"
      )

    refute xss =~ "javascript"
    refute xss =~ "data:image/svg"

    assert Publishing.render_markdown("![png](data:image/png;base64,iVBORw0KGgo=)") =~
             "data:image/png"
  end

  test "publishing snapshots stored content, preserves slugs across revocation, and validates origins",
       context do
    vault = Store.create_vault(context.user_id, %{name: "Publishing"})

    note =
      Store.create_note(vault.id, context.user_id, %{
        title: " Public note ",
        content: "safe\n:::private\nsecret\n:::\n[[Target]] {{ai:skip}}"
      })

    first =
      Publishing.publish(note.id, context.user_id, context.username, %{
        title: "forged",
        content: "forged"
      })

    published = Publishing.get_by_slug(first.slug)
    assert published.title == "Public note"
    assert published.content =~ "Private block omitted from the public note."
    refute published.content =~ "secret"
    refute published.content =~ "forged"
    assert Publishing.unpublish(note.id, context.user_id)
    refute Publishing.unpublish(note.id, context.user_id)

    second = Publishing.publish(note.id, context.user_id, context.username)
    assert second.slug == first.slug
    assert second.published_at == first.published_at

    %Plug.Conn{} = request_conn = conn(:get, "/p/#{second.slug}")
    conn = %{request_conn | host: "cscd.online"}

    assert Publishing.public_base_url(conn, %{"CASCADE_ALLOWED_ORIGINS" => "https://cscd.online"}) ==
             "https://cscd.online"

    assert_raise ArgumentError, "CASCADE_PUBLIC_URL must be an absolute HTTP(S) origin", fn ->
      Publishing.public_base_url(conn, %{"CASCADE_PUBLIC_URL" => "javascript:alert(1)"})
    end
  end

  test "native QMD contract synchronizes variants, fuses lexical and vector ranks, scopes results, and removes stale files",
       context do
    vault = Store.create_vault(context.user_id, %{name: "Search"})

    alpha =
      Store.create_note(vault.id, context.user_id, %{
        title: "Deploy guide",
        content: "release production safely"
      })

    secret =
      Store.create_note(vault.id, context.user_id, %{
        title: "Secrets",
        content: "public\n:::private\npassword nebula\n:::"
      })

    channel =
      Store.create_note(vault.id, context.user_id, %{
        title: "Chat",
        content: "cascade://chat-channel"
      })

    Query.execute(
      "INSERT INTO chat_messages (id, channel_id, vault_id, author, body, status, created_at) VALUES ('m-search', ?, ?, 'alice', 'deploy production verified', NULL, '2026-01-01')",
      [channel.id, vault.id]
    )

    Query.execute(
      "INSERT INTO chat_messages (id, channel_id, vault_id, author, body, status) VALUES ('sys-next-search', ?, ?, 'Astra', 'deploy production checkpoint instructions', NULL)",
      [channel.id, vault.id]
    )

    all = QMD.search(vault.id, "deploy production", scope: "all", limit: 10)
    refute Enum.any?(all, &(&1.id == "sys-next-search"))
    assert Enum.any?(all, &(&1.type == "note" and &1.id == alpha.id and &1.score > 0))

    assert Enum.any?(
             all,
             &(&1.type == "chat" and &1.id == "m-search" and &1.channelId == channel.id)
           )

    assert Enum.all?(QMD.search(vault.id, "deploy", scope: "notes"), &(&1.type == "note"))
    assert Enum.all?(QMD.search(vault.id, "deploy", scope: "chat"), &(&1.type == "chat"))

    agent_hits = QMD.search(vault.id, "password nebula", scope: "notes", redact_private: true)
    refute Enum.any?(agent_hits, &String.contains?(&1.snippet, "password"))

    user_hits = QMD.search(vault.id, "password nebula", scope: "notes")

    assert Enum.any?(
             user_hits,
             &(&1.id == secret.id and String.contains?(&1.snippet, "password"))
           )

    user_dir =
      Path.join([
        System.fetch_env!("CASCADE_QMD_DIR"),
        Base.url_encode64(vault.id, padding: false),
        "user",
        "notes"
      ])

    assert length(Path.wildcard(Path.join(user_dir, "*.md"))) >= 2
    Store.toggle_archive(secret.id, context.user_id)
    QMD.search(vault.id, "deploy", scope: "notes")

    refute File.exists?(
             Path.join(user_dir, Base.url_encode64(secret.id, padding: false) <> ".md")
           )
  end

  test "chat excerpts retain a match after multibyte text without returning the full body",
       context do
    vault = Store.create_vault(context.user_id, %{name: "Unicode excerpts"})

    channel =
      Store.create_note(vault.id, context.user_id, %{
        title: "Chat",
        content: "cascade://chat-channel"
      })

    body = String.duplicate("🌊é ", 200) <> "NEEDLE matched" <> String.duplicate(" trailing", 100)

    Query.execute(
      "INSERT INTO chat_messages (id, channel_id, vault_id, author, body, status) VALUES ('unicode-hit', ?, ?, 'Astra', ?, NULL)",
      [channel.id, vault.id, body]
    )

    [hit] = QMD.search(vault.id, "needle", scope: "chat")
    assert hit.id == "unicode-hit"
    assert hit.channelId == channel.id
    assert String.contains?(hit.snippet, "NEEDLE matched")
    assert String.length(hit.snippet) <= 242
    refute Map.has_key?(hit, :body)

    assert [%{body: ^body}] =
             Query.maps("SELECT body FROM chat_messages WHERE id = 'unicode-hit'", [], [:body])
  end

  test "QMD search ranks the matching live note first", context do
    vault = Store.create_vault(context.user_id, %{name: "QMD search"})

    first =
      Store.create_note(vault.id, context.user_id, %{
        title: "Release",
        content: "deploy production verified"
      })

    _second =
      Store.create_note(vault.id, context.user_id, %{
        title: "Rollback",
        content: "production rollback plan"
      })

    previous_semantic = System.get_env("CASCADE_QMD_SEMANTIC")
    System.put_env("CASCADE_QMD_SEMANTIC", "false")
    Application.put_env(:cascade_elixir, :qmd_adapter, Cascade.Search.QMD.Worker)

    on_exit(fn ->
      restore_env("CASCADE_QMD_SEMANTIC", previous_semantic)
      Cascade.Search.QMD.Worker.stop()
    end)

    actual = QMD.search(vault.id, "production deploy", scope: "notes", limit: 10)
    assert actual != []
    assert hd(actual).id == first.id
  end

  test "scratchpad journal, threads, skills, outcomes, recall, promotion and injection preserve ownership",
       context do
    vault = Store.create_vault(context.user_id, %{name: "Scratchpad"})

    first =
      Scratchpad.append_journal_entry(context.user_id, vault.id, %{
        agent_key: "@sol",
        kind: "bogus",
        body: "  root cause  "
      })

    second =
      Scratchpad.append_journal_entry(context.user_id, vault.id, %{
        agent_key: "sol",
        kind: "decision",
        body: "ship native"
      })

    assert first.kind == "observation"

    assert Enum.map(
             Scratchpad.list_journal_entries(context.user_id, vault.id, agent_key: "sol"),
             & &1.id
           ) == [first.id, second.id]

    assert Scratchpad.status(vault.id, "sol").unconsolidated == 2

    assert Scratchpad.mark_journal_consolidated(context.user_id, vault.id,
             through_id: first.id,
             agent_key: "sol"
           ) == 1

    thread =
      Scratchpad.open_thread(context.user_id, vault.id, %{
        agent_key: "sol",
        intent: "continue port",
        blocked_on: "none",
        next_try: "tests"
      })

    assert Scratchpad.list_open_threads(context.user_id, vault.id, agent_key: "sol")
           |> hd()
           |> Map.get(:id) == thread.id

    closed =
      Scratchpad.close_open_thread(context.user_id, vault.id,
        thread_id: thread.id,
        agent_key: "sol",
        reason: "done"
      )

    assert closed.closeReason == "done"

    skill =
      Scratchpad.create_skill_note(context.user_id, vault.id, %{
        agent_key: "sol",
        title: "Deploy safely",
        body: "Use for production deploy verification."
      })

    assert Scratchpad.record_note_outcome(context.user_id, vault.id, %{
             agent_key: "sol",
             note_ref: skill.id,
             result: "win"
           }).wins == 1

    assert [%{title: "Deploy safely", stats: %{uses: 1, wins: 1}}] =
             Scratchpad.list_skill_notes(context.user_id, vault.id, "sol")

    assert [%{id: id, kind: "skill", shared: false}] =
             Scratchpad.recall(context.user_id, vault.id, %{
               agent_key: "sol",
               query: "production deploy"
             })

    assert id == skill.id

    promoted =
      Scratchpad.promote_note(context.user_id, vault.id, %{agent_key: "sol", note_ref: skill.id})

    assert promoted.kind == "skill"

    assert Enum.any?(
             Scratchpad.list_skill_notes(context.user_id, vault.id, "other"),
             &(&1.id == skill.id and &1.shared)
           )

    Scratchpad.ensure_policies(vault.id, context.user_id, "sol")
    injection = Scratchpad.build_injection(vault.id, agent_key: "sol", user_id: context.user_id)
    assert injection =~ "Scratchpad is optional persistent memory"
    assert injection =~ "[[Deploy safely]]"
    refute injection =~ "continue port"
  end

  test "evolution indexes and backfills chat links, distills idempotently, and keeps memory private",
       context do
    vault = Store.create_vault(context.user_id, %{name: "Evolution"})
    target = Store.create_note(vault.id, context.user_id, %{title: "Roadmap", content: "initial"})

    channel =
      Store.create_note(vault.id, context.user_id, %{
        title: "Dev",
        content: "cascade://chat-channel"
      })

    first_message_id = "evolution-m1-#{context.user_id}"
    second_message_id = "evolution-m2-#{context.user_id}"

    Query.execute(
      "INSERT INTO chat_messages (id, channel_id, vault_id, author, body, status, created_at) VALUES (?, ?, ?, 'alice', 'We should ship [[Roadmap]] after verification because this is a substantive message.', NULL, '2026-01-01'), (?, ?, ?, 'Sol', 'Action: deploy and verify production before calling it done.', NULL, '2026-01-02')",
      [first_message_id, channel.id, vault.id, second_message_id, channel.id, vault.id]
    )

    assert Evolution.extract_wiki_titles("[[Roadmap]] ![[roadmap|alias]]") == ["Roadmap"]

    assert Evolution.backfill_chat_note_backlinks(vault.id) == %{
             processed: 2,
             indexed: 1,
             nextAfterRowid: nil
           }

    assert [%{messageId: ^first_message_id, noteId: note_id}] =
             Evolution.list_chat_note_backlinks(target.id)

    assert note_id == target.id

    created =
      Evolution.distill_chat_to_note(context.user_id, vault.id, channel.id, %{
        mode: "create",
        last_n: 2,
        title: "Decision log",
        by: context.username
      })

    assert created.status == "completed"
    assert created.note.is_listed == 0
    assert created.note.content =~ "## Transcript"
    assert created.note.content =~ "distilled_from:"

    duplicate =
      Evolution.distill_chat_to_note(context.user_id, vault.id, channel.id, %{
        mode: "create",
        last_n: 2,
        title: "Ignored"
      })

    assert duplicate.status == "exists"
    assert duplicate.note.id == created.note.id

    preview =
      Evolution.distill_chat_to_note(context.user_id, vault.id, channel.id, %{
        mode: "merge",
        last_n: 1,
        note_ref: target.id
      })

    assert preview.status == "needs_confirm"
    assert Store.get_note(target.id).content == "initial"

    memory =
      Evolution.create_agent_memory_note(context.user_id, vault.id, %{
        agent_key: "sol",
        title: "Boundary",
        body: "public\n:::private\nsecret token\n:::",
        listed: false
      })

    injection =
      Evolution.build_agent_memory_injection(vault.id,
        agent_key: "sol",
        channel_topic: "Boundary"
      )

    assert memory.id in injection.noteIds
    refute injection.text =~ "secret token"
    Evolution.set_agent_memory_enabled(vault.id, false)
    assert Evolution.build_agent_memory_injection(vault.id).enabled == false
  end

  test "isolated router exposes the exact 23-route catalog and preserves wrappers/statuses",
       context do
    assert length(CascadeWeb.ExtendedContentRoutes.catalog()) == 23
    assert length(Enum.uniq(CascadeWeb.ExtendedContentRoutes.catalog())) == 23
    vault = Store.create_vault(context.user_id, %{name: "HTTP extended"})

    unauthorized = request(:get, "/api/vaults/#{vault.id}/scratchpad/status", nil, nil)
    assert unauthorized.status == 401

    created =
      request(
        :post,
        "/api/vaults/#{vault.id}/scratchpad/journal",
        %{body: "remember this", agentKey: "sol"},
        context.token
      )

    assert created.status == 201

    assert %{"entry" => %{"agentKey" => "sol", "body" => "remember this"}} =
             Jason.decode!(created.resp_body)

    status =
      request(:get, "/api/vaults/#{vault.id}/scratchpad/status?agent=sol", nil, context.token)

    assert status.status == 200
    assert Jason.decode!(status.resp_body)["status"]["unconsolidated"] == 1
  end

  defp request(method, path, body, token) do
    json_conn(method, path, body, token)
    |> CascadeWeb.ExtendedContentRouter.call(@router_options)
  end

  defp canonical_html(html) do
    canonical = html |> HtmlSanitizeEx.Parser.parse() |> canonical_node()

    case canonical do
      [node] -> canonical_node(node)
      nodes -> nodes
    end
  end

  defp canonical_node({tag, attrs, children}) do
    {tag, Enum.sort(attrs), children |> Enum.map(&canonical_node/1) |> Enum.reject(&(&1 == ""))}
  end

  defp canonical_node(text) when is_binary(text) do
    text
    |> String.replace(["ï¼¿", "ï½¿"], " ")
    |> String.replace(~r/\s+/u, " ")
    |> String.trim()
  end

  defp canonical_node(nodes) when is_list(nodes) do
    nodes |> Enum.map(&canonical_node/1) |> Enum.reject(&(&1 == ""))
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
  defp restore_application_env(key, nil), do: Application.delete_env(:cascade_elixir, key)
  defp restore_application_env(key, value), do: Application.put_env(:cascade_elixir, key, value)
end
