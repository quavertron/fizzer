# Deployment and operations

## Production topology

Production serves the certified Dockerized Elixir service and built React client behind nginx.
Persistent application data is mounted from `/var/lib/cascade` into `/data` in
the container.

`docker-compose.yml` binds the application to `127.0.0.1:3000`; nginx owns the
public HTTP and TLS boundary.

## Immutable release artifact

The `Deploy Production` GitHub Actions workflow builds a missing
revision-labelled image on the production host from the exact triggering Git
object, then verifies its revision and digest before cutover. A push to
`master` in the public Fizzer repository is the only production release
trigger.

Capacity-sensitive releases may still be built, certified, and staged ahead of
time so the exact image tested under load is the image deployed:

```bash
npm run release:image:build

# Run the four load shards and capacity monitor against:
IMAGE="cascade:certified-$(git rev-parse HEAD)"
IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE")"

npm run release:image:certify -- \
  --image "$IMAGE" \
  --monitor /secure/cascade-capacity/monitor.jsonl \
  --load-result /secure/cascade-capacity/shard-0.json \
  --load-result /secure/cascade-capacity/shard-1.json \
  --load-result /secure/cascade-capacity/shard-2.json \
  --load-result /secure/cascade-capacity/shard-3.json \
  --fault-result /secure/cascade-capacity/runner-restart.json \
  --fault-result /secure/cascade-capacity/sqlite-lock.json \
  --soak-result /secure/cascade-capacity/soak-invariants.json

npm run release:image:stage -- \
  ".cascade-release/$(git rev-parse HEAD).json"
```

The build refuses a dirty checkout. Dockerfile bases are digest-pinned, the
image carries the full Git revision, and certification refuses a different
monitor image ID, a failed/incomplete 10,000-user run, fewer than four bound
load shards, a monitor shorter than 2,250 seconds, a concurrent gate shorter
than 30 minutes, any shard that does not span that gate, or an image whose
embedded cutover gate is closed. The manifest also requires exact-image runner
restart/reclaim and SQLite lock/recovery proofs plus a separate 5,000-user,
two-hour churn/run-event durability soak. The durability soak never replaces
the exact 10,000-user/30-minute capacity gate: both must pass for the same image
ID, full revision, target, fixture identity, and production runtime shape.
Certification reopens the raw capacity and soak journals, fixture file, and
both server-log artifacts without following symlinks; recomputes their semantic
gates from the captured records; and verifies every byte count, line count, and
SHA-256. Fatal/error logs, per-sample container/config drift, probe/DB errors,
non-identical requested/delegated/terminal/persisted run-ID sets, failed SQLite
integrity/count reconciliation, or a probe uninstall failure all fail closed.
The durability artifact also binds the observed 300-310-second ramp, all ten
deterministic churn cohorts, exact live event sequences 2/3/4, one-owner fixture
groups, the single batched runner teardown snapshot/flush, and a fully drained
presence dispatcher with zero unclassified/noop/failure outcomes.
The certified and production runtime envelope is the same exact 2 CPUs pinned
to `0-1`, 3 GiB memory/no additional swap, 100,000 PIDs, and 200,000 open-file
limit. The deploy checks both rendered Compose configuration and container
inspection before reopening traffic, leaving roughly 0.8 GiB host memory
outside the app container.
Staging streams `docker save` over SSH into `docker load`, verifies the remote
image ID, and installs a root-owned checksum manifest below the separate
root-only `/var/lib/cascade-release` trust root. The application-writable
`/var/lib/cascade` volume has no path to replace release attestations. Staging
does not start or replace the production container.

### Shared Docker build cache

The Dockerfile uses BuildKit caches for npm, Hex/Rebar, and Elixir's `_build`
directory. The release helper uses the local BuildKit cache by default. Set
`CASCADE_BUILD_CACHE_REF` to share dependency and compilation layers through a
registry. The cache is separate for each target platform.

The example address is GitHub Container Registry (GHCR). Replace
`YOUR_GITHUB_USERNAME` with the GitHub account that owns the cache package. It
is storage for a Docker cache image, not a running service. The first successful
cache export creates the package; publishing requires a GitHub token with
package write permission, and every builder that imports or exports it must
have appropriate registry access. Keep the package private unless exposing
intermediate build layers is acceptable.

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# The repository's shared cache is:
export CASCADE_BUILD_CACHE_REF=ghcr.io/grm4871/fizzer:buildcache-amd64

