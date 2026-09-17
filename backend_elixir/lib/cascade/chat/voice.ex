defmodule Cascade.Chat.Voice do
  @moduledoc "Human-only LiveKit voice authorization. SFU membership is rechecked, including after app restart."
  use GenServer
  alias Cascade.Chat.Channel
  alias Cascade.Accounts.VaultMembers

  defp authorized_route(vault, channel, user) do
    with true <- VaultMembers.role(vault, user) in ["owner", "editor"],
         {:ok, route} <- Channel.assert_vault_channel(vault, channel, user),
         [content] <-
           Cascade.Accounts.SQL.one("SELECT content FROM notes WHERE id=?", [
             route.sourceChannelId
           ]),
         true <- List.first(String.split(String.trim(content || ""))) == "cascade://voice-channel" do
      {:ok, route}
    else
      _ -> {:error, :forbidden}
    end
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
             name: nonblank(user[:display_name]) || user.username,
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

  def participants(user, vault, channel) do
    with {:ok, route} <- authorized_route(vault, channel, user.id),
         {:ok, result} <- rpc("ListParticipants", %{room: room(route)}) do
      profiles =
        Channel.participant_snapshot(route.sourceVaultId, route.sourceChannelId,
          include_avatars: true
        ).users
        |> Map.new(&{&1.id, &1})

      {:ok,
       %{
         participants:
           Enum.map(result["participants"] || [], fn peer ->
             profile = participant_profile(peer, route, profiles)

             %{
               avatarUrl: profile[:avatarUrl] || "",
               identity: peer["identity"],
               name:
                 nonblank(profile[:displayName]) || nonblank(profile[:username]) ||
                   nonblank(peer["name"]) || "Participant",
               muted:
                 not Enum.any?(
                   peer["tracks"] || [],
                   &(&1["type"] in [nil, "AUDIO", 0] and &1["muted"] != true)
                 ),
               deafened: get_in(peer, ["attributes", "fizzer.deafened"]) == "true"
             }
           end)
       }}
    end
  end

  defp participant_profile(peer, route, profiles) do
    with true <- authorized_peer?(room(route), peer),
         {:ok, %{"user" => user}} <- Jason.decode(peer["metadata"] || "") do
      Map.get(profiles, user, %{})
    else
      _ -> %{}
    end
  end

  defp nonblank(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      name -> name
    end
  end

  defp nonblank(_), do: nil

  def deafen(user, vault, channel, identity, deafened) do
    with {:ok, route} <- authorized_route(vault, channel, user.id),
         true <- is_binary(identity) and String.starts_with?(identity, "u#{user.id}-"),
         true <- is_boolean(deafened) do
      rpc("UpdateParticipant", %{
        room: room(route),
        identity: identity,
        attributes: %{"fizzer.deafened" => to_string(deafened)}
      })
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
