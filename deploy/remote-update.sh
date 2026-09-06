#!/usr/bin/env bash
# Production update with an offline Elixir/data preflight, a zero-503 rolling
# handoff for state-identical releases, and a gated snapshot rollback fallback
# for releases that intentionally migrate persistent state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/deploy/deploy-lock.sh"
acquire_cascade_deploy_lock "$ROOT"
cd "$ROOT"

# systemd/root deploys can hit "dubious ownership" on this checkout.
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

COMPOSE_ARGS=(-f docker-compose.yml)
HEALTH_URL="http://127.0.0.1:3000/api/health"
CONTAINER_NAME="cascade"
DATA_DIR="/var/lib/cascade"
LIVE_DB="$DATA_DIR/docs.db"
MAINTENANCE_MARKER="/run/cascade-maintenance"
REVISION="$(git rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]] || \
   [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Error: production cutover requires a clean tracked checkout at one full Git revision." >&2
  exit 1
fi
REVISION_SHORT="${REVISION:0:12}"
ROLLING_CONTAINER="cascade-rolling-$REVISION_SHORT"
CERTIFIED_RELEASE_DIR="/var/lib/cascade-release"
CERTIFIED_IMAGE_DIR="$CERTIFIED_RELEASE_DIR/certified-images"
CERTIFIED_MANIFEST="$CERTIFIED_IMAGE_DIR/$REVISION.json"
CERTIFIED_IMAGE_ID=""
CANDIDATE_IMAGE=""
ROLLBACK_IMAGE="cascade:rollback-$REVISION"
PREFLIGHT_DIR=""
PREFLIGHT_CONTAINER="cascade-preflight-$REVISION"
PREFLIGHT_PORT=""
SNAPSHOT_DIR=""
SNAPSHOT_DB=""
CUTOVER_STARTED=0
DEPLOY_COMMITTED=0
ROLLBACK_IN_PROGRESS=0
OLD_BACKEND_STOPPED=0
CANDIDATE_DATA_TOUCHED=0
DEPLOY_DOMAIN=""
ROLLING_SAFE=0
ROLLING_STARTED=0
ROLLING_OLD_STOPPED=0
ROLLING_OLD_REMOVED=0
ROLLING_FINAL_STARTED=0
ROLLING_ROLLBACK_IN_PROGRESS=0
ROLLING_PORT=39001
NGINX_CONFIG_CHANGED=0

close_maintenance_gate() {
  # Replace, rather than follow, any unexpected object at the marker path.
  rm -f -- "$MAINTENANCE_MARKER"
  install -m 0644 -o 0 -g 0 /dev/null "$MAINTENANCE_MARKER"
  if [[ -L "$MAINTENANCE_MARKER" || ! -f "$MAINTENANCE_MARKER" ]] ||
     [[ "$(stat -c '%u:%g:%a' "$MAINTENANCE_MARKER")" != "0:0:644" ]]; then
    echo "Error: could not establish the root-owned maintenance gate." >&2
    return 1
  fi
}

open_maintenance_gate() {
  if ! rm -f -- "$MAINTENANCE_MARKER" || [[ -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ]]; then
    echo "CRITICAL: maintenance marker could not be removed; traffic remains gated." >&2
    return 1
  fi
}

