# Independent voice review — accepted

Task: 771915b2-ae08-4715-ad9a-d8f5795174f1. Mission fb9d1015-0435-4c31-83db-272bf6f4f7d0. Reviewed the authoritative note-v1:1 content supplied in the dispatch, the implementation REPORT.md, committed evidence, and actual source.

Exact accepted candidate: `f2a8715f52c3e1e379503994d2878ed017b73a5b`.
Parent: `e619d5770bcd4c9e4c9b301be091e7d54e75cea5`.
Candidate `/tmp/fizzer-voice-0bc4b1` was clean before and after review. Independent detached review checkout: `/tmp/fizzer-review-771915`. No product changes, nested workers, integration, push, or release. No blocking findings.

## Findings

- Footer: Sidebar renders controls after the existing music section and before account settings. It removes the prior fixed panel/padding workaround. Closed-sidebar controls use the 900px mobile breakpoint. A single app-level received-audio host remains mounted across sidebar/control remounts and ordinary vault navigation. Actual App/SFU fixture verified footer geometry, music coexistence, open/closed mobile controls and audio retention.
- Avatars: the authorized roster request resolves the source route first, reads the existing channel participant snapshot with avatars, and matches server-issued metadata, user identity prefix, current membership and source room before hydrating a photo. It does not infer identity from display names or publish photos in SFU tokens/realtime metadata. Frontend merge is exact-identity and room/source bounded; omitted values preserve, explicit empty values clear, failures clear profiles, and late old-source results cannot hydrate another source. Tests include duplicate names/sessions, forged identity, invalid/wrong-source metadata, outsider denial and explicit clear.
- Continuity: join captures effective local API base/cookie mode or remote origin/token. Join, leave, deafen, active roster polling and late-token cleanup all use that captured source. Ordinary browsing does not run leave. The room highlight and explicit join compare vault/channel plus API origin/token, including identical IDs at another origin. Source labels and controls remain associated with the joined room.
- Lifecycle/privacy: generation/session checks fence pending token, connect, capture, publication and control work. Joins wait for pending disconnects. User/auth epoch changes and explicit logout leave; SFU disconnect and source 401/403/404 clean up. Tracks stop, received audio clears and polling cancels. Capturing a source credential for an active room does not create new server authority; backend membership checks and revocation sweep remain operative. No recordings/video/settings or account privilege expansion found.
- Minimality: the change reuses Sidebar footer, existing account auth epoch, existing API routing and authorized channel snapshot; the small polling helper is shared by active and idle rosters. No parallel voice/session store or new dependency was added.

## Independent execution evidence

All commands ran against the exact candidate unless marked parent. Dependency directories were reused/copied; candidate product files stayed untouched.

| Check | Result | Evidence |
|---|---|---|
| Parent research reproduction, clean e619d577 | Reproduced disconnect/track stop on vault switch, ignored avatar and absent footer placement; mutable generic routing reproduced | parent-reproduction.json |
| `npm test -- --run src/tests/voiceChannels.test.ts` | 5 passed | client-tests.log |
| `node scripts/test-voice-session-browser.mjs` | 9 passed | session.log |
| Same command with `--local-relative` | 9 passed | session-relative.log |
| Review-only `extra-lifecycle.mjs` importing unchanged candidate | 4 passed: pending token across navigation, exact same vault/channel IDs at new origin, delayed old disconnect before new join, pending capture across navigation and SFU disconnect cleanup | extra-lifecycle.log, extra-lifecycle.mjs |
| `npm run typecheck:client` | Passed | typecheck.log |
| `npm --ignore-scripts run build` | Passed actual root build and HTML preview build; skipped install lifecycle using existing dependencies | build.log |
| `FIZZER_MEDIA_OUTPUT=... npm run test:voice-html` | 6 passed, 37.6 seconds | media.log, media-verification.json |

Real SFU proof: two headless synthetic oscillator clients, relay UDP candidate, connected ICE, 118066 inbound bytes / 478 packets, measured audio energy 0.6349, retained audio through A→B→A navigation, avatar clear, footer/music/mobile checks, explicit room switch/privacy, reconnect, revocation observed in 1289ms, permission denial and delayed-capture cancellation. Fixture also passed existing hostile HTML checks. No personal desktop/display/microphone/speakers or live human writes. Fixture uses process-isolated SQLite/vaults and a dedicated internal Docker SFU/network; no fixture container/network remained afterward. The initial SFU startup curl retry was followed by successful startup and the passing test run.

Parent reproduction includes an unrelated existing local chat profile-overlay clear defect and an intentionally unpinned generic API call; those are not candidate voice failures. Candidate voice avoids that overlay and independently passed captured-source routing tests.

## Saving overlap and boundaries

Read accepted `2ec5165d9b65fa7797b15330557882eda1276eb0` without copying or integrating it. Its App.tsx saving manager, draft protection, save callbacks, keyboard handling and aggregate refresh changes occupy separate behavior from this candidate's voice hook arguments, logout cleanup and audio/control placement. Both candidates change the API routing guard to `targetOrigin === undefined`; retain that once. Preserve the saving candidate's ApiOptions comment and all accepted saving behavior during coordinator-owned integration. No combined-build claim is made.

Real media proof is local-app/two-local-vault only. Remote origin/token mapping and same-ID collisions were exercised with mocked HTTP/SFU, not two deployed remote instances. No production verification or release was performed. Acceptance applies only to this SHA; integration/release verification remains coordinator/Along-owned.

## Artifacts and changed files

Review changes are confined to `artifacts/review-771915/`: this report, command logs, parent reproduction, independent extra lifecycle fixture and compact media receipt. Raw synthetic screenshots/netlog remain at `/tmp/fizzer-review-771915/artifacts/review-771915/media/`; they are not needed for product integration.

Candidate product files reviewed: `client/src/App.tsx`, `client/src/api.ts`, `client/src/components/Sidebar.tsx`, `client/src/components/VoiceRoom.tsx`, `client/src/components/VoiceRoom.css`, and `backend_elixir/lib/cascade/chat/voice.ex`. Test changes reviewed: `client/src/tests/voiceChannels.test.ts`, `backend_elixir/test/cascade_web/voice_html_test.exs`, `scripts/test-voice-html-browser.mjs`, `scripts/test-voice-session-browser.mjs`. Implementation evidence is under `artifacts/voice-0bc4b1/`.
