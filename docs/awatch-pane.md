# Awatch in GUI panes

Right-click the **+** in a pane's tab bar and choose **Awatch**, or click
**Open Awatch** on a new-tab page. Drag its tab to a pane edge to split the
workspace. The layout is saved with the workspace.

The native GUI shows a continuous tail-style log of file edits, inline diffs, tool activity,
and lock grants/conflicts. It works in the desktop app and browser. Filter by
file or agent, follow new activity, or clear only this pane's view.

## Shared transports

- Local alock commands, tool-hook submissions, and terminal Awatch subscriptions
  use the existing `/tmp/alock/daemon.sock`. There is no Awatch collector process
  or separate producer/viewer socket. The daemon fans out events and retains
  up to 1,024 events / 16 MiB; slow viewers cannot block edits.
- The persistent per-vault HTTP daemon subscribes to that same local alock feed,
  scopes file paths to its canonical vault root, and forwards activity through
  its existing stdout Port to Fizzer. Separate-account tool hooks submit through
  their authorized bridge; remote bridges forward over DTOB/HTTP.
- Desktop run tool events and separate-account local edits also travel over the
  existing runner connection. Local lock/edit events must match one of that
  run's bridge sessions; unrelated local activity is never forwarded. The server
  scopes delivery to the authorized run's vault and deduplicates by source ID.
  Local file paths remain absolute; server-vault paths are relative to the vault.
- GUI panes share the existing chat/file-update `/vault` Socket.IO connection.
  `vault:activity` carries events; `awatch:replay` resumes after reconnect.
  Only current owners/editors receive activity, since diffs may include files
  outside the published note list. Server replay holds 256 events / 512 KB per
  vault, with at most 32 retained vault streams.
- File refresh still uses `vault:filesChanged` on that connection and the
  persistent rclone daemon. File contents flow server to client; edits are
  submitted over HTTP.

The GUI keeps at most 500 events / 16 MiB per connected vault. Remote diff
previews are bounded to 32 KiB per side and marked when truncated. History gaps
remain visible. These previews are not an audit archive.

The Live indicator requires a response from the server activity feed, not just
a connected chat socket. Deploy the backend activity support with the desktop
client. Local run forwarding requires a native helper that reports bridge session
IDs; development builds use the bundled `.native-tools/alock` for the human-side
bridge while the installed helper remains the separate-account command client.

Upgrade alock and Awatch together. If an older alock daemon is running, end its
active work before restarting it; viewers report an incompatible daemon rather
than killing it and losing locks. `alock events --ensure` reports the daemon
socket and verifies activity support. `FIZZER_ALOCK_BIN` overrides binary lookup.
The standalone `awatch/tool_hook.py` sends bounded, best-effort tool metadata;
configure agent hooks explicitly if not already installed.

Focused checks:

```sh
node --test cascade-electron/awatch.test.cjs
node scripts/test-awatch-pane-browser.mjs
npm --workspace=client test -- src/tests/activity.test.ts src/tests/workspace.test.ts src/layout/tree.test.ts
# Optional native integration uses an isolated alock binary:
FIZZER_ALOCK_BIN=/path/to/alock mix test test/cascade/activity_test.exs test/cascade_web/alock_router_test.exs
```
