# Agent runtime

## Supported adapters

The shared agent adapter is `cli-agents/cli-agent.ts`. Current agent IDs include
Claude Code, Codex, Grok, Antigravity, Copilot, Hermes, Akron Grok, OMP, and Pi.
Available models may be supplemented by a live capability probe from the
desktop.

Provider credentials are not stored on the Cascade server. Authentication is
owned by the local CLI or provider SDK on the desktop that executes the run.

## Chat run lifecycle

Chat agent registrations have a stable Cascade conversation ID. The server maps
that conversation to a provider session ID when the provider supports resume.

These IDs are deliberately distinct:

- `conversation_id` groups Cascade runs for one registered chat agent;
- `session_id` is the backing provider/CLI session returned by a completed run.

Follow-up steering is serialized per registered agent conversation. A second
top-level prompt waits for the active turn to settle so the server can persist
its provider session ID before the next run resumes it.

Backing chat sessions remain continuous by default so the provider harness can
compact them just as it does in the direct CLI. Optional rotation bounds are
documented in `.env.example`:

```text
CHAT_SESSION_MAX_RUNS=0
CHAT_SESSION_MAX_AGE_HOURS=0
```

A rotation retains the Cascade conversation ID and injects bounded recent
channel context into the new provider session.

## Event protocol

Providers normalize their output into run events such as:

- `status` — queued, running, completed, failed, or canceled;
- `text` — response, reasoning, and tool-use blocks;
- `user` — tool results represented as user-side provider messages;
- `harness` — raw terminal trace;
- `cascade-stats` — model, token, context, turn, and rate-limit telemetry.

`client/src/chat/runBlocks.ts` and the server-side folding helpers in
`backend_elixir/lib/cascade/chat/` convert this event stream into persisted
chat content. The
session manager exposes readable activity and a separate raw console view.

## Agent helpers

Agent subprocesses receive these commands on `PATH`:

- `cascade-note` — list, read, create, edit, move, and find live notes;
- `cascade-chat` — inspect channel history, open attachments, and send messages;
- `cascade-scratchpad` — store and recall durable agent knowledge.

Run each command with `--help` for its current interface. Helpers use a
restricted token and scoped environment supplied by the desktop runner.

Use scratchpad storage only for durable causes, decisions, and dead ends.
Routine progress belongs in the run trace.

## Chat-first orchestration

A channel may designate one registered agent as its coordinator. This is a
membership setting, not a separate project-management surface:

- ordinary messages route to the coordinator owned by their author; other
  users' agents require an explicit opted-in @mention;
- an explicit `@specialist` mention takes the direct zero-hop path instead;
- the coordinator answers tiny Q&A and one-liner fixes itself;
- for almost any non-trivial request it creates a **mission** — durable,
  searchable task data projected on the chat transcript (subagents optional;
  a solo mission the coordinator executes alone is normal);
- for parallel or long work it may also delegate focused tasks to other
  registered channel agents, or to anonymous subagents of a named agent
  (including itself) via `mission delegate --anonymous`.

The provider session remains the reasoning and execution environment. Cascade
only supplies the durable coordination substrate through `cascade-chat`:

```text
cascade-chat members
cascade-chat mission start --title "..." --objective "..."
cascade-chat mission delegate --mission <id> --to @agent --task "..." --message "..."
cascade-chat mission delegate --mission <id> --to @agent --anonymous --effort high --task "..." --message "..."
cascade-chat mission status --mission <id>
cascade-chat mission list
cascade-chat mission history --mission <id>
cascade-chat mission retry --task <id> --summary "..."
cascade-chat mission finish --mission <id> --summary "..." --verification "Observed checks and artifact/live revision evidence"
```

Named assignees still get at most one active mission task at a time.
`--anonymous` creates a parallel clone of that agent (isolated session, no
extra channel membership) so a coordinator can fan out several sols at
different effort levels without registering duplicate members. Workers inherit
that agent's tools and authority, not its coordinator role: they execute one
task and cannot start or delegate missions. A worker can create up to eight direct
child tasks under its own task, using its own agent identity and the existing runner
concurrency limits. Children start isolated worktrees from the parent's committed
workspace state. Commit prerequisites before creating a child; uncommitted edits
are not inherited. Children cannot delegate further:

```text
cascade-chat mission child --task "Parser tests" --message "Implement only the parser regression tests"
cascade-chat mission join
```

The parent keeps doing independent work, then ends its turn to join. Once its
children settle, the same parent task resumes with each child's summary, branch,
workspace and verification for integration. Failed or blocked children must be
resolved before parent completion. Stopping a parent cancels unfinished children;
steering the parent preserves them. Recovery retries unacknowledged stops for every
canceled task, including parents, until the runner acknowledges cancellation.
Children do not trigger a separate mission
review. The parent owns integration and the coordinator performs the final review.

`chat_missions` and `chat_mission_tasks` are authoritative, while
`chat_mission_events` is an append-only timeline with no retention window. A compact mission
projection is materialized on the root chat message so it arrives in the normal
transcript, Socket.IO updates, linked multiplayer channels, and reloads without
a second client-owned task store. Worker terminal events update their task. A
failed or blocked task puts the still-open mission in `attention`; dependent
tasks remain pending instead of being permanently blocked, and retrying keeps
the task identity, workspace, and evidence. The coordinator reviews and
integrates worker evidence, then explicitly finishes the mission; worker
completion alone puts a mission in `reviewing`, not `completed`.

