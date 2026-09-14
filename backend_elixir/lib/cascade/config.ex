defmodule Cascade.Config do
  @moduledoc "Runtime configuration and persisted-secret compatibility with the Node service."

  @legacy_dev_secret "cascade-dev-secret"

  def network_mode?, do: Application.fetch_env!(:cascade_elixir, :network_mode)

  def require_invite_registration?,
    do: Application.get_env(:cascade_elixir, :require_invite_registration, network_mode?())

  def jwt_secret! do
    case System.get_env("JWT_SECRET") do
      value when is_binary(value) and value != "" and value != @legacy_dev_secret ->
        value

      @legacy_dev_secret ->
        if network_mode?() do
          raise "Refusing to start in network mode with the default JWT_SECRET"
        else
          persisted_secret!("secret")
        end

      _ ->
        persisted_secret!("secret")
    end
  end

  def data_dir do
    System.get_env("CASCADE_DATA_DIR") ||
      Cascade.DB.Repo.config() |> Keyword.fetch!(:database) |> Path.dirname()
  end

  defp persisted_secret!(name) do
    directory = Path.join(System.user_home!(), ".cascade")
    path = Path.join(directory, name)
    File.mkdir_p!(directory)

    case read_nonempty(path) do
      {:ok, secret} -> secret
      :missing -> create_secret!(path)
    end
  end

  defp create_secret!(path) do
    generated = Base.encode16(:crypto.strong_rand_bytes(32), case: :lower)

    case File.open(path, [:write, :exclusive]) do
      {:ok, device} ->
        try do
          File.chmod!(path, 0o600)
          IO.binwrite(device, generated <> "\n")
        after
          File.close(device)
        end

        generated

      {:error, :eexist} ->
        case read_nonempty(path) do
          {:ok, secret} -> secret
          :missing -> raise "JWT secret file was created concurrently but is empty"
        end

      {:error, reason} ->
        raise "Could not create JWT secret: #{:file.format_error(reason)}"
    end
  end

  defp read_nonempty(path) do
    case File.read(path) do
      {:ok, contents} ->
        case String.trim(contents) do
          "" -> :missing
          secret -> {:ok, secret}
        end

      {:error, :enoent} ->
        :missing

      {:error, reason} ->
        raise "Could not read JWT secret: #{:file.format_error(reason)}"
    end
  end
end
