# BYOU shared remote workspaces

Status: proposed architecture and implementation sequence; no runtime changes authorized or implemented by this plan.

## Outcome

Two people open the same remote vault. Each sees its project files at a normal local filesystem path. Each runs their own authenticated agents on their own computer. A saved, accepted edit persists on the workspace host and becomes visible to the other participant without Git pushes, manual pulls, or manual synchronization.

The host stores shared files, revisions, permissions, and change events. It does not run provider agents, hold provider credentials, or multiplex one person's provider session among participants. Sharing a vault grants access to its data, not permission to invoke another person's agent. Treat that separation as a product requirement; this plan makes no determination about any provider's terms.

## Current integration points

- `backend_elixir/lib/cascade_web/orchestration_controller.ex` selects `runner_user_id` from the registration owner, but resolves execution through registration, channel, and work-item `cwd` paths.
- `cascade-electron/agent-runner.cjs` resolves `opts.cwd` / `opts.vaultRoot` before invoking local CLIs. Keep this execution boundary.
- `scripts/desktop-runner-daemon.cjs` supports workspace preparation and local execution for the terminal surface. Electron and TUI must use the same workspace service.
- `cascade-electron/worktrees.cjs` manages host-local Git worktrees and explicit publication. Preserve isolated task workspaces instead of replacing them with one mutable shared Git index.
- Vault notes and chat are backend records. Project files are a separate resource; do not synchronize a SQLite database or create a second editable copy of note content.

## Proposed architecture

```text
Person A                                     Person B
own CLI credentials                          own CLI credentials
      |                                            |
local agent runner                           local agent runner
      |                                            |
local workspace path                         local workspace path
      |                                            |
workspace client + private cache             workspace client + private cache
      |                                            |
      +-------- authenticated file protocol -------+
                              |
                  shared workspace service
                  revisions / leases / event log
                              |
                  durable shared project files
```

Use one desktop application and one local workspace daemon per installation, shared by Electron and the TUI. Local vaults use a local filesystem adapter. Remote vaults use the same runner interface backed by a managed remote workspace adapter. Choosing a vault changes its binding; it does not require launching another application version.

### Identity and permissions

Introduce a durable `workspace_id` bound to the vault and storage service. Identify it by instance origin plus workspace ID, not vault name or a globally assumed vault ID. Dispatch references the workspace ID, a relative working directory, and optionally an isolated task ID / base revision.

Each device privately maps that identity to a path such as `~/.fizzer/mounts/<instance>/<workspace>/`. Resolve and validate the path on the owner's machine immediately before starting the agent. A remote server's absolute path must never become an executable local `cwd`.

Bind every run to the initiating user's authorized registration, device, workspace access, and local provider session. Explicitly audit mentions, coordinators, missions, queued recovery, and delegated worker paths: a collaborator's message must not silently spend the owner's usage. A request addressed to another person's agent can require that owner's acceptance before becoming a locally authorized run. Membership alone is insufficient authority.

Workspace credentials are revocable and scoped to workspace operations; they are distinct from provider credentials. Removing access stops new reads, commits, and lease renewal. Previously downloaded files cannot be remotely made unknown to a participant.

### Filesystem behavior and transport

Target a normal folder usable by existing CLI agents, editors, `rg`, compilers, and formatters. Prototype a mounted filesystem on macOS first, then validate Linux and Windows separately. Do not claim cross-platform parity before testing the filesystem adapters.

Prefer a versioned file protocol over the existing authenticated TLS connection. SSH may tunnel that protocol to a self-hosted workspace service. Raw writable SSHFS/SFTP access cannot be the only production write path because it can bypass revision and lease enforcement. Stock SSHFS is useful for measuring mount compatibility, not proof of collaboration correctness.

A local mirror with a watcher is an alternative only if the mount prototype fails its compatibility or installation gate. It has different save semantics: local writes can succeed before publication is accepted. Expose that as pending/conflicted synchronization and do not label it equivalent to a confirmed shared save. Select the implementation after the spike; do not build both by default.

### Save contract

1. Read returns bytes and a file revision. A managed edit session records that baseline before the agent reads and edits.
2. Stage modifications locally. Publish completed saves, not individual keystrokes or partially written byte ranges.
3. Commit contains the expected revision, new content hash, mutation ID, and current lease fencing token. The server checks authorization and revision atomically.
4. A successful acknowledgment means the content and revision are durable and a replayable change event exists. Retrying the same mutation ID returns the same outcome.
5. Other clients consume the ordered event, invalidate stale cache entries, refresh the affected files, and notify their UIs. Reconnect resumes from a sequence number; a missing event range triggers manifest reconciliation.

Use server-enforced whole-file leases initially, including rename/delete operations. Adapt `alock` staging to obtain these leases and revisions across machines. Do not assume today's machine-local locks coordinate separate computers. Range locks and automatic text merging can follow after file-level correctness is proven.

A filesystem cannot infer that an arbitrary shell command is writing content based on an earlier stale read. Agent edit hooks must retain the read baseline, or an explicit workspace lease must cover the entire operation. For uninstrumented formatters and shell edits, require an exclusive operation lease or an isolated workspace. Merely acquiring a lock at final write time is insufficient. Reject stale edits while preserving a recoverable local draft; never silently replace the current revision.

