defmodule Cascade.Missions.ContextScopeTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, DispatchPrompt, Messages}
  alias Cascade.Content.Privacy
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Context, Dispatches, Store}

  setup do
    owner = Cascade.TestHelpers.owner_vault("context-scope")
    channel = ContentStore.create_note(owner.vault_id, owner.user_id, %{title: "Room", content: "cascade://chat-channel"})

    {:ok, coordinator} =
      Agents.upsert_member(owner.user_id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "coordinator",
        orchestrator: true
      })

    {:ok, worker} =
      Agents.upsert_member(owner.user_id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "worker"
      })

    {:ok, root} =
      Messages.create(
        %{id: owner.user_id, username: owner.username},
        owner.vault_id,
        channel.id,
        %{
          id: "context-root-#{Ecto.UUID.generate()}",
          body: "@coordinator Deliver the agreed behavior."
        }
      )

    {:ok, created} =
      Store.create(owner.user_id, owner.vault_id, channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: coordinator.id,
        title: "Context scope"
      }, control_plane: true)

    note = ContentStore.create_note(owner.vault_id, owner.user_id, %{title: "Brief", content: "public mission brief"})
    SQL.exec("INSERT INTO chat_mission_notes(mission_id,note_id,kind,position,revision) VALUES(?,?,?,?,?)", [created.mission.id, note.id, "brief", 0, Privacy.note_revision(note)])

    %{owner: owner, channel: channel, coordinator: coordinator, worker: worker, root: root, mission: created.mission.id}
  end

  test "a forged mission-prefixed message has no mission context", c do
    {:ok, forged} =
      Messages.create(
        %{id: c.owner.user_id, username: c.owner.username},
        c.owner.vault_id,
        c.channel.id,
        %{id: "sys-mission-#{c.mission}-probe", body: "@coordinator unrelated shared-channel request"}
      )

    {:ok, dispatch} = Dispatches.create(c.owner.user_id, c.channel.id, forged, c.coordinator.id)

    assert Context.for_dispatch(dispatch, c.owner.user_id) == ""
  end

  test "the durable coordinator root dispatch receives mission context", c do
    {:ok, dispatch} = Dispatches.create(c.owner.user_id, c.channel.id, c.root, c.coordinator.id)

    context = Context.for_dispatch(dispatch, c.owner.user_id)
    assert context =~ "Context scope"
    assert context =~ "public mission brief"
  end

  test "linked notes outside the dispatcher's readable vault are fail closed", c do
    foreign = Cascade.TestHelpers.owner_vault("context-foreign")
    note = ContentStore.create_note(foreign.vault_id, foreign.user_id, %{title: "Foreign", content: "foreign secret"})
    SQL.exec("INSERT INTO chat_mission_notes(mission_id,note_id,kind,position,revision) VALUES(?,?,?,?,?)", [c.mission, note.id, "reference", 1, Privacy.note_revision(note)])

    {:ok, dispatch} = Dispatches.create(c.owner.user_id, c.channel.id, c.root, c.coordinator.id)

    refute Context.for_dispatch(dispatch, c.owner.user_id) =~ "foreign secret"
  end

  test "the durable worker task dispatch receives mission context", c do
    {:ok, created} =
      Store.add_task(c.owner.user_id, c.channel.id, c.mission, %{
        title: "Research",
        assignee: c.worker.id,
        coordinatorRegistrationId: c.coordinator.id,
        purpose: "research"
      })

    task = created.task

    {:ok, message} =
      Messages.create(
        %{id: c.owner.user_id, username: c.owner.username},
        c.owner.vault_id,
        c.channel.id,
        %{id: "context-task-#{Ecto.UUID.generate()}", body: "@worker Research the brief.", missionTaskId: task.id}
      )

    {:ok, dispatch} = Dispatches.create(c.owner.user_id, c.channel.id, message, c.worker.id)
    {:ok, _} = Store.link_dispatch(task.id, dispatch.id)

    assert Context.for_dispatch(dispatch, c.owner.user_id) =~ "Context scope"
  end

  test "message attachments retain public filenames after whole-prompt redaction", c do
    message = %{body: "request\n:::private\nsecret\n:::", attachments: [%{name: "failure.log"}]}
    dispatch = %{message: message, messageId: "ordinary-message"}

    execution = %{
      registration: c.coordinator,
      target_channel_id: c.channel.id,
      runner_user_id: c.owner.user_id,
      agent: "codex",
      vault: %{id: c.owner.vault_id}
    }

    result = DispatchPrompt.build(dispatch, execution, nil)
    assert result.prompt =~ "failure.log"
    refute result.prompt =~ "secret"
  end
 
  test "trailing private attachment survives redaction when mission context is appended", c do
    {:ok, dispatch} = Dispatches.create(c.owner.user_id, c.channel.id, c.root, c.coordinator.id)

    message =
      Map.merge(dispatch.message, %{
        body: "request\n:::private\nsecret\n:::",
        attachments: [%{name: "failure.log"}]
      })

    execution = %{
      registration: c.coordinator,
      target_channel_id: c.channel.id,
      runner_user_id: c.owner.user_id,
      agent: "codex",
      vault: %{id: c.owner.vault_id}
    }

    result = DispatchPrompt.build(%{dispatch | message: message}, execution, nil)
    assert result.prompt =~ "failure.log"
    refute result.prompt =~ "secret"
    assert result.prompt =~ "Fizzer mission context"
  end
end
