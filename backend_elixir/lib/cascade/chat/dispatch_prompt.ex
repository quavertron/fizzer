defmodule Cascade.Chat.DispatchPrompt do
  @moduledoc "Focused chat prompts and media built from durable dispatches in the runner owner's channel."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext, Schema}
  alias Cascade.Content.Privacy

  @without_images ~w(grok antigravity copilot hermes akron-grok)
  @labels %{
    "claude-code" => "Claude",
    "codex" => "Codex",
    "grok" => "Grok",
    "antigravity" => "Antigravity",
    "copilot" => "Copilot",
    "hermes" => "Hermes",
    "akron-grok" => "Akron --grok",
    "omp" => "OMP",
    "pi" => "Pi"
  }
  @relationships %{
    "builds_on" => {"Building on", "…which built on"},
    "review_request" => {"Review requested for", "…which requested review of"},
    "question" => {"Question about", "…which asked about"},
    "contradiction" => {"Challenging", "…which challenged"},
    "decision" => {"Decision about", "…which decided about"}
  }

  @doc "Returns prompt, provider images, and the outgoing collaboration reply reference. Room context is added by the caller."
  def build(dispatch, execution, resume) do
    channel_id = execution.target_channel_id
    user_id = execution.runner_user_id
    {:ok, route} = Channel.assert_channel(channel_id, user_id)
    registration = execution.registration || field(dispatch, :registration)
    message = field(dispatch, :message) |> Privacy.sanitize_json()
    {:ok, registrations} = Agents.list_members(channel_id, user_id)
    registrations = [registration | registrations]
    source = message_text(message)
    direct = strip_mentions(source, registrations)
    reply = field(message, :replyTo)
    reply_to = collaboration_reply(message)

    if execution.agent == "claude-code" and String.downcase(direct) == "/compact" and
         not is_map(reply) and text(message, :missionTaskId) == "" do
      %{prompt: "/compact", images: [], reply_to: reply_to}
    else
      own_images = images(hydrate_media(message, channel_id, user_id))

      batch =
        if not is_map(reply) and (direct == "" or own_images == []),
          do: preceding_batch(route, user_id, message),
          else: []

      chain = reply_chain(reply, channel_id, user_id, MapSet.new(), 0)
      quoted = quote_chain(chain, mention(registration))
      batch_text = batch |> Enum.map_join("\n", &message_text/1) |> tail(4_000)

      request =
        join([quoted, if(direct == "" and not is_map(reply), do: batch_text, else: direct)])

      request =
        if request == "", do: nonblank(source, "Please review the attached media."), else: request

      carried =
        if own_images == [] do
          sources =
            if is_map(reply), do: Enum.take(chain, 1) |> Enum.map(&elem(&1, 1)), else: batch

          sources
          |> Enum.filter(
            &(is_map(&1) and has_images?(&1) and
                not String.starts_with?(text(&1, :id), "agent-dispatch-"))
          )
          |> Enum.take(-4)
          |> Enum.flat_map(&(hydrate_media(&1, channel_id, user_id) |> images()))
          |> Enum.take(-4)
        else
          []
        end

      run_images = Enum.take(own_images ++ carried, 8)
      blind = execution.agent in @without_images

      media_notice =
        if blind and run_images != [],
          do:
            "This message carries #{length(run_images)} image(s) not delivered inline. Open them with `cascade-chat attachment --message-id <id>`; if unavailable, say so instead of guessing.",
          else: ""

      [channel_name] = SQL.one("SELECT title FROM notes WHERE id=?", [channel_id])

      %{
        prompt:
          join([
            header(channel_name, registration, execution.agent, message, resume),
            request,
            media_notice
          ]),
        images: if(blind, do: [], else: run_images),
        reply_to: reply_to
      }
    end
  end

  defp header(channel, registration, agent, message, resume) do
    continued = resume not in [nil, "", false]
    name = nonblank(text(registration, :displayName), Map.get(@labels, agent, agent))

    identity =
      "You are #{name} (@#{mention(registration)}) in ##{Privacy.redact_blocks(channel)}, replying to #{text(message, :author)}."

    note = if continued, do: "", else: text(registration, :contextPrompt)
    task = text(message, :missionTaskId)

    delivery =
      if field(registration, :ambientGroupChat) == true and task == "" do
        "You are a persistent participant in this shared conversation. Use your own judgment: reply, ask, disagree, use tools, or pursue useful project work. Your final response is posted automatically; do not call cascade-chat send or collaboration tools."
      else
        join(
          [
            "Complete requested work and required verification before replying; use judgment and do not over-research. Once implementation and required checks are delivered, owner-waived optional verification must not make the task blocked. Report Delivered, awaiting your feedback and explicitly disclose any unverified behavior. Keep actual implementation, required-check, deployment, or authority blockers blocked; honor explicit Stop. Keep the final chat reply short: outcome first; skip process narrative and restated questions. Keep progress in the run trace; do not post separate chat messages.",
            if(field(registration, :finalReplyOnly) == true,
              do:
                "Write one normal group-chat message, never a work log: no planning, status, reasoning, tool narration, or generic agreement. Respond to concrete claims in the triggering message. If you have no new evidence, correction, question, or decision, output exactly [no-reply].",
              else: ""
            ),
            if(not continued,
              do:
                "Use #{if agent == "akron-grok", do: "the harness `scratchpad`", else: "`cascade-scratchpad`"} only for a durable root cause, decision, or dead end; skip routine progress and simple Q&A.",
              else: ""
            )
          ],
          " "
        )
      end

    role =
      cond do
        task != "" ->
          "You are a mission worker, not the channel control plane. Fizzer mission task id: #{task}. Execute only this assigned task; do not start a mission or spawn provider subagents. #{Cascade.Missions.Children.guidance(task)} The mission card updates when this run ends. If blocked, run `cascade-chat mission update --task #{task} --status blocked --summary \"<what is needed>\"` and stop."

        String.starts_with?(text(message, :id), ["sys-mission-", "sys-next-"]) ->
          ""

        field(registration, :orchestrator) == true and
            field(registration, :ambientGroupChat) != true ->
          "You coordinate this channel. Treat clear actionable requests as implementation authority; clarify only a requested mission/kanban or a material scope, authority, or product choice. Stay available as a lightweight control plane: answer trivial questions directly. For actionable work, first inspect `cascade-chat mission list` for existing ownership of the same request; use `cascade-chat mission status --mission <id>` when needed and use `cascade-chat mission steer` for corrections to a running task. Keep implementation, recovery, verification, and delivery under that same owner; do not create overlapping missions for these phases. Honor explicit Stop; do not retry or restart canceled work without a new user instruction. Only when no existing task owns the request, use `cascade-chat mission start --control-plane`, then pass the request unchanged to one anonymous self-subagent with `cascade-chat mission delegate --anonymous`. The worker uses the channel working directory and normal CLI path; do not plan, verify, poll, or wait in the coordinator turn. Its successful final response completes the mission and replies automatically. Use `--isolated`, multiple workers, dependencies, or coordinator review only when explicitly needed by the user; use `--after`, `--priority`, or `--effort` when needed. Workers are ephemeral task-scoped copies of your model, tools, authority, and safety policy, not vault agents. Keep mission summaries short. Fix it with the smallest test that would have caught it. Open images with `cascade-chat attachment --message-id <id>`."

        true ->
          ""
      end

    join([identity, delivery, role, if(note == "", do: "", else: "Channel note: " <> note)], " ")
  end

  defp preceding_batch(route, user_id, message) do
    # Cursor-relative IDs avoid both future turns and a renderer-sized recent-history window.
    SQL.all(
      "SELECT id FROM chat_messages WHERE channel_id=? AND rowid < (SELECT rowid FROM chat_messages WHERE id=? AND channel_id=?) ORDER BY rowid DESC LIMIT 8",
      [route.sourceChannelId, text(message, :id), route.sourceChannelId]
    )
    |> Stream.map(fn [id] ->
      case Messages.get(route.localChannelId, user_id, id) do
        {:ok, prior} -> Privacy.sanitize_json(prior)
        _ -> nil
      end
    end)
    |> Enum.take_while(
      &(is_map(&1) and text(&1, :author) == text(message, :author) and
          author_key(&1) == author_key(message))
    )
    |> Enum.reverse()
  end

  defp author_key(message), do: field(message, :registrationId) || field(message, :agentId)

  defp reply_chain(reply, channel_id, user_id, seen, depth) do
    id = text(reply, :messageId)

    if not is_map(reply) or id == "" or MapSet.member?(seen, id) or depth > RoomContext.max_hops() do
      []
    else
      case Messages.get(channel_id, user_id, id) do
        {:ok, parent} ->
          parent = Privacy.sanitize_json(parent)

          [
            {reply, parent}
            | reply_chain(
                field(parent, :replyTo),
                channel_id,
                user_id,
                MapSet.put(seen, id),
                depth + 1
              )
          ]

        _ ->
          [{reply, nil}]
      end
    end
  end

  defp quote_chain(chain, self_mention) do
    chain
    |> Enum.with_index()
    |> Enum.map(fn {{reply, message}, depth} ->
      body = nonblank(message_text(message), Privacy.redact_preview(text(reply, :preview)))

      who =
        nonblank(
          text(reply, :author),
          nonblank(text(reply, :mention), nonblank(text(message, :author), "a message"))
        )

      addressed =
        Regex.scan(~r/(?:^|[\s(])@([A-Za-z0-9_-]{1,40})/, body, capture: :all_but_first)
        |> List.flatten()
        |> Enum.map(&Schema.normalize_mention/1)
        |> Enum.uniq()

      aside =
        if self_mention != "" and addressed != [] and self_mention not in addressed,
          do:
            " (addressed to #{Enum.map_join(addressed, ", ", &("@" <> &1))}, not you — context only)",
          else: ""

      labels =
        Map.get(
          @relationships,
          field(reply, :relationship),
          {"Replying to", "…which was itself replying to"}
        )

      label = elem(labels, if(depth == 0, do: 0, else: 1))

      quote =
        body
        |> clip(if(depth == 0, do: 1_200, else: 400))
        |> String.split("\n")
        |> Enum.map_join("\n", &("> " <> &1))

      if body == "", do: "", else: "#{label} #{who}#{aside}:\n#{quote}"
    end)
    |> join()
  end

  defp collaboration_reply(message) do
    if text(field(message, :replyTo), :relationship) != "" do
      %{
        "messageId" => text(message, :id),
        "author" => text(message, :author),
        "mention" => "",
        "preview" =>
          nonblank(text(message, :body), "(collaboration request)") |> String.slice(0, 120),
        "relationship" => "builds_on"
      }
    end
  end

  defp hydrate_media(message, channel_id, user_id) do
    if field(message, :hasImages) == true do
      case Messages.get(channel_id, user_id, text(message, :id)) do
        {:ok, full} -> Privacy.sanitize_json(full)
        _ -> message
      end
    else
      message
    end
  end

  defp has_images?(message),
    do: field(message, :hasImages) == true or List.wrap(field(message, :images)) != []

  defp images(message) do
    message
    |> field(:images)
    |> List.wrap()
    |> Enum.flat_map(fn source ->
      case is_binary(source) &&
             Regex.run(~r/^data:(image\/[^;,]+);base64,(.+)$/s, String.trim(source)) do
        [_, media_type, data] -> [%{"media_type" => media_type, "data" => data}]
        _ -> []
      end
    end)
  end

  defp message_text(message),
    do:
      join(
        [
          text(message, :body)
          | Enum.map(List.wrap(field(message, :attachments)), &text(&1, :name))
        ],
        " "
      )

  defp strip_mentions(source, registrations) do
    Enum.reduce(registrations, source, fn registration, source ->
      handle = mention(registration)

      if handle == "",
        do: source,
        else:
          Regex.replace(
            Regex.compile!("@\\s*" <> Regex.escape(handle) <> "(?=$|[\\s.,:;!?\\])}])", "i"),
            source,
            " "
          )
    end)
    |> String.trim()
  end

  defp mention(registration),
    do: Schema.normalize_mention(text(registration, :mention), text(registration, :agentId))

  defp clip(text, limit),
    do: if(String.length(text) > limit, do: String.slice(text, 0, limit - 1) <> "…", else: text)

  defp tail(text, limit),
    do:
      if(String.length(text) > limit,
        do: "…" <> String.slice(text, -(limit - 1), limit - 1),
        else: text
      )

  defp join(parts, separator \\ "\n\n"),
    do: parts |> Enum.reject(&(&1 in [nil, ""])) |> Enum.join(separator)

  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value

  defp text(map, key),
    do: field(map, key, "") |> to_string() |> Privacy.redact_blocks() |> String.trim()

  defp field(map, key, fallback \\ nil)

  defp field(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))

  defp field(_map, _key, fallback), do: fallback
end
