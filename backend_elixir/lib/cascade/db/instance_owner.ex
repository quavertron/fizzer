defmodule Cascade.DB.InstanceOwner do
  @moduledoc false
  use GenServer
  alias Exqlite.Sqlite3

  # Network services use the deployment system's rolling/drain coordination.
  # This lease prevents accidental duplicate desktop/dev services only.
  def children, do: if(Cascade.Config.network_mode?(), do: [], else: [__MODULE__])

  # A separate SQLite file holds an OS-backed exclusive lease for the lifetime
  # of this backend. It never locks the application database; process exit also
  # releases the lease after a crash, without stale PID-file lock recovery.
  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @impl true
  def init(options) do
    Process.flag(:trap_exit, true)
    database = Keyword.get_lazy(options, :database, fn -> Cascade.DB.Repo.config()[:database] end) |> Path.expand()
    File.mkdir_p!(Path.dirname(database))
    {:ok, lease} = Sqlite3.open(database <> ".owner.sqlite")
    :ok = Sqlite3.execute(lease, "PRAGMA busy_timeout=0")
    case Sqlite3.execute(lease, "BEGIN EXCLUSIVE") do
      :ok ->
        state = %{lease: lease, database: database, discovery: nil}
        {:ok, if(Application.fetch_env!(:cascade_elixir, :server), do: publish(state), else: state)}
      {:error, reason} ->
        Sqlite3.close(lease)
        {:stop, "Another backend owns #{database}: #{inspect(reason)}"}
    end
  end

  defp publish(state) do
    port = Application.fetch_env!(:cascade_elixir, :port)
    record = Jason.encode!(%{origin: "http://127.0.0.1:#{port}", pid: String.to_integer(System.pid()), database: state.database})
    destination = Path.join(Path.dirname(state.database), "local-backend.json")
    temporary = destination <> ".#{System.pid()}.tmp"
    File.write!(temporary, record)
    File.chmod!(temporary, 0o600)
    File.rename!(temporary, destination)
    %{state | discovery: {destination, record}}
  end

  @impl true
  def terminate(_reason, state) do
    case state.discovery do
      {destination, record} ->
        if File.read(destination) == {:ok, record}, do: File.rm(destination)
      nil -> :ok
    end
    Sqlite3.close(state.lease)
  end
end
