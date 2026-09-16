# Recorded completion: one delivery authority (first slice)

`Store.finish` remains the explicit mission-delivery authority. It checks the existing implementation → accepted review → integration → passed verification chain and active-worker guard. Neither a successful provider exit nor a completed worker task establishes that the user objective was fulfilled.

## Before / after

| Boundary | Before | Now |
| --- | --- | --- |
| Explicit mission delivery | `chat_missions` and its completion event said completed, but interpretation required another saved `executionCompleted` flag | The existing completion event is canonical. Its stable source key identifies the new atomic projection contract; new completions do not write or depend on the interpretation flag |
| Already interpreted evidence followed by delivery | Changing mission phase/delivery changed the interpretation fingerprint and bought another coordinator wake | The same completion transaction advances the existing acknowledgment only over the delivery/phase change, and only if the complete preceding evidence was explicitly handled |
| Unhandled/raced evidence | Interpretation owns semantic judgment | Unchanged: a pending batch stays pending; a previously unclaimed changed snapshot is made pending, not acknowledged |
| Explicit completed task followed by provider exit | Settlement copied task summary into work-item verification, replacing real evidence or manufacturing new evidence text and another wake | Explicit terminal task evidence is retained. Provider exit settles the attempt; it does not become a verifier |
| Completed task while its bound run is active | Notifications were quiet, while mission/root-message status said attention | Both consume Store's same bound-run settlement predicate; the projection stays active until the run settles |

Runs still own attempt execution, mission tasks own stage outcomes/dependencies, work items own workspace/artifact evidence, interpretation owns semantic commitments/questions, and the mission owns explicit delivery. They are not interchangeable tables. `ChatMissionCard` consumes the root-message mission status, so the corrected Store projection reaches the existing card without a second frontend status rule.

## Compatibility and safety

- No schema, service, reconciliation loop, policy change, model downgrade, or historical data migration.
- Existing completion events without the canonical source key retain the old acknowledgment compatibility path. No historical completion/review/release receipt is fabricated.
- Optional suggestions are not promoted to accepted obligations. Explicit fulfilled commitments do not bypass native review/deployment evidence gates.
- Canceled/missing runs and real failed/blocked tasks retain attention/evidence-missing behavior. Stop/admission gates remain in their existing owners.
- The implicit legacy provider-to-task result path is not rewritten here. Only already explicit terminal task outcomes stop being overwritten by settlement.

## Verification

Regressions exercise real Store / Scheduler / Interpretation / WorkItems / Notifications with inert persisted runs, root-message readback, duplicate settlements and duplicate finish, and a new BEAM reading the same disposable test database after completion. Before fixes, an already handled delivery scheduled another interpretation, an explicitly completed task generated a new verification text and wake on provider exit, and a still-active bound run projected attention. Existing accepted-review, failed-verification, source-scope, admission, Stop and transport tests remain required affected-boundary checks.

## Deliberate limit

This is a first native recorded-completion slice, not consolidation of every historical accepted job. An externally shipped commitment may be semantically fulfilled while its native mission has unexecuted/missing review/integration dependency edges. The existing free-form evidence references do not safely prove exact artifact binding or actual deployed verification for those stages. This change does not mark those stages complete, infer user acceptance, synthesize receipts, rerun shipped work, or auto-resume history. A `finish` attempted while workers are still active continues to wait/reject; this change does not add a parallel deferred-completion intent ledger.
