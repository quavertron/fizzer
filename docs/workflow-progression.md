# Durable workflow progression

Orchestrator mode uses the existing mission/task DAG and native dispatch outbox, not an in-memory promise. A task finishing is not request delivery: closure continues to require accepted review, integration, passed verification, and resolution of negative reviews. Tool/deployment rights still come from the original owner instructions and existing project controls; no phase grants extra privileges.

## Progression and repair

- Newly created owner-rooted missions record `workflow_enrolled` in the durable event log. Existing historical missions are not bulk enrolled. Restricted owners require the operator policy below even if an enrollment event exists.
- Completed research releases original dependency stages through the scheduler. Worktree preparation inherits the exact completed dependency workspace/commit; missing or ambiguous sources stay a concrete repository-preparation blocker, never an arbitrary process cwd or unlinked substitute run.
- For enrolled executing workflows, an independent `changes_requested` review with one unambiguous original implementation owner creates a correction owned by that implementer and a re-review owned by the reviewer. Untouched pending integration dependencies are redirected to the re-review; the rejected review remains in ancestry.
- Correction creation, integration dependency updates and the durable event are one transaction. Repeated maintenance and process crashes do not duplicate tasks. At most two automatic correction rounds per workflow are permitted. Exhaustion produces a durable no-model task follow-up, not infinite retries or a completed request. Ambiguous multi-owner reviews remain coordinator decisions.
- Existing coordinator interpretation retries remain bounded. `noMaterialChange` cannot consume independently scheduled work or suppress task blockers. Coordinator dispatch identity is persisted independently of acknowledgment, so transport recovery still recognizes the exact authorized run after the interpretation clears its active pointer.
- Stopped/canceled workflows are not repaired. Historical pending dispatches held by admission do not reserve registrations and starve admitted work; actual running work still reserves its slot.

## Operator admission during recovery

The optional `CASCADE_DATA_DIR/execution-admission.json` remains a boot-loaded fail-closed boundary across schedule, claim and transport replay. Preserve the existing exact task bindings and retained-run rules. Optional owner fields:

- `workflows`: exact `{missionId, vaultId, channelId, rootMessageId}` bindings. Descendants remain inside that persisted objective; other objectives/vaults are not admitted.
- `futureOwnerMessageAfterSeq`: a one-time captured persisted message sequence fence, not a date filter. Only newer owner-authored messages without agent/registration attribution and with the authenticated owner's author identity qualify. Event-bound server notices cannot qualify. Subsequent objectives rooted in those new instructions can progress; old backlog is still held.
- `maxConcurrent`: `1` or `2` caps simultaneous queued/running claims across the owner's agents and channels; explicit `"unlimited"` disables only that capacity cap. Missing/null values remain invalid. Capacity does not authorize historical work or override Stop/session/provider controls. A request for two simultaneous workers means concurrency, not a two-start lifetime allowance. Authorized sequential dependency stages continue after earlier runs settle.
- `qualificationBudget`: optional `{afterRunId, maxStarts}` for a bounded real recovery qualification. It limits claims for explicitly recovered workflows, counts persisted starts even after completion/reboot, and does **not** block genuinely new owner requests. This is an operator testing limit, not a normal long-running workflow default. A retained running delivery remains deliverable after the start budget is exhausted. Removing/changing this limit is an explicit operational decision, never an automatic test cleanup.

Do not remove the admission file to fix chat or resume work. Update its content under the deployment procedure, then independently compare the authenticated `/api/execution-admission-v1` policy to the intended complete object. On-disk replacement alone is not runtime activation.

## Evidence and limits

Regression coverage exercises actual SQLite task/outbox state, separate BEAM crashes before and after transaction commit and restart, native Node Git workspace creation, exact dependency commit inheritance, quiet coordinator acknowledgment, correction bounds and durable blocker receipts. Real Socket.IO fixtures prove old-work rejection and newer owner-work delivery across disconnect/reconnect; fixture runners never invoke a model. Isolated Chromium exercises actual built App human/coordinator grouping, original-root context actions, exact-registration Stop, and sidebar geometry.

These are execution-mechanism tests, not proof of an arbitrary multi-day production workload. Live qualification, exact release revision, actual task/provider outcomes and external deployment verification must be reported separately. A worker completing research, a green unit suite or a successful push alone is not whole-request delivery.
