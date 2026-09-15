# Missions overhaul

**Status:** Product model being refined through an interactive UI prototype. Backend implementation planning follows Fred's explicit UI/UX approval.

Missions organize scoped product work within Fizzer's [projects and areas model](projects-areas-refactor.md). This is a living description of the intended product, not a claim that the current runtime implements it.

## Purpose

A mission is a scoped body of work with its own collaboratively maintained brief and chat. It records intended change, rationale, scope, progress, and delivery conditions, referencing product knowledge in its owning area. It can coordinate work too large for a single agent's context window, but its brief is not an execution prompt. The PM's instructions to the coding orchestrator live in a separate area-owned dispatch artifact.

A mission is not a permanent collection of product knowledge and is not required merely because a task has several steps. Durable product knowledge belongs in short area notes linked from an overview/index. Missions obtain that context through references, not duplicated documentation. Small human tasks can stand alone; a bounded coding request is simply a prompt to an agent.

## Relationships

- A project is the topmost level and has its own editable note and chat. The example project is **Fizzer**; project remains the user-facing name for a vault.
- An area is the middle level, with an overview/index, short supporting product notes, and a group chat. The index links documentation instead of containing every topic.
- The **Project Interface** area links the **Mission refactor** and **Create the project agent** mission briefs, each with its own chat. The project agent is not the area's name.
- An area can contain multiple missions and standalone tasks. A mission contains its tasks; it is not subordinate to a task. A mission task opens in the right-hand artifact pane with floating task chat, leaving the mission document centered.
- Product documentation lives in Fizzer. Code and engineering documentation live in the codebase.
- Product notes are the shared definition from which tasks and missions emerge. Conversations refine those notes; a board is not a substitute for the product context.
- A dispatch is an area-owned artifact containing the PM's prompt for the coding orchestrator. It uses the product documentation as input without replacing or reclassifying that documentation.

## Roles

### Project manager: define the product outcome

One shared project agent in the PM role works across project, area, mission, and task chats. It can read new messages across those rooms, load relevant notes and references, and choose where to reply. There is no separate area-manager agent; a mission's own conversation does not isolate its context from the project agent.

The PM discusses the product with humans in those shared rooms, helps the group scope and brainstorm, maintains product documentation, identifies work, assigns priorities, and creates mission documents describing:

- What the product should do from the user's point of view.
- Why the change matters and what outcome it should deliver.
- What must be confirmed working before the mission is complete.

The PM owns product understanding, not technical execution. It creates a separate dispatch artifact with the instructions for the coding orchestrator when work is ready for planning. It does not inspect the codebase or act as a relay for implementation discussions.

### Coding orchestrator: plan and coordinate execution

“Mission manager” and “coding orchestrator” are the same role.

The coding orchestrator receives the PM's dispatch prompt and referenced product documentation. It commissions planning agents to investigate the codebase and develop an implementation plan, then evaluates their proposed technical work against the mission's delivery conditions. Receiving a dispatch does not authorize immediate implementation.

It accepts the plan when it believes the plan will deliver those conditions, then presents it to humans for approval. Only after human approval does it dispatch implementation sub-agents and coordinate their work.

The coding orchestrator and technical agents use the relevant product requirements together with code and engineering documentation in the repository. Technical findings can be reported to the PM so their product implications are captured in Fizzer's notes without duplicating engineering documentation.

## Mission workflow

### Define the mission

Product definition comes before implementation planning. The PM helps humans scope the work, ideate, brainstorm alternatives, and describe the intended change, rationale, outcomes, and delivery conditions in the mission brief. Durable product behavior belongs in the area's topic notes; the mission references those notes and has its own discussion.

This can emerge from an area conversation, a group interview, proactive review of project context, or a human request. The room builds shared understanding before treating a choice as settled; the first reply is not automatically the group's conclusion. Unresolved choices remain in the note. Prototyping can follow that discovery as a step within the mission, not a replacement for its larger goal.

### Approve the product-level mission

Humans approve what is to be delivered. This is the first human approval stage and permits implementation planning, not implementation. In the current Mission refactor example, Fred, Diego, and Tyler each need to explicitly say the UX is ready.

### Prepare the dispatch

The PM creates a separate area-owned dispatch artifact containing the coding orchestrator's prompt and references to the product requirements. The area and mission notes remain product documentation for the PM. A draft dispatch can be reviewed while the product definition is being refined; the draft is not evidence that work has been sent or that agreement has been reached.

### Develop the implementation plan

The coding orchestrator commissions planning agents. It judges whether their plan describes technical work that should satisfy the mission's delivery conditions and brings a credible plan to the humans.

The orchestrator's technical judgment belongs to preparing the plan. It is not a third human approval or a separate verification workflow.

