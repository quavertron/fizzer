import Config

parse_bool = fn
  nil, default -> default
  value, _default -> String.downcase(String.trim(value)) in ["1", "true", "yes", "on"]
end

parse_integer = fn name, default, range ->
  value = System.get_env(name)

  case value && Integer.parse(value) do
    nil ->
      default

    {parsed, ""} ->
      if parsed in range do
        parsed
      else
        raise "#{name} must be an integer in #{inspect(range)}"
      end

    _ ->
      raise "#{name} must be an integer in #{inspect(range)}"
  end
end

parse_ip = fn raw ->
  case raw |> String.to_charlist() |> :inet.parse_address() do
    {:ok, address} -> address
    {:error, _reason} -> raise "CASCADE_BIND_IP must be a numeric IPv4 or IPv6 address"
  end
end

if config_env() != :test do
  network_mode = parse_bool.(System.get_env("CASCADE_NETWORK_MODE"), false)

  require_invite_registration =
    parse_bool.(System.get_env("CASCADE_REQUIRE_INVITE_REGISTRATION"), network_mode)

  repo_root = System.get_env("CASCADE_REPO_ROOT") || Path.expand("../..", __DIR__)
  data_dir = System.get_env("CASCADE_DATA_DIR") || repo_root
  admission_file = Path.join(data_dir, "execution-admission.json")
  admission = case File.read(admission_file) do
    {:ok, bytes} ->
      case Jason.decode!(bytes) do
        %{"version" => 1, "owners" => owners} = value when is_list(owners) ->
          valid_id = fn id -> is_binary(id) and byte_size(id) in 1..160 end
          valid = Enum.all?(owners, fn o ->
            is_map(o) and is_integer(o["ownerId"]) and o["ownerId"] > 0 and
              o["maxConcurrent"] in [1, 2, "unlimited"] and is_list(o["tasks"]) and is_list(o["retainedRuns"]) and
              (is_nil(o["futureOwnerMessageAfterSeq"]) or (is_integer(o["futureOwnerMessageAfterSeq"]) and o["futureOwnerMessageAfterSeq"] >= 0)) and
              (is_nil(o["qualificationBudget"]) or (is_map(o["qualificationBudget"]) and
                is_integer(o["qualificationBudget"]["afterRunId"]) and o["qualificationBudget"]["afterRunId"] >= 0 and
                o["qualificationBudget"]["maxStarts"] in 1..16)) and
              is_list(o["workflows"] || []) and Enum.all?(o["workflows"] || [], fn w ->
                is_map(w) and Enum.all?(~w(missionId vaultId channelId rootMessageId), &valid_id.(w[&1]))
              end) and
              Enum.all?(o["tasks"], fn t ->
                is_map(t) and t["ownerId"] == o["ownerId"] and is_integer(t["attempt"]) and t["attempt"] >= 0 and
                  Enum.all?(~w(taskId missionId workItemId registrationId vaultId channelId identityId), &valid_id.(t[&1])) and
                  Map.has_key?(t, "dispatchId") and (is_nil(t["dispatchId"]) or valid_id.(t["dispatchId"]))
              end) and Enum.all?(o["retainedRuns"], fn r ->
                is_map(r) and is_integer(r["runId"]) and r["runId"] > 0 and valid_id.(r["vaultId"]) and
                  Map.has_key?(r, "dispatchId") and (is_nil(r["dispatchId"]) or valid_id.(r["dispatchId"]))
              end)
          end)
          if not valid or length(Enum.uniq_by(owners, & &1["ownerId"])) != length(owners),
            do: raise("Invalid execution admission bindings")
          value
        _ -> raise "Invalid execution admission policy"
      end
    {:error, :enoent} -> nil
    {:error, _} -> raise "Cannot read execution admission policy"
  end
  config :cascade_elixir, :execution_admission, admission
  server = parse_bool.(System.get_env("CASCADE_SERVER"), true)

  config :cascade_elixir,
    server: server,
    dispatch_worker_enabled: server,
    bind_ip: parse_ip.(System.get_env("CASCADE_BIND_IP") || "127.0.0.1"),
    port: parse_integer.("API_PORT", 3000, 1..65_535),
    http_acceptors:
      parse_integer.("CASCADE_HTTP_ACCEPTORS", max(System.schedulers_online(), 4), 1..1_024),
    http_max_connections:
      parse_integer.("CASCADE_HTTP_MAX_CONNECTIONS", 16_384, 1_024..1_000_000),
    http_backlog: parse_integer.("CASCADE_HTTP_BACKLOG", 65_535, 1_024..1_000_000),
    realtime_hibernate_after_ms:
      parse_integer.("CASCADE_REALTIME_HIBERNATE_AFTER_MS", 5_000, 1_000..60_000),
    runner_orphan_reclaim_ms:
      parse_integer.("CASCADE_RUNNER_ORPHAN_RECLAIM_MS", 120_000, 120_000..3_600_000),
    trust_proxy_hops: parse_integer.("CASCADE_TRUST_PROXY_HOPS", 0, 0..5),
    client_dist_dir:
      Path.expand(
        System.get_env("CASCADE_CLIENT_DIST_DIR") || Path.join(repo_root, "client/dist")
      ),
    beta_client_dist_dir:
      (case System.get_env("CASCADE_BETA_CLIENT_DIST_DIR") do
         nil -> nil
         "" -> nil
         path -> Path.expand(path)
       end),
    qmd_worker_enabled: parse_bool.(System.get_env("CASCADE_QMD_WORKER_ENABLED"), true),
    network_mode: network_mode,
    require_invite_registration: require_invite_registration,
    allowed_origins:
      (System.get_env("CASCADE_ALLOWED_ORIGINS") || "")
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

  config :cascade_elixir, Cascade.DB.Repo,
    database: Path.expand(System.get_env("DOCS_DB_PATH") || Path.join(data_dir, "docs.db")),
    pool_size: parse_integer.("CASCADE_SQLITE_POOL_SIZE", 20, 1..64),
    busy_timeout: parse_integer.("CASCADE_SQLITE_BUSY_TIMEOUT_MS", 5_000, 100..120_000)
end