load_release_candidate() {
  echo "==> Verifying staged release image for $REVISION"
  CANDIDATE_IMAGE="cascade:certified-$REVISION"

  local loaded_revision
  CERTIFIED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")"
  loaded_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$CANDIDATE_IMAGE")"
  if [[ ! "$CERTIFIED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ || "$loaded_revision" != "$REVISION" ]]; then
    echo "Error: staged release image has an invalid identity or revision label." >&2
    return 1
  fi

  # Capacity evidence is optional for routine releases. When it is staged for
  # a capacity-sensitive change, still bind it to the exact image being run.
  if [[ -f "$CERTIFIED_MANIFEST" || -f "$CERTIFIED_MANIFEST.sha256" ]]; then
    local release_dir certification_part certified_image_id certified_image_tag
    for release_dir in "$CERTIFIED_RELEASE_DIR" "$CERTIFIED_IMAGE_DIR"; do
      if [[ -L "$release_dir" || ! -d "$release_dir" ]] ||
         [[ "$(stat -c '%u:%g:%a' "$release_dir")" != "0:0:700" ]]; then
        echo "Error: certification directories must be canonical root-owned directories, mode 0700." >&2
        return 1
      fi
    done
    for certification_part in "$CERTIFIED_MANIFEST" "$CERTIFIED_MANIFEST.sha256"; do
      if [[ -L "$certification_part" || ! -f "$certification_part" ]] ||
         [[ "$(stat -c '%u:%g:%a' "$certification_part")" != "0:0:600" ]]; then
        echo "Error: certification and checksum must be regular root-owned files, mode 0600." >&2
        return 1
      fi
    done
    certified_image_id="$(node deploy/certified-image.mjs verify --manifest "$CERTIFIED_MANIFEST")"
    certified_image_tag="$(node deploy/certified-image.mjs field --manifest "$CERTIFIED_MANIFEST" --name image.tag)"
    if [[ "$certified_image_id" != "$CERTIFIED_IMAGE_ID" || "$certified_image_tag" != "$CANDIDATE_IMAGE" ]]; then
      echo "Error: staged capacity certification differs from the release image." >&2
      return 1
    fi
    echo "==> Capacity certification matches the staged image"
  fi

  local embedded_gate
  embedded_gate="$(docker run --rm --network none \
    --entrypoint /app/release/bin/cascade_elixir "$CANDIDATE_IMAGE" eval \
    'if CascadeWeb.RouteCatalog.swap_ready?(), do: IO.puts("swap-ready"), else: System.halt(42)')"
  if [[ "$embedded_gate" != *"swap-ready"* ]]; then
    echo "Error: release image does not contain an approved cutover gate." >&2
    return 1
  fi
  echo "==> Release candidate is $CERTIFIED_IMAGE_ID"
}

verify_runtime_shape_json() {
  local label="${1:?runtime-shape label is required}"
  CASCADE_SHAPE_LABEL="$label" node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    const compose = parsed?.services?.cascade;
    const host = Array.isArray(parsed) ? parsed[0]?.HostConfig : null;
    const nofile = compose
      ? compose.ulimits?.nofile
      : host?.Ulimits?.find((entry) => entry.Name === "nofile");
    const actual = compose ? {
      cpus: Number(compose.cpus),
      cpuset: compose.cpuset,
      memory: Number(compose.mem_limit),
      memorySwap: Number(compose.memswap_limit),
      pids: Number(compose.pids_limit),
      nofileSoft: Number(nofile?.soft),
      nofileHard: Number(nofile?.hard),
    } : {
      cpus: Number(host?.NanoCpus) / 1_000_000_000,
      cpuset: host?.CpusetCpus,
      memory: Number(host?.Memory),
      memorySwap: Number(host?.MemorySwap),
      pids: Number(host?.PidsLimit),
      nofileSoft: Number(nofile?.Soft),
      nofileHard: Number(nofile?.Hard),
    };
    const expected = {
      cpus: 2,
      cpuset: "0-1",
      memory: 3 * 1024 ** 3,
      memorySwap: 3 * 1024 ** 3,
      pids: 100_000,
      nofileSoft: 200_000,
      nofileHard: 200_000,
    };
    const mismatches = Object.keys(expected)
      .filter((key) => actual[key] !== expected[key])
      .map((key) => `${key}=${actual[key] ?? "missing"} expected=${expected[key]}`);
    if (mismatches.length) {
      console.error(`Error: ${process.env.CASCADE_SHAPE_LABEL} differs from the certified runtime envelope: ${mismatches.join(", ")}`);
      process.exit(1);
    }
  '
  echo "==> $label matches the certified 2 CPU / 3 GiB runtime envelope"
}

verify_compose_runtime_shape() {
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" config --format json \
    | verify_runtime_shape_json "Compose candidate configuration"
}

verify_container_runtime_shape() {
  local container="${1:?container is required}"
  local label="${2:?runtime-shape label is required}"
  docker inspect "$container" | verify_runtime_shape_json "$label"
}

secure_production_environment() {
  local environment_file="$ROOT/.env"
  if [[ "$EUID" -ne 0 || -L "$environment_file" || ! -f "$environment_file" ]]; then
    echo "Error: production requires a regular root-managed .env file." >&2
    return 1
  fi
  chown 0:0 "$environment_file"
  chmod 0600 "$environment_file"
  if [[ "$(stat -c '%u:%g:%a' "$environment_file")" != "0:0:600" ]]; then
    echo "Error: production .env must be root-owned and mode 0600." >&2
    return 1
  fi
  echo "==> Production environment file permissions are secure"
}

wait_for_url() {
  local url="${1:?health URL is required}"
  local max_attempts="${2:-90}"
  local label="${3:-app}"

  echo "==> Waiting for $label"
  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if [[ "$code" == "200" ]]; then
      echo "    $label is up."
      return 0
    fi
    if [[ "$i" -eq "$max_attempts" ]]; then
      echo "Error: $label did not become ready (last HTTP status: ${code})." >&2
      return 1
    fi
    sleep 2
  done
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]
}

check_engine_io() {
  local origin="${1:?origin is required}"
  local open_packet legacy_code

  open_packet=$(curl -fsS --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=4&transport=polling&t=$RANDOM")
  if [[ "$open_packet" != 0* ]]; then
    echo "Error: Engine.IO v4 did not return an OPEN packet." >&2
    return 1
  fi

  legacy_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=3&transport=polling&t=$RANDOM" || true)
  if [[ "$legacy_code" != "400" ]]; then
    echo "Error: Engine.IO v3 must fail closed with HTTP 400 (got $legacy_code)." >&2
    return 1
  fi
  echo "==> Engine.IO v4 accepted and v3 rejected"
}

verify_maintenance_gate() {
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    echo "Error: deployment domain is unavailable for maintenance-gate verification." >&2
    return 1
  fi

  # A graceful nginx reload can leave the retiring worker generation alive for
  # a moment. Prove that fresh connections consistently reach the gated
  # generation before stopping the old backend.
  local code="000" consecutive=0
  for _attempt in $(seq 1 20); do
    code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health" || true)
    if [[ "$code" == "503" ]]; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 3 ]]; then
        echo "==> Nginx maintenance gate verified"
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Error: nginx maintenance gate did not stabilize at HTTP 503 (last status: ${code:-000})." >&2
  return 1
}

