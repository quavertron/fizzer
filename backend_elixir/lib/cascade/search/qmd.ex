defmodule Cascade.Search.QMD do
  @moduledoc """
  Elixir-owned QMD corpus lifecycle and result contract.

  Semantic inference is delegated to the pinned `@tobilu/qmd` model worker;
  the web backend, corpus authority, private variants, timeouts, backpressure,
  reciprocal-rank fusion, and response shaping remain native Elixir.
  """

  alias Cascade.Content.{Privacy, Query}

  @rrf_offset 60

  def search(vault_id, query, opts \\ []) do
    query = String.trim(to_string(query))
    scope = normalize_scope(Keyword.get(opts, :scope, "all"))
    limit = opts |> Keyword.get(:limit, 40) |> number(40) |> trunc() |> min(100) |> max(1)
    redact_private = Keyword.get(opts, :redact_private, false)

    if query == "" do
      []
    else
      variant = if redact_private, do: "agent", else: "user"
      root = Path.join([root_dir(), safe_segment(vault_id), variant])
      corpus = sync_corpus(vault_id, root, redact_private)
      docs = Enum.filter(corpus.docs, &in_scope?(&1, scope))
      adapter = Application.get_env(:cascade_elixir, :qmd_adapter, Cascade.Search.QMD.Worker)

      rankings =
        case adapter.search(
               index_key: "#{vault_id}:#{variant}",
               root: root,
               fingerprint: corpus.fingerprint,
               query: query,
               scope: scope,
               limit: limit
             ) do
          {:ok, %{lexical: lexical, vector: vector}} -> [lexical, vector]
          {:error, _reason} -> [fallback_lexical(docs, query, limit), []]
        end

      fuse(rankings, corpus.docs, query, limit)
    end
  end

  def sync_corpus(vault_id, root, redact_private) do
    notes_dir = Path.join(root, "notes")
    chats_dir = Path.join(root, "chats")
    File.mkdir_p!(notes_dir)
    File.mkdir_p!(chats_dir)

    notes =
      Query.maps(
        "SELECT id, title, content, updated_at FROM notes WHERE vault_id = ? AND is_archived = 0",
        [vault_id],
        [:id, :title, :content, :updated_at]
      )
      |> Enum.map(fn row ->
        body =
          if redact_private, do: Privacy.redact_blocks(row.content || ""), else: row.content || ""

        title = if row.title in [nil, ""], do: "Untitled", else: row.title
        path = Path.join(notes_dir, "#{safe_segment(row.id)}.md") |> Path.expand()
        atomic_write(path, "# #{title}\n\n#{body}")

        %{
          type: "note",
          id: row.id,
          title: title,
          body: body,
          path: path,
          updated_at: row.updated_at,
          channel_id: nil,
          timestamp: nil
        }
      end)

    chats =
      if table_exists?("chat_messages") do
        Query.maps(
          "SELECT id, channel_id, author, body, created_at FROM chat_messages WHERE vault_id = ? AND body != '' AND status IS NULL AND id NOT LIKE 'sys-next-%'",
          [vault_id],
          [:id, :channel_id, :author, :body, :created_at]
        )
        |> Enum.map(fn row ->
          path = Path.join(chats_dir, "#{safe_segment(row.id)}.md") |> Path.expand()
          atomic_write(path, "# #{row.author}\n\n#{row.body}")

          %{
            type: "chat",
            id: row.id,
            title: row.author,
            body: row.body,
            path: path,
            updated_at: row.created_at,
            channel_id: row.channel_id,
            timestamp: row.created_at
          }
        end)
      else
        []
      end

    docs = notes ++ chats
    keep = docs |> Enum.map(& &1.path) |> MapSet.new()
    remove_stale(notes_dir, keep)
    remove_stale(chats_dir, keep)

    fingerprint =
      docs
      |> Enum.map(&"#{&1.type}:#{&1.id}:#{&1.updated_at}:#{String.length(&1.body)}")
      |> Enum.sort()
      |> Enum.join("|")

    %{docs: docs, fingerprint: fingerprint}
  end

  def clear_cache do
    adapter = Application.get_env(:cascade_elixir, :qmd_adapter, Cascade.Search.QMD.Worker)
    if function_exported?(adapter, :clear, 0), do: adapter.clear()
    :ok
  end

  defp fuse(rankings, docs, query, limit) do
    by_path = Map.new(docs, &{Path.expand(&1.path), &1})

    rankings
    |> Enum.reduce(%{}, fn results, fused ->
      results
      |> Enum.with_index()
      |> Enum.reduce(fused, fn {path, rank}, acc ->
        path = Path.expand(path)

        if Map.has_key?(by_path, path) do
          Map.update(
            acc,
            path,
            1 / (@rrf_offset + rank + 1),
            &(&1 + 1 / (@rrf_offset + rank + 1))
          )
        else
          acc
        end
      end)
    end)
    |> Enum.map(fn {path, score} -> {Map.fetch!(by_path, path), score} end)
    |> Enum.sort_by(fn {doc, score} -> {-score, doc.id} end)
    |> Enum.take(limit)
    |> Enum.map(fn {doc, score} ->
      %{
        type: doc.type,
        id: doc.id,
        title: doc.title,
        snippet: snippet(doc.body, query),
        score: score
      }
      |> maybe_put(:channelId, doc.channel_id)
      |> maybe_put(:timestamp, doc.timestamp)
    end)
  end

  defp fallback_lexical(docs, query, limit) do
    query_terms = tokens(query)

    docs
    |> Enum.map(fn doc ->
      text = String.downcase("#{doc.title}\n#{doc.body}")
      title = String.downcase(doc.title)

      score =
        Enum.reduce(query_terms, 0.0, fn term, total ->
          matches = length(:binary.matches(text, term))
          total + :math.log(1 + matches) + if(String.contains?(title, term), do: 1.25, else: 0.0)
        end)

      {doc.path, score}
    end)
    |> Enum.filter(&(elem(&1, 1) > 0))
    |> Enum.sort_by(fn {path, score} -> {-score, path} end)
    |> Enum.take(limit)
    |> Enum.map(&elem(&1, 0))
  end

  defp snippet(text, query, max \\ 240) do
    clean = text |> String.replace(~r/\s+/u, " ") |> String.trim()

    at =
      query
      |> tokens()
      |> Enum.map(fn term ->
        case Regex.run(Regex.compile!(Regex.escape(term), "iu"), clean, return: :index) do
          nil -> nil
          [{index, _length}] -> String.length(binary_part(clean, 0, index))
        end
      end)
      |> Enum.reject(&is_nil/1)
      |> Enum.min(fn -> 0 end)

    start = max(0, at - 70)
    value = String.slice(clean, start, max)

    if(start > 0, do: "…", else: "") <>
      value <> if(start + max < String.length(clean), do: "…", else: "")
  end

  defp atomic_write(path, body) do
    if not File.exists?(path) or File.read!(path) != body do
      temp = "#{path}.tmp-#{System.pid()}"
      File.write!(temp, body)
      File.rename!(temp, path)
    end
  end

  defp remove_stale(dir, keep) do
    dir
    |> File.ls!()
    |> Enum.filter(&String.ends_with?(&1, ".md"))
    |> Enum.map(&(Path.join(dir, &1) |> Path.expand()))
    |> Enum.reject(&MapSet.member?(keep, &1))
    |> Enum.each(&File.rm!/1)
  end

  defp root_dir,
    do: System.get_env("CASCADE_QMD_DIR") || Path.join([System.user_home!(), ".cascade", "qmd"])

  defp safe_segment(value), do: value |> to_string() |> Base.url_encode64(padding: false)

  defp tokens(text),
    do: Regex.scan(~r/[a-z0-9_@#\.\/:-]{2,}/u, String.downcase(text)) |> List.flatten()

  defp normalize_scope(value) when value in [:notes, "notes"], do: "notes"
  defp normalize_scope(value) when value in [:chat, "chat"], do: "chat"
  defp normalize_scope(_value), do: "all"
  defp in_scope?(_doc, "all"), do: true
  defp in_scope?(%{type: "note"}, "notes"), do: true
  defp in_scope?(%{type: "chat"}, "chat"), do: true
  defp in_scope?(_doc, _scope), do: false
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp table_exists?(name),
    do: Query.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil

  defp number(value, _fallback) when is_integer(value) or is_float(value), do: value

  defp number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      :error -> fallback
    end
  end
end
