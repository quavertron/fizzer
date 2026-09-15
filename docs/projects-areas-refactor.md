# Projects, areas, and missions refactor

**Status:** Product model being refined through an interactive UI prototype. Backend implementation planning follows Fred's explicit UI/UX approval.

This living brief describes the current project and area model. [Missions overhaul](missions-overhaul.md) describes the mission workflow in detail. Keep both documents current and consistent as product decisions change.

## Delivery order

1. Save the agreed product model and decisions in this brief.
2. Iterate the selected note-and-chat prototype within Fizzer's existing web UI, using its visual language and explicit in-memory sample data. Work on this one design, not alternative layouts or parallel versions.
3. Exercise the real UI and iterate with Fred. The prototype is ready for feedback, not a deployed or backend-complete feature.
4. Only after Fred explicitly approves the product UI/UX, derive the backend implementation plan needed to make the agreed experience real. Implementation-plan approval precedes real implementation.

Do not turn prototype state shapes into a prematurely committed backend schema. Do not change the backend, migrate vault data, launch real agent work, or claim simulated activity is real. Leave unrelated terminal UI work untouched.

## Product purpose

Fizzer supports people and agents collaboratively defining a product and carrying work through to delivery. Group product discovery is a core, ongoing workflow, not merely an onboarding step. The execution dashboard is also essential; it must coexist with accessible product conversations and documentation.

Keep the system easy to use. Do not add approval queues for ordinary note edits, elaborate scope-management machinery, separate verification agents, or mandatory missions for small work.

## Vocabulary and relationships

- **Project:** The topmost level, represented by a collaboratively editable project note with its own chat. The example project is **Fizzer**. It contains areas and their work. This remains the user-facing name for the existing vault, not an additional container above a vault or a mechanical rename of compatibility identifiers.
- **Area:** The middle level: durable product knowledge lives here, in an overview/index and short supporting notes, with a group chat. It links missions and standalone tasks and preserves understanding across missions. **Project Interface** is the example feature area; the project agent is one mission within it, not the area's name.
- **Area index:** The entry document links supporting product documentation instead of containing all of it. Split topics into notes roughly one or two pages long. Missions obtain relevant knowledge from these area notes rather than copying it.
- **Task:** A bounded human or single-agent piece of work with its own document and conversation. A mission task opens as a right-hand artifact with floating task chat, keeping its mission centered on the left. Standalone tasks remain lightweight; a small coding request does not require a mission-planning workflow.
- **Mission:** A scoped body of work with its own change-specific brief and chat, linked from the owning area. Its documentation records intended change, rationale, scope, progress, and delivery conditions, referring to shared product knowledge in the area. It is not the coding orchestrator's execution prompt. Several steps alone do not require a mission.
- **Delivery conditions:** The mission's checklist of what must be confirmed working before it is complete, including both agent-verifiable and human-verifiable items.
- **Leaf artifact:** A prototype, image, or leaf-note document that has no notes beneath it. Images and prototypes are not text notes, but share the same leaf behavior. They are linked from a parent note and open beside it rather than replacing it.
- **Dispatch:** A separate area-owned artifact created by the PM containing the prompt/instructions for the coding orchestrator. It refers to product documentation as input; it does not turn the area or mission note into an execution prompt. The orchestrator proposes an implementation plan before implementation.

Example:

```text
Project note: Fizzer                         + project chat
├── Area note: Project Interface             + area group chat
│   ├── Mission note: Mission refactor       + mission chat
│   │   ├── Current step: UI refinement
│   │   └── Human review task documents      + floating task chat, right-hand artifact
│   ├── Mission note: Create the project agent + mission chat
│   │   ├── Current step: group scoping and ideation
│   │   └── Later: prototype, refine, implement, and confirm delivery
│   └── Dispatch artifact: PM's coding-orchestrator prompt
├── Area note: Beta test                     + area group chat
└── Area note: Public launch                 + area group chat
```

The distinction is durable context versus work versus orchestration. Amp's orbs are resumable remote agent environments, not this product-context abstraction. Cursor Projects provide useful inspiration for long-lived shared context that outlives individual tasks; neither product dictates Fizzer's implementation or naming.

## Two management roles, not three

### Project manager: product responsibility

There is one shared project-level agent in the PM role, not a separate area-manager agent. It works across project, area, mission, and task notes and chats, using their documentation and references for context. These chats are shared rooms, not isolated agent sessions: the project agent can read new messages across them and choose where to reply.

