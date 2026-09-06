# Release checks

Use the smallest check that covers the changed behavior. A focused regression
test is the default; boundary suites are for broad changes and releases.

`npm test` runs client unit tests. Browser checks (`test:chat-scroll` and
`verify:client-runtime`) and bundle budgets (`verify:client-performance`) are
opt-in checks for changes to those behaviors. Do not run them on unrelated edits.
The frontend boundary suite runs type checking and unit tests; production builds
the client bundle once in Docker. `mix check` runs the backend tests and their
automatic compilation. Format changed files during editing; whole-tree formatting
and a second compilation are not release gates. Data-parity checks are for changes
to persisted data compatibility.

| Boundary | Broad-change or release check |
| --- | --- |
| Client | `npm run test:release:frontend` |
| Elixir or agent server | `npm run test:release:backend` |
| Electron main process or packaging | `npm run test:release:desktop` |
| Multiple boundaries | Run only the affected suites above |

Keep one cross-boundary test per risky flow:

- `npm run test:chat-mission` for durable mission state across clients and reload.
- `npm run test:desktop-runner` for runner reclaim, replay, and duplicate-process avoidance.

Deployment, rollback, capacity, soak, Android packaging, and browser/device
inspection are explicit operator checks. Run them only when that boundary
changes or when performing that release. Self-hosters must verify their own
revision, image identity, health, rollback, and served assets.

Changes limited to tests, contributor instructions, or documentation do not
trigger production deployment. The bundled `docs/user-guide.md` remains a runtime
input and does deploy. Dependency installs ignore package command scripts, and
revision labels are applied after runtime layers so each commit reuses the cache.

Desktop installers build on native runtime changes, version tags, or manual
workflow dispatch. Android builds on Android or bundled client changes, or manual
dispatch. Backend-only pushes do not rebuild native installers. Installer refresh
runs after desktop publication, independently of the application cutover.

Before pushing, inspect the diff and run `npm run build`. Before claiming a
deployment complete, require a green `Deploy Production` run proving the exact
live revision and image plus internal and public health; a successful local
build or push is not deployment evidence.
