# Unix-account bridge preview

`alock bridge` is compiled into the C binary. The server runs as the human and
uses the existing private alock daemon. It does not expose that daemon's socket
or staging directory. No Python runtime or agent hooks are required.

Start as the human (not with sudo), after creating the separate agent account:

```sh
mkdir -m 755 /private/tmp/alock-diego-bridge
./alock bridge serve --socket /private/tmp/alock-diego-bridge/socket \
  --root /absolute/path/to/approved-project --user fizzer
```

Use a dedicated directory you own. The bridge refuses to replace an existing
socket. Stop the old process before removing a socket left by a crash.
The socket permits connections across accounts, but each request is authorized
using the kernel-reported peer UID (`getpeereid` on macOS, `SO_PEERCRED` on Linux).
The server CLI refuses root and same-user configurations.

From an agent process running as `fizzer`, with access to the alock binary:

```sh
alock bridge stage --socket /private/tmp/alock-diego-bridge/socket \
  --path src/example.c
# JSON response: {"ticket": "...", "file": "/.../alock-proposal-..."}
# Edit that temporary file with any tool, then:
alock bridge commit --socket /private/tmp/alock-diego-bridge/socket \
  --ticket TICKET --file /path/from/the/response
# Or abandon the edit:
alock bridge abort --socket /private/tmp/alock-diego-bridge/socket \
  --ticket TICKET
```

The temporary proposal is owned by the calling agent with mode 0600. Commit
sends its contents; the human service never opens an agent-supplied temp path.
The agent should remove its temporary copy afterward. Always stage before
editing and use the returned content as the baseline. Tickets expire after 60
seconds; expired/rejected proposals must be staged again and reconciled.

The server keeps a private alock stage, locks the entire file, and rejects a
changed baseline, including human appends. Each ticket fixes the target and is
single-use. Requests/files are bounded, with at most 32 outstanding proposals.
Path checks reject traversal, symlink parents, hard links, unsafe ACLs, and
group/other-writable files/directories. Root-owned sticky temporary ancestors
are permitted. Checks run again before commit. Existing alock clients still
coordinate through the same daemon.

## Scope and limits

- Regular files can be created, edited, and deleted. Use `stage --delete` then
  `commit --delete --author NAME` to delete a file or symlink; no `--file` is needed.
  To replace an existing symlink with a regular file, use `stage --replace-symlink`,
  edit the proposal, then commit normally. To change its target, use `stage --symlink`
  and put the literal new target in the proposal, without a trailing newline or NUL.
  These operations act on the link itself, never its referent; symlink parents
  remain rejected. Directory deletion, rename, and partial-range edits are unsupported.
  Every mutation requires `--author`; `nab = true` in alock.toml records history
  beside the source. Symlink history records target strings, not referent content.
- Permissions of existing projects are never automatically changed. The agent
  must not have other direct write access, sudo authority, or another service
  that can execute arbitrary commands as the human.
- Enroll only paths you intend agents to edit. Files containing code/config
  subsequently executed as the human can themselves confer human authority;
  a path allowlist is not a guarantee against that.
- All processes under the authorized UID share this capability. Tickets are
  opaque, not separate per-agent Unix identities.
- Human editors retain direct writes. A human changing files or permissions
  between validation and publication can still race with a commit. This does
  not claim mandatory coordination of human writes.
- One request is handled at a time, with bounded socket waits. An authorized
  local account can still exhaust its ticket capacity or delay other requests.
- Account provisioning, agent launching, remote-server approval, and packaging
  the binary so both accounts can execute it remain application integration.

Verification: `python3 -m unittest discover -s tests -p 'test_bridge.py' -v`.
Python is only the test driver: it builds and invokes the C server/client and
an isolated real daemon. The harness allows testing under the current UID and
shortens leases to two seconds; the production CLI retains its account checks
and 60-second lease. An actual second-account permissions test requires
administrator setup. Set `ALOCK_TEST_SANITIZERS=1` for ASan/UBSan builds.

The native socket protocol uses 4-byte little-endian length-prefixed DTOB key-value
envelopes (`op`, `argument`, `content`), retiring the legacy 16-byte `ALB1` header.
Operations are stage=1, commit=2, abort=3, mkdir=4, stage_delete=5, commit_delete=6,
stage_replace_link=7, stage_link=8; replies use success=0 or error=255. Arguments cannot
contain embedded NULs and must fit within PATH_MAX; content is capped at 4 MiB. All socket
I/O is deadline-bounded via nonblocking poll transfers, keeping untrusted input strictly
bounded.