The PM:

- Participates in group product-definition conversations and interviews.
- Understands intended user behavior and why it matters.
- Maintains product notes as decisions and understanding develop.
- Identifies and proposes work proactively.
- Proposes **areas as notes with links to the context they need**, rather than silently creating areas.
- Creates mission product documents describing intended behavior, expected outcomes, rationale, and delivery conditions, linked from their area notes.
- Creates separate area-owned dispatch artifacts with instructions for the coding orchestrator when the product work is ready for implementation planning.
- Assigns priorities across areas and says what should be done next.
- Can assign human work, as can humans.

The interview pattern is shared, room-based product discovery: PM asks focused questions, offers alternatives, incorporates teammates' perspectives, and helps the room reach a conclusion. It must not treat the first reply as the group's decision. Unresolved choices can be recorded in the notes while discussion continues; this is not a new note-approval queue or an additional mission approval.

The PM's context is product documentation in Fizzer. Code and engineering documentation stay in the codebase and are read by technical orchestrators and agents. Technical findings can inform the product notes without copying the engineering documentation into Fizzer.

### Coding orchestrator: mission responsibility

“Mission manager” and “coding orchestrator” name the same role, not two additional layers.

The coding orchestrator:

- Receives the PM's dispatch prompt with the relevant approved product documentation and delivery conditions as inputs.
- Commissions planning agents to investigate and develop an implementation plan.
- Evaluates that plan and accepts it when the described technical work should deliver the mission's conditions.
- Presents the plan to humans for review and approval.
- Only after approval dispatches implementation sub-agents and coordinates execution.

Humans discuss technical planning and execution directly with the coding orchestrator in the relevant scoped chat. Missions have their own conversations; agents can still follow context across rooms. The PM is not a relay for technical conversations.

## Mission flow and approvals

1. PM and humans shape the mission's product document: intended behavior, why, expected outcome, and delivery checklist.
2. Humans approve the product-level direction. In Mission refactor, Fred, Diego, and Tyler each need to say the UX is ready before implementation planning.
3. PM prepares a separate dispatch artifact in the area containing the coding orchestrator's prompt and references to the product documentation.
4. Coding orchestrator commissions planning agents and proposes a technically credible implementation plan, rather than implementing immediately.
5. A human reviews and approves that plan. **This human approval is plan verification.** Do not add a separate verification agent or verification workflow.
6. Coding orchestrator dispatches implementation sub-agents to carry out the approved plan.
7. Agent and human delivery checks are satisfied before the mission is considered complete.

There are two human approvals: the product-level mission and the implementation plan. The orchestrator's technical judgment is part of preparing a credible plan, not a third human approval.

Human checks include trying UI flows and judging aspects of the experience that agents cannot reliably assess. Automated checks do not substitute for those checks.

Small single-agent work can be dispatched directly as a prompt without this mission process.

## Human work, priorities, and dates

Human work is first-class and often the main work people manage on the Kanban:

- Writing and refining specs.
- Reviewing and approving specs or mission definitions.
- Reviewing and approving implementation plans.
- Dispatching work.
- Running human acceptance checks.

These are actual tasks with board status, one or more named human assignees, and due dates—not just hidden approval buttons inside a mission.

- PM sets priorities and recommends next work.
- Humans allocate delivery dates; a due date means delivery by that date, not an invented start-time scheduling system.
- Both PM and humans can assign work.
- Any one assignee can complete a task assigned to several humans. No all-assignees sign-off machinery.
- Coding orchestrator assigns implementation work to its coding sub-agents.

## Notes and visible changes

PM edits to established project notes take effect immediately. People need a project-wide list of actual note diffs showing what changed, who changed it, and when.

No note-approval queue. Do not add elaborate scope fences or a second documentation-review workflow. The UI should make changes easy to understand and review.

### Short notes and local links

The area's overview/index is the starting document. A compact **Notes** button at the chat header's top right opens its available documents, index first. Choosing a supporting note changes what is being read without switching the conversation. A mission can consult its area's product documentation through this picker without duplicating that knowledge in its brief.

Literal `[[name]]` links open notes, missions, tasks, or artifacts by local name. Names resolve among siblings and children of the current document; there is no global name search or duplicate-name chooser. A spaced hyphen descends through named containers: `[[Mission refactor - Review Mission refactor UX]]`. Typing inside brackets offers eligible local names; after `Mission refactor - ` it offers only that mission's children.

