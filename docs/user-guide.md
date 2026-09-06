# Fizzer user guide

Fizzer is a shared workspace for people, notes, conversations, and locally-run AI agents. Its public source repository is `grm4871/fizzer`.

Use Fizzer when you want one place where:

- knowledge is durable instead of disappearing in chat;
- people and AI agents can work in the same project context;
- coding agents can run on an owner’s computer without sending provider credentials to the server;
- work can be organized, assigned, reviewed, and resumed;
- private material stays private while useful project context is shared.

Fizzer is early-beta software. The interface and available agent adapters may change.

## The mental model

### Vaults are workspaces

A **vault** is the top-level boundary for a project or community. It contains folders, notes, chat channels, members, agents, and activity. Create separate vaults when the context or permissions should be separate—for example, one for personal research and another for a client project.

A vault can be private or shared. Shared vault members have roles such as owner, editor, or viewer. The owner controls membership, invitations, discovery settings, moderation, and role changes.

### Notes are the durable layer

A **note** is a Markdown-backed document. Use notes for requirements, decisions, meeting records, research, specifications, checklists, reference material, or anything you want to remain useful after a conversation ends.

Notes can be placed in folders, linked to each other, searched, converted to Kanban boards, and published as public snapshots.

### Channels are the coordination layer

A **channel** is a persistent conversation inside a vault. Use a channel for questions, decisions, status updates, agent requests, and project discussion. Channels appear in the same navigation tree as notes and can be opened in tabs or split panes.

### Agents are local workers

An agent registration connects a channel to a locally authenticated CLI such as Claude Code, Codex, Grok, Copilot, Hermes, Antigravity, Akron Grok, OMP, or Pi. The agent process and provider credentials stay on the owner’s desktop. Fizzer stores the workspace conversation, run events, and results—not the provider’s secret credentials.

## Ways to use Fizzer

| Goal | Use | Why |
| --- | --- | --- |
| Keep personal or team knowledge | Notes and folders | The information remains searchable and editable after chat moves on. |
| Discuss work with people | Vault channels | Everyone sees the same durable transcript and context. |
| Ask an AI to do work | Agent mentions | The request runs through the owner’s local authenticated CLI. |
| Coordinate a larger task | Missions | Work becomes a durable, trackable task instead of one fragile prompt. |
| Track implementation | Work items and Kanban | Tasks, branches, reviews, and status have an addressable home. |
| Protect sensitive context | Private note blocks | Agents and model prompts do not receive the marked content. |
| Share a finished document | Publish | Readers get a public snapshot without access to the private vault. |
| Find prior decisions | Workspace search | Search covers both notes and chats. |
| See what changed | Updates | Mentions, replies, note changes, and new activity are collected in one place. |

## Getting started

### Option 1: use the desktop beta

1. Download a desktop release from the project’s GitHub releases.
2. Install at least one supported agent CLI on the same computer if you want AI execution. Authenticate that CLI directly with its provider.
3. Open Fizzer and create an account.
4. Create a vault from the vault switcher.
5. Create a note or channel and start working.

The desktop installers are currently unsigned, so macOS or another operating system may ask you to confirm that you trust the application.

### Option 2: run from source

For ordinary note and chat work, the browser/headless mode is enough. Agent execution requires the desktop shell or another compatible runner.

Prerequisites:

- Node.js 20 or newer;
- npm and Git;
- Elixir 1.17+ and Erlang/OTP for the local API;
- an Electron-capable desktop session for local agent execution.

From the repository root:

```bash
cp .env.example .env
npm install
npm install --prefix cascade-electron
npm run dev
```

This starts the API at `http://localhost:3000`, the Vite client at `http://localhost:5173`, and the Electron shell.

For browser-only work:

```bash
npm run dev-headless
```

Local runtime data is stored outside the checkout by default:

- database: `~/.cascade/docs.db`;
- vault files and assets: `~/.cascade/vaults/`.

## The main workspace

### Sidebar

The left sidebar contains:

- the current vault and vault switcher;
- quick actions for a new note, folder, channel, and search;
- the folder and note tree;
- unread activity badges;
- access to public vault discovery and direct messages;
- account and vault management actions.

Right-click a note or folder for rename, delete, move, and creation actions. Drag notes and folders to reorder them or move them into another folder. The `Notes` heading is the drop target for moving an item back to the vault root.

### Tabs and panes

Notes, channels, and the Superkanban command center open as tabs. Tabs are remembered per vault in the local browser session.

