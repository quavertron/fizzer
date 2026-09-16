# Independent review: accepted

Task `cebcf344-327b-4d24-aaf6-2ab859e4d15d`. Exact save candidate **`2ec5165d9b65fa7797b15330557882eda1276eb0` accepted**. No blocking defect found in assigned scope. Independent session; no product edits, fix, push, release, personal GUI, live data or nested workers.

## Exact provenance

- Fetched `origin/master`: `e619d5770bcd4c9e4c9b301be091e7d54e75cea5`, same as candidate parent. Registered review branch remains `cascade/22130d04/independently-review-exact-note--cebcf3`; initial tree clean, HEAD exact save candidate. Dirty primary untouched.
- Save tree: `62ee828d2eb5e1d0895d58077eaf67ebc288614b`.
- Disposable detached worktree `/tmp/cebcf344-combined`, built from current master by cherry-picking, in order, exact save `2ec5165d9b65fa7797b15330557882eda1276eb0`, accepted bounded note-Kanban `9e3c2cfa57ad82757b8cc3281eb4b74452625aa8`, accepted human-message `4bf74b3d44733878336ee003f6439f9120ce8cc9`. No conflicts or adaptations.
- Combined HEAD `c2f3a091d9ce5e35a9b1fd6b6c14b281eae0d471`; **combined tree `b3ca86f2c022d08ac9f6f67ab3c6410e37aed3dd`**. Review harnesses are additional untracked scripts, not product changes.
- Component provenance retained: Kanban blob `fb361c85516b3a49bf9934af23d7053f49733c00` equals accepted candidate; workTrace blob `3916fbe936d4fff684bbe2c69a09d4027e6cc34a` equals accepted candidate. Prior acceptance remains bounded by review task `9b8784a1-9fbe-408b-b520-3052f87d6a6e` (KANBAN_COMPLETION_REVIEW.md in its worktree) and human review `37aa0271-6f72-4014-bcc3-b363abed8b3b`; this review adds save/composition evidence, not broader model acceptance.

## Review findings and evidence

Inspected NoteSaving, WorkspaceStore, main App, PopoutApp, NoteEditor and API routing changes against parent. Scheduling lives outside editor lifetime. One in-flight request coalesces newer drafts against the acknowledged revision; request token and account epoch fence obsolete completions. Delayed local writes explicitly select the local origin; remote writes select their vault's registered origin. Dirty/error/in-flight entries survive close and sidebar replacement; refreshed bodies do not silently rebase unresolved drafts. 409/428/403/404 block retries; transient failures retain drafts for explicit retry. Dirty Popout transfer is refused, and unload protection covers unresolved state. Main and Popout share revision-aware saving; CodeMirror consumes the shortcut and the window handler observes defaultPrevented. Status distinguishes dirty, pending, failure and acknowledgement. Read-only CodeMirror and controller permission enforcement prevent writes.

Passed independently:

- Exact candidate: **17 unit tests**, **12 mounted App/Popout checks**, **4 real Router/SQLite/file tests**, root build and client typecheck. Exact request records are in `exact-browser.log`; backend results in `backend.log`.
- Failing-before rerun against untouched parent: same mounted App test fails the product assertion `Ctrl-S must submit one immediate PUT`, actual 0, expected 1 (`failing-before.log`).
- Combined tree: **41 unit tests** (saving/workspace/Kanban), **12 human-message browser checks**, root build and client typecheck. See `cebcf344-combined-*.log`, `cebcf344-human-browser.log`.
- `combined-browser.mjs` / `.json`: production App and Kanban mounted with controlled API. Category menu opt-in + native card drag + Ctrl-S emits the marker, destination and checked state in one revision-aware PUT; delayed response remains Saving and leaves persisted fixture unchanged until acknowledgement. Already-open aggregate receives the committed completion. Flag and card position/check survive hard reload; subsequent drag autosaves. Injected 403, 409 and network failures retain the complete board draft through note switching, do not show Saved, and do not loop. Permission/conflict retries remain blocked; network retry saves and reloads.
- `http-browser.mjs` / `.json` and `isolated-server.exs`: same combined App, with note GET/PUT forwarded over real loopback HTTP to Bandit/Cascade Router, isolated SQLite and synthetic markdown files. Opt-in + drag + immediate save and subsequent autosave survive GET/reload; direct file reads exactly match the committed board. Browser network failure retains the changed checkbox, explicit retry writes the real file, then reload restores it. A genuine concurrent backend PUT advances the revision; the stale browser save returns **409**, keeps the dirty checked draft and leaves the externally committed file unchanged. No request token is included in evidence. Server stopped and synthetic vault/token manifest removed after checks.