Links remain normal text: a click follows the target, while dragging selects text and keyboard navigation can place the cursor inside the brackets. Copying, cutting, replacing, and deleting the text work normally. Completion inserts text, not an embedded object. Notes use muted yellow, missions muted red, and tasks muted blue at comparable perceived brightness, with icons as well as color.

## Existing channels are the conversation surface

Reuse existing channels for project, area, mission, and task chats. Group chats, interviews, and product discussions are channel conversations, not a new parallel conversation type. Projects, areas, and missions open their document and chat together. Mission tasks use their own existing conversation in the floating artifact UI while their mission remains centered. Agents with project access can follow new messages across those chats and reply wherever relevant; selecting a mission does not confine an agent to that room.

PM involvement is configurable:

- **Live:** PM follows the conversation as it happens; its conversational participation can be configured.
- **Catch-up:** Humans converse first. After a quiet period (15 minutes was an example, not a hard requirement), new messages are sent to the PM so it can update product context and notes and identify resulting work.

“Unread” in catch-up means messages the PM has not processed in each chat, independent of human read/unread state. PM loads the relevant product notes and their references. Following multiple rooms does not mean replying to every message.

The PM may catch up when its runner reconnects. Always-on infrastructure is not required. Closing a project view need not stop a connected runner; offline work waits until the runner is available.

## Project and mission views

The main workspace pairs a shared document with its conversation. **Fizzer is a project note; Project Interface opens an area index; Mission refactor and Create the project agent each have their own mission brief and chat.** Supporting product knowledge belongs to the area. Mission tasks open on the right as editable artifacts with floating task conversations, never replacing the centered mission. Product documentation and mission briefs are not executable prompts.

The prototype opens the existing **Project Interface overview/index within Fizzer**, already populated and editable beside the area's chat. It links short product notes, Mission refactor, and Create the project agent. It must not show a “Start” screen when the area exists. Restored selection resolves to a valid document. One compact, clickable hierarchy provides navigation without duplicate tabs, breadcrumb rows, or an “Open Project Interface” button in the note.

### The two example missions

**Mission refactor** adapts the existing app's missions to the new project interface. Its product document and chat define and discuss the change, with linked review tasks and artifacts. Useful orchestration, approvals, tasks, and delivery checks remain part of the intended workflow, while execution instructions live in a separate dispatch artifact.

This mission is already at **UI refinement**. Fred, Diego, and Tyler must each explicitly say the UI/UX is ready before implementation planning proceeds. These are separate reviewer obligations, not one shared task that any assignee can finish. Agent checks, ordinary feedback, or the first person's approval cannot satisfy everybody's readiness gate. Passing that gate permits the next step; it does not complete the mission.

**Create the project agent** is a sibling mission, not a mission called “Prototype the project agent.” It is earlier in its lifecycle: the team is scoping, ideating, and brainstorming what it wants in that mission's chat, with the agent helping the conversation. Prototyping is the next stage after shared scope is established. It has not reached the mission-refactor example's UX-readiness gate. Prototyping, implementation, and delivery belong to the larger mission rather than replacing its goal.

### Shared documents and work

Mission creation establishes a change-specific brief and conversation, linked from the area. Intended change, rationale, progress, and delivery checklist are prose and checklists in that brief, not a second set of form fields. Shared product behavior is documented in the area's topic notes and referenced by the mission. Mission task links open editable documents in the artifact pane while the mission remains centered. Notes are always directly editable; there is no Edit note button or reading/editing mode switch. Chat-driven changes supplement typing without overwriting other scopes' documents.

The note surface is plain Markdown/source text with syntax colors. Markers such as `#`, `**`, list prefixes, and links stay visible. Different patterns use different colors, not larger headings, varying font sizes, rendered bold/italic styles, duplicate titles, or decorative cards. Text uses a uniform font size, weight, and line height. One small history control floats at the note pane's top right and opens only that note's history in place; closing it leaves the note and conversation selected. Global Changes remains a separate navigation destination.

Markdown checklists are ordinary editable text: manually typing `[ ]` or `[x]` is sufficient for this prototype. Any existing direct-click convenience changes the same source and note history; no further checkbox machinery or permission/approval mechanism is needed.

The document is enough: do not append a redundant Mission refactor card, mission workflow panel, or duplicate Brief/Plan form beneath it. Product context and review obligations belong in the note and linked task documents. The PM's planning-first instructions to the coding orchestrator belong in the separate area dispatch artifact, not in the product document.

