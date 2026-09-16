# Voice rooms and HTML attachments

## Features

Dedicated voice channels use self-hosted LiveKit. The channel creation dialog
persists either the existing `cascade://chat-channel` marker (text) or
`cascade://voice-channel` (voice) in the normal note store, including folder/order.
Existing text notes, messages and folders are unchanged; there is no conversion or
schema migration. The server permits voice joins only for the voice marker.

Click a speaker-icon sidebar room or its explicit Join button to connect. Opening
or restoring a room as a tab never joins. Participant rows beneath rooms show mute
and deafen; the joined room also shows live speaking state. Unjoined room rosters
refresh every five seconds and cannot subscribe to media. The app owns one voice
session, so note/text navigation keeps it connected. Its persistent controls offer
mute, deafen and disconnect, including on phone layouts. Switching rooms closes the
old connection and tracks before connecting the next and preserves mute/deafen
intent. Disconnect, vault/account changes, revocation and unmount clean up media;
pending asynchronous capture is fenced against cancelled sessions.

Human owner/editor access and the existing channel/DM
route authorization are required. Agent tokens cannot join. Joken issues 30-second
room-specific microphone-only tokens; data publication and metadata changes are
forbidden. Deafen status uses a human-authorized, identity-scoped server
`UpdateParticipant` call; it never grants clients permission to edit the metadata
used for revocation. Every five seconds the backend checks SFU participants against current
membership, including peers surviving backend restart. Revocation depends on the
SFU control connection being available; token expiration alone does not revoke an
existing media session. Missing/unreachable SFU returns unavailable, never a fake room.

`cascade-chat send --file /absolute/artifact.html --vault VAULT --channel CHANNEL`
uploads through authenticated channel-scoped asset authorization and publishes an
HTML attachment. ChatComposer also accepts HTML files. Download serves the original
bytes as an attachment, never active same-origin HTML. The preview is deliberately
restricted: inline JS/local interaction and inline styling work; external resources,
network, storage, parent DOM, popups, forms, navigation and nested frames do not.
DOMPurify removes frame/object/embed construction in the trusted outer guard; CSP,
opaque sandbox origins and Trusted Types constrain dynamic HTML creation. WebRTC
constructors are disabled before artifact scripts, with fresh-frame escape paths
blocked. Frameworks needing external modules or unrestricted innerHTML may not work.
Preview is not a general-purpose hostile-compute containment service: CPU/memory
exhaustion and browser-engine vulnerabilities remain outside this boundary.

Preview script/CSP exceptions are limited to the exact preview response. The app
shell additionally permits frames only at its own `/api/html-previews/` path and,
when voice is configured, microphone for self. Other routes retain existing headers. The earlier research's single-window WebRTC override is insufficient:
`scripts/test-html-research-bypass.mjs` demonstrates a nested-srcdoc realm bypass.

Interaction reference: [Discord voice channels](https://support.discord.com/hc/en-us/articles/19583625604887-Voice-Channels-FAQs).
State synchronization follows [LiveKit participant attributes](https://docs.livekit.io/transport/data/state/participant-attributes/)
and [server participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/).

## Existing-host deployment (parent-owned release)

No production service/configuration was changed by this feature branch. The normal
application release must include the generated preview guard and new frontend.
`npm run build` generates the guard and bundled third-party license files.

Voice additionally needs a private random LiveKit keypair and sidecar:

1. Copy `deploy/livekit.yaml.example` to a protected host file, substituting the
   existing host public IP and random keypair. Never use test keys or CHANGE_ME.
2. Set FIZZER_VOICE_CONFIG to that absolute file and FIZZER_VOICE_NETWORK to the
   existing app Docker network in protected `/etc/fizzer/voice.env`.
3. `docker compose --env-file /etc/fizzer/voice.env -f deploy/voice.compose.yml config`
   then `up -d`. This uses a pinned image, resource limits and private control API.
4. The maintained `deploy/nginx.conf.template` includes voice signalling and denies
   the SFU control API; normal Actions cutover renders and validates it. Custom
   self-hosted nginx configurations can use `deploy/voice.nginx.conf`. Do not add a
   production host-only include: the next cutover replaces it. Reuse the existing
   domain/certificate; no new domain required.
5. Pass these variables into the application container via its deployment environment:
   FIZZER_VOICE_URL=wss://EXISTING_HOST/voice,
   FIZZER_VOICE_API=http://fizzer-voice:7880,
   FIZZER_VOICE_KEY and FIZZER_VOICE_SECRET matching the protected SFU configuration.
   Merely setting the host shell variables does not inject them into Docker.
6. Verify external signalling and media from two independent networks. The sidecar
   needs inbound TCP 7881, UDP 7882 and UDP 3478. These are feature-specific media
   ports, not an instruction to alter unrelated firewall policy. Confirm provider
   and host access before advertising live voice. UDP TURN is included; networks
   requiring TURN/TLS on 443 need an additional routing/certificate plan and are NOT
   proven by the local fixture. No paid service or DNS purchase is required here.

Preserve execution-admission.json and never restart the desktop runner to activate
these features. Parent owns release ordering and live acceptance. Rollback sidecar
with its exact compose project only; disable the four voice app variables through
the normal release process. Do not tear down the application's network.

## Reproducible isolated verification

Install normal repository dependencies, cached Playwright Chromium and Docker.
`PLAYWRIGHT_BROWSERS_PATH=/path/to/cache npm run test:voice-html` builds a disposable
internal Docker network/SFU and runs real HTTP/router/CLI/UI/media tests. It cleans
its own container/network on exit; it unsets personal display variables. Browser
uses synthetic oscillator tracks with speaker output disabled, never the user's microphone.
The fixture renders the actual App and uses its normal human-authenticated API. Optional
FIZZER_MEDIA_OUTPUT selects evidence directory and FIZZER_ORIGINAL_HTML_FIXTURE
selects an existing HTML artifact to verify without modifying it.

Historical initial voice/HTML implementation evidence (not checks for the dedicated
channel candidate): 4 focused tests passed; two headless clients transferred real audio
(3705 inbound bytes, 15 packets, nonzero audio energy), selected TURN relay,
reconnected, left/rejoined, denied microphone permission, rejected unauthorized
joins and disconnected a revoked member in 5297 ms. CLI upload/download bytes,
original session-monitor interaction, and hostile sandbox fixtures passed.
Chromium netlog contained zero hostile.invalid events; this is evidence for the
fixtures, not a proof against every browser exploit.

Full backend: 490 passed. Frontend/typecheck: 40 files, 382 tests passed.
Production audio and personal signed-in desktop activation are not claimed.
