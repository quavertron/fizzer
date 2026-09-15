# Private local Hermes agent setup

The desktop can opt in to a narrow, same-OS-user setup RPC. This is not a
replacement authentication API or a general request proxy. It reuses Electron
`net.fetch` and the signed-in Chromium cookie session with the ordinary
`X-Cascade-Browser: 1` protection. No tokens or cookies are accepted, returned,
read from storage, or logged by this service. The existing helper TCP proxy's
header allowlist is unchanged.

## Enable only after the runner is ready

1. Drain active desktop runs and quit Fizzer normally. Do not terminate another
   user's or agent's active work. Install/build this desktop revision first.
2. Start the normal signed-in desktop with `FIZZER_LOCAL_AGENT_SETUP=1`, targeting
   `APP_URL=https://cscd.online`. Preserve its normal OS HOME and Chromium user-data
   location; do not copy a cookie database or open a debugging port.
3. Once the renderer connects its runner, the main process creates
   `~/.cascade/agent-setup/setup.sock`. The existing `.cascade` and all ancestor
   directories must be real directories, root/current-user owned and not writable
   by another user. The new leaf must be current-user owned, mode 0700; the socket
   is mode 0600. Symlinks and existing endpoints are refused, not replaced.
4. Invoke the RPC from a local client that validates those permissions and the
   live endpoint ownership. Never expose it through a web server, TCP bridge,
   browser extension or generic proxy. Disable the opt-in on subsequent ordinary
   launches when setup is finished.

The Unix filesystem permission boundary excludes other OS users (root is outside
this boundary). It does not sandbox malicious processes running as the same OS
user. Browsers cannot connect to Unix sockets; Origin/Sec-Fetch headers, cookie
and authorization headers, unexpected Host, methods and routes are also refused.
The service closes on runner disconnect or a switch away from the pinned origin.
A leftover socket after a crash is a refusal, not proof that its owner is dead;
inspect the owning process/listener before any manual cleanup.

## One operation

`POST /v1/register-hermes` with `Host: localhost` and
`Content-Type: application/json`. JSON must contain exactly:

- `vaultId`: existing vault ID; `ownerUserId`: positive integer account ID.
- `displayName`, `mention` (lowercase simple handle), `profile` (Hermes profile),
  `cwd` (absolute path), and `model`.
- `flags`: exactly `pingableByOthers: false`, `taggableByAgents: false`,
  `replyToEveryMessage: false`, `orchestrator: false`, `ambientGroupChat: false`,
  `nextStepSuggestions: false`, `finalReplyOnly: true`, `yolo: false`.

The service checks authoritative `/api/me` and requires vault ownership and
exactly one member. It reuses or creates the matching Hermes identity, refusing
incompatible identities instead of overwriting them, and reuses or creates the
empty chat channel named for its mention. Identity, channel and registration IDs
are validated and read back exactly; membership flags are explicitly written and
verified. Existing registration IDs must survive retries. Operations serialize
within this service. A transport failure may mean a partial setup: inspect/retry
this same binding rather than creating a different handle. Setup sends no chat,
run, model, approval or orchestration request.

**Identity visibility is vault-wide**, not channel-only. Fizzer can project
memberships into other channels, with backend defaults. The returned flags are
verified for the returned membership only. An external session adapter must
independently reject unsupported invocation settings in every channel. Future
vault membership changes also require re-evaluating the intended audience.

The HTTPS upstream is pinned in the module, with redirect rejection and a bounded
request timeout. This first flow deliberately does not support arbitrary
self-host origins, alternate API paths, request methods, headers or credentials.

## Checks

```sh
node --test cascade-electron/local-agent-setup.test.cjs cascade-electron/desktop-runner-host.test.cjs
npm run test:electron
npm run test:cli-agents
npm run build
```

Tests use real private Unix sockets and a real local HTTP fixture injected at the
fetch boundary. They cover idempotency/readback, account/private-vault checks,
flag mismatches, forbidden routes/browser requests, unsafe paths and socket
permissions, existing live endpoints and opt-in/disconnect lifecycle. Fixtures
never represent live account registration or phone acceptance.