- Drag a tab onto the center of another pane to dock it there.
- Drag a tab toward a pane edge to split the pane.
- Resize split panes with their divider.
- Drag a tab outside the workspace to pop it into a separate desktop window when running Electron.
- Use the tab context menu to close tabs or close other tabs.

This is useful when comparing a specification with a note, keeping chat beside a board, or watching an agent while editing a document.

### Workspace toolbar

The top toolbar provides:

- **Orbit** — a live view of currently running agents;
- **Updates** — unread mentions, replies, note changes, and other activity;
- **Sessions** — active AI runs, model, elapsed time, and controls;
- **Members** — open the current vault’s people and agent panel when available.

## Vaults, folders, and sharing

### Create and switch vaults

1. Open the vault name at the top of the sidebar.
2. Choose **New vault**.
3. Enter a name and create it.
4. Switch between vaults from the same menu.

Use a separate vault when you need a clean context boundary, different collaborators, or different access rules.

The vault menu also lets you rename or delete vaults when your role permits it. Deleting a vault is permanent and removes its notes.

### Organize notes

Use **New folder** to create a folder. Create notes from the quick action, from a folder’s context menu, or with `Cmd/Ctrl+N`.

Rename a note inline from the note title or via its context menu. Move notes by dragging them or using the move action. Folders can be nested and reordered.

### Invite and manage people

Open account settings and choose **Current vault**, or use the member controls in a channel.

Owners can:

- invite a user by username;
- copy an invite link for a chosen role;
- change a member’s role;
- remove or ban a member;
- unban a member;
- leave moderation reports unresolved or resolved;
- approve or decline public-vault join requests.

A viewer can read according to the vault’s access rules but should not be given editor access unless the owner intentionally promotes them.

### Public vault discovery

Vault owners can list a vault publicly with a summary, topics, community guidelines, and an optional sanitized home-note preview. Choose one join policy:

- **Open** — anyone can join as a viewer;
- **Request** — the owner must approve the request;
- **Invite only** — discovery does not permit self-joining.

Open the vault switcher and choose **Browse public vaults** to search by name, owner, purpose, or topic. Open a vault’s detail page to read its guidelines and join or request access.

Use public discovery when you want people to find a community or project without making the vault’s working notes public.

## Notes

### Edit and save a note

Open a note from the sidebar. The editor is a Markdown live-preview editor. The title is editable at the top of the note.

Edits make the tab dirty. Save the active note with:

- `Cmd/Ctrl+Shift+S` on desktop;
- the **Save** action on mobile.

Save before closing a tab or switching context if you need the latest draft persisted.

### Formatting toolbar

The editor supports:

- bold, italic, strikethrough, and inline code;
- links;
- headings 1–3;
- checklists, bullet lists, and numbered lists;
- horizontal rules;
- Markdown tables rendered as live previews;
- images, MP3 audio, and MP4 video uploads;
- pasted or dropped images;
- links to other Fizzer notes;
- private blocks;
- public publishing;
- an editor view and a Kanban view.

Uploaded images, audio, video, PDFs, and text files are limited to 64 MB each. Images can also be resized in the editor.

### Link notes together

Use the note-link action on mobile or the link control in the editor to search for another note and insert a link. You can also type an Obsidian-style wikilink such as:

```markdown
[[Decision log]]
```

Clicking a wikilink opens the matching note. Linking notes is useful for connecting requirements to decisions, research to conclusions, or a project overview to its working documents.

### Hide sensitive material from agents

Select the private-block toolbar action, or use this Markdown form:

```markdown
:::private
credential=value
internal-only context
:::
```

The editor renders the block as a protected region. Private blocks are redacted before search, memory, previews, publishing, and model prompts. Use them for secrets or context that collaborators may see but agents must not receive.

Do not treat this as a substitute for a password manager. Avoid storing credentials in notes when a dedicated secret store is available.

### Ask an agent from a note

An AI directive has the form:

```markdown
{{ai: Summarize this note into three decisions}}
```

Place the cursor on the directive and press `Cmd/Ctrl+Enter`. Fizzer sends the prompt through the active agent path. Use this for small, note-local actions such as summarizing, extracting tasks, or drafting a rewrite.

For larger work, use a channel and a mission so the request has a durable conversational and task history.

### Publish a note

1. Open the note.
2. Select the globe action in the editor toolbar.
3. Fizzer publishes a snapshot and copies the public link.
4. Use the link action to copy it again or the external-link action to open it.
5. Click the public status in the footer to unpublish.

