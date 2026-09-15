# Isolated BEAM participant: uses the parent's disposable test database only.
[encoded, directory, participant, dispatch_id, owner_id] = System.argv()
Application.load(:cascade_elixir)
for {key, value} <- encoded |> Base.decode64!() |> :erlang.binary_to_term(),
  do: Application.put_env(:cascade_elixir, key, value)
for app <- Application.spec(:cascade_elixir, :applications), do: Application.ensure_all_started(app)
Logger.configure(level: :warning)

for module <- [Cascade.DB.Repo, Cascade.DB.WriteCoordinator,
                Cascade.Realtime.OrderedPublisher, Cascade.Runs.Supervisor,
                Cascade.Realtime.VerifiedTokenCache, Cascade.Realtime.AuthBatcher] do
  {:ok, _} = module.start_link([])
end
{:ok, _} = Cascade.Realtime.Supervisor.start_link(runner_callbacks: Cascade.Runs.TransportCallbacks)
alias Cascade.Realtime.{Session, Protocol.EngineIO, Protocol.SocketIO}
owner_id = String.to_integer(owner_id)
[username] = Cascade.Accounts.SQL.one("SELECT username FROM users WHERE id=?", [owner_id])
sid = "process-probe-#{participant}"
{:ok, ^sid, pid} = Cascade.Realtime.start_session(sid: sid, domain: Cascade.Realtime.DomainAdapter)
{:ok, _} = Session.poll(sid, 1_000)
token = Cascade.Auth.Token.sign_user(%{id: owner_id, username: username, auth_version: 0})
packet = %{type: :connect, namespace: "/runners", data: %{"token" => token}}
send_packet = fn packet ->
  :ok = Session.receive_payload(sid, EngineIO.encode_payload([%{type: :message, data: SocketIO.encode(packet)}]))
end
send_packet.(packet)
{:ok, _} = Session.poll(sid, 1_000)
send_packet.(SocketIO.event("/runners", "runner:register", [%{"activeRunIds" => [], "runnerInstanceId" => sid}]))
{:ok, _} = Session.poll(sid, 1_000)

publisher = Process.whereis(Cascade.Realtime.OrderedPublisher)
:sys.suspend(publisher)
task = Task.async(fn -> CascadeWeb.OrchestrationController.execute_dispatch(dispatch_id) end)
wait = fn predicate ->
  Enum.reduce_while(1..1_000, nil, fn _, _ ->
    if predicate.(), do: {:halt, :ok}, else: (Process.sleep(10); {:cont, nil})
  end) || raise "probe barrier timed out"
end
wait.(fn ->
  {:messages, messages} = Process.info(publisher, :messages)
  Enum.any?(messages, fn
    {:"$gen_call", _, {:mutate, fun}} ->
      {:name, name} = :erlang.fun_info(fun, :name)
      String.contains?(Atom.to_string(name), "start_dispatch")
    _ -> false
  end)
end)
File.write!(Path.join(directory, "ready-#{participant}"), "ready")
wait.(fn -> File.exists?(Path.join(directory, "release")) end)
:sys.resume(publisher)
result = Task.await(task, 10_000)
packets = :sys.get_state(pid).queue |> :queue.to_list()
delegations = Enum.count(packets, &String.contains?(&1, "run:delegate"))
File.write!(Path.join(directory, "result-#{participant}.json"),
  Jason.encode!(%{result: inspect(result), delegations: delegations}))