## Precise commands

From registered review workspace unless stated otherwise:

```sh
git fetch origin master
git rev-parse origin/master
npm install --ignore-scripts --include=dev --no-audit --no-fund
npm --workspace=client run test -- src/tests/noteSaving.test.ts src/tests/workspace.test.ts
env -u DISPLAY -u WAYLAND_DISPLAY node scripts/test-note-saving-browser.mjs
(cd backend_elixir && MIX_ENV=test mix test test/cascade_web/note_saving_test.exs test/cascade/content/note_revision_test.exs)
npm run build
npm --workspace=client run typecheck
git worktree add --detach /tmp/cebcf344-combined e619d5770bcd4c9e4c9b301be091e7d54e75cea5
git -C /tmp/cebcf344-combined cherry-pick 2ec5165d9b65fa7797b15330557882eda1276eb0 9e3c2cfa57ad82757b8cc3281eb4b74452625aa8 4bf74b3d44733878336ee003f6439f9120ce8cc9
git -C /tmp/cebcf344-combined rev-parse HEAD 'HEAD^{tree}'
```

Copied isolated backend `deps` and `_build` from implementation worktree to review worktree; Mix recompiled 139 current source files. Config/test.exs independently selects process-specific SQLite and fixture vault root. Initial npm ci omitted dev dependencies due inherited NODE_ENV=production; explicit --include=dev resolved it. Combined dependency symlink attempt missed client-local packages; replaced with a local `npm ci --ignore-scripts --include=dev --no-audit --no-fund`. Harness selector/case corrections were confined to review scripts.

From `/tmp/cebcf344-combined` after copying these two review scripts into `scripts/` as `review-combined-browser.mjs` and `review-http-browser.mjs`:

```sh
npm ci --ignore-scripts --include=dev --no-audit --no-fund
npm --workspace=client run test -- src/tests/noteSaving.test.ts src/tests/workspace.test.ts src/tests/kanban.test.ts
env -u DISPLAY -u WAYLAND_DISPLAY node scripts/test-human-mission-content-browser.mjs
npm run build
npm --workspace=client run typecheck
REVIEW_EVIDENCE=/home/jt/.fizzer/worktrees/cascade/22130d04-independently-review-exact-note-cebcf3/review/cebcf344/combined-browser.json env -u DISPLAY -u WAYLAND_DISPLAY node scripts/review-combined-browser.mjs
# First run in registered review workspace/backend_elixir and leave active:
# MIX_ENV=test mix run ../review/cebcf344/isolated-server.exs
REVIEW_EVIDENCE=/home/jt/.fizzer/worktrees/cascade/22130d04-independently-review-exact-note-cebcf3/review/cebcf344/http-browser.json env -u DISPLAY -u WAYLAND_DISPLAY node scripts/review-http-browser.mjs
```

Failing-before: `git worktree add --detach /tmp/cebcf344-before e619d5770bcd4c9e4c9b301be091e7d54e75cea5`; symlinked review workspace node_modules and client/node_modules, copied exact candidate browser harness as `scripts/review-before.mjs`, then ran `env -u DISPLAY -u WAYLAND_DISPLAY node scripts/review-before.mjs` from that parent worktree. Expected assertion failure recorded.

## Limits and ownership

The HTTP test connects real note persistence, but session/listing/socket input remains controlled: it is not full production authentication/realtime E2E. 403 disk enforcement is tested separately by real backend Router test; composition injects 403 to exercise UI retention. Remote routing/account reset/recreated lifetime are unit checks; native Electron detach/window-manager behavior is source-reviewed, not desktop-tested. Draft retention is session memory plus unload warning, not crash recovery. Conflicted drafts remain blocked without an added conflict resolution UI. These are explicit scope limits, not claims of persistence before acknowledgement.

Note-backed checked cards and durable mission work remain separate model boundaries. No inferred mapping, guard bypass, durable work completion, new Superkanban drag route, or dot-summary UI work is accepted or added here. Coordinator owns integration, release, Actions and exact served revision/health checks.

Changed files in this review: only `review/cebcf344/` artifacts, scripts and logs. Product candidate unchanged. Review acceptance is not deployment.
