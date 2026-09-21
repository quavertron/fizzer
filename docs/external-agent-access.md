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

## Missions and delegation capability

The agent settings toggle **Missions and delegation** belongs to the agent
identity (`vaultAgentId`). It defaults on and is shared by that identity's
registrations, including anonymous mission workers. Only a human owner can edit
it. Ordinary profile updates that omit it preserve its value.

New missions, delegated tasks, children, retries, automatic repair and agent
handoffs require the source identity to be enabled. The destination can still
receive human direct work or another enabled agent's work while its own toggle
is off. Queued work is retained with a disabled-source reason and checked again
at execution admission. Stop fences remain in effect after re-enabling. Running
results, child-result integration, inspection and Stop remain available.

The desktop receives a short-lived, run-bound helper bearer minted from the
server's owned run and dispatch. The helper env and per-run config use that
bearer; it is not stored in the replay payload. The helper proxy omits browser
cookies. A client-supplied run header or registration cannot change its source
identity. Generic `/api/auth/agent-token` bearers retain notes, inspection and
no-invoke access but cannot authorize a new delegated invocation.

**Renewal.** Helpers renew near-expiry or expired run credentials through
`POST /api/auth/agent-token/renew`, authenticating with the existing bound bearer.
The server derives the replacement source exclusively from that bearer and
checks account revocation, the persisted source, and an owned queued/running run.
No requested run or registration can replace the signed source. A disabled
agent may renew for direct work, inspection, reporting and Stop; new delegation
still checks the live setting. Expired proof is accepted only on this endpoint,
for seven days after issuance. Completed/stopped runs cannot renew. An inactive
credential older than seven days needs owner provisioning again.

All three helpers renew before authenticated API calls, including repeated
polling calls. They save a replacement to the matching per-run helper config
when writable, and prefer a newer same-source config bearer over the immutable
process environment. They never fall back from bound proof to a broader disk
credential. Read-only configs retain renewal within the CLI process only.

**Provisioning and activation.** The owner-authenticated
`POST /api/auth/agent-token` accepts `{ "runId": 123 }` to provision an existing
owned active run. Unlike the no-body generic-token request, this returns a bound
credential derived from that run's persisted dispatch. Foreign, missing and
ended runs are rejected. Agent credentials cannot call this provisioning route;
the renewal route cannot upgrade generic credentials. This gives external
callers and existing runs a secure migration path without trusting their run
headers. Supply the returned bearer as the worker's `CASCADE_NOTE_TOKEN` or
explicit `--token`; retain its matching run ID. Keep the owner credential in the
provisioning client, never in the worker. Updated helpers handle renewal.

**Staged release gate.** `Deploy Production` now fails before configuring SSH or
deploying any backend unless the production environment variable
`DELEGATION_ACTIVATION` contains reviewed migration evidence for the exact
triggering revision. This applies to master pushes, manual runs and successful
Desktop builds events. An absent record blocks activation by default; the
currently deployed compatible backend continues serving existing processes.
Desktop builds remain independent so the runner and bundled helpers can be
distributed first. A green installer build alone does not open the gate.

The release coordinator must complete these stages using existing release
authority; this does not require a new manual mission approval:

1. Build and distribute the updated desktop runners and bundled helpers. Verify
   that every supported installation consumes `helperToken` on newly dispatched
   runs and supports bound-token renewal. Until activation, the new runner uses
   the existing generic credential when the old backend omits `helperToken`.
2. Let all existing generic-credential processes finish normally before the
   cutover. Do not cancel tasks, alter Stop, or restart workers to manufacture
   readiness. Account for queued/replayed packets and prevent new generic
   processes from appearing during the cutover. Merely minting a bearer does not
   update a running process. This gate deliberately requires draining; it does
   not certify in-place provisioning as a substitute.
3. Verify supported external orchestration callers use the run-bound provisioning
   and renewal contract, with the owner credential confined to the provisioning
   client. Keep external launches quiescent across cutover until this contract
   is available. The provisioning endpoint described above is part of the new
   backend; it is not assumed available on the old backend.
4. Independently review the installation, process-drain and external-client
   evidence. Record its durable HTTPS reference and the integrated full commit
   SHA in the production environment variable, then rerun `Deploy Production`:

   ```json
   {"revision":"<40-character integrated commit SHA>","desktopRunners":"verified","existingGenericProcesses":"drained","externalClients":"verified","evidence":"https://<durable-reviewed-migration-evidence>"}
   ```

The gate validates the attestation, not remote installations. The coordinator
must not populate it from API tests, a build result, or an unverified worker
claim. A different revision requires fresh matching evidence; installer refresh
events cannot reuse an older revision's record. Follow normal exact-revision
deployment and live verification after activation. This temporary gate stays
until a separately reviewed change removes it after migration is established.
Self-hosters must follow the same migration sequence before installing this
backend; their deployment does not run the public repository's Actions gate.

No installed-client migration or production activation is established by the
synthetic tests. This candidate makes premature backend activation fail closed;
it does not claim that generic credentials work against the activated backend.

Automatic invocation settings (`orchestrator` and `nextStepSuggestions`) are
also owner-only, including alternate/nested settings payloads, so an agent
cannot use a sibling's suggestion checkpoint to bypass its own delegation gate.

Fizzer enforces this capability at its HTTP and execution boundaries. Provider
native subagent tools, arbitrary external processes, and tools outside Fizzer's
API are **not** controlled by that HTTP policy. Disabled prompts instruct agents
to work directly and avoid native delegation, and helper help omits delegation
commands; those are guidance, not a provider sandbox. This does not isolate
credentials from other processes with access to the same OS account/filesystem.
