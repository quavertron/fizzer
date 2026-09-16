# Independent exact-candidate review

Outcome: **accepted for the candidate's explicitly bounded note-backed Kanban implementation**.
Reviewed SHA: `9e3c2cfa57ad82757b8cc3281eb4b74452625aa8`.
Task: `9b8784a1-9fbe-408b-b520-3052f87d6a6e`; authority: owner `msg-1789584390995-mfbzje`, brief `note-v1:1`.

**This is not acceptance of the full mission objective or release readiness.** Durable linked-work completion is absent, and real App save integration is not certified. Those remain coordinator dependencies, not permission to add a linking format or make Superkanban draggable. No blocking defect found in the bounded component change.

## Reviewed behavior

- `client/src/components/KanbanView.tsx:148`: heading-adjacent marker defaults off and belongs to the actual section, not its label. Arbitrary/duplicate labels and WIP suffixes work. New/old Done columns are not inferred to be completion categories.
- `KanbanView.tsx:284`: explicit menu setting round-trips and does not bulk-complete existing cards. Add and empty-target insertion preserve marker adjacency (`:245`, `:345`). Rename retains it; deleting the category deletes its metadata. Unrelated settings/footer/archive remain intact in exercised cases.
- `KanbanView.tsx:335`: only entry from a different column checks an unchecked card, via the exact existing manual helper (`:293`, manual control `:738`). Position and checkbox are one content mutation. Same-column reorder/self-drop, enabling, adding, and exit do not complete/reopen. Already checked source line is preserved byte-for-byte, including uppercase X and rich text; plain bullets use the same normalization as manual completion.
- `KanbanView.tsx:508`, `:517`, `:714`: drag ref is local to the mounted board and validates exact drag-start content; no foreign data-transfer fallback. Both native background and card-target routes passed. A changed draft invalidates the drag, preventing reused line indexes from moving a different card.

## Linked projections, guards and realtime boundary

1. `KanbanView.tsx:29` defines only line-derived identity, text, checked and marker. No durable work identifier or resolver exists in the dragged cards. Wiki-links remain text. Completing these cards does not call a work-item or mission mutation.
2. An existing affected projection **does** exist: `SuperkanbanView.tsx:145` copies note cards into aggregate columns, retaining checked state and note identity (`:161`). Supplemental review test verifies the newly checked note card projects as complete after supplying the changed note body. Arbitrary category names still determine aggregate placement; completion does not force the category into the Done lane.
3. Separately, `SuperkanbanView.tsx:87` projects durable work, including mission twins, using status and `workItemId` (`:123`, `:131`). Its render (`:332`) has no drag or completion controls. Supplemental test proves a same-title durable item stays open while the note card completes. This is a model boundary, not evidence that linked-work completion was implemented. Label/title matching would be unsafe and was not introduced.
4. Note-save authorization/revision/realtime paths are unchanged: `content_controller.ex:195` uses writable-note checks (`:637`), expected revision and note events (`:219`); `content/store.ex:599` checks revision under transaction, preserves protected blocks for agents, writes/indexes the note, observes mission-linked note revisions, and restores file contents on caught failures. Existing mission-linked **note revision awareness** can still run on save (`:656`); this is not mission-task completion.
5. Canonical mission guards are not bypassed because the candidate never invokes durable completion. `missions/store.ex:927` authorizes task mutation, checks open mission and outcomes; `:949` blocks unresolved children. Generic `work_items.ex:99` alone is not a replacement for that path. No permission widening, new scheduler call, lease mutation, run dispatch or new realtime protocol was added. Runtime authorization/atomicity for linked completion has **not** been tested or established.
6. Existing aggregate freshness limitation remains: `App.tsx:1609` fetches note bodies/work items on aggregate open or selection (`:1643`, `:2289`); note event handling (`:1902`) refreshes open clean note bodies, not the already-loaded Superkanban body cache. Thus the parser projection is correct on refreshed input, but an already-visible aggregate is not certified to update immediately. This is unchanged baseline behavior and must not be described as realtime linked-projection delivery.

## Save consistency and separately owned integration

`NoteEditor.tsx:1998` passes only content/onContentChange. `App.tsx:1756` records a draft, and `:1723` saves the full draft with expectedRevision, calling completeSave only on success. Checkbox plus move remain a dirty draft on failure. There is no new component-level persistence success claim.

The browser harness constructs its own React App and Save fixture button (`scripts/test-kanban-completion-browser.mjs:20`), uses real WorkspaceStore reconciliation, and intercepts HTTP (`:55`). Its 403/409 feedback is implemented in the fixture. **It does not mount production App/NoteEditor or exercise backend authorization.** Production App's existing save catch explicitly notices 409/428, while other failures are logged/rethrown (`App.tsx:1741`). Do not transfer fixture feedback assertions to the real UI.

Mission `22130d04` owns App autosave/keyboard/draft changes. Required combined-candidate checks, without taking over those edits:

- Real App: menu opt-in, marked move, autosave/manual save and hard reload retain both policy and checked position; unmarked movement/manual completion remain unchanged.
- Real App: failed 403/409/network saves visibly fail and preserve dirty move+checkbox together; remote updates and note/vault switching do not overwrite dirty drafts; retry does not clobber edits made during an in-flight save.
- Real backend: actual note authorization/revision rejection leaves committed note/file/revision unchanged; accepted save exposes the same checked state on reread and existing note event consumers.
- Existing aggregate: verify committed note-card state after refresh and explicitly resolve/report already-open Superkanban freshness. Keep durable mission/work projection assertions separate.
- Full mission cannot close on this candidate: coordinator must resolve the absent durable-card identity/completion contract within owner scope, or explicitly surface that portion as unfulfilled. No new linking/drag scope was invented by this review.

## Actual independent checks

Fresh assigned branch was clean at `b3bb36da` and fast-forwarded to the exact candidate, preserving registered branch identity. Implementation workspace and dirty primary were not changed. Candidate is based on `e619d577`; its four-file diff was reviewed separately from intervening base history.

- Dependencies: `npm install --ignore-scripts --include=dev --no-audit --no-fund`; no lockfile change.
- `npm --workspace=client run test -- src/tests/kanban.test.ts src/tests/workspace.test.ts`: **30/30 passed**, 2 files.
- `node scripts/test-kanban-completion-browser.mjs`: **passed** in isolated headless Chromium; native drops, setting/reload, no reopen/retroactive/reorder, stale/foreign rejection, fixture 403/409 dirty retention, reconciliation/retry/reload. No personal desktop or display used.
- `npm --workspace=client run test -- src/tests/kanban-review.test.ts`: **3/3 passed** supplemental independent checks for rich checked-line preservation and archive/footer/deletion, manual uncheck and policy round-trip, note aggregate vs independent durable projection. Review-only test artifact retained at that path, not part of the implementation SHA.
- `npm run typecheck:client`: passed.
- `npm run build`: passed, including prebuild and HTML preview build.
- `git diff --check`: passed; tracked candidate files unchanged.

No actual backend test, full App browser test, push, deployment, release takeover, nested worker or model probe performed. Release remains with the current release owner; integration changes require verification on their own resulting revision.

Review artifacts only: this report and `client/src/tests/kanban-review.test.ts` (uncommitted). No product fixes.
