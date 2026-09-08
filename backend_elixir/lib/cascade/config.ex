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

  @doc """
  Resolve a path under the Fizzer home dir, preferring `~/.fizzer` but falling
  back to the legacy `~/.cascade` when the specific target only exists there.
  With no `sub`, returns the base directory (preferring whichever exists).
  """
  def dotdir(sub \\ nil) do
    home = System.user_home!()
    primary = if sub, do: Path.join([home, ".fizzer", sub]), else: Path.join(home, ".fizzer")
    legacy = if sub, do: Path.join([home, ".cascade", sub]), else: Path.join(home, ".cascade")

    cond do
      File.exists?(primary) -> primary
      File.exists?(legacy) -> legacy
      true -> primary
    end
  end

  defp persisted_secret!(name) do
    path = dotdir(name)
    File.mkdir_p!(Path.dirname(path))

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
