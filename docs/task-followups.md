# Server-owned task follow-ups

`Cascade.Missions.Notifications` is independent of model interpretation and runner availability. Its bounded reannouncer job uses the existing mission event outbox and system-labeled automation chat persistence (`agentId: fizzer-task-status`, never a human instruction), with no invocation/member/reply hooks and no new schema. Scheduler calls also save receipts immediately. A `Noop` event sink cannot acknowledge delivery; periodic maintenance drains those saved messages.

Each task attempt/outcome category has an immutable ID:

`task-notification:<task-id>:<attempt>:<category>`

The message and `task_notification` event commit together under an immediate SQLite transaction. The existing source-key uniqueness constraint and message primary key arbitrate concurrent processes. After fanout, `task_notification_sent` records the event ID. A crash after fanout but before acknowledgment can replay the **same** message ID: clients must upsert by ID. This is durable, idempotent at-least-once fanout, not exactly-once network delivery, a push-notification receipt, or proof a person read it. Reconnecting clients can read the persisted channel message.

## Evidence and waiting

- Saved blocked/failed task summaries get a fallback even when a coordinator cannot start or acknowledges `noMaterialChange:true`. Missing summaries are explicitly diagnosed as missing, not invented.
- Completion uses Store's existing bound run/task/workspace evidence predicate, not the mission's global status. A completed flag without that evidence produces `evidence-missing`, never a success notice. A task outcome does not establish objective fulfillment or independent real-world verification.
- Dependency attention, an actual owner migration-decision gate, and recorded dispatch errors get explicitly **waiting/nonterminal** notices. Ordinary capacity and queue waits do not get unsolicited terminal notices. No task status is changed by notifications.
- The task projection retains `queueReason` and adds `waitingReason` with dependency/capacity/approval/provider/dispatch detail. Scheduling of independent ready tasks is unchanged.
- One immutable receipt per category/attempt avoids diagnostic/retry spam. A changed summary in the same category is still available on the task; it does not generate a second fallback receipt. A new attempt or different outcome category has a different ID. Existing coordinator-authored explanations are not suppressed or mistaken for this machine receipt.

## Scope and control

Periodic maintenance reconciles existing noncompleted/noncanceled mission backlog, including earlier unresolved tasks. Historical completed missions are not mass-backfilled. A saved pending receipt remains selected after mission completion. Explicit scheduler reconciliation covers a newly completed mission. Tasks with no mission and unstructured chat promises are not inferred as tracked tasks; the owner/integrating agent must inventory those obligations separately.

Cancellation/interpretation Stop suppress pending fanout; current owner/channel access is rechecked before persistence and each fanout. Already persisted messages are retained as history, not deleted by Stop. Revocation is not retroactive cancellation of an event already handed to transport. No worker execution, auto-retry of a completed action, approval grant, coordinator membership, Missions UI or dedicated-channel allocation is added.

## Verification

`mix test test/cascade/missions/notifications_test.exs` exercises real SQLite, coordinator quiet acknowledgment, runner-offline fallback, mixed dependency/ready work, completion evidence refusal, explicit waiting reasons, failed/Noop fanout, Stop/access revocation, concurrent callers, and an actual separate-BEAM crash after publication followed by two concurrent restarted BEAM processes using the same disposable test DB. The periodic recovery regression asserts the exact new system receipt and unchanged dispatch/run sets, rather than assuming an offline owner receives no status at all.
