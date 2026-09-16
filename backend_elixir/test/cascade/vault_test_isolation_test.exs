defmodule Cascade.VaultTestIsolationTest do
  use ExUnit.Case, async: false

  test "missing fixture override never falls back to the real user's vaults" do
    previous = System.get_env("CASCADE_VAULTS_BASE_DIR")

    on_exit(fn ->
      if previous,
        do: System.put_env("CASCADE_VAULTS_BASE_DIR", previous),
        else: System.delete_env("CASCADE_VAULTS_BASE_DIR")
    end)

    expected = Application.fetch_env!(:cascade_elixir, :test_vaults_base_dir)
    assert String.starts_with?(expected, Path.join(System.tmp_dir!(), "cascade_elixir_vaults_"))
    refute expected == Cascade.Config.dotdir("vaults")
    System.delete_env("CASCADE_VAULTS_BASE_DIR")
    assert Cascade.Content.Store.vaults_base_dir() == expected
    System.put_env("CASCADE_VAULTS_BASE_DIR", "   ")
    assert Cascade.Content.Store.vaults_base_dir() == expected
  end
end
