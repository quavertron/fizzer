defmodule Cascade.Chat.DispatchPromptTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, DispatchPrompt, Messages}

  setup do
    owner = Cascade.TestHelpers.owner_vault("dispatch-prompt")
    channel_id = channel(owner, "Lab")

    {:ok, registration} =
      Agents.upsert_member(owner.user_id, owner.vault_id, channel_id, %{
        agentId: "claude-code",
        displayName: "Builder",
        mention: "builder",
        contextPrompt: "Stay in this clone.\n:::private\nchannel-secret\n:::"
      })

    execution = %{
      registration: registration,
      target_channel_id: channel_id,
      runner_user_id: owner.user_id,
      agent: registration.agentId,
      vault: %{id: owner.vault_id}
    }

    Map.merge(owner, %{channel_id: channel_id, execution: execution})
  end

  test "builds identity, strips only registered mentions, and preserves filenames and private boundaries",
       c do
    {:ok, _} =
      Agents.upsert_member(c.user_id, c.vault_id, c.channel_id, %{
        agentId: "codex",
        mention: "reviewer"
      })

    trigger =
      message(c, "@builder @reviewer Fix @human's report\n:::private\nrequest-secret\n:::", %{
        attachments: [%{name: "failure.log", url: "https://example.test/private-file"}]
      })

    result = build(c, trigger)
    assert result.prompt =~ "You are Builder (@builder) in #Lab"
    assert result.prompt =~ "Stay in this clone."
    assert result.prompt =~ "Fix @human's report"
    assert result.prompt =~ "failure.log"
    assert result.prompt =~ "Private block hidden from agents"
    refute result.prompt =~ "@reviewer"
    refute result.prompt =~ "request-secret"
    refute result.prompt =~ "channel-secret"
    refute result.prompt =~ "https://example.test/private-file"
    assert result.images == []
    assert result.reply_to == nil

    continued = build(c, trigger, %{}, "session-id")
    refute continued.prompt =~ "Stay in this clone."
    refute continued.prompt =~ "Keep progress in the run trace"
  end

  test "worker role overrides coordinator and ambient roles while delivery remains final-only",
       c do
    trigger = message(c, "@builder Verify reload", %{missionTaskId: "task-1"})
    settings = %{orchestrator: true, ambientGroupChat: true, finalReplyOnly: true}

    for resume <- [nil, "session-id"] do
      worker = build(c, trigger, settings, resume)
      assert worker.prompt =~ "mission worker, not the channel control plane"
      assert worker.prompt =~ "--task task-1 --status blocked"
      assert worker.prompt =~ "do not start a mission or spawn provider subagents"
      assert worker.prompt =~ "output exactly [no-reply]"
      refute worker.prompt =~ "mission start --control-plane"
      refute worker.prompt =~ "persistent participant"
    end

    trigger = message(c, "@builder Implement the release")

    for resume <- [nil, "session-id"] do
      coordinator = build(c, trigger, %{orchestrator: true}, resume)
      assert coordinator.prompt =~ "mission start --control-plane"
      assert coordinator.prompt =~ "mission delegate --anonymous"
      assert coordinator.prompt =~ "handle bookkeeping directly"

      assert coordinator.prompt =~
               "Successful background work completes the mission automatically"

      assert coordinator.prompt =~ "Reuse an existing mission for follow-ups and recovery"
      assert coordinator.prompt =~ "mission delegate --after <task-id>"
      assert coordinator.prompt =~ "corrections that must change active work now"

      assert coordinator.prompt =~
               "queued or dispatched acknowledgment does not confirm execution"

      assert coordinator.prompt =~ "honor explicit Stop"
      refute coordinator.prompt =~ "for actionable work immediately use"
    end

    ambient = build(c, trigger, %{ambientGroupChat: true, finalReplyOnly: true})
    assert ambient.prompt =~ "persistent participant"
    assert ambient.prompt =~ "Use your own judgment"
    assert ambient.prompt =~ "final response is posted automatically"
    assert ambient.prompt =~ "do not call cascade-chat send or collaboration tools"
    refute ambient.prompt =~ "output exactly [no-reply]"
  end

  test "Claude compact is a bare native command, not a quoted or worker request", c do
    trigger = message(c, "@BUILDER /CoMpAcT")
    assert build(c, trigger) == %{prompt: "/compact", images: [], reply_to: nil}
    assert build(c, trigger, %{}, "session-id").prompt == "/compact"

    assert Cascade.Runs.PromptContext.enrich_prompt(
             c.vault_id,
             c.user_id,
             "/compact",
             "claude-code",
             nil
           )
           |> Cascade.Runs.PromptContext.append_context(["Room state", "Mission guidance"]) ==
             "/compact"

    refute build(c, Map.put(trigger, :replyTo, ref(trigger, "question"))).prompt == "/compact"
    refute build(c, Map.put(trigger, :missionTaskId, "task-1")).prompt == "/compact"
    refute build(c, trigger, %{agentId: "codex"}).prompt == "/compact"
  end

  test "loads older reply evidence with recipient-specific provenance, typed links, images, and a cycle bound",
       c do
    evidence = message(c, "@reviewer investigate old evidence\n:::private\nquoted-secret\n:::")

    answer =
      message(c, "The failure is here", %{
        images: [image("quote")],
        replyTo: ref(evidence, "question")
      })

    trigger = message(c, "@builder review this", %{replyTo: ref(answer, "review_request")})

    for n <- 1..130, do: message(c, "Later unrelated #{n}")

    result = build(c, trigger)
    assert result.prompt =~ "Review requested for"
    assert result.prompt =~ "…which asked about"
    assert result.prompt =~ "old evidence"
    assert result.prompt =~ "addressed to @reviewer, not you — context only"
    refute result.prompt =~ "quoted-secret"
    refute result.prompt =~ "Later unrelated"
    assert result.images == [%{"media_type" => "image/png", "data" => "quote"}]

    assert result.reply_to == %{
             "messageId" => trigger.id,
             "author" => c.username,
             "mention" => "",
             "preview" => "@builder review this",
             "relationship" => "builds_on"
           }

    own = build(c, Map.put(trigger, :images, [image("own")]))
    assert own.images == [%{"media_type" => "image/png", "data" => "own"}]

    SQL.exec("UPDATE chat_messages SET reply_to_json=? WHERE id=?", [
      Jason.encode!(ref(answer, "question")),
      evidence.id
    ])

    cyclic = build(c, trigger)
    assert length(Regex.scan(~r/The failure is here/, cyclic.prompt)) == 1

    other = build(c, trigger, %{mention: "reviewer"})
    refute other.prompt =~ "not you — context only"
  end

  test "mention-only batches use the persisted cursor and author identity, carrying at most four images",
       c do
    message(c, "Other agent boundary", %{agentId: "codex"})
    for n <- 1..5, do: message(c, "Evidence #{n}", %{images: [image("batch#{n}")]})

    message(c, "\n:::private\nbatch-secret\n:::\nPlease inspect", %{
      attachments: [%{name: "trace.txt"}]
    })

    trigger = message(c, "@builder")
    message(c, "Future same-author text", %{images: [image("future")]})

    result = build(c, trigger)
    assert result.prompt =~ "Evidence 1"
    assert result.prompt =~ "Please inspect trace.txt"
    refute result.prompt =~ "batch-secret"
    refute result.prompt =~ "Other agent boundary"
    refute result.prompt =~ "Future same-author text"
    assert Enum.map(result.images, & &1["data"]) == ~w(batch2 batch3 batch4 batch5)

    direct = build(c, Map.put(trigger, :body, "@builder A different request"))
    refute direct.prompt =~ "Evidence 1"
    assert direct.images == result.images

    blind = build(c, trigger, %{agentId: "hermes"})
    assert blind.images == []
    assert blind.prompt =~ "4 image(s) not delivered inline"
    assert blind.prompt =~ "if unavailable, say so instead of guessing"
  end

  test "uses the owner-local linked channel and does not read reply evidence from another room",
       c do
    owner = Cascade.TestHelpers.owner_vault("dispatch-owner")
    local = channel(owner, "Owner room")
    {:ok, _} = Channel.link(c.vault_id, c.channel_id, owner.vault_id, local, owner.user_id)
    source = message(c, "Linked evidence", %{images: [image("linked")]})
    trigger = message(c, "@builder check", %{replyTo: ref(source, "review_request")})

    execution = %{
      c.execution
      | target_channel_id: local,
        runner_user_id: owner.user_id,
        vault: %{id: owner.vault_id}
    }

    dispatch = %{message: trigger, messageId: trigger.id, registration: c.execution.registration}
    result = DispatchPrompt.build(dispatch, execution, nil)
    assert result.prompt =~ "#Owner room"
    assert result.prompt =~ "Linked evidence"
    assert result.images == [%{"media_type" => "image/png", "data" => "linked"}]

    private_channel = channel(owner, "Other room")

    private =
      message(
        %{c | channel_id: private_channel, user_id: owner.user_id, vault_id: owner.vault_id},
        "Never fetch this evidence",
        %{images: [image("private")]}
      )

    reply = %{messageId: private.id, author: "Unknown", preview: "Unavailable source"}

    result =
      DispatchPrompt.build(
        %{dispatch | message: Map.put(trigger, :replyTo, reply)},
        execution,
        nil
      )

    assert result.prompt =~ "Unavailable source"
    refute result.prompt =~ "Never fetch this evidence"
    assert result.images == []

    {:ok, light} = Messages.list(local, owner.user_id)
    hydrated = Enum.find(light, &(&1.id == source.id))
    assert hydrated.hasImages
    result = DispatchPrompt.build(%{dispatch | message: hydrated}, execution, nil)
    assert result.images == [%{"media_type" => "image/png", "data" => "linked"}]

    assert_raise MatchError, fn ->
      DispatchPrompt.build(dispatch, %{execution | target_channel_id: c.channel_id}, nil)
    end
  end

  defp build(c, message, overrides \\ %{}, resume \\ nil) do
    registration = Map.merge(c.execution.registration, overrides)
    execution = %{c.execution | registration: registration, agent: registration.agentId}
    dispatch = %{message: message, messageId: message.id, registration: registration}
    DispatchPrompt.build(Jason.decode!(Jason.encode!(dispatch)), execution, resume)
  end

  defp message(c, body, extra \\ %{}) do
    {:ok, message} =
      Messages.create(
        %{id: c.user_id, username: c.username},
        c.vault_id,
        c.channel_id,
        Map.merge(%{body: body, author: c.username}, extra),
        access: :agent
      )

    message
  end

  defp channel(owner, title) do
    id = Ecto.UUID.generate()

    SQL.exec(
      "INSERT INTO notes(id,vault_id,title,content,created_by) VALUES(?,?,?,?,?)",
      [id, owner.vault_id, title, "cascade://chat-channel", owner.user_id]
    )

    id
  end

  defp image(data), do: "data:image/png;base64," <> data

  defp ref(message, relationship),
    do: %{
      messageId: message.id,
      author: message.author,
      preview: "clipped",
      relationship: relationship
    }
end
