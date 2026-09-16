# Real process death/restart against only the parent's disposable test DB.
# No application startup, runner, transport delivery or model executable.
[encoded, mission, mode] = System.argv()
Application.load(:cascade_elixir)
for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(),
  do: Application.put_env(:cascade_elixir, key, value)
for app <- Application.spec(:cascade_elixir, :applications), do: Application.ensure_all_started(app)
Logger.configure(level: :warning)
for module <- [Cascade.DB.Repo, Cascade.DB.WriteCoordinator, Cascade.Realtime.Hub, Cascade.Realtime.OrderedPublisher],
  do: ({:ok, _} = module.start_link([]))
reconcile = fn ->
  Cascade.Missions.Scheduler.schedule(mission)
  Cascade.Chat.Continuations.reconcile()
end
if mode == "rollback" do
  Cascade.Realtime.OrderedPublisher.mutate(fn ->
    Cascade.Accounts.SQL.transaction(fn ->
      reconcile.()
      System.halt(23)
    end)
  end)
else
  reconcile.()
  if mode == "commit", do: System.halt(24)
end
