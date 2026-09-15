# Projects, areas, and missions refactor

**Status:** Agreed product direction; interactive UI proof of concept ready for hands-on review and iteration. Backend implementation planning follows Fred's explicit UI/UX approval.

This living brief describes the current project and area model. [Missions overhaul](missions-overhaul.md) describes the mission workflow in detail. Keep both documents current and consistent as product decisions change.

## Delivery order

1. Save the agreed product model and decisions in this brief.
2. Build interactive mock UIs within Fizzer's existing web UI. Reuse its visual language and existing components. Explore what people can see, edit, navigate, and act on using explicit sample data and in-memory interactions.
3. Exercise the real UI and iterate with Fred. The prototype is ready for feedback, not a deployed or backend-complete feature.
4. Only after Fred explicitly approves the product UI/UX, derive the backend implementation plan needed to make the agreed experience real. Implementation-plan approval precedes real implementation.

Do not turn prototype state shapes into a prematurely committed backend schema. Do not change the backend, migrate vault data, launch real agent work, or claim simulated activity is real. Leave unrelated terminal UI work untouched.

## Product purpose

Fizzer supports people and agents collaboratively defining a product and carrying work through to delivery. Group product discovery is a core, ongoing workflow, not merely an onboarding step. The execution dashboard is also essential; it must coexist with accessible product conversations and documentation.

Keep the system easy to use. Do not add approval queues for ordinary note edits, elaborate scope-management machinery, separate verification agents, or mandatory missions for small work.

## Vocabulary and relationships

- **Project:** The existing vault renamed as the user-facing product concept. It contains people, product notes, channels, areas, missions, tasks, and activity. This is not a mechanical rename of compatibility identifiers or an additional container above a vault.
- **Area:** A persistent, indexed collection of product context for an effort such as **Beta test**. Feedback is part of that effort, not necessarily its own area. An area can exist before there is an immediate task and preserve understanding across many missions and tasks.
- **Area index:** Identifies the product-context files relevant to the area, including links to existing notes. The PM uses it to select what to load into its context. Do not require duplicate copies of shared product notes or a fixed document template.
- **Standalone task:** A bounded human or single-agent piece of work. A small coding request is just a prompt, not a mission-planning workflow.
- **Mission:** A goal or body of work requiring agent orchestration because it is too large for one agent's context window. It contains tasks; it is not subordinate to a task. Several steps alone do not require a mission.
- **Delivery conditions:** The mission's checklist of what must be confirmed working before it is complete, including both agent-verifiable and human-verifiable items.

Example:

```text
Project: Fizzer
└── Area: Beta test
    ├── Product context and its index
    │   ├── Goals, participants, and features being tested
    │   ├── Relevant database references and beta setup
    │   ├── Feedback and findings
    │   └── Links to feature/product notes
    ├── Standalone task: Check this week's customer feedback
    └── Mission: Prepare the first beta round
        ├── Task: Configure participant access
        └── Task: Verify the onboarding flow
```

The distinction is durable context versus work versus orchestration. Amp's orbs are resumable remote agent environments, not this product-context abstraction. Cursor Projects provide useful inspiration for long-lived shared context that outlives individual tasks; neither product dictates Fizzer's implementation or naming.

## Two management roles, not three

### Project manager: product responsibility

There is one shared project-level PM, not a separate area-manager agent. The same PM works across areas by using their indexes to select relevant product notes.

The PM:

- Participates in group product-definition conversations and interviews.
- Understands intended user behavior and why it matters.
- Maintains product notes as decisions and understanding develop.
- Identifies and proposes work proactively.
- Proposes **areas together with the context files they would contain or reference**, rather than silently creating areas.
- Creates missions describing intended behavior, expected outcomes, rationale, and delivery conditions.
- Assigns priorities across areas and says what should be done next.
- Can assign human work, as can humans.

