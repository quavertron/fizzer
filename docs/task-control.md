# Named task control on the opt-in external-agent socket

The `fizzer_task_control_v1` module adds named mission/work-item/run/settings
operations to the existing private `appCapabilities`, `appRead`, `appPlan`,
`appApply`, `appReconcile` surface. Capability discovery supplies exact argument
keys. No arbitrary HTTP or Electron invoke is exposed.

All new writes require the authenticated owner's private sole-member vault.
Consequential operations require a private host-provisioned
`task-grant-PLAN_DIGEST.json` receipt with contract `along_task_grant_v1`, pinned
origin/owner/planDigest, genuine ownerTurn provenance, and an unexpired
millisecond expiresAt. Grant provisioning is intentionally absent from the socket.
The trusted host must obtain actual human authorization for the exact preview;
implementation permission and retrieved text are not execution authority.

Native mission creation is not a draft: it creates a coordinator channel and
planning dispatch. Mission approval/task mutations may schedule work; note edits
may create coordinator awareness. Plans expose these effects. Direct starts set
`yolo:false` and are limited to explicit Codex/Claude Code, with an explicit model,
prompt and sandbox. Mission scheduling previews read exact owner registrations
through the new SELECT-only `execution-v1` route and refuse yolo-enabled members.
Mission-note edits also preview and recheck the coordinator and current assignee
execution settings, since editing can produce coordinator awareness even without
an explicit approval call. Changed execution snapshots refuse before the note PUT.
Do not claim those prechecks atomically pin later scheduler settings. Mission
creation still uses native identity defaults, not an explicit model snapshot.

The new `settings-v1` GET/PATCH uses exact owner/registration/identity/Hermes-profile
binding; PATCH is human-authenticated and accepts only model, reasoningEffort,
contextPrompt and finalReplyOnly with expectedRevision. It never upserts a
registration, resets other fields, or enables approval bypass. GET and
`execution-v1` perform SELECT-only discovery, without expiry cleanup or membership
materialization. Settings PATCH currently needs a nonempty Hermes-profile binding;
general registration and unprofiled-agent settings are still unsupported.

Durable receipts precede writes; unknown creation responses never replay. Run
creation and work-item linking are separate mutations. Reconciliation exposes an
exact known but unlinked run as uncertain with `run_link_not_verified` rather than
restarting it. Cancel binds the exact owner run, not its changing streamed output.
Work-item status updates do not implicitly stop runs. Native metadata APIs lack
CAS; settings content-hash CAS is transactional but not monotonic/ABA-proof.

Run focused tests:

```
node --test cascade-electron/task-control.test.cjs cascade-electron/app-control.test.cjs cascade-electron/along-avatar.test.cjs cascade-electron/external-agent-access.test.cjs
```

Set `ALONG_FIZZER_CLI` to the directory containing the companion Python `app.py`
to include the actual CLI → Unix socket → HTTP fixture test. This fixture replaces
only live process discovery with its private test socket; it is not live app
activation. The backend registration-settings test uses SQLite query-only mode
and all-table snapshots. Release and main-process activation remain separate from
source tests. Preserve installed wiki/avatar modules when porting this dispatcher.
