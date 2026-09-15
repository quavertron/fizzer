# Private no-invoke PNG publication

The opt-in external-agent Unix socket exposes `mediaCapabilities`, `mediaUpload`
and `mediaSend`. These are authenticated, owner/vault/channel-bound operations,
not an unauthenticated upload proxy. Existing text-only `send` stays compatible.
The new service module requires Electron main-process activation; installing a
file alone does not update an existing request closure.

- `mediaCapabilities`: only `{ "op": "mediaCapabilities" }`.
- `mediaUpload`: exact keys `op, mode, requestId, vaultId, channelId, name, data`.
  `data` is canonical base64 of PNG bytes; `name` is a plain `.png` filename.
- `mediaSend`: exact keys `op, mode, requestId, vaultId, channelId, body, uploads`.
  `uploads` is zero to four prior verified upload request IDs, never URLs/paths.
  Use `uploads: []` for explicit-vault text-only publication; the same owner,
  channel, no-invoke negotiation, body validation and durable receipts apply.
  `mediaCapabilities` advertises `textOnly: true` and `minImages: 0` when activated.
  No upload is performed for text-only sends. The backend already accepts empty
  images on its dedicated route; this extension requires only desktop activation.
- `mode`: `apply` or read-only `reconcile`. Reconciliation repeats the original
  intent with only mode changed. No new intent is admitted in reconcile mode.

Each request rechecks authenticated current owner/vault access and exact channel
membership/marker, then negotiates `messages_no_invoke_v1` with media contract
`channel_png_assets_v1`. Old or mixed-version servers are not text fallbacks.
Uploads reuse normal browser-CSRF `POST /api/notes/:channel/assets`; message
creation uses a cookie-omitted, request-local agent bearer minted with normal
browser CSRF. No credentials leave the process. No membership materialization,
runner/model dispatch, reply hook, legacy send or generic remote URL fetch occurs.
The dedicated backend route checks current owner and exact channel access and
allows only up to four existing same-channel PNG assets, never inline data,
foreign URLs, nonimage attachments or execution inputs.

Limits: 8 MiB per image, four images per message, 8000-character nonmention body;
PNG RGB/RGBA, 8-bit noninterlaced, at most 8192 per axis and 16 million pixels.
Local validation checks canonical base64, PNG signature, chunk boundaries/CRC,
IHDR, bounded zlib decode, row length/filter bytes and IEND. Unsupported encodings
are rejected, not silently converted. The backend retains normal asset upload
validation and independently checks persisted PNG type/size and channel binding.

Private credential-free receipts are fsynced before each network mutation. A
lost upload or message creation response is unknown and is never automatically
replayed, including after service restart. A known returned ID/asset is read back;
changed intent conflicts. An uncertain upload can leave one unreferenced asset;
there is deliberately no heuristic search/replay or automatic deletion. A send
only accepts uploads from the exact same scoped channel receipts. Every upload
reconciliation downloads authenticated bytes and compares size/SHA-256; every
send reconciliation rechecks those bytes and exact message attribution, text,
images, completed state and absent run/reply/attachments. Subsequent deliberate
message edits or invocations are outside the creation-only no-dispatch contract.

Tests:
`node --test cascade-electron/media-control.test.cjs`
`cd backend_elixir && mix test test/cascade_web/external_agent_access_test.exs`

The first crosses real Unix socket and HTTP boundaries (CSRF/token/header flow,
file/scope/capability refusals, both unknown write stages, restart reconciliation,
corrupt bytes/metadata). The second crosses the actual backend router and storage
(upload/readback, cookie CSRF and agent restrictions, exact media persistence,
foreign/missing/inline/oversize-count refusal and no new dispatches/runs with
ambient agents enabled). Neither fixture by itself is live delivery evidence.

The persisted `images` entries in this contract are `{url, name, media_type,
data: ""}` objects, unlike ordinary human-upload URL strings. `ChatGroupRow`
uses the object's `url` for both thumbnail and lightbox without changing persisted
metadata or upload/send receipts. This also renders messages published before
the renderer understood the contract; do not repost or rewrite them.

Run `node scripts/test-chat-images-browser.mjs` for actual Chromium decoding and
rendering of both wire formats through the real component. Optional
`CHAT_IMAGE_EVIDENCE` points to a private JSON `{messages, assets}` capture, where
assets have `url, path, headers`; `CHAT_IMAGE_OUTPUT` saves screenshots and decode
receipts. Never commit private captures. Delivery acceptance requires exact
message readback, authenticated bytes, and actual image decoding/rendering, not
just successful upload/download hashes. Label isolated component verification
separately from a live signed-in application observation.
