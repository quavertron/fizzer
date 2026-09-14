# Pre-overhaul mission application rollback

This forward rollback restores application source to `461382ce442de206794e6c78a2a059edbd4ec7a0`, before `eb886fc4bce39e61dfa032f70847b3cda22aea91` (master merge `65b7a2c33d416fb7f49a9d06b8782911beed5703`). It does not reset master or delete mission/channel/message/media data.

## Explicit differences from the historical target

- `backend_elixir/lib/cascade/chat/schema.ex` remains exactly the `9da88710ca2f4efcd6c416a5ab53ddb4c57d6e81` version. Its only differences are current color columns, schema signatures and color-preserving rebuild/select handling. The exact historical schema repair otherwise drops persisted registration colors. No later mission/application behavior is retained.
- Current operational safety remains: `deploy/github-actions-host.sh`, `deploy/prune-release-images.py` and its test, `deploy/remote-update.sh` and its test, `docs/release-image-retention.md`, plus `scripts/check-elixir-data-compat.mjs`, its test and mission schema transition fixture. These preserve deployed retention/recovery protections and schema preflight, not mission-overhaul application behavior. The production Actions workflow is byte-identical at both revisions.
- Current `AGENTS.md` remains contributor guidance.
- Schema tests expect and exercise preserved colors. A historical stale recovery test now checks evidence in `Interpretation.dispatch_prompt(dispatch.id)` (used by `DispatchPrompt.build/3`) while separately asserting the short public carrier. Target commit `576ab8d6c` changed the carrier without updating the older assertion from `8c257836c`; exact untouched target reproduces that failure. No recovery application change or assertion removal is used.
- Added focused mission test proves creation keeps the existing room and creates no `mission-channel-*` note. All tests use isolated fixtures, not live model starts.

The removed intervening application functionality includes Along external/task/media APIs, image presentation fixes and startup restoration changes. Existing posted image data and mission virtual-channel records remain stored; this does not promise later APIs or newer image presentation in the old application. Existing desktops are not restarted or refreshed. Old task settlement/coordinator review uses historical durable dispatch and runner lifecycle paths; runtime starts are not tested against production.

## Compatibility evidence

The exact retained historical image was booted with only the above schema source compiled into its runtime, networking disabled, `CASCADE_SERVER=false`, and QMD disabled, against a disposable full current database copy. All 64 application table raw-byte hashes and complete sqlite_master schema were identical; SQLite quick_check passed. All 232 registration colors remained, with zero non-default values. Schema source SHA-256: `62609d67a4f2eeddb7e3188bdb1fa0f159af4e5ae7bf3dce2e46edc052918e24`. This is a compatibility probe, not a claim that a newly built release image has deployed.

Existing recovery snapshot and pinned recovery image are retained; no repeat corpus backup, retention deletion, desktop activation or production database edit was performed during preparation. Delivery must use normal forward commit/push and GitHub Actions, then independent exact revision/image, health and data readback.