An explicit, compact **Note / Project** toggle retains the project work view without taking a full-width toolbar band. Project mode initially shows **Current tasks** for all people. Expanding the Kanban horizontally reveals **To do / In progress / Done** and **My work / All work**. Collapsing it restores the all-people view. Mission cards expand to contain their tasks; standalone tasks remain separate. Task dragging does not bypass approvals or delivery checks.

Conversation is integrated into the normal workspace. Switching context preserves drafts. Opening a mission from a note link, navigation, or work card opens its brief on the left and its chat on the right. Opening a mission task instead keeps that mission on the left and opens the task as an artifact on the right, with the task's own floating chat. The Notes picker changes the reading document without switching conversations. Clicking a resolved local `[[name]]` or `[[container - child]]` link follows the same destination behavior while leaving the literal source editable.

Agent actions are distinct from speech and link their effects on assignments, mission conditions, and note content. The launch-language review assigned to Diego remains a secondary example. Mission refactor's discussion illustrates UI refinement; Create the project agent's discussion illustrates earlier group discovery. Project and area chats preserve wider context.

The prototype includes linked events across project, area, and mission conversations to demonstrate cross-chat awareness. Scripted collaboration changes the intended in-memory mission document and history without overwriting other notes or inventing unanimous sign-off. These messages and editing cues are illustrative, not real agents or multiplayer editing.

### Leaf artifacts and floating chat

A parent note stays in the left pane when a linked leaf artifact opens. A prototype, image, or ordinary leaf-note document takes the right pane normally used by that parent's chat and uses the same parent conversation, not a new artifact channel. Mission tasks use this artifact presentation too, but retain their existing task conversations in the floating chat. Mission refactor's tasks and review artifacts keep its mission document centered. Closing a task artifact returns to the mission chat without navigating away. The PM's dispatch belongs to the area, so opening it keeps the area document on the left and uses the area chat.

The illustrative **Mission refactor dispatch** is a draft prompt for the coding orchestrator. It links the product requirements and asks for an implementation plan first. It is deliberately separate from the area and mission documentation, and its presence is not evidence that implementation or real dispatch has begun.

With chat collapsed, the artifact is unobscured. A compact bottom chat/writing control has a small unread count; there is no persistent message history or active writing area. A newly received message can briefly float over the artifact as a bubble, with **Dismiss** and **Reply**. It disappears after a few seconds if ignored. Removing that temporary bubble does not delete its message history.

Clicking the bottom control to write or read history expands floating messages above it and activates the composer. The artifact remains visible underneath, blurred while the expanded conversation has attention. This is not an opaque full-pane chat card or another sidebar. Reply opens the composer; collapse returns attention to the sharp artifact and hides history again.

Expanding chat history clears the displayed unread count. Artifact and conversation changes preserve drafts, and expanding or sending chat does not reset the artifact being reviewed. The visual prototype uses illustrative incoming messages to make the transient-bubble behavior visible; it does not implement real message delivery or read synchronization.

### Navigation and content hierarchy

The sidebar keeps the **full project list visible and expanded**: areas, missions, and ordinary supporting notes stay available regardless of the center document. It is a list, not a drill-down file explorer. The overview/index sits above slightly indented supporting notes, alongside that area's missions and standalone tasks. Only mission-owned task and artifact rows are conditional: show them when that mission's document is centered; otherwise hide them. Opening a mission task leaves the mission centered, so those rows remain visible. Do not duplicate task artifacts or backing notes as ordinary-note rows. Search respects the same visibility rule. Keep **Changes** explicit, without separate channel rows or a redundant global Notes landing page.

Muted yellow notes, red missions, and blue tasks use distinct icons as well as comparable-brightness color. The full list provides direct document access without requiring navigation into containers first. Documents use one always-editable, syntax-colored text surface, including task and leaf-note artifacts on the right. Compact local links retain access without large cards or a secondary context column.

The existing-product preview should feel like ongoing work: concrete discussions, different mission stages, named human obligations, and meaningful before/after changes. Do not restore the prototype banner or relocate its removed controls elsewhere. This brief and the handoff carry the prototype limitations.

## Starting projects

### Greenfield

Several humans can start by talking with the PM in the project's group chat. A repository, finished spec, or configured coding team is not a prerequisite. The conversation establishes the project note, proposed area notes and their context, and eventually mission and task documents with their own discussions. Scoping and ideation precede prototyping; a prototype is a step toward a mission's outcome, not automatically a separate mission.

