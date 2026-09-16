# Request timing evidence

New runner versions emit `timing` run events through the existing run-event
stream, persisted by the backend on delivery. Like ordinary activity events they
can be lost across disconnection or bounded-buffer eviction; they do not inherit
the special durable terminal-status receipt guarantee. Group by run ID and payload `requestId`. Each observation contains
`boundary`, `phase` (`request_start`, `first_response`, `completion`), UTC
`observedAt` from the runner clock, and monotonic `elapsedMs` since request start.
Completion also includes `outcome`. First response and completion occur at most
once per request ID. A silent failure has no first-response event. A lost runner
may have no completion; do not fabricate it from a later dispatch repair.

These are **agent invocation boundaries**, not individual HTTP/model requests:

- `codex_app_server_turn`: start immediately before submitting `turn/start`, after
  local thread serialization and initial thread setup. First response is the first
  observed non-user, non-compaction item notification (including reasoning or a
  tool), not the protocol acknowledgement. Completion is receipt of
  `turn/completed`, or local failure settlement. Notifications received before
  the acknowledgement retain their original observation times when replayed.
  Active-writer recovery/retries after submission remain inside this span.
- `cli_process_stdout` and `claude_cli_stdout`: start immediately before spawning
  the CLI with the request; first response is the first stdout chunk, which can
  be startup metadata or buffered output, not necessarily model text. Completion
  is process close/error, or local idle-timeout settlement. Stderr diagnostics and
  Fizzer-generated heartbeats do not count as first response. Each process retry
  has its own request ID. A zero exit means process success, not proof that the
  provider supplied an answer; existing result validation remains authoritative.
- `agentapi_process_stdout`: the same process boundary for Antigravity's agentapi
  command. Its stdout can be a single final JSON blob, so first response can be
  near completion even when transcript activity was visible earlier.

Time to first response can contain startup, transport, retries, provider waiting,
model execution, and buffering. It is neither pure provider queuing nor pure
inference time. Completion minus first response also includes tools and further
model calls. No queue/model split is inferred. UTC clocks on different runners
can differ; use `elapsedMs` for durations within a request, and retain server event
receipt timestamps separately rather than substituting them for observations.

For mission wall-clock attribution, retain the existing dispatch/run/task events
for orchestration and structured tool-use/tool-result pairs for tool spans. Clip
intervals to the mission window and take their union before measuring elapsed
coverage: concurrent tools, workers, and parent/child runs must not be summed.
The new request intervals are enclosing context, not an additional exclusive
category to add to tool or orchestration durations. Subtract the union of known
tool and orchestration intervals from request coverage to describe the remaining
**unclassified invocation time**; time outside all known coverage remains
unclassified too. Missing tool endpoints or clock uncertainty must remain explicit.

The durable off-Fizzer dispatch/completion paths are unchanged: timing events are
ordinary evidence, never terminal run status or mission completion authority.
Existing installed runners emit no new evidence until they adopt this version;
server deployment alone cannot instrument an old desktop binary.

Historical mission `b9c30149-c380-499a-b607-f46153431bc9` remains 18m56s total with
13m28s unclassified. New observations cannot retroactively split that gap into
provider waiting and model execution.
