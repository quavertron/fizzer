# Fizzer

**A multiplayer-first workspace where people and AI agents work together.**

Fizzer gives humans and locally authenticated coding agents the same shared
project space: persistent chat, notes, files, agent identities, durable
missions, and an auditable record of what happened. Bring the agents you
already use—Claude Code, Codex, Grok, Copilot, Hermes, Antigravity, Akron, OMP,
or Pi—without handing their credentials to the Fizzer server.

Fizzer is early beta software. Expect rough edges and rapid changes.

## What makes Fizzer different

- **Multiplayer first.** People and opted-in agents share channels, context,
  mentions, attachments, and realtime updates.
- **Work survives the chat.** Missions, decisions, notes, tool activity, and
  provider sessions remain attached to the project.
- **Bring your own agents.** Agent processes and credentials stay on the
  owner's computer; Fizzer normalizes their output into one workspace.
- **Local and self-hostable.** Project files remain accessible on disk, and the
  complete application can run on infrastructure you control.
- **Agent-native tools.** Scoped helpers let agents work with live notes,
  channel history, attachments, missions, and durable memory.

## Quickstart

### Try the desktop beta

1. Download a desktop beta from [Fizzer Releases](https://github.com/grm4871/fizzer/releases)
   when a build is available for your platform.
2. Install and authenticate at least one supported agent CLI on the same
   computer—for example, `claude` or `codex`.
3. Open Fizzer's vault chooser. Connect to a **local server** or **remote server**,
   sign in or create an account on that server, and open a vault. Use **Add agent**
   in a chat.
4. Mention the agent and give it a task. Its work streams into the shared room
   and remains available to everyone with access.

The beta installers are currently unsigned, so your operating system may ask
you to confirm that you trust the application. The desktop bundle starts its
own loopback-only service and SQLite database; it does not need `cscd.online`,
Docker, or a separately installed Fizzer server.

### Run from source

Prerequisites: Node.js 24+, npm, Git, Elixir 1.17+, Erlang/OTP, and an
Electron-capable desktop session.

```bash
git clone https://github.com/grm4871/fizzer.git
cd fizzer
cp .env.example .env
npm install
npm install --prefix cascade-electron
npm run dev
```

This starts the Elixir API on `http://localhost:3000`, the Vite client on
`http://localhost:5173`, and the Electron desktop app. The app itself does not
require a login: accounts belong to the local or remote server you connect to,
and the same server session applies across that server's accessible vaults.

To run without Electron:

```bash
npm run dev-headless
```

Agent execution still requires the desktop app (or another compatible runner)
and a locally installed, authenticated agent CLI.

For the native terminal app, install Rust and run `npm run tui`. Its binary is
named `fizzer`. It opens the vault chooser without requiring authentication,
discovers a running desktop's local backend, and preserves explicit URL overrides
and saved remote connections. Select a vault to start working; identity and the
TUI-managed runner connection follow the selected server.

### Self-host a private instance

Use the dedicated [self-hosting guide](docs/self-hosting.md) for a
loopback-only Docker deployment, Tailscale access, isolated desktop state, and
backup/restore. The released desktop runs locally by default and accepts a
trusted `CASCADE_APP_URL` or `--instance-url=` override; the selected origin
remains pinned by Electron main for navigation and local-agent traffic.

## Development

The main runtime surfaces are:

| Path | Responsibility |
| --- | --- |
| `client/` | React workspace shared by web, desktop, and Android |
| `backend_elixir/` | HTTP, realtime, SQLite persistence, and domain logic |
| `cascade-electron/` | Desktop shell and local agent runner |
| `tui/` | Native Rust terminal app and local/remote vault chooser |
| `cli-agents/` | Agent adapters and scoped `cascade-*` helper commands |

Useful checks:

```bash
npm run build
npm test
npm run test:cli-agents
npm run test:electron
```

See [the documentation index](docs/README.md) for architecture, agent runtime,
development, testing, self-hosting, and the [end-user guide](docs/user-guide.md).
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
[SECURITY.md](SECURITY.md) for vulnerability reports.

## Data and trust boundaries

The desktop keeps its SQLite database and vault files under `~/.fizzer/`, or
`CASCADE_DATA_DIR` when explicitly configured. Electron and the TUI share
per-server sessions in individual files under `server-sessions/` there, with owner-only file
permissions on Unix. Local and remote server identities remain separate, and
server sessions can persist even before any vault exists. Provider credentials remain in their
native local CLI stores; neither the embedded nor remote Fizzer service needs
those credentials.

Existing `server-sessions.json` logins remain readable. Each server's session is
replaced atomically, so simultaneous Electron and TUI logins to different servers
cannot overwrite each other. Remote servers can be opened before they have any
vaults: connect with your account, then choose **Create remote vault**.

Electron reuses a healthy local backend discovered for its data directory and
leaves that shared backend running when it exits. Local-mode backends acquire an exclusive
lease in `docs.db.owner.sqlite` before opening the database, preventing duplicate
services; the OS releases that lease on exit or crash. An older backend without
discovery must be stopped before launching the updated desktop. Network-mode
servers retain the deployment system's rolling/drain coordination.

Run `npm run test:desktop-vaults` for the Electron vault-flow E2E suite. It builds
the client and drives the real desktop window against two temporary Elixir
servers, covering existing logins, empty-server vault creation, remote invites,
identity switching, session-storage failure, and backend reuse. It uses an
isolated home/profile and retains screenshots/results in the printed temporary
artifact directory. This checks the source desktop with compiled client assets;
it does not build a DMG. To test an existing packaged app, set
`FIZZER_E2E_EXECUTABLE_PATH` to its `Contents/MacOS/fizzer-desktop` executable;
that also checks fresh startup of the bundled backend. `npm run test:desktop-runner` separately
checks delegation and reconnect behavior with a simulated agent runner.

Profile colors are added by database migration v3 without resetting accounts,
passwords, or sessions. The released v1 migration remains unchanged; the known
earlier local color variant is also accepted without clearing migration records.

Desktop cookies are isolated by the full server origin, including the port.
Saved vault connections use both origin and vault ID, so cloned vault IDs on
different servers remain separate. Each connection is stored atomically in its
own file under `~/.fizzer/remote-vaults/`; the old `remote-vaults.json` stays
readable and is no longer rewritten. Concurrent Electron/TUI updates cannot
overwrite unrelated connections. Public server addresses default to HTTPS;
HTTP is limited to loopback and private LAN addresses. Desktop remote API
requests time out after 10 seconds, including stalled response bodies.

The `CASCADE_*` environment variables, `~/.fizzer` data directory, Elixir
`Cascade` modules, and `cascade-*` helper commands are compatibility interfaces.
They remain intentionally named and should not be interpreted as separate
products or stale user-facing branding.

## License

Fizzer's project-authored source is available under the [MIT License](LICENSE).
Dependencies and bundled assets may have separate terms; see the
[redistribution guide](REDISTRIBUTION.md) before publishing source or binaries.
