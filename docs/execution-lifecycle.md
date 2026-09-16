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
