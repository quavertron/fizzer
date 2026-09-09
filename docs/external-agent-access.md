# External Along access (opt-in, source desktop, Unix only)

Opt-in, owner-private external API for the source desktop. Packaged apps and
Windows are excluded. The TCP helper proxy is unchanged; no credential files,
helper contexts, or model sessions are used. Backend deployment and local desktop
activation are separate operations.

## Atomic no-invocation contract (backend deployment required)

`send` negotiates an authenticated GET on the exact channel route
`/api/vaults/:vault/channels/:channel/messages-no-invoke-v1`. It requires
`contract: "messages_no_invoke_v1"` and matching authoritative actor/vault/channel
bindings before writing a receipt or posting a message. Missing or incompatible
capability returns `nonping_backend_unsupported` (normal authentication/token mint
may already have occurred). POST uses that same dedicated versioned endpoint,
never the legacy messages route or an ignorable flag. A mixed-version backend
returning 404 on POST cannot invoke through fallback; uncertainty blocks replay.

The backend requires agent access and current vault ownership, rechecked inside
the write transaction, and reuses ordinary channel access, DM, attribution,
persistence and response privacy checks. It persists text as completed, with no
run or reply, and emits the ordinary display event with empty dispatches. It never
materializes members, infers replies, processes clear commands, or enters dispatch
creation. Ambient/settings changes cannot switch this operation into invocation.
Normal messages, mentions and ambient behavior remain unchanged. This contract
covers this creation operation, not subsequent explicit edits or invocations.

**Deploy the backend addition through GitHub Actions before live sends can work.**
Source desktop changes alone do not enable the deployed server. A production
release does not restart or activate any local desktop.

## Authentication and identity

Every supported operation reads `/api/me` and `/api/vaults` through the normal
signed-in desktop session, checking the configured owner ID and vault-owner role.
It mints an operation-local restricted bearer with `POST /api/auth/agent-token`
and normal `x-cascade-browser: 1` CSRF protection. Agent data requests omit cookies
and reject redirects. Tokens are never returned, persisted, or logged.

Current main supports unregistered agent attribution (`author: "Along (AI agent)"`,
`agentId: "hermes"`, `registrationId: null`) and authoritative `actorUserId` on
message readback. This is not a verified registered Along identity or phone bridge.
Account-level agent tokens are not cryptographically vault-scoped; the private
service applies the narrower scope. Same-UID programs can access the socket.

## Activation (parent/operator only; not performed)

1. Drain active runs and arrange an approved source-desktop relaunch; never restart
   collaborative work merely to load this hook. Use normal sign-in, not copied
   cookies or credentials. No change takes effect in the already running process.
2. Provision an absolute, nonsymlink, owned 0700 directory with safe ancestors,
   for example `/home/jt/.cascade/along-main-access`. An existing `access.sock`
   blocks startup; establish endpoint ownership before any manual removal.
3. Launch this unpackaged source checkout with:
   - `FIZZER_EXTERNAL_AGENT_ACCESS=1`
   - `FIZZER_EXTERNAL_AGENT_DIRECTORY=/home/jt/.cascade/along-main-access`
   - `FIZZER_EXTERNAL_AGENT_VAULT=<verified-private-wiki-vault-id>`
     (replace with the verified private vault ID; the formerly documented
     `5f57525b-4272-47aa-96ed-cc913a6563e8` is a public user-group vault, not a wiki target).
   - `FIZZER_EXTERNAL_AGENT_OWNER=1`
   - normal app instance selection pinned to the intended HTTPS origin.
     The embedded HTTP backend is intentionally not accepted by this hook.
4. First use `node scripts/external-agent-client.cjs SOCKET '{"op":"list"}'`.
   Verify the exact intended account/vault. Channel creation is a real write and
   requires separately approved execution and exact readback. `send` requires the
   deployed versioned no-invocation backend contract.
5. Before claiming live readiness, verify actual Chromium `session.fetch` cookie
   omission, normal CSRF token minting, and real deployment compatibility. Isolated
   Elixir router tests are not a signed-in Electron or deployed-server smoke.

## Private socket protocol

