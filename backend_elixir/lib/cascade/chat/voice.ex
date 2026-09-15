defmodule Cascade.Chat.Voice do
  @moduledoc "Human-only LiveKit voice authorization. SFU membership is rechecked, including after app restart."
  use GenServer
  alias Cascade.Chat.Channel
  alias Cascade.Accounts.VaultMembers

  defp authorized_route(vault, channel, user) do
    if VaultMembers.role(vault, user) in ["owner", "editor"],
      do: Channel.assert_vault_channel(vault, channel, user),
      else: {:error, :forbidden}
  end

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def config do
    Application.get_env(:cascade_elixir, :voice) ||
      %{
        url: System.get_env("FIZZER_VOICE_URL"),
        api: System.get_env("FIZZER_VOICE_API"),
        key: System.get_env("FIZZER_VOICE_KEY"),
        secret: System.get_env("FIZZER_VOICE_SECRET")
      }
  end

  def enabled?,
    do: Enum.all?([:url, :api, :key, :secret], &(is_binary(config()[&1]) and config()[&1] != ""))

  def room(route),
    do:
      "fizzer-" <>
        Base.url_encode64(
          :crypto.hash(:sha256, route.sourceVaultId <> ":" <> route.sourceChannelId),
          padding: false
        )

  def join(user, vault, channel) do
    with {:ok, route} <- authorized_route(vault, channel, user.id),
         true <- enabled?(),
         {:ok, _} <- rpc("ListRooms", %{names: [room(route)]}) do
      identity =
        "u#{user.id}-" <> Base.url_encode64(:crypto.strong_rand_bytes(12), padding: false)

      metadata = Jason.encode!(%{user: user.id, vault: vault, channel: channel})

      grant = %{
        roomJoin: true,
        room: room(route),
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        canPublishSources: ["microphone"]
      }

      {:ok,
       %{
         url: config().url,
         token:
           token(%{
             sub: identity,
             name: user[:display_name] || user.username,
             metadata: metadata,
             video: grant
           }),
         identity: identity,
         room: room(route)
       }}
    else
      false -> {:error, :unavailable}
      error -> error
    end
  end

  def leave(user, vault, channel, identity) do
    with {:ok, route} <- Channel.assert_vault_channel(vault, channel, user.id),
         true <- is_binary(identity) and String.starts_with?(identity, "u#{user.id}-") do
      rpc("RemoveParticipant", %{room: room(route), identity: identity})
    else
      _ -> {:error, :forbidden}
    end
  end

  def token(claims) do
    now = System.system_time(:second)

    {:ok, jwt, _} =
      Joken.encode_and_sign(
        Map.merge(%{iss: config().key, nbf: now - 5, exp: now + 30}, claims),
        Joken.Signer.create("HS256", config().secret)
      )

    jwt
  end

  def rpc(method, payload) do
    if enabled?() do
      auth =
        token(%{
          sub: "fizzer-server",
          video: %{roomList: true, roomAdmin: true, room: payload[:room] || ""}
        })

      headers = [{~c"authorization", String.to_charlist("Bearer " <> auth)}]

      url =
        String.to_charlist(
          String.trim_trailing(config().api, "/") <> "/twirp/livekit.RoomService/" <> method
        )

      case :httpc.request(
             :post,
             {url, headers, ~c"application/json", Jason.encode!(payload)},
             [
               timeout: 3000,
               connect_timeout: 1000,
               ssl: [
                 verify: :verify_peer,
                 cacerts: :public_key.cacerts_get(),
                 customize_hostname_check: [
                   match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
                 ]
               ]
             ],
             body_format: :binary
           ) do
        {:ok, {{_, status, _}, _, body}} when status in 200..299 -> Jason.decode(body)
        _ -> {:error, :unavailable}
      end
    else
      {:error, :unavailable}
    end
  end

  # Do not rely on browser heartbeats or token expiry to revoke an existing peer.
  # Metadata is server-issued; clients have no permission to modify it.
  def sweep do
    with {:ok, %{"rooms" => rooms}} <- rpc("ListRooms", %{}) do
      for %{"name" => name} <- rooms, String.starts_with?(name, "fizzer-") do
        with {:ok, %{"participants" => peers}} <- rpc("ListParticipants", %{room: name}) do
          for peer <- peers, not authorized_peer?(name, peer) do
            rpc("RemoveParticipant", %{room: name, identity: peer["identity"]})
          end
        end
      end
    end
  end

  def authorized_peer?(name, peer) do
    with {:ok, %{"user" => user, "vault" => vault, "channel" => channel}} <-
           Jason.decode(peer["metadata"] || ""),
         true <- is_integer(user),
         true <- String.starts_with?(peer["identity"] || "", "u#{user}-"),
         {:ok, route} <- authorized_route(vault, channel, user) do
      room(route) == name
    else
      _ -> false
    end
  end

  @impl true
  def init(_opts) do
    send(self(), :sweep)
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    if enabled?(), do: sweep()
    Process.send_after(self(), :sweep, 5000)
    {:noreply, state}
  end
end
