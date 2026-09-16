# Independent review: accepted

Reviewed exact candidate `4bf74b3d44733878336ee003f6439f9120ce8cc9` from implementation c152b09b; parent `e619d577`. Review task `37aa0271-6f72-4014-bcc3-b363abed8b3b`.

No blocking findings. The one-line product change removes premature body erasure at the owning segmentation boundary without adding restoration, caches, or persistence behavior.

## Workspace and scope

Assigned isolated worktree started clean at b3bb36da61263879d81b09f52b7439387188fe4e and was fast-forwarded to the exact candidate. Registered branch remains `cascade/22130d04/independently-review-human-messa-37aa02`. Original implementation worktree and dirty primary were not changed. No implementation edits, nested workers, push/deploy, live owner-note changes, desktop/display/mic access, or note-save work. Only review artifacts were added. `git diff --exit-code 4bf74b3d` passes after testing.

Candidate files:
- `client/src/chat/workTrace.ts`: one line retaining durable root body.
- `scripts/test-human-mission-content-browser.mjs`: composed ChatView regression.

## Source review

- `client/src/chat/workTrace.ts:393-398`: a durable mission host with relocated trace becomes a work segment. Previously its only artifact carrier deliberately had an empty body. Retaining `head.body` is the smallest fix; object spread retains ID, author, timestamp, actor, attachments, mission/root/reply identity. Existing status suppression is unchanged.
- `client/src/components/ChatView.tsx:1035-1098`: the carrier supplies the mission artifact; human roots render from that artifact with only mission removed. The separate coordinator row is produced by `missionCoordinatorCarrier`, so preserved root prose cannot leak into the coordinator display. Agent mission roots do not enter the human-render branch.
- `client/src/chat/missionAttribution.ts:4-22`: synthetic coordinator carrier explicitly has empty body and exact stored coordinator registration; human detection depends on absence of agent/registration identity.
- `client/src/components/ChatMissionCard.tsx:158-188,351-355`: Stop uses mission ID and stored coordinator registration; reply/context uses the original artifact message. No changes to these paths.
- `client/src/chat/runBlocks.ts:167-218`: realtime upserts and authoritative snapshot deletion remain unchanged. The fix does not synthesize missing messages or resurrect deleted rows.

## Independent commands and results

Run in this review worktree, with dependencies installed using `npm ci --ignore-scripts --include=dev` (exit 0; install.log).

1. `node scripts/test-human-mission-content-browser.mjs` — exit 0, all 12 stages pass (candidate.log).
2. `node review/37aa0271/failing-before.mjs` — expected exit 1 (before.log). Review-only fixture reuses the candidate test with an asserted Vite pre-transform reinstating exactly the parent's `body: ''` expression. Product source remains untouched. Root passes before trace; after linked running trace the actual paragraph count is 0 versus expected 1. Since this is the entire product delta from the parent, this isolates the failing-before mechanism.
3. `npm --workspace=client test -- src/tests/runBlocks.test.ts src/tests/chatSteering.test.ts src/tests/missionAttribution.test.ts` — exit 0, 3 files / 79 tests passed (units.log).
4. `npm run build` — exit 0, TypeScript, CLI wrapper copy and HTML-preview build passed (build.log).
5. `git diff --exit-code 4bf74b3d` — exit 0; HEAD is the full reviewed SHA above.

## Assertion audit

The new browser test really mounts ChatView with the message store and production segmentation/reconciliation helpers, rather than only checking a copied transformation.

- Lines 76-98 assert exactly one human chunk and one paragraph matching the original text; deep equality protects stored root and carrier identity/content. Attachment link and author are asserted. Separate coordinator card/author and absence of duplicated root text are asserted.
- Lines 101-111 run those checks before/after trace arrival, duplicate upserts, interruption, reconnect snapshot, and fresh page mount.
- Lines 113-119 exercise card-context Reply and check original preview text; Stop asserts the exact mocked finish endpoint and request body, including coordinator registration.
- Lines 121-128 assert removal after explicit local delete and authoritative snapshot omission.
- Lines 130-140 cover attachment-only roots, ordinary human messages and agent-created missions with no duplicate agent prose.
- Carrier deep equality covers original timestamp, replyTo and mission root ID; source tracing additionally confirms Reply passes the original message. The test does not separately assert the rendered timestamp or a sent reply payload.

## Limits

Headless Chromium and synthetic canonical rows only. API responses are mocked; the Stop assertion verifies client targeting, not server cancellation. Explicit deletion uses local remove-by-ID, not DELETE API authorization. Refresh reloads the fixture, not deployed storage. Attachment presence is checked, not file download content. No production HTTP/storage, live owner state, deployment health or served revision is verified. The new regression is directly invoked, not wired into a package/CI test suite. These limits do not block this one-line presentation fix. Coordinator retains integration and normal Actions exact-revision/health/served verification; acceptance is not shipped.
