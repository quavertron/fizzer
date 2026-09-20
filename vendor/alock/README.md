# alock

The Rust-controlled separate-account local/remote flow is documented in
[ACCOUNT_FLOW.md](ACCOUNT_FLOW.md), including persistent DTOB/HTTP daemons,
assistant-turn locks and configured syntax checkers.

Cooperative file locking for concurrent AI agents. When several agents edit the
same file, alock stops them from clobbering each other's byte ranges and keeps
every agent's locks pointing at the right place as the file shifts underneath
them.

## How it works

alock runs a **single daemon for all files**. The daemon holds all lock state in memory and
is the **sole writer** to the file. Agents never write directly — they ask the
daemon to write on their behalf, and the daemon:

1. checks the agent actually holds a lock covering the range,
2. splices the new content into the file,
3. shifts every *other* lock on that file below the edit point — both byte
   offsets and line numbers — so nobody's lock drifts.

The CLI (`alock`) is a thin client. It talks to the daemon over the shared unix
socket `/tmp/alock/daemon.sock`, including the target file in each request, encoding messages with
[dtob](https://github.com/diegocabello/dtob). The first `acquire` on a file
auto-spawns its daemon; the daemon exits on its own once it holds no active
locks.

## Commands

### Authors and optional nab history

All modifying commands require an explicit `--author NAME`: native `write` and
`commit` (including delete/rename commits), and bridge `commit` and `mkdir`.
`--agent` remains the lock identity; it does not substitute for `--author`.
Missing, empty, control-character-containing or over-32-byte authors are rejected
before mutation, even when history is disabled. Staging and abort do not require
an author. The supplied author is passed as nab's `--author`; existing staging
hooks supply a shortened agent label, and Fizzer supplies its chat author.

Enable recording with `~/.config/alock.toml` (or `$XDG_CONFIG_HOME/alock.toml`):

```toml
nab = true
```

Absent configuration or `nab = false` disables recording. This option is read
on each mutation; malformed `nab` booleans fail rather than silently disabling
history. The supported setting is the top-level, unquoted TOML key `nab`.

Nab is a Git submodule pinned in `nab/` and compiled into alock's single binary.
Initialize submodules before building; no nab process, PATH lookup, elevated
privilege, Fizzer dependency, or network access is involved in recording.
Alock retains its hardened DTOB dependency and adapts nab's decoder API to it.

Archives live beside their source files: `src/example.c` gets `src/.example.c.nab`
(mode 0600). Locks, pending recovery snapshots, the original `path`, and author/operation
metadata remain under `${XDG_STATE_HOME:-~/.local/state}/alock/<path-sha256>/`.
An existing central `history.nab` is used when the sidecar is absent; the next
recorded edit copies its history into the sidecar, retaining the old archive.
The first recorded edit includes a baseline revision. Identical
content is deduplicated by nab; its event metadata is still retained. Deletes
record an empty after-image; rename records source/destination events. Directory
creation records a `directory` marker. Direct writes outside alock are not observed.

`alock bridge serve ... --turn` groups a bridge run's solo edits into one nab
revision per file at shutdown. Each edit still saves durable recovery snapshots.
Before a different turn acquires that file, alock flushes the solo batch. While
several turns participate, each edit records immediately; participation survives
individual lock releases. When one turn remains, batching resumes. Authors label
history; internally generated turn IDs distinguish runs even with identical authors.
Ordinary clients without `--turn` continue recording each edit immediately.

Fizzer starts turn-aware bridges and ends them with its agent runs. A bridge sends
heartbeats every five seconds. After 30 seconds without a heartbeat, the daemon
releases its outstanding staged locks and flushes pending history. Failed flushes
retain snapshots and are retried; daemon startup also replays durable snapshots.
These are bridge-run boundaries, not individual assistant messages or tool calls.
Snapshot ordering uses a durable per-file sequence, independent of wall-clock
changes, and migrates pending timestamp-based snapshots before newer edits.
Incomplete daemon frames have a bounded deadline and size; transient capability
probe failures are retried by bridge heartbeats rather than treated as an old daemon.

```sh
alock history --file src/example.c
alock history --file src/example.c --retry
```

File edits and history publication are **not one crash-atomic transaction**.
After a successful edit, alock saves exact before/after snapshots, updates a copy
of the archive, then atomically replaces the archive. If recording fails, the
command reports that the file already changed; existing history is preserved.
Pending snapshots remain for `--retry` or the next recorded edit. Fix the storage
error before retrying; do not blindly repeat the edit. A crash between the file
write and snapshot persistence, or failure to write the snapshots themselves,
can still leave an unrecorded edit. This is version history, not a tamper-proof audit.

After upgrading, an old running daemon must drain its locks and exit (30 seconds
idle). New clients reject mutation through daemons lacking author/history support.

### Native editor staging

`integrations/staging_hook.py` redirects Codex, Claude Code, Antigravity CLI,
and Grok native edit inputs to temporary copies. Before the tool runs, `alock
stage` acquires its range and saves the original content inside the daemon.
The post-tool hook asks `alock commit` to validate and apply the edited range.
An unsuccessful tool call uses `alock abort` instead. Each tool call has its own
agent identifier, so parallel calls from one session cannot bypass one another.

```
alock stage --file src/example.c --lines 10-20 --agent claude:example
# Returns {"ok":true,"stage":"/tmp/alock/stage-..."}.
# Edit that temporary file with a native editor, then:
alock commit --file src/example.c --stage /tmp/alock/stage-... --agent claude:example --author claude
# Or discard it:
alock abort --file src/example.c --stage /tmp/alock/stage-... --agent claude:example
```

The daemon rejects changes to the copied prefix or suffix outside the lock.
It also checks that the current locked content still matches the baseline,
then splices only the replacement into the current real file. Other agents'
edits outside the lock survive, including edits that shifted the locked range.
Commit uses a temporary sibling plus rename and preserves permission bits.
Successful commits and rejected proposals both release their staging lock.
Expired or explicitly released locks invalidate their staging copies.

Run `python3 integrations/install_staging.py` to preview local hook wiring;
`--apply` installs it and backs up previous configurations in a temporary directory.
Existing Codex plugin installations also need a cachebuster/reinstall and a new
thread to load changed hook registration. Restart other agent sessions as well.

This first version handles regular files up to 32 MiB, including empty and new
files whose parent exists. Text replacements acquire their enclosing line range;
patches, multi-edits, and whole-file writes conservatively acquire the whole file.
Patch `Delete File` and `Update File` with `Move to` are supported. Both require
an existing source and an exclusive whole-file stage; rename also reserves a
missing destination whose parent exists. Rename patches may edit content in the
same operation. Existing destinations are never overwritten. Failed tools abort
these proposals without changing the original paths.

The same operations are available for manual staging:

```
alock stage --file old.txt --lines 1-2147483647 --agent example --delete
# Delete the returned temporary staging file, then commit or abort as above.
alock stage --file old.txt --lines 1-2147483647 --agent example --to new.txt
# Optionally edit the returned staging file, then commit or abort as above.
```

The CLI rejects delete/rename staging against an older running daemon. Let its
active locks drain and wait for it to exit before retrying with the rebuilt binary.
Missing paths are normalized through their parent directory so aliases share the
same destination reservation.

Commit validates the whole source baseline before deleting or renaming. Aborts,
rejections, releases, and expiry release both rename reservations. Rename
preserves permission bits and publishes the edited destination before removing
the source; the two path changes are not crash-atomic (a crash can leave both
paths). Multi-file patches commit one file at a time, not as an atomic transaction. Hooks do not prevent unhooked shell writes or
provide a filesystem sandbox. A host hook crash/timeout can fail open; host-level
read tracking or permission checks may also reject edits to a fresh temporary path.
Those cases require host-specific testing before treating this as enforcement.

Build with `make`; run integration checks with
`python3 -m unittest discover -s tests -v` (requires local Unix socket access).

### Direct range commands

```
alock acquire --file <path> --lines <start>-<end> --agent <id>
```
Lock a line range for an agent. Converted to a byte range internally. Fails if it
overlaps a range held by a *different* agent. Prints the lock as JSON:
`{"ok":true,"lock":N,"line_start":N,"line_end":N,"byte_start":N,"length":N}`.

```
printf 'new content\n' | alock write --file <path> --lines <start>-<end> --agent <id> --author <name>
```
Replace the given line range with content from stdin. The range must be covered
by a lock the agent holds (it can be a subset — lock 1-50, write 10-15). After
the write, all other locks on the file are shifted automatically.

Direct writes and staged commits use the same atomic replacement path,
including lock adjustment and editor notification. Both accept regular files
up to 32 MiB. The former `alock pipe` shell-filter command has been removed;
use native edits through staging instead.

```
alock release --file <path> --agent <id>
```
Release every lock the agent holds on that file.

```
alock release-agent --agent <id>
```
Release all of an agent's locks across every file.

```
alock check --file <path> --agent <id>
```
Exit 0 if the agent holds a lock on the file, exit 1 otherwise. Useful for a
PreToolUse hook that gates edits.

```
alock status [--file <path>]
```
Show active locks as JSON — with `--file`, just that file; without, every file.
Each entry includes agent, line range, byte range, lock id, and TTL remaining.

## Rules

1. **The daemon is the sole writer.** Agents acquire a lock, then ask the daemon
   to `write` or `commit` a staged edit. No edit happens without a covering lock.
2. **Locks are byte ranges** (`byte_start` + `length`); line numbers are tracked
   alongside but the overlap math is done in bytes.
3. **Same agent may hold overlapping locks; different agents may not.** An
   overlapping acquire from another agent is a conflict and fails.
4. **Every write shifts the locks below it.** Locks starting after the edit move
   by the byte/line delta; a lock the edit lands inside grows or shrinks. Pure
   arithmetic, no re-scan.
5. **Relative ordering of any agent's locks is invariant** — a corollary of 3+4.
   No other agent's write can reorder your locks.
6. **Locks expire after a TTL (default 600s / 10 min).** Dead agents don't hold
   forever. The daemon checks expiry every second and shuts down after 30 seconds
   idle with no locks or active turns.

## awatch integration

When present, the daemon notifies a watcher at `/tmp/awatch.sock` on lock events
(`granted` / `shared` / `conflict`) and on every write (old vs. new lines, so a
UI can render live diffs). It's best-effort — if nothing is listening, alock
carries on.

## Change event subscribers

The daemon broadcasts editor-neutral JSON change events to Unix datagram sockets
ending in `.sock`, and Unix stream sockets ending in `.stream`, in `/tmp/alock-events-<uid>` (override with `ALOCK_EVENT_DIR`
before starting the daemon). The directory must be owned by the daemon user and
mode 0700; subscribers create it and their own sockets. Events contain
`kind: "change"`, `file`, `line_start`, `line_end`, `agent`, and `author`.
Delivery is nonblocking and best-effort. Stage, abort, and rejected edits emit no
change event. Existing awatch DTOB delivery remains independent.

Editor commands and the companion plugin now belong to [nv-watch](../nv-watch/README.md).

## Build

```
git submodule update --init --recursive
make
```

Builds the checked-out `libdtob/` and embeds `nab/`, producing the single `alock`
binary. The bundled nab migration preserves the complete types header when
upgrading archives that predate author metadata.

The native cross-user bridge supports file creation, deletion, regular-file
replacement of symlinks, and symlink retargeting; see
[account bridge usage and limits](integrations/account-bridge.md).

## Repo layout

```
src/main.c           CLI client — parses args, talks to daemon
src/events.c         editor-neutral change notification fan-out
src/daemon.c         shared daemon: locking, staging, and atomic file replacement
src/bridge.c         cross-user proposals with peer authentication
src/history.c        sidecar archives and durable recovery snapshots
src/turns.c          per-file turn participation, batching, and lease cleanup
src/nab_embed.c      embedded nab adapter
src/lock.c           lock table: overlap checks, byte/line auto-shift, TTL expiry
src/ipc.c            unix-socket framing and shared socket path
integrations/        native-editor staging hook
                     (staging_hook.py, install_staging.py, per-agent *.md) & openclaw plugin
```