`POST /v1`, JSON object with exactly the fields listed. No caller-controlled URL,
HTTP method, credential, registration, run ID, reply, attachment, or proxy route.

| op | additional fields | result |
| --- | --- | --- |
| list | none | scoped note IDs/titles |
| read | noteId | scoped note with upstream agent privacy redaction |
| history | channelId | last 40 messages, not full harness logs |
| createChannel | requestId, title | listed note exactly `cascade://chat-channel` |
| inspectPrivateVault | none | exact scoped private vault, owner and complete single-owner membership |
| createPrivateVault | requestId | fixed name `Along — shared wiki`, explicit private input and exact privacy/owner/member readback |
| createNote | requestId, title, content | ordinary listed note; privacy checked before POST and after exact body readback |
| send | requestId, channelId, body | persisted attributed message; unsupported backends refused before message POST |

### Private wiki extension (source-tested, not live)

The three wiki operations above require the updated opt-in local desktop module;
deploying master does not activate a running desktop. Six Node tests use actual private sockets and loopback HTTP;
these are fixtures, not proof of signed-in Chromium or production writes.

Prefer creating the vault in the normal signed-in app first, then pinning that
verified ID for the approved API-enabled relaunch. `createPrivateVault` also
supports bootstrap when the service is already enabled with an existing owned
vault scope; its returned new ID does **not** silently broaden/rebind that scope.
A safely arranged reconfiguration is required before `createNote` can target the
new vault. Existing same-name vaults block duplicate creation; inspect them rather
than guessing their identity. Unknown writes remain blocked by durable intent.
The ordinary backend currently defaults new vaults to private and may seed a
General channel note. No message is sent or agent invoked by these operations.

Private checks require `visibility: private`, `created_by` equal to the pinned
owner, owner role, and exactly one member with that same owner ID/role. Along
accesses through John's authenticated service, not an invited second account.
Checks are before/after network writes, **not** an atomic lock against a concurrent
owner changing vault sharing. Do not change sharing during wiki creation.
No invite, public toggle, generic fetch, note update/delete, or background writer
was added. Conversational maintenance/editing is not yet a verified live feature.
Wiki content rejects `cascade://` markers, is limited to 8000 characters, and must
read back exactly; no transcript import or agent-message route is involved.

Main's actual note wire shape remains **`is_listed`**, not `listed`; creation sends
`is_listed: true`. The local view exposes `listed`. Linked-channel markers are
rejected. The legacy send validator also rejects `@` and `/compact`.

Socket mode is 0600; receipt directories are 0700 and files 0600. Writes require
stable 1–80 character ASCII alphanumeric/underscore/hyphen request IDs. Fsynced
intent precedes POST; retries read back saved result IDs without a second POST.
Missing/damaged results block as `uncertain_write`, including across restarts.
Never delete uncertain receipts to retry blindly. Server-generated note IDs mean
this is not crash-atomic. Renamed or mismatched readbacks fail closed.

Bounds: 1000 receipts, one in-flight operation, 16 KiB request, 1 MiB response,
160-character titles, 8000-character message bodies. Error codes are fixed and
never contain upstream bodies, tokens, or private paths. No delete/edit/model/
registration mutation/credential-export operation is exposed.

## Verification

Run `node --test cascade-electron/external-agent-access.test.cjs`,
`npm run test:release:desktop`, and `npm run build` from the release checkout.
Run `MIX_ENV=test mix test test/cascade_web/external_agent_access_test.exs
test/cascade_web/orchestration_chat_dispatch_test.exs` from `backend_elixir`.

The isolated router/SQLite regression covers browser CSRF minting, note wire
shape, attribution/readback, no dispatch or run under ambient settings, explicit
mentions, reply inputs, clear text and concurrent settings changes, permission
denials, and unchanged legacy dispatch. Node tests use real private Unix sockets
and loopback HTTP fixtures, including durable replay and mixed-version refusal.
These tests do not establish signed-in Chromium compatibility, deployed API
writes, desktop activation, or phone readiness. Record release-specific counts,
preexisting failures, workflow URL, and exact deployed revision separately.
