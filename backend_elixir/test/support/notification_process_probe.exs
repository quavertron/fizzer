# Separate BEAM, parent's disposable test DB only; no runner or model starts.
[encoded, directory, participant, mission_id, mode] = System.argv()
Application.load(:cascade_elixir)
for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(),
  do: Application.put_env(:cascade_elixir, key, value)
for app <- Application.spec(:cascade_elixir, :applications), do: Application.ensure_all_started(app)
Logger.configure(level: :warning)
for module <- [Cascade.DB.Repo, Cascade.DB.WriteCoordinator, Cascade.Realtime.OrderedPublisher] do
  {:ok, _} = module.start_link([])
end
File.write!(Path.join(directory, "ready-#{participant}"), "ready")
if mode != "crash" do
  Enum.reduce_while(1..1_000, nil, fn _, _ ->
    if File.exists?(Path.join(directory, "release")), do: {:halt, :ok}, else: (Process.sleep(10); {:cont, nil})
  end) || raise "notification barrier timed out"
end
sink = fn event ->
  File.write!(Path.join(directory, "delivery-#{participant}"), event.message.id)
  if mode == "crash", do: System.halt(23)
  :ok
end
:ok = Cascade.Missions.Notifications.reconcile(mission_id, sink)
