#!/bin/bash
# One-command macOS account + native alock bridge smoke test.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
fail() { echo "Error: $*" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || fail 'This test currently supports macOS only.'
[[ $EUID != 0 ]] || fail 'Run with bash, not sudo; the bridge must run as your normal user.'
[[ $# -le 1 ]] || fail "Usage: bash $0 [path/to/alock]"
script_dir=$(cd "$(dirname "$0")" && pwd)
binary=${1:-/usr/local/libexec/fizzer/alock}
[[ -x $binary ]] || fail "Build alock first; binary not found: $binary"
help=$("$binary" bridge --help 2>&1 || true)
[[ $help == *'alock bridge serve'* ]] || fail 'This alock binary does not include the native bridge.'

echo 'Administrator authentication is needed to create/use the separate fizzer account.'
sudo -v
if ! dscl . -read /Users/fizzer UniqueID >/dev/null 2>&1; then
  sudo /bin/bash "$script_dir/setup-fizzer-user.sh" --apply
fi
sudo /bin/bash "$script_dir/setup-fizzer-user.sh" --test

fixture=$(mktemp -d /private/tmp/fizzer-bridge.XXXXXX)
server_pid=
proposals=()
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n $server_pid ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ $status != 0 && -f $fixture/server.log ]]; then cat "$fixture/server.log" >&2; fi
  for proposal in ${proposals[@]+"${proposals[@]}"}; do
    sudo -n -u fizzer /bin/rm -f "$proposal" 2>/dev/null || true
  done
  chmod -N "$fixture/project" 2>/dev/null || true
  rm -rf "$fixture"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$fixture/project"
# Reproduce the standard macOS home ACL that previously broke real vaults.
chmod +a 'everyone deny delete' "$fixture/project"
printf 'original\n' > "$fixture/project/note.txt"
cp "$binary" "$fixture/alock"
chmod 755 "$fixture" "$fixture/project" "$fixture/alock"
chmod 644 "$fixture/project/note.txt"
endpoint=$fixture/socket
"$fixture/alock" bridge serve --socket "$endpoint" --root "$fixture/project" --user fizzer >"$fixture/server.log" 2>&1 &
server_pid=$!
ready=false
for ((attempt=0; attempt<100; attempt++)); do
  if [[ $(cat "$fixture/server.log") == *'Bridge ready:'* ]]; then ready=true; break; fi
  kill -0 "$server_pid" 2>/dev/null || fail 'Bridge exited during startup.'
  sleep 0.1
done
[[ $ready == true ]] || fail 'Bridge did not become ready within 10 seconds.'

stage() {
  local response
  response=$(sudo -n -u fizzer "$fixture/alock" bridge stage --socket "$endpoint" --path "${1:-note.txt}")
  ticket=$(printf '%s' "$response" | plutil -extract ticket raw -o - -)
  proposal=$(printf '%s' "$response" | plutil -extract file raw -o - -)
  [[ $proposal == /tmp/alock-proposal-* && $ticket =~ ^[0-9a-f]{48}$ ]] || fail 'Unexpected stage response.'
  proposals+=("$proposal")
  sudo -n -u fizzer /bin/sh -c 'printf "edited by fizzer\n" > "$1"' sh "$proposal"
}
commit() {
  sudo -n -u fizzer "$fixture/alock" bridge commit --socket "$endpoint" --ticket "$ticket" --file "$proposal" --author fizzer-test
}

stage
commit > /dev/null
[[ $(cat "$fixture/project/note.txt") == 'edited by fizzer' ]] || fail 'Committed content does not match.'
echo 'PASS: fizzer temp-file proposal committed through the human-owned bridge'

stage
printf 'human edit\n' > "$fixture/project/note.txt"
if commit >"$fixture/rejection.log" 2>&1; then fail 'Stale proposal was unexpectedly accepted.'; fi
[[ $(cat "$fixture/rejection.log") == *'File changed since staging'* ]] || fail 'Commit failed for an unexpected reason.'
[[ $(cat "$fixture/project/note.txt") == 'human edit' ]] || fail 'Human edit was overwritten.'
echo 'PASS: stale proposal rejected; direct human edit preserved'
sudo -n -u fizzer "$fixture/alock" bridge mkdir --socket "$endpoint" --path package --author fizzer-test > /dev/null
stage package/main.go
[[ ! -e $fixture/project/package/main.go ]] || fail 'Creation published before commit.'
commit > /dev/null
[[ $(cat "$fixture/project/package/main.go") == 'edited by fizzer' ]] || fail 'New-file content does not match.'
echo 'PASS: directory and new file created through the bridge'
echo 'All checks passed. Temporary files and bridge process are cleaned up; the fizzer account remains.'