configure_nginx_upstreams() {
  local primary_port="${1:?primary upstream port is required}"
  local backup_port="${2:-}"
  local domain="${CASCADE_DEPLOY_DOMAIN:-}"
  local site="/etc/nginx/sites-available/cscd"
  if [[ "$EUID" -ne 0 || ! -f "$site" ]]; then
    echo "Error: a root-managed $site is required for a verified cutover." >&2
    return 1
  fi
  if [[ ! "$primary_port" =~ ^[0-9]+$ ]] || (( primary_port < 1 || primary_port > 65535 )); then
    echo "Error: invalid primary nginx upstream port '$primary_port'." >&2
    return 1
  fi
  if [[ -n "$backup_port" ]] && {
    [[ ! "$backup_port" =~ ^[0-9]+$ ]] ||
      (( backup_port < 1 || backup_port > 65535 )) ||
      [[ "$backup_port" == "$primary_port" ]];
  }; then
    echo "Error: invalid backup nginx upstream port '$backup_port'." >&2
    return 1
  fi
  if [[ -z "$domain" && -f "$ROOT/.env" ]]; then
    local configured_url
    configured_url="$(sed -nE 's/^[[:space:]]*CASCADE_PUBLIC_URL=//p' "$ROOT/.env" | tail -1)"
    configured_url="${configured_url#\"}"
    configured_url="${configured_url%\"}"
    configured_url="${configured_url#\'}"
    configured_url="${configured_url%\'}"
    domain="${configured_url#*://}"
    domain="${domain%%/*}"
  fi
  if [[ -z "$domain" ]]; then
    domain="$(awk '$1 == "server_name" { for (i=2; i<=NF; i++) { gsub(/;/, "", $i); if ($i !~ /^www\./ && $i != "_") { print $i; exit } } }' "$site")"
  fi
  if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
    echo "Error: invalid CASCADE_DEPLOY_DOMAIN '$domain'" >&2
    return 1
  fi
  DEPLOY_DOMAIN="$domain"

  local rendered backup backup_server=""
  rendered="$(mktemp)"
  backup="$(mktemp)"
  cp "$site" "$backup"
  if [[ -n "$backup_port" ]]; then
    backup_server="server 127.0.0.1:$backup_port backup max_fails=1 fail_timeout=2s;"
  fi
  sed \
    -e "s/DOMAIN/$domain/g" \
    -e "s/CASCADE_PRIMARY_PORT/$primary_port/g" \
    -e "s|CASCADE_BACKUP_SERVER|$backup_server|g" \
    deploy/nginx.conf.template > "$rendered"
  if ! grep -q "www\.$domain" "$site"; then
    sed -i "s/ www\.$domain//g" "$rendered"
  fi
  local site_changed=0
  if ! cmp -s "$rendered" "$site"; then
    site_changed=1
    install -m 0644 "$rendered" "$site"
    if ! nginx -t; then
      install -m 0644 "$backup" "$site"
      nginx -t
      find "$rendered" "$backup" -maxdepth 0 -type f -delete
      echo "Error: restored previous nginx site after validation failed" >&2
      return 1
    fi
    if ! systemctl reload nginx; then
      install -m 0644 "$backup" "$site"
      nginx -t
      systemctl reload nginx
      find "$rendered" "$backup" -maxdepth 0 -type f -delete
      echo "Error: restored previous nginx site after reload failed" >&2
      return 1
    fi
  fi
  local active_config
  active_config="$(nginx -T 2>&1)"
  if [[ "$active_config" != *'if (-f /run/cascade-maintenance)'* ||
        "$active_config" != *'upstream cascade_app {'* ||
        "$active_config" != *"server 127.0.0.1:$primary_port"* ||
        ( -n "$backup_port" && "$active_config" != *"server 127.0.0.1:$backup_port backup"* ) ]]; then
    if [[ "$site_changed" == "1" ]]; then
      install -m 0644 "$backup" "$site"
      nginx -t
      systemctl reload nginx
    fi
    find "$rendered" "$backup" -maxdepth 0 -type f -delete
    echo "Error: active nginx configuration does not contain the requested cutover upstreams." >&2
    return 1
  fi
  if [[ "$site_changed" == "1" ]]; then
    NGINX_CONFIG_CHANGED=1
  fi
  find "$rendered" "$backup" -maxdepth 0 -type f -delete
  echo "==> Nginx upstream active on $primary_port${backup_port:+ with failover to $backup_port}"
}

sync_nginx_security() {
  configure_nginx_upstreams \
    "${1:?active upstream port is required}" "${2:-}"
  echo "==> Nginx security and cutover controls are active"
}

settle_reloaded_nginx() {
  if [[ "$NGINX_CONFIG_CHANGED" != "1" ]]; then
    return 0
  fi
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    echo "Error: deployment domain is unavailable for nginx generation settling." >&2
    return 1
  fi

  # The first release that installs the stable primary/backup upstream leaves
  # a graceful worker generation carrying the previous single-upstream config.
  # Keep the old backend alive beyond nginx's default 75-second HTTP keepalive
  # window so those connections drain before either backend is stopped. Future
  # releases do not rewrite this fixed upstream pair and skip this wait.
  echo "==> Nginx configuration changed; draining the previous HTTP worker generation"
  local code="000"
  for _attempt in $(seq 1 80); do
    code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 3 --max-time 10 --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
      "https://$DEPLOY_DOMAIN/api/health" || true)
    if [[ "$code" != "200" ]]; then
      echo "Error: production health changed while nginx workers drained (HTTP ${code:-000})." >&2
      return 1
    fi
    sleep 1
  done
  echo "==> Previous nginx HTTP worker generation drained"
}

cleanup_preflight() {
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$PREFLIGHT_DIR" && "$PREFLIGHT_DIR" == "$DATA_DIR"/.deploy-preflight.* && -d "$PREFLIGHT_DIR" ]]; then
    find "$PREFLIGHT_DIR" -depth -delete 2>/dev/null || true
  fi
}

cleanup_preflight_clones() {
  # Keep schema fingerprints: rolling candidates still compare against them.
  local directory="${PREFLIGHT_DIR:?preflight directory is required}"
  rm -rf -- "$directory"/before.db* "$directory"/after.db* \
    "$directory/before-data" "$directory/after-data" "$directory/sqlite-scratch"
}

prune_cutover_snapshots() {
  [[ -d /var/backups/cascade ]] || return 0
  # The shared deploy lock excludes cutover/restore work. Also fail closed if
  # another container explicitly mounts a recovery snapshot for investigation.
  local containers mounts
  containers="$(docker ps -q)"
  [[ -n "$containers" ]] || return 1
  mounts="$(docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' $containers)"
  if printf '%s\n' "$mounts" | grep -Eq '^(/|/var|/var/backups|/var/backups/cascade(/.*)?)$'; then
    echo "Error: recovery snapshots are mounted by a running container; refusing retention cleanup." >&2
    return 1
  fi
  python3 "$ROOT/deploy/prune-cutover-snapshots.py" /var/backups/cascade \
    --apply --protect "$SNAPSHOT_DIR"
}

restore_database_snapshot() {
  if [[ -z "$SNAPSHOT_DB" || ! -f "$SNAPSHOT_DB" ]]; then
    echo "Error: no cutover database snapshot is available for rollback." >&2
    return 1
  fi

  "$ROOT/deploy/restore-sqlite-snapshot.sh" "$SNAPSHOT_DIR" "$LIVE_DB" "$REVISION"
}