Chat-to-agent intent is also an outbox (`chat_agent_dispatches`). Message and
target survive renderer reloads and reconnects. The server admits and starts
ordinary chat, worker, and review turns without an open chat page. It preserves
requester and owner identity and rechecks access before starting a run. A unique
run key prevents duplicate starts. Bounded jobs serialize each agent session while
other sessions continue through slow desktop acknowledgments. Offline owners'
requests remain untouched until their runner reconnects, preserving maintenance
cutover checks. Interrupted startups with no delegation lease settle as failed
once they are at least 30 seconds old and the owner reconnects, so their tasks can
be retried.

Desktop delegation retains its original payload in `delegated_runs` until an
owned native event confirms receipt. Unconfirmed deliveries replay the same run
ID and payload at 15-second intervals while the owner is online, with at most five
attempts before an explicit failure. They survive server restarts and wait without
mutating offline work. Native running events and heartbeats update the stored run
status; a recorded delegation alone is not proof that a worker started.

Electron main retains terminal events separately from its bounded event history
until the server acknowledges persisted settlement. Renderer reloads and unrelated
worker output cannot evict an unacknowledged completion. Duplicate receipts preserve
the first terminal status, including a prior Stop.

Explicit mission delegation is the permission boundary that lets a
coordinator call a worker which has disabled ordinary agent-to-agent mentions.
Shared-channel users can only launch registrations whose owner enabled
multiplayer pings.

## Prompt and context layers

A chat run may combine:

1. a short agent/channel instruction;
2. the current user request;
3. current workspace ancestry and project context;
4. recent channel messages on a cold start;
5. bounded memory and scratchpad recall for cold starts.

Every agent path also receives a shared chat-brevity rule from
`formatAgentChatPrompt` / `CHAT_REPLY_BREVITY`: the final bubble stays short
(outcome first; no process essay). Verification and intermediate detail belong
in the run trace. Coordinators keep mission finish summaries short as well.

Stable application capability context is not re-sent to a resumed session.
Private note blocks are redacted after all context assembly and immediately
before delegation.

## Durable authority and completion evidence

Mission creation snapshots owner-authored messages in the root reply chain.
Use `mission start --authority-messages <id,id>` to include earlier explicit
instructions from the same channel. Agent-authored messages cannot be recorded
as user grants. Saved instructions and the mission objective accompany worker
and review dispatches. Existing missions have empty source records; recover their
original user context when authority is unclear. Later user corrections and
revocations take precedence over saved instructions.

These records preserve context, not additional tool permissions. They do not
constitute a general spend/deploy permission system. Coordinator completion
requires `--verification` separately from the worker summary, alongside the
existing bound-run evidence checks. Record actual check results and inspectable
artifacts or live revisions. The server checks presence and provenance of run
records; the coordinator remains responsible for verifying external claims.

The server replays unclaimed worker and review dispatches and reconciles terminal
run records whose mission callback was missed. Consumed reviews wake again only
when task evidence changes; an unchanged blocker or failed closure does not start
another review. Missing outbox entries replay the same deterministic review.
Legacy reviews adopt their current evidence fingerprint without a deployment wake.
Canceled reviews and closed missions are not resumed. Periodic recovery waits for
the mission owner's runner to reconnect and requires a running server.

A coordinator can use `mission link-recovery` to attach successful recovery-task
evidence to a settled original task, including across missions owned by the same
user and coordinator in the same channel. Supply the exact original `--objective`,
`--task`, `--target-attempt`, `--target-run` when bound, `--source-task`,
`--source-run`, and observed `--verification`. The relationship pins the task,
objective, authority, run binding, and evidence snapshots; later edits or retries
invalidate it. It permits closure without changing the failed original run or task
history. Workers cannot create this attestation or finish missions. Unchanged
blockers should be reported, not assigned ceremonial verification workers.

Dispatch/run uniqueness and task idempotency prevent duplicate admission. Shared
workspaces still require agents to preserve unrelated files or use isolated
worktrees; the mission scheduler cannot lock arbitrary external side effects.
Production deployment serialization remains owned by GitHub Actions.

A coordinator can redirect its own worker with
`cascade-chat mission steer --task <id> --message "<correction>"` (stdin also works).
The helper pins the current task attempt and run. The server records the instruction
in mission history, waits for provider stop acknowledgment, and resumes the saved
provider session in the same task/work item and workspace. The correction replaces
repeated task instructions in the continuation; existing context and file edits
remain. Worker dispatches never interrupt the coordinator's foreground session.

The acknowledgment distinguishes queued instructions from a dispatched worker run;
dispatch is not proof that the agent acted on them. Queued steering replays through
the existing server outbox, including after reconnect. Only one outstanding correction
per task is accepted. Steering waits if no provider session has been saved, rejects
finished or changed tasks, and is revoked by an explicit stop. Mission history records
the request and outcome; the following task-start event identifies the continuation.
Workers cannot steer peers, and steering another owner's worker is rejected.

## Cancellation and recovery

Cancellation is routed to the owning desktop and then persisted server-side.
Run events and linked chat messages are settled even when the initiating client
is no longer connected.

Brief runner disconnects receive a grace period. After a server restart, the
desktop reports active run IDs so ownership can be reclaimed before orphaned
runs are failed.

Revision conflicts from app context, coordinator continuation, and mission
interpretation return HTTP 409 with `code: "revision_conflict"`, `currentRevision`,
and `changedFields`. The CLI preserves this JSON in its error output and exits
unsuccessfully without retrying the write. `changedFieldsBasis: "submitted_values"`
means the listed persisted fields differ from the values in this request; omitted
fields and publication-only inputs are not compared. These records have no
historical baseline (`changesSinceRevisionKnown: false`), so an empty list does
not mean nothing changed. Re-read the existing detail endpoint and merge
intentionally before saving with the current revision.
