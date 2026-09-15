# Voice rooms and HTML attachments

## Features

Channel voice uses self-hosted LiveKit, not the agent runner. Join is explicit;
only then is microphone capture requested. Mute, deafen (also mutes publication),
leave, participant list and reconnect status are in ChatView. Switching channels
or unmounting stops tracks. Human owner/editor access and the existing channel/DM
route authorization are required. Agent tokens cannot join. Joken issues 30-second
room-specific microphone-only tokens; data publication and metadata changes are
forbidden. Every five seconds the backend checks SFU participants against current
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
uses synthetic oscillator tracks, never the user's microphone. Optional
FIZZER_MEDIA_OUTPUT selects evidence directory and FIZZER_ORIGINAL_HTML_FIXTURE
selects an existing HTML artifact to verify without modifying it.

Observed: 4 focused tests passed; two headless clients transferred real audio
(3705 inbound bytes, 15 packets, nonzero audio energy), selected TURN relay,
reconnected, left/rejoined, denied microphone permission, rejected unauthorized
joins and disconnected a revoked member in 5297 ms. CLI upload/download bytes,
original session-monitor interaction, and hostile sandbox fixtures passed.
Chromium netlog contained zero hostile.invalid events; this is evidence for the
fixtures, not a proof against every browser exploit.

Full backend: 490 passed. Frontend/typecheck: 40 files, 382 tests passed.
Production audio and personal signed-in desktop activation are not claimed.
