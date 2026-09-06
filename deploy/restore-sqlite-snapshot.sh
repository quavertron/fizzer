#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/deploy/deploy-lock.sh"
acquire_cascade_deploy_lock "$ROOT"

SNAPSHOT_DIR="${1:?snapshot directory is required}"
LIVE_DB="${2:?live database path is required}"
REVISION="${3:?revision is required}"
SNAPSHOT_DB="$SNAPSHOT_DIR/docs.db"
CHECKSUM_FILE="$SNAPSHOT_DIR/docs.db.sha256"
DATA_DIR="$(dirname "$LIVE_DB")"

if [[ ! -f "$SNAPSHOT_DB" || ! -f "$CHECKSUM_FILE" || -L "$SNAPSHOT_DB" || -L "$CHECKSUM_FILE" ]]; then
  echo "Error: rollback snapshot or checksum is missing." >&2
  exit 1
fi
if [[ -L "$LIVE_DB" || ! -f "$LIVE_DB" ]]; then
  echo "Error: live database must be a regular file, not a symlink." >&2
  exit 1
fi
if [[ ! "$REVISION" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "Error: unsafe rollback revision '$REVISION'." >&2
  exit 1
fi

expected_checksum="$(awk 'NR == 1 && $2 == "docs.db" { print $1 }' "$CHECKSUM_FILE")"
actual_checksum="$(sha256sum "$SNAPSHOT_DB" | awk '{ print $1 }')"
if [[ ! "$expected_checksum" =~ ^[a-fA-F0-9]{64}$ || "$actual_checksum" != "$expected_checksum" ]]; then
  echo "Error: refusing to restore a snapshot that failed its SHA-256 check." >&2
  exit 1
fi

restore_tmp="$DATA_DIR/.$(basename "$LIVE_DB").rollback-$REVISION"
cleanup_restore_tmp() {
  find "$restore_tmp" -maxdepth 0 -type f -delete 2>/dev/null || true
}
trap cleanup_restore_tmp EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp --remove-destination --reflink=auto --sparse=always --preserve=mode,ownership,timestamps \
  "$SNAPSHOT_DB" "$restore_tmp"
if [[ -L "$restore_tmp" || ! -f "$restore_tmp" ]]; then
  echo "Error: rollback copy did not produce a regular database file." >&2
  exit 1
fi
mv -fT "$restore_tmp" "$LIVE_DB"
find "$LIVE_DB-wal" "$LIVE_DB-shm" -maxdepth 0 -type f -delete 2>/dev/null || true

trap - EXIT INT TERM
