import Config

test_db = Path.join(System.tmp_dir!(), "cascade_elixir_#{System.pid()}.sqlite3")
Enum.each([test_db, test_db <> "-shm", test_db <> "-wal"], &File.rm/1)

config :cascade_elixir,
  server: false,
  dispatch_worker_enabled: true,
  network_mode: false,
  qmd_worker_enabled: false,
  client_dist_dir: Path.join(System.tmp_dir!(), "cascade_elixir_no_static")

config :cascade_elixir, Cascade.DB.Repo,
  database: test_db,
  pool_size: 1,
  journal_mode: :wal,
  busy_timeout: 5_000,
  foreign_keys: :on,
  synchronous: :normal

config :logger, level: :warning