### Existing product

Support assisted setup: research agents investigate the existing app and codebase, and PM turns their findings into a project note and proposed area notes that humans refine. PM does not inspect code itself; engineering documentation remains in the repository.

These are equally important entry paths into the same ongoing product workflow.

## UI proof-of-concept coverage

Use the real application's styling and components with explicitly simulated, in-memory data. Provide a repeatable preview and make reset/reload behavior clear. Do not connect mock UI actions to production mutations or real agent dispatch.

This iteration is for visual and interaction review of the selected design. Do not add behavioral test suites, production authorization enforcement, or alternate-layout work to this UI prototype. Fred judges whether the experience looks and feels right.

The prototype should let Fred evaluate:

- Fizzer as the top-level index, area indexes and short product notes beneath it, and mission briefs that reference area knowledge. Mission tasks open as right-hand artifacts with their own floating chats.
- The full expanded project list stays visible with slightly nested, color-and-icon-coded notes. Mission task/artifact rows depend on the centered mission; opening a task keeps that mission centered.
- The existing Project Interface note visible and editable immediately, with its page chat and a compact Note / Project toggle.
- Mission refactor already at UI refinement, requiring Fred, Diego, and Tyler to each say the UX is ready before implementation planning.
- Create the project agent as a sibling mission still at group scoping and ideation, with prototyping later rather than a separate mission goal.
- Durable product knowledge in area notes; mission briefs contain change-specific scope, progress, and checks. A separate area-owned dispatch artifact contains the planning-first execution prompt.
- The all-people Current tasks view in Project mode, horizontal board expansion, and the expanded board's personal-work filter.
- Expandable mission cards containing task cards, standalone tasks beside them, and drag-based task movement without status controls on cards.
- Editing due dates, assignees, and priorities, and completing shared tasks without bypassing mission approvals.
- Scoped name/path links and card actions open the correct mission or artifact. The chat-header Notes picker switches reading documents without switching the conversation.
- PM assignment events visually distinct from speech, with linked effects on task ownership, mission acceptance, and shared note content.
- Group conversations showing brainstorming, differing mission stages, and the agent's awareness of new messages across scoped chats.
- Proposed areas represented as editable notes with context links, accepting an area, and opening its document.
- Always-editable, uniformly sized Markdown; muted type colors; literal editable/selectable bracket links with scoped name/path completion; manual `[x]` editing; and note-local History.
- Existing channel-style group conversations, live/catch-up settings, and visibly simulated PM catch-up/offline behavior.
- Mission documentation without a redundant inline mission card, workflow panel, or duplicate definition form.
- A planning-first dispatch artifact distinct from product documentation, with direct technical conversation rather than a PM relay.
- The existing Fizzer scenario in the selected note-and-chat version, without expanding this iteration into other prototype designs.

Mock conversations, planning, catch-up, execution, and approvals demonstrate interactions only. No AI reasoning, runner work, persistence, multiplayer synchronization, or backend behavior is implied by a clickable prototype.

### Running the current preview

The prototype extends the existing `docs/missions-overhaul-prototype.html` entry point. From the repository root:

```sh
python3 -m http.server 5175 --bind 127.0.0.1 --directory docs
```

Open [Project Interface](http://127.0.0.1:5175/missions-overhaul-prototype.html?variant=A). The default is its populated, always-editable area note and page chat within Fizzer. Its links open Mission refactor at UI refinement and Create the project agent at group scoping and ideation, each with its own document and chat. The compact Note / Project toggle and clickable note hierarchy belong to this one design. Existing B/C alternatives are not being developed or separately verified in this iteration.

The example uses Fred, Tyler, and Diego, with secondary Beta test and Public launch work. Reload restores the fixture; edits and discussions are in memory. This is not deployed, persistent, or connected to agents. Fred owns hands-on visual and UX review.

## Reference research

- Amp [Orbs overview](https://ampcode.com/docs/orbs) and [Orbs, Explained](https://ampcode.com/notes/orbs-explained).
- Cursor [Introducing Projects](https://cursor.com/blog/projects) and [Projects release notes](https://cursor.com/changelog/projects).

## Review outcome

**UI/UX approval: pending Fred's hands-on review.**

Backend implementation planning and real implementation remain deferred. Record the accepted UI choices and any changed product decisions here as review progresses; then remove losing prototype variants and replace simulated behavior through the separately approved implementation work.
