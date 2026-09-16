# Owner source collaboration through the private adapter

`collaborateOwnerSource` is a narrow task-control plan/apply/reconcile operation.
Arguments: `vaultId`, `channelId`, `sourceMessageId`, `registrationId`,
`vaultAgentId`, `instruction`. Use one stable request ID (also the backend
continuation message ID). Relationship is fixed to `builds_on`.

The selected vault must be private and solely owned by the authenticated local
owner. Source must be the exact human-authored owner message, not an agent or
registration message. The SELECT-only execution endpoint binds the target to
that owner, vault/channel and identity. Preview includes the complete source and
existing execution permissions. Apply requires a host-private exact-plan grant
from an actual direct CLI owner turn, not approval inferred from retrieved text.
Changing source or execution settings after preview refuses the write.

This is the native human collaboration endpoint with ordinary Chromium browser
CSRF. It preserves existing permissions, including an explicitly previewed
existing yolo=true. It does not change or bypass the separate createMission or
repository-binding guards. It does not start a run directly, allocate a mission,
change admission or resume a historical dispatch. Normal backend collaboration
may materialize its channel-member projection; it is an intentional model-capable
write, never a read-only probe.

Persist intent before POST. Apply/reconcile after an uncertain response only
reads the stable exact message; never automatically POST again. Independent
readback checks owner, body and source relationship. Returned dispatch is the
original response receipt, not an independently fetched dispatch. If the response
was lost it is null; inspect exact persisted dispatch/run separately before
claiming worker execution. A verified message is not a completed objective.

The existing `along-fizzer-app plan`, `grant-task --owner-turn`, `apply` and
`reconcile` commands support this operation; grant creation is never exposed on
the socket. Source desktop activation needs a safe main-process reload because
Node caches task-control. Merely editing a file or renderer reload is not proof.

Focused fixture: `ALONG_FIZZER_CLI=/path/to/along/fizzer node --test
cascade-electron/task-control.test.cjs`. Exercises real private Unix socket and
HTTP, ordinary CSRF, positive yolo-preserving collaboration while createMission
still refuses, missing/expired/wrong-owner grants, agent/other-owner source,
identity/source/settings drift, byte bounds, unknown response across restart,
exact stable readback and no replay. No live model fixture.
