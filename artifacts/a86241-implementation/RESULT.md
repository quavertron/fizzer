# Mission preview and background repair

Base: origin/master `65cec0d24e4dc7cdca45036a653501d6f0410c4a`, fetched and fast-forwarded on the registered branch before edits. Scope: brief note-v1:1 plus authoritative owner clarification `msg-1789642430748-23kuyy` (persistent mission card background, not mission-history modal). No history-modal changes.

## Delivered behavior

- Collapsed mission uses the existing dot, meaningful live summary, status and exact-owner Stop as its single preview. Opening shows the original task details and full embedded worker trace. Removed the duplicate collapsed task/trace rendering path; no message/content deduplication or ownership changes.
- Removed only the collapsed `background: transparent` override. The existing mission gradient remains in both collapsed and expanded states; compact border/shadow styling is retained.

Product files: `client/src/components/ChatMissionCard.tsx`, `client/src/index.css`.
Regression files: `client/src/tests/workTrace.test.ts`, `scripts/test-mission-preview-browser.mjs`, `scripts/fixtures/mission-preview-public-replay.json`.

## Evidence

- `unit-before.log`: real mission-card plus forced-open trace composition fails on the duplicate trace body (47 other tests pass). `unit-after.log`: all 48 pass.
- `browser-regression-before.log`: desired one-preview invariant fails with 2 copies on the unmodified base.
- `browser-before.log`: controlled headless Chromium confirms duplicated visible prefix and missing collapsed background at desktop 1280px, narrow 390px and a 420px split-width container. Corresponding `before-*.png` show actual CSS/layout.
- `browser-after.log`: all three widths pass single visible preview, same nonempty background image collapsed/expanded, full trace expansion, human root and separate coordinator answer, exact stored coordinator Stop payload, increasing/repeated public text snapshots, final replacement and reconnect reconciliation. A separately identified assistant answer with identical prose remains visible independently.
- `after-*.png`: development preview screenshots, collapsed and expanded, ready for feedback. Real ChatView/card/trace and production CSS in a controlled Vite fixture; synthetic surrounding human/coordinator rows and fully intercepted APIs. Split check is constrained ChatView width, not the full App pane manager.
- `build.log`: `npm run build` passed. `typecheck.log`: `npm run typecheck:client` passed.

Reproduce: `npm --workspace=client test -- src/tests/workTrace.test.ts`; `EVIDENCE_DIR=/tmp/mission-preview node scripts/test-mission-preview-browser.mjs`; `npm run build`; `npm run typecheck:client`.

Replay reuses the research public-only run 4244 events with original event/task/run/mission/message IDs. It derives client projection snapshots from these events and exercises actual client reconciliation; it does not re-execute a provider or backend ingestion. Before screenshots were regenerated against exact base versions of the two product files, then current bytes restored. No personal desktop, live human writes, workers, push or deployment. Independent review and coordinator integration/release remain outstanding.