Publishing is for sharing a finished or intentionally public document. It is not the same as inviting someone to the vault: a public snapshot does not grant access to the private workspace.

## Chat and direct messages

### Send a channel message

1. Open or create a channel.
2. Type in the composer.
3. Press Enter to send; use Shift+Enter for a new line.
4. Use the emoji action or upload action when needed.

A channel transcript is persistent and realtime. Use ordinary messages for context, questions, decisions, and progress. Attach images or other supported media when visual context matters.

### Reply, quote, and forward

Right-click a message to:

- **Reply** — attach the message as the direct context for your response;
- **Forward** — copy the message into another channel while retaining its origin;
- **Add to kanban** — turn the message into a durable work item;
- **Report** — report a channel message to the vault’s moderation queue;
- **Delete** — delete for everyone when you have permission.

Use replies when the conversation has multiple threads. Use forwarding when another channel needs the result but should still be able to see where it came from.

### Chat with a person directly

Open **Messages** from the vault switcher or community controls. Start a conversation by entering a username. You can control whether strangers may start new direct messages and block or unblock users.

Use direct messages for private coordination that does not belong in a shared vault channel. Put decisions that the team needs later into a vault note or channel instead.

## Local AI agents

### What an agent run does

An agent run combines the user’s request with relevant channel and workspace context, starts on the registered owner’s local runner, streams status and tool activity, and persists the result back into the channel.

A run may show:

- queued, running, completed, failed, or canceled status;
- answer text and reasoning/tool blocks;
- a readable activity trace;
- raw harness output when needed;
- model, token, context, turn, and rate-limit statistics.

The short chat bubble is the outcome. Open the activity or session views when you need the detailed process trace.

### Install and authenticate an agent

Install and authenticate the provider’s CLI on the computer that will execute the run. Fizzer does not replace the provider login and does not store that provider credential on the server.

The desktop runner is required for normal local agent execution. If the runner is offline, ordinary notes and chat remain usable but agent runs cannot start until a compatible runner reconnects.

### Add an agent to a channel

1. Open a channel.
2. Open the people/agent panel on the right.
3. Choose **Add agent** or create a new vault agent.
4. Select a backend and model.
5. Set a display name and `@` handle.
6. Set the working directory (`Cwd`) to the vault root or a project path.
7. Add standing persona/context instructions if useful.
8. Save the registration.

An agent identity can be reused across channels in the vault. Channel membership controls how that identity behaves in a particular conversation.

### Mention behavior

Use `@agent-handle` when you want a specific agent to respond. The registration can also allow mentions from other agents or from other people in the vault.

The channel settings include:

- **Coordinate this channel** — the agent reads every human message and can delegate durable work;
- **Reply to every human message** — the agent answers ordinary human messages without an explicit mention;
- **Other agents** — other agents may mention it;
- **Other people** — any vault member may mention it;
- **Full host access** — bypasses prompts and workspace boundaries.

Keep **Full host access** off unless you understand the local-machine consequences. The recommended execution mode keeps the agent inside its owner’s workspace and uses the owner’s local CLI account.

### Choose a project folder

Open channel settings and set **Project folder** to the directory where the agent should work. Agents can also use a vault-relative path in their registration.

Set a project folder when you want an agent to edit a repository or inspect a defined project. Leave it unset for general conversation or note-oriented work.

### Coordinate multiple agents

A channel may designate one agent as its coordinator. The coordinator can answer simple questions directly and create a mission for non-trivial work. It can delegate tasks to other registered agents or to isolated anonymous worker sessions. Those workers execute a single assigned task; they do not become extra coordinators.

Enable coordination when the channel benefits from a single dispatcher—for example, a project room with one planning agent and several specialist agents. Do not enable several competing coordinators for the same channel.

**Suggest what to work on next** is off by default. When enabled, the coordinator considers useful next work after completion and when you return, without interrupting an active request. It may suggest one grounded task or record why no suggestion is appropriate. Accepting authorizes only the proposed task; declining preserves your reason and suppresses that topic. An unanswered suggestion waits for your response.

## Missions and durable work

A **mission** is a durable task record projected into the chat transcript. It is useful when a request has multiple steps, may take a long time, needs delegation, or requires review after workers finish.

Typical mission states are:

- active while tasks are pending or running;
- reviewing after worker output arrives;
- attention when a task fails or is blocked;
- completed after coordinator verification, or qualifying evidence for a mission configured for automatic completion;
- canceled when stopped.

