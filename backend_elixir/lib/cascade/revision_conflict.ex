defmodule Cascade.RevisionConflict do
  @moduledoc false

  # No historical baseline is retained. Compare only submitted persisted fields,
  # never claim these are the fields changed since the caller's revision.
  def error(message, revision, current, submitted) do
    current = Map.new(current, fn {key, value} -> {to_string(key), value} end)

    fields =
      submitted
      |> Enum.filter(fn {key, value} ->
        key != "revision" and Map.has_key?(current, key) and current[key] != value
      end)
      |> Enum.map(&elem(&1, 0))
      |> Enum.sort()

    {:error,
     %{
       error: message,
       code: "revision_conflict",
       currentRevision: revision,
       changedFields: fields,
       changedFieldsBasis: "submitted_values",
       changesSinceRevisionKnown: false
     }}
  end
end
