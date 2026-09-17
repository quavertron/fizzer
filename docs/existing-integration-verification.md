# Reuse observed delivery evidence without synthetic tasks

`Store.finish` remains the explicit delivery authority. The implementation → accepted independent review → integration chain is unchanged. A separate verification task is still supported and required when checks or remediation actually remain. A provider exit, free-form fulfilled commitment, or prose reference does not close a mission.

## Coordinator verification of an existing integration

When a coordinator has actually inspected the released artifact and affected behavior, it can bind that observation to existing integration evidence in the finish transaction:

```sh
cascade-chat mission finish --mission MISSION \
  --objective 'exact current mission objective' \
  --verified-integrations-file /path/to/pins.json \
  --verification 'Observed release/artifact checks, results, and activation limits' \
  --summary 'Delivered outcome'
```

The JSON file is an array of `{ "taskId": "INTEGRATION", "runId": 123, "attempt": 0 }`. The HTTP finish body uses `verifiedIntegrations`, `objective`, and `verification` with the same values. It requires the existing coordinator authority, exact objective and current task/run/attempt, completed integration, settled noncanceled bound provider run, and existing isolated workspace/base binding where applicable. The new observation need not already have been copied into a worker's `work_items.verification` field.

The existing mission event log receives `integration_verified_by_coordinator`, recording the actual coordinator observation, bound task/run/attempt and a fingerprint of the current ancestry, outcome, workspace, repository/branch and recorded Git head/dirty state. No fake verification task, worker run, review result, or deployment is created. This receipt is distinct from worker-written evidence. Receipt and closure roll back together if any completion gate fails. Already acknowledged interpretation remains acknowledged over this explicit delivery; genuinely pending evidence is not suppressed.

Unfinished tasks, active workers, absent accepted review ancestry, changes-requested reviews, failed verification and Stop still block completion. Coordinator verification cannot waive a failed verification: a subsequent passed verification remains required. Stop is reread inside the final transaction.

## Explicit combined-release closure

If one real combined release covered work from another mission, first close the delivery mission with the pinned observation above. Reuse the existing `mission link-recovery` operation to explicitly attest which original completed implementation was covered by that integration; supply the original objective and exact target attempt/run and source run. Then finish the original mission normally.

Cross-mission coverage requires the same owner, vault, channel and coordinator; an unchanged existing recovery snapshot; a completed source mission with the canonical completion event; and its unchanged fingerprinted integration-verification receipt. Changes to review outcome, attempt, evidence, objective, workspace or recorded candidate invalidate reuse. A stopped target or canceled source cannot qualify. The coordinator must verify semantic coverage; software does not infer it from similar text or automatically attach unrelated work.

This creates no new polling loop, auto-resumption, schema, table, background model invocation, or historical data migration. The existing link endpoint can schedule normal coordinator awareness; it is not a no-model production probe.

## Verification and boundaries

Focused tests exercise real Store/HTTP/CLI paths, rollback and duplicate finish, missing/stale pins, isolated artifact binding with empty legacy worker verification, failed verification, explicit cross-mission reuse, changed review/Git evidence, channel/attempt changes, Stop, unchanged task/run/dispatch counts and closure from a fresh BEAM using only persisted evidence. A baseline module reproduces the missing-verification-stage failure.

Deployment makes the mechanism available; it does not silently close existing missions or mark semantic commitments fulfilled. Installed CLI activation and actual current-workload closure must be reported separately. A server release is not activation of local desktop-native changes, and a verification statement must retain that limitation rather than claiming the entire feature is loaded.
