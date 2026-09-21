# Separate-account local and remote flow

`alock account` implements the separate-account edit flow. Its controller is
Rust (`control/`); file access, atomic publication, range locks, content hashes,
nab storage, checker execution and DTOB encoding are C. Build with `make`, a C
compiler and Rust/Cargo. `control/Cargo.lock` pins the HTTP dependencies.

## Decisions

1. Request a range lock. An overlapping lock held by another agent returns
   conflict. For a remote file, its submitted **content** SHA-256 must match
   the remote master. The remote daemon is authoritative; a stale hash returns
   HTTP 409. The pathname hash used for alock's internal state directory is
   unrelated to this content revision check.
2. If another agent is active on the file and the current master passes its
   configured syntax check, checkpoint the preceding solo edits in nab before
   admitting the new agent. Approve either an ordinary assistant-turn lock or
   an explicitly requested persistent lease, at most 600 seconds.
3. Return the baseline as an agent-owned temporary file. The agent edits it
   with its usual editor. The neighboring `.alock` file holds the proposal's
   metadata. Commit sends only the replacement for the acquired range.
4. Commit checks plausible syntax and a valid lock. An expired or unclaimed
   lock may be renewed through request-lock only if the full master is
   unchanged and the range is available. With a live lock, three-way merge uses
   the staged range as ancestor, the proposal as ours, and the current **shifted
   live range** as theirs. Clean text merges are accepted; overlapping changes
   return 409 without publishing conflict markers. Differing binary edits also
   return 409. Other agents' accepted edits outside that range survive. Syntax
   checks run on the merged candidate before publication.
5. Each accepted concurrent commit writes master and checkpoints nab. Solo
   commits write master; their nab checkpoint waits for conclude. A rejected
   local commit leaves the already-edited temp file intact. A rejected remote
   commit saves the proposal beside master as `FILE.pending-RANDOM`, without
   changing master; the DTOB response identifies that pending file.
6. Conclude is **each assistant turn**, not the lifetime of the provider process.
   If master passes syntax, checkpoint its outstanding edits. If it fails, do
   not record. Release ordinary locks. Persistent locks keep their original
   deadlines and survive conclude. Bridge heartbeats expire lost sessions after
   30 seconds; they do not extend persistent deadlines.

Account-flow checkpoints are required by this flow. The `nab` boolean continues
to control optional recording for the older native/legacy bridge interfaces.
Solo account edits remain in master until conclude; they are not durable staged
transactions. A daemon crash before conclude can lose the in-memory batching
baseline. File publication and nab publication are not crash-atomic.

The existing native editor hooks and `alock bridge` interface remain available.
The new account flow operates on regular files, including new files whose
parents already exist. Legacy bridge directory, deletion and symlink operations
retain their existing interface.

## Configured syntax checkers

Create `$XDG_CONFIG_HOME/alock/syntax.tsv`, or `~/.config/alock/syntax.tsv`.
Each non-comment line is `file type<TAB>shell command`. The file type is the last
extension including its dot; extensionless files use their basename. Examples
(replace the spacing after the extension with a literal tab):

```text
.json	python3 -m json.tool "$1" >/dev/null
.py	python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$1"
.sh	sh -n "$1"
```

`$1` is a temporary candidate containing the entire proposed master; `$2` is
the original path. Paths are arguments, never interpolated into shell code.
Unconfigured types skip checking. Exit zero accepts; nonzero or a ten-second
timeout rejects. The configuration must be owned by the daemon user and not
group/other writable. Checker commands run as that user.

## Local bridge

Launch as the human, authorizing the existing separate agent account:

```sh
alock account serve --root /path/to/project --user fizzer --socket /path/to/owned-directory/agent.sock
```

Run from the agent account:

```sh
alock account stage --socket SOCKET --path src/main.c --lines 10-20 --author coder
# Edit only the returned file, leaving its .alock metadata beside it.
alock account commit --socket SOCKET --ticket TICKET --file TEMP_FILE --author coder
alock account conclude --socket SOCKET
```

Add `--persistent SECONDS` to stage for an explicit persistent lock. Commit does
not extend its deadline. `account abort` or `account release`, with socket and
ticket, releases an abandoned proposal. Failed commits do not remove the temp
proposal. An embedding host starts the bridge with `--control-stdin` and writes
`conclude\n` to its stdin; stdout acknowledges with `{"concluded":true}`.
Closing that control pipe stops the bridge. The HTTP daemon also accepts
`--control-stdin` for owner-process shutdown. These controls launch no processes.

## Persistent DTOB/HTTP transport

Create a private, owner-only header file containing `Authorization: Bearer TOKEN`
with a randomly generated token. Start the remote HTTP daemon once:

```sh
alock account http-serve --root /server/vault --listen 127.0.0.1:8041 --header-file /private/header
```

Start the local bridge with `--remote-url https://server/alock` and
`--header-file /private/header`, in addition to its normal serve arguments.
The header file remains on the human side of the account boundary. The HTTP
daemon should be served through the hosting application's authenticated HTTPS
ingress when used across machines.

For remote staging, provide `--base LOCAL_BASELINE_FILE` or `--sha256 CONTENT_SHA256`.
The server owns lock and commit decisions. There is no mirror update or sync
implementation. Successful responses refresh only the agent's temp proposal and
metadata, so subsequent commits can use the accepted baseline.

POST `/lock`, `/commit`, `/conclude`, `/heartbeat` and `/release` carry a DTOB
key-value body with `Content-Type: application/vnd.dtob`. The body includes
`operation` and `session`; lock also carries `file` (root-relative), `author`,
`sha256`, `line_start`, `line_end`, and optional `persistent_seconds`; commit
carries `ticket`, `author`, and raw `replacement` bytes. Replies contain `ok`,
`status`, and operation-specific fields. A lock/commit success includes `ticket`,
`sha256`, `content`, `start`, and `length`. Duplicate-key envelopes are rejected.
The local Unix-socket form uses the same DTOB with a four-byte little-endian
length prefix. HTTP uses its own framing, without that prefix.

The local bridge reuses its in-process HTTP client. The remote HTTP listener and
the private sole-writer daemon persist between requests. There is no curl,
shell transport, or per-request server process. External checker commands are
the explicitly configured syntax-check step, not transport.

## Verification

```sh
python3 -m unittest discover -s tests -p test_bridge.py -v
python3 tests/account_http_smoke.py /absolute/path/to/new/alock fizzer
```

The second command needs an already-installed account and noninteractive sudo
permission to launch as it. It uses disposable files and proves remote master
updates, unchanged local mirror, stale-hash rejection, retained daemon processes,
and an assistant-turn checkpoint. It does not install accounts or helpers.
