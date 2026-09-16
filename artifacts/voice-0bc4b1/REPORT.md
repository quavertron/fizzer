# Voice implementation handoff — 0bc4b17b

Scope: mission fb9d1015, authoritative note-v1:1. Implementation only; no push, integration, release, nested workers, personal desktop/device access, or live human writes.

Candidate: `/tmp/fizzer-voice-0bc4b1`, detached from fetched origin/master `e619d5770bcd4c9e4c9b301be091e7d54e75cea5`. Registered task branch/workspace preserved. Primary and installed edits untouched. Commit is supplied in the task completion; `git rev-parse HEAD` identifies this candidate.

## Changes

- `client/src/components/Sidebar.tsx`, `VoiceRoom.css`: connected controls occupy a normal nonshrinking footer slot after music and before account settings; closed sidebar has accessible detached controls, using the 900px drawer breakpoint.
- `client/src/App.tsx`: one stable app-level received-audio host; hook receives source vault label and existing auth epoch; explicit logout starts voice cleanup. No saving/workspace-navigation behavior was copied or modified. Coordinator retains ownership of accepted save2ec5165d integration.
- `client/src/components/VoiceRoom.tsx`: ordinary vault navigation retains the room, tracks, preferences, labels and source routing. Every voice HTTP call uses its join-time options. Explicit joins compare source/vault/channel, serialize pending disconnects, and fence late token/capture/roster work. User/auth-epoch changes, access failure, SFU disconnect and explicit leave clean up. Connected source roster polling continues when browsing away. Idle roster state is source-keyed; avatars merge only by exact SFU identity, absent preserves and explicit empty clears.
- `client/src/api.ts`: capture the effective local API_BASE or remote origin/token; explicit empty origin bypasses mutable route inference. Local session credentials retain their existing cookie behavior.
- `backend_elixir/lib/cascade/chat/voice.ex`: authorized roster endpoint hydrates avatars from the authorized channel snapshot only after server metadata, identity, membership and source-room validation. No unscoped user lookup or photo-bearing realtime/token metadata.
- Tests: extended `voiceChannels.test.ts`, `voice_html_test.exs`, `scripts/test-voice-html-browser.mjs`; added `scripts/test-voice-session-browser.mjs`, adapted from completed research reproduction for deterministic routing/lifecycle edge cases.

## Evidence

- `before.json`: ran the supplied research reproduce.mjs against unchanged fetched master before edits. Vault switch disconnected/stopped the track, authorized photo did not render, footer slot absent, mutable routing changed target. The unrelated chat local-profile-clear hazard remains deliberately untouched; voice does not reuse that overlay.
- `client-tests.log`: 5 focused component tests passed.
- `backend.log`: 5 backend tests passed, including authorized avatar lookup, duplicate names/multiple sessions, forged identity, invalid/wrong-source metadata, outsider denial and intentional clear.
- `session.log` and `session-relative.log`: each passed 9 headless React cases with mocked SFU/HTTP, covering local effective API_BASE and empty local base, local/remote navigation, mapping replacement, same-ID source collisions, privacy, one stable audio node, auth replacement, late token/capture/roster fences, and access-loss cleanup.
- `typecheck.log`: client typecheck passed.
- `build.log`: required `npm run build` passed.
- `client-build.log`: production client bundle passed; normal large-chunk warning remains.
- `media.log`, `media-verification.json`: shipped dedicated internal-Docker-network SFU fixture passed all 6 ExUnit cases. Actual two-client oscillator media, relay candidates, inbound RTP, audio energy; A→B→A vault navigation preserved received audio; connected authorized avatars cleared; desktop footer above account, music coexistence at 1000×600, open/closed 390/800px controls and stable audio; explicit room switching/privacy; reconnect; revocation (observed 1288ms); no implicit/restored capture; permission denial; delayed-capture cancellation. Existing HTML isolation checks also passed. Docker container/network cleaned by fixture trap.
- Raw headless media screenshots/netlog retained outside candidate at `/tmp/fizzer-voice-media-0bc4b1` (synthetic fixtures only); compact receipt committed here.

Two intermediate media attempts required reruns: an assertion expected only the prior SFU disconnect wording while new authorized polling detected revocation earlier; another was invalidated by Vite reload during continued editing. Final run used frozen product source and passed in 37.3 seconds.

## Material limits / next owner

Remote routing/auth collisions use deterministic mocked HTTP/SFU; real synthetic media exercised the local app and two local vaults, not two deployed remote instances. No production probe or release was performed. Source cookie auth cannot be copied out of HttpOnly cookies; the pinned local API/credential mode is bounded by the existing app user/auth-epoch cleanup. Fresh independent exact-commit review and coordinated integration/release remain with the mission coordinator. Preserve the separately accepted saving candidate when reconciling App.tsx.
