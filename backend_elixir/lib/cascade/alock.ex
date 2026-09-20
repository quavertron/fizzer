defmodule Cascade.Alock do
  @moduledoc "Owns persistent native HTTP daemons; authorization stays at the Fizzer HTTP boundary."
  use GenServer

  def start_link(_), do: GenServer.start_link(__MODULE__, %{}, name: __MODULE__)

  def forward(vault, user_id, operation, body) do
    with {:ok, endpoint} <-
           GenServer.call(__MODULE__, {:endpoint, vault.id, vault.root_path}, 15_000) do
      headers = [
        {~c"authorization", String.to_charlist(endpoint.authorization)},
        {~c"x-alock-namespace", String.to_charlist("#{vault.id}:#{user_id}")}
      ]

      case :httpc.request(
             :post,
             {String.to_charlist(endpoint.url <> "/" <> operation), headers,
              ~c"application/vnd.dtob", body},
             [timeout: 25_000, connect_timeout: 3_000, autoredirect: false],
             body_format: :binary
           ) do
        {:ok, {{_, status, _}, _, response}} -> {:ok, status, response}
        {:error, reason} -> {:error, reason}
      end
    end
  end

  @impl true
  def init(state), do: {:ok, state}

  @impl true
  def handle_call({:endpoint, id, root}, _from, state) do
    case state[id] do
      %{root: ^root} = endpoint ->
        {:reply, {:ok, endpoint}, state}

      nil ->
        case launch(root) do
          {:ok, endpoint} -> {:reply, {:ok, endpoint}, Map.put(state, id, endpoint)}
          error -> {:reply, error, state}
        end

      _ ->
        {:reply, {:error, :vault_root_changed}, state}
    end
  end

  @impl true
  def handle_info({port, {:exit_status, _}}, state) do
    {dead, live} = Enum.split_with(state, fn {_, endpoint} -> endpoint.port == port end)
    Enum.each(dead, fn {_, endpoint} -> File.rm_rf(endpoint.directory) end)
    {:noreply, Map.new(live)}
  end

  def handle_info(_, state), do: {:noreply, state}

  @impl true
  def terminate(_, state) do
    Enum.each(state, fn {_, endpoint} ->
      if Port.info(endpoint.port), do: Port.close(endpoint.port)
      File.rm_rf(endpoint.directory)
    end)
  end

  defp launch(root) do
    binary =
      System.get_env("FIZZER_ALOCK_BIN") || System.find_executable("alock") ||
        "/usr/local/libexec/fizzer/alock"

    directory =
      Path.join(
        System.tmp_dir!(),
        "fizzer-alock-" <> Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)
      )

    header = Path.join(directory, "authorization")
    authorization = "Bearer " <> Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    with :ok <- File.mkdir(directory),
         :ok <- File.chmod(directory, 0o700),
         :ok <- File.write(header, "Authorization: " <> authorization <> "\n", [:exclusive]),
         :ok <- File.chmod(header, 0o600) do
      try do
        port =
          Port.open({:spawn_executable, binary}, [
            :binary,
            :exit_status,
            {:line, 8192},
            args: [
              "account",
              "http-serve",
              "--root",
              root,
              "--listen",
              "127.0.0.1:0",
              "--header-file",
              header,
              "--control-stdin"
            ]
          ])

        receive do
          {^port, {:data, {:eol, line}}} ->
            case Jason.decode(line) do
              {:ok, %{"ready" => true, "address" => address}} ->
                {:ok,
                 %{
                   root: root,
                   port: port,
                   directory: directory,
                   authorization: authorization,
                   url: "http://" <> address
                 }}

              _ ->
                Port.close(port)
                File.rm_rf(directory)
                {:error, :invalid_daemon_startup}
            end

          {^port, {:exit_status, _}} ->
            File.rm_rf(directory)
            {:error, :daemon_exited}
        after
          10_000 ->
            Port.close(port)
            File.rm_rf(directory)
            {:error, :daemon_start_timeout}
        end
      rescue
        _ ->
          File.rm_rf(directory)
          {:error, :daemon_unavailable}
      end
    else
      error ->
        File.rm_rf(directory)
        error
    end
  end
end
