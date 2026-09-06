defmodule Cascade.Missions.Interpretation do
  @moduledoc "Durable coordinator understanding and acknowledgment over the mission event/dispatch outbox."
  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Messages, Channel}
  alias Cascade.Missions.Store
  alias Cascade.Realtime.OrderedPublisher

  @columns "state_json,revision,handled_fingerprint,pending_fingerprint,pending_context_json,dispatch_id,attempt,retry_after,stopped,publication_pending"

  defp coordinator(id),
    do: SQL.one("SELECT coordinator_registration_id FROM chat_missions WHERE id=?", [id]) |> hd()

  def initialize(id) do
    if SQL.changes("INSERT OR IGNORE INTO chat_mission_interpretations(mission_id) VALUES(?)", [
         id
       ]) > 0 do
      # Adopt an already admitted pre-upgrade review instead of starting another
      # coordinator beside it. Its prompt is refreshed at normal admission.
      case SQL.one(
             """
             SELECT d.id FROM chat_agent_dispatches d JOIN chat_missions m ON m.id=?
             LEFT JOIN runs r ON r.id=d.run_id
             WHERE d.message_id LIKE 'sys-mission-' || m.id || '-%'
               AND d.registration_id=m.coordinator_registration_id AND d.failed_at IS NULL
               AND (d.run_id IS NULL OR r.status IN ('queued','running')) ORDER BY d.rowid DESC LIMIT 1
             """,
             [id]
           ) do
        [dispatch] ->
          evidence = snapshot(id, %{})

          SQL.exec(
            "UPDATE chat_mission_interpretations SET dispatch_id=?,pending_fingerprint=?,pending_context_json=? WHERE mission_id=?",
            [dispatch, fingerprint(evidence), Jason.encode!(evidence), id]
          )

        _ ->
          :ok
      end
    end
  end

  defp row(id) do
    case SQL.one("SELECT #{@columns} FROM chat_mission_interpretations WHERE mission_id=?", [id]) do
      [state, revision, handled, pending, context, dispatch, attempt, retry, stopped, publication] ->
        %{
          state: Jason.decode!(state),
          revision: revision,
          handled: handled,
          pending: pending,
          context: Jason.decode!(context),
          dispatch: dispatch,
          attempt: attempt,
          retry: retry,
          stopped: stopped == 1,
          publication: publication
        }

      _ ->
        nil
    end
  end

  # Progress remains in task history. Only deliberate findings and settled work
  # need interpretation; child results belong to their integrating parent.
  defp snapshot(id, state) do
    [objective, status, summary, verification] =
      SQL.one("SELECT objective,status,summary,verification FROM chat_missions WHERE id=?", [id])

    findings =
      SQL.all(
        """
        SELECT t.id,t.title,t.status,
          CASE WHEN t.status IN ('completed','blocked','failed','canceled') THEN t.summary ELSE e.summary END,
          CASE WHEN t.status IN ('completed','blocked','failed','canceled') THEN COALESCE(w.verification,'') ELSE '' END
        FROM chat_mission_tasks t
        LEFT JOIN work_items w ON w.id=t.work_item_id
        LEFT JOIN chat_mission_events e ON e.id=(
          SELECT MAX(id) FROM chat_mission_events
          WHERE mission_id=t.mission_id AND task_id=t.id AND kind='task_finding' AND attempt=t.attempt
        )
        WHERE t.mission_id=? AND t.parent_task_id IS NULL
          AND (e.id IS NOT NULL OR t.status IN ('completed','blocked','failed','canceled'))
        ORDER BY t.id
        """,
        [id]
      )
      |> Enum.map(fn [task, title, status, summary, verification] ->
        %{
          taskId: task,
          title: title,
          status: status,
          summary: summary,
          verification: verification
        }
      end)

    overdue =
      Enum.filter(state["commitments"] || [], fn item ->
        item["status"] == "open" and due?(item["dueAt"])
      end)

    %{
      objective: objective,
      eventCursor:
        SQL.one("SELECT COALESCE(MAX(id),0) FROM chat_mission_events WHERE mission_id=?", [id])
        |> hd(),
      findings: findings,
      delivery:
        if(status == "completed",
          do: %{status: status, summary: summary, verification: verification}
        ),
      recoveryEvidence: Store.recovery_context(id),
      overdueCommitments: overdue
    }
  end

  defp due?(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, time, _} -> DateTime.compare(time, DateTime.utc_now()) != :gt
      _ -> false
    end
  end

  defp due?(_), do: false

  defp fingerprint(value) do
    value = if is_map(value), do: Map.drop(value, [:eventCursor, "eventCursor"]), else: value
    :crypto.hash(:sha256, :erlang.term_to_binary(canonical(value))) |> Base.encode16(case: :lower)
  end

  defp canonical(value) when is_map(value),
    do: {:map, value |> Enum.map(fn {k, v} -> {to_string(k), canonical(v)} end) |> Enum.sort()}

  defp canonical(value) when is_list(value), do: Enum.map(value, &canonical/1)
  defp canonical(value), do: value

  # Called under the scheduler's existing transaction. One outstanding batch per
  # objective; evidence arriving during a turn is picked up after its acknowledgment.
  def claim(update) do
    id = update.mission.id
    initialize(id)
    record = row(id)
    current = snapshot(id, record.state)
    digest = fingerprint(current)

    meaningful =
      current.findings != [] or current.delivery != nil or current.overdueCommitments != [] or
        current.recoveryEvidence != [] or record.handled != ""

    cond do
      update.mission.status == "canceled" or record.stopped ->
        nil

      record.dispatch != nil ->
        retry(update, record)

      digest == record.handled or not meaningful ->
        nil

      true ->
        SQL.exec(
          """
          UPDATE chat_mission_interpretations SET pending_fingerprint=?,pending_context_json=?,attempt=0,retry_after=NULL
          WHERE mission_id=?
          """,
          [digest, Jason.encode!(current), id]
        )

        wake(update, %{record | pending: digest, context: current, attempt: 0})
    end
  end

  defp retry(update, record) do
    case SQL.one(
           """
           SELECT d.run_id,r.status,d.failed_at FROM chat_agent_dispatches d
           LEFT JOIN runs r ON r.id=d.run_id WHERE d.id=?
           """,
           [record.dispatch]
         ) do
      [run, "canceled", _] ->
        if SQL.one(
             "SELECT 1 FROM run_events WHERE run_id=? AND type='status' AND json_extract(payload_json,'$.steering')=1 LIMIT 1",
             [run]
           ) do
          retry_wake(update, record)
        else
          SQL.exec("UPDATE chat_mission_interpretations SET stopped=1 WHERE mission_id=?", [
            update.mission.id
          ])

          nil
        end

      [_, status, failure] when status in ["completed", "failed"] or not is_nil(failure) ->
        retry_wake(update, record)

      nil ->
        wake(update, record)

      _ ->
        nil
    end
  end

  defp retry_wake(update, record) do
    cond do
      record.retry == nil ->
        seconds = min(300, 10 * (record.attempt + 1))

        SQL.exec(
          "UPDATE chat_mission_interpretations SET retry_after=datetime('now',?) WHERE mission_id=?",
          ["+#{seconds} seconds", update.mission.id]
        )

        nil

      SQL.one(
        "SELECT 1 FROM chat_mission_interpretations WHERE mission_id=? AND retry_after<=datetime('now')",
        [update.mission.id]
      ) == [1] ->
        next = %{record | attempt: record.attempt + 1, retry: nil}

        SQL.exec(
          "UPDATE chat_mission_interpretations SET attempt=?,retry_after=NULL WHERE mission_id=?",
          [next.attempt, update.mission.id]
        )

        wake(update, next)

      true ->
        nil
    end
  end

  defp wake(update, record) do
    Map.merge(update, %{
      coordinatorRegistrationId: coordinator(update.mission.id),
      generation: "interpret-#{record.revision}-#{record.pending}-#{record.attempt}",
      interpretation: %{
        revision: record.revision,
        fingerprint: record.pending,
        evidence: record.context,
        understanding: record.state
      }
    })
  end

  def admitted(id, dispatch_id),
    do:
      SQL.exec("UPDATE chat_mission_interpretations SET dispatch_id=? WHERE mission_id=?", [
        dispatch_id,
        id
      ])

  def keep_wake?(id) do
    SQL.one(
      """
      SELECT 1 FROM chat_mission_interpretations i JOIN chat_missions m ON m.id=i.mission_id
      WHERE i.dispatch_id=? AND i.stopped=0 AND i.pending_fingerprint<>'' AND m.status<>'canceled'
      """,
      [id]
    ) == [1]
  end

  def action_key(run_id, action) do
    case SQL.one(
           "SELECT i.mission_id,i.revision FROM chat_mission_interpretations i JOIN runs r ON r.chat_dispatch_id=i.dispatch_id WHERE r.id=? AND i.stopped=0",
           [run_id]
         ) do
      [mission, revision] -> "interpretation-action:#{mission}:#{revision}:#{fingerprint(action)}"
      _ -> nil
    end
  end

  def stop_run(run_id) do
    SQL.exec(
      """
      UPDATE chat_mission_interpretations SET stopped=1
      WHERE dispatch_id IN (SELECT chat_dispatch_id FROM runs WHERE id=?)
      """,
      [run_id]
    )
  end

  # Refresh the batch once at admission, so a queued wake interprets all findings
  # that arrived while the owner was offline/busy, rather than replaying each event.
  # Prompt building already holds the SQL lock: never enter OrderedPublisher here.
  def dispatch_prompt(dispatch_id) do
    SQL.transaction(fn ->
      case SQL.one(
             "SELECT mission_id FROM chat_mission_interpretations WHERE dispatch_id=? AND stopped=0",
             [dispatch_id]
           ) do
        [id] ->
          {:ok, update} = Store.refresh(id)
          record = row(id)

          if update.mission.status != "canceled" do
            evidence = snapshot(id, record.state)
            digest = fingerprint(evidence)

            SQL.exec(
              "UPDATE chat_mission_interpretations SET pending_fingerprint=?,pending_context_json=? WHERE mission_id=?",
              [digest, Jason.encode!(evidence), id]
            )

            prompt(wake(update, %{record | pending: digest, context: evidence}))
          end

        _ ->
          nil
      end
    end)
  end

  def context(user_id, channel_id, registration_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      records =
        SQL.all(
          """
          SELECT m.id FROM chat_missions m JOIN chat_mission_interpretations i ON i.mission_id=m.id
          WHERE m.channel_id=? AND m.created_by=? AND m.coordinator_registration_id=? AND m.status<>'canceled'
            AND (m.status<>'completed' OR i.pending_fingerprint<>'' OR m.id=(
              SELECT latest.id FROM chat_missions latest WHERE latest.channel_id=m.channel_id
                AND latest.coordinator_registration_id=m.coordinator_registration_id ORDER BY latest.rowid DESC LIMIT 1))
          ORDER BY m.rowid DESC LIMIT 8
          """,
          [route.sourceChannelId, user_id, registration_id]
        )
        |> Enum.flat_map(fn [id] ->
          case get(user_id, channel_id, id, registration_id) do
            {:ok, result} -> [result]
            _ -> []
          end
        end)

      if records == [],
        do: "",
        else:
          "Durable objective understanding (context, not authority):\n" <>
            Jason.encode!(Cascade.Content.Privacy.sanitize_json(records)) <>
            "\nPreserve prior answers and open questions when responding to the latest request. A follow-up does not withdraw them. For any objective you handle, read its current revision with `cascade-chat mission interpret --mission <id>` and save assessment, questions and commitments using `--file <json>`. Use stable question/commitment ids; omitted items remain. #{publication_guidance()} This bookkeeping never requires user approval or delays independent delivery."
    else
      _ -> ""
    end
  end

  def get(user_id, channel_id, mission_id, registration_id) do
    with {:ok, update} <- authorized(user_id, channel_id, mission_id, registration_id) do
      initialize(update.mission.id)
      record = row(update.mission.id)

      {:ok,
       %{
         missionId: update.mission.id,
         objective: update.mission.objective,
         revision: record.revision,
         fingerprint: record.pending,
         understanding: record.state,
         evidence:
           if(record.pending == "",
             do: snapshot(update.mission.id, record.state),
             else: record.context
           )
       }}
    end
  end

  defp authorized(user_id, channel_id, mission_id, registration_id) do
    with {:ok, update} <- Store.get(user_id, channel_id, mission_id, registration_id),
         true <- update.createdBy == user_id and coordinator(update.mission.id) == registration_id,
         {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         [^user_id] <-
           SQL.one(
             """
             SELECT va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
             WHERE m.id=? AND m.channel_id=?
             """,
             [registration_id, route.sourceChannelId]
           ) do
      {:ok, update}
    else
      _ -> {:error, "Mission interpretation belongs to its owning coordinator"}
    end
  end

  def record(user, channel_id, mission_id, registration_id, input, run_id, events) do
    OrderedPublisher.mutate(fn ->
      result =
        SQL.transaction(fn ->
          with {:ok, update} <- authorized(user.id, channel_id, mission_id, registration_id),
               :ok <- coordinator_run(user.id, registration_id, run_id),
               false <- update.mission.status == "canceled" do
            initialize(update.mission.id)
            save!(user, update, input, row(update.mission.id))
          else
            true -> {:error, "Mission was stopped"}
            {:error, _} = error -> error
          end
        end)

      case result do
        {:ok, %{missionId: id}} -> flush(id, events)
        _ -> :ok
      end

      result
    end)
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp coordinator_run(user, registration, run) do
    if SQL.one(
         """
         SELECT 1 FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
         WHERE r.id=? AND r.owner_user_id=? AND d.registration_id=? AND r.status IN ('queued','running')
           AND NOT EXISTS (SELECT 1 FROM chat_mission_tasks t WHERE t.run_id=r.id)
         """,
         [run, user, registration]
       ) == [1],
       do: :ok,
       else: {:error, "Only a live coordinator run can record interpretation; workers cannot"}
  end

  defp save!(user, update, input, record) do
    id = update.mission.id
    revision = input["revision"]
    key = "interpretation:#{id}:#{revision}"
    previous = SQL.one("SELECT summary FROM chat_mission_events WHERE source_key=?", [key])

    cond do
      previous != nil ->
        [encoded] = previous
        data = Jason.decode!(encoded)["result"]

        result =
          Map.new(
            ~w(missionId inputFingerprint handledEventId handledFingerprint revision messageId noMaterialChange)a,
            &{&1, data[to_string(&1)]}
          )

        if result.inputFingerprint == fingerprint(input),
          do: {:ok, result},
          else: {:error, "Interpretation changed; read current state and merge"}

      record.stopped ->
        {:error, "Interpretation was stopped"}

      revision != record.revision ->
        {:error, "Interpretation changed; read current state and merge"}

      (input["fingerprint"] || "") != record.pending ->
        {:error, "Evidence batch changed; read current interpretation"}

      true ->
        state = merge_state(record.state, input)

        state =
          if record.context["delivery"] != nil,
            do: Map.put(state, "executionCompleted", true),
            else: state

        body = String.trim(input["body"] || "")
        acknowledging = record.pending != ""

        if acknowledging and body == "" and input["noMaterialChange"] != true,
          do: raise("Publish an explanation or explicitly record noMaterialChange")

        if body != "" and input["noMaterialChange"] == true,
          do: raise("An explanation and noMaterialChange are mutually exclusive")

        message_id = if body != "", do: "mission-explanation-#{id}-#{revision}"
        correction = input["correctsMessageId"]

        if correction && not Enum.any?(state["claims"] || [], &(&1["messageId"] == correction)),
          do: raise("A correction must reference a previous explanation for this objective")

        if message_id do
          {:ok, route} = Store.owner_route(user.id, update.vaultId, update.channelId)

          reply = %{
            messageId: correction || update.mission.rootMessageId,
            author: "",
            preview: "",
            relationship: if(correction, do: "contradiction", else: "builds_on")
          }

          {:ok, _} =
            Messages.create(
              user,
              route.localVaultId,
              route.localChannelId,
              %{
                id: message_id,
                body: body,
                registrationId: coordinator(update.mission.id),
                createdAt: DateTime.utc_now() |> DateTime.to_iso8601(),
                replyTo: reply
              },
              access: :agent
            )
        end

        state =
          if message_id,
            do:
              Map.update(
                state,
                "claims",
                [%{"messageId" => message_id, "body" => body}],
                &(&1 ++
                    [
                      %{
                        "messageId" => message_id,
                        "body" => body,
                        "correctsMessageId" => correction
                      }
                    ])
              ),
            else: state

        result = %{
          missionId: id,
          inputFingerprint: fingerprint(input),
          handledEventId: record.context["eventCursor"],
          handledFingerprint: record.pending,
          revision: revision + 1,
          messageId: message_id,
          noMaterialChange: input["noMaterialChange"] == true
        }

        previously_due = record.context["overdueCommitments"] || []
        current_commitments = Map.new(state["commitments"] || [], &{&1["id"], &1})

        still_due =
          previously_due
          |> Enum.map(&current_commitments[&1["id"]])
          |> Enum.filter(&(&1 && &1["status"] == "open" && due?(&1["dueAt"])))

        handled =
          if record.pending == "",
            do: record.handled,
            else: fingerprint(Map.put(record.context, "overdueCommitments", still_due))

        SQL.exec(
          """
          UPDATE chat_mission_interpretations SET state_json=?,revision=revision+1,
            handled_fingerprint=?,
            pending_fingerprint='',pending_context_json='{}',dispatch_id=NULL,attempt=0,retry_after=NULL,
            publication_pending=COALESCE(?,publication_pending) WHERE mission_id=?
          """,
          [Jason.encode!(state), handled, message_id, id]
        )

        SQL.exec(
          "INSERT INTO chat_mission_events(mission_id,kind,summary,source_key) VALUES(?,?,?,?)",
          [
            id,
            "interpretation_recorded",
            Jason.encode!(%{
              result: result,
              changes:
                Map.take(
                  input,
                  ~w(assessment questions commitments evidenceReferences correctsMessageId)
                )
            }),
            key
          ]
        )

        if record.dispatch do
          SQL.exec(
            "UPDATE chat_agent_dispatches SET failed_at=datetime('now'),error='Interpretation already handled' WHERE id=? AND run_id IS NULL",
            [record.dispatch]
          )

          Cascade.Missions.Dispatches.retract_pending_reply(record.dispatch)
        end

        {:ok, result}
    end
  end

  defp merge_state(state, input) do
    if byte_size(Jason.encode!(input)) > 64_000, do: raise("Interpretation must stay under 64KB")

    state =
      if is_binary(input["assessment"]),
        do: Map.put(state, "assessment", input["assessment"]),
        else: state

    state =
      Enum.reduce(~w(questions commitments), state, fn field, acc ->
        if Map.has_key?(input, field) do
          entries = input[field]

          unless is_list(entries) and
                   Enum.all?(entries, &(is_map(&1) and is_binary(&1["id"]) and &1["id"] != "")),
                 do: raise("#{field} must be objects with stable ids")

          entries =
            if field == "commitments" do
              Enum.map(entries, fn entry ->
                if entry["status"] && entry["status"] not in ~w(open fulfilled canceled),
                  do: raise("Commitment status must be open, fulfilled or canceled")

                if entry["dueAt"] &&
                     not match?({:ok, _, _}, DateTime.from_iso8601(entry["dueAt"])),
                   do: raise("Commitment dueAt must be an ISO8601 timestamp")

                if Enum.any?(acc[field] || [], &(&1["id"] == entry["id"])),
                  do: entry,
                  else: Map.put_new(entry, "status", "open")
              end)
            else
              entries
            end

          merged =
            Enum.reduce(entries, Map.new(acc[field] || [], &{&1["id"], &1}), fn entry, old ->
              Map.update(old, entry["id"], entry, &Map.merge(&1, entry))
            end)
            |> Map.values()
            |> Enum.sort_by(& &1["id"])

          Map.put(acc, field, merged)
        else
          acc
        end
      end)

    references = input["evidenceReferences"] || []
    unless is_list(references), do: raise("evidenceReferences must be a list")

    Map.put(
      state,
      "evidenceReferences",
      Enum.uniq((state["evidenceReferences"] || []) ++ references)
    )
  end

  # The message and acknowledgment commit together. Fanout can replay the same
  # message id after a crash; normal chat clients already upsert by id.
  def flush(id, events) do
    # Drain every committed publication, not only the most recent revision. A
    # second coordinator write cannot overwrite a message awaiting fanout.
    SQL.all(
      """
      SELECT e.id,json_extract(e.summary,'$.result.messageId'),m.created_by,m.vault_id,m.channel_id
      FROM chat_mission_events e JOIN chat_missions m ON m.id=e.mission_id
      JOIN chat_mission_interpretations i ON i.mission_id=m.id
      WHERE m.id=? AND e.kind='interpretation_recorded'
        AND json_extract(e.summary,'$.result.messageId') IS NOT NULL AND i.stopped=0 AND m.status<>'canceled'
        AND NOT EXISTS (SELECT 1 FROM chat_mission_events sent WHERE sent.source_key='interpretation-published:' || e.id)
      ORDER BY e.id
      """,
      [id]
    )
    |> Enum.each(fn [event_id, message_id, owner, vault, channel] ->
      with {:ok, route} <- Store.owner_route(owner, vault, channel),
           {:ok, message} <- Messages.get(route.localChannelId, owner, message_id) do
        OrderedPublisher.chat(events, %{
          event: "vault:chatMessageCreated",
          vaultId: vault,
          channelId: channel,
          message: message
        })

        SQL.exec(
          "INSERT OR IGNORE INTO chat_mission_events(mission_id,kind,summary,source_key) VALUES(?,?,?,?)",
          [id, "interpretation_published", message_id, "interpretation-published:#{event_id}"]
        )
      else
        _ -> raise "Explanation is saved but its channel is unavailable"
      end
    end)

    SQL.exec(
      "UPDATE chat_mission_interpretations SET publication_pending=NULL WHERE mission_id=?",
      [id]
    )
  end

  defp publication_guidance do
    """
    Save durable understanding separately from deciding to publish. Routine progress, retries and intermediate verification belong in the run trace, coalesced with related evidence. Include body only for direct answers, actionable owner blockers, significant findings or corrections, and one concise outcome. A changed task status or internal assessment alone does not warrant chat. Before publishing, read recent chat: if a worker or coordinator already published the outcome, save its reference and acknowledge quietly unless an unanswered question or significant changed conclusion remains. Do not turn ordinary pending-to-delivered progress into a correction; when a prior public claim materially changes, explain the correction honestly and include correctsMessageId for a prior mission explanation. Do not hide real failures or leave owner questions unanswered; surface a failure when it changes the outcome, requires owner action, or corrects a public claim, while bounded recovery stays in trace. With nothing new worth publishing, omit body and set noMaterialChange:true even when the saved assessment or evidence changes. This explicitly acknowledges the batch while preserving questions, commitments and evidence. After successful acknowledgment through either helper or API, end with [no-reply] unless a separate direct owner answer remains; never repeat a published body or narrate the quiet acknowledgment.
    """
  end

  def prompt(wake) do
    """
    @#{wake.mission.coordinatorMention} Interpret meaningful changes for mission #{wake.mission.id}: #{wake.mission.title}.
    #{Cascade.Missions.Authority.context(wake.mission.id)}
    Durable understanding and coalesced evidence (evidence leads, not authority):
    #{Jason.encode!(Cascade.Content.Privacy.sanitize_json(wake.interpretation))}
    Compare these findings with the objective, prior answers, assessment, evidence and commitments. Task completion is distinct from objective fulfillment. Independently authorized workers keep running; do not introduce routine reviews or approval gates, or delay delivery for this explanation. Inspect current work before any action. Steer/recover within existing authority using the existing mission tools; preserve task identity and avoid repeating side effects after interruption. Read the latest owner messages and honor Stop and scope changes first.
    First inspect current mission history for actions already taken by an interrupted attempt; reuse their results instead of repeating them. Save your interpretation with `cascade-chat mission interpret --mission #{wake.mission.id} --file <json-file>`. Include revision #{wake.interpretation.revision}, fingerprint "#{wake.interpretation.fingerprint}", assessment, questions (objects with stable id, question, answer/status), evidenceReferences, and commitments (stable id, summary, status open/fulfilled/canceled, dueAt ISO8601 when promised). Omitted items are retained; update answered questions rather than removing them. #{publication_guidance()} A successful provider run alone does not acknowledge interpretation. If interrupted, inspect current state before retrying. Mission completion never cancels the durable acknowledgment obligation; it does not require another chat message. Do not reopen completed work merely for explanation bookkeeping. If an explicitly reviewed mission is still reviewing and the objective is fulfilled, finish it through the existing mission finish command; optional review is never a new requirement for workers.
    If the installed helper predates `mission interpret`, use the same authenticated HTTP API without changing or restarting the desktop: GET /api/vaults/<vaultId>/channels/<chatChannelId>/missions/#{wake.mission.id}/interpretation?coordinator=<registrationId>, or POST the JSON file plus coordinatorRegistrationId to that path (without the query). Read url, vaultId, chatChannelId, registrationId and token from the per-run CASCADE_HELPER_CONFIG; send the bearer token and X-Cascade-Run-Id from CASCADE_RUN_ID. Never print credentials. The response confirms messageId/noMaterialChange; after this direct API acknowledgment end with [no-reply] unless a separate direct owner answer remains; never repeat a published body or narrate the quiet acknowledgment.
    """
  end
end