### Approve the implementation plan

A human reviews and approves the plan. **This human review and approval is plan verification.** There is no separate plan-verification agent.

This is the second human approval. Implementation sub-agents are dispatched only after it.

### Execute and confirm delivery

The coding orchestrator dispatches implementation sub-agents, coordinates their tasks, and gathers results against the delivery conditions.

Some conditions can be checked by agents through their validation tools. Others require humans to run flows, try the UI, and judge aspects of the experience agents cannot reliably assess. Agent success is not a substitute for a required human check.

The mission is complete when its delivery conditions have been satisfied.

## Human work is first-class

Writing specs, approving mission definitions, reviewing implementation plans, dispatching work, and performing human acceptance checks are actual tasks. They appear on the project's Kanban with status, named assignees, and due dates rather than existing only as buttons inside the mission.

- PM sets priorities and identifies what should happen next.
- Humans set delivery dates.
- PM and humans can both assign human work.
- A human task can be assigned to one person or several specific people.
- Any one assignee can complete a shared task; everyone need not sign off.
- Coding orchestrator assigns implementation work to coding sub-agents.

Keep small standalone tasks lightweight. Do not force them through mission creation, planning, or the two-approval workflow.

## Mission documents and conversations

The hierarchy is **Fizzer project index → Project Interface area index and product notes → mission briefs → task artifacts**. Initial opening shows the existing Project Interface index. Mission links open their brief on the left and chat on the right. Mission task links keep that mission centered and open an editable task artifact with floating task chat. The sidebar keeps the expanded area/mission/supporting-note list visible. Its indexes precede slightly indented notes; notes are muted yellow, missions muted red, and tasks muted blue, with distinct icons. Only a mission's task/artifact rows depend on that mission being centered. Opening a task no longer removes that mission's rows.

**Mission refactor** describes adapting the previous app's missions to the new project interface. It preserves useful orchestration, approvals, tasks, and delivery checks while providing a collaboratively maintained product document and scoped discussion rather than only a channel or an embedded card.

This example is already at **UI refinement**. Fred, Diego, and Tyler each have a separate obligation to explicitly say the UX is ready. All three sign-offs are required before moving to implementation planning. Feedback, agent validation, or one person's approval is not everybody's sign-off. These are stage-specific readiness checks, not a third universal mission-authorization step. Passing them does not complete the overall refactor.

The sibling **Create the project agent** mission is earlier: the group is scoping and ideating what it wants in that mission's chat, assisted by the project agent. Prototyping comes next after shared scope is established; implementation and delivery come later. It must not appear already at the refactor's UX gate, and its name and scope must not shrink to “Prototype the project agent.”

Intended change, rationale, progress, and delivery checklist are contents of the mission brief, not separate form fields or an inline workflow card. Shared product knowledge stays in the area's short topic notes. Creating a mission establishes its brief and chat and links it from the area. Markdown is always editable, with uniform font size, weight, and line height. There is no Edit note button, separate rendered preview, or decorative document card.

Checklists remain ordinary `[ ]` and `[x]` text. Manual editing is sufficient; existing direct-click convenience may remain without further checkbox machinery or a permission/approval mechanism.

Mission briefs link area product notes, task artifacts, prototypes, and review artifacts through literal `[[name]]` links. Resolution and typing suggestions stay among local siblings and children; `[[container - child]]` descends through a named container without searching unrelated descendants globally. Clicking opens the target, dragging selects text, and keyboard navigation can edit inside the brackets. Links remain ordinary copied, cut, or deleted text. Human review obligations belong in the brief and linked tasks, not a duplicate Mission refactor card beneath it.

The coding orchestrator's instructions belong in the separate dispatch artifact. Humans can speak directly to technical agents in the relevant scoped conversation without routing implementation discussion through the PM. Agents can follow messages across rooms rather than being pinned to whichever mission is selected.

The project work view remains available through **Note / Project**. Its Kanban shows expandable mission cards containing tasks and separate standalone task cards. Task details expand in place; dragging replaces Done buttons and status dropdowns on cards. The mission's approvals and delivery conditions remain authoritative.

## Notes and collaboration

People and agents maintain durable product knowledge in short area notes and change-specific work in mission/task documents. A compact **Notes** picker at the chat header opens an index-first document list. Selecting a note changes the reading document without changing the conversation; missions can consult their area's product notes there. PM edits take effect immediately, with actual before/after diffs showing author and time. The small History control opens only the current note's history in place. Global Changes remains separate. The sidebar keeps the full project list available; only mission-owned task/artifact rows depend on their mission being centered.

