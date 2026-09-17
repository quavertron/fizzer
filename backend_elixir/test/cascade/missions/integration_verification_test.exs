defmodule Cascade.Missions.IntegrationVerificationTest do
  use ExUnit.Case, async: false
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.Store

  setup do
    suffix = System.unique_integer([:positive])
    user = %{id: suffix + 8_000_000, username: "integration_verify_#{suffix}"}

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,? ,?,'',0)",
      [user.id, user.username, "x", user.username]
    )

    vault = ContentStore.create_vault(user.id, %{name: "Verification #{suffix}"})

    channel =
      ContentStore.create_note(vault.id, user.id, %{
        title: "Room",
        content: "cascade://chat-channel"
      })

    {:ok, identity} =
      Agents.upsert_identity(user.id, vault.id, %{
        agentId: "codex",
        displayName: "Coordinator",
        mention: "verify-#{suffix}"
      })

    {:ok, coordinator} =
      Agents.add_to_channel(user.id, vault.id, channel.id, identity.id, %{orchestrator: true})

    %{user: user, vault: vault, channel: channel, coordinator: coordinator}
  end

  test "explicit pinned integration verification closes without inventing another task", ctx do
    {mission, _work, review, integration, pin} = chain(ctx)
    input = finish_input(ctx, mission, pin)
    before = counts()
    assert {:error, _} = finish(ctx, mission, Map.delete(input, :verifiedIntegrations))

    for bad <- [
          Map.put(input, :objective, "changed objective"),
          Map.put(input, :verification, ""),
          Map.put(input, :verifiedIntegrations, [%{pin | runId: pin.runId + 1}]),
          Map.put(input, :verifiedIntegrations, [%{pin | attempt: pin.attempt + 1}]),
          Map.put(input, :verifiedIntegrations, [%{pin | taskId: review.id}]),
          Map.put(input, :verifiedIntegrations, "not a list")
        ] do
      assert {:error, _} = finish(ctx, mission, bad)
    end

    for status <- ["running", "canceled"] do
      SQL.exec("UPDATE runs SET status=? WHERE id=?", [status, pin.runId])
      assert {:error, _} = finish(ctx, mission, input)
    end

    SQL.exec("UPDATE runs SET status='completed' WHERE id=?", [pin.runId])

    SQL.exec("UPDATE chat_mission_tasks SET review_outcome='changes_requested' WHERE id=?", [
      review.id
    ])

    assert {:error, _} = finish(ctx, mission, input)

    assert [0] =
             SQL.one(
               "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='integration_verified_by_coordinator'",
               [mission.id]
             )

    SQL.exec("UPDATE chat_mission_tasks SET review_outcome='accepted' WHERE id=?", [review.id])

    {:ok, interpreted} =
      Cascade.Missions.Interpretation.get(
        ctx.user.id,
        ctx.channel.id,
        mission.id,
        ctx.coordinator.id
      )

    SQL.exec(
      "UPDATE chat_mission_interpretations SET handled_fingerprint=?,pending_fingerprint='',pending_context_json='{}' WHERE mission_id=?",
      [interpreted.fingerprint, mission.id]
    )

    assert {:ok, result} = finish(ctx, mission, input)
    assert result.mission.status == "completed"
    assert %{dispatches: [], wakeDispatches: []} = Cascade.Missions.Scheduler.schedule(mission.id)
    assert {:ok, _} = finish(ctx, mission, input)
    assert counts() == before

    assert [
             [
               integration.id,
               pin.runId,
               pin.attempt,
               "Observed exact release and affected behavior"
             ]
           ] ==
             SQL.all(
               "SELECT task_id,run_id,attempt,summary FROM chat_mission_events WHERE mission_id=? AND kind='integration_verified_by_coordinator'",
               [mission.id]
             )

    assert [0] =
             SQL.one(
               "SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=? AND purpose='verification'",
               [mission.id]
             )
  end

  test "HTTP finish carries exact pins and records a receipt for an isolated artifact", ctx do
    {mission, _work, _review, integration, pin} = chain(ctx)
    input = finish_input(ctx, mission, pin)

    SQL.exec("UPDATE chat_mission_tasks SET workspace_mode='isolated' WHERE id=?", [
      integration.id
    ])

    path = "/api/vaults/#{ctx.vault.id}/channels/#{ctx.channel.id}/missions/#{mission.id}/finish"
    token = Cascade.Auth.Token.sign_user(Map.put(ctx.user, :auth_version, 0))

    request = fn body ->
      Cascade.TestHelpers.json_conn(:post, path, body, token)
      |> CascadeWeb.MissionRouter.call(CascadeWeb.MissionRouter.init([]))
    end

    assert request.(input).status == 400

    SQL.exec(
      "UPDATE work_items SET base_commit=?,worktree_path='/inert/exact-worktree',verification='' WHERE id=?",
      [String.duplicate("a", 40), integration.workItemId]
    )

    response = request.(input)
    assert response.status == 200, response.resp_body
    assert Jason.decode!(response.resp_body)["mission"]["status"] == "completed"
    # Preserve missing old verifier fields instead of fabricating worker output.
    assert [""] =
             SQL.one("SELECT verification FROM work_items WHERE id=?", [integration.workItemId])

    state = Store.notification_state(mission.id)
    assert Enum.find(state.tasks, &(&1.id == integration.id)).evidence_ready
  end

  test "explicit verification does not waive a failed verification or unfinished task", ctx do
    {mission, _work, _review, integration, pin} = chain(ctx)
    input = finish_input(ctx, mission, pin)
    failed = task(ctx, mission, "verification", [integration.id])
    assert {:error, _} = finish(ctx, mission, input)
    settle(ctx, failed, verification_passed: "false")
    assert {:error, reason} = finish(ctx, mission, input)
    assert reason =~ "failed verification"

    assert [0] =
             SQL.one(
               "SELECT COUNT(*) FROM chat_mission_events WHERE mission_id=? AND kind='integration_verified_by_coordinator'",
               [mission.id]
             )
  end

  test "cross-mission closure reuses explicit recovery and unchanged verified ancestry only",
       ctx do
    target = mission(ctx, "CLI outcome")
    original = task(ctx, target, "implementation", [])
    target_pin = settle(ctx, original)
    {source, _work, review, integration, pin} = chain(ctx)
    input = finish_input(ctx, source, pin)

    target_finish = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      status: "completed",
      verification: "Same candidate reviewed and delivered"
    }

    assert {:error, _} = finish(ctx, target, target_finish)

    link = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      sourceTaskId: integration.id,
      sourceRunId: pin.runId,
      targetRunId: target_pin.runId,
      targetAttempt: target_pin.attempt,
      objective: target.objective,
      verification: "This integration includes the exact CLI candidate"
    }

    assert {:ok, _} = Store.link_recovery(ctx.user.id, ctx.channel.id, original.id, link)
    assert {:error, _} = finish(ctx, target, target_finish)
    assert {:ok, _} = finish(ctx, source, input)

    other_channel =
      ContentStore.create_note(ctx.vault.id, ctx.user.id, %{
        title: "Other room",
        content: "cascade://chat-channel"
      })

    SQL.exec("UPDATE chat_missions SET channel_id=? WHERE id=?", [other_channel.id, source.id])
    assert {:error, _} = finish(ctx, target, target_finish)
    SQL.exec("UPDATE chat_missions SET channel_id=? WHERE id=?", [ctx.channel.id, source.id])
    SQL.exec("UPDATE chat_mission_tasks SET attempt=attempt+1 WHERE id=?", [original.id])
    assert {:error, _} = finish(ctx, target, target_finish)
    SQL.exec("UPDATE chat_mission_tasks SET attempt=attempt-1 WHERE id=?", [original.id])
    # Neither edited review results nor another-channel completion retain authority.
    SQL.exec("UPDATE chat_mission_tasks SET review_outcome='changes_requested' WHERE id=?", [
      review.id
    ])

    assert {:error, _} = finish(ctx, target, target_finish)
    SQL.exec("UPDATE chat_mission_tasks SET review_outcome='accepted' WHERE id=?", [review.id])
    [old_git] = SQL.one("SELECT git_state_json FROM work_items WHERE id=?", [review.workItemId])

    SQL.exec("UPDATE work_items SET git_state_json=? WHERE id=?", [
      Jason.encode!(%{headCommit: "different-candidate"}),
      review.workItemId
    ])

    assert {:error, _} = finish(ctx, target, target_finish)
    SQL.exec("UPDATE work_items SET git_state_json=? WHERE id=?", [old_git, review.workItemId])
    SQL.exec("UPDATE chat_missions SET status='canceled' WHERE id=?", [source.id])
    assert {:error, _} = finish(ctx, target, target_finish)
    SQL.exec("UPDATE chat_missions SET status='completed' WHERE id=?", [source.id])
    before = counts()

    config =
      Application.get_all_env(:cascade_elixir) |> :erlang.term_to_binary() |> Base.encode64()

    paths = :code.get_path() |> Enum.flat_map(&["-pa", to_string(&1)])
    probe = Path.expand("../../support/integration_verification_probe.exs", __DIR__)

    {output, code} =
      System.cmd(
        System.find_executable("elixir"),
        paths ++
          [probe, config, to_string(ctx.user.id), ctx.channel.id, target.id, ctx.coordinator.id],
        env: [{"ERL_FLAGS", "+S 2:2"}],
        stderr_to_stdout: true
      )

    assert code == 0, output
    assert output =~ "EXPLICIT_LINK_CLOSED_AFTER_RESTART"
    assert {:ok, result} = finish(ctx, target, target_finish)
    assert result.mission.status == "completed"
    assert counts() == before

    assert [1] =
             SQL.one("SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=?", [target.id])
  end

  test "Stop cannot be turned into completion through a recovery link", ctx do
    target = mission(ctx, "Stopped objective")
    original = task(ctx, target, "implementation", [])
    target_pin = settle(ctx, original)
    {source, _work, _review, integration, pin} = chain(ctx)
    assert {:ok, _} = finish(ctx, source, finish_input(ctx, source, pin))

    assert {:ok, _} =
             finish(ctx, target, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "canceled"
             })

    assert {:error, _} =
             Store.link_recovery(ctx.user.id, ctx.channel.id, original.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               sourceTaskId: integration.id,
               sourceRunId: pin.runId,
               targetRunId: target_pin.runId,
               targetAttempt: target_pin.attempt,
               objective: target.objective,
               verification: "Evidence"
             })

    assert {:error, "Mission is already closed"} =
             finish(ctx, target, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed"
             })
  end

  defp counts,
    do:
      Enum.map(
        ["runs", "chat_agent_dispatches", "chat_mission_tasks"],
        &SQL.one("SELECT COUNT(*) FROM #{&1}")
      )

  defp finish(ctx, mission, input),
    do: Store.finish(ctx.user.id, ctx.channel.id, mission.id, input)

  defp finish_input(ctx, mission, pin),
    do: %{
      coordinatorRegistrationId: ctx.coordinator.id,
      status: "completed",
      objective: mission.objective,
      verifiedIntegrations: [pin],
      verification: "Observed exact release and affected behavior"
    }

  defp mission(ctx, title) do
    {:ok, root} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        id: Ecto.UUID.generate(),
        body: title
      })

    {:ok, result} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: title
      })

    result.mission
  end

  defp task(ctx, mission, purpose, deps) do
    {:ok, result} =
      Store.add_task(ctx.user.id, ctx.channel.id, mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "#{purpose} #{Ecto.UUID.generate()}",
        purpose: purpose,
        assignee: ctx.coordinator.id,
        anonymous: true,
        workspaceMode: "shared",
        dependsOn: deps
      })

    result.task
  end

  defp settle(ctx, task, opts \\ []) do
    dispatch = Ecto.UUID.generate()

    SQL.exec(
      "INSERT INTO runs(vault_id,owner_user_id,prompt,conversation_id,status,chat_dispatch_id) VALUES(?,?,?,?,?,?)",
      [ctx.vault.id, ctx.user.id, "Inert receipt", Ecto.UUID.generate(), "completed", dispatch]
    )

    run = SQL.last_insert_id()

    SQL.exec(
      "UPDATE chat_mission_tasks SET status='completed',summary='Existing result',run_id=?,dispatch_id=?,review_outcome=?,verification_passed=? WHERE id=?",
      [
        run,
        dispatch,
        Keyword.get(opts, :review_outcome),
        Keyword.get(opts, :verification_passed),
        task.id
      ]
    )

    %{taskId: task.id, runId: run, attempt: task.attempt}
  end

  defp chain(ctx) do
    mission = mission(ctx, "Reviewed delivery")
    work = task(ctx, mission, "implementation", [])
    settle(ctx, work)
    review = task(ctx, mission, "review", [work.id])
    settle(ctx, review, review_outcome: "accepted")
    integration = task(ctx, mission, "integration", [review.id])
    pin = settle(ctx, integration)
    {mission, work, review, integration, pin}
  end
end
