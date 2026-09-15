#!/bin/bash
# macOS/Linux. Run without arguments to inspect; --apply creates the account.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

fail() { echo "Error: $*" >&2; exit 1; }
mode=${1:---check}
case "$mode" in --check|--apply|--test) ;; *) fail "Usage: bash $0 [--check|--apply|--test]" ;; esac
[[ $# -le 1 ]] || fail 'Expected one option.'
platform=$(uname -s)
[[ $platform == Darwin || $platform == Linux ]] || fail 'This setup supports macOS and Linux.'

account_exists() { id -u fizzer >/dev/null 2>&1; }
if [[ $mode == --check ]]; then
  if account_exists; then
    id fizzer
  else
    echo 'No fizzer account exists.'
  fi
  echo 'Apply creates a non-admin, password-disabled account with a private group and home.'
  echo 'It does not change project permissions, install hooks, or configure agent launching.'
  echo "Run: sudo bash $0 --apply"
  exit 0
fi

[[ $EUID == 0 ]] || fail 'Run this option with sudo from your terminal.'
human=${SUDO_USER:-}
[[ -n $human && $human != root && $human != fizzer ]] || fail 'Run sudo from your normal human account.'

if [[ $mode == --apply ]]; then
  # Do not modify an existing account or adopt a pre-existing home/group.
  account_exists && fail 'Account fizzer already exists; left unchanged. Use --test to check permissions.'
  if [[ $platform == Linux ]]; then
    command -v useradd >/dev/null || fail 'Install the distribution useradd utility first.'
    [[ ! -e /var/lib/fizzer && ! -L /var/lib/fizzer ]] || fail '/var/lib/fizzer already exists; left unchanged.'
    if getent group fizzer >/dev/null; then fail 'Group fizzer already exists; left unchanged.'; fi
    useradd --system --user-group --create-home --home-dir /var/lib/fizzer --shell /bin/false --password '*' fizzer
    chmod 700 /var/lib/fizzer
    echo 'Created non-admin fizzer account. No project permissions changed.'
    exit 0
  fi
  [[ ! -e /Users/fizzer && ! -L /Users/fizzer ]] || fail '/Users/fizzer already exists; left unchanged.'
  if dscl . -read /Groups/fizzer >/dev/null 2>&1; then fail 'Group fizzer already exists; left unchanged.'; fi
  mkdir /var/run/fizzer-user-setup.lock 2>/dev/null || fail 'Setup lock exists; check for another setup process.'
  trap 'rmdir /var/run/fizzer-user-setup.lock' EXIT
  # Select an unused local ID for both records. Fail on any directory-service error.
  users=$(dscl . -list /Users UniqueID)
  groups=$(dscl . -list /Groups PrimaryGroupID)
  next_id=$(printf '%s\n%s\n' "$users" "$groups" | awk 'BEGIN { n=500 } $NF ~ /^[0-9]+$/ && $NF > n && $NF < 60000 { n=$NF } END { print n+1 }')
  [[ $next_id -lt 60000 ]] || fail 'No automatic account ID available.'
  echo "Creating fizzer with UID/GID $next_id. If creation fails, inspect the partial records before retrying."
  dscl . -create /Groups/fizzer
  dscl . -create /Groups/fizzer PrimaryGroupID "$next_id"
  dscl . -create /Groups/fizzer Password '*'
  dscl . -create /Users/fizzer
  dscl . -create /Users/fizzer UniqueID "$next_id"
  dscl . -create /Users/fizzer PrimaryGroupID "$next_id"
  dscl . -create /Users/fizzer RealName 'Fizzer agents'
  dscl . -create /Users/fizzer NFSHomeDirectory /Users/fizzer
  dscl . -create /Users/fizzer UserShell /usr/bin/false
  dscl . -create /Users/fizzer Password '*'
  dscl . -create /Users/fizzer IsHidden 1
  install -d -m 700 -o "$next_id" -g "$next_id" /Users/fizzer
  echo 'Created account. No admin membership, sudo rules, hooks, or project changes added.'
  echo "Run the disposable test: sudo bash $0 --test"
  exit 0
fi

account_exists || fail 'Create the account with --apply first.'
[[ $(id -u fizzer) != 0 ]] || fail 'Refusing to test a root-equivalent account.'
for group in $(id -Gn fizzer); do
  case $group in admin|sudo|wheel) fail 'fizzer belongs to an administrator group.' ;; esac
done
fixture=$(mktemp -d /tmp/fizzer-permissions.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
chmod 755 "$fixture"
install -d -m 755 -o "$human" "$fixture/managed"
install -d -m 700 -o fizzer "$fixture/staging"
sudo -u "$human" /bin/sh -c 'printf "original\n" > "$1"; chmod 644 "$1"' sh "$fixture/managed/config"

deny() {
  local label=$1; shift
  if sudo -u fizzer "$@" >"$fixture/output" 2>&1; then fail "$label unexpectedly succeeded"; fi
  echo "PASS: $label denied"
}
sudo -u fizzer /bin/cat "$fixture/managed/config" >/dev/null
echo 'PASS: agent can read managed content'
deny 'direct write' /bin/sh -c 'printf bad > "$1"' sh "$fixture/managed/config"
if [[ $platform == Darwin ]]; then
  deny 'sed in-place edit' /usr/bin/sed -i '' 's/original/bad/' "$fixture/managed/config"
else
  deny 'sed in-place edit' /usr/bin/sed -i 's/original/bad/' "$fixture/managed/config"
fi
sudo -u fizzer /bin/sh -c 'printf "proposal\n" > "$1"' sh "$fixture/staging/proposal"
echo 'PASS: agent can write its own temporary proposal'
deny 'atomic replacement' /bin/mv -f "$fixture/staging/proposal" "$fixture/managed/config"
if [[ -x /usr/bin/python3 ]] && /usr/bin/python3 --version >/dev/null 2>&1; then
  deny 'Python write' /usr/bin/python3 -c 'import sys; open(sys.argv[1], "w").write("bad")' "$fixture/managed/config"
else
  echo 'SKIP: Python write test (system Python unavailable)'
fi
[[ $(cat "$fixture/managed/config") == original ]] || fail 'Managed content changed.'
sudo -u "$human" /bin/sh -c 'printf "human edit\n" > "$1"' sh "$fixture/managed/config"
[[ $(cat "$fixture/managed/config") == 'human edit' ]] || fail 'Human edit failed.'
echo 'PASS: human retains direct editing access'
echo 'Permission test passed in a disposable directory; existing projects were not modified.'
echo 'The cross-user alock bridge and Fizzer agent launcher are not implemented by this script.'
