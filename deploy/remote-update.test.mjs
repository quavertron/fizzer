import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(deployDirectory, 'remote-update.sh'), 'utf8');
const hostDeploy = fs.readFileSync(path.join(deployDirectory, 'github-actions-host.sh'), 'utf8');
const workflow = fs.readFileSync(
  path.join(deployDirectory, '../.github/workflows/deploy-production.yml'),
  'utf8',
);
const desktopWorkflow = fs.readFileSync(
  path.join(deployDirectory, '../.github/workflows/desktop-build.yml'),
  'utf8',
);
const compose = fs.readFileSync(path.join(deployDirectory, '../docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(deployDirectory, '../Dockerfile'), 'utf8');
const nginxTemplate = fs.readFileSync(path.join(deployDirectory, 'nginx.conf.template'), 'utf8');

function assertOrdered(...lines) {
  let previous = -1;
  for (const line of lines) {
    const index = source.indexOf(`\n${line}\n`, previous + 1);
    assert.notEqual(index, -1, `missing cutover gate: ${line}`);
    assert.ok(index > previous, `cutover gate is out of order: ${line}`);
    previous = index;
  }
}

function functionBody(name) {
  const start = source.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `unterminated function: ${name}`);
  return source.slice(start, end + 3);
}

function assertOrderedWithin(haystack, ...lines) {
  let previous = -1;
  for (const line of lines) {
    const index = haystack.indexOf(`\n${line}\n`, previous + 1);
    assert.notEqual(index, -1, `missing ordered line: ${line}`);
    assert.ok(index > previous, `line is out of order: ${line}`);
    previous = index;
  }
}

test('state-identical releases use a warmed backup and never close the maintenance gate', () => {
  const rolling = functionBody('rolling_cutover');
  assertOrderedWithin(
    rolling,
    '  start_rolling_container',
    '  verify_reopened_production_edge',
    '  docker stop -t 120 "$CONTAINER_NAME" >/dev/null',
    '  ROLLING_OLD_STOPPED=1',
    '  verify_reopened_production_edge',
    '  docker rm "$CONTAINER_NAME" >/dev/null',
    '  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \\',
    '  verify_container_runtime_shape "$CONTAINER_NAME" "canonical rolling candidate"',
    '  sleep 3',
    '  verify_reopened_production_edge',
    '  docker stop -t 120 "$ROLLING_CONTAINER" >/dev/null',
    '  verify_reopened_production_edge',
    '  DEPLOY_COMMITTED=1',
  );
  assert.doesNotMatch(rolling, /close_maintenance_gate|verify_maintenance_gate|restore_database_snapshot/);
  assert.match(source, /if \[\[ "\$ROLLING_SAFE" == "1" \]\]; then\s+rolling_cutover\s+else\s+maintenance_cutover/);
  assert.match(source, /sync_nginx_security 3000 "\$ROLLING_PORT"/);
  assertOrdered(
    'sync_nginx_security 3000 "$ROLLING_PORT"',
    'settle_reloaded_nginx',
    '  rolling_cutover',
  );
});

test('state-changing releases retain the gated snapshot rollback path', () => {
  const maintenance = functionBody('maintenance_cutover');
  assertOrderedWithin(
    maintenance,
    '  CUTOVER_STARTED=1',
    '  close_maintenance_gate',
    '  verify_maintenance_gate',
    '  docker compose "${COMPOSE_ARGS[@]}" stop -t 120 cascade',
    '  OLD_BACKEND_STOPPED=1',
    '  checkpoint_and_snapshot',
    '  CANDIDATE_DATA_TOUCHED=1',
    '  verify_live_database',
    '  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"',
    '  DEPLOY_COMMITTED=1',
    '  open_maintenance_gate',
    '  verify_reopened_production_edge',
  );
});

test('production promotes an exact staged image without requiring capacity certification', () => {
  assert.match(source, /CERTIFIED_RELEASE_DIR="\/var\/lib\/cascade-release"/);
  assert.match(source, /CERTIFIED_MANIFEST="\$CERTIFIED_IMAGE_DIR\/\$REVISION\.json"/);
  assert.match(source, /CANDIDATE_IMAGE="cascade:certified-\$REVISION"/);
  assert.match(source, /CERTIFIED_IMAGE_ID="\$\(docker image inspect/);
  assert.match(source, /loaded_revision="\$\(docker image inspect/);
  assert.match(source, /staged release image has an invalid identity or revision label/);
  assert.match(source, /Capacity evidence is optional for routine releases/);
  assert.match(source, /certification directories must be canonical root-owned directories, mode 0700/);
  assert.match(source, /for certification_part in "\$CERTIFIED_MANIFEST" "\$CERTIFIED_MANIFEST\.sha256"/);
  assert.match(source, /certification and checksum must be regular root-owned files, mode 0600/);
  assert.match(source, /git status --porcelain --untracked-files=no/);
  assert.match(source, /-L "\$certification_part"/);
  assert.match(source, /certified-image\.mjs verify --manifest "\$CERTIFIED_MANIFEST"/);
  assert.match(source, /staged capacity certification differs from the release image/);
  assert.doesNotMatch(source, /operator-capacity-waiver/);
  assert.match(source, /docker run --rm --network none[\s\S]*RouteCatalog\.swap_ready\?\(\)/);
  assert.match(source, /running_image_id="\$\(docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(source, /running_image_id" != "\$CERTIFIED_IMAGE_ID/);
  assert.doesNotMatch(source, /^\s*docker (?:compose )?build(?:\s|$)/mu);
  assert.doesNotMatch(source, /BUILD_ARGS/);
});

test('GitHub Actions is the only exact-revision production deploy entrypoint', () => {
  assert.match(workflow, /name: Deploy Production/);
  assert.match(workflow, /push:\s+branches: \[master\]/);
  assert.match(workflow, /workflow_run:\s+workflows: \[Desktop builds\]\s+types: \[completed\]/);
  assert.match(workflow, /group: deploy-production\s+cancel-in-progress: false/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /REVISION: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}/);
  assert.match(workflow, /"deploy \$REVISION"/);
  assert.match(workflow, /"verify \$REVISION"/);
  assert.match(workflow, /https:\/\/cscd\.online\/api\/health/);

  assert.match(hostDeploy, /REMOTE=https:\/\/github\.com\/grm4871\/fizzer\.git/);
  assert.match(hostDeploy, /git fetch --force --no-tags origin refs\/heads\/master/);
  assert.match(hostDeploy, /git merge-base --is-ancestor "\$revision" "\$master_revision"/);
  assert.match(hostDeploy, /git reset --hard "\$revision"/);
  assert.match(hostDeploy, /image="cascade:certified-\$revision"/);
  assert.match(hostDeploy, /bash deploy\/build-release-image\.sh/);
  assert.match(hostDeploy, /CASCADE_DEPLOY_DOMAIN="\$DOMAIN" bash deploy\/remote-update\.sh/);
  assert.match(hostDeploy, /running_revision" == "\$revision"/);
  assert.match(hostDeploy, /running_image" == "\$certified_image"/);
  assert.match(hostDeploy, /http:\/\/127\.0\.0\.1:3000\/api\/health/);
  assert.ok(
    hostDeploy.indexOf('git reset --hard "$revision"')
      < hostDeploy.indexOf('bash deploy/build-release-image.sh'),
    'the host must resolve the exact triggering commit before building it',
  );
  assert.equal(fs.existsSync(path.join(deployDirectory, 'deploy-watcher.sh')), false);
  assert.equal(fs.existsSync(path.join(deployDirectory, 'install-deploy-watcher.sh')), false);
});

test('the post-cutover installer sync verifies a release manifest before replacing routes', () => {
  const sync = fs.readFileSync(path.join(deployDirectory, 'sync-desktop-installers.sh'), 'utf8');
  assert.match(source, /bash "\$ROOT\/deploy\/sync-desktop-installers\.sh"/);
  assert.doesNotMatch(desktopWorkflow, /gh workflow run deploy-production\.yml/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(sync, /Fizzer-mac-arm64\.dmg/);
  assert.match(sync, /Fizzer-mac-x64\.dmg/);
  assert.match(sync, /Fizzer-Setup\.exe/);
  assert.match(sync, /Fizzer-linux-x64\.deb/);
  assert.match(sync, /Fizzer-linux-x64\.rpm/);
  assert.match(sync, /sha256sum --check --status SHA256SUMS/);
  assert.match(sync, /mv -f "\$staging\/\$file" "\$DOWNLOADS_DIR\/\$file"/);
});

test('the host build reads an image identity supported by older Docker engines', () => {
  const build = fs.readFileSync(path.join(deployDirectory, 'build-release-image.sh'), 'utf8');
  assert.match(build, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.doesNotMatch(build, /\.Descriptor/);
});

test('preflight, rolling bridge, Compose, and the canonical candidate share the resource envelope', () => {
  assert.match(source, /cpus: 2,[\s\S]*cpuset: "0-1"[\s\S]*memory: 3 \* 1024 \*\* 3/);
  assert.match(source, /memorySwap: 3 \* 1024 \*\* 3,[\s\S]*pids: 100_000/);
  assert.match(source, /CASCADE_IMAGE="\$CANDIDATE_IMAGE" docker compose[\s\S]*config --format json/);
  assert.match(source, /--cpus 2 --cpuset-cpus 0-1 --memory 3g --memory-swap 3g/);
  assert.match(source, /--pids-limit 100000 --ulimit nofile=200000:200000/);
  assert.match(source, /verify_container_runtime_shape "\$PREFLIGHT_CONTAINER" "isolated candidate preflight"/);
  assert.match(source, /verify_container_runtime_shape "\$ROLLING_CONTAINER" "warmed rolling candidate"/);
  assert.match(source, /verify_container_runtime_shape "\$CONTAINER_NAME" "running production candidate"/);
  assert.match(source, /verify_container_runtime_shape "\$CONTAINER_NAME" "canonical rolling candidate"/);
});

test('authenticated production smoke runs directly against both rolling candidate instances', () => {
  assert.match(source, /Running authenticated production read\/realtime smoke against \$container/);
  assert.match(source, /release eval` starts a separate VM, not an RPC session/);
  assert.match(source, /new Database\("\/data\/docs\.db", \{ readonly: true, fileMustExist: true \}\)/);
  assert.match(source, /createHmac\("sha256", process\.env\.JWT_SECRET\)/);
  assert.match(source, /authenticated-live-smoke\.mjs "\$origin"/);
  assert.doesNotMatch(source, /runner:register/);
  assert.match(dockerfile, /COPY --chown=node:node deploy\/authenticated-live-smoke\.mjs \.\/deploy\/authenticated-live-smoke\.mjs/);
  const rolling = functionBody('rolling_cutover');
  assert.match(rolling, /verify_authenticated_live_candidate "\$CONTAINER_NAME" "http:\/\/127\.0\.0\.1:3000"/);
  const starter = functionBody('start_rolling_container');
  assert.match(starter, /verify_authenticated_live_candidate "\$ROLLING_CONTAINER" "http:\/\/127\.0\.0\.1:\$ROLLING_PORT"/);
});

test('the reopened TLS edge serves health, client assets, and Engine.IO', () => {
  assert.match(source, /--resolve "\$DEPLOY_DOMAIN:443:127\.0\.0\.1" "https:\/\/\$DEPLOY_DOMAIN\/api\/health"/);
  assert.match(source, /--resolve "\$DEPLOY_DOMAIN:443:127\.0\.0\.1" "https:\/\/\$DEPLOY_DOMAIN\/app\.html"/);
  assert.match(source, /root_html[\s\S]*<div id="root"/);
  assert.match(source, /root_html[\s\S]*assets\/main-/);
  assert.match(source, /socket\.io\/\?EIO=4&transport=polling/);
  assert.match(source, /Require three complete,[\s\S]*fresh edge probes/);
  assert.match(source, /health_code" == "200"[\s\S]*root_html[\s\S]*engine_open/);
  assert.match(source, /"\$consecutive" -ge 3/);
  assert.match(source, /reopened production edge did not stabilize/);
  assertOrderedWithin(
    functionBody('maintenance_cutover'),
    '  open_maintenance_gate',
    '  verify_reopened_production_edge',
  );
  assert.match(source, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" ps/);
});

test('failure handling restores only a verified snapshot after the candidate is stopped', () => {
  assert.match(source, /if \[\[ "\$CUTOVER_STARTED" == "1" && "\$DEPLOY_COMMITTED" != "1" \]\]; then\s+rollback_cutover/);
  assertOrdered(
    '  if ! close_maintenance_gate; then',
    '      CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" stop -t 30 cascade || true',
    '      if ! restore_database_snapshot; then',
    '    if ! CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \\',
    '    if open_maintenance_gate; then',
  );
  assert.match(source, /candidate is still running; refusing an unsafe database restore/);
  assert.match(source, /rollback cannot prove traffic is gated; refusing to mutate production data/);
  assert.match(source, /if \[\[ "\$OLD_BACKEND_STOPPED" == "1" \|\| "\$backend_running" != "true" \]\]/);
  assert.match(source, /rollback did not become healthy; maintenance gate remains active/);
});

test('rolling failure keeps a verified bridge online and never rewinds user writes', () => {
  const rollback = functionBody('rollback_rolling_cutover');
  assert.match(source, /if \[\[ "\$ROLLING_STARTED" == "1" && "\$DEPLOY_COMMITTED" != "1" \]\]; then\s+rollback_rolling_cutover/);
  assert.match(rollback, /restoring the previous image without rewinding live data/);
  assert.match(rollback, /rolling rollback bridge/);
  assert.match(rollback, /CASCADE_IMAGE="\$ROLLBACK_IMAGE" docker compose/);
  assert.match(rollback, /Previous image restored with all rolling-window writes preserved/);
  assert.doesNotMatch(rollback, /restore_database_snapshot|SNAPSHOT_DB/);
  assert.match(rollback, /leaving the healthy candidate in service/);
  assert.match(rollback, /ROLLING_OLD_STOPPED" != "1" \]\] && container_running "\$CONTAINER_NAME"/);
  assert.match(rollback, /ROLLING_OLD_STOPPED=1/);
});

test('nginx uses a primary/backup upstream with bounded pre-send failover', () => {
  assert.match(nginxTemplate, /upstream cascade_app \{/);
  assert.match(nginxTemplate, /server 127\.0\.0\.1:CASCADE_PRIMARY_PORT/);
  assert.match(nginxTemplate, /CASCADE_BACKUP_SERVER/);
  assert.match(nginxTemplate, /proxy_next_upstream error timeout http_502 http_503 http_504/);
  assert.match(nginxTemplate, /proxy_next_upstream_tries 2/);
  assert.doesNotMatch(nginxTemplate, /proxy_next_upstream[^;]*non_idempotent/);
  assert.equal((nginxTemplate.match(/proxy_pass http:\/\/cascade_app;/g) || []).length, 4);
});

test('the one-time upstream bootstrap drains old HTTP keepalive workers before cutover', () => {
  const configure = functionBody('configure_nginx_upstreams');
  const settle = functionBody('settle_reloaded_nginx');
  assert.match(configure, /NGINX_CONFIG_CHANGED=1/);
  assert.match(settle, /seq 1 80/);
  assert.match(settle, /production health changed while nginx workers drained/);
  assert.match(settle, /https:\/\/\$DEPLOY_DOMAIN\/api\/health/);
  assert.doesNotMatch(settle, /close_maintenance_gate/);
});

test('snapshot creation fails closed on a busy checkpoint and records integrity evidence', () => {
  assert.match(source, /Match the production database owner[\s\S]*--user 1000:1000 --entrypoint node/);
  assert.match(source, /wal_checkpoint\(TRUNCATE\)/);
  assert.match(source, /busy WAL checkpoint/);
  assert.match(source, /SQLite quick_check failed/);
  assert.match(source, /SQL query-only while allowing those disposable files/);
  assert.match(source, /-v "\$SNAPSHOT_DIR:\/snapshot"/);
  assert.match(source, /db\.pragma\("query_only = ON"\)/);
  assert.match(source, /rm -f -- "\$snapshot_tmp-wal" "\$snapshot_tmp-shm"/);
  assert.match(source, /snapshot foreign_key_check failed/);
  assert.match(source, /sha256sum docs\.db > docs\.db\.sha256/);
  assert.match(source, /git rev-parse HEAD > "\$SNAPSHOT_DIR\/revision\.txt"/);
});

test('isolated preflight classifies startup state before its mutating protocol probe', () => {
  assert.match(source, /busy preflight WAL checkpoint/);
  assert.match(source, /preflight SQLite quick_check failed/);
  assert.match(source, /Classify only startup DDL/);
  assertOrderedWithin(
    functionBody('preflight_candidate'),
    '  dump_live_schema "$PREFLIGHT_DIR/before-schema.json"',
    '    --materialize-schema /preflight/before-schema.json \\',
    '  boot_preflight_database',
    '    --dump-schema /preflight/after.db > "$PREFLIGHT_DIR/after-schema.json"',
    '    --schema-only --before-schema /preflight/before-schema.json --after-schema /preflight/after-schema.json 2>&1)"',
    '  start_preflight_server',
    '  docker run --rm --network host --entrypoint node \\',
    '  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null',
  );
  assert.match(functionBody('start_preflight_server'), /verify_container_runtime_shape "\$PREFLIGHT_CONTAINER" "isolated candidate preflight"/);
  assert.match(functionBody('verify_migration_clone'), /--before \/preflight\/before\.db --after \/preflight\/after\.db/);
});

test('preflight and live cutover bind the complete vault and QMD corpus without exemptions', () => {
  assert.match(functionBody('verify_migration_clone'), /before-data\/vaults/);
  assert.match(functionBody('verify_migration_clone'), /before-data\/qmd/);
  assert.match(functionBody('verify_migration_clone'), /--before-root \/preflight\/before-data --after-root \/preflight\/after-data/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/vaults"/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/qmd"/);
  assert.match(source, /--before-root \/snapshot\/corpus --after-root \/live-corpus/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/vaults:\/live-corpus\/vaults:ro"/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/qmd:\/live-corpus\/qmd:ro"/);
  assert.doesNotMatch(source, /"\$DATA_DIR\/\.cascade:\/live-corpus:ro"/);
  assert.match(source, /CASCADE_SQLITE_SNAPSHOT_TMPDIR=\/sqlite-scratch/);
  assert.match(source, /sqlite-scratch:\/sqlite-scratch/);
  assert.doesNotMatch(source, /allow-derived|ignore.*index\.sqlite/iu);
  assert.match(source, /Candidate boot is schema-identical; rolling cutover is eligible/);
  assert.match(source, /--schema-only/);
  assert.match(source, /verify_live_schema_identity "\$ROLLING_CONTAINER"/);
  assert.doesNotMatch(source, /verify_live_schema_identity "\$CONTAINER_NAME"/);
  assert.doesNotMatch(functionBody('preflight_candidate'), /--require-identical/);
  assert.doesNotMatch(functionBody('verify_live_schema_identity'), /backup_running_database/);
});

test('production gives runners ten minutes to reclaim after gated candidate startup', () => {
  const configured = compose.match(/CASCADE_RUNNER_ORPHAN_RECLAIM_MS:\s*"(\d+)"/);
  assert.ok(configured, 'production runner reclaim override is missing');
  assert.equal(Number(configured[1]), 600_000);

  const healthAttempts = source.match(/wait_for_url "\$HEALTH_URL" (\d+) "Elixir candidate"/);
  assert.ok(healthAttempts, 'candidate health wait is missing');
  assert.ok(Number(configured[1]) > Number(healthAttempts[1]) * 2_000);
  assertOrderedWithin(
    functionBody('maintenance_cutover'),
    '  CANDIDATE_DATA_TOUCHED=1',
    '  wait_for_url "$HEALTH_URL" 90 "Elixir candidate"',
    '  verify_live_database',
    '  DEPLOY_COMMITTED=1',
  );
  assert.match(source, /DEPLOY_COMMITTED=1\s+open_maintenance_gate/);
});

test('maintenance and cleanup operations fail closed and stay project scoped', () => {
  assert.match(source, /install -m 0644 -o 0 -g 0 \/dev\/null "\$MAINTENANCE_MARKER"/);
  assert.match(source, /if ! rm -f -- "\$MAINTENANCE_MARKER" \|\| \[\[ -e "\$MAINTENANCE_MARKER" \|\| -L "\$MAINTENANCE_MARKER" \]\]/);
  assert.match(source, /consecutive=\$\(\(consecutive \+ 1\)\)/);
  assert.match(source, /"\$consecutive" -ge 3/);
  assert.match(source, /maintenance gate did not stabilize at HTTP 503/);
  assert.match(source, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" ps -aq[\s\S]*--status created --status exited --status dead cascade/);
  assert.doesNotMatch(source, /--filter "label=com\.docker\.compose\.service=cascade"/);
});

test('production secrets are regular root-owned mode 0600 before candidate startup', () => {
  assert.match(source, /-L "\$environment_file" \|\| ! -f "\$environment_file"/);
  assert.match(source, /chown 0:0 "\$environment_file"/);
  assert.match(source, /chmod 0600 "\$environment_file"/);
  assert.match(source, /"0:0:600"/);
  assertOrdered(
    'secure_production_environment',
    'preflight_candidate',
  );
  assert.match(functionBody('maintenance_cutover'), /CANDIDATE_DATA_TOUCHED=1/);
  assert.match(functionBody('rolling_cutover'), /start_rolling_container/);
});


test('repeat revision refreshes installers without cutover only with current live evidence', () => {
  const start = source.indexOf('already_running_release() {');
  const end = source.indexOf('AVAIL_KB=', start);
  assert.ok(start > 0 && end > start, 'repeat deployment must have an early live-evidence guard');
  const fastPath = source.slice(start, end);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-repeat-deploy-'));
  const image = `sha256:${'a'.repeat(64)}`;
  const revision = 'b'.repeat(40);
  const script = `set -euo pipefail
ROOT=/unused
CONTAINER_NAME=cascade
HEALTH_URL=http://unused
REVISION=$TEST_REVISION
docker() {
  if [[ "$*" == "inspect --format {{.Image}} cascade" ]]; then
    printf '%s' "$TEST_RUNNING_IMAGE"
  elif [[ "$*" == *"{{.Id}}"* ]]; then
    printf '%s' "$TEST_EXPECTED_IMAGE"
  else
    printf '%s' "$TEST_IMAGE_REVISION"
  fi
}
curl() { printf '%s' "$TEST_HEALTH"; return "$TEST_CURL_STATUS"; }
prune_cutover_snapshots() { echo RETENTION; }
bash() { echo INSTALLERS; return "$TEST_INSTALLER_STATUS"; }
${fastPath}
echo CUTOVER
`;
  const run = (overrides = {}) => spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, MAINTENANCE_MARKER: path.join(dir, 'maintenance'),
      TEST_REVISION: revision, TEST_IMAGE_REVISION: revision,
      TEST_RUNNING_IMAGE: image, TEST_EXPECTED_IMAGE: image,
      TEST_HEALTH: '{"status":"ok"}', TEST_CURL_STATUS: '0', TEST_INSTALLER_STATUS: '0',
      ...overrides },
  });
  try {
    const healthy = run();
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /INSTALLERS/);
    assert.match(healthy.stdout, /RETENTION/);
    assert.doesNotMatch(healthy.stdout, /CUTOVER/);
    for (const overrides of [
      { TEST_RUNNING_IMAGE: `sha256:${'c'.repeat(64)}` },
      { TEST_EXPECTED_IMAGE: '' },
      { TEST_IMAGE_REVISION: 'd'.repeat(40) },
      { TEST_HEALTH: '{"status":"error"}' },
      { TEST_CURL_STATUS: '22' },
    ]) {
      const result = run(overrides);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /CUTOVER/);
      assert.doesNotMatch(result.stdout, /INSTALLERS/);
    }
    const failedSync = run({ TEST_INSTALLER_STATUS: '17' });
    assert.equal(failedSync.status, 17);
    assert.doesNotMatch(failedSync.stdout, /CUTOVER|RETENTION/);
    fs.writeFileSync(path.join(dir, 'maintenance'), '');
    assert.match(run().stdout, /CUTOVER/);
    fs.unlinkSync(path.join(dir, 'maintenance'));
    fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'maintenance'));
    assert.match(run().stdout, /CUTOVER/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('late desktop completion cannot request an older production revision', () => {
  assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/master" --jq .sha/);
  assert.match(workflow, /"\$CURRENT_MASTER" != "\$REVISION"/);
  assert.match(workflow, /echo "skipped=true" >> "\$GITHUB_OUTPUT"/);
  assert.equal(workflow.match(/if: steps\.delivery\.outputs\.skipped != 'true'/g)?.length, 2);
});


test('desktop delivery checks current master after queueing and fails closed on lookup errors', () => {
  const body = workflow.split('id: delivery')[1].split('        run: |\n')[1]
    .split('\n      - name:')[0].replace(/^          /gm, '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-desktop-delivery-'));
  const revision = 'b'.repeat(40);
  const run = (overrides = {}) => spawnSync('bash', ['-c', `
    gh() { printf '%s' "$TEST_MASTER"; return "$TEST_LOOKUP_STATUS"; }
    ssh() { echo SSH_CALLED; }
${body}`], {
    encoding: 'utf8',
    env: { ...process.env, REVISION: revision, TEST_MASTER: revision,
      TEST_LOOKUP_STATUS: '0', GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_REPOSITORY: 'example/fizzer', GITHUB_OUTPUT: path.join(dir, 'output'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
      DEPLOY_PORT: '22', DEPLOY_USER: 'unused', DEPLOY_HOST: 'unused', ...overrides },
  });
  try {
    const current = run();
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /SSH_CALLED/);
    const stale = run({ TEST_MASTER: 'c'.repeat(40) });
    assert.equal(stale.status, 0, stale.stderr);
    assert.doesNotMatch(stale.stdout, /SSH_CALLED/);
    assert.match(fs.readFileSync(path.join(dir, 'output'), 'utf8'), /skipped=true/);
    const failed = run({ TEST_LOOKUP_STATUS: '1' });
    assert.notEqual(failed.status, 0);
    assert.doesNotMatch(failed.stdout, /SSH_CALLED/);
    const push = run({ GITHUB_EVENT_NAME: 'push', TEST_MASTER: 'c'.repeat(40) });
    assert.equal(push.status, 0, push.stderr);
    assert.match(push.stdout, /SSH_CALLED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('full-copy capacity is required only for migrations and rechecked before gating traffic', () => {
  assert.doesNotMatch(source, /verify_compose_runtime_shape\nensure_cutover_disk_capacity/);
  assertOrderedWithin(functionBody('verify_migration_clone'),
    '  ensure_cutover_disk_capacity',
    '  mkdir -p "$PREFLIGHT_DIR/before-data" "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"');
  assertOrderedWithin(functionBody('maintenance_cutover'),
    '  ensure_cutover_disk_capacity', '  CUTOVER_STARTED=1', '  close_maintenance_gate');
  assertOrderedWithin(functionBody('preflight_candidate'),
    '  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null',
    '  cleanup_preflight_clones', '  mkdir -p "$PREFLIGHT_DIR/sqlite-scratch"');
  assert.match(source, /docker builder prune -af --keep-storage 1GB/);
});

test('capacity includes WAL, corpus, reserve, and a separate snapshot filesystem', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-capacity-'));
  try {
    fs.writeFileSync(path.join(directory, 'docs.db'), 'db');
    fs.writeFileSync(path.join(directory, 'docs.db-wal'), 'wal');
    const check = (dataFree, snapshotFree) => spawnSync('bash', ['-c', `
      set -euo pipefail
      DATA_DIR="$1"
      LIVE_DB="$DATA_DIR/docs.db"
      stat() { if [[ "$3" == *-wal ]]; then echo 104857600; else echo 1073741824; fi; }
      du() { echo '204800 corpus'; }
      install() { :; }
      df() { echo 'Filesystem 1024-blocks Used Available Capacity Mounted';
        if [[ "$2" == /var/backups/cascade ]]; then echo 'snapshot 99999999 0 ${snapshotFree} 0% /snapshot';
        else echo 'data 99999999 0 ${dataFree} 0% /data'; fi; }
      ${functionBody('ensure_cutover_disk_capacity')}
      ensure_cutover_disk_capacity
    `, 'test', directory], { encoding: 'utf8' });
    // 4 * (1 GiB DB + 100 MiB WAL) + 3 * 200 MiB corpus + 1 GiB.
    const required = 4 * (1048576 + 102400) + 3 * 204800 + 1048576;
    assert.equal(check(required, 99999999).status, 0);
    assert.match(check(required - 1, 99999999).stderr, /cutover needs/);
    assert.match(check(required, 1048576).stderr, /snapshot filesystem lacks/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('preflight disposal releases large clones but retains rolling comparison evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-clone-cleanup-'));
  try {
    for (const name of ['before.db', 'after.db', 'after.db-wal', 'before-schema.json', 'after-schema.json'])
      fs.writeFileSync(path.join(directory, name), name);
    for (const name of ['before-data', 'after-data', 'sqlite-scratch']) {
      fs.mkdirSync(path.join(directory, name));
      fs.writeFileSync(path.join(directory, name, 'corpus'), 'data');
    }
    const result = spawnSync('bash', ['-c', `set -euo pipefail
      PREFLIGHT_DIR="$1"
      ${functionBody('cleanup_preflight_clones')}
      cleanup_preflight_clones`, 'test', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['after-schema.json', 'before-schema.json']);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


test('retention follows successful deployment and preserves active snapshot references', () => {
  assertOrdered('  rolling_cutover', '  maintenance_cutover',
    'bash "$ROOT/deploy/sync-desktop-installers.sh"', 'prune_cutover_snapshots');
  assert.match(functionBody('prune_cutover_snapshots'), /docker ps -q/);
  assert.match(functionBody('prune_cutover_snapshots'), /recovery snapshots are mounted/);
  assert.match(functionBody('prune_cutover_snapshots'), /--apply --protect "\$SNAPSHOT_DIR"/);
  assert.doesNotMatch(functionBody('on_exit'), /prune_cutover/);
  assert.match(functionBody('checkpoint_and_snapshot'), /--seal/);
});


test('retention refuses direct, ancestor and descendant recovery mounts', () => {
  const body = functionBody('prune_cutover_snapshots')
    .replace('[[ -d /var/backups/cascade ]] || return 0', ':');
  for (const mount of ['/', '/var', '/var/backups', '/var/backups/cascade', '/var/backups/cascade/cutover-active']) {
    const result = spawnSync('bash', ['-c', `set -euo pipefail
      ROOT=/unused
      SNAPSHOT_DIR=""
      docker() { if [[ "$1" == ps ]]; then echo container; else echo "$TEST_MOUNT"; fi; }
      python3() { echo PRUNED; }
      ${body}
      prune_cutover_snapshots`],
      { encoding: 'utf8', env: { ...process.env, TEST_MOUNT: mount } });
    assert.notEqual(result.status, 0, mount);
    assert.match(result.stderr, /mounted by a running container/);
    assert.doesNotMatch(result.stdout, /PRUNED/);
  }
});
