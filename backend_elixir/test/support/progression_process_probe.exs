# Separate BEAM processes share only the parent's disposable test database.
# Start persistence/ordering services, never application runners or providers.
[encoded, mission, mode] = System.argv()
Application.load(:cascade_elixir)
for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(), do: Application.put_env(:cascade_elixir, key, value)
for app <- Application.spec(:cascade_elixir, :applications), do: Application.ensure_all_started(app)
Logger.configure(level: :warning)
for module <- [Cascade.DB.Repo, Cascade.DB.WriteCoordinator, Cascade.Realtime.OrderedPublisher] do
  {:ok, _} = module.start_link([])
end
if mode == "rollback" do
  Cascade.Accounts.SQL.transaction(fn ->
    Cascade.Missions.Progression.reconcile(mission)
    System.halt(23)
  end)
else
  Cascade.Accounts.SQL.transaction(fn -> Cascade.Missions.Progression.reconcile(mission) end, mode: :immediate)
  if mode == "commit", do: System.halt(24)
end
