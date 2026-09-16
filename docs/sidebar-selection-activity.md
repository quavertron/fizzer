# Sidebar selection and queued activity

The selected note/channel and its connector use one visible target. An expanded
ancestry targets the note itself; the outermost collapsed ancestor becomes the
highlighted target. This includes nested folders and guards malformed cycles.

Channel activity distinguishes a bound `running` row from queued/sending or
unbound rows. Orange means a signed-in owner's message is running with a run ID;
a hollow neutral marker means **Agent work queued — not running**. Queued rows
remain in the transcript and snapshot-recovery path. This is a presentation of
persisted execution state, not an independent provider heartbeat or a claim that
queued work has been completed. Running takes precedence over queued, then
finished, when aggregating vault activity.

Desktop workspace preparation errors retain the desktop's bounded diagnostic
instead of replacing a non-ok ACK with a generic message. Repository binding,
execution admission, and Along's owner-authored invocation guard are unchanged.
A coordinator-authored task cannot bypass the latter; the owner-authorized Along
conversation can integrate an existing artifact without rerunning that provider.

Focused checks:

```
npm test -- --run src/tests/sidebarConnector.test.ts src/tests/queuedActivity.test.ts src/tests/messageStore.test.ts
env -u DISPLAY -u WAYLAND_DISPLAY node scripts/test-sidebar-selection-browser.mjs
```

The browser fixture exercises the actual built App with all API data intercepted,
including nested collapse/reopen, exactly one highlighted row, connector endpoint
geometry, and visible queued/nonorange status at desktop and phone widths. Set
`SIDEBAR_APP_URL` to inspect the public-served assets with the same isolated data.
It never signs in as a human, invokes a model, or uses the personal display.
Existing voice/HTML delivery receipts remain separate from historical failed
native worker states; do not replay already delivered features to tidy badges.
