# Agent-account setup (macOS and Linux)

On macOS and Linux, desktop setup is available explicitly in Account settings →
Preferences → Agent file-write coordination (alock). It never opens at startup.
The dialog only displays or copies a terminal command; it does not install,
enable access, run sudo, or read credentials. It remains available after a prior
decline or installation. Existing grants and installer defaults are unchanged.
The TUI's optional startup prompt is unchanged: Enter leaves raw mode and runs
the installer so sudo reads the password directly. Neither application collects
an administrator password. The decline marker controls the TUI prompt only.

To enable the integrated launcher from a development checkout:

```sh
bash install-agent-writes.sh
```

This one command installs/enables the bridge and defaults to human-account-wide write
access for all current and future agents, including runs without a chat
registration. No per-agent setup is required. It still asks for sudo and offers
credential copying. Both desktop and TUI use the same installation default.

Existing global access settings and per-agent overrides are preserved on reruns.
The checkout installer builds the five projects in `vendor/` in a temporary directory:
alock, nab, awatch, purrvect, and one shared libdtob. No sibling checkout or GitLab
fetch is needed. Source builds require Node, Go, make, C/C++ compilers, CMake,
pkg-config, and ThorVG >= 1.0.7. Go resolves dependencies from its checked-in go.sum.
Packaged installations include the four executables and purrvect's shared libraries.
An explicit alock path or `FIZZER_ALOCK_BIN` selects a complete helper bundle in
that directory. To update an existing installation
without repeating credential-copy prompts:

```sh
bash install-agent-writes.sh --update
```

New runs use the updated helper; existing runs must finish first. On macOS,
`bash scripts/test-fizzer-bridge.sh` tests the installed binary, including the
standard home-directory deny-delete ACL.

## Working directory versus write access

The working directory selects where the provider starts. Local write grants
independently select where its human-owned alock bridges accept file
proposals. Configure a registration from your normal account:

```sh
node scripts/configure-agent-writes.cjs --server http://127.0.0.1:62465 --vault VAULT_ID --agent REGISTRATION_ID --scope human
```

Scopes are `workspace`, `human` (the installer default: any location accepted by
the human-owned bridge), or `folders` with one or more `--folder /absolute/path`
arguments. Use `workspace` to revoke broader access for subsequent runs.
Per-agent overrides apply to one server origin, vault and channel agent
registration and take precedence over `agent-write-access-default.json`.
New registrations, servers and non-chat runs inherit the installation default.
Without either policy, the fallback is workspace-only. The installer preserves
explicit per-agent restrictions. Existing runs retain their starting grants; cancel them to
revoke immediately. Both Electron and TUI runners read these local policies.
This initial configuration interface is the script, not a new GUI/TUI control.

Policies live in private `~/.fizzer/agent-write-access` files, updated atomically
per registration. Remote prompts cannot supply these grants. Human scope uses
a bridge rooted at `/`, with relative paths such as `Users/diego/project/file`;
it does not run as root or change any filesystem permissions. Existing alock
checks still reject symlink parents, hardlinks, permission-granting ACLs,
group/other-writable targets, and files the human cannot replace. It is therefore
more restrictive than an unrestricted human shell. The agent can still directly
write its own temporary files and credentials; this is not a guarantee that all
writes everywhere are mediated. Rename and directory deletion remain unsupported.
Stage with `--delete` then commit with `--delete` to remove a file or symlink.
Stage with `--replace-symlink` to replace a link with regular-file proposal contents,
or `--symlink` to set its new target from proposal text (no newline or NUL).
Both use the normal `--file` commit and never modify the link's referent.
All bridge commits and directory creations require `--author NAME`; the runner
instructs agents to supply their chat author. Alock can record accepted changes
with its embedded nab when `~/.config/alock.toml` contains `nab = true`. This is
an alock preference, not a Fizzer-only setting. Setup adds `nab = true` when
the top-level setting is absent and preserves explicit choices, including false.

To create a file, use `bridge stage --path RELATIVE_FILE` as for an edit. A missing
file returns an empty temporary proposal and remains absent until commit.
Commit publishes without overwriting a competing creator; abort leaves no file.
Parents must exist. Create missing directories with `bridge mkdir --path RELATIVE_DIRECTORY`
one parent at a time, using the same authorized socket. Directory creation is
immediate, not staged, and refuses existing entries. New files use mode 0644;
new directories use 0755 subject to the human runner's umask.

This installs native alock under `/usr/local/libexec/fizzer`, creates the
non-admin account if needed, and installs one `/etc/sudoers.d/fizzer-UID` rule.
The rule permits only the invoking human to launch processes **as fizzer**;
it grants no sudo rights to fizzer. Setup requires the normal sudoers.d include
and does not edit the main sudoers file. Linux needs sudo/visudo and useradd.

Setup individually offers to copy `.codex/auth.json` and
`.claude/.credentials.json` if present. Copying is opt-in for each provider,
uses stdin rather than command-line secrets, and writes private files as the
agent account. Keychain-only logins and other providers require separate sign-in.
No whole profile or automatic credential synchronization is installed.

Once `agent-writes-enabled` exists in the Fizzer data directory, new local runs
start a human-owned native bridge and a worker launched through
`sudo -n -H -u fizzer`. Both Electron and the TUI's headless runner use this path.
Existing running agents are not migrated. Restart older GUI/TUI clients and
headless runners after upgrading to pick up the new launcher. Provider executables, Node/Electron,
and application resources must be executable/readable by the agent account.
Missing permissions, setup, credentials, or a failed bridge produce a failed run;
there is no silent fallback to the human UID.

