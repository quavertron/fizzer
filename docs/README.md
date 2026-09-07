# Fizzer documentation

This directory is the maintained technical documentation for Fizzer.
It lives inside the application repository so documentation changes can be
reviewed with the code they describe.

## Start here

- [Getting started](getting-started.md) — install dependencies and run Fizzer
  locally.
- [User guide](user-guide.md) — understand what Fizzer can do and how to use it.
- [Fizzer Guide conversations and reporting](user-guide.md#fizzer-guide-conversations-and-reporting) — start, reopen, or delete local Guide conversations; draft and publish public Fizzer tracker issues.
- [Product language](CONTEXT.md) — canonical terms for guide, feedback, reports, and the public Fizzer tracker.
- [Architecture](architecture.md) — understand the client, server, desktop
  shell, persistence, and realtime boundaries.
- [Agent runtime](agent-runtime.md) — understand local agent execution,
  sessions, streaming, helpers, and security boundaries.
- [App context](app-context.md) — maintain bounded account-wide behavioral guidance for agent runs.
- [Terminal client](../tui/README.md) — connect the Rust TUI to an authenticated Fizzer instance.
- [Development and testing](development.md) — make and verify changes.
- [Self-hosting](self-hosting.md) — run a loopback-only private instance and
  connect a pinned desktop identity.
- [Deployment and operations](deployment.md) — build, deploy, verify, and
  refresh production safely.

## Repository map

| Path | Responsibility |
| --- | --- |
| `client/src/` | React renderer, chat and note UI, layout, sockets, and tests |
| `backend_elixir/` | OTP HTTP and Socket.IO backend, SQLite, and realtime |
| `cascade-electron/` | Electron main process, preload bridge, and local runner |
| `cli-agents/` | Agent adapters and the `cascade-*` helper commands |
| `android/` | Capacitor Android wrapper |
| `tui/` | Rust terminal client for authenticated notes, chat, and agents |
| `deploy/` | Production host command, snapshot-safe cutover, locking, and nginx configuration |
| `scripts/` | Verification, development instances, and integration utilities |

## Documentation rules

1. Document current behavior, not intended behavior.
2. Link to the source file that owns a behavior instead of duplicating large
   implementation details.
3. Keep secrets, private host details, user tokens, and `.private/` contents out
   of documentation.
4. Update the relevant page in the same change when a public command,
   architecture boundary, deployment path, or operator workflow changes.
5. Prefer short runnable examples. Commands should work from the repository
   root unless a page says otherwise.

The code and checked-in configuration remain authoritative. In particular,
`package.json`, `.github/workflows/`, `docker-compose.yml`, and
`.github/workflows/deploy-production.yml`, `deploy/github-actions-host.sh`, and
`deploy/remote-update.sh` should be checked before production operational work.