Define save boundaries for direct writes, temp-file-plus-rename, flush, close, and `fsync` in the prototype. Support multi-file atomic commits for managed tools. Ordinary tools performing separate saves do not acquire an implicit cross-file transaction; build/test operations that need a stable tree should use an explicit snapshot.

### Local-only files, Git, and failures

- Keep provider stores, Fizzer tokens, `.env` secrets, agent session files, dependency caches, build outputs, and sockets outside the shared namespace by default. Initial import previews included files and exclusions. Decide deliberately how project-specific outputs enter shared storage.
- Keep `.git` indexes, locks, and worktree metadata local. Git snapshots/branches are explicit integration artifacts, not a concurrently writable remote `.git` directory. Prove status/diff/commit and isolated-worktree behavior in the prototype before enabling Git-mutating commands on a live shared tree. Serialize publication/integration where necessary.
- On disconnect or lease loss, shared commits fail promptly. Preserve private staged changes and expose read-only cached state. Reconnection revalidates the baseline before retrying. An expired client cannot overwrite the new lease holder's changes.
- Define path normalization, case collisions, executable modes, and symlink rules. Confine operations to the workspace; never follow a link into a participant's home or credential directories.
- Persist revision history, tombstones, and restoration metadata. Content storage, revision metadata, and event publication need recoverable crash ordering; a process-local watcher is not the durability boundary.

“Immediately” means after a completed save has been accepted, subject to network latency. Proposed target: with two healthy clients at 50 ms RTT and a changed file under 100 KB, p95 durable save acknowledgment below 250 ms and peer visibility below 500 ms, excluding time waiting for an edit lease. Measure cache warm/cold reads, directory traversal, search, and build workloads separately. These are acceptance targets, not measured promises.

## Delivery sequence

1. **Filesystem and ownership spike.** Run two local agent processes on two machines against one test workspace. Measure mount behavior, caching, watcher delivery, atomic saves, formatter writes, Git operations, and disconnect handling. Check all dispatch entry points for BYOU ownership. Deliver a supported-operation matrix and select the filesystem adapter. Stop here if correct save semantics require unacceptable CLI changes; report the alternative explicitly.
2. **Workspace identity and local adapter.** Add additive workspace references and per-device bindings. Introduce a shared `prepareWorkspace` contract for Electron and TUI. Keep legacy local paths working through the local adapter. Block remote execution when no valid local binding exists instead of falling back to a home directory or server path.
3. **Durable workspace service.** Implement manifests, file revisions, scoped reads, staged commits, leases with fencing, idempotency, an event log, and recovery. Test two writers and interrupted commits before exposing writable mounts.
4. **Managed mount and local runner.** Add private caching, revision-aware edit sessions, alock coordination, event replay, bounded I/O failures, and local workspace resolution. Keep provider authentication and execution entirely local. Deliver the smallest two-user preview here.
5. **Product integration.** One vault chooser in the compiled Electron app and the TUI. Add “Attach shared project folder,” import preview, readiness state, collaborator activity, and explicit conflict recovery. A pending mount or conflict must not appear as a ready writable workspace. Notes/chat continue using existing APIs.
6. **Isolated tasks and migration.** Extend local worktrees to snapshot the shared workspace and publish reviewed change sets back with revision checks. Preserve existing BYOU runs and local workspaces. Opt in one remote vault, then additional vaults after verification. Remove superseded remote absolute-path logic only after migrated callers pass their checks.

Migration does not automatically upload existing vault roots. Inventory each root, let its owner select shared content, create the durable workspace, verify a manifest, then bind participating devices. Rollback disables the remote adapter and preserves both the authoritative files and uncommitted local drafts; it must never replace either from an older snapshot.

## Required acceptance checks

- Two people use separate locally authenticated agents against one workspace; accepted edits propagate without manual synchronization.
- No provider credential or session is present on the workspace service, and another participant cannot trigger spending on an owner's account without the owner's authorization.
- Same-file concurrent edits, stale reads, expired leases, rename/delete races, and replayed mutations never silently lose work. Disjoint edits proceed independently.
- Network loss and restart preserve staged work, reject stale writers, replay changes, and recover interrupted publication.
- Ordinary edits, atomic-save editors, bulk formatters, executable bits, case collisions, and symlinks satisfy the declared filesystem contract.
- Local dependencies and secrets remain private; both supported direct editing and isolated worktrees operate correctly.
- Electron and TUI use the same workspace identity and local runner behavior. A single compiled Electron build opens local and remote vaults.
- Meet the measured propagation target under the stated workload; record limits under slow links, large files, and many agents.

## Sources informing the filesystem spike

SSHFS exposes caching controls, so freshness needs explicit validation: [SSHFS manual](https://github.com/libfuse/sshfs/blob/master/sshfs.rst). FUSE writeback mode assumes changes pass through its local kernel module and is generally unsuitable for network filesystems: [Linux FUSE I/O modes](https://kernel.org/doc/html/latest/filesystems/fuse/fuse-io.html). These constraints motivate the revision service and cache-coherence tests; they do not establish that a stock SSH mount provides the proposed guarantees.
