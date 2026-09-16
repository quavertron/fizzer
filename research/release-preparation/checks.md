# Candidate checks

Commands ran in the registered preparation workspace. Headless browser commands unset DISPLAY and WAYLAND_DISPLAY; synthetic fixtures only.

| Command | Result | Evidence |
| --- | --- | --- |
| `npm run build` | passed | checks/build.log |
| `npm run test:release:frontend` | 45 files, 439 tests passed | checks/frontend.log |
| `npm run test:release:backend` | 510 tests passed | checks/backend-rerun.log |
| `npm run test:release:desktop` | 141 passed, 1 skipped (platform), 0 failures | checks/desktop.log |
| `node scripts/test-note-saving-browser.mjs` | 12 App/Popout checks, zero page errors | checks/save-browser.log |
| `node scripts/test-human-mission-content-browser.mjs` | 12 composed UI checks, including original reply and exact coordinator Stop | checks/human-browser.log |
| `node scripts/test-work-summary-browser.mjs` | 8 status/viewport cases, keyboard/click expansion | checks/dot-browser.log |
| `node scripts/test-voice-session-browser.mjs` | 9 source/lifecycle checks; mocked SFU/HTTP | checks/voice-browser.log |
| `node scripts/test-kanban-completion-browser.mjs` | component fixture passes | checks/kanban-browser.log |
| `REVIEW_EVIDENCE=... node scripts/test-combined-save-kanban-browser.mjs` | mounted App category/drag/save/aggregate/reload and 403/409/network retention pass | checks/combined-browser.json |
| `REVIEW_EVIDENCE=... node scripts/test-combined-save-kanban-http.mjs` | real HTTP/Router/SQLite/markdown persistence and genuine concurrent revision conflict pass | checks/http-browser.json |
| `node scripts/test-chat-projection-browser.mjs` | real backend + two browsers: stream/cancel/Stop retry, snapshot outage/recovery, suppression/reload, clear-session, offline close/reconnect, logout cleanup passed | checks/projection-browser.log |
| `git diff --check` | passed | rerun before commit |

The combined browser/HTTP scripts were reused from the accepted saving review, with the HTTP manifest path changed to this task. Start the synthetic HTTP fixture via `cd backend_elixir && MIX_ENV=test mix run ../research/release-preparation/isolated-server.exs`; it writes a temporary `/tmp/bf273e-server.json` containing only synthetic test auth and file paths. The run was stopped and the temporary token manifest and synthetic markdown root removed. No real notes or sessions are involved.

## Corrected attempts and limits

Initial frontend checks caught unused imports after the merge and older tests expecting superseded labels/baselines. Fixed imports and reconciled those assertions to the accepted save and summary behavior; complete frontend suite now passes. Initial desktop attempts lacked its separately installed dependencies and root build output; installed dependencies with scripts disabled, ran required build, then reran the full desktop suite successfully.

The first full backend suite had one notification crash-probe race (expected simulated exit 23, got 0). No product or test change was made for that result. Its focused suite passed 14/14, then the complete suite passed 510/510. Treat the first result as observed nondeterminism, not a falsely claimed uninterrupted green run. Raw first-run logs remain in `/tmp/bf273e-snapshot/backend.log`.

The old primary projection fixture first intercepted per-message hydration, whereas current master recovers via channel snapshots; corrected the interception. It next expected offline queued shells, whereas master b512bc75 keeps offline outbox work quiet. Reconciled that obsolete expectation without restoring the superseded runtime behavior. A subsequent fixture-only rerun caught a leftover deleted-loop variable; removed it before the final run. Running Stop failure/retry remains in the real-backend fixture; queued Stop source/component/backend safeguards remain unchanged.

Prior exact voice review includes real synthetic two-client SFU/media evidence; this preparation did not repeat microphone/media tests or deployment verification. Saving HTTP tests control auth/listing/socket fixtures around the real persistence path. Root build is the required local build; production client bundle/deploy verification belongs to the integration/release owner.
