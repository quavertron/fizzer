# Fresh BEAM, disposable test DB only; no application workers or model transport.
[encoded, user, channel, mission, coordinator] = System.argv()
Application.load(:cascade_elixir)

for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(),
    do: Application.put_env(:cascade_elixir, key, value)

for app <- Application.spec(:cascade_elixir, :applications),
    do: Application.ensure_all_started(app)

Logger.configure(level: :warning)

for module <- [
      Cascade.DB.Repo,
      Cascade.DB.WriteCoordinator,
      Cascade.Realtime.Hub,
      Cascade.Realtime.OrderedPublisher
    ],
    do: {:ok, _} = module.start_link([])

{:ok, result} =
  Cascade.Missions.Store.finish(String.to_integer(user), channel, mission, %{
    coordinatorRegistrationId: coordinator,
    status: "completed",
    verification: "Existing explicit delivery link verified after restart"
  })

"completed" = result.mission.status
IO.puts("EXPLICIT_LINK_CLOSED_AFTER_RESTART")
