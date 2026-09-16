# Reliable note saving candidate

Task c593d7f7-85d3-4ab8-8420-c1d6f2ab307c. Base `e619d5770bcd4c9e4c9b301be091e7d54e75cea5`; registered branch preserved. Research fd8ec6f6 read in place, unchanged. No primary edits copied, live notes changed, nested workers, push or deployment.

## Product change

- `client/src/noteSaving.ts`: shared workspace-owned 750ms debounce, immediate save, one in-flight write per vault/note/session, coalesced latest follow-up using acknowledged revision, request-lifetime/epoch fencing, explicit retry after transient failure, blocked conflict/403/404 writes, unload protection. Existing PUT API retained.
- `client/src/workspace.ts`: keep unresolved drafts on close/replacement; refresh cannot replace unresolved baseline, draft, error or in-flight identity. Completion preserves newer typing.
- `client/src/App.tsx`: main host integration, permissions, Ctrl/Cmd-S without search/bubble duplicates. Loaded Superkanban refreshes after note events and local acknowledgements; stale aggregate loads are fenced by request generation, vault and account epoch. Aggregate bodies reflect persisted data, not unsaved drafts.
- `client/src/PopoutApp.tsx`: same revision-aware save controller/status/shortcuts/autosave; errors retain editor. Unresolved notes stay in their originating window instead of being detached/merged into a separately hydrated editor.
- `client/src/components/NoteEditor.tsx`: consumes save shortcut once, contains promise rejection, truthful main/popout status (green only when acknowledged), read-only CodeMirror including toolbar transactions.
- `client/src/api.ts`: explicit empty origin selects this instance, so queued local writes cannot follow a newly selected remote vault. Undefined origin retains existing automatic routing.

## Checks and evidence

- `npm --workspace=client run test -- src/tests/noteSaving.test.ts src/tests/workspace.test.ts`: 17 passing checks. Debounce cancellation/deduplication; newer-edit coalescing/revision advancement; navigation/close/vault switch; 500/409/428/403/404 retention/no loops; logout and recreated-note lifetime fences; original local/remote instance routing; permission denial; unload warning.
- `npm --workspace=client run typecheck`: passed.
- `env -u DISPLAY -u WAYLAND_DISPLAY node scripts/test-note-saving-browser.mjs`: production App + CodeMirror and production PopoutApp mounted in headless Chromium; API and socket source controlled in memory. 12 checks, exact requests in `frontend-evidence.json`, no page errors. Manual shortcut/save/reload, autosave burst, search, slow save/newer typing/navigation, 500/retry, close/reopen, conflict/unload, Popout network retry/autosave/reload, 403, viewer read-only, already-open aggregate refresh.
- Same browser script against an archive of unchanged base product fails `Ctrl-S must submit one immediate PUT`: actual 0, expected 1 (`failing-before.txt`). This is a product assertion, not an import/startup failure.
- `cd backend_elixir && MIX_ENV=test mix test test/cascade_web/note_saving_test.exs test/cascade/content/note_revision_test.exs`: 4 passing checks. Actual Router/API, isolated SQLite and temporary note files: revision-aware PUT then GET/file reread; stale 409 and viewer 403 preserve content/revision/file. Existing opaque/private revision regressions also pass. This is separate backend disk proof, not a browser connected to that backend.
- `npm run build`: passed. `git diff --check`: passed.

## Coordinator integration

Cherry-pick this save candidate alongside independently accepted Kanban `9e3c2cfa57ad82757b8cc3281eb4b74452625aa8`. This candidate does not edit `KanbanView.tsx`; its existing `onContentChange` sends each entire board mutation through the shared draft/save contract.

On the combined revision, run the focused suites plus real-App category opt-in -> move into marked category -> autosave/manual save -> hard reload. Both category policy and move/checked markdown must persist together in the same revision-aware PUT. Exercise 403/409/network failure on that actual interaction: whole dirty board survives, no false Saved, no conflict rebase; newer edits survive slow writes and note/vault switching. Recheck already-open Superkanban projection after committed note changes. Our aggregate test uses an ordinary checked note card; it does not certify combined completion-policy UI. Kanban's component Save harness is not production App or backend proof.

Durable work identity/completion remains the coordinator's separate gap: no title inference, new drag route or mission guard bypass was added. Coordinator owns fresh independent exact-candidate review and coordinated integration/release.

## Limits

Draft retention is in memory for the current account session; unload warns but does not claim disk persistence or survive forced process loss. Conflicts/permission failures remain retained and blocked; no automatic rebase or new merge-resolution UI was introduced. Browser tests use controlled API/event input, not production transport. Backend proof is isolated Router/SQLite/file testing, not a production deployment or full browser-to-backend end-to-end session. No personal desktop or Electron window-manager interaction was performed.
