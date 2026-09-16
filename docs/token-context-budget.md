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

This change does not implement guidance-by-session delivery, bound all historical
declines, remove acknowledgment recovery turns or repair replacement-session
cold-start construction. Those paths need delivery/compaction/recovery evidence;
dropping them merely to improve a token score risks losing constraints or work.

Checks: backend interpretation and next-step tests; CLI usage and inert Codex
app-server protocol tests (also run with `FIZZER_TEST_CLI_MODULE` pointing to the
compiled module); frontend harness activity tests. All use inert providers.
