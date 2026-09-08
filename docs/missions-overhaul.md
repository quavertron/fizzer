# Missions overhaul

**Status:** Planning — living brief, not authorization to implement everything below.
**Project:** Fizzer
**Mission conversation:** Missions Overhaul channel
**Working method:** Fred and the orchestrator refine this document together, through direct edits and conversation.

## Outcome

Make Fizzer missions useful for collaborative, agent-assisted project work: discuss an outcome with an available orchestrator, shape a shared plan, delegate scoped work, follow progress, and review verified results.
Our first target is completing the **Fizzer missions overhaul** itself. Narrative, Fred’s personal planning and reflection app, is a later bounded use case; Fizzer is the collaborative workspace used to build it, and this does not introduce multiplayer into Narrative itself.

Keep this pragmatic. Build a useful workflow, not an enterprise orchestration platform or a harness whose only purpose is building itself.

## Why this work exists

Fred reports that current everyday use centers on one agent and one general channel. Missions have been implemented and lightly tested, but have not been exercised as the normal workflow for substantial work. Agent scope, configuration, and mission visibility are confusing.

Focused channels and properly functioning missions should provide useful context boundaries before we invent more elaborate context-management machinery.

## Clean-cutover policy

This brief describes one replacement mission system, not parallel legacy and new runtimes. Missions use one lifecycle—planning, executing, and closed—with the final schema and status details settled from source facts during implementation planning. An explicit schema/data migration is required.

Before that migration runs, decide how historical mission records are migrated or retained (including any read-only treatment). Never silently delete historical records, and do not preserve old mission execution behavior solely for compatibility. Migrate every mission caller, helper, prompt, UI path, and relevant test; remove superseded mission paths, comments, and tests. Reuse generic infrastructure where it fits. Ordinary notes, chat, and security behavior remain unchanged. This scope does not add an archive project or a tool-restriction project.

## Agreed product decisions

### A mission begins in planning

- Create a mission while the goal is still being explored; a complete implementation plan is not a prerequisite.
- The orchestrator asks questions, captures decisions, and dispatches research workers as questions arise.
- Planning and research do not automatically authorize implementation. The precise implementation go-ahead interaction remains to be designed.
- Small, bounded requests can remain direct agent conversations. Multiple steps or temporary delegation do not by themselves make something a mission.

### The mission orchestrator manages; workers do technical work

- The orchestrator maintains intent, constraints, scope, assignments, dependencies, progress, and completion criteria.
- It remains available for conversation and steering while workers execute.
- It reads and edits product notes, plans, and worker reports.
- It does **not** read source code, implement changes, technically review code, or integrate code itself.
- Workers perform code research, implementation, testing, technical review, and integration.
- The orchestrator evaluates reported outcomes and evidence against the mission goal, commissions further work when necessary, and explains what was delivered or remains open.

### Missions are first-class workspace items

- Missions appear in the vault navigation alongside notes, channels, and folders.
- Opening a mission opens its Mission Control workspace, not its chat transcript.
- Adapt Factory’s mission concepts rather than reproducing its fixed panel layout. Remove the large mission header and permanent progress-log and worker-output panels; the main document/work area gets the space.
- A compact chat on the right is shared by the human collaborators and the orchestrator. It is a group conversation, not a private orchestrator chat or a separate destination to navigate back to. The underlying mission channel remains openable separately.
- An ordinary channel may originate multiple missions; each mission should have its own dedicated channel.
- Worker details should be inspectable without flooding the orchestrator conversation with every tool call.
- Do not spend time on channel reuse or duplication edge cases unless they obstruct actual use.
- The mission workspace is the primary way of interacting with the orchestrator: shared notes, plans, assignments, progress, and review make the work directly understandable and actionable. Chat supports clarification and discussion; it is not the control surface that everything else merely illustrates.

### Notes are the collaborative planning surface

- People can contribute by editing mission notes directly or by talking to the orchestrator and having it update those notes.
- Notes hold the evolving goal, constraints, open questions, milestones, scoped work, preconditions, expected behavior, and verification criteria.
- The orchestrator needs to notice relevant note edits and reconcile them with its understanding and assignments.
- The orchestrator should update notes as conversational decisions become clear, rather than requiring people to copy decisions out of chat.
- Shared notes are the working plan, not merely a retrospective report.

## Proposed experience — to refine together

Start with one mission note and split out supporting notes only when useful. Avoid requiring a separate document for every tiny assignment.

The mission surface should let someone see:

1. What we are trying to accomplish and what is still undecided.
2. The current milestone and its scoped work.
3. An assignment’s preconditions, expected behavior, and verification criteria.
4. Which workers are doing what, and where attention is needed.
5. Meaningful progress and timing, with detailed worker output available separately.
6. What has been verified, rather than merely reported finished.

Keep current responsibility prominent; completed missions remain accessible as dated history rather than dominating the view.

### Mission workspace navigation

- Replace the current Brief / Assignment tabs with Brief and Work (milestones and features).
- Brief shows the shared mission note. Work shows expandable milestones and their features, with assigned agents, current activity, and relevant requirements.
- Clicking an assigned agent reveals its worker trace on demand. The trace can expand to a full-screen view; direct worker steering is a desired capability, with its interaction with orchestrator assignments still to be defined.
- History is accessible behind a button, not a permanent progress-log panel.
- Mission status, progress, elapsed time, and usage do not require a large header. Their compact placement remains to be explored.
- Preserve a high-level understanding of live work even while reading the brief. The exact presentation is still open; do not substitute raw tool output or an event history for that overview.
- Use sensible spacing, scrolling, and explicit expansion rather than requiring draggable dividers.

