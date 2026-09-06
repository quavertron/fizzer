defmodule Cascade.Runs.PromptContextTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Content.Query
  alias Cascade.Runs.PromptContext
  alias Cascade.Evolution

  setup do
    suffix = System.unique_integer([:positive])
    username = "prompt-context-#{suffix}"
    vault_id = Ecto.UUID.generate()
    root = Path.join(System.tmp_dir!(), "cascade-prompt-context-#{suffix}")
    File.mkdir_p!(root)

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [username, "x", username, ""]
    )

    user_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      vault_id,
      "Prompt context",
      root,
      user_id
    ])

    SQL.exec(
      "INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)",
      [vault_id, user_id, "owner", user_id]
    )

    on_exit(fn ->
      SQL.exec("DELETE FROM vaults WHERE id=?", [vault_id])
      SQL.exec("DELETE FROM users WHERE id=?", [user_id])
      File.rm_rf!(root)
    end)

    %{root: root, user_id: user_id, vault_id: vault_id}
  end

  test "cold runs seed and inject the exact Node memory and scratchpad contract", context do
    prompt =
      PromptContext.enrich_prompt(
        context.vault_id,
        context.user_id,
        "Exercise release parity",
        "codex",
        nil
      )

    assert prompt =~ "Exercise release parity\n\n[Context: Fizzer app context"
    assert prompt =~ PromptContext.app_context()
    assert prompt =~ "Agent memory (vault):\n- [[INDEX]]: # Agent memory — @codex"
    assert prompt =~ "Scratchpad is optional persistent memory."
    assert prompt =~ "Your POLICIES note: # Scratchpad policies"

    folders =
      Query.maps(
        "SELECT name,parent_id FROM folders WHERE vault_id=? ORDER BY rowid",
        [context.vault_id],
        [:name, :parent_id]
      )

    assert Enum.map(folders, & &1.name) == ["_agent", "codex", "memory"]
    assert Enum.map(folders, &is_nil(&1.parent_id)) == [true, false, false]

    notes =
      Query.maps(
        "SELECT title,content,word_count,position,is_listed FROM notes WHERE vault_id=? ORDER BY rowid",
        [context.vault_id],
        [:title, :content, :word_count, :position, :is_listed]
      )

    assert Enum.map(notes, & &1.title) == ["INDEX", "POLICIES"]
    assert Enum.map(notes, & &1.word_count) == [30, 739]
    assert Enum.map(notes, & &1.position) == [0, 1]
    assert Enum.map(notes, & &1.is_listed) == [1, 1]
    policies = List.last(notes)

    assert :crypto.hash(:sha256, policies.content) |> Base.encode16(case: :lower) ==
             "a9f03a27fa2a1239f7512c9216c2e5d8bd9a5e9e23d6f978e6045ee6e429b8b6"

    assert File.read!(Path.join(context.root, "_agent/codex/memory/INDEX.md")) ==
             hd(notes).content

    assert File.read!(Path.join(context.root, "_agent/codex/memory/POLICIES.md")) ==
             policies.content

    assert [[2, context.user_id]] ==
             Query.all(
               "SELECT COUNT(*),MIN(actor_user_id) FROM community_note_activity WHERE note_id IN (SELECT id FROM notes WHERE vault_id=?)",
               [context.vault_id]
             )

    assert [2] =
             Query.one(
               "SELECT COUNT(*) FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE vault_id=?)",
               [context.vault_id]
             )

    PromptContext.enrich_prompt(
      context.vault_id,
      context.user_id,
      "Another cold turn",
      "codex",
      nil
    )

    assert [2] = Query.one("SELECT COUNT(*) FROM notes WHERE vault_id=?", [context.vault_id])
  end

  test "resumed runs refresh app guidance without bootstrapping vault memory", context do
    assert PromptContext.enrich_prompt(
             context.vault_id,
             context.user_id,
             "Continue exactly",
             "codex",
             "provider-session"
           ) =~ "Fizzer app context"

    assert [0] = Query.one("SELECT COUNT(*) FROM folders WHERE vault_id=?", [context.vault_id])
    assert [0] = Query.one("SELECT COUNT(*) FROM notes WHERE vault_id=?", [context.vault_id])
  end

  test "disabled memory still mints agent folders and policies on a cold start", context do
    Evolution.set_agent_memory_enabled(context.vault_id, false)

    prompt =
      PromptContext.enrich_prompt(
        context.vault_id,
        context.user_id,
        "Cold with memory disabled",
        "codex",
        nil
      )

    refute prompt =~ "Agent memory (vault):"
    assert prompt =~ "Your POLICIES note:"
    assert [3] = Query.one("SELECT COUNT(*) FROM folders WHERE vault_id=?", [context.vault_id])
    assert [2] = Query.one("SELECT COUNT(*) FROM notes WHERE vault_id=?", [context.vault_id])
  end

  test "delegate payload includes Node fields and omits absent optionals" do
    run = %{id: 42, vault_id: "vault"}

    payload =
      PromptContext.delegate_payload(
        run,
        "/vault/root",
        "codex",
        "prompt",
        %{"cwd" => "vault root", "model" => "codex-pro", "images" => []},
        nil
      )

    assert Map.keys(payload) |> Enum.sort() ==
             [
               :agent,
               :agentMemoryKey,
               :chatAuthor,
               :chatChannelId,
               :chatMessageId,
               :chatRegistrationId,
               :chatTriggeringMessageId,
               :hermesProfile,
               :hermesSafeMode,
               :images,
               :inlineSvgs,
               :priorityServiceTier,
               :prompt,
               :runId,
               :vaultId,
               :vaultRoot,
               :yolo
             ]
             |> Enum.sort()

    refute Map.has_key?(payload, :cwd)
    refute Map.has_key?(payload, :model)
    refute Map.has_key?(payload, :resumeSessionId)

    resumed =
      PromptContext.delegate_payload(
        run,
        "/vault/root",
        "codex",
        "prompt",
        %{"cwd" => " /repo ", "model" => " custom-model ", "yolo" => true},
        "provider-session"
      )

    assert resumed.cwd == "/repo"
    assert resumed.model == "custom-model"
    assert resumed.resumeSessionId == "provider-session"
    assert resumed.yolo
  end

  test "delegate payload extracts inline SVGs for local rasterization" do
    run = %{id: 43, vault_id: "vault"}

    first =
      ~s(<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>)

    second = ~s(<SVG viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></SVG>)

    payload =
      PromptContext.delegate_payload(
        run,
        "/vault/root",
        "claude-code",
        "before #{first} between #{second} after",
        %{},
        nil
      )

    assert payload.prompt ==
             "before [[FIZZER_INLINE_SVG:1]] between [[FIZZER_INLINE_SVG:2]] after"

    assert payload.inlineSvgs == [first, second]
  end

  test "delegate payload merges room SVG sources after direct prompt SVGs" do
    run = %{id: 44, vault_id: "vault"}
    direct = ~s(<svg width="3" height="3"><rect width="3" height="3"/></svg>)
    room = ~s(<svg width="4" height="4"><circle cx="2" cy="2" r="2"/></svg>)

    payload =
      PromptContext.delegate_payload(
        run,
        "/vault/root",
        "codex",
        "direct #{direct} room [[@FIZZER_ROOM_INLINE_SVG:1]]",
        %{},
        "session",
        %{inline_svgs: [room]}
      )

    assert payload.prompt ==
             "direct [[FIZZER_INLINE_SVG:1]] room [[FIZZER_INLINE_SVG:2]]"

    assert payload.inlineSvgs == [direct, room]
  end
end
