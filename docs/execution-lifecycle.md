# Execution lifecycle

The existing mission scheduler and dispatch outbox own native work. Provider exit
settles an attempt, not the accepted job. No additional supervisor, ledger,
background service, model loop or schema migration is introduced here.

## State transitions

- A saved pending coordinator continuation survives its originating run. Its
  dispatch inherits only the exact persisted owner/identity/channel/session
  sources that pass the existing human-source fence or exact enrolled-mission
  provenance. A generated message prefix is never authorization. An unadmitted
  historical queue row does not block the admitted session; a real active run does.
- Only an explicit continuation disposition completes responsibility. A successful
  provider exit without one gets the existing single recovery identity; a second
  missing disposition retains unresolved responsibility as waiting, not completed.
  Explicit waiting/permission pause does not poll or reissue work. Stop rejects an
  in-flight stale writer; a genuinely new owner request does not inherit canceled
  sources. Already-claimed runs can report their result after recording a completed
  disposition, without making that disposition a new dispatch grant.
- Execution records a server-observed startup interruption only when the queued
  run has no desktop delegation. Existing Progression retries that exact task once
  through normal admission. Work item, workspace and task session are preserved.
  An arbitrary error summary is not recovery evidence. No historical backfill is
  performed, and a second failure remains failed with its evidence/owner retained.
- An explicit accepted task/review summary is not overwritten by the later generic
  provider terminal summary. Downstream stages wait for bound predecessor runs to
  settle successfully. Creation and scheduling share the same structural stage
  predicate: integration names review with implementation/fix ancestry; verification
  names integration. Invalid new graphs fail at declaration rather than silently
  entering an impossible queue. Pending predecessors are allowed when planning.
- New interpretation commitments default to `accepted:false`. Explicit acceptance
  names `sourceMessageId` and `sourceQuote` from the actual human owner's message
  in the mission's channel. Accepted summary/source fields are immutable; status,
  findings and evidence remain updateable. Corrections cancel obsolete scope and
  name a separately sourced replacement. Existing accepted records are retained.
  This bookkeeping is not a new prerequisite for independent authorized delivery.

## Verification

The regression tests use real Scheduler, Execution, Dispatches, Store, continuation
and interpretation boundaries with inert runs. A separate BEAM process dies before
commit, dies after commit, then restarts against the same disposable test database:
exactly one release/continuation dispatch remains and accepted review bytes survive
repeated terminal events. The Socket.IO dispatch fixture exercises actual periodic
startup recovery to a new delegation of the same task/work item, without a model.
Stop, permission wait, source-fence refusal, active-run exclusion, unlimited owner
capacity and bounded recovery remain covered by the owning backend suite.

## Limits

This is not general autonomous-recovery or GasTown persistence parity. It does not
infer missing historical review edges from prose, repair an arbitrarily mismatched
dirty Git branch, reconstruct an arbitrary provider session after desktop death,
or retry unknown side effects. Such jobs remain unresolved with existing artifacts
and ownership, not delivered. Source quotation proves provenance, not semantic
entailment of every coordinator paraphrase. Existing continuation-provider failure
recovery remains bounded; no universal recovery classification is claimed.

Use normal Actions deployment and verify the exact serving revision and health.
No owner-policy/cap changes, desktop restart or live model workload is required.

## Automatic workspace baselines

Native `workspace:prepare` transports the durable WorkItem's nonempty `baseCommit`
as `startCommit`. Before first preparation, an explicit historical revision or
owner-constrained branch is represented by its **full commit object ID** in that
existing field (40 lowercase hex characters for SHA-1, 64 for SHA-256). Creation
and the existing WorkItem update API accept it. Resolve a requested branch to its
exact commit before storing it; branch names, revision expressions and prose are
not pins. Invalid/unavailable IDs fail preparation. `baseBranch` remains integration
metadata. Binding and Git reports reject a different recorded base.

For a new unpinned root only, preparation uses the source primary branch's
configured upstream when its locally known tip is a descendant of source HEAD.
This neither fetches nor promises remote freshness. Ahead, diverged, detached,
untracked and nonprimary sources retain source HEAD. Execution sends
`preferUpstream: false` for parent/dependency sources, including shared sources
without an isolated path. Exact pins take precedence over this flag. Manual
workspace creation still starts at source HEAD.

A registry-owned workspace always resumes in place, whether clean, dirty,
committed or active. Its recorded branch/path/repository/base must match; a
mismatch fails rather than moving it. There is no automatic clean-workspace reset
or backend exception permitting an unused workspace's base to change. Existing
admission, Stop, tenancy and lease checks still own permission to execute.

`cascade-chat mission update --summary-file PATH` (or `-` for stdin) passes literal
multiline text through the existing summary field. It conflicts with `--summary`;
status, review outcome and verification outcome remain explicit. The server's
existing summary length/normalization rules and completion authority still apply.
The same input is available on `mission retry`; neither command invents evidence.