The PM's context is product documentation in Fizzer. Code and engineering documentation stay in the codebase and are read by technical orchestrators and agents. Technical findings can inform the product notes without copying the engineering documentation into Fizzer.

### Coding orchestrator: mission responsibility

“Mission manager” and “coding orchestrator” name the same role, not two additional layers.

The coding orchestrator:

- Takes an approved mission and its delivery conditions.
- Commissions planning agents to investigate and develop an implementation plan.
- Evaluates that plan and accepts it when the described technical work should deliver the mission's conditions.
- Presents the plan to humans for review and approval.
- Only after approval dispatches implementation sub-agents and coordinates execution.

Humans discuss technical planning and execution directly with the coding orchestrator in the mission conversation. The PM is not a relay for technical conversations.

## Mission flow and approvals

1. PM defines the mission: intended behavior, why, expected outcome, and delivery checklist.
2. A human approves the mission. Product definition precedes the implementation plan.
3. Coding orchestrator commissions planning agents and judges the resulting plan technically credible.
4. A human reviews and approves the implementation plan. **This human approval is plan verification.** Do not add a separate verification agent or verification workflow.
5. Coding orchestrator dispatches implementation sub-agents to carry out the approved plan.
6. Agent and human delivery checks are satisfied before the mission is considered complete.

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

## Existing channels are the conversation surface

Reuse existing channels. Group chats, interviews, and product discussions are channel conversations, not a new parallel conversation type.

PM involvement is configurable:

- **Live:** PM follows the conversation as it happens; its conversational participation can be configured.
- **Catch-up:** Humans converse first. After a quiet period (15 minutes was an example, not a hard requirement), new messages are sent to the PM so it can update product context and notes and identify resulting work.

“Unread” in catch-up means messages the PM has not processed, independent of human read/unread state. PM loads the relevant product files through the area's index.

The PM may catch up when its runner reconnects. Always-on infrastructure is not required. Closing a project view need not stop a connected runner; offline work waits until the runner is available.

## Project and mission views

The project view is the main entry into ongoing work, with access to:

- Execution overview: Kanban or an equivalent presentation of tasks, priorities, assignees, due dates, and mission progress.
- Current work across all people, with a personal filter available on the expanded Kanban.
- Changes since the person's last visit, including note diffs.
- Areas, their context indexes, and editable product notes.
- Existing channels and ongoing group conversations with the PM.
- **An explicit button to open a mission view.**

In the mission view, humans can review mission intent and delivery conditions, inspect and approve the implementation plan, follow execution, and talk directly to the coding orchestrator.

The default workspace shows a **Current tasks** column on the left, containing everyone's in-progress work—not only work assigned to the current person. Project chat and **Since your last look** updates occupy the remaining space. Keep the header compact and use the available workspace rather than oversized introductions or empty panels.

Expanding the Kanban horizontally reveals **To do / In progress / Done** and the **My work / All work** filter. The wider board compresses the secondary panels; updates can fold while chat remains available. Returning to Current tasks restores the all-people view.

Missions appear as expandable Kanban cards with their tasks inside. Standalone tasks remain separate cards, and task details can expand in place. Drag-and-drop replaces status dropdowns and Done controls on cards. Mission progress still respects the two approvals and delivery checks; dragging does not silently bypass them.

Product conversation is embedded in the main workspace, not hidden behind navigation. Resizing the board and moving work should preserve the message being composed. Exact proportions remain subject to Fred's hands-on UX review.

### Navigation and content hierarchy

The sidebar starts with **Overview**, immediately followed by the main project channel, **Notes**, and **Changes**. Below these, each expandable area contains its own product channels and missions. Channels and missions are not separate project-wide sidebar categories.

**Notes** is a dedicated space for finding, creating, reading, and editing project and area product notes. Search covers note content; area filtering keeps the library manageable. Area pages link to relevant notes and their context index without reproducing entire documents. Reading and editing use the same note canvas rather than two stacked copies.

