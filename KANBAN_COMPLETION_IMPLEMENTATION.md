# Kanban category completion candidate

Task 5173dc66-0878-42cc-8d82-79d2f2a027bd; mission brief note-v1:1.
Base: e619d5770bcd4c9e4c9b301be091e7d54e75cea5, fetched origin/master on 2026-09-16.
Registered branch preserved: cascade/342718c5/implement-opt-in-completion-for--5173dc.

## Change

The existing list menu has an explicit “Complete cards on entry” checkbox. A reserved `<!-- fizzer:complete-on-entry -->` comment immediately below the category heading persists the setting per actual section, including duplicate labels. Absence is false. Renaming, adding cards, and moving the section retain the setting. A small check indicator identifies enabled lists.

Both existing drag paths call moveKanbanCard. Entry into an enabled category uses toggleKanbanCard for an unchecked card in the same Markdown mutation as its move. Already checked cards stay checked. Exit, same-list reorder, adding cards, enabling the setting and renaming do not complete/reopen anything. Existing unmarked Done lists retain their old behavior. Drag acceptance is local to the board instance and exact drag-start content; foreign payloads and changed drafts cannot act on stale line-derived IDs.

Production changes: client/src/components/KanbanView.tsx only.
Regression files: client/src/tests/kanban.test.ts; scripts/test-kanban-completion-browser.mjs.
This report is the fourth candidate file.

## Save integration and coverage boundary

Research was rechecked in current source: draggable KanbanCard has text, checked, marker and line-derived identity, no durable work ID. Superkanban separately projects workItemId but has no drag/drop handler. Wiki-links in card text are ordinary note links, not work-item identity. No linked-work completion is implemented or claimed. No title matching, new link syntax, mission mutations, scheduling, permissions or realtime protocol changes were introduced.

The existing NoteEditor content/onContentChange path remains intact. Moves and completion are draft edits until the existing note save accepts the full content. No new success notification or early committed state is introduced. Existing note PUT authorization, expectedRevision checks and committed note events remain authoritative. Failed saves retain a dirty draft with both moved position and checkbox, not persisted completion.

Read active mission 22130d04-f9a7-48de-8d43-23f933513a7a and its research summary: Ctrl-S routing, autosave and note-switch draft preservation are owned there. App.tsx, NoteEditor.tsx and workspace save code are untouched here. Coordinator must combine with that accepted candidate and verify real App edit/save/reload plus failed-save feedback; this candidate does not repair or certify those existing defects.

## Actual checks

- Normal missing dependencies installed in this isolated workspace with npm install --ignore-scripts --include=dev --no-audit --no-fund; no lockfile change.
- npm --workspace=client run test -- src/tests/kanban.test.ts src/tests/workspace.test.ts: 30 passed, 2 files. Six newly added regressions failed against original e619d577 component (18 old tests passed), then all passed after restoring candidate.
- node scripts/test-kanban-completion-browser.mjs: passed in isolated headless Chromium. Actual component menu/reload, native background and card-target drops, no reopen/retroactive/reorder completion, stale and foreign drag rejection, 403/409 dirty-draft retention, remote refresh preservation, retry and reload. Uses actual WorkspaceStore/reconcile methods with fixture HTTP and a fixture save handler; proves component/save contract, not App wiring or backend authorization.
- npm run build: passed (including prebuild and HTML preview build).
- npm run typecheck:client: passed.
- git diff --check: passed.

No backend tests, production API mutations, personal desktop/display/microphone, nested workers, push, deployment or independent review performed. Candidate is for a separate fresh exact-SHA review and coordinated integration/release.