Open **Missions** in a channel to inspect mission history. Expand a mission to see tasks, assignees, statuses, attempts, and event history.

A coordinator can review worker evidence, retry a task, or finish a reviewed mission with a concise summary and verification. Before retrying, inspect the existing task and completed work; a retry starts a new attempt and must respect Stop. The assigned worker owns integration and authorized delivery. See [Agent runtime](agent-runtime.md#chat-first-orchestration) for completion and recovery details.

Use missions instead of a loose sequence of prompts when you care about ownership, dependencies, retries, or an auditable record.

## Kanban and project workspaces

### Turn a note into a Kanban board

Open a note and select the Kanban view. If the note is not already a board, choose **Create board**. Fizzer creates a portable Markdown-backed board with columns such as Backlog, In progress, and Done.

Kanban actions include:

- add, rename, complete, and delete cards;
- add, rename, collapse, archive, and delete lists;
- drag cards between lists or reorder them;
- search cards;
- archive completed cards;
- optionally include the board in Superkanban.

The board remains ordinary Markdown, so the content stays portable. A compatible Obsidian Kanban marker is recognized when present.

### Superkanban

**Superkanban** is the vault-wide command center. It collates boards across the vault and shows active, blocked, and in-review work. Filter by board or text, and choose whether backlog and completed cards are visible.

Use it when you want a single high-level view instead of opening boards one at a time. A channel with an orchestrator can receive a local board automatically; other boards can be included with the board’s **Add to Superkanban** action.

### Create work items

Right-click a channel message and choose **Add to kanban**, or open the channel’s project tools and choose **New work item**.

A work item records the task title, brief, channel/source, status, assignee or lease, repository, workspace mode, branch, runs, review evidence, and pull request information.

Use work items when a chat message needs a durable lifecycle rather than remaining only as conversation.

### Use isolated Git workspaces

Set a channel’s **Project folder**, then open the project tools. In the desktop app you can:

1. create a work item;
2. create a new isolated workspace/worktree;
3. bind the workspace to the work item;
4. use the workspace for agent or human changes;
5. inspect branch, commits, dirty files, and unpushed work;
6. review the diff;
7. open a pull request, optionally as a draft;
8. mark the work item done when the result is accepted.

Isolation is valuable when multiple agents or people might touch the same repository. It reduces accidental cross-task edits and gives reviewers a concrete branch and base commit.

The worktree and pull-request controls are desktop features. The panel will say **Desktop only** when the required Electron bridge is unavailable.

### Review agent changes

A completed task can expose a review panel showing changed files and textual diffs. Add snapshot-bound comments or request changes. A change request records review feedback; it does not automatically push, merge, or dispatch more work.

## Search, updates, sessions, and activity

### Search

- `Cmd/Ctrl+P` opens **Open anything**, which searches note titles and tags and can create a new note from an unmatched query.
- `Cmd/Ctrl+Shift+F` opens workspace search, which searches notes and chats using server-side ranked search.

Use the command palette for navigation and quick note creation. Use workspace search when you remember content but not the document or channel where it lives.

### Updates

Open **Updates** from the toolbar to see new activity across vaults and conversations:

- mentions;
- replies;
- note changes;
- channel posts;
- unread counts grouped by vault.

Open an item to jump to its note or message, or choose **Mark all read**. This is the best place to recover context after being away.

### Orbit and sessions

**Orbit** shows running agents at a glance. **Sessions** is the operational view: inspect active runs, model, elapsed time, and detailed output, and cancel a run when necessary.

Use Sessions when an agent appears stuck, when you need to distinguish queued work from running work, or when the chat transcript is intentionally keeping the final answer compact.

## Account and device settings

Open account settings from the user/profile control.

- **Profile** — change display name and avatar. The login handle remains stable because it is used for mentions, invitations, ownership, and history.
- **Preferences** — show or hide agent-memory folders and their updates.
- **Security** — change the account password.
- **Local Codex** — on supported Android builds, authenticate the bundled Codex runtime and optionally switch execution to the phone while Fizzer is open.
- **Current vault** — manage members, roles, invitations, public discovery, join requests, reports, bans, and leaving the vault.

Provider credentials normally remain in the provider’s native local CLI store. Do not put API keys in `.env` committed to the repository or in ordinary notes.

## Useful shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+P` | Open anything / find notes or create a note |
| `Cmd/Ctrl+S` | Search notes and chats |
| `Cmd/Ctrl+Shift+F` | Search notes and chats |
| `Cmd/Ctrl+\\` | Toggle the main sidebar |
| `Cmd/Ctrl+N` | Create a note |
| `Cmd/Ctrl+Shift+S` | Save the active note |
| `Cmd/Ctrl+W` | Close the active tab |
| `Cmd/Ctrl+Alt+\\` or `Cmd/Ctrl+Shift+\\` | Split the focused pane |
| `Cmd/Ctrl+Enter` in an `{{ai: ...}}` directive | Run the directive |
| `Enter` in chat | Send a message |
| `Shift+Enter` in chat | Insert a newline |
| `Escape` | Close the active popup or modal |

On macOS, use `Cmd`; on Windows and Linux, use `Ctrl`.

## Practical recipes

### Turn a discussion into executable work

1. Discuss the goal in a channel.
2. Reply to or forward the key decision so it is easy to find.
3. Right-click the message and choose **Add to kanban**.
4. Set the project folder in channel settings.
5. Create or bind an isolated workspace.
6. Mention an agent with explicit acceptance criteria.
7. Watch the run in Sessions or Orbit.
8. Review the diff and request changes if needed.
9. Open a draft pull request and finish the work item after approval.

### Build a reusable project knowledge base

1. Create a vault for the project.
2. Add folders such as `Overview`, `Decisions`, `Research`, and `Runbooks`.
3. Put durable facts and decisions in notes, not only chat.
4. Link related notes with `[[wikilinks]]`.
5. Keep current tasks in a Markdown Kanban board.
6. Use a channel for discussion and agent requests.
7. Publish only the notes that are intentionally public.

### Collaborate safely with an agent

1. Install and authenticate the agent CLI on the owner’s desktop.
2. Add the agent to a channel.
3. Set its project folder to the intended repository.
4. Leave Full host access disabled unless the task truly requires it.
5. Put secrets or human-only context in `:::private` blocks.
6. Ask for a small verifiable task first.
7. Inspect the run trace, changed files, and branch before accepting the result.

### Recover after being away

1. Open Updates and mark or open the relevant activity.
2. Use workspace search for the project name or a decision phrase.
3. Open the channel’s Missions history.
4. Check Superkanban for blocked or in-review cards.
5. Open Sessions if an agent is still running.

## Fizzer guide and product feedback

The floating **Ask the Fizzer guide** button opens a help assistant that answers from this manual through the local Codex runner. The guide conversation is kept in the open app session; it is not a normal vault channel or a durable project record.

The assistant cannot answer while the local runner is offline. Product feedback is separate: choose **Feedback**, review the privacy notice, and explicitly send your message. Only the feedback text and your username go to the Fizzer server owner. The guide conversation, notes, chats, files, traces, and attachments are not included.

This feedback action is for product bugs and usability suggestions. Use the normal **Report** action for trust-and-safety reports about a vault, note, message, or member.

## Boundaries and troubleshooting

- **Notes/chat work but agents do not start:** open the desktop app or reconnect the compatible runner; verify the provider CLI is installed and authenticated on that machine.
- **A note looks edited but is still marked dirty:** save it with `Cmd/Ctrl+Shift+S` or the mobile Save button.
- **A board is empty:** open the note’s Kanban view and choose **Create board**, or ensure the Markdown has the expected Kanban frontmatter and `##` list headings.
- **A worktree action says Desktop only:** use the Electron desktop app; the browser client cannot access local Git worktrees.
- **An agent cannot see a private block:** this is intentional; private blocks are redacted before agent context is assembled.
- **A public vault cannot be joined:** its policy may be Request or Invite only, or the owner may need to approve the request.
- **The app shows stale activity:** refresh the relevant modal or reopen the channel; realtime state is server-authoritative and updates are persisted.

## Glossary

- **Vault:** project/community workspace and permission boundary.
- **Note:** durable Markdown document.
- **Channel:** persistent group conversation inside a vault.
- **Agent registration:** a configured local provider identity attached to a channel/vault.
- **Runner:** the desktop process that starts the local agent CLI.
- **Mission:** durable multi-step work record projected into chat.
- **Work item:** addressable task record with status, repository, workspace, and review state.
- **Workspace/worktree:** local Git checkout used for an isolated task.
- **Superkanban:** vault-wide board overview.
- **Private block:** `:::private` content hidden from agents and public/search/model-derived surfaces.
- **Public snapshot:** published copy of a note that can be opened without vault membership.
