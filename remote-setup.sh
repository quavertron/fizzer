#!/usr/bin/env bash
set -Eeuo pipefail

# One-time Fizzer self-host setup for Debian/Ubuntu hosts.
# Run from the cloned repository as root:
#   bash remote-setup.sh
# Optional:
#   FIZZER_PUBLIC_URL=http://127.0.0.1:3000 bash remote-setup.sh

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DATA_DIR="${FIZZER_DATA_DIR:-/srv/fizzer/data}"
PUBLIC_URL="${FIZZER_PUBLIC_URL:-http://127.0.0.1:3000}"
ALLOWED_ORIGINS="${FIZZER_ALLOWED_ORIGINS:-${PUBLIC_URL}}"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.selfhost.yml"

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "Run this from the Fizzer repository; missing ${COMPOSE_FILE}." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose nginx certbot python3-certbot-nginx openssl curl

# Install Mutagen for live workspace file mirroring
if ! command -v mutagen >/dev/null 2>&1; then
  MUTAGEN_VERSION="v0.18.0"
  ARCH="$(uname -m)"
  case "${ARCH}" in
    x86_64) MUTAGEN_ARCH="amd64" ;;
    aarch64|arm64) MUTAGEN_ARCH="arm64" ;;
    *) echo "Warning: Mutagen binary not available for architecture: ${ARCH}" >&2; MUTAGEN_ARCH="" ;;
  esac

  if [[ -n "${MUTAGEN_ARCH}" ]]; then
    echo "Installing Mutagen ${MUTAGEN_VERSION} (${MUTAGEN_ARCH})..."
    curl -fsSL "https://github.com/mutagen-io/mutagen/releases/download/${MUTAGEN_VERSION}/mutagen_linux_${MUTAGEN_ARCH}_${MUTAGEN_VERSION}.tar.gz" \
      | tar -xz -C /usr/local/bin mutagen
    chmod 755 /usr/local/bin/mutagen
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker 2>/dev/null || true
fi
service docker start >/dev/null 2>&1 || true

mkdir -p "${DATA_DIR}"
chmod 750 "${DATA_DIR}"

ENV_FILE="${REPO_ROOT}/.env.selfhost"
if [[ ! -s "${ENV_FILE}" ]] || ! grep -q '^JWT_SECRET=' "${ENV_FILE}" || [[ "$(sed -n 's/^JWT_SECRET=//p' "${ENV_FILE}")" == "" ]]; then
  umask 077
  cat > "${ENV_FILE}" <<EOF_ENV
CASCADE_PUBLIC_URL=${PUBLIC_URL}
CASCADE_ALLOWED_ORIGINS=${ALLOWED_ORIGINS}
JWT_SECRET=$(openssl rand -hex 32)
FIZZER_DATA_DIR=${DATA_DIR}
EOF_ENV
else
  # Keep the existing secret/data directory, but refresh the URL settings supplied
  # for this invocation.
  sed -i "s#^CASCADE_PUBLIC_URL=.*#CASCADE_PUBLIC_URL=${PUBLIC_URL}#; s#^CASCADE_ALLOWED_ORIGINS=.*#CASCADE_ALLOWED_ORIGINS=${ALLOWED_ORIGINS}#; s#^FIZZER_DATA_DIR=.*#FIZZER_DATA_DIR=${DATA_DIR}#" "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"
# Docker Compose v1 reads .env for interpolation; v2 also accepts this file.
cp "${ENV_FILE}" "${REPO_ROOT}/.env"
chmod 600 "${REPO_ROOT}/.env"

# The Dockerfile copies docs/user-guide.md, while the checked-in ignore file
# excludes docs. Temporarily allow that single runtime document during the build,
# then restore the repository file even if the build fails.
DOCKERIGNORE="${REPO_ROOT}/.dockerignore"
DOCKERIGNORE_BACKUP="${DOCKERIGNORE}.remote-setup-backup"
restore_dockerignore() {
  if [[ -f "${DOCKERIGNORE_BACKUP}" ]]; then
    mv -f "${DOCKERIGNORE_BACKUP}" "${DOCKERIGNORE}"
  fi
}
trap restore_dockerignore EXIT
if grep -qx 'docs' "${DOCKERIGNORE}" && [[ -f "${REPO_ROOT}/docs/user-guide.md" ]]; then
  cp "${DOCKERIGNORE}" "${DOCKERIGNORE_BACKUP}"
  sed -i '/^docs$/d' "${DOCKERIGNORE}"
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is not available after installation." >&2
  exit 1
fi

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
cd "${REPO_ROOT}"
# The image runs as the unprivileged node user (UID 1000).
chown -R 1000:1000 "${DATA_DIR}"
"${COMPOSE[@]}" -f "${COMPOSE_FILE}" up -d --build

for attempt in {1..30}; do
  if curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then
    echo "Fizzer is healthy at ${PUBLIC_URL}"
    echo "Data directory: ${DATA_DIR}"
    echo "For local testing through SSH: ssh -N -L 3000:127.0.0.1:3000 root@SERVER_IP"
    echo "For live folder mirroring: mutagen sync create --sync-mode=one-way-replica root@SERVER_IP:${DATA_DIR}/.cascade/vaults/<vault_id>/workspace ~/.fizzer/vaults/<vault_id>/replica"
    exit 0
  fi
  sleep 2
done

echo "Fizzer did not become healthy. Recent logs:" >&2
"${COMPOSE[@]}" -f "${COMPOSE_FILE}" logs --tail=80 fizzer >&2 || true
exit 1