# An ARM64 Mac uses emulation but produces the server-compatible AMD64 image.
npm run release:image:build

# An AMD64 builder uses the same command and cache ref natively.
# For an intentional ARM64 artifact, set CASCADE_TARGET_PLATFORM=linux/arm64
# and export CASCADE_BUILD_CACHE_REF=...:buildcache-arm64 instead.
```

The registry cache is separate from the certified runtime image and uses
`mode=max`, so later Linux builders can reuse matching dependency and
compilation layers. The `RUN --mount=type=cache` directories themselves remain
local to each BuildKit builder; they provide incremental compiler reuse when a
builder handles successive source changes. The release image is still built in
a Linux environment because its bundled OTP runtime and native NIFs must match
the target OS and architecture.
Pre-staged images are reused without rebuilding. Otherwise the host uses its
local BuildKit cache, so routine incremental builds are typically small.

Capacity certification is an operator workflow, not a routine commit gate. When
changing that workflow, run only the affected component checks:

- `npm run test:elixir:deploy-safety` exercises certification, rollback, and
  the exact nginx edge policy.
- `npm run test:elixir:certified-image`, `npm run test:elixir:rollback`, and
  `npm run test:elixir:edge` expose those three gates individually without
  rerunning them in the aggregate release command.
- `npm run test:elixir:load-harness` exercises the load driver, monitor, edge
  limit proof, and protocol codec.

## Routine production release

Push the intended commit to `master` in `grm4871/fizzer`, then watch the
`Deploy Production` workflow. The workflow serializes releases, sends
`github.sha` through a dedicated forced-command SSH identity, and fails unless
the host checkout, immutable image label and ID, internal health, and public
health all match that exact revision.

Successful desktop builds also trigger installer refresh for the current master
revision. Older desktop completions are skipped so they cannot roll production
back. When the exact immutable image is already healthy and traffic is ungated,
the update refreshes verified installers without repeating preflight, snapshots
or container cutover. Failed health or mismatched image identity follows the
normal deployment path. Installer failures still fail the workflow and can be
retried; exact live and public health verification still run afterward.

The protected `production` environment contains only these host credentials:
`PRODUCTION_DEPLOY_HOST`, `PRODUCTION_DEPLOY_PORT`,
`PRODUCTION_DEPLOY_USER`, `PRODUCTION_DEPLOY_SSH_KEY`, and
`PRODUCTION_DEPLOY_KNOWN_HOSTS`. The SSH account can invoke only the root-owned
copy of `deploy/github-actions-host.sh`; it has no interactive or forwarding
access. The host checkout's only remote is
`https://github.com/grm4871/fizzer.git`.

Do not add a deploy API, webhook listener, polling timer, request-file watcher,
or second workflow. `deploy/remote-update.sh` remains the internal cutover
primitive invoked by the forced host command, not an additional production
entrypoint.

The cutover script uses two fail-closed modes:

1. acquires the shared deploy lock;
2. requires the root-owned certification manifest for the exact full commit;
3. verifies the staged tag, immutable image ID, revision label, checksum, and
   embedded cutover approval;
4. checks disk space and removes only stale, non-running Compose containers;
5. runs the isolated database, HTTP, and Socket.IO preflight on that image and
   determines whether a complete candidate boot is logically state-identical;
6. for a state-identical release, warms the image on loopback port `39001`,
   verifies it against live state, and uses nginx's fixed `3000` primary / `39001`
   backup pair while the canonical Compose container is replaced;
7. verifies the canonical image directly, lets nginx's primary failure timer
   expire, then drains the temporary bridge without ever creating the
   maintenance marker;
8. for a release that intentionally changes persistent state, retains the
   mutation-free maintenance gate, checked snapshot, post-start data comparison,
   and automatic image/database rollback path;
9. verifies health, Engine.IO, authenticated reads/realtime, the public TLS edge,
   and the exact running image ID before promoting it to `cascade:latest`.

The rolling upstream is failover, not load balancing: the warmed candidate does
not receive public traffic until the previous primary stops accepting a
connection. Rollback starts the previous image against the same live state, so
writes accepted during the rolling handoff are preserved rather than rewound.

The Actions run is green only after the host and public checks pass. A pushed
commit or a healthy endpoint without matching revision evidence is not a
successful release.

## Deployment storage

