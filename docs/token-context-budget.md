# Routine context and token accounting

Routine coordinator carry-over is a projection, not the durable record. A mission
with no accepted open commitments, unanswered questions, pending evidence or
nonterminal tasks/findings carries its objective, interpretation revision,
questions, unfulfilled/refused commitments and a full-retrieval command. Its old
assessment, findings and accumulated evidence references are not replayed.

Active and failed work retains the complete baseline. An interpretation wake
still supplies its complete evidence. Explicit `mission interpret` and history
retrieval remain unchanged. The projection does not complete a task, acknowledge
new evidence, authorize a retry, cancel work or change Stop. Cold-start routine
context does not depend on an in-memory prior-delta cursor.

Use the supplied interpretation revision/fingerprint when writing. Read again
when omitted evidence is needed or after a conflict, not to acknowledge every
unchanged carry-over record. Suggestion context prints each owner feedback body
once with subsequent same-source references; it does not discard declined topics.

## Accounting

Codex's cached input is a subset of input. The normalized harness receipt now
separates `usageScope` (`request`, `turn`, `session`, `unknown`), last request input,
cached/uncached input, output and cumulative session counters. Cumulative-only
notifications do not become request counts or context occupancy. Last-request
input may describe occupancy; cumulative total tokens and turn aggregate usage
cannot. Early usage notifications with an explicit turn ID use the existing
notification buffer, so a notification racing `turn/start` is not discarded.
The UI retains the scope and does not add cached input twice or present scoped
aggregate counters as context occupancy.

These receipts are observations, not an additive billing ledger. A consumer must
not sum repeated thread snapshots. Provider-response identity and failed-request
coverage are required for an exact request ledger. Account subscription-window
percentages are not attributable token counters.

## Offline comparison and limits

Compare the same recorded packet through the baseline and candidate production
projection, then count both texts with a named deterministic tokenizer. Report
packet input reduction separately from cumulative provider input, cached and
uncached input, output, model calls and account allowance. A large packet saving
is not evidence of equal end-to-end or quota savings. Preserve recorded tool
outputs and request counts rather than assuming the model would do less work.

## Session guidance and explicit evidence disposition

Persistent Codex places the single account-guidance block in the provider's
`developerInstructions` thread field, instead of appending it to every user turn.
The current document is supplied on each open/resume and every replacement, with
current model/configuration. Codex owns durable session metadata; Fizzer adds no
in-memory delivery cache, new ledger or database. Imported sessions are exempt so
their original instructions are not overwritten; ambiguous multiple guidance
blocks and nonpersistent/other-provider paths retain their existing full text.
The guidance explicitly remains subordinate to current user and authorization
constraints. Account updates replace that field, not historical storage.

Codex dispatches carry the bounded cold baseline even when a prior session was
found. This deliberately retains some repeated context rather than letting a
missing/busy-thread fallback infer from a continuation-only prompt. It is a safety
tradeoff, not a claim that all stable instructions are now deduplicated.

Full interpretation reads now return an exact evidence fingerprint even before
maintenance claims a batch, plus explicit `pendingEvidence`. A live coordinator's
explicit read/save acknowledges that exact snapshot transactionally; the next
scheduler tick does not buy a second model turn for already-disposed evidence.
Raced evidence conflicts. Compact dossiers have no acknowledgment fingerprint,
and legacy empty cursors remain writes rather than acknowledgments. New agenda
items, changed findings/notes, Stop and missing-disposition recovery still retain
their existing lifecycle semantics. Provider success alone never acknowledges work.

Offline verification includes actual installed Codex 0.153.3 against a loopback
inert Responses endpoint (no external inference): identical recorded guidance on
two turns appeared once then twice in baseline serialized requests, once then
once using native thread instructions. Four actual serialized request texts were
counted with tiktoken0.14.0/o200k_base: baseline 23,932 versus candidate22,307 text
tokens. This controlled guidance-only replay excludes real job/tool execution,
cache effects and generated output; it is not an80% workload result. Scheduler
and real Socket.IO dispatch tests separately cover explicit save, unchanged
maintenance, raced evidence and cold baseline. Full real-workload savings remain
unmeasured; historical declines are still not globally bounded.

Checks: backend interpretation and next-step tests; CLI usage and inert Codex
app-server protocol tests (also run with `FIZZER_TEST_CLI_MODULE` pointing to the
compiled module); frontend harness activity tests. All use inert providers.
