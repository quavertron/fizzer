# Delete a vault through an owner mission

The vault switcher already lets a signed-in vault owner delete a vault. An agent
can use the same deletion service through `cascade-note` while carrying out an
active owner mission:

```sh
cascade-note vault list
cascade-note vault delete <full-vault-id> \
  --confirm-name 'Exact vault name' \
  --authority-message <owner-message-id>
```

This permanently removes the vault and its managed files. The helper verifies
that the target is absent afterward. It never defaults deletion to the current
vault or resolves a partial ID.

The server checks ownership, the running mission and its saved authority, and
the original human message. The source must still be the owner's latest human
message in that channel, unchanged and not forwarded. Supported instructions are
complete imperatives: `delete the <name> vault` or `delete <name> vault`, optionally
prefixed with `please` or `add a way to delete vaults and`, and optionally ending
with `for me` and a period or exclamation mark. Arbitrary prose, negations,
questions and conditional requests do not authorize deletion. Name matching is
case insensitive; a trailing ISO date may be omitted only when the resulting
name identifies exactly one visible vault. The helper still requires the full
current name and ID.

Missing authority, a later human message (including Stop), an edited source,
other owners' vaults, a vault created after the instruction, ambiguous names,
the running mission's vault, and targets with queued/running runs or unfinished
missions are rejected. Unregistered agent posts always retain an agent marker,
even when their display name matches a human. Other agent restrictions remain
in force. No owner credentials or database access are needed by the helper.

The HTTP interface is `DELETE /api/vaults/:id`, with an agent bearer token,
`X-Cascade-Run-Id`, and JSON fields `expectedName` and `authorityMessageId`.
The existing signed-in owner deletion interface remains available.
