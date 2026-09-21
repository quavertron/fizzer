defmodule Cascade.Chat.DelegationTest do
  use ExUnit.Case, async: false
  import Cascade.TestHelpers
  import Plug.Conn
  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Token
  alias Cascade.Chat.{Agents, Delegation, Messages, Schema}
  alias Cascade.Content.Store, as: Content
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Runs.Store, as: Runs

  setup do
    owner = owner_vault("delegation")
    user = %{id: owner.user_id, username: owner.username, auth_version: 0}

    channel =
      Content.create_note(owner.vault_id, user.id, %{
        title: "Room",
        content: "cascade://chat-channel"
      })

    {:ok, source} =
      Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "source",
        orchestrator: true
      })

    {:ok, sibling} =
      Agents.upsert_member(user.id, owner.vault_id, channel.id, %{
        agentId: "codex",
        mention: "sibling",
        taggableByAgents: true
      })

    {:ok, root} =
      Messages.create(user, owner.vault_id, channel.id, %{body: "Deliver the scoped change"})

    {:ok, dispatch} = Dispatches.create(user.id, channel.id, root, source.id)

    {:ok, run} =
      Runs.start(owner.vault_id, nil, "Inert source fixture", "codex",
        owner_user_id: user.id,
        chat_dispatch_id: dispatch.id,
        conversation_id: dispatch.conversationId
      )

    :ok = Dispatches.attach_run(dispatch.id, run.id)

    %{
      user: user,
      vault: owner.vault_id,
      channel: channel.id,
      source: source,
      sibling: sibling,
      root: root,
      run: run,
      token: Token.sign_run_agent(user, run.id),
      human: Token.sign_user(user),
      generic: Token.sign_agent(user)
    }
  end

  test "default on, shared identity across vault registrations, omitted updates and rebuild-safe ensure",
       c do
    assert c.source.missionsEnabled
    other = Content.create_vault(c.user.id, %{name: "Other"})
    on_exit(fn -> SQL.exec("DELETE FROM vaults WHERE id=?", [other.id]) end)

    room =
      Content.create_note(other.id, c.user.id, %{
        title: "Other room",
        content: "cascade://chat-channel"
      })

    {:ok, shared} = Agents.add_to_channel(c.user.id, other.id, room.id, c.source.vaultAgentId)
    set(c, c.source, false)
    refute Delegation.enabled?(shared.id)
    assert Delegation.enabled?(c.sibling.id)

    {:ok, identity} =
      Agents.upsert_identity(c.user.id, c.vault, %{
        id: c.source.vaultAgentId,
        agentId: "codex",
        mention: "source",
        displayName: "Updated"
      })

    refute identity.missionsEnabled

    {:ok, member} =
      Agents.add_to_channel(c.user.id, c.vault, c.channel, identity.id, %{model: "other"})

    refute member.missionsEnabled
    for _ <- 1..2, do: assert(:ok == Schema.ensure!())
    refute Delegation.enabled?(shared.id)
    {:ok, members} = Agents.ensure_vault_wide(c.user.id, c.vault, c.channel)
    refute Enum.find(members, &(&1.id == c.source.id)).missionsEnabled
    assert Enum.find(members, &(&1.id == c.sibling.id)).missionsEnabled
  end

  test "only owner credentials may write capability through every profile/member path", c do
    identity_path = "/api/vaults/#{c.vault}/vault-agents"

    assert request(
             c,
             :put,
             identity_path,
             %{
               id: c.source.vaultAgentId,
               agentId: "codex",
               mention: "source",
               missionsEnabled: false
             },
             c.human
           ).status == 200

    refute Delegation.enabled?(c.source.id)

    for token <- [c.token, c.generic],
        {method, path, payload} <- [
          {:put, identity_path,
           %{id: c.source.vaultAgentId, agentId: "codex", missionsEnabled: true}},
          {:put, base(c) <> "/agents",
           %{vaultAgentId: c.source.vaultAgentId, missionsEnabled: true}},
          {:put, base(c) <> "/agents",
           %{agentId: "codex", mention: "new", missionsEnabled: true}},
          {:post, base(c) <> "/agents/from-vault",
           %{vaultAgentId: c.source.vaultAgentId, missionsEnabled: true}},
          {:patch, base(c) <> "/agents/#{c.source.id}/settings-v1",
           %{expectedRevision: "x", patch: %{missionsEnabled: true}}},
          {:put, identity_path,
           %{id: c.source.vaultAgentId, agentId: "codex", nested: %{missions_enabled: true}}}
        ] do
      assert request(c, method, path, payload, token).status == 403
      refute Delegation.enabled?(c.source.id)
    end

    # Unrelated profile edits stay available; omission cannot reset the setting.
    assert request(
             c,
             :put,
             identity_path,
             %{
               id: c.source.vaultAgentId,
               agentId: "codex",
               mention: "source",
               displayName: "Still editable"
             },
             c.token
           ).status == 200

    refute Delegation.enabled?(c.source.id)
    stranger = owner_vault("delegation-stranger")
    {:ok, _} = Cascade.Accounts.VaultMembers.add(c.vault, c.user.id, stranger.user_id, "editor")

    assert {:error, _} =
             Agents.upsert_identity(stranger.user_id, c.vault, %{
               id: c.source.vaultAgentId,
               agentId: "codex",
               missionsEnabled: true
             })

    refute Delegation.enabled?(c.source.id)

    assert {:error, 400, _} =
             Cascade.Chat.RegistrationSettings.update(
               c.user.id,
               c.vault,
               c.channel,
               c.source.id,
               %{},
               %{"expectedRevision" => "x", "patch" => %{"missionsEnabled" => true}}
             )
  end

  test "a foreign identity from another home vault cannot be overwritten through an accessible vault",
       c do
    stranger = owner_vault("delegation-other-home")

    {:ok, identity} =
      Agents.upsert_identity(stranger.user_id, stranger.vault_id, %{
        agentId: "codex",
        mention: "foreign",
        missionsEnabled: false
      })

    before =
      SQL.one("SELECT owner_user_id,missions_enabled,mention FROM vault_agents WHERE id=?", [
        identity.id
      ])

    response =
      request(
        c,
        :put,
        "/api/vaults/#{c.vault}/vault-agents",
        %{id: identity.id, agentId: "codex", mention: "replacement", missionsEnabled: true},
        c.human
      )

    assert response.status == 403

    assert SQL.one("SELECT owner_user_id,missions_enabled,mention FROM vault_agents WHERE id=?", [
             identity.id
           ]) == before

    response =
      request(
        c,
        :put,
        base(c) <> "/agents",
        %{id: identity.id, agentId: "codex", mention: "replacement", missionsEnabled: true},
        c.human
      )

    assert response.status == 403

    assert SQL.one("SELECT owner_user_id,missions_enabled,mention FROM vault_agents WHERE id=?", [
             identity.id
           ]) == before
  end

  test "bound provenance rejects missing identity, forged run and enabled-sibling substitution",
       c do
    input = mission_input(c)
    path = base(c) <> "/missions"
    before = counts()
    assert request(c, :post, path, input, c.generic).status == 403

    assert request(c, :post, path, %{input | coordinatorRegistrationId: c.sibling.id}).status ==
             403

    assert request(c, :post, path, input, c.token, c.run.id + 1000).status == 403
    assert counts() == before
    assert {:ok, claims} = Token.verify(c.token)
    assert claims.agent_source["registrationId"] == c.source.id
    assert claims.agent_source["vaultAgentId"] == c.source.vaultAgentId
    # Omitted client run header uses signed server provenance, never human mode.
    assert request(c, :post, path, input).status == 201
  end

  test "both creation surfaces and root task delegation deny disabled sources before writes", c do
    set(c, c.source, false)
    before = counts()

    for token <- [c.token, c.human] do
      assert request(c, :post, base(c) <> "/missions", mission_input(c), token).status in [
               400,
               403
             ]

      assert request(
               c,
               :post,
               "/api/vaults/#{c.vault}/missions",
               Map.merge(mission_input(c), %{
                 id: Ecto.UUID.generate(),
                 channelId: c.channel,
                 coordinatorIdentityId: c.source.vaultAgentId,
                 briefContent: "Brief"
               }),
               token
             ).status in [400, 403]
    end

    assert counts() == before
    set(c, c.source, true)
    mission = mission(c)
    set(c, c.source, false)
    before = counts()
    assert {:error, reason} = Store.add_task(c.user.id, c.channel, mission.id, task_input(c))
    assert reason =~ "disabled"
    assert counts() == before
  end

  test "chat, mention and typed handoff cannot substitute siblings or leave partial messages",
       c do
    path = base(c) <> "/messages"
    set(c, c.source, false)
    before = counts()

    assert request(c, :post, path, %{
             id: "denied-#{c.run.id}",
             registrationId: c.source.id,
             body: "@sibling do it"
           }).status == 400

    assert request(c, :post, path, %{registrationId: c.sibling.id, body: "@source do it"}).status ==
             403

    assert request(
             c,
             :post,
             path,
             %{registrationId: c.sibling.id, body: "@source do it"},
             c.generic
           ).status == 400

    assert request(c, :post, path <> "/#{c.root.id}/collaborate", %{
             registrationId: c.source.id,
             target: c.sibling.id,
             relationship: "question",
             instruction: "Investigate"
           }).status == 400

    assert counts() == before

    posted =
      request(c, :post, path, %{registrationId: c.source.id, body: "Here is my direct answer"})

    assert posted.status == 201
    assert Jason.decode!(posted.resp_body)["dispatches"] == []

    quiet =
      request(
        c,
        :post,
        base(c) <> "/messages-no-invoke-v1",
        %{author: "External", body: "@sibling quoted only"},
        c.generic
      )

    assert quiet.status == 201
    assert Jason.decode!(quiet.resp_body)["dispatches"] == []
    # A human can still directly invoke the disabled agent.
    assert request(c, :post, path, %{body: "@source direct work"}, c.human).status == 201
  end

  test "source controls queue and start, not the destination's ability to delegate", c do
    mission = mission(c)
    set(c, c.sibling, false)
    {:ok, added} = Store.add_task(c.user.id, c.channel, mission.id, task_input(c))
    set(c, c.source, false)

    for _ <- 1..2 do
      assert Store.schedulable(mission.id).candidates == []
    end

    assert SQL.one("SELECT status,dispatch_id FROM chat_mission_tasks WHERE id=?", [added.task.id]) ==
             ["pending", nil]

    assert SQL.one(
             "SELECT COUNT(*) FROM chat_mission_events WHERE task_id=? AND kind='delegation_deferred'",
             [added.task.id]
           ) == [1]

    {:ok, update} = Store.get(c.user.id, c.channel, mission.id)
    waiting = Enum.find(update.mission.tasks, &(&1.id == added.task.id)).waitingReason
    assert waiting.kind == "delegation-disabled"
    assert waiting.detail =~ "disabled"
    set(c, c.source, true)
    [item] = Scheduler.schedule(mission.id).dispatches
    assert {:ok, _} = Dispatches.for_execution(item.dispatch.id)
    set(c, c.source, false)
    assert {:deferred, reason} = Dispatches.for_execution(item.dispatch.id)
    assert reason =~ "disabled"

    assert SQL.one("SELECT failed_at,run_id,error FROM chat_agent_dispatches WHERE id=?", [
             item.dispatch.id
           ]) == [nil, nil, reason]

    refute Enum.any?(Dispatches.pending(), &(&1.id == item.dispatch.id))
    set(c, c.source, true)
    assert {:ok, _} = Dispatches.for_execution(item.dispatch.id)

    {:ok, run} =
      Runs.start(c.vault, nil, "Inert worker fixture", "codex",
        owner_user_id: c.user.id,
        chat_dispatch_id: item.dispatch.id
      )

    :ok = Dispatches.attach_run(item.dispatch.id, run.id)
    {:ok, _} = Store.attach_run(item.dispatch.id, run.id)
    set(c, c.source, false)

    assert {:ok, _} =
             Store.update_task(c.user.id, c.channel, added.task.id, %{
               status: "completed",
               summary: "Existing result"
             })

    Runs.finish(run.id, "completed", "Existing result")

    assert {:error, reason} =
             Store.update_task(c.user.id, c.channel, added.task.id, %{status: "pending"})

    assert reason =~ "disabled"

    assert SQL.one("SELECT status,summary FROM chat_mission_tasks WHERE id=?", [added.task.id]) ==
             ["completed", "Existing result"]
  end

  test "pinned chat source stays disabled even when the message attribution changes", c do
    {:ok, message} =
      Messages.create(
        c.user,
        c.vault,
        c.channel,
        %{registrationId: c.source.id, body: "@sibling investigate"},
        access: :agent
      )

    {:ok, dispatch} = Dispatches.create(c.user.id, c.channel, message, c.sibling.id)
    set(c, c.source, false)

    SQL.exec("UPDATE chat_messages SET registration_id=NULL,agent_id=NULL WHERE id=?", [
      message.id
    ])

    assert {:deferred, _} = Dispatches.for_execution(dispatch.id)
    set(c, c.source, true)
    assert {:ok, _} = Dispatches.for_execution(dispatch.id)
  end

  test "disabled mission cannot poison global scheduling and Stop survives re-enable", c do
    first = mission(c)
    {:ok, held} = Store.add_task(c.user.id, c.channel, first.id, task_input(c))

    {:ok, root} =
      Messages.create(c.user, c.vault, c.channel, %{body: "Separate authorized objective"})

    {:ok, second} =
      Store.create(
        c.user.id,
        c.vault,
        c.channel,
        %{rootMessageId: root.id, coordinatorRegistrationId: c.sibling.id, title: "Independent"},
        control_plane: true
      )

    {:ok, ready} =
      Store.add_task(c.user.id, c.channel, second.mission.id, %{
        coordinatorRegistrationId: c.sibling.id,
        title: "Independent task",
        purpose: "research",
        anonymous: true
      })

    set(c, c.source, false)
    scheduled = Scheduler.schedule()
    assert Enum.any?(scheduled.dispatches, &(&1.message.missionTaskId == ready.task.id))
    refute Enum.any?(scheduled.dispatches, &(&1.message.missionTaskId == held.task.id))

    stopped =
      request(c, :post, base(c) <> "/missions/#{first.id}/finish", %{
        coordinatorRegistrationId: c.source.id,
        status: "canceled",
        summary: "Stop"
      })

    assert stopped.status == 200
    before = SQL.one("SELECT status,phase FROM chat_missions WHERE id=?", [first.id])
    set(c, c.source, true)
    assert Scheduler.schedule(first.id).dispatches == []
    assert SQL.one("SELECT status,phase FROM chat_missions WHERE id=?", [first.id]) == before
    assert before == ["canceled", "closed"]

    assert SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [held.task.id]) == [
             "canceled"
           ]
  end

  test "retry uses bound actor even for normalized status payloads", c do
    {:ok, root} = Messages.create(c.user, c.vault, c.channel, %{body: "Sibling objective"})

    {:ok, created} =
      Store.create(
        c.user.id,
        c.vault,
        c.channel,
        %{
          rootMessageId: root.id,
          coordinatorRegistrationId: c.sibling.id,
          title: "Sibling mission"
        },
        control_plane: true
      )

    {:ok, added} =
      Store.add_task(c.user.id, c.channel, created.mission.id, %{
        coordinatorRegistrationId: c.sibling.id,
        title: "Retry target",
        purpose: "research",
        anonymous: true
      })

    SQL.exec("UPDATE chat_mission_tasks SET status='failed' WHERE id=?", [added.task.id])
    set(c, c.source, false)

    for token <- [c.generic, c.token], status <- ["pending", " pending "] do
      assert request(
               c,
               :patch,
               base(c) <> "/missions/tasks/#{added.task.id}",
               %{status: status},
               token
             ).status == 403
    end

    assert SQL.one("SELECT status,attempt FROM chat_mission_tasks WHERE id=?", [added.task.id]) ==
             ["failed", 0]

    assert request(
             c,
             :patch,
             base(c) <> "/missions/tasks/#{added.task.id}",
             %{status: "pending"},
             c.human
           ).status == 200
  end

  test "disabled source cannot schedule a sibling via automatic invocation settings", c do
    set(c, c.source, false)
    before = counts()

    for token <- [c.token, c.generic],
        flags <- [
          %{orchestrator: false},
          %{nextStepSuggestions: true},
          %{nested: %{next_step_suggestions: true}}
        ] do
      assert request(
               c,
               :put,
               base(c) <> "/agents",
               Map.put(flags, :vaultAgentId, c.sibling.vaultAgentId),
               token
             ).status == 403
    end

    assert counts() == before
    # The exact two-step review reproduction cannot switch coordinators.
    assert request(c, :put, base(c) <> "/agents", %{
             vaultAgentId: c.source.vaultAgentId,
             orchestrator: false
           }).status == 403

    assert request(c, :put, base(c) <> "/agents", %{
             vaultAgentId: c.sibling.vaultAgentId,
             orchestrator: true,
             nextStepSuggestions: true
           }).status == 403

    # An actual owner can still opt in to a suggestion checkpoint.
    assert request(
             c,
             :put,
             base(c) <> "/agents",
             %{vaultAgentId: c.source.vaultAgentId, orchestrator: false},
             c.human
           ).status == 200

    assert request(
             c,
             :put,
             base(c) <> "/agents",
             %{
               vaultAgentId: c.sibling.vaultAgentId,
               orchestrator: true,
               nextStepSuggestions: true
             },
             c.human
           ).status == 200

    [id] =
      SQL.one(
        "SELECT id FROM chat_agent_dispatches WHERE registration_id=? AND message_id LIKE 'sys-next-enable-%'",
        [c.sibling.id]
      )

    assert {:ok, _} = Dispatches.for_execution(id)
  end

  test "expired active bearer renews its own source and preserves disabled work reporting", c do
    mission = mission(c)
    {:ok, task} = Store.add_task(c.user.id, c.channel, mission.id, task_input(c))
    expired = aged_token(c.token, 43201)
    set(c, c.source, false)
    assert request(c, :get, base(c) <> "/missions/" <> mission.id, nil, expired).status == 401

    response =
      request(
        c,
        :post,
        "/api/auth/agent-token/renew",
        %{runId: c.run.id + 1, registrationId: c.sibling.id},
        expired
      )

    # Claimed alternate registration is rejected, not used to mint a new source.
    assert response.status == 403
    response = request(c, :post, "/api/auth/agent-token/renew", %{runId: c.run.id + 1}, expired)
    assert response.status == 200
    fresh = Jason.decode!(response.resp_body)["token"]
    assert {:ok, %{agent_source: source}} = Token.verify(fresh)
    assert source == Delegation.run_source(c.user.id, c.run.id)
    assert request(c, :get, base(c) <> "/missions/" <> mission.id, nil, fresh).status == 200

    assert request(
             c,
             :patch,
             base(c) <> "/missions/tasks/" <> task.task.id,
             %{status: "completed", summary: "Preserved result"},
             fresh
           ).status == 200

    assert request(c, :post, base(c) <> "/missions", mission_input(c), fresh).status == 403
  end

  test "renewal rejects generic, revoked, stale, foreign and ended-run proof", c do
    endpoint = "/api/auth/agent-token/renew"
    assert request(c, :post, endpoint, %{runId: c.run.id}, c.generic).status == 403
    assert request(c, :post, endpoint, %{}, aged_token(c.generic, 43201)).status == 401
    assert request(c, :post, endpoint, %{}, aged_token(c.token, 8 * 86400)).status == 401
    assert request(c, :post, endpoint, %{}, c.token <> "tampered").status == 401
    SQL.exec("UPDATE users SET auth_version=auth_version+1 WHERE id=?", [c.user.id])
    assert request(c, :post, endpoint, %{}, c.token).status == 401
    SQL.exec("UPDATE users SET auth_version=auth_version-1 WHERE id=?", [c.user.id])
    SQL.exec("UPDATE runs SET status='completed' WHERE id=?", [c.run.id])
    assert request(c, :post, endpoint, %{}, c.token).status == 403
    assert request(c, :post, endpoint, %{}, aged_token(c.token, 43201)).status == 401
  end

  test "owner can provision a legacy or external run without granting caller-chosen binding", c do
    endpoint = "/api/auth/agent-token"
    assert request(c, :post, endpoint, %{runId: c.run.id}, c.generic).status == 403
    assert request(c, :post, endpoint, %{runId: c.run.id}, c.token).status == 403
    stranger = owner_vault("binding-stranger")
    other = Token.sign_user(%{id: stranger.user_id, username: stranger.username, auth_version: 0})
    assert request(c, :post, endpoint, %{runId: c.run.id}, other).status == 403
    assert request(c, :post, endpoint, %{runId: c.run.id + 100_000}, c.human).status == 403
    assert request(c, :post, endpoint, %{runId: "invalid"}, c.human).status == 400

    assert request(c, :post, base(c) <> "/missions", mission_input(c), c.generic, c.run.id).status ==
             403

    response = request(c, :post, endpoint, %{runId: c.run.id}, c.human)
    assert response.status == 200
    bound = Jason.decode!(response.resp_body)["token"]

    assert request(c, :post, base(c) <> "/missions", mission_input(c), bound, c.run.id).status ==
             201

    set(c, c.source, false)

    assert request(c, :post, base(c) <> "/missions", mission_input(c), bound, c.run.id).status ==
             403
  end

  defp aged_token(token, age) do
    signer = Joken.Signer.create("HS256", System.fetch_env!("JWT_SECRET"))
    {:ok, claims} = Joken.verify(token, signer)
    now = System.system_time(:second)

    {:ok, token, _} =
      Joken.encode_and_sign(Map.merge(claims, %{"iat" => now - age, "exp" => now - 1}), signer)

    token
  end

  defp mission_input(c),
    do: %{
      rootMessageId: c.root.id,
      coordinatorRegistrationId: c.source.id,
      title: "Scoped mission",
      controlPlane: true
    }

  defp task_input(c),
    do: %{
      coordinatorRegistrationId: c.source.id,
      assignee: c.sibling.id,
      title: "Scoped task",
      purpose: "research"
    }

  defp mission(c) do
    {:ok, result} =
      Store.create(c.user.id, c.vault, c.channel, mission_input(c), control_plane: true)

    result.mission
  end

  defp set(c, agent, enabled) do
    {:ok, _} =
      Agents.add_to_channel(c.user.id, c.vault, c.channel, agent.vaultAgentId, %{
        missionsEnabled: enabled
      })
  end

  defp counts,
    do:
      Map.new(
        ~w(notes chat_messages chat_missions chat_mission_tasks work_items chat_agent_dispatches),
        fn table -> {table, SQL.one("SELECT count(*) FROM #{table}")} end
      )

  defp base(c), do: "/api/vaults/#{c.vault}/channels/#{c.channel}"

  defp request(c, method, path, payload, token \\ nil, run \\ nil) do
    conn = json_conn(method, path, payload, token || c.token)
    conn = if run, do: put_req_header(conn, "x-cascade-run-id", to_string(run)), else: conn

    router =
      cond do
        String.starts_with?(path, "/api/auth/") -> CascadeWeb.Router
        String.contains?(path, "/missions") -> CascadeWeb.MissionRouter
        true -> CascadeWeb.ChatRouter
      end

    router.call(conn, router.init([]))
  end
end