Before running, the worker checks the entire project under its actual UID for
direct write access. The configured agent working directory takes precedence
over the vault folder; the bridge and provider use the same resolved directory.
Writable entries and traversable but unreadable directories block launch.
Private directories the agent cannot traverse are skipped.
Read-only symlink targets are checked too, with cycles visited only once;
dangling links are skipped. The bridge still rejects edits through symlinks.
This can take time in large trees. Existing project permissions
are never changed automatically. Human permission changes during a run can
still invalidate the initial check.

The owner's vault API token stays in the human runner. Agent helper requests
receive a temporary read-only proxy limited to the selected vault; API
mutations and non-vault-scoped endpoints are unavailable in this mode. This
prevents note API writes from bypassing filesystem coordination. Normal agent
responses still return through the runner's existing event connection.

Current limits: no rename, directory deletion, or remote-server commit bridge.
Provider session history under the human account is not migrated by credential
copying. Stop account mode by removing `agent-writes-enabled` from the Fizzer
data directory. Remove `agent-writes-declined` there to offer setup again.

Packaged desktop/TUI builds include the native helper bundle and installer.
Build it on the target OS/architecture with `npm run build:agent-tools`, or set
`FIZZER_ALOCK_BIN` to alock in a complete native helper bundle. Packaging fails
if the required tools or bridge capabilities are missing. Cross-OS TUI packaging
is refused rather than including the wrong native binary. Windows does not offer
this feature.

After installation, test the integrated runner without contacting a provider:

```sh
node scripts/test-agent-account-runner.cjs
```

This runs a fake provider under the actual fizzer UID, checks a denied direct
write and a successful alock commit, tests cancellation, and verifies that a
writable project is rejected before provider launch.

From the repository root:

```sh
bash scripts/test-fizzer-bridge.sh
```

This prompts for sudo, creates the account if missing, runs the disposable
permissions test, then tests a native bridge commit and rejection of a stale
proposal. It stops its bridge and removes test files afterward; the account
remains. By default it uses `/usr/local/libexec/fizzer/alock`; an alternate
binary path may be supplied as the script's only argument. Run it as yourself,
not under sudo. Account-only setup/inspection remains available through
`scripts/setup-fizzer-user.sh` (`--check`, `--apply`, or `--test`).

The account has a dedicated group, a private `/Users/fizzer` home, disabled
password login, a non-login shell, and no added administrator or sudo privileges.
An administrator can still execute an explicit command with `sudo -u fizzer`.
Setup refuses to modify an existing account, group, or home. A failed setup may
leave partial directory-service records; inspect them before cleanup or retry.
The script installs no hooks and changes no existing project permissions.

The test uses disposable files. It checks that the agent can read a managed
file, write a temporary proposal, and cannot directly overwrite or atomically
replace the managed file. It also checks sed and, when available, Python, and
confirms that the human can still edit directly. This test does not establish
that existing projects have suitable permissions.

## How the alock bridge works

```text
Agent (UID fizzer)
  reads permitted project files
  writes proposal in its own temporary directory
            |
            | target + base revision + proposed content
            v
Bridge (UID of the human, e.g. diego)
  authenticates peer; checks the authorized root and allowed path
  snapshots proposal; validates base revision
            |
            v
alock (same human UID)
  stages/coordinates the edit; validates; commits or rejects
            |
            v
Project files (human-owned) --> recoverable nab history when enabled

Human Vim/Emacs (human UID) --> can still edit project files directly
```

The bridge is compiled into the bundled alock binary as `alock bridge`
from `vendor/alock/src/bridge.c`.
It supports existing-file edits, new-file proposals, directory creation, file and
symlink deletion, and symlink replacement or retargeting. Nab recording is enabled
by alock's TOML configuration. Fizzer starts each bridge with `--turn`: solo edits
save recovery snapshots and become one revision per file at run completion; when
another turn joins that file, the pending batch is flushed and concurrent edits
record individually. Turn membership survives individual staging lock releases.
Unique internal turn IDs distinguish runs even when their author names match.
Bridge heartbeats and lease expiry release locks and flush pending history after
process loss. File replacement and history publication are not one crash-atomic
transaction; failed history publication retains recovery snapshots for retry.

The cross-user bridge exposes its own peer-authenticated socket. The underlying
alock daemon and staging files remain private to the human. Do not make the
daemon's socket directory world-writable: caller-supplied agent IDs on its native
protocol are not Unix peer authentication or a substitute for the bridge.

The bridge validates peer identity and allowed roots, ingests a bounded proposal,
and checks conflicts against the baseline returned when staging. Taking a new
baseline only after receiving a stale proposal would lose that protection.
Keep the agent unable to write the destination directories as well as the files;
otherwise it can replace a read-only file using rename. Group permissions and
ACLs must also be checked before enrolling an existing project.

Human edits remain outside alock's coordination. A base-version check can reject
stale proposals but cannot alone eliminate a human write racing with the final
commit. Do not promise complete race prevention while arbitrary human editors
retain direct writes. Remote writes would need the server to validate its own
authoritative base version too; a local alock success is not remote acceptance.

The integrated launcher uses the selected credentials and local write grants.
Do not copy the human's whole home or credentials into the account, or grant
agents arbitrary execution as the human. Password-disabled login does not prevent
an administrator from explicitly launching a process under this account.