### Collaborative edits during execution

Proposed minimum behavior, not a detailed synchronization design:

- Do not silently overwrite another person’s intervening edits.
- If an edit changes an active assignment, the orchestrator acknowledges its impact and redirects the worker or explains when it takes effect.
- A saved change to a note must not be mistaken for a successfully delivered change to a running worker’s instructions.
- Avoid elaborate approval machinery for ordinary editorial changes.

## Candidate milestones — not an approved implementation plan

### Understand and agree on the workflow

**Preconditions:** Current product documentation and concrete user feedback are available.

**Expected outcome:** A shared brief that makes planning, research, implementation approval, orchestrator availability, worker responsibilities, notes, and mission channels understandable.

**Evidence:** Walk through Missions Overhaul as the example; compare relevant Factory UX and selected open-source references. Delegate narrow source investigations only when a product decision needs technical facts.

### Make the core mission loop usable

**Preconditions:** Agree on the core experience and inspect existing implementation through research workers.

**Expected outcome:** A mission can begin in planning, maintain a shared brief, commission research, and move into authorized worker execution while keeping its orchestrator conversation available.

**Evidence:** Exercise the actual workflow in Fizzer. Exact acceptance criteria and implementation slices are still to be agreed.

### Close the loop with integration and verification

**Preconditions:** Scoped workers can deliver results into the mission.

**Expected outcome:** Technical review and integration belong to workers; the orchestrator tracks their results and presents verified outcomes, blockers, and remaining work clearly.

**Evidence:** Exercise the actual Fizzer workflow and inspect both the delivered behavior and the user’s ability to follow and steer it. Narrative is a later follow-on use case, not a prerequisite or first target.

## Open questions

- How should the editable mission notes and optional orchestrator sidebar fit into the agreed Factory-style Mission Control layout?
- What does the user approve before implementation begins, and how do material scope changes return for discussion?
- How do we represent milestones and assignments in notes without maintaining a conflicting second plan in the UI?
- How does the orchestrator receive note changes and user messages while workers run?
- How are existing vault agents selected for mission roles, and where should model choices be visible?
- What do pause, redirect, blocked, review, and complete mean to a user in the first usable workflow?
- Which generic infrastructure can be reused, and which mission paths must be replaced?

## Parallel work and boundaries

Another OMP process is coordinating current-app fixes:

- #5: Preserve drafts when switching vaults.
- #6 and #7: Native vault working-directory picker.
- #8: Vault agents available across channels.
- #9: My Agents picker and clearer Add Agents flow.
- #10: Ownership background colors.

Do not duplicate or interfere with that work. Those changes need not anticipate this overhaul.

[#11](https://github.com/quavertron/fizzer/issues/11), automatic dedicated mission channels, belongs with this mission’s scope.

No unrelated self-hosting changes, permission-default changes, or broad refactors. Fred’s preference for full host access is not authorization to change permissions.

## Reference material

### Factory Missions

Adapt useful UI and workflow concepts, not undocumented internals or an entire competing product.

- [Overview](https://docs.factory.ai/missions/overview)
- [Planning and validation](https://docs.factory.ai/missions/planning)
- [Mission Control in the app](https://docs.factory.ai/missions/running-app)
- [Execution and steering in the CLI](https://docs.factory.ai/missions/running-cli)
- [Published orchestration design](https://factory.ai/news/missions)

Documented patterns: collaborative planning before execution approval; milestones containing features; fresh feature-worker sessions; milestone validation; visible worker activity; separate role/model choices; pause and redirect controls.

The supplied terminal screenshot is the initial structural UI reference, not just general inspiration. Fusion’s modal-heavy dashboard UI was reviewed and rejected. Factory also publishes a graphical Mission Control screenshot: it shows a left session list, a central selected-session conversation, and right-side models, features, and progress. We are starting from the terminal structure instead, with the orchestrator chat secondary.

- [Terminal Mission Control screenshot](https://docs.factory.ai/docs-assets/images/mission-control.webp)
- [Graphical Mission Control screenshot](https://docs.factory.ai/docs-assets/images/mission-web.webp)

Factory documents research roles, but the material reviewed so far does not establish exact planning-time dispatch behavior or a strict prohibition on orchestrator source access. Our orchestrator boundary and planning-time research behavior are our own agreed requirements.

### Open-source research

Initial documentation/license research identified these possible references; none has been technically evaluated or selected for reuse:

- [Fusion](https://github.com/Runfusion/Fusion) — MIT; mission planning, plan artifacts, visible workflow/review steps. Broad early-preview platform; borrow selectively.
- [Stoneforge](https://github.com/stoneforge-ai/stoneforge) — Apache-2.0; director/worker/integration-steward separation and handoffs. Experimental and more autonomous than our intended approval boundary.
- [pi-orchestration](https://github.com/stew675/pi-orchestration) — MIT; lightweight editable-plan and worker workflow around Pi. Small project; no established shared-note or multiplayer experience.

Read licenses and the relevant implementation before copying code. Product documentation is not proof of runtime reliability.
