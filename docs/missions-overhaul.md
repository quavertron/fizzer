# Missions overhaul

**Status:** Agreed product model; interactive UI proof of concept ready for hands-on review and iteration. Backend implementation planning follows Fred's explicit UI/UX approval.

Missions are the orchestration part of Fizzer's [projects and areas model](projects-areas-refactor.md). This is a living description of the intended product, not a claim that the current runtime implements it.

## Purpose

A mission coordinates work that is too large for a single agent's context window. It gives people a clear product outcome, delivery conditions, an approved implementation plan, and visibility into the agents carrying it out.

A mission is not a permanent collection of topic knowledge and is not required merely because a task has several steps. Persistent product context belongs to the project and its areas. Small human tasks can stand alone; a bounded coding request is simply a prompt to an agent.

## Relationships

- A project is the user-facing name for a vault.
- An area, such as **Beta test**, collects durable product context through an index of relevant notes and references. It can exist without an immediate task and outlive many missions.
- An area can contain missions and standalone tasks.
- A mission contains its execution tasks. Missions are not subordinate to tasks.
- Product documentation lives in Fizzer. Code and engineering documentation live in the codebase.

## Roles

### Project manager: define the product outcome

One shared project manager works across the project's areas, loading the appropriate product-context files through each area's index. There is no separate area-manager agent.

The PM discusses the product with humans in existing channels, maintains product notes, identifies work, assigns priorities, and creates missions describing:

- What the product should do from the user's point of view.
- Why the change matters and what outcome it should deliver.
- What must be confirmed working before the mission is complete.

The PM owns product understanding, not technical execution. It does not inspect the codebase or act as a relay for implementation discussions.

### Coding orchestrator: plan and coordinate execution

“Mission manager” and “coding orchestrator” are the same role.

The coding orchestrator receives an approved mission, commissions planning agents to investigate the codebase and develop an implementation plan, and evaluates their proposed technical work against the mission's delivery conditions.

It accepts the plan when it believes the plan will deliver those conditions, then presents it to humans for approval. Only after human approval does it dispatch implementation sub-agents and coordinate their work.

The coding orchestrator and technical agents use the relevant product requirements together with code and engineering documentation in the repository. Technical findings can be reported to the PM so their product implications are captured in Fizzer's notes without duplicating engineering documentation.

## Mission workflow

### Define the mission

Product definition comes before implementation planning. The PM works with humans to describe intended behavior, rationale, expected outcome, and delivery conditions.

This can emerge from a group product interview, an area conversation, the PM's proactive review of project context, or a human request. Existing channels remain the conversation surface.

### Approve the product-level mission

A human approves what is to be delivered. This is the first human approval and authorizes planning, not implementation.

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

## Mission view and conversations

Missions live under their areas in the sidebar, alongside each area's product channels. Area and project overview cards provide an explicit button to open a mission's own view; there is no separate project-wide Missions navigation category.

On the project Kanban, a mission is an expandable card containing its tasks; standalone tasks remain separate. Task details expand in place. People move task cards by dragging rather than using a Done button or a status dropdown. The mission's approvals and delivery conditions remain authoritative.

The mission view lets people:

- Read and edit the mission's intended behavior, rationale, and delivery conditions.
- Inspect and discuss the implementation plan and approve it.
- Understand current progress, assignments, blockers, and remaining human work.
- Inspect detailed worker activity when useful without making raw traces the main view.
- Talk directly to the coding orchestrator in the mission's channel.

Product discussions remain with the PM in project/area channels. Technical planning and execution discussions happen directly with the coding orchestrator. There is no PM-mediated telephone chain.

The project execution dashboard remains available alongside product discovery. The precise mission layout, information hierarchy, and navigation are to be evaluated in the real-app UI prototype, not fixed by an external product's panel layout.

## Notes and collaboration

People and the PM maintain product understanding through shared notes and channel conversations. PM updates to established product notes take effect immediately. The project view provides actual before/after note diffs with author and time.

Do not add note-approval queues, elaborate scope-management machinery, or an additional documentation-review workflow. Reuse normal collaborative editing behavior rather than making routine changes cumbersome.

Area context remains available across missions. Mission results inform that context; completing a mission does not discard the area's product understanding.

## Availability

PM participation in existing channels is configurable: live participation or catch-up after a quiet period. Catch-up processes messages the PM has not yet processed and updates relevant product notes through the area index.

An offline PM can catch up when its runner reconnects. Always-on hosted infrastructure is not a prerequisite for the product workflow.

## Current delivery plan

1. Maintain this mission brief and the projects/areas brief as consistent living documents.
2. Maintain the interactive mock views in the existing `docs/missions-overhaul-prototype.html` entry point, using Fizzer's real UI language and explicit in-memory example data. See the [preview instructions](projects-areas-refactor.md#running-the-current-preview).
3. Exercise mission creation/definition, both human approvals, plan editing, direct orchestrator conversation, agent/human delivery checks, and navigation from the project view.
4. Iterate until Fred explicitly approves the product UI/UX.
5. Then derive the backend implementation plan from the accepted interactions and information requirements. Real implementation follows approval of that plan.

Mock planning, agent messages, approvals, and execution are demonstrations of interaction, not real agent dispatch or persistence. Do not change backend behavior, migrate data, or touch unrelated terminal UI work during this prototype.

For real implementation, evolve one mission system rather than introducing a parallel legacy runtime. Preserve existing user records and evidence; determine the necessary migration and caller changes during implementation planning, after UI approval. Do not mechanically rename compatibility identifiers or expand into unrelated hosting and permission changes.

## UI review checklist

- A person can distinguish a mission from a persistent area and a small standalone task.
- The mission explains its product outcome before presenting an implementation plan.
- The first human approval concerns the mission; the second concerns its implementation plan.
- Planning agents and implementation sub-agents have visibly different purposes and timing.
- There is no separate plan-verification agent or third human approval.
- Mission progress includes remaining human work, not only coding-agent activity.
- Human tasks have assignees and delivery dates; one assignee can complete shared work.
- A mission can be opened directly from the project view.
- Humans can talk to the coding orchestrator inside the mission view without routing technical discussion through the PM.
- Product context remains accessible and note changes are visible from the project.
- Prototype actions are clearly simulated and cannot mutate real project data or dispatch agents.

**UI/UX approval remains pending Fred's hands-on review.**