PM actions such as assigning a review are visually distinct from ordinary messages. The assignment connects a named human task to the required mission delivery condition and to the note that defines it. The demo's launch-language review belongs to Diego; the mission cannot treat that required review as satisfied merely because agent work finished.

The prototype shows fictional group discussions, different current mission stages, and linked project/area/mission events to illustrate agent cross-chat awareness. A scripted update changes the intended mission document, preserving other notes and leaving unresolved human readiness checks unresolved. Actual multiplayer editing and agent-driven updates remain outside this UI prototype.

Mission documents link task artifacts, prototypes, images, and review notes. Opening one keeps its mission document on the left and uses the right pane for the artifact. Mission tasks retain their own task conversation in the floating messaging UI; ordinary prototypes, images, and leaf-note artifacts use the parent's conversation. Closing a task artifact returns to the mission chat without changing the centered mission. The separate dispatch artifact belongs to the area and uses its area chat. It remains a draft, planning-first prompt, not product documentation or actual agent work. See [leaf artifacts and floating chat](projects-areas-refactor.md#leaf-artifacts-and-floating-chat) for collapsed chat, transient messages, and expanded history/composer behavior.

Do not add note-approval queues, elaborate scope-management machinery, or an additional documentation-review workflow. Reuse normal collaborative editing behavior rather than making routine changes cumbersome.

Area context remains available across missions. Mission results inform that context; completing a mission does not discard the area's product understanding.

## Availability

PM participation across scoped chats is configurable: live participation or catch-up after a quiet period. New messages from each room are available to the agent, which chooses where a reply is useful. Catch-up tracks messages it has not processed, independently of human read state, and updates relevant notes.

An offline PM can catch up when its runner reconnects. Always-on hosted infrastructure is not a prerequisite for the product workflow.

## Current delivery plan

1. Maintain this mission brief and the projects/areas brief as consistent living documents.
2. Iterate only the selected note-and-chat version in `docs/missions-overhaul-prototype.html`, using Fizzer's real UI language and explicit in-memory example data. Do not build alternative layouts or parallel prototypes. See the [preview instructions](projects-areas-refactor.md#running-the-current-preview).
3. Present the selected shared-note/artifact interaction and illustrative mission stages for Fred's visual and UX review. Do not build behavioral test suites or production authorization enforcement for this prototype.
4. Iterate until Fred explicitly approves the product UI/UX.
5. Then derive the backend implementation plan from the accepted interactions and information requirements. Real implementation follows approval of that plan.

Mock planning, agent messages, approvals, and execution are demonstrations of interaction, not real agent dispatch or persistence. Do not change backend behavior, migrate data, or touch unrelated terminal UI work during this prototype.

For real implementation, evolve one mission system rather than introducing a parallel legacy runtime. Preserve existing user records and evidence; determine the necessary migration and caller changes during implementation planning, after UI approval. Do not mechanically rename compatibility identifiers or expand into unrelated hosting and permission changes.

## UI review checklist

- A person can identify the project and area indexes, area product notes, mission briefs, and task artifacts. Mission tasks retain their own floating conversations without replacing the centered mission.
- Mission refactor explains the change from the existing app and is visibly at UI refinement, while Create the project agent remains at group scoping and ideation.
- Fred, Diego, and Tyler each explicitly sign off UX readiness before the refactor proceeds to implementation planning; the sibling has not reached that gate.
- Prototyping is a step within a mission, not automatically the mission's entire goal.
- The first human approval concerns the mission; the second concerns its implementation plan.
- Planning agents and implementation sub-agents have visibly different purposes and timing.
- There is no separate plan-verification agent or third human approval.
- Mission progress includes remaining human work, not only coding-agent activity.
- Human tasks have assignees and delivery dates; one assignee can complete shared work.
- A mission opens its own document/chat workspace; a mission task opens in the right artifact pane while that mission stays centered.
- Areas, missions, and ordinary notes remain expanded, with indexes first and slightly nested supporting notes. Mission task/artifact rows remain visible while a task is being read beside its centered mission.
- Area notes hold shared product knowledge; mission briefs reference it and record their own work. The coding orchestrator's planning-first prompt remains a separate area-owned dispatch artifact.
- Humans can speak directly to technical agents in scoped chats without routing technical discussion through the PM.
- The note has no redundant inline mission card, and its History control shows only that note's changes without navigating away.
- The Notes picker changes the reading document without changing the conversation. Scoped bracket links and completion follow local names and explicit spaced-hyphen child paths.
- Agents demonstrate awareness across rooms; group discovery is not reduced to a single-person interview.
- Product context remains accessible and note changes are visible from the project.
- Prototype actions are clearly simulated and cannot mutate real project data or dispatch agents.

**UI/UX approval remains pending Fred's hands-on review.**
