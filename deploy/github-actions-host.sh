#!/usr/bin/env bash
# Root-owned forced command for the production GitHub Actions deploy identity.
set -euo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ROOT=/var/www/fizzer
REMOTE=https://github.com/grm4871/fizzer.git
DOMAIN=cscd.online
# Retain the live Compose project identity while removing the stale checkout
# path; this preserves container ownership across the first consolidated deploy.
export COMPOSE_PROJECT_NAME=cascade-browser

read -r action revision extra <<<"${SSH_ORIGINAL_COMMAND:-}"
if [[ -n "${extra:-}" || ! "$revision" =~ ^[0-9a-f]{40}$ ]] ||
   [[ "$action" != "deploy" && "$action" != "verify" ]]; then
  echo "Error: expected deploy or verify followed by one full revision SHA." >&2
  exit 2
fi

cd "$ROOT"
if [[ "$(git remote get-url origin)" != "$REMOTE" ]]; then
  echo "Error: production origin is not the public Fizzer repository." >&2
  exit 1
fi

exec {DEPLOY_LOCK_FD}<"$ROOT"
echo "==> Waiting for the production deploy lock"
flock -w 1800 "$DEPLOY_LOCK_FD"
export CASCADE_DEPLOY_LOCK_HELD=1

verify_revision() {
  local checkout_revision running_image certified_image running_revision health
  checkout_revision="$(git rev-parse HEAD)"
  running_image="$(docker inspect --format '{{.Image}}' cascade)"
  certified_image="$(docker image inspect --format '{{.Id}}' "cascade:certified-$revision")"
  running_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$running_image")"
  health="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 10 http://127.0.0.1:3000/api/health)"

  [[ "$checkout_revision" == "$revision" ]]
  [[ "$running_image" == "$certified_image" ]]
  [[ "$running_revision" == "$revision" ]]
  [[ "$health" == *'"status":"ok"'* ]]
  [[ ! -e /run/cascade-maintenance ]]

  echo "LIVE_REVISION=$running_revision"
  echo "LIVE_IMAGE=$running_image"
  echo "INTERNAL_HEALTH=$health"
}

if [[ "$action" == "verify" ]]; then
  verify_revision
  exit 0
fi

echo "==> Fetching the public Fizzer master"
git fetch --force --no-tags origin refs/heads/master
master_revision="$(git rev-parse FETCH_HEAD)"
git cat-file -e "$revision^{commit}"
if ! git merge-base --is-ancestor "$revision" "$master_revision"; then
  echo "Error: requested revision is not on the public Fizzer master branch." >&2
  exit 1
fi

echo "==> Checking out exact triggering revision $revision"
git reset --hard "$revision"
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Error: production checkout is not clean after exact-revision checkout." >&2
  git status --short >&2
  exit 1
fi

image="cascade:certified-$revision"
if docker image inspect "$image" >/dev/null 2>&1; then
  echo "==> Reusing immutable image $image"
else
  echo "==> Building immutable image $image"
  bash deploy/build-release-image.sh
fi

echo "==> Running snapshot-safe immutable-image cutover"
CASCADE_DEPLOY_DOMAIN="$DOMAIN" bash deploy/remote-update.sh
verify_revision

# Operator-installed scoped retention survives exact-revision checkout/reset.
# Run only after successful cutover/healthy exact-revision retry, under this lock.
python3 /usr/local/lib/fizzer/prune-release-images.py --apply --lock-fd "$DEPLOY_LOCK_FD"