rollback_cutover() {
  if [[ "$ROLLBACK_IN_PROGRESS" == "1" ]]; then
    return 1
  fi
  ROLLBACK_IN_PROGRESS=1
  set +e
  echo "==> Candidate failed; restoring the pre-cutover service" >&2
  if ! close_maintenance_gate; then
    echo "CRITICAL: rollback cannot prove traffic is gated; refusing to mutate production data." >&2
    return 1
  fi
  local backend_running
  backend_running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)"
  if [[ "$OLD_BACKEND_STOPPED" == "1" || "$backend_running" != "true" ]]; then
    if [[ "$backend_running" == "true" ]]; then
      CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" stop -t 30 cascade || true
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" == "true" ]]; then
      echo "CRITICAL: candidate is still running; refusing an unsafe database restore" >&2
      return 1
    fi
    if [[ "$CANDIDATE_DATA_TOUCHED" == "1" ]]; then
      if ! restore_database_snapshot; then
        echo "CRITICAL: database restore failed; refusing to boot the old image" >&2
        return 1
      fi
    fi
    if ! CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
      up -d --no-build --force-recreate; then
      echo "CRITICAL: rollback image failed to start" >&2
      return 1
    fi
  fi
  if wait_for_url "$HEALTH_URL" 60 "rollback" && systemctl is-active --quiet nginx; then
    if open_maintenance_gate; then
      echo "==> Rollback is healthy; external traffic restored" >&2
    fi
  else
    echo "CRITICAL: rollback did not become healthy; maintenance gate remains active" >&2
  fi
  set -e
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_preflight
  if [[ "$ROLLING_STARTED" == "1" && "$DEPLOY_COMMITTED" != "1" ]]; then
    rollback_rolling_cutover || true
  elif [[ "$CUTOVER_STARTED" == "1" && "$DEPLOY_COMMITTED" != "1" ]]; then
    rollback_cutover || true
  fi
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup_running_database() {
  local destination="${1:?destination is required}"
  local container="${2:-$CONTAINER_NAME}"
  local relative
  relative="${destination#"$DATA_DIR"/}"
  if [[ "$relative" == "$destination" || "$relative" == *".."* ]]; then
    echo "Error: backup destination must be a resolved child of $DATA_DIR" >&2
    return 1
  fi

  docker exec -e CASCADE_BACKUP_PATH="/data/$relative" "$container" \
    node --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/data/docs.db", { fileMustExist: true });
      try { await db.backup(process.env.CASCADE_BACKUP_PATH); } finally { db.close(); }
    '
}

checkpoint_preflight_clone() {
  # A short-lived release VM may leave its final writes in WAL. The identity
  # checker deliberately reads an immutable main-file copy, so checkpoint each
  # complete boot mode after it has stopped.
  docker run --rm --network none --user 1000:1000 --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/preflight/after.db", { fileMustExist: true });
      try {
        const result = db.pragma("wal_checkpoint(TRUNCATE)");
        if (result.some((row) => Number(row.busy) !== 0)) throw new Error(`busy preflight WAL checkpoint: ${JSON.stringify(result)}`);
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("preflight SQLite quick_check failed");
      } finally { db.close(); }
    '
}

