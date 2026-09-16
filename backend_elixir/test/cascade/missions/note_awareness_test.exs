defmodule Cascade.Missions.NoteAwarenessTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Content.{Privacy, Store}
  alias Cascade.Chat.Messages
  alias Cascade.Missions.{Dispatches, Interpretation, Scheduler}
  alias Cascade.Missions.Store, as: MissionStore
  alias Cascade.Runs.Store, as: Runs

  @router_options CascadeWeb.ContentRouter.init([])

  test "ordered linked-note writes retain committed revisions and trusted actors" do
    owner = Cascade.TestHelpers.owner_vault("note-awareness")
    user = %{id: owner.user_id, username: owner.username}

    channel =
      Store.create_note(owner.vault_id, owner.user_id, %{
        title: "Channel",
        content: "cascade://chat-channel"
      })

    {:ok, root} = Messages.create(user, owner.vault_id, channel.id, %{body: "Mission"})
    mission_id = Ecto.UUID.generate()
    note = Store.create_note(owner.vault_id, owner.user_id, %{title: "Brief", content: "initial"})

    SQL.exec(
      """
      INSERT INTO chat_missions
        (id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,created_by)
      VALUES (?,?,?,?,?,?,?)
      """,
      [mission_id, owner.vault_id, channel.id, root.id, "coordinator", "Mission", owner.user_id]
    )

    SQL.exec(
      "INSERT INTO chat_mission_notes(mission_id,note_id,kind,revision) VALUES (?,?,?,?)",
      [mission_id, note.id, "mission", Privacy.note_revision(note)]
    )

    first = Store.update_note(
      note.id,
      "first",
      111,
      expected_revision: Privacy.note_revision(note),
      actor_origin: :human,
      auth: %{actor_id: 111, origin: :human}
    )

    second = Store.update_note(
      note.id,
      "second",
      222,
      expected_revision: Privacy.note_revision(first),
      actor_origin: :human,
      auth: %{actor_id: 222, origin: :human}
    )

    events =
      SQL.all(
        "SELECT summary FROM chat_mission_events WHERE mission_id=? AND kind='mission_note_changed' ORDER BY id",
        [mission_id]
      )
      |> Enum.map(fn [summary] -> Jason.decode!(summary) end)

    assert Enum.map(events, & &1["actorId"]) == [111, 222]
    assert Enum.map(events, & &1["committedRevision"]) ==
             [Privacy.note_revision(first), Privacy.note_revision(second)]
    assert Enum.map(events, &get_in(&1, ["auth", "origin"])) == ["human", "human"]
  end

  test "linked-note observer failure rolls back content, file and rename revisions" do
    c = interpretation_fixture("observer-rollback")
    note = Store.get_note(c.note)
    file = Store.resolve_note_path(note.id)
    previous = Application.fetch_env!(:cascade_elixir, :linked_note_revision_observer)
    on_exit(fn -> Application.put_env(:cascade_elixir, :linked_note_revision_observer, previous) end)
    Application.put_env(:cascade_elixir, :linked_note_revision_observer, fn id, _, _, opts ->
      assert id == note.id
      assert opts[:in_transaction]
      # Any observer writes must roll back along with the note itself.
      SQL.exec("UPDATE chat_mission_notes SET revision='must-roll-back' WHERE note_id=?", [id])
      raise "observer failed"
    end)
    linked_before = SQL.all("SELECT revision FROM chat_mission_notes WHERE note_id=?", [note.id])

    assert_raise RuntimeError, "observer failed", fn ->
      Store.update_note(note.id, "must not commit", c.user.id,
        expected_revision: Privacy.note_revision(note), actor_origin: :human)
    end
    assert Store.get_note(note.id).content == note.content
    assert Privacy.note_revision(Store.get_note(note.id)) == Privacy.note_revision(note)
    assert File.read!(file) == note.content
    assert SQL.all("SELECT revision FROM chat_mission_notes WHERE note_id=?", [note.id]) == linked_before

    assert_raise RuntimeError, "observer failed", fn ->
      Store.rename_note(note.id, "Must not rename", c.user.id)
    end
    assert Store.get_note(note.id).title == note.title
    assert Privacy.note_revision(Store.get_note(note.id)) == Privacy.note_revision(note)
    assert SQL.all("SELECT revision FROM chat_mission_notes WHERE note_id=?", [note.id]) == linked_before

    Application.delete_env(:cascade_elixir, :linked_note_revision_observer)
    assert_raise ArgumentError, fn ->
      Store.update_note(note.id, "missing observer", c.user.id,
        expected_revision: Privacy.note_revision(note), actor_origin: :human)
    end
    assert File.read!(file) == note.content
    assert Store.get_note(note.id).content == note.content
  end

  test "agent orbit caption restores private blocks from a redacted proposal" do
    owner = Cascade.TestHelpers.owner_vault("orbit-caption")
    note =
      Store.create_note(owner.vault_id, owner.user_id, %{
        title: "Private note",
        content: "public\n:::private\nsecret\n:::\n"
      })

    user = %{id: owner.user_id, username: owner.username, auth_version: 0}
    token = Token.sign_agent(user)

    conn =
      conn(:post, "/api/notes/#{note.id}/orbit-caption", Jason.encode!(%{label: "Agent", status: "done"}))
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer #{token}")
      |> CascadeWeb.ContentRouter.call(@router_options)

    assert conn.status == 200
    assert Store.get_note(note.id).content =~ "secret"
    assert Store.get_note(note.id).content =~ "- Agent — done"
  end
  test "approval evidence wakes the coordinator once" do
    c = interpretation_fixture("approval-wake")
    note = Store.get_note(c.note)

    external =
      Store.update_note(
        note.id,
        "baseline",
        c.user.id,
        expected_revision: Privacy.note_revision(note),
        actor_origin: :human,
        auth: %{actor_id: c.user.id, origin: :human}
      )

    wake = c.mission |> Scheduler.schedule() |> Map.fetch!(:wakeDispatches) |> hd()
    review = start_run(c, wake.dispatch)
    assert {:ok, _} = record(c, review, %{"noMaterialChange" => true})
    :ok = Runs.finish(review.id, "completed", "Recorded")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    assert {:ok, _} =
             MissionStore.approve_workspace(
               c.user.id,
               c.vault,
               c.mission,
               %{note.id => Privacy.note_revision(external)}
             )

    {:ok, approved_state} =
      Interpretation.get(c.user.id, c.channel, c.mission, c.coordinator.id)

    assert approved_state.fingerprint != ""
    assert get_in(approved_state.evidence, ["approval", "approvedBy"]) == c.user.id
    assert Scheduler.schedule(c.mission).wakeDispatches == []
  end

  test "coordinator self-edit is acknowledged but concurrent external edit remains wakeable" do
    c = interpretation_fixture("self-edit")
    note = Store.get_note(c.note)

    initial =
      Store.update_note(
        note.id,
        "initial external",
        c.user.id,
        expected_revision: Privacy.note_revision(note),
        actor_origin: :human,
        auth: %{actor_id: c.user.id, origin: :human}
      )

    wake = c.mission |> Scheduler.schedule() |> Map.fetch!(:wakeDispatches) |> hd()
    review = start_run(c, wake.dispatch)

    self_edit =
      Store.update_note(
        note.id,
        "coordinator edit",
        c.user.id,
        expected_revision: Privacy.note_revision(initial),
        actor_origin: :agent,
        auth: %{
          actor_id: c.user.id,
          origin: :agent,
          registration_id: c.coordinator.id,
          run_id: review.id,
          dispatch_id: wake.dispatch.id
        }
      )

    assert {:ok, _} = record(c, review, %{"noMaterialChange" => true})
    :ok = Runs.finish(review.id, "completed", "Recorded")
    assert Scheduler.schedule(c.mission).wakeDispatches == []

    external =
      Store.update_note(
        note.id,
        "human edit after coordinator",
        c.user.id + 1,
        expected_revision: Privacy.note_revision(self_edit),
        actor_origin: :human,
        auth: %{actor_id: c.user.id + 1, origin: :human}
      )

    assert external.content == "human edit after coordinator"
    assert [_wake] = Scheduler.schedule(c.mission).wakeDispatches
  end

  defp interpretation_fixture(prefix) do
    owner = Cascade.TestHelpers.owner_vault(prefix)
    user = %{id: owner.user_id, username: owner.username}

    channel =
      Store.create_note(owner.vault_id, user.id, %{
        title: "Interpretation",
        content: "cascade://chat-channel"
      })

    {:ok, coordinator} =
      Cascade.Chat.Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "coordinator",
        orchestrator: true
      })

    {:ok, root} = Messages.create(user, owner.vault_id, channel.id, %{body: "Mission"})

    {:ok, update} =
      MissionStore.create(
        user.id,
        owner.vault_id,
        channel.id,
        %{
          rootMessageId: root.id,
          coordinatorRegistrationId: coordinator.id,
          title: "Mission"
        },
        control_plane: true
      )

    note = Store.create_note(owner.vault_id, user.id, %{title: "Brief", content: "brief"})

    SQL.exec(
      "INSERT INTO chat_mission_notes(mission_id,note_id,kind,revision) VALUES (?,?,?,?)",
      [update.mission.id, note.id, "mission", Privacy.note_revision(note)]
    )

    Interpretation.initialize(update.mission.id)

    %{
      user: user,
      vault: owner.vault_id,
      channel: channel.id,
      coordinator: coordinator,
      mission: update.mission.id,
      note: note.id
    }
  end

  defp start_run(c, dispatch) do
    {:ok, run} =
      Runs.start(c.vault, nil, "Interpret", "codex",
        owner_user_id: c.user.id,
        chat_dispatch_id: dispatch.id,
        conversation_id: dispatch.conversationId
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)
    run
  end

  defp record(c, run, fields) do
    {:ok, current} = Interpretation.get(c.user.id, c.channel, c.mission, c.coordinator.id)

    input =
      Map.merge(%{"revision" => current.revision, "fingerprint" => current.fingerprint}, fields)

    Interpretation.record(
      c.user,
      c.channel,
      c.mission,
      c.coordinator.id,
      input,
      run.id,
      Cascade.Chat.Events.Noop
    )
  end

end
