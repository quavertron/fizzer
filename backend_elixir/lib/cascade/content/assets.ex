defmodule Cascade.Content.Assets do
  @moduledoc "Validated note assets stored below each vault's isolated root."

  import Bitwise

  alias Cascade.Content.{Query, Store}

  @max_bytes 64 * 1_024 * 1_024
  @extensions %{
    "image/png" => "png",
    "image/jpeg" => "jpg",
    "image/jpg" => "jpg",
    "image/gif" => "gif",
    "image/webp" => "webp",
    "image/svg+xml" => "svg",
    "audio/mpeg" => "mp3",
    "audio/mp3" => "mp3",
    "video/mp4" => "mp4",
    "application/pdf" => "pdf",
    "text/plain" => "txt",
    "text/html" => "html",
    "text/markdown" => "md"
  }
  @mime_by_extension %{
    ".png" => "image/png",
    ".jpg" => "image/jpeg",
    ".jpeg" => "image/jpeg",
    ".gif" => "image/gif",
    ".webp" => "image/webp",
    ".svg" => "image/svg+xml",
    ".mp3" => "audio/mpeg",
    ".mp4" => "video/mp4",
    ".pdf" => "application/pdf",
    ".txt" => "text/plain",
    ".html" => "text/html",
    ".md" => "text/markdown"
  }

  def max_bytes, do: @max_bytes

  def canonical_media_type("image/jpg"), do: "image/jpeg"
  def canonical_media_type("audio/mp3"), do: "audio/mpeg"
  def canonical_media_type(media_type), do: media_type

  def decode_data(data) do
    compact = data |> to_string() |> String.replace(~r/\s/u, "")

    invalid? =
      compact == "" or
        not Regex.match?(~r/^[A-Za-z0-9+\/]*={0,2}$/u, compact) or
        rem(String.length(compact), 4) == 1

    if invalid?, do: raise(ArgumentError, "Asset data is not valid base64")

    canonical_input = String.replace(compact, ~r/=+$/u, "")

    decoded =
      case Base.decode64(canonical_input, padding: false) do
        {:ok, bytes} -> bytes
        :error -> raise ArgumentError, "Asset data is not valid base64"
      end

    canonical_decoded = decoded |> Base.encode64() |> String.replace(~r/=+$/u, "")

    if byte_size(decoded) == 0 or canonical_input != canonical_decoded do
      raise ArgumentError, "Asset data is not valid base64"
    end

    decoded
  end

  def matches_media_type?(media_type, bytes) when is_binary(bytes) do
    case canonical_media_type(media_type) do
      "image/png" ->
        byte_size(bytes) >= 8 and
          binary_part(bytes, 0, 8) == <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A>>

      "image/jpeg" ->
        byte_size(bytes) >= 3 and binary_part(bytes, 0, 3) == <<0xFF, 0xD8, 0xFF>>

      "image/gif" ->
        byte_size(bytes) >= 6 and binary_part(bytes, 0, 6) in ["GIF87a", "GIF89a"]

      "image/webp" ->
        byte_size(bytes) >= 12 and binary_part(bytes, 0, 4) == "RIFF" and
          binary_part(bytes, 8, 4) == "WEBP"

      "audio/mpeg" ->
        (byte_size(bytes) >= 3 and binary_part(bytes, 0, 3) == "ID3") or
          (byte_size(bytes) >= 2 and :binary.at(bytes, 0) == 0xFF and
             (:binary.at(bytes, 1) &&& 0xE0) == 0xE0)

      "video/mp4" ->
        byte_size(bytes) >= 12 and binary_part(bytes, 4, 4) == "ftyp"

      "application/pdf" ->
        byte_size(bytes) >= 5 and binary_part(bytes, 0, 5) == "%PDF-"

      media_type when media_type in ["text/plain", "text/markdown", "text/html"] ->
        String.valid?(bytes) and not String.contains?(bytes, <<0>>)

      _ ->
        false
    end
  end

  def assets_dir(note_id) do
    with note when not is_nil(note) <- Store.get_note(note_id),
         [root_path] <- Query.one("SELECT root_path FROM vaults WHERE id = ?", [note.vault_id]) do
      Store.resolve_under_vault(root_path, [".cascade-assets", note_id])
    else
      _ -> nil
    end
  end

  def delete_all(note_id) do
    case assets_dir(note_id) do
      nil ->
        :ok

      directory ->
        File.rm_rf(directory)
        :ok
    end
  end

  def upload(note_id, user_id, input) do
    note = Store.get_note(note_id) || raise(ArgumentError, "Note not found")

    if is_nil(Store.get_writable_vault(note.vault_id, user_id)),
      do: raise(ArgumentError, "Note not found")

    declared = input |> value(:media_type) |> to_string() |> String.trim() |> String.downcase()

    cond do
      declared in ["image/svg+xml", "image/svg"] ->
        raise ArgumentError, "SVG uploads are not supported"

      not Map.has_key?(@extensions, declared) ->
        raise ArgumentError, "This file type is not supported"

      true ->
        :ok
    end

    media_type = canonical_media_type(declared)
    data = input |> value(:data) |> to_string() |> String.trim()
    if data == "", do: raise(ArgumentError, "Asset data is required")
    bytes = decode_data(data)

    if media_type == "text/html" and byte_size(bytes) > 1_048_576,
      do: raise(ArgumentError, "HTML preview is too large (max 1MB)")

    if byte_size(bytes) > @max_bytes,
      do: raise(ArgumentError, "Asset is too large (max #{div(@max_bytes, 1_024 * 1_024)}MB)")

    if not matches_media_type?(media_type, bytes),
      do: raise(ArgumentError, "Asset contents do not match the declared media type")

    asset_id = :crypto.strong_rand_bytes(12) |> Base.url_encode64(padding: false)
    extension = Map.get(@extensions, media_type, "bin")
    directory = assets_dir(note_id) || raise(ArgumentError, "Note not found")
    File.mkdir_p!(directory)
    File.chmod!(directory, 0o700)
    filename = "#{asset_id}.#{extension}"
    path = Path.join(directory, filename)

    {:ok, device} = File.open(path, [:write, :binary, :exclusive])

    try do
      IO.binwrite(device, bytes)
    after
      File.close(device)
    end

    File.chmod!(path, 0o600)

    %{asset_id: asset_id, url: "/api/notes/#{note_id}/assets/#{asset_id}", filename: filename}
  end

  def resolve_path(note_id, asset_id) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/u, asset_id) do
      with directory when not is_nil(directory) <- assets_dir(note_id),
           {:ok, files} <- File.ls(directory),
           filename when not is_nil(filename) <-
             Enum.find(files, &String.starts_with?(&1, asset_id <> ".")),
           candidate = Path.join(directory, filename),
           {:ok, %{type: :regular}} <- File.lstat(candidate) do
        candidate
      else
        _ -> nil
      end
    end
  end

  def response_metadata(path) do
    extension = path |> Path.extname() |> String.downcase()
    downloadable? = extension in [".svg", ".pdf", ".txt", ".md", ".html"]

    %{
      content_type: Map.get(@mime_by_extension, extension, "application/octet-stream"),
      content_disposition:
        "#{if(downloadable?, do: "attachment", else: "inline")}; filename=\"#{Path.basename(path)}\"",
      cache_control: "private, max-age=3600",
      csp: "default-src 'none'; sandbox"
    }
  end

  defp value(map, key) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), ""))

  defp value(_, _), do: ""
end
