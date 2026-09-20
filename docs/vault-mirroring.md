# Server-to-client vault mirrors

Fizzer uses a persistent **rclone rcd** process for one-way remote vault mirrors.
Edits still go through alock's DTOB/HTTP endpoints. Mirrors never upload local
changes. No Docker service or per-update shell command is involved.

## Connections and lifetime

The desktop's existing `/vault` Socket.IO connection forwards file and note
notifications to the main process. It calls rclone's JSON HTTP API over a private,
authenticated Unix socket. The headless runner multiplexes `/vault` on its
existing Socket.IO manager. Successful alock commits and concludes broadcast
`vault:filesChanged` to the vault room, including the originating client.
Existing note-created/changed/deleted events also trigger reconciliation.

Rclone downloads through the authenticated, read-only
`GET/HEAD /api/vaults/:id/mirror/` directory source. Authorization is checked on
every request; full filesystem mirrors require owner/editor access. Symlinks and
alock temporary/pending proposal files are excluded. Nab files are included.
There are no upload operations on this endpoint.

One rclone process serves all watched vaults in a host process. Bursts are
coalesced for 100 ms. Jobs for a vault never overlap; notifications during a job
schedule another pass. Initial connection, reconnection, and a 60-second
reconciliation interval repair missed events. Account runs wait for the initial
mirror and give agents its path as `mirrorRoot` in their remote grant. Mirrors
continue updating between turns and runs. Desktop logout and host shutdown stop
the daemon; the next reconciliation restarts an unexpectedly exited daemon.

Mirrors live in `$CASCADE_DATA_DIR/mirrors/<hash>`, defaulting to
`~/.fizzer/mirrors/<hash>`. The hash identifies the server origin and vault ID.
Only these managed destinations are eligible for rclone's deletion of files
absent from the server. Agents read baselines there, edit alock proposals, and
post through the remote bridge. The human account owns mirrors and the private
rclone control socket.

## Installation

The native helper bundle includes rclone **v1.75.1**, downloaded from the official
release site during `npm run build:agent-tools` and verified against pinned
SHA-256 hashes. This adds an `unzip` build prerequisite. Updating through
`install-agent-writes.sh` installs it alongside alock. There is no runtime download.

Development can use an existing `rclone` or set `FIZZER_RCLONE_BIN`. The installed
helper path and common Homebrew locations are checked before PATH. Remote desktop
instances and remote headless runners enable mirroring; headless runners also
accept `FIZZER_REMOTE_MIRROR=1` for loopback tunnels. Local embedded vaults do not
need mirrors. This integration targets macOS/Linux separate-account operation.

## Current limits

HTTP sources provide no checksums and commonly expose timestamps only to the
second. Reconciliation currently forces downloads so same-size edits within one
second cannot be missed. Large vaults consequently re-download unchanged files
on each pass. Rclone owns traversal, transfer, replacement, and deletion. Jobs
are not atomic snapshots of the whole vault; notifications during transfer cause
another pass, and alock still checks the authoritative content hash before edits.

The daemon is shared across vaults in one host process, not independently
launched Fizzer processes. Standalone alock remains independent of rclone.

## Verification

```sh
FIZZER_RCLONE_BIN=/path/to/rclone node --test cascade-electron/vault-mirror.test.cjs
cd backend_elixir
FIZZER_RCLONE_BIN=/path/to/rclone mix test test/cascade_web/mirror_router_test.exs
```

These disposable tests cover PID reuse, same-size edits, deletion, no uploads,
failed-source preservation, vault broadcasts, and reconnect reconciliation.
