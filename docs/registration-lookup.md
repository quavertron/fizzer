# SELECT-only owner registration lookup

Authenticated `GET /api/vaults/:vault/channels/:channel/agents/:registration?vaultAgentId=:identity&hermesProfile=:profile` returns `{registration}`. Both query bindings are required. `:registration=resolve` is the named exact identity+channel query, not a roster: it returns only a unique existing registration. Missing, expired, excluded, inaccessible, wrong owner/profile/identity bindings return 404; unauthenticated calls return 401. User and agent authentication are supported.

The projection contains `id`, `vaultAgentId`, identity `vaultId`, `ownerUserId`, `agentId`, `hermesProfile`, `identityAvatarUrl`, membership `avatarUrl`, local/source vault/channel IDs and `contract: registration_lookup_select_only_v1`. No prompts, model settings or working directories are returned. Local channel access is checked and the membership is joined in its resolved source channel. Only the authenticated identity owner may read it.

This route only SELECTs. It excludes expired sessions using a predicate, without cleanup, departed-owner repair, membership creation, assets or events. A missing result is not permission to recreate an identity. Existing list/detail identity and channel roster routes retain their legacy side effects and must not be used as a fallback.

The endpoint fixture exercises the actual router using a temporary SQLite database with `PRAGMA query_only=ON`, snapshots every table, includes unrelated expired and unprojected identities, and checks user/agent auth and owner/profile/vault/channel mismatch denial. No production identity or avatar mutation is part of this release.
