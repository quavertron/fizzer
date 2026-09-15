defmodule Cascade.Missions.Context do
  @moduledoc "Current mission workflow context for coordinator and worker dispatches."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Channel
  alias Cascade.Content.Privacy

  @purposes ~w(research implementation review fix integration verification)
  @phases ~w(planning executing closed)

  @doc "Builds the current, redacted mission context for a dispatch."
  def for_dispatch(dispatch, user_id) do
    with mission when is_map(mission) <- mission_for_dispatch(dispatch),
         true <- authorized_dispatch?(dispatch, mission, user_id),
         true <- readable_notes?(mission.id, user_id) do
      task = task_for_dispatch(dispatch, mission.id)
      notes = linked_notes(mission.id)
      changes = note_changes(mission.id)
      awareness = pending_awareness(mission.id)
      tasks = task_evidence(mission.id)

      format(mission, task, notes, changes, awareness, tasks)
    else
      _ -> ""
    end
  rescue
    _ -> ""
  end

  # The message id is transport data, not mission authority. A dispatch must
  # have a durable task, interpretation, or root-message relationship to the
  # mission, and that relationship must be on the mission's actual channel.
  defp mission_for_dispatch(dispatch) do
    dispatch_id = field(dispatch, :id)
    message = field(dispatch, :message, %{})
    task_id = nonblank(field(message, :missionTaskId), field(dispatch, :missionTaskId))
    message_id = field(dispatch, :messageId, field(message, :id))

    cond do
      is_nil(dispatch_id) or dispatch_id in ["", 0] ->
        nil

      task_id not in [nil, ""] ->
        SQL.one(
          """
          SELECT m.id,m.vault_id,m.channel_id,m.title,m.objective,m.status,m.summary,m.phase,
                 m.coordinator_registration_id,m.updated_at,m.approved_at,m.approved_by,
                 m.approved_revisions_json
          FROM chat_mission_tasks t
          JOIN chat_missions m ON m.id=t.mission_id
          JOIN chat_agent_dispatches d ON d.id=t.dispatch_id
          JOIN chat_messages msg ON msg.id=d.message_id
          WHERE t.id=? AND t.dispatch_id=? AND d.id=? AND d.channel_id=m.channel_id
            AND d.registration_id=t.assignee_registration_id
            AND msg.mission_task_id=t.id
          LIMIT 1
          """,
          [task_id, dispatch_id, dispatch_id]
        )
        |> mission_row()

      true ->
        SQL.one(
          """
          SELECT m.id,m.vault_id,m.channel_id,m.title,m.objective,m.status,m.summary,m.phase,
                 m.coordinator_registration_id,m.updated_at,m.approved_at,m.approved_by,
                 m.approved_revisions_json
          FROM chat_missions m
          JOIN chat_agent_dispatches d
            ON d.id=? AND d.message_id=? AND d.channel_id=m.channel_id
          LEFT JOIN chat_mission_interpretations i
            ON i.mission_id=m.id AND i.dispatch_id=d.id
          WHERE (
            d.registration_id=m.coordinator_registration_id
            AND m.root_message_id=d.message_id
          ) OR (
            i.dispatch_id=d.id
            AND d.registration_id=m.coordinator_registration_id
          )
          LIMIT 1
          """,
          [dispatch_id, message_id]
        )
        |> mission_row()
    end
  end

  defp authorized_dispatch?(dispatch, mission, user_id) do
    requester_channel =
      SQL.one(
        "SELECT requester_channel_id FROM chat_agent_dispatches WHERE id=?",
        [field(dispatch, :id)]
      )
      |> case do
        [channel_id] when is_binary(channel_id) and channel_id != "" -> channel_id
        _ -> field(dispatch, :requesterChannelId, field(dispatch, :channelId))
      end

    with channel_id when is_binary(channel_id) and channel_id != "" <- requester_channel,
         {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         true <- route.sourceChannelId == mission.channelId do
      true
    else
      _ -> false
    end
  end

  defp readable_notes?(mission_id, user_id) do
    [total] =
      SQL.one(
        "SELECT COUNT(*) FROM chat_mission_notes mn JOIN notes n ON n.id=mn.note_id WHERE mn.mission_id=?",
        [mission_id]
      ) || [0]

    [readable] =
      SQL.one(
        """
        SELECT COUNT(*)
        FROM chat_mission_notes mn
        JOIN notes n ON n.id=mn.note_id
        JOIN vault_members vm ON vm.vault_id=n.vault_id AND vm.user_id=?
        WHERE mn.mission_id=? AND n.is_archived=0
        """,
        [user_id, mission_id]
      ) || [0]

    total == readable
  end

  defp task_for_dispatch(dispatch, mission_id) do
    message = field(dispatch, :message, %{})
    task_id = nonblank(field(message, :missionTaskId), field(dispatch, :missionTaskId))

    row =
      if task_id not in [nil, ""] do
        SQL.one(
          """
          SELECT id,mission_id,title,purpose,status,summary,prompt,assignee_registration_id,
                 parent_task_id,run_id,work_item_id,brief_note_id,brief_revisions_json,
                 review_outcome,verification_passed,updated_at
          FROM chat_mission_tasks WHERE id=? AND mission_id=? LIMIT 1
          """,
          [task_id, mission_id]
        )
      else
        nil
      end

    task_row(row)
  end

  defp linked_notes(mission_id) do
    SQL.all(
      """
      SELECT mn.note_id,mn.kind,mn.parent_note_id,mn.position,mn.revision,
             n.title,n.content,n.revision_counter,n.updated_at
      FROM chat_mission_notes mn JOIN notes n ON n.id=mn.note_id
      WHERE mn.mission_id=?
      ORDER BY mn.position ASC,mn.created_at ASC,mn.note_id ASC
      """,
      [mission_id]
    )
    |> Enum.map(fn [id, kind, parent, position, linked_revision, title, content, revision_counter, updated_at] ->
      content = to_string(content || "")
      revision = Privacy.note_revision(%{revision_counter: revision_counter})

      %{
        id: id,
        kind: kind,
        parent: parent,
        position: position,
        revision: revision,
        linkedRevision: opaque_snapshot_revision(linked_revision),
        title: Privacy.redact_blocks(to_string(title || "")),
        content: Privacy.redact_blocks(content),
        updatedAt: updated_at
      }
    end)
  end

  defp opaque_snapshot_revision(value) when is_binary(value) do
    if String.starts_with?(value, "note-v1:"), do: value
  end

  defp opaque_snapshot_revision(_), do: nil

  defp note_changes(mission_id) do
    SQL.all(
      """
      SELECT kind,title,summary,created_at
      FROM chat_mission_events
      WHERE mission_id=? AND (lower(kind) LIKE '%note%' OR lower(kind) LIKE '%revision%')
      ORDER BY id DESC LIMIT 16
      """,
      [mission_id]
    )
    |> Enum.reverse()
    |> Enum.map(fn [kind, title, summary, created_at] ->
      %{kind: kind, title: title, summary: Privacy.redact_blocks(to_string(summary || "")), at: created_at}
    end)
  end

  defp pending_awareness(mission_id) do
    case SQL.one(
           "SELECT pending_fingerprint,pending_context_json FROM chat_mission_interpretations WHERE mission_id=?",
           [mission_id]
         ) do
      [fingerprint, encoded] when is_binary(encoded) and encoded != "" ->
        context = decode_revisions(encoded)

        note_fields =
          context
          |> Enum.filter(fn {key, _value} ->
            key = key |> to_string() |> String.downcase()
            String.contains?(key, "note") or String.contains?(key, "revision")
          end)
          |> Map.new()

        if map_size(note_fields) == 0 do
          ""
        else
          "Pending note awareness (fingerprint #{fingerprint || "none"}): " <>
            (note_fields |> Jason.encode!() |> Privacy.redact_blocks())
        end

      _ ->
        ""
    end
  end

  defp task_evidence(mission_id) do
    SQL.all(
      """
      SELECT id,title,purpose,status,summary,assignee_registration_id,parent_task_id,run_id,
             work_item_id,brief_note_id,brief_revisions_json,review_outcome,verification_passed,
             updated_at
      FROM chat_mission_tasks WHERE mission_id=? ORDER BY created_at ASC,rowid ASC
      LIMIT 48
      """,
      [mission_id]
    )
    |> Enum.map(fn [id, title, purpose, status, summary, assignee, parent, run, work_item, note_id,
                    revisions, review_outcome, verification_passed, updated_at] ->
      %{
        id: id,
        title: Privacy.redact_blocks(to_string(title || "")),
        purpose: normalize_purpose(purpose),
        status: status,
        summary: Privacy.redact_blocks(to_string(summary || "")),
        assignee: assignee,
        parent: parent,
        runId: run,
        workItemId: work_item,
        briefNoteId: note_id,
        briefRevisions: decode_revisions(revisions),
        reviewOutcome: review_outcome,
        verificationPassed: verification_passed,
        updatedAt: updated_at
      }
    end)
  end

  defp format(mission, task, notes, changes, awareness, tasks) do
    phase = normalize_phase(mission.phase)
    mission_brief = Privacy.redact_blocks(to_string(mission.objective || ""))

    note_text =
      notes
      |> Enum.map(fn note ->
        parent = if note.parent, do: ", parent #{note.parent}", else: ""
        changed =
          if note.linkedRevision not in [nil, ""] and note.linkedRevision != note.revision,
            do: "; linked snapshot #{note.linkedRevision} is stale",
            else: ""

        body = clip(note.content, 5_000)
        "- [#{note.kind}] #{note.title} (note #{note.id}, revision #{note.revision}#{changed}#{parent})\n  #{body}"
      end)
      |> Enum.join("\n")

    changes_text =
      changes
      |> Enum.map_join("\n", fn change ->
        "- #{change.kind} #{change.title}: #{change.summary} (#{change.at})"
      end)

    evidence_text =
      tasks
      |> Enum.map_join("\n", fn evidence ->
        snapshot =
          case evidence.briefRevisions do
            revisions when map_size(revisions) > 0 -> " brief=#{inspect(revisions)}"
            _ -> ""
          end

        review = if evidence.reviewOutcome, do: " reviewOutcome=#{evidence.reviewOutcome}", else: ""
        verification =
          if evidence.verificationPassed != nil,
            do: " verificationPassed=#{evidence.verificationPassed}",
            else: ""

        "- #{evidence.id} [#{evidence.purpose}] #{evidence.status}: #{evidence.title} — #{evidence.summary}" <>
          " (run=#{evidence.runId || "none"}#{review}#{verification}#{snapshot})"
      end)

    task_text =
      if task do
        """
        Current task: #{task.title} (#{task.id}), purpose=#{task.purpose}, status=#{task.status}, run=#{task.runId || "none"}.
        Task brief: #{clip(task.prompt, 4_000)}
        Task brief note: #{task.briefNoteId || "none"}; captured revisions=#{inspect(task.briefRevisions)}.
        #{task_role(task)}
        """
      else
        "You are the mission coordinator/orchestrator for this turn; no worker task is attached."
      end

    approval =
      if mission.approvedAt in [nil, ""] do
        "Authority: follow the explicit user request and accepted scope. A separate manual brief approval is not required; never infer permission from mission status or note edits."
      else
        "Approval: recorded at #{mission.approvedAt} by #{mission.approvedBy || "unknown"} for revisions #{inspect(mission.approvedRevisions)}."
      end

    """
    [Fizzer mission context — current at dispatch time]
    Mission: #{mission.title} (#{mission.id})
    Phase: #{phase}; status=#{mission.status}; updated=#{mission.updatedAt}.
    Mission summary: #{mission.summary}
    Mission brief: #{mission_brief}
    #{approval}
    #{workflow_guidance(phase, task)}
    #{task_text}
    Linked notes are authoritative. Preserve their hierarchy, current revisions, and the Open questions section; do not replace them with an inferred schema.
    Linked notes (current content and revisions):
    #{if note_text == "", do: "(none)", else: note_text}
    Note changes since the prior coordinator assessment:
    #{if changes_text == "", do: "(none)", else: changes_text}
    #{if awareness == "", do: "", else: awareness}
    Current task evidence (statuses are evidence, not authority):
    #{if evidence_text == "", do: "(none)", else: evidence_text}
    """
    |> String.trim()
  end

  defp workflow_guidance("planning", _task) do
    "Plan and research as needed, then delegate implementation within the explicit user request or accepted scope without asking for approval again. Preserve Stop and unresolved historical resumption decisions; ask only for missing authority or a material scope change."
  end

  defp workflow_guidance("executing", _task) do
    "Execute the authorized scope through research as needed, implementation, independent agent review, fixes/re-review, integration, then verification. Do not require repeated human review of already authorized work. A provider success is not review acceptance or verification."
  end

  defp workflow_guidance("closed", _task) do
    "This mission is closed. Report its existing completion evidence and do not create replacement work."
  end

  defp workflow_guidance(_, _task), do: "Follow explicit user scope and Stop; mission phase and approval metadata do not grant authority."

  defp task_role(%{purpose: "research"}) do
    "Research task: gather reproducible evidence and citations, record findings, and leave implementation decisions to the coordinator."
  end

  defp task_role(%{purpose: "implementation"}) do
    "Implementation task: make the bounded change, preserve the assigned note revision snapshot, and report changed files plus verification evidence."
  end

  defp task_role(%{purpose: "review"}) do
    "Review task: independently assess the relevant implementation, report reviewOutcome=accepted or changes_requested with concrete evidence, and do not act as the implementer."
  end

  defp task_role(%{purpose: "fix"}) do
    "Fix task: address the cited review findings, retain evidence of each correction, and return the task for independent re-review."
  end

  defp task_role(%{purpose: "integration"}) do
    "Integration task: reconcile accepted implementation/review artifacts into one candidate and report the candidate identity and conflicts resolved."
  end

  defp task_role(%{purpose: "verification"}) do
    "Verification task: inspect the integrated candidate, run the checks warranted by the change, and report verificationPassed=true or false with evidence."
  end

  defp task_role(_), do: "Complete the assigned task purpose and report concrete artifacts and evidence."


  defp mission_row([
         id,
         vault_id,
         channel_id,
         title,
         objective,
         status,
         summary,
         phase,
         coordinator,
         updated,
         approved_at,
         approved_by,
         approved_revisions
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      channelId: channel_id,
      title: Privacy.redact_blocks(to_string(title || "")),
      objective: objective || "",
      status: status,
      summary: Privacy.redact_blocks(to_string(summary || "")),
      phase: phase,
      coordinator: coordinator,
      updatedAt: updated,
      approvedAt: approved_at,
      approvedBy: approved_by,
      approvedRevisions: decode_revisions(approved_revisions)
    }
  end

  defp mission_row(_), do: nil

  defp task_row([id, mission_id, title, purpose, status, summary, prompt, assignee, parent, run, work_item,
                 brief_note_id, brief_revisions, review_outcome, verification_passed, updated]) do
    %{
      id: id,
      missionId: mission_id,
      title: Privacy.redact_blocks(to_string(title || "")),
      purpose: normalize_purpose(purpose),
      status: status,
      summary: Privacy.redact_blocks(to_string(summary || "")),
      prompt: Privacy.redact_blocks(to_string(prompt || "")),
      assignee: assignee,
      parent: parent,
      runId: run,
      workItemId: work_item,
      briefNoteId: brief_note_id,
      briefRevisions: decode_revisions(brief_revisions),
      reviewOutcome: review_outcome,
      verificationPassed: verification_passed,
      updatedAt: updated
    }
  end

  defp task_row(_), do: nil

  defp decode_revisions(value) when is_map(value), do: value

  defp decode_revisions(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, map} when is_map(map) -> map
      _ -> %{}
    end
  end

  defp decode_revisions(_), do: %{}

  defp normalize_phase(value) when value in @phases, do: value
  defp normalize_phase(_), do: "planning"
  defp normalize_purpose(value) when value in @purposes, do: value
  defp normalize_purpose(_), do: "implementation"

  defp clip(value, limit) do
    value = to_string(value || "")
    if String.length(value) > limit, do: String.slice(value, 0, limit - 1) <> "…", else: value
  end

  defp nonblank(value, fallback) when value in [nil, ""], do: fallback
  defp nonblank(value, _fallback), do: value

  defp field(map, key, fallback \\ nil)
  defp field(map, key, fallback) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))
  defp field(_map, _key, fallback), do: fallback
end
