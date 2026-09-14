# Development and testing

## Common commands

```bash
npm run dev                 # API + Vite + Electron
npm run dev-headless        # API + Vite
npm run build               # TypeScript CLI helper/agent build
npm run build:client        # production renderer bundle
npm run build:desktop-runtime # native OTP release + client for Electron
npm test                    # client unit tests
npm run test:native         # API native rebuild helper tests
npm run rebuild:native      # rebuild helper better-sqlite3 if the ABI drifted
npm run test:desktop-runner # desktop runner integration test
```

The mission and desktop-runner integration scripts cover the two retained
cross-boundary flows. See
`docs/getting-started.md` for ABI mismatch recovery after Node upgrades.

## Change workflow

1. Read `AGENTS.md` and the source that owns the behavior.
2. Preserve unrelated work in a dirty checkout.
3. Make the smallest coherent change across source, tests, and documentation.
4. Run focused tests while iterating.
5. Run the build and verification appropriate to the changed boundary.
6. Inspect the real affected UI or runtime before declaring the work complete.

## Frontend verification

A TypeScript or Vite build is not sufficient for renderer work.

```bash
npm test
npm run build:client
node scripts/verify-client-runtime.mjs
```

Then exercise the affected screen using a development server, Vite preview, or
Electron. Check:

- no `console.error`, page exceptions, or failed module loads;
- empty, loading, error, and populated states;
- keyboard and touch behavior;
- narrow viewport and safe-area layout;
- scroll and overflow behavior;
- the actual changed interaction, not only the initial render.

After renaming or deleting a function, hook, component, or class name, search
both source and `client/dist` for stale references after rebuilding.

## Test locations

- `client/src/tests/` — renderer feature and regression tests;
- `client/src/layout/*.test.ts` — layout behavior;
- `backend_elixir/test/` — Elixir backend domain and HTTP tests;
- `cascade-electron/*.test.cjs` — Electron runner and usage tests;
- `cli-agents/*.test.mjs` — helper command tests;
- `scripts/test-chat-mission-e2e.mjs` and `scripts/test-desktop-runner-e2e.mjs`
  — retained cross-boundary checks.

## Data safety

Use an isolated `DOCS_DB_PATH` for tests that write application state. Do not
point experiments at the user's normal `~/.cascade/docs.db`.

Do not commit:

- `.env` files;
- SQLite databases;
- provider credentials or tokens;
- `node_modules/`, `dist/`, or `client/dist/`;
- local logs, screenshots, or `.private/` contents.

## Code ownership guide

| Change | Start with |
| --- | --- |
| Workspace shell or global state | `client/src/App.tsx` |
| Chat UI | `client/src/components/ChatView.tsx` |
| Note editor | `client/src/components/NoteEditor.tsx` |
| Agent prompt/model catalog | `client/src/chat/agents.ts` |
| Run stream folding | `client/src/chat/runBlocks.ts`, `backend_elixir/lib/cascade/chat/` |
| HTTP route | `backend_elixir/lib/cascade_web/` and the matching domain module |
| Provider adapter | `cli-agents/cli-agent.ts` |
| Electron IPC or desktop lifecycle | `cascade-electron/main.cjs`, `preload.cjs` |
| Desktop agent execution | `cascade-electron/agent-runner.cjs` |
| Production release | `.github/workflows/deploy-production.yml`, `deploy/github-actions-host.sh`, `deploy/remote-update.sh` |