Schema-identical rolling releases use a schema-only disposable database, not
full production copies. They require the 1 GiB free-space floor, and preserve
live writes on rollback. Full-copy capacity is checked only when startup changes
schema, before cloning data and again before closing the maintenance gate.

Migration capacity conservatively budgets `4 * (database + WAL) + 3 * corpus +
1 GiB` on the data filesystem; the snapshot filesystem must also have room for
`database + WAL + corpus + 1 GiB`. Corpus includes both vault files and QMD.
Reflink savings are never assumed. Disposable preflight clones are deleted after
the protocol check, before snapshot creation. The allowance includes checker
scratch, SQLite journals, the rollback copy, and post-start verification; rapid
concurrent growth or a larger migration can still exhaust the reserve and fail
closed. Deployment is not a substitute for provisioning space for growing data.

Unused Docker build cache is pruned toward 1 GB before the capacity checks and
after successful deployment, without an age delay. Active cache can exceed that
target. Images, active volumes, and recovery snapshots are not part of this prune.

Cutover snapshots contain a checkpointed, SHA-256-checked `docs.db` plus the
vault/QMD corpus. Automatic rollback restores the database only, while traffic is
gated and the candidate stopped; the corpus is used by compatibility verification.
These local snapshots are not a complete off-host disaster-recovery backup.
Historical snapshots currently have no automatic expiry. Selecting a retention
policy requires deciding which older recovery dates may be discarded; this
change preserves them all. Consequently their historical and future growth is
not bounded by the build-cache policy.

## Infrastructure security boundary

The checked-in nginx policy applies bounded per-address authentication, API,
web, and connection limits before the application allocates request bodies. It protects
the application process from ordinary abuse; it cannot absorb traffic that
saturates the VPS link. Volumetric DDoS protection requires a provider or
CDN/WAF in front of the host and therefore a DNS/account change outside a code
deployment.

`/var/lib/cascade` contains SQLite, Markdown, and note assets. Back it with an
encrypted provider volume or an OS-managed encrypted filesystem. Migrating the
live directory is deliberately not automated by a release: it requires an
authenticated infrastructure console, a verified backup, a maintenance window,
and post-copy ownership/data reconciliation. Application-level encryption with
a key stored beside the data would not protect a stolen volume.

## Verification

At minimum, verify:

```bash
curl -fsS "https://$FIZZER_DOMAIN/api/health"
```

On the host, also verify the container and checkout:

```bash
docker compose -f "$FIZZER_CHECKOUT/docker-compose.yml" ps
git -C "$FIZZER_CHECKOUT" rev-parse --short HEAD
curl -fsS http://127.0.0.1:3000/api/health
docker inspect --format '{{.Image}}' cascade
node "$FIZZER_CHECKOUT/deploy/certified-image.mjs" field \
  --manifest "/var/lib/cascade-release/certified-images/$(git -C "$FIZZER_CHECKOUT" rev-parse HEAD).json" \
  --name image.id
```

For a renderer release, load the production client and check for runtime
errors. The repository helper accepts a production URL:

```bash
node scripts/verify-client-runtime.mjs --no-preview "https://$FIZZER_DOMAIN/app.html"
```

## First-time production host setup

`deploy/deploy.sh <domain>` bootstraps nginx, certificates, environment, and the
Compose application. It requires the exact revision's certified image to have
been staged first, starts it with `--no-build`, and refuses to replace an
existing Cascade container. Install a root-owned copy of
`deploy/github-actions-host.sh` at `/usr/local/sbin/fizzer-github-deploy`, then
bind the dedicated locked SSH key to that forced command. Existing production
hosts release only through `Deploy Production`; the forced command invokes the
snapshot-backed `deploy/remote-update.sh` cutover.

Use `deploy/.env.example` as the minimal environment template and generate a
strong `JWT_SECRET`.

Private self-hosted instances are separate from this maintainer workflow; see
`docs/self-hosting.md` for their lifecycle.

## Client refresh behavior

Do not terminate Electron after a deployment; doing so kills active desktop
agent runs.

- Web clients observe `version.json` and reload automatically.
- Electron source builds use the sidebar **Update desktop app** action to
  fast-forward the checkout and reload renderer windows in place.
- `Ctrl/Cmd+R` reloads only the focused renderer.
- Do not use `Ctrl/Cmd+Shift+R` as a deployment follow-up because it relaunches
  the whole app.

Server-only compatible releases require no desktop refresh. In-flight agent
runs are designed to survive a model-server restart through runner reclaim.
