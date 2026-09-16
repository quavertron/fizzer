# Combined candidate preparation

Task bf273e25-76a4-4cbe-b84f-f63d537e3a5a; implementation/preparation only. Authority: deploy-all milestone af78b3c9-fa42-46a3-9945-9df7235283f0, note-v1:1. Fresh independent combined review and eventual release remain with coordinator and integration bb74382c. No push, deployment, primary mutation, installed-runtime mutation, personal desktop/data/device use or child workers.

## Source reconciliation

Fetched master e619d5770bcd4c9e4c9b301be091e7d54e75cea5. Registered branch retained. The 88 changed primary paths at base b3bb36da are captured in snapshot commit cdf8513 and `/tmp/bf273e-snapshot`: exact staged/unstaged/combined binary patches, original index bytes, and file copies. `manifest.json` records every source path, primary/index/base hashes and final disposition; the primary bytes and index independently rechecked unchanged.

64 paths are identical to current master (already shipped or superseded); 24 retain primary changes with reconciliation. Remaining primary work includes shared ContentHTTP authorization/error wrappers, batched work-item hydration, shared unread target counts, SearchListOverlay consolidation, CSS consolidation/circular avatars, active trace presentation, and their tests. All ordinary staged, unstaged and untracked source paths have an explicit manifest disposition. No new optional cleanup was introduced.

Three-way reconciliation preferred shipped master at conflicting old architecture boundaries, then inspected residual differences. In particular:

- Keep current execution admission, Stop/cancellation, task/note authority, worker/runner lifecycle, native ownership and historical fences. These files match master; no wiki daemon reactivation.
- Deduplicate the primary no-invoke routes against their already-shipped implementation. Restore shipped note/chat search, UTF-8 helpers and the Scheduler test alias that old primary edits would delete.
- Preserve newer content revision/auth provenance and HTML preview checks while using primary ContentHTTP wrappers; adapt caption/preview/search actions to the shared wrapper. Real persistence/conflict/permission tests cover the combined result.
- Save and voice App changes coexist; the explicit API-origin guard occurs once. Save routing, latest-draft retention, auth epoch fences, and source-pinned voice audio lifecycle remain intact.
- Human root preservation is included once. Dot-summary prerequisite 08997707 and accepted human 4bf74b3d have the same stable patch id per independent review.
- Remove obsolete peek CSS at the accepted summary conflict. Update older primary tests to assert accepted public summaries instead of superseded labels, and preserve the save candidate's unresolved baseline instead of expecting remote baseline replacement.
- The primary projection browser fixture intercepted an obsolete individual-message polling route. Current master polls channel snapshots; fixture now injects outages at that actual boundary. It also stops expecting an offline queued message that master deliberately no longer creates (b512bc75); retains real running Stop failure/retry and offline close/reconnect coverage. Queued Stop remains covered by the existing component and backend tests.

## Exact prior acceptance

Copied original independent reports under `provenance/` (they describe prior candidates, not approval of this combined tree):

| Candidate | Exact accepted SHA | Independent review task |
| --- | --- | --- |
| Saving | 2ec5165d9b65fa7797b15330557882eda1276eb0 | cebcf344-327b-4d24-aaf6-2ab859e4d15d |
| Note Kanban | 9e3c2cfa57ad82757b8cc3281eb4b74452625aa8 | 9b8784a1-9fbe-408b-b520-3052f87d6a6e |
| Human preservation | 4bf74b3d44733878336ee003f6439f9120ce8cc9 | 37aa0271-6f72-4014-bcc3-b363abed8b3b |
| Dot/public summary | 78f372f1743ffc4e355a9108f2ffbca2f894740c | 43279442-fd57-4635-b97b-094140cabedd |
| Voice | f2a8715f52c3e1e379503994d2878ed017b73a5b | 771915b2-ae08-4715-ad9a-d8f5795174f1 |

## Exclusions and scope

No ordinary source path in the 88-file inventory was excluded. Ignored private/runtime paths were not copied: `.env`, `.env.selfhost`, `.env.staging`, `.private/`, `.cascade/`, SQLite databases/WAL/SHM, debug logs, dependency trees, compiled `dist`, client bundles, Electron embedded runtime/output, Android build/cache/generated assets/native libraries/APK and local.properties. These are excluded by path/category without reading private contents or claiming a secrets-content audit. Ignored historical `experiments/` remains excluded under the explicit canceled-experiment boundary. Snapshot hashes contain no private environment/database content.

No release-script cleanup from task 553e4037 is included. Full durable Kanban identity/completion remains unresolved and outside this deployment; checked note cards do not imply durable task completion. No linked-note hierarchy or Open questions content was modified.

## Verification

See `checks.md` and compact logs. Read the current fetched release matrix: frontend is typecheck + unit tests; backend is mix check; desktop is Electron tests. Build ran separately as required. Headless fixtures use synthetic identities/data, no personal display or microphone.

Draft retention is session memory with unload protection, not crash recovery. Saving/Kanban HTTP fixture connects real Router/SQLite/files, but authentication/listing/socket inputs remain controlled. Voice rerun uses mocked SFU/HTTP; prior exact voice review separately records real synthetic two-client media. No new media or production verification claim. Acceptance of prior components does not replace fresh combined review.
