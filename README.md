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
3. Open Fizzer, create a local account and vault, then use **Add agent** in a chat.
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
`http://localhost:5173`, and the Electron desktop app. Create an account in the
app; no seed data or invitation is required.

To run without Electron:

```bash
npm run dev-headless
```

Agent execution still requires the desktop app (or another compatible runner)
and a locally installed, authenticated agent CLI.

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

The desktop keeps its SQLite database and vault files under its Electron user
data directory in `local-server/`. Source and self-hosted deployments retain
the compatible `~/.cascade/` conventions. Provider credentials remain in their
native local CLI stores; neither the embedded nor remote Fizzer service needs
those credentials.

The `CASCADE_*` environment variables, `~/.cascade` data directory, Elixir
`Cascade` modules, and `cascade-*` helper commands are compatibility interfaces.
They remain intentionally named and should not be interpreted as separate
products or stale user-facing branding.

## License

Fizzer's project-authored source is available under the [MIT License](LICENSE).
Dependencies and bundled assets may have separate terms; see the
[redistribution guide](REDISTRIBUTION.md) before publishing source or binaries.
