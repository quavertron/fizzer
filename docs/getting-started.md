# Getting started

## Prerequisites

- Node.js 20 or newer
- Elixir 1.17+ and Erlang/OTP (for the local API)
- npm
- Git
- Electron-capable desktop session for the full desktop app

Agent backends are optional for basic note and chat development. To execute
agents, install and authenticate at least one supported local CLI, such as
Codex, Grok, Claude Code, Copilot, Hermes, OMP, or Pi.

## Install

From the repository root:

```bash
npm install
npm install --prefix cascade-electron
```

The root package is an npm workspace that includes `client/`. `cascade-electron/`
is a separate package (desktop shell) and needs its own install.

### Native modules (`better-sqlite3`)

Helper scripts and the QMD worker compile `better-sqlite3` against the current
Node ABI. After a Node upgrade, if those tools fail with
`NODE_MODULE_VERSION`, rebuild:

```bash
npm run rebuild:native
```

Root `postinstall` rebuilds `better-sqlite3` only when a load-time ABI mismatch
is detected.

On macOS, if node-gyp fails because Homebrew Python is broken (e.g. `pyexpat`),
the rebuild script prefers `/usr/bin/python3`. You can also force it:

```bash
npm_config_python=/usr/bin/python3 npm run rebuild:native
```

Skip automatic native work with `CASCADE_SKIP_NATIVE_REBUILD=1`.

## Run the full stack

```bash
npm run dev
```

This starts:

- the API and Socket.IO server on `http://localhost:3000`;
- the Vite client on `http://localhost:5173`;
- the Electron desktop shell.

For a browser-only development session:

```bash
npm run dev-headless
```

For a named isolated development instance:

```bash
npm run dev-instance -- --name my-change
```

See `node scripts/dev-instance.cjs --help` for instance options.

## Local data

By default Fizzer stores runtime data outside the checkout (using the legacy
`.cascade` directory name for compatibility):

- SQLite database: `~/.cascade/docs.db`
- Vault files and assets: `~/.cascade/vaults/`

Override the database for an isolated run:

```bash
DOCS_DB_PATH=/tmp/cascade-dev.db npm run dev
```

Do not inspect or edit the database directly for ordinary product work. Use the
application API and the `cascade-note`, `cascade-chat`, and
`cascade-scratchpad` helpers where applicable.

## First verification

```bash
npm run build
npm test
npm run build:client
node scripts/verify-client-runtime.mjs
```

The last command loads the built renderer in headless Chromium and fails on
uncaught exceptions, failed module loads, and fatal console errors.

## Configuration

The repository root `.env.example` documents local server, runner, and session
settings. `deploy/.env.example` is the minimal production environment template.

Never commit `.env`, tokens, agent credentials, database files, or files under
`.private/`.
