#!/bin/bash
# Run in a terminal as the human. sudo handles the password; Fizzer never reads it.
set -euo pipefail
export PATH=${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin
fail() { echo "Error: $*" >&2; exit 1; }

ignore_nab_history() {
  local ignore_file
  ignore_file=$(git config --global --path --get core.excludesFile || true)
  if [[ -z $ignore_file ]]; then
    ignore_file=${XDG_CONFIG_HOME:-$HOME/.config}/git/ignore
    git config --global core.excludesFile "$ignore_file"
  fi
  mkdir -p "$(dirname "$ignore_file")"
  touch "$ignore_file"
  if ! /usr/bin/grep -Fxq '*.nab' "$ignore_file"; then
    # Start a new line even if the existing file has no final newline.
    printf '\n%s\n' '*.nab' >> "$ignore_file"
  fi
}

script_dir=$(cd "$(dirname "$0")" && pwd)
account_setup=$script_dir/setup-fizzer-user.sh
[[ -f $account_setup ]] || account_setup=$script_dir/scripts/setup-fizzer-user.sh
prefix=/usr/local/libexec/fizzer

if [[ ${1:-} == --privileged ]]; then
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  [[ $EUID == 0 && $# == 3 ]] || fail 'Internal installation requires sudo.'
  human=${SUDO_USER:-}
  [[ $human =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*$ && $human != root && $human != fizzer ]] || fail 'Run from your normal account.'
  binary=$2
  uid=$(id -u "$human")
  [[ $3 == "$uid" ]] || fail 'Invoking account changed.'
  command -v visudo >/dev/null || fail 'Install sudo/visudo first.'
  # A standard include is required; do not rewrite the administrator sudoers file.
  if ! /usr/bin/grep -Eq '^[[:space:]]*([@#]includedir)[[:space:]]+(/private)?/etc/sudoers.d/?[[:space:]]*$' /etc/sudoers; then
    fail 'sudoers must include /etc/sudoers.d before installation.'
  fi
  if ! id -u fizzer >/dev/null 2>&1; then /bin/bash "$account_setup" --apply; fi
  agent_uid=$(id -u fizzer)
  [[ $agent_uid != 0 && $agent_uid != "$uid" ]] || fail 'fizzer must have its own non-root UID.'
  for group in $(id -Gn fizzer); do
    case $group in admin|sudo|wheel) fail 'fizzer must not belong to an administrator group.' ;; esac
  done
  for directory in /usr/local /usr/local/libexec "$prefix" /etc/sudoers.d; do
    [[ ! -L $directory ]] || fail "Refusing installation through symlink: $directory"
  done
  install -d -m 755 -o root "$prefix"
  [[ ! -L $prefix/alock ]] || fail 'Refusing an installed alock symlink.'
  tools_dir=$(dirname "$binary")
  for tool in alock awatch nab purrvect; do
    [[ -f $tools_dir/$tool && ! -L $prefix/$tool ]] || fail "Missing tool or unsafe destination: $tool"
    install -m 755 -o root "$tools_dir/$tool" "$prefix/$tool"
  done
  for library in "$tools_dir"/*.dylib "$tools_dir"/*.so*; do
    [[ -f $library ]] || continue
    target=$prefix/$(basename "$library")
    [[ ! -L $target ]] || fail "Refusing installed library symlink: $target"
    install -m 755 -o root "$library" "$target"
  done
  [[ ! -L $prefix/licenses ]] || fail 'Refusing installed license directory symlink.'
  install -d -m 755 -o root "$prefix/licenses"
  for notice in "$tools_dir/licenses"/*; do
    [[ -f $notice ]] || continue
    target=$prefix/licenses/$(basename "$notice")
    [[ ! -L $target ]] || fail "Refusing installed license symlink: $target"
    install -m 644 -o root "$notice" "$target"
  done
  install -d -m 750 -o root /etc/sudoers.d
  rule=$(mktemp /etc/sudoers.d/.fizzer-install.XXXXXX)
  trap 'rm -f "$rule"' EXIT
  printf '%s ALL=(fizzer) NOPASSWD: ALL\n' "$human" > "$rule"
  chmod 440 "$rule"
  visudo -cf "$rule"
  mv "$rule" "/etc/sudoers.d/fizzer-$uid"
  echo 'Installed alock and permission for your account to launch processes as fizzer.'
  exit 0
fi

[[ $EUID != 0 ]] || fail 'Run this script as yourself, without sudo.'
case $(uname -s) in Darwin|Linux) ;; *) fail 'Supported on macOS and Linux only.' ;; esac
update=false
if [[ ${1:-} == --update ]]; then update=true; shift; fi
[[ $# -le 1 ]] || fail "Usage: bash $0 [--update] [path/to/alock]"
binary=${1:-${FIZZER_ALOCK_BIN:-}}
if [[ -z $binary && -x $script_dir/alock ]]; then binary=$script_dir/alock; fi
if [[ -z $binary ]]; then
  # The repository carries all five projects; no sibling checkout or Git fetch.
  build_dir=$(mktemp -d)
  trap 'rm -rf "$build_dir"' EXIT
  [[ -f $script_dir/scripts/build-agent-tools.mjs ]] || fail 'Missing bundled tools and source builder; use a complete Fizzer checkout or release.'
  echo 'Building bundled awatch, alock, nab, libdtob and purrvect...'
  node "$script_dir/scripts/build-agent-tools.mjs" "$build_dir/tools"
  binary=$build_dir/tools/alock
fi
binary=${binary:-$script_dir/alock}
[[ -x $binary ]] || fail 'Native alock is missing. Pass the path to an alock binary built with bridge support.'
help=$("$binary" bridge --help 2>&1 || true)
[[ $help == *'alock bridge serve'* ]] || fail 'alock needs native bridge support.'
[[ $help == *'alock bridge mkdir'* ]] || fail 'alock needs file-creation support; rebuild from current source.'
[[ $help == *'--author NAME'* ]] || fail 'alock needs mandatory-author support; rebuild from current source.'
[[ $help == *'--replace-symlink'* && $help == *'--delete'* ]] || fail 'alock needs deletion and symlink support; rebuild from current source.'
[[ $help == *'--turn'* ]] || fail 'alock needs turn-aware history support; rebuild from current source.'
binary=$(cd "$(dirname "$binary")" && pwd)/$(basename "$binary")
for tool in awatch nab purrvect; do
  [[ -x $(dirname "$binary")/$tool ]] || fail "The helper bundle is missing $tool; run npm run build:agent-tools."
done
echo 'This creates a fizzer account, installs alock, and lets your account launch agents as fizzer.'
echo 'All agents get human-account-wide alock access by default, across projects and chats. Explicit per-agent restrictions are preserved. No root privileges are granted.'
echo 'No agent hooks are installed. Existing project permissions are unchanged.'
echo 'New installations enable nab history; explicit history and access preferences are preserved.'
sudo /bin/bash "$script_dir/install-agent-writes.sh" --privileged "$binary" "$(id -u)"
sudo -n -H -u fizzer /usr/bin/id -u >/dev/null
ignore_nab_history
config_dir=${XDG_CONFIG_HOME:-$HOME/.config}
mkdir -p "$config_dir"
# Preserve existing settings, including an explicit nab = false. Prepending puts
# the default at the top level even when the existing file ends inside a table.
config_file=$config_dir/alock.toml
if [[ ! -e $config_file ]]; then
  (umask 077; set -o noclobber; printf 'nab = true\n' > "$config_file")
elif ! awk '/^[[:space:]]*\[/ { exit } /^[[:space:]]*nab[[:space:]]*=/ { found=1 } END { exit !found }' "$config_file"; then
  config_tmp=$(mktemp "$config_dir/.alock.toml.XXXXXX")
  { printf 'nab = true\n'; cat "$config_file"; } > "$config_tmp"
  mv "$config_tmp" "$config_file"
fi
data_dir=${CASCADE_DATA_DIR:-$HOME/.fizzer}
mkdir -p "$data_dir"
umask 077
if [[ ! -e $data_dir/agent-write-access-default.json ]]; then
  (set -o noclobber; printf '{"scope":"human"}\n' > "$data_dir/agent-write-access-default.json")
fi
printf '1\n' > "$data_dir/agent-writes-enabled"
rm -f "$data_dir/agent-writes-declined"
if [[ $update == true ]]; then
  echo 'Agent write bridge updated. Existing access settings and credentials are preserved. New runs use the updated helper; existing runs must finish first.'
  exit 0
fi
for entry in 'Codex:.codex/auth.json' 'Claude:.claude/.credentials.json'; do
  provider=${entry%%:*}
  relative=${entry#*:}
  source=$HOME/$relative
  if [[ -f $source && ! -L $source ]]; then
    answer=
    read -r -p "Copy your existing $provider credential file to the fizzer account? [y/N] " answer || true
    if [[ $answer == y || $answer == Y ]]; then
      # Only the selected file crosses accounts, on stdin rather than argv/logs.
      sudo -n -H -u fizzer /bin/sh -c '
        set -eu
        umask 077
        target="$HOME/$1"
        mkdir -p "$(dirname "$target")"
        temporary=$(mktemp "$(dirname "$target")/.auth-copy.XXXXXX")
        trap '\''rm -f "$temporary"'\'' EXIT
        cat > "$temporary"
        mv "$temporary" "$target"
      ' sh "$relative" < "$source"
      echo "Copied selected $provider credentials."
    fi
  else
    echo "$provider: no portable credential file found; sign in under fizzer if needed (Keychain logins are not copied)."
  fi
done
echo 'Agent account setup complete. Providers without copied credentials need a sign-in under fizzer.'
