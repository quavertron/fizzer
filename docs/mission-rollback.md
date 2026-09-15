# Intentional mission-overhaul rollback, preserving current integrations

This is an explicitly owner-requested **selective forward rollback**, not an accidental loss of upstream work. The dedicated mission workspace/channel implementation entered in `eb886fc4bce39e61dfa032f70847b3cda22aea91` (merge `65b7a2c33d416fb7f49a9d06b8782911beed5703`, historical parent `461382ce442de206794e6c78a2a059edbd4ec7a0`). The earlier broad rollback `ddd3cdc4265cb952ff679f78d9348deed9e9f5a7` was explicitly reverted by `84c215efa0f95fb0df49135984434c95a55ea049`, restoring the unwanted mission UI and dedicated channel allocator. This redo starts from `9e8376ca08af4b5b4f00b692a13c2b007e69b26f`, not from the historical application tree.

## Intent and compatibility contract

- Remove the Missions sidebar, mission workspace component/chunk, and mission-specific tab/presence/discovery machinery. Discard obsolete persisted mission **views**, not any server data. Ordinary note/chat tabs and revision-protected drafts survive.
- Restore authenticated `POST /api/vaults/:vault/channels/:channel/missions` with the existing root-message/coordinator contract. Creation retains that channel; no per-mission channel or membership is allocated.
- Preserve current mission/task/read/note/approval APIs and lifecycle safeguards rather than replacing all orchestration internals with historical code. The legacy-named `create_workspace`/vault collection API now requires explicit **existing** `channelId`, `rootMessageId`, and `coordinatorRegistrationId`, in addition to its existing identity/title/brief/id fields. It may create a brief and queue planning, but cannot create or reconfigure a conversation, coordinator registration, or root message. Missing context fails before writes. Retries bind channel/root/coordinator as well as mission identity.
- `cascade-chat mission start` carries its existing channel, triggering message (or `--root`), and registration. Along `createMission` also takes these three explicit fields, previews execution settings, retains owner-grant and durable no-replay checks, and checks exact returned channel/coordinator. Old channel-less creation requests fail closed; historical receipts can reconcile without replay. Existing deployed desktops are **not** restarted by this change, so older callers lacking those creation fields must update before creating missions. Other task/media/app operations remain supported unchanged.
- Keep all schema/migration modules, including registration `color`; no destructive migration, deletion, data rewrite, or virtual-channel cleanup. Existing historical mission channels remain stored and reachable through existing APIs/session links.

This intentionally is **not** byte-exact pre-overhaul orchestration: current task control, brief-note revision/approval/settlement contracts and safe dispatch lifecycle are retained. Do not reintroduce the separate workspace/channel allocator merely to make the tree look like upstream. Future product changes require their own intent and tests; this document imposes no branch policy.

## Preserved-feature manifest

Unchanged: all `tui/` and `vendor/` content; opt-in Unix-account/alock/awatch/native terminal implementation from `774d30bb1d840d2ecc92eac981868bfac3a7ff49`; imageCount server metadata; Codex session import from `2796e5014eeda2cd0db445f2e0de19731a8fb846` (including App wiring); test vault storage isolation from `9e8376ca08af4b5b4f00b692a13c2b007e69b26f`; external app/wiki/media/avatar API modules; image rendering; note CAS/hydration; current startup/remote-vault chooser and sidebar navigation; agent runner/provider bridge; dispatch claim/queued delivery revocation; deployment/retention/recovery safeguards.

The only integration adjustments are mission creation's explicit existing-room bindings in the native route, CLI, Along task-control client, frontend API type, and their fixtures. This does not implement unrelated alock Settings placement or sign-in-picker changes.

## Verification

- `npm run build`, frontend/backend/desktop release suites, CLI tests, schema data-parity tests.
- `npm run build:client && npm run test:mission-workspace-ui` now exercises the actual built App in isolated Chromium, desktop/mobile widths, stale mission tabs, existing transcript, absent Missions section/workspace and zero write/model-dispatch requests.
- Full disposable production-DB boot probe: current retained image plus **all three changed backend modules**, networking/server/QMD disabled. Complete sqlite_master and all 64 raw-byte table hashes identical; quick_check ok; 309 missions, 232 colors, four existing virtual channels retained at the captured checkpoint. Module hashes are in the private operator receipt.
- Exact workflow SHA, serving image/revision, internal/public health, served application assets and postcutover DB comparison must be read back before calling deployment complete. No live mission start is an acceptable no-model test.
