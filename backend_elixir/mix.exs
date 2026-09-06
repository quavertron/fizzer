defmodule CascadeElixir.MixProject do
  use Mix.Project

  def project do
    [
      app: :cascade_elixir,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases()
    ]
  end

  def application do
    [
      mod: {Cascade.Application, []},
      extra_applications: [:crypto, :logger]
    ]
  end

  def cli do
    [preferred_envs: [check: :test]]
  end

  defp deps do
    [
      {:bandit, "~> 1.7"},
      {:bcrypt_elixir, "~> 3.3"},
      {:ecto_sqlite3, "~> 0.17"},
      {:html_sanitize_ex, "~> 1.5.4"},
      {:jason, "~> 1.4"},
      {:joken, "~> 2.6"},
      {:mdex, "~> 0.13.5"},
      {:plug, "~> 1.16"}
    ]
  end

  defp aliases do
    [
      check: ["test"]
    ]
  end
end
