defmodule Cascade.Runs.PromptContext do
  @moduledoc "Node-compatible cold-start prompt enrichment and desktop delegation payloads."

  alias Cascade.Content.Privacy
  alias Cascade.Evolution
  alias Cascade.Scratchpad

  @removed_model_presets ~w(codex-flash codex-pro grok-2 grok-beta gpt-4o claude-3.5-sonnet o1-mini)
  @inline_svg ~r/<svg\b[\s\S]*?<\/svg\s*>/iu

  def app_context, do: Cascade.Runs.AppContext.seed()

  def normalize_model(value) when is_binary(value) do
    value = String.trim(value)
    if value == "" or value in @removed_model_presets, do: nil, else: value
  end

  def normalize_model(_value), do: nil

  def normalize_cwd(value) when is_binary(value) do
    value = String.trim(value)

    if value == "" or Regex.match?(~r/^(vault\s*root|root|\.\/?)$/iu, value),
      do: nil,
      else: value
  end

  def normalize_cwd(_value), do: nil

  def agent_memory_key("akron-grok"), do: "akron"
  def agent_memory_key(agent), do: to_string(agent)

  def enrich_prompt(vault_id, user_id, prompt, agent, resume_session_id, mode \\ :default)

  def enrich_prompt(_vault_id, _user_id, "/compact", "claude-code", _resume, _mode),
    do: "/compact"

  def enrich_prompt(vault_id, user_id, prompt, agent, resume_session_id, mode) do
    chunks =
      if normalize_context_mode(mode) != :self_contained and resume_session_id in [nil, ""] do
        key = agent_memory_key(agent)

        [
          memory_context(vault_id, user_id, prompt, key),
          scratchpad_context(vault_id, user_id, key)
        ]
      else
        []
      end

    append_context(prompt, [Cascade.Runs.AppContext.injection(user_id) | chunks])
  end

  def normalize_context_mode("self-contained"), do: :self_contained
  def normalize_context_mode(:self_contained), do: :self_contained
  def normalize_context_mode(_mode), do: :default

  def normalize_sandbox("read-only"), do: "read-only"
  def normalize_sandbox(:read_only), do: "read-only"
  def normalize_sandbox(_mode), do: nil

  defp context_mode_payload(mode) do
    case normalize_context_mode(mode) do
      :self_contained -> "self-contained"
      :default -> nil
    end
  end

  def delegate_payload(run, vault_root, agent, prompt, params, resume_session_id, runtime \\ %{}) do
    memory_key = field(runtime, :agent_memory_key, agent_memory_key(agent))
    {prompt, inline_svgs} = extract_inline_svgs(prompt)

    {prompt, inline_svgs} =
      merge_context_inline_svgs(prompt, inline_svgs, field(runtime, :inline_svgs, []))

    %{
      runId: run.id,
      vaultId: run.vault_id,
      agent: agent,
      prompt: prompt,
      vaultRoot: vault_root,
      priorityServiceTier: field(runtime, :priority_service_tier, false) == true,
      chatChannelId: field(runtime, :chat_channel_id, ""),
      chatMessageId: field(runtime, :chat_message_id, ""),
      chatTriggeringMessageId: field(runtime, :chat_triggering_message_id, ""),
      chatAuthor: field(runtime, :chat_author, ""),
      agentMemoryKey: memory_key,
      chatRegistrationId: field(runtime, :chat_registration_id, ""),
      images: clean_images(params["images"]),
      inlineSvgs: inline_svgs,
      yolo: field(runtime, :yolo, params["yolo"] == true) == true,
      hermesProfile: field(runtime, :hermes_profile, ""),
      hermesSafeMode: field(runtime, :hermes_safe_mode, false) == true
    }
    |> maybe_put(:cwd, normalize_cwd(field(runtime, :cwd, params["cwd"])))
    |> maybe_put(:model, normalize_model(field(runtime, :model, params["model"])))
    |> maybe_put(:reasoningEffort, field(runtime, :reasoning_effort))
    |> maybe_put(:resumeSessionId, resume_session_id)
    |> maybe_put(:workItemId, field(runtime, :work_item_id))
    |> maybe_put(
      :contextMode,
      context_mode_payload(field(runtime, :context_mode, params["contextMode"]))
    )
    |> maybe_put(:sandbox, normalize_sandbox(field(runtime, :sandbox, params["sandbox"])))
  end

  def append_context("/compact", _chunks), do: "/compact"

  def append_context(prompt, chunks) do
    context = chunks |> List.wrap() |> Enum.reject(&(&1 in [nil, ""])) |> Enum.join("\n\n")

    if context == "",
      do: Privacy.redact_blocks(prompt),
      else: Privacy.redact_blocks(prompt <> "\n\n[Context: " <> context <> "]")
  end

  def extract_inline_svgs(prompt) when is_binary(prompt) do
    @inline_svg
    |> Regex.split(prompt, include_captures: true, trim: false)
    |> Enum.reduce({[], [], 0}, fn part, {prompt_parts, sources, count} ->
      if Regex.match?(@inline_svg, part) do
        next = count + 1
        {["[[FIZZER_INLINE_SVG:#{next}]]" | prompt_parts], [part | sources], next}
      else
        {[part | prompt_parts], sources, count}
      end
    end)
    |> then(fn {prompt_parts, sources, _count} ->
      {prompt_parts |> Enum.reverse() |> IO.iodata_to_binary(), Enum.reverse(sources)}
    end)
  end

  def extract_inline_svgs(prompt), do: {to_string(prompt || ""), []}

  defp merge_context_inline_svgs(prompt, inline_svgs, context_inline_svgs) do
    context_inline_svgs
    |> List.wrap()
    |> Enum.with_index(1)
    |> Enum.reduce({prompt, inline_svgs}, fn {svg, context_index}, {prompt, sources} ->
      marker = "[[@FIZZER_ROOM_INLINE_SVG:#{context_index}]]"

      if is_binary(svg) and String.contains?(prompt, marker) do
        next = length(sources) + 1

        {
          String.replace(prompt, marker, "[[FIZZER_INLINE_SVG:#{next}]]", global: false),
          sources ++ [svg]
        }
      else
        {prompt, sources}
      end
    end)
  end

  defp memory_context(vault_id, user_id, prompt, key) do
    try do
      Evolution.ensure_agent_named_memory_folders(vault_id, user_id, key)

      Evolution.build_agent_memory_injection(vault_id,
        channel_topic: String.slice(" #{prompt}", 0, 400),
        max_chars: 900,
        agent_key: key,
        note_stats: Scratchpad.note_stats(vault_id)
      ).text
    rescue
      _ -> ""
    end
  end

  defp scratchpad_context(vault_id, user_id, key) do
    try do
      Scratchpad.ensure_policies(vault_id, user_id, key)

      Scratchpad.build_injection(vault_id,
        agent_key: key,
        user_id: user_id,
        max_chars: 1_400
      )
    rescue
      _ -> ""
    end
  end

  defp clean_images(images) when is_list(images) do
    images
    |> Enum.filter(fn
      %{"media_type" => media_type, "data" => data}
      when is_binary(media_type) and is_binary(data) ->
        true

      _ ->
        false
    end)
    |> Enum.take(8)
    |> Enum.map(&Map.take(&1, ["media_type", "data"]))
  end

  defp clean_images(_images), do: []

  defp maybe_put(map, _key, value) when value in [nil, ""], do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp field(map, key, fallback \\ nil)

  defp field(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))

  defp field(_map, _key, fallback), do: fallback
end
