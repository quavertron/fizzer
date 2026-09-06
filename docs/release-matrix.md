# Release checks

Use the smallest check that covers the changed behavior. A focused regression
test is the default; boundary suites are for broad changes and releases.

`npm test` includes the focused headless Chromium chat-scroll regression
(`npm run test:chat-scroll`). It mounts the production ChatView and stylesheet
and checks native wheel input across incoming messages, touch intent, returning
to live follow, and channel changes. It requires Playwright Chromium
(`npx playwright install chromium`); it does not access a desktop session.

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

Before pushing, inspect the diff and run `npm run build`. Before claiming a
deployment complete, require a green `Deploy Production` run proving the exact
live revision and image plus internal and public health; a successful local
build or push is not deployment evidence.
