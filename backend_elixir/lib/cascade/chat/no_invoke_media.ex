defmodule Cascade.Chat.NoInvokeMedia do
  @moduledoc "Bounded existing channel PNG assets for non-dispatching creation. No remote URLs or inline data."
  alias Cascade.Content.Assets
  @max_bytes 8 * 1024 * 1024

  def validate(input, channel_id) do
    images = Map.get(input, "images", [])
    attachments = Map.get(input, "attachments", [])

    if is_list(images) and length(images) <= 4 and attachments in [nil, []] and
         Enum.all?(images, &valid_image?(&1, channel_id)) do
      {:ok, images}
    else
      {:error, "Invalid channel image assets"}
    end
  end

  defp valid_image?(image, channel_id) when is_map(image) do
    prefix = "/api/notes/#{channel_id}/assets/"
    url = image["url"]
    name = image["name"]

    with true <- Enum.sort(Map.keys(image)) == ~w(data media_type name url),
         true <- image["data"] == "" and image["media_type"] == "image/png",
         true <- is_binary(name) and byte_size(name) in 1..160,
         true <- Regex.match?(~r/^[A-Za-z0-9][A-Za-z0-9._ -]*\.png$/, name),
         true <- is_binary(url) and String.starts_with?(url, prefix),
         asset_id <- String.replace_prefix(url, prefix, ""),
         true <- Regex.match?(~r/^[A-Za-z0-9_-]{16}$/, asset_id),
         path when is_binary(path) <- Assets.resolve_path(channel_id, asset_id),
         {:ok, %{size: size}} <- File.stat(path),
         true <- size > 0 and size <= @max_bytes,
         {:ok, bytes} <- File.read(path) do
      Assets.response_metadata(path).content_type == "image/png" and
        Assets.matches_media_type?("image/png", bytes)
    else
      _ -> false
    end
  end

  defp valid_image?(_, _), do: false
end
