defmodule Cascade.Content.Privacy do
  @moduledoc false

  import Bitwise

  @start ~r/^[\t ]*:::private[\t ]*$/iu
  @finish ~r/^[\t ]*:::[\t ]*$/u
  @placeholder ~r/\[Private block hidden from agents\. id=([a-z0-9-]+)\]/iu
  @redacted_block ~r/\A[\t ]*:::private[\t ]*\r?\n\[Private block hidden from agents\. id=[a-z0-9-]+\]\r?\n[\t ]*:::[\t ]*\z/iu

  def redact_note(nil, _agent?), do: nil

  def redact_note(note, agent?) do
    note = Map.delete(note, :file_path)

    note =
      if is_binary(note[:content]),
        do: Map.put(note, :revision, Cascade.WikiMaintenance.revision(note.content)),
        else: note

    if agent? do
      note
      |> maybe_update(:content, &redact_blocks/1)
      |> maybe_update(:content_preview, &redact_preview/1)
    else
      note
    end
  end

  def redact_blocks(content) do
    replace_blocks(to_string(content), fn block ->
      if Regex.match?(@redacted_block, block.raw), do: block.raw, else: placeholder(block)
    end)
  end

  def redact_preview(content) do
    value = to_string(content)

    case Regex.run(~r/:::private/iu, value, return: :index) do
      nil ->
        value

      [{offset, _length}] ->
        String.trim(binary_part(value, 0, offset) <> "[Private block hidden from agents]")
    end
  end

  def sanitize_json(value) when is_binary(value), do: redact_blocks(value)
  def sanitize_json(value) when is_list(value), do: Enum.map(value, &sanitize_json/1)

  def sanitize_json(value) when is_map(value) do
    Map.new(value, fn
      {key, item} when key in [:content_preview, "content_preview"] and is_binary(item) ->
        {key, redact_preview(item)}

      {key, item} ->
        {key, sanitize_json(item)}
    end)
  end

  def sanitize_json(value), do: value

  def restore_blocks(existing, incoming) do
    incoming = to_string(incoming)

    markers =
      Enum.map(private_blocks(existing), fn block ->
        marker =
          if Regex.match?(@redacted_block, block.raw), do: block.raw, else: placeholder(block)

        [_, id] = Regex.run(@placeholder, marker)
        # Both engines have emitted these hash casings; the raw block is never normalized.
        aliases =
          [id, String.downcase(id), String.upcase(id) |> String.replace_prefix("P", "p")]
          |> Enum.uniq()
          |> Enum.map(&String.replace(marker, "id=#{id}", "id=#{&1}"))

        {String.downcase(id), aliases, block.raw}
      end)

    expected = MapSet.new(markers, fn {id, _, _} -> id end)
    ids = Regex.scan(@placeholder, incoming, capture: :all_but_first)

    Enum.each(ids, fn [id] ->
      if not MapSet.member?(expected, String.downcase(id)),
        do: raise(ArgumentError, "Unknown private block placeholder.")
    end)

    replacements =
      Enum.reduce(markers, %{}, fn {id, aliases, raw}, replacements ->
        occurrences = Enum.flat_map(aliases, &:binary.matches(incoming, &1))

        if length(occurrences) != 1 or
             Enum.count(ids, fn [found] -> String.downcase(found) == id end) != 1 do
          raise ArgumentError,
                "Agent edits must preserve every private block placeholder exactly once."
        end

        Enum.reduce(aliases, replacements, &Map.put(&2, &1, raw))
      end)

    if map_size(replacements) == 0,
      do: incoming,
      else: String.replace(incoming, Map.keys(replacements), &Map.fetch!(replacements, &1))
  end

  defp private_blocks(content) do
    lines = content_lines(to_string(content))
    parse_blocks(lines, to_string(content), 0, [])
  end

  defp parse_blocks([], _content, _index, blocks), do: Enum.reverse(blocks)

  defp parse_blocks([line | rest], content, index, blocks) do
    if Regex.match?(@start, line.text) do
      {finish, remaining} = find_finish(rest, byte_size(content))
      raw = binary_part(content, line.from, finish - line.from)
      block = %{from: line.from, to: finish, raw: raw, id: stable_id(raw, index)}
      parse_blocks(remaining, content, index + 1, [block | blocks])
    else
      parse_blocks(rest, content, index, blocks)
    end
  end

  defp find_finish([], default), do: {default, []}

  defp find_finish([line | rest], default) do
    if Regex.match?(@finish, line.text),
      do: {line.to, rest},
      else: find_finish(rest, default)
  end

  defp content_lines(content), do: content_lines(content, 0, [])

  defp content_lines(content, from, lines) when from >= byte_size(content),
    do: Enum.reverse(lines)

  defp content_lines(content, from, lines) do
    rest = binary_part(content, from, byte_size(content) - from)

    size =
      case :binary.match(rest, "\n") do
        :nomatch -> byte_size(rest)
        {relative, 1} -> relative
      end

    raw = binary_part(rest, 0, size)
    text = if String.ends_with?(raw, "\r"), do: binary_part(raw, 0, size - 1), else: raw
    line = %{from: from, to: from + size, text: text}
    content_lines(content, from + size + 1, [line | lines])
  end

  defp stable_id(raw, index) do
    input = Integer.to_string(index) <> <<0>> <> raw

    utf16 = :unicode.characters_to_binary(input, :utf8, {:utf16, :little})

    hash =
      for <<unit::little-16 <- utf16>>, reduce: 2_166_136_261 do
        current -> band(bxor(current, unit) * 16_777_619, 0xFFFFFFFF)
      end

    "p#{hash |> Integer.to_string(36) |> String.downcase()}-#{index + 1}"
  end

  defp placeholder(block) do
    ":::private\n[Private block hidden from agents. id=#{block.id}]\n:::"
  end

  defp replace_blocks(content, replacement) do
    blocks = private_blocks(content)

    {parts, cursor} =
      Enum.reduce(blocks, {[], 0}, fn block, {parts, cursor} ->
        prefix = binary_part(content, cursor, block.from - cursor)
        {[parts, prefix, replacement.(block)], block.to}
      end)

    IO.iodata_to_binary([parts, binary_part(content, cursor, byte_size(content) - cursor)])
  end

  defp maybe_update(map, key, function) do
    case Map.fetch(map, key) do
      {:ok, value} when is_binary(value) -> Map.put(map, key, function.(value))
      _ -> map
    end
  end
end