start_preflight_server() {
  docker run -d --name "$PREFLIGHT_CONTAINER" --env-file "$ROOT/.env" \
    --cpus 2 --cpuset-cpus 0-1 --memory 3g --memory-swap 3g \
    --pids-limit 100000 --ulimit nofile=200000:200000 \
    -e API_PORT=3000 \
    -e CASCADE_BIND_IP=0.0.0.0 \
    -e CASCADE_NETWORK_MODE=false \
    -e CASCADE_QMD_WORKER_ENABLED=false \
    -e CASCADE_DATA_DIR=/preflight/after-data \
    -e CASCADE_VAULTS_BASE_DIR=/preflight/after-data/vaults \
    -e CASCADE_QMD_DIR=/preflight/after-data/qmd \
    -e DOCS_DB_PATH=/preflight/after.db \
    -p 127.0.0.1::3000 \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" >/dev/null
  verify_container_runtime_shape "$PREFLIGHT_CONTAINER" "isolated candidate preflight"

  PREFLIGHT_PORT="$(docker port "$PREFLIGHT_CONTAINER" 3000/tcp | sed -n 's/.*://p' | head -1)"
  if [[ ! "$PREFLIGHT_PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: could not resolve candidate preflight port." >&2
    return 1
  fi
  wait_for_url "http://127.0.0.1:$PREFLIGHT_PORT/api/health" 60 "candidate preflight"
}

dump_sqlite_schema() {
  local source="${1:?schema source database is required}"
  local destination="${2:?schema dump path is required}"
  docker run --rm --network none --entrypoint node \
    -v "$(dirname "$source"):/schema-source:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema "/schema-source/$(basename "$source")" \
    > "$destination"
}

dump_live_schema() {
  local destination="${1:?schema dump path is required}"
  # The running production image may predate this checker. Read the live
  # database with the candidate image while sharing the WAL directory.
  if container_running "$CONTAINER_NAME"; then
    docker run --rm --network none --volumes-from "$CONTAINER_NAME" --entrypoint node \
      "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
      --dump-schema /data/docs.db > "$destination"
    return
  fi
  dump_sqlite_schema "$LIVE_DB" "$destination"
}

boot_preflight_database() {
  mkdir -p "$PREFLIGHT_DIR/after-data/vaults" "$PREFLIGHT_DIR/after-data/qmd"
  chown -R 1000:1000 "$PREFLIGHT_DIR"
  docker run --rm --network none --env-file "$ROOT/.env" \
    -e CASCADE_SERVER=false \
    -e CASCADE_QMD_WORKER_ENABLED=false \
    -e CASCADE_DATA_DIR=/preflight/after-data \
    -e CASCADE_VAULTS_BASE_DIR=/preflight/after-data/vaults \
    -e CASCADE_QMD_DIR=/preflight/after-data/qmd \
    -e DOCS_DB_PATH=/preflight/after.db \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" eval \
    'case Application.ensure_all_started(:cascade_elixir) do {:ok, _} -> :ok; other -> raise inspect(other) end'
  checkpoint_preflight_clone
}

verify_migration_clone() {
  echo "==> Candidate boot mutates schema; verifying maintenance-cutover compatibility"
  ensure_cutover_disk_capacity
  mkdir -p "$PREFLIGHT_DIR/before-data" "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"
  if container_running "$CONTAINER_NAME"; then
    backup_running_database "$PREFLIGHT_DIR/before.db"
  else
    cp --reflink=auto --sparse=always "$LIVE_DB" "$PREFLIGHT_DIR/before.db"
    chown 1000:1000 "$PREFLIGHT_DIR/before.db"
  fi
  cp --reflink=auto --sparse=always "$PREFLIGHT_DIR/before.db" "$PREFLIGHT_DIR/after.db"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/vaults" "$PREFLIGHT_DIR/before-data/vaults"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/qmd" "$PREFLIGHT_DIR/before-data/qmd"
  rm -rf "$PREFLIGHT_DIR/after-data/vaults" "$PREFLIGHT_DIR/after-data/qmd"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/vaults" "$PREFLIGHT_DIR/after-data/vaults"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/qmd" "$PREFLIGHT_DIR/after-data/qmd"
  boot_preflight_database
  docker run --rm --network none --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /preflight/before.db --after /preflight/after.db \
    --before-root /preflight/before-data --after-root /preflight/after-data
}

preflight_candidate() {
  echo "==> Running isolated schema and protocol preflight"
  PREFLIGHT_DIR="$(mktemp -d "$DATA_DIR/.deploy-preflight.XXXXXX")"
  chown 1000:1000 "$PREFLIGHT_DIR"
  mkdir -p "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"

  dump_live_schema "$PREFLIGHT_DIR/before-schema.json"
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --materialize-schema /preflight/before-schema.json \
    --materialize-dest /preflight/after.db
  chown 1000:1000 "$PREFLIGHT_DIR/after.db"

  # Classify only startup DDL. The protocol probe creates disposable rows, so
  # it must not participate in the rolling-safe decision.
  boot_preflight_database
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema /preflight/after.db > "$PREFLIGHT_DIR/after-schema.json"
  local schema_output=""
  local schema_status=0
  set +e
  schema_output="$(docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --schema-only --before-schema /preflight/before-schema.json --after-schema /preflight/after-schema.json 2>&1)"
  schema_status=$?
  set -e
  printf '%s\n' "$schema_output"
  if [[ "$schema_status" -eq 0 ]]; then
    ROLLING_SAFE=1
    echo "==> Candidate boot is schema-identical; rolling cutover is eligible"
  elif [[ "$schema_output" == *"database schema changed"* || "$schema_output" == *"migration ledger changed"* ]]; then
    verify_migration_clone
    ROLLING_SAFE=0
  else
    echo "Error: schema preflight failed before a rolling-safe decision could be made." >&2
    return 1
  fi

  start_preflight_server
  check_engine_io "http://127.0.0.1:$PREFLIGHT_PORT"
  docker run --rm --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/preflight-client.mjs "http://127.0.0.1:$PREFLIGHT_PORT"
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null
  # Compatibility and protocol checks are complete. Do not carry disposable
  # database/corpus clones into the rollback snapshot and live verification.
  cleanup_preflight_clones
  mkdir -p "$PREFLIGHT_DIR/sqlite-scratch"
  chown -R 1000:1000 "$PREFLIGHT_DIR"
}

checkpoint_and_snapshot() {
  echo "==> Checkpointing and snapshotting the quiescent production database"
  # Match the production database owner. SQLite may need to recreate WAL/SHM
  # sidecars after the old container was force-stopped at its drain deadline.
  docker run --rm --network none --user 1000:1000 --entrypoint node \
    -v "$DATA_DIR:/data" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/data/docs.db", { fileMustExist: true });
      try {
        const result = db.pragma("wal_checkpoint(TRUNCATE)");
        if (result.some((row) => Number(row.busy) !== 0)) throw new Error(`busy WAL checkpoint: ${JSON.stringify(result)}`);
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite quick_check failed");
      } finally { db.close(); }
    '

  SNAPSHOT_DIR="/var/backups/cascade/cutover-$REVISION-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$SNAPSHOT_DIR"
  local snapshot_tmp="$SNAPSHOT_DIR/.docs.db.incomplete"
  cp --reflink=auto --sparse=always --preserve=mode,ownership,timestamps "$LIVE_DB" "$snapshot_tmp"
  # A WAL-mode database opened from a read-only mount can fail before
  # `quick_check` because SQLite still needs transient SHM/WAL sidecars. Keep
  # SQL query-only while allowing those disposable files in the private,
  # root-owned snapshot directory.
  docker run --rm --network none --user 0:0 --entrypoint node \
    -v "$SNAPSHOT_DIR:/snapshot" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/snapshot/.docs.db.incomplete", { fileMustExist: true });
      try {
        db.pragma("query_only = ON");
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("snapshot quick_check failed");
        if (db.pragma("foreign_key_check").length) throw new Error("snapshot foreign_key_check failed");
      } finally { db.close(); }
    '
  rm -f -- "$snapshot_tmp-wal" "$snapshot_tmp-shm"
  mv "$snapshot_tmp" "$SNAPSHOT_DIR/docs.db"
  install -d -m 0700 "$SNAPSHOT_DIR/corpus"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/vaults" "$SNAPSHOT_DIR/corpus/vaults"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/qmd" "$SNAPSHOT_DIR/corpus/qmd"
  (cd "$SNAPSHOT_DIR" && sha256sum docs.db > docs.db.sha256)
  SNAPSHOT_DB="$SNAPSHOT_DIR/docs.db"
  git rev-parse HEAD > "$SNAPSHOT_DIR/revision.txt"
  docker inspect --format '{{.Image}}' "$CONTAINER_NAME" > "$SNAPSHOT_DIR/rollback-image.txt"
  python3 "$ROOT/deploy/prune-cutover-snapshots.py" "$SNAPSHOT_DIR" --seal
}

verify_live_database() {
  backup_running_database "$PREFLIGHT_DIR/live-after.db"
  mkdir -p "$PREFLIGHT_DIR/live-corpus"
  docker run --rm --network none --user 0:0 --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$SNAPSHOT_DIR:/snapshot:ro" \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    -v "$PREFLIGHT_DIR/live-corpus:/live-corpus" \
    -v "$DATA_DIR/.cascade/vaults:/live-corpus/vaults:ro" \
    -v "$DATA_DIR/.cascade/qmd:/live-corpus/qmd:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /snapshot/docs.db --after /preflight/live-after.db \
    --before-root /snapshot/corpus --after-root /live-corpus
}

verify_live_schema_identity() {
  local container="${1:?container is required}"
  docker exec "$container" node /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema /data/docs.db > "$PREFLIGHT_DIR/live-schema-$container.json"
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --schema-only \
    --before-schema /preflight/before-schema.json \
    --after-schema "/preflight/live-schema-$container.json"
}

verify_authenticated_live_candidate() {
  local container="${1:-$CONTAINER_NAME}"
  local origin="${2:-$HEALTH_URL}"
  origin="${origin%/api/health}"
  echo "==> Running authenticated production read/realtime smoke against $container"
  local probe_token
  # `release eval` starts a separate VM, not an RPC session in the running
  # release, so its Repo is intentionally absent. Mint the ephemeral parity
  # token from the image's pinned SQLite library and Node's HMAC; the live
  # Elixir edge still performs every authorization check below.
  probe_token="$(docker exec "$container" node --input-type=module -e '
    import crypto from "node:crypto";
    import Database from "better-sqlite3";
    const db = new Database("/data/docs.db", { readonly: true, fileMustExist: true });
    try {
      const user = db.prepare(`
        SELECT DISTINCT u.id,u.username,u.auth_version AS authVersion FROM users u
        JOIN vaults v ON v.created_by=u.id
        JOIN notes n ON n.vault_id=v.id
        WHERE n.is_archived=0
          AND (n.content LIKE ? OR n.content_preview LIKE ?)
        ORDER BY u.id ASC LIMIT 1
      `).get("cascade://chat-channel%", "cascade://chat-channel%");
      if (!user) throw new Error("production has no owner account with an accessible chat channel");
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...user, access: "user", iat: now, exp: now + 7 * 24 * 60 * 60 })}`;
      process.stdout.write(`${body}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(body).digest("base64url")}`);
    } finally { db.close(); }
  ')"
  if [[ -z "$probe_token" ]]; then
    echo "Error: could not mint the ephemeral authenticated smoke token." >&2
    return 1
  fi
  printf '%s' "$probe_token" | docker run --rm -i --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/authenticated-live-smoke.mjs "$origin"
  unset probe_token
}

verify_reopened_production_edge() {
  echo "==> Verifying the reopened production edge"
  local health_code="000" root_html="" engine_open="" consecutive=0
  # As with gate closure, nginx's graceful reload can briefly leave a retiring
  # worker generation serving the old marker state. Require three complete,
  # fresh edge probes before declaring the public cutover finished.
  for _attempt in $(seq 1 20); do
    health_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health" || true)"
    root_html="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/app.html" || true)"
    engine_open="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
      "https://$DEPLOY_DOMAIN/socket.io/?EIO=4&transport=polling&t=$RANDOM" || true)"
    if [[ "$health_code" == "200" && "$root_html" == *'<div id="root"'* && "$root_html" == *'assets/main-'* && "$engine_open" == 0* ]]; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 3 ]]; then
        echo "==> Reopened production health, client, TLS edge, and Engine.IO are verified"
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Error: reopened production edge did not stabilize (health HTTP ${health_code:-000}, client=$([[ "$root_html" == *'<div id="root"'* && "$root_html" == *'assets/main-'* ]] && echo ok || echo failed), Engine.IO=$([[ "$engine_open" == 0* ]] && echo ok || echo failed))." >&2
  return 1
}

ensure_cutover_disk_capacity() {
  if [[ ! -f "$LIVE_DB" ]]; then
    echo "Error: production database $LIVE_DB does not exist." >&2
    return 1
  fi

  local database_kb corpus_kb wal_kb available_kb required_kb snapshot_available_kb
  database_kb="$(( ($(stat -c '%s' "$LIVE_DB") + 1023) / 1024 ))"
  available_kb="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')"
  wal_kb=0
  if [[ -f "$LIVE_DB-wal" ]]; then
    wal_kb="$(( ($(stat -c '%s' "$LIVE_DB-wal") + 1023) / 1024 ))"
  fi
  corpus_kb="$(du -sk --apparent-size "$DATA_DIR/.cascade/vaults" "$DATA_DIR/.cascade/qmd" | awk '{sum += $1} END {print sum+0}')"
  # Before/after DBs plus checker copy and SQLite journal; corpus before/after
  # plus checker scratch. WAL is a conservative allowance for uncheckpointed
  # growth. No reflink/compression savings are assumed. Clones are removed
  # before cutover; the same budget covers snapshot, live check and restore.
  required_kb="$(( (database_kb + wal_kb) * 4 + corpus_kb * 3 + 1048576 ))"
  install -d -m 0700 /var/backups/cascade
  snapshot_available_kb="$(df -Pk /var/backups/cascade | awk 'NR==2 {print $4}')"
  if (( snapshot_available_kb < database_kb + wal_kb + corpus_kb + 1048576 )); then
    echo "Error: rollback snapshot filesystem lacks database/corpus headroom plus 1 GiB reserve." >&2
    return 1
  fi
  if (( available_kb < required_kb )); then
    echo "Error: cutover needs ${required_kb} KiB free for verified snapshots; only ${available_kb} KiB is available." >&2
    return 1
  fi
  echo "==> Cutover snapshot capacity available (${available_kb} KiB free; ${required_kb} KiB required)"
}

start_rolling_container() {
  if container_exists "$ROLLING_CONTAINER"; then
    if container_running "$ROLLING_CONTAINER"; then
      echo "Error: rolling candidate $ROLLING_CONTAINER is already running." >&2
      return 1
    fi
    docker rm "$ROLLING_CONTAINER" >/dev/null
  fi

  echo "==> Starting a warmed rolling candidate"
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" run \
    -d -T --no-deps --name "$ROLLING_CONTAINER" \
    -p "127.0.0.1:$ROLLING_PORT:3000" cascade >/dev/null
  docker update --restart=no "$ROLLING_CONTAINER" >/dev/null
  if [[ "$(docker port "$ROLLING_CONTAINER" 3000/tcp)" != "127.0.0.1:$ROLLING_PORT" ]]; then
    echo "Error: rolling candidate is not bound to the reserved loopback port $ROLLING_PORT." >&2
    return 1
  fi

  verify_container_runtime_shape "$ROLLING_CONTAINER" "warmed rolling candidate"
  wait_for_url "http://127.0.0.1:$ROLLING_PORT/api/health" 60 "warmed rolling candidate"
  check_engine_io "http://127.0.0.1:$ROLLING_PORT"
  verify_live_schema_identity "$ROLLING_CONTAINER"
  verify_authenticated_live_candidate "$ROLLING_CONTAINER" "http://127.0.0.1:$ROLLING_PORT"
}

rollback_rolling_cutover() {
  if [[ "$ROLLING_ROLLBACK_IN_PROGRESS" == "1" ]]; then
    return 1
  fi
  ROLLING_ROLLBACK_IN_PROGRESS=1
  set +e
  echo "==> Rolling candidate failed; restoring the previous image without rewinding live data" >&2

  # The process may have been interrupted after Docker stopped the canonical
  # container but before the next shell assignment. Trust observed container
  # state over the progress flag so that interruption cannot remove the only
  # healthy bridge and strand a stopped primary.
  if [[ "$ROLLING_OLD_STOPPED" != "1" ]] && container_running "$CONTAINER_NAME"; then
    if container_exists "$ROLLING_CONTAINER"; then
      docker rm -f "$ROLLING_CONTAINER" >/dev/null 2>&1
    fi
    set -e
    return 0
  fi
  ROLLING_OLD_STOPPED=1

  # Keep the warmed candidate serving while the canonical port is restored.
  local bridge_ready=0
  if container_exists "$ROLLING_CONTAINER" && ! container_running "$ROLLING_CONTAINER"; then
    docker start "$ROLLING_CONTAINER" >/dev/null
  fi
  if container_running "$ROLLING_CONTAINER"; then
    if wait_for_url "http://127.0.0.1:$ROLLING_PORT/api/health" 60 "rolling rollback bridge"; then
      bridge_ready=1
    fi
  fi

  local canonical_image=""
  canonical_image="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null)"
  if [[ -n "$canonical_image" && "$canonical_image" != "$CURRENT_IMAGE_ID" ]]; then
    if container_running "$CONTAINER_NAME" && [[ "$bridge_ready" != "1" ]]; then
      verify_reopened_production_edge
      echo "CRITICAL: rollback bridge is unavailable; leaving the healthy candidate in service" >&2
      set -e
      return 1
    fi
    docker stop -t 30 "$CONTAINER_NAME" >/dev/null 2>&1
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1
    canonical_image=""
  fi

  if [[ -z "$canonical_image" ]]; then
    CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
      up -d --no-build --force-recreate
  elif ! container_running "$CONTAINER_NAME"; then
    docker start "$CONTAINER_NAME" >/dev/null
  fi

  if wait_for_url "$HEALTH_URL" 60 "rolling rollback"; then
    sleep 3
    if [[ "$bridge_ready" == "1" ]] && container_running "$ROLLING_CONTAINER"; then
      docker stop -t 30 "$ROLLING_CONTAINER" >/dev/null 2>&1
    fi
    if verify_reopened_production_edge; then
      docker tag "$CURRENT_IMAGE_ID" cascade:latest
      docker rm "$ROLLING_CONTAINER" >/dev/null 2>&1
      echo "==> Previous image restored with all rolling-window writes preserved" >&2
    fi
  else
    echo "CRITICAL: previous image did not recover; leaving any healthy rolling bridge in service" >&2
  fi
  set -e
}

rolling_cutover() {
  echo "==> Starting zero-503 rolling cutover"
  ROLLING_STARTED=1
  start_rolling_container

  # Every nginx worker generation uses the stable 3000/39001 primary/backup
  # pair. The candidate receives traffic only after port 3000 stops accepting
  # a connection, never concurrently by load-balancing policy.
  verify_reopened_production_edge

  echo "==> Draining the previous backend into the warmed candidate"
  docker stop -t 120 "$CONTAINER_NAME" >/dev/null
  ROLLING_OLD_STOPPED=1
  verify_reopened_production_edge

  docker rm "$CONTAINER_NAME" >/dev/null
  ROLLING_OLD_REMOVED=1

  # Restore the canonical Compose service and port while the warmed candidate
  # continues to serve. This keeps established operational checks unchanged.
  echo "==> Starting the canonical candidate behind the rolling bridge"
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-build --force-recreate
  ROLLING_FINAL_STARTED=1
  verify_container_runtime_shape "$CONTAINER_NAME" "canonical rolling candidate"
  wait_for_url "$HEALTH_URL" 90 "canonical rolling candidate"
  check_engine_io "http://127.0.0.1:3000"
  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"

  local running_image_id
  running_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
  if [[ "$running_image_id" != "$CERTIFIED_IMAGE_ID" ]]; then
    echo "Error: canonical candidate is $running_image_id, expected certified image $CERTIFIED_IMAGE_ID." >&2
    return 1
  fi

  # Let every worker's primary failure timer expire before removing the
  # bridge. A failed bridge connection can still retry the now-healthy primary.
  sleep 3
  verify_reopened_production_edge
  echo "==> Draining the rolling bridge into the canonical candidate"
  docker stop -t 120 "$ROLLING_CONTAINER" >/dev/null
  verify_reopened_production_edge

  docker tag "$CERTIFIED_IMAGE_ID" cascade:latest
  DEPLOY_COMMITTED=1
  docker rm "$ROLLING_CONTAINER" >/dev/null 2>&1 || true
  echo "==> Zero-503 rolling cutover committed"
}

maintenance_cutover() {
  echo "==> Persistent-state migration requires the snapshot-backed maintenance cutover"
  ensure_cutover_disk_capacity
  CUTOVER_STARTED=1
  close_maintenance_gate
  verify_maintenance_gate

  # Stopping first closes pre-existing WebSockets; the nginx marker prevents
  # reconnects and mutations until the migration candidate is verified.
  docker compose "${COMPOSE_ARGS[@]}" stop -t 120 cascade
  OLD_BACKEND_STOPPED=1
  checkpoint_and_snapshot

  echo "==> Starting the Elixir candidate"
  CANDIDATE_DATA_TOUCHED=1
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-build --force-recreate

  verify_container_runtime_shape "$CONTAINER_NAME" "running production candidate"
  wait_for_url "$HEALTH_URL" 90 "Elixir candidate"
  check_engine_io "http://127.0.0.1:3000"
  verify_live_database
  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"
  local running_image_id
  running_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
  if [[ "$running_image_id" != "$CERTIFIED_IMAGE_ID" ]]; then
    echo "Error: running candidate is $running_image_id, expected certified image $CERTIFIED_IMAGE_ID." >&2
    return 1
  fi

  docker tag "$CERTIFIED_IMAGE_ID" cascade:latest
  # Once the gate opens, external mutations can reach the candidate and an
  # automatic database rollback would lose them. Commit first, then open it.
  DEPLOY_COMMITTED=1
  open_maintenance_gate
  verify_reopened_production_edge
}

prune_build_cache() {
  # Keep the dependency layers and compiled Elixir cache between small releases.
  # Under disk pressure, favor recovery space over the next build's speed.
  local available_kb keep_storage=8GB
  available_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
  if (( available_kb < 5242880 )); then keep_storage=1GB; fi
  docker builder prune -af --keep-storage "$keep_storage" >/dev/null || true
}

# A desktop release or retried workflow may target the image already serving.
# Reuse that exact artifact's completed cutover; mutable health is checked again.
already_running_release() {
  local running_image expected_image image_revision health
  [[ ! -e "$MAINTENANCE_MARKER" && ! -L "$MAINTENANCE_MARKER" ]] || return 1
  running_image="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")" || return 1
  expected_image="$(docker image inspect --format '{{.Id}}' "cascade:certified-$REVISION")" || return 1
  [[ "$expected_image" =~ ^sha256:[0-9a-f]{64}$ && "$running_image" == "$expected_image" ]] || return 1
  image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$running_image")" || return 1
  [[ "$image_revision" == "$REVISION" ]] || return 1
  health="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 "$HEALTH_URL")" || return 1
  [[ "$health" == *'"status":"ok"'* ]] || return 1
}

if already_running_release; then
  echo "==> Exact revision $REVISION is already healthy; refreshing installers without cutover"
  bash "$ROOT/deploy/sync-desktop-installers.sh"
  prune_cutover_snapshots
  exit 0
fi

# Builds can refill several GiB in minutes. Bound disposable build cache before
# capacity checks, including failed attempts; never prune images or volumes.
prune_build_cache
AVAIL_KB="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')"
if (( AVAIL_KB < 1048576 )); then
  echo "Error: less than 1 GiB free; refusing deployment." >&2
  exit 1
fi

# Remove only stopped Compose leftovers. Never stop the live app as cleanup.
mapfile -t STALE_CONTAINERS < <(
  docker compose "${COMPOSE_ARGS[@]}" ps -aq \
    --status created --status exited --status dead cascade | sort -u
)
if [[ "${#STALE_CONTAINERS[@]}" -gt 0 ]]; then
  echo "==> Removing stale Cascade recreate containers"
  docker rm "${STALE_CONTAINERS[@]}" >/dev/null
fi

load_release_candidate
verify_compose_runtime_shape
secure_production_environment
preflight_candidate
sync_nginx_security 3000 "$ROLLING_PORT"
settle_reloaded_nginx

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
if [[ -z "$CURRENT_IMAGE_ID" ]]; then
  echo "Error: no running production image is available for rollback." >&2
  exit 1
fi
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"

if [[ "${CASCADE_TUNE_HOST_CAPACITY:-1}" == "1" ]]; then
  "$ROOT/deploy/tune-host-capacity.sh"
fi

if [[ "$ROLLING_SAFE" == "1" ]]; then
  rolling_cutover
else
  maintenance_cutover
fi

docker compose "${COMPOSE_ARGS[@]}" ps
if [[ -n "$SNAPSHOT_DIR" ]]; then
  echo "==> Deployed $REVISION_SHORT ($CERTIFIED_IMAGE_ID); rollback snapshot: $SNAPSHOT_DIR"
else
  echo "==> Deployed $REVISION_SHORT ($CERTIFIED_IMAGE_ID); rolling rollback preserved live state"
fi

# The desktop workflow publishes its release after the push-triggered deploy.
# A repeated exact-revision deploy refreshes these assets through the fast path
# above once the release assets and SHA256SUMS are available.
bash "$ROOT/deploy/sync-desktop-installers.sh"

# Only expire recovery points after the new service and edge passed all checks.
prune_cutover_snapshots

echo "==> Pruning dangling images and old build cache"
docker image prune -f >/dev/null || true
prune_build_cache
df -h / | awk 'NR==2 {printf "    Disk: %s used, %s free (%s)\n", $3, $4, $5}'
