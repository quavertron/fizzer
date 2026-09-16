# App context

Fizzer loads one bounded behavioral document into every agent run and continued
turn, including coordinator and worker prompts. It is shared across the signed-in
account's agents and vaults, never across accounts. Provider compaction commands
remain untouched.

Agents use the existing authenticated helper:

```sh
cascade-chat context get
cascade-chat context set --file context.txt --revision <revision-from-get>
```

The read returns JSON with `content` and `revision`. Save the complete revised
document as UTF-8 text (at most 12,000 bytes). A stale revision returns HTTP 409:
read again and merge deliberately before retrying. There is one current document
in the application database, with no editing UI or version history. Saved edits
survive server restarts; unsaved accounts receive the built-in seed.

Keep this document for reusable behavior, not private vault facts or secrets.
It cannot grant authority or override current user instructions, task ownership,
Stop, privacy, or server authorization. Save a correction successfully before
promising to remember it. Updated desktop helper bundles provide the new command;
already-running older helper installations require their normal source/app update.