An area opens on a short purpose statement, human work needing attention, mission progress, relevant product notes, and recent conversation. Editing area details is an explicit action. A proposed area uses a status and an acceptance action, not a large instructional proposal panel.

The existing-product preview should feel like an ongoing project: concrete conversations and decisions, dated human work, agent assignments, several mission stages, and meaningful before/after note changes. Keep prototype disclosure in the shell and forced agent transitions in compact preview controls. Do not fill ordinary product surfaces with explanations of the mock.


## Starting projects

### Greenfield

Several humans can start by talking with the PM in a channel. A repository, finished spec, or configured coding team is not a prerequisite for defining the product. PM conducts interviews, maintains notes, proposes areas and context files, and eventually identifies missions and tasks.

### Existing product

Support assisted setup: research agents investigate the existing app and codebase, and PM turns their findings into product-facing notes and proposed areas that humans refine. PM does not inspect code itself; engineering documentation remains in the repository.

These are equally important entry paths into the same ongoing product workflow.

## UI proof-of-concept coverage

Use the real application's styling and components with explicitly simulated, in-memory data. Provide a repeatable preview and make reset/reload behavior clear. Do not connect mock UI actions to production mutations or real agent dispatch.

The prototype should let Fred evaluate:

- Project-first navigation with area-owned channels and missions, a dedicated Notes space, and several distinct dashboard information hierarchies.
- The all-people Current tasks default, horizontal board expansion, and the expanded board's personal-work filter.
- Expandable mission cards containing task cards, standalone tasks beside them, and drag-based task movement without status controls on cards.
- Editing due dates, assignees, and priorities, and completing shared tasks without bypassing mission approvals.
- Main-page project chat alongside recent changes, including draft preservation while changing the work view.
- Proposed areas with proposed context files, accepting an area, and opening its index.
- Searching and creating project/area notes, reading or editing one document canvas, and inspecting actual before/after diffs.
- Existing channel-style group conversations, live/catch-up settings, and visibly simulated PM catch-up/offline behavior.
- Opening a mission from the project; editing its definition and plan; exercising both human approval steps and the human/agent delivery checklist.
- Direct mission conversation with the coding orchestrator, distinct from product discussion with PM.
- Greenfield product discussion and an existing-product example.

Mock conversations, planning, catch-up, execution, and approvals demonstrate interactions only. No AI reasoning, runner work, persistence, multiplayer synchronization, or backend behavior is implied by a clickable prototype.

### Running the current preview

The prototype extends the existing `docs/missions-overhaul-prototype.html` entry point. From the repository root:

```sh
python3 -m http.server 5175 --bind 127.0.0.1 --directory docs
```

Open [the project overview](http://127.0.0.1:5175/missions-overhaul-prototype.html?variant=A) or [Beta test](http://127.0.0.1:5175/missions-overhaul-prototype.html?variant=A&view=area&id=beta). The bottom arrows switch between the work board, people/dates, and area overview layouts. Each uses the same local project state.

The example uses Fred, Tyler, and Diego, with active Beta test and Public launch areas, a proposed Partner pilot, product discussions and notes, and missions at different approval/execution stages. Reload or Reset restores the example; the person selector lets reviewers inspect shared human work. The preview is not deployed, persistent, or connected to agents. Fred owns the hands-on visual and UX review.

## Reference research

- Amp [Orbs overview](https://ampcode.com/docs/orbs) and [Orbs, Explained](https://ampcode.com/notes/orbs-explained).
- Cursor [Introducing Projects](https://cursor.com/blog/projects) and [Projects release notes](https://cursor.com/changelog/projects).

## Review outcome

**UI/UX approval: pending Fred's hands-on review.**

Backend implementation planning and real implementation remain deferred. Record the accepted UI choices and any changed product decisions here as review progresses; then remove losing prototype variants and replace simulated behavior through the separately approved implementation work.
