# Independent review: accepted

Task: 43279442-fd57-4635-b97b-094140cabedd
Exact accepted candidate: `78f372f1743ffc4e355a9108f2ffbca2f894740c`
Fetched origin/master baseline: `e619d5770bcd4c9e4c9b301be091e7d54e75cea5`
Prerequisite: `08997707236a502f860f651d69290da3a72343b1`
Independent stable patch-id check: prerequisite and accepted human fix `4bf74b3d44733878336ee003f6439f9120ce8cc9` both yield `ac6d5ed6d6bfb97dfcc8e1c6f03916a8f73f540c`.

No blocking findings. Both collapsed surfaces reuse `.chat-mission-state` and existing public work data. Public output selection excludes thinking, tool input/results, redacted text and harness logs; status remains separate from summary text. Empty/placeholder content falls back to truthful status/task/title information. Expansion, keyboard controls, narrow wrapping, human/Astra attribution, original Reply and exact coordinator Stop passed the checks below.

## New voice/human report: reproduced render suppression, not storage deletion

Opened the explicitly supplied screenshot `msg-1789586479990-cuoqel-0.png`. It shows a blank row immediately above the voice mission; the screenshot alone cannot prove deletion or identify a cause.

Research fixture `human-voice-review.mjs` imports the actual composed ChatView, message store, remote-upsert/snapshot reconciliation and transcript segmentation. It uses synthetic identities and a synthetic voice mission with the exact supplied body `and switching vaults leaves the chat. fix all 3`. It uses no personal desktop, account session, database or live message data. The API is mocked with shaped empty responses.

At both 1280px and 390px:
- Baseline renders the original human text before a linked trace exists. Adding the linked running trace leaves the original store row/body unchanged but creates a body-empty carrier and a blank human row (zero body paragraphs).
- Baseline remains blank with empty, populated and replacement mission summaries, duplicate trace upserts, steering interruption, reconnect snapshot, and fresh mount. It also remains blank when the mission completes while retaining the steered trace. Once the trace settles into a full public reply, the baseline body becomes visible again.
- Candidate renders the exact original human body once in all those states, including both completed-state variants and completed reconnects. Its carrier, when present, equals the canonical synthetic root. Human and Astra rows remain attributed separately.
- Candidate mission Reply previews the original human body. Stop issues exactly `/api/vaults/fixture-vault/channels/fixture/missions/m1/finish` with `{status:"canceled",coordinatorRegistrationId:"reg-astra",summary:"Stopped by user."}`.
- Attachment-only human roots, ordinary humans, agent-created missions, explicit deletion and authoritative snapshot deletion remain correct.

This independently reproduces an analogous presentation failure and proves the candidate fixes that path. It does not establish the exact production event sequence, actual server storage, or eliminate every possible cause of the owner's screenshot.

## Independent checks

All completed successfully on the exact candidate:
- `npm --workspace=client test -- src/tests/workTrace.test.ts src/tests/workTraceStyles.test.ts src/tests/missionAttribution.test.ts`: 51 tests; `unit.log`.
- `node scripts/test-work-summary-browser.mjs` with EVIDENCE_DIR set here: eight desktop/phone x running/completed/failed/canceled cases, summary and dot rendering, status labels, border removal, overflow, Enter/Space/click expansion, Stop presence; `summary-browser.log`, `after-*.png`.
- Extra research Vitest `independent-review-432794.test.ts`: privacy/public-output/fallback matrix across running, queued, sending, failed, canceled and completed; placeholder/steering exclusions; mission summary/task/trace/title fallback. One test containing the matrix passed; `summary-matrix.log`. Copied temporarily into client/src/tests for Vitest, then removed. Reusable test artifact is retained here.
- `REVIEW_ROOT=<candidate checkout> node /tmp/432794-review/human-voice-review.mjs`: all composed voice/human stages at both widths; `candidate-human.log`.
- `EXPECT_BEFORE=1 REVIEW_ROOT=/tmp/432794-review/baseline node /tmp/432794-review/human-voice-review.mjs`: all expected baseline loss/control stages at both widths; `baseline-human.log`. PASS in this log explicitly means the expected baseline defect/control was observed, not that baseline preserves the body.
- `npm --workspace=client run typecheck`: `typecheck.log`.
- `npm run build`: `build.log`.
- `git diff --check`; clean final git status on candidate and detached baseline.
- Visually inspected synthetic baseline/candidate 390px screenshots and failed-state phone summary screenshot. Final baseline/candidate screenshots use corrected shaped API mocks with no fixture error banner.

## Artifacts and changed files

Review artifacts only: `/tmp/432794-review/evidence.md`, `human-voice-review.mjs`, `independent-review-432794.test.ts`, logs and synthetic screenshots. `summary-matrix.ts` is the initial direct-tsx research attempt; it could not load Vite import.meta.env, so the successful check is the Vitest artifact/log instead. Baseline dependency setup initially needed its own install; final baseline run exited zero.

Candidate product/test files reviewed relative to fetched master:
- client/src/chat/workTrace.ts
- client/src/components/ChatMissionCard.tsx
- client/src/components/ChatWorkTrace.tsx
- client/src/index.css
- client/src/tests/workTrace.test.ts
- scripts/test-human-mission-content-browser.mjs (prerequisite)
- scripts/test-work-summary-browser.mjs

No product edits, commits, pushes, nested workers, integration or deployment were performed. Registered review branch remains `cascade/4e23ed0d/review-dot-summary-candidate-and-432794` at the exact candidate with a clean tree. The primary checkout was not modified. Baseline is an isolated detached worktree under this artifact directory. Existing save-combined review and human review ownership were not changed or duplicated.

Limits: synthetic headless frontend review, no actual voice/media transport or personal desktop check, no production deployment or health claim, no mobile-device/swipe gesture test. Independent build is root build plus client typecheck; implementation-reported client bundle build was not rerun. Coordinator retains single integration/release and exact live verification.
