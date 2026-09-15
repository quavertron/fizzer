export const PEOPLE = ['Fred', 'Tyler', 'Diego'];
export const PHASE_LABELS = {
    proposal: 'Mission approval', planning: 'Planning', 'plan-review': 'Plan approval',
    executing: 'Executing', verification: 'Delivery checks', complete: 'Complete',
};
export const STATUS_LABELS = { todo: 'To do', 'in-progress': 'In progress', done: 'Done' };
export const nowLabel = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const newId = () => crypto.randomUUID();
const titleMatch = (item, text) => String(item?.title || '').trim().toLocaleLowerCase() === String(text || '').trim().toLocaleLowerCase();
const noteFor = (state, id) => (state.notes || []).find(note => note.id === id);
const missionForNote = (state, noteId) => (state.missions || []).find(mission => mission.noteId === noteId);
const taskForNote = (state, noteId) => (state.tasks || []).find(task => task.noteId === noteId);
const artifactForNote = (state, noteId) => (state.artifacts || []).find(artifact => artifact.noteId === noteId);
const areaForNote = (state, noteId) => (state.areas || []).find(area => area.noteId === noteId);

function targetChildren(state, noteId) {
    const note = noteFor(state, noteId);
    const area = areaForNote(state, noteId);
    const mission = missionForNote(state, noteId);
    const children = [];
    if (noteId === state.projectNoteId) {
        for (const item of state.areas || []) children.push({ kind: 'note', id: item.noteId, title: item.name, noteId: item.noteId, parentNoteId: state.projectNoteId });
    }
    if (area) {
        for (const item of state.notes || []) if (item.parentNoteId === noteId) children.push(item);
        for (const item of state.artifacts || []) if (item.parentNoteId === noteId) children.push(item);
    } else if (mission) {
        for (const item of state.tasks || []) if (item.missionId === mission.id) children.push(item);
        for (const item of state.artifacts || []) if (item.parentNoteId === noteId) children.push(item);
        for (const item of state.notes || []) if (item.parentNoteId === noteId) children.push(item);
    } else if (note) {
        for (const item of state.notes || []) if (item.parentNoteId === noteId) children.push(item);
        for (const item of state.missions || []) if (item.noteId && noteFor(state, item.noteId)?.parentNoteId === noteId) children.push(item);
        for (const item of state.tasks || []) if (item.noteId && noteFor(state, item.noteId)?.parentNoteId === noteId) children.push(item);
        for (const item of state.artifacts || []) if (item.parentNoteId === noteId) children.push(item);
    }
    return children;
}

function asTarget(state, item) {
    if (!item) return null;
    let kind = 'note';
    let id = item.id;
    let title = item.title;
    let noteId = item.noteId || (item.kind === 'note' ? item.id : undefined);
    let parentNoteId = item.parentNoteId || null;
    const directArtifact = (state.artifacts || []).find(candidate => candidate.id === item.id);
    const directTask = (state.tasks || []).find(candidate => candidate.id === item.id);
    const directMission = (state.missions || []).find(candidate => candidate.id === item.id);
    const artifact = directArtifact || artifactForNote(state, item.id);
    const task = directTask || taskForNote(state, item.id);
    const mission = directMission || missionForNote(state, item.id);
    if (artifact) {
        kind = 'artifact'; id = artifact.id; title = artifact.title; noteId = artifact.noteId; parentNoteId = artifact.parentNoteId || null;
    } else if (task) {
        kind = 'task'; id = task.id; title = task.title; noteId = task.noteId; parentNoteId = noteFor(state, task.noteId)?.parentNoteId || null;
    } else if (mission) {
        kind = 'mission'; id = mission.id; title = mission.title; noteId = mission.noteId; parentNoteId = noteFor(state, mission.noteId)?.parentNoteId || null;
    }
    const childCount = targetChildren(state, noteId || id).length;
    return { kind, id, title, ...(noteId ? { noteId } : {}), parentNoteId, hasChildren: childCount > 0 };
}
function uniqueTargets(state, items) {
    const seen = new Set();
    return items.map(item => asTarget(state, item)).filter(item => item && !seen.has(`${item.kind}:${item.id}`) && seen.add(`${item.kind}:${item.id}`));
}
function initialTargets(state, fromNoteId) {
    const note = noteFor(state, fromNoteId);
    if (!note && fromNoteId !== state.projectNoteId) return [];
    const children = targetChildren(state, fromNoteId);
    const parentId = note?.parentNoteId;
    const siblings = parentId ? targetChildren(state, parentId) : [];
    const all = [...children, ...siblings];
    return uniqueTargets(state, all);
}

export function getNoteLinkTargets(state, fromNoteId, containerPath = '') {
    let targets = initialTargets(state, fromNoteId);
    for (const segment of String(containerPath || '').split(' - ').map(value => value.trim()).filter(Boolean)) {
        const container = targets.find(target => titleMatch(target, segment));
        if (!container) return [];
        targets = uniqueTargets(state, targetChildren(state, container.noteId || container.id));
    }
    return targets;
}

export function resolveNoteLink(state, fromNoteId, text) {
    const parts = String(text || '').trim().split(' - ').map(value => value.trim()).filter(Boolean);
    if (!parts.length) return null;
    const finalName = parts.pop();
    const candidates = getNoteLinkTargets(state, fromNoteId, parts.join(' - '));
    return candidates.find(target => titleMatch(target, finalName)) || null;
}
export function editPrototypeNote(state, id, content, author = state.currentUser) {
    const note = state.notes.find(item => item.id === id);
    if (!note || content === note.content)
        return state;
    const at = nowLabel();
    return { ...state,
        notes: state.notes.map(item => item.id === id ? { ...item, content, updatedBy: author, updatedAt: at } : item),
        changes: [{ id: newId(), noteId: id, title: note.title, before: note.content, after: content, author, at }, ...state.changes],
    };
}
export function patchPrototypeTask(state, id, patch) {
    const task = state.tasks.find(item => item.id === id);
    return { ...state, tasks: state.tasks.map(item => item.id === id ? { ...item, ...patch } : item),
        missions: task?.conditionId && patch.status ? state.missions.map(mission => {
            if (mission.id !== task.missionId) return mission;
            const conditions = mission.conditions.map(condition => condition.id === task.conditionId ? { ...condition, done: patch.status === 'done' } : condition);
            const phase = ['verification', 'complete'].includes(mission.phase)
                ? conditions.every(condition => condition.done) ? 'complete' : 'verification'
                : mission.phase;
            return { ...mission, conditions, phase };
        }) : state.missions,
    };
}
export function createPrototypeState(greenfield = false) {
    const base = {
        projectName: greenfield ? 'Untitled product' : 'Fizzer', setup: greenfield ? 'greenfield' : 'existing', currentUser: 'Fred', runnerOnline: true,
        projectNoteId: 'product-overview', projectChannelId: 'general',
        areas: [], tasks: [], notes: [], changes: [], missions: [], artifacts: [], noteActivity: [],
        channels: [{ id: 'general', name: 'product', areaId: null, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'g1', author: 'Tyler', role: 'human', body: greenfield ? 'Let’s shape the product together before we start building.' : 'Our next priority is a useful beta, not a bigger feature list.', at: '09:10' },
                    { id: 'g2', author: 'Project manager', role: 'pm', body: greenfield ? 'Who is this product for, and what should become easier for them?' : 'The beta invitation flow is the next priority. I have proposed a separate Public launch area for the next release.', at: '09:12' },
                    { id: 'g3', author: 'Diego', role: 'human', body: greenfield ? 'Let’s start with the people and situations this should serve.' : 'I can review the launch language once the beta sessions give us stronger evidence.', at: '09:15' },
                    ...(!greenfield ? [
                        { id: 'g4', kind: 'action', author: 'Project manager', role: 'pm', body: 'Assigned launch language review to Diego.', at: '09:16', action: { type: 'task-assigned', taskId: 'launch-copy-review', missionId: 'launch-readiness', noteId: 'launch-brief', assignee: 'Diego' } },
                        { id: 'g5', author: 'Fred', role: 'human', body: 'The beta suggests we should lead with the outcome, but I do not want to lose the shared-work story.', at: '09:18' },
                        { id: 'g6', author: 'Tyler', role: 'human', body: 'I hear both. A small team needs to see what becomes easier first, then understand how the work stays accountable.', at: '09:20' },
                        { id: 'g7', author: 'Project manager', role: 'pm', body: 'The room is aligned on testing an outcome-first promise with the shared-work context close by. The final wording remains open for Diego’s evidence review.', at: '09:22' },
                        { id: 'g8', author: 'Project manager', role: 'pm', body: 'For the next mission, we are refining the Mission refactor in its own document linked from the Project Interface area note. The sibling Create the project agent mission is still in group scoping.', at: '09:24' },
                        { id: 'g9', author: 'Fred', role: 'human', body: 'I will review the Mission refactor prototype and say explicitly whether the UX is ready for my product workflow.', at: '09:26' },
                        { id: 'g10', author: 'Diego', role: 'human', body: 'I will review the handoff and language path separately. My UX-ready call should not be inferred from anyone else’s.', at: '09:27' },
                        { id: 'g11', author: 'Tyler', role: 'human', body: 'I will test coordination and say explicitly whether the UX is ready for the team.', at: '09:28' },
                        { id: 'g12', kind: 'action', author: 'Coding orchestrator', role: 'orchestrator', body: 'Requested three separate UX-ready reviews for Mission refactor before implementation planning.', at: '09:29', action: { type: 'review-requested', taskIds: ['overhaul-review-fred', 'overhaul-review-diego', 'overhaul-review-tyler'], missionId: 'mission-overhaul', noteId: 'project-interface-note' } },
                        { id: 'g13', author: 'Project manager', role: 'pm', body: 'No room agreement is recorded yet. Mission refactor remains in UI refinement until all three people say the UX is ready.', at: '09:31' },
                    ] : []),
                ] }],
    };
    if (greenfield)
        return base;

    const betaOverviewBefore = '# Beta test\n\nLearn whether new participants can start a useful project without assistance.\n\n## Participants\nInvite 12 people from the early-access list.\n\n## What we need to learn\n- Can people understand projects and areas?\n- Can they find work assigned to them?';
    const betaOverview = '# Beta test\n\nLearn whether new participants can start a useful project without assistance.\n\n## Participants\nInvite 20 people from the early-access list.\n\n## What we need to learn\n- Can people understand projects and areas?\n- Can they find work assigned to them?\n- Can they distinguish the project manager from the coding orchestrator?';
    const betaParticipantsBefore = '# Beta participants\n\nCohort: 12 people from the early-access list.\n\nTyler coordinates invitations. Fred runs the first usability sessions.';
    const betaParticipants = '# Beta participants\n\nCohort: 20 people from the early-access list.\n\nTyler coordinates invitations. Fred runs the first usability sessions. Diego observes the first three sessions and records confusing moments.\n\n## Consent\nParticipants opt in through the invitation and may withdraw after each session.';
    const betaFeedbackBefore = '# Feedback and findings\n\n## Questions for the first round\n- Is it clear what requires a human action?\n- Can participants navigate from a project to its missions?';
    const projectInterfaceNote = '# Project Interface\n\nMake Fizzer a shared place where people and agents define a product, preserve its context, and carry agreed work through to delivery. This area owns the product knowledge; missions reference it and record their own work.\n\n## Product documentation\n- [[Product model]] — projects, areas, missions, and tasks\n- [[Notes and navigation]] — short documents, local links, editing, and history\n- [[Artifacts and conversations]] — side-by-side review and floating chat\n- [[Mission workflow]] — product approval, planning, execution, and delivery\n- [[Human work and board]] — responsibilities, priorities, dates, and progress\n- [[Project agent]] — shared product understanding and group discovery\n\n## Missions\n- [[Mission refactor]] — adapt existing missions; currently refining this UI\n- [[Create the project agent]] — scope and ideate the agent before prototyping\n\n## Dispatch\n[[Mission refactor dispatch]] is a separate draft prompt for implementation planning. It has not been sent.\n\n## Current work\nRefine this note-and-chat experience before deciding the backend implementation plan. The documentation records agreed intent; teammate activity in this preview is illustrative.';
    const missionRefactorNote = '# Mission refactor\n\n## Intended change\nAdapt the existing mission system to the project interface. A mission becomes understandable through its brief, conversation, tasks, and review artifacts rather than being organized around a channel or an isolated task board.\n\n## Product context\nUse the shared area documentation: [[Product model]], [[Notes and navigation]], [[Artifacts and conversations]], [[Mission workflow]], and [[Human work and board]]. This brief records the change and its progress, not another copy of those rules.\n\n## Current step: UI refinement\nWe are refining the selected note-and-chat prototype. Backend implementation planning has not been approved. Preserve useful orchestration and existing work when the implementation is planned.\n\n## Human readiness\nEach required person must explicitly say the UX is ready. These are separate review obligations, not one shared completion.\n- [ ] [[Review Mission refactor UX]] — Fred: product workflow\n- [ ] [[Review Mission refactor handoff]] — Diego: language and handoff\n- [ ] [[Review Mission refactor coordination]] — Tyler: team coordination\n\n## Delivery checks\n- [ ] Product knowledge stays in area notes and remains accessible from the mission.\n- [ ] A task opens beside the mission with floating task conversation.\n- [ ] Product approval, implementation-plan approval, and delivery checks remain distinct.\n\n## Next step\nAfter UX readiness, the PM prepares the planning dispatch. The coding orchestrator proposes a plan for human approval before implementation.';
    const createProjectAgentNote = '# Create the project agent\n\n## Intended change\nGive the project one shared agent that helps people discover what they want, maintains product knowledge in area notes, and identifies useful work across conversations.\n\n## Product context\n[[Project agent]] defines the role and its context. [[Product model]] defines ownership; [[Mission workflow]] defines the handoff to technical execution.\n\n## Current step: Group scoping and ideation\nWork out the desired experience together before selecting a prototype. This mission is earlier than Mission refactor: it has not reached a prototype or UX-readiness gate.\n\n## Questions to settle\n- When should the agent join a conversation, and when should it catch up later?\n- How should it surface missing decisions, proposed work, and conflicting views?\n- What should people see when it changes a note or proposes a mission?\n\n## Next steps\n1. Record the group’s scope and unresolved questions.\n2. Prototype the agreed direction as a step within this mission.\n3. Refine that prototype with the group.\n4. Settle the implementation plan and delivery checks before implementation.';
    const reviewerNotes = {
        fred: '# Review Mission refactor UX\n\nReview the project-facing workflow and say explicitly whether it is ready. The parent mission stays visible beside this task.\n\n- [ ] The area index and short product notes make the context understandable.\n- [ ] Links open the expected document or artifact without losing the mission.\n- [ ] The Notes picker changes the reading document without switching the conversation.\n\nRecord concerns here; ordinary feedback is not an explicit readiness sign-off.',
        diego: '# Review Mission refactor handoff\n\nReview language and the handoff between product definition and execution. The parent mission stays visible beside this task.\n\n- [ ] Product knowledge belongs to the area; the mission references it.\n- [ ] The PM dispatch is clearly separate from product documentation.\n- [ ] Planning comes before implementation, with a human approval of the plan.\n\nRecord concerns here, then explicitly say whether the handoff UX is ready.',
        tyler: '# Review Mission refactor coordination\n\nReview how people coordinate through shared notes, tasks, and conversations. The parent mission stays visible beside this task.\n\n- [ ] Each person’s readiness remains visible as a separate obligation.\n- [ ] Mission tasks open beside the mission and retain their own floating chat.\n- [ ] Closing an artifact returns to the mission conversation without losing context.\n\nRecord concerns here, then explicitly say whether the coordination UX is ready.',
    };
    const dispatchNote = '# Mission refactor dispatch\n\n## Status\nDraft — not sent. The product UX is still being refined.\n\n## Execution prompt\nCoding orchestrator, use [[Mission refactor]] and the three reviewer notes as product context. Propose an implementation plan first; do not infer approval or UX readiness from this draft.\n\n## Requirements\n- Preserve the product-document and chat relationship.\n- Keep Fred, Diego, and Tyler’s readiness calls separate.\n- Return the plan for human review before implementation or delivery work.';
    const projectProductNotes = [
        { id: 'project-interface-product-model-note', title: 'Product model', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Product model\n\n## Context before work\nFizzer is the project. Projects replace the user-facing vault name, not the underlying compatibility identifiers. A project brings together people, shared conversations, areas, and their work.\n\nAn area is a lasting part of the product, not a temporary execution container. It can exist before there is a task to do. Its overview/index links short notes containing the product knowledge that people and agents need. That knowledge survives individual missions.\n\n## Missions and tasks\nA mission describes a bounded change: what should become possible, why, its scope, and what must be confirmed before it is complete. It references the area’s product notes rather than duplicating them. It has its own brief and conversation.\n\nTasks are bounded human or single-agent work. They can belong to a mission or stand alone. Several steps do not automatically require a mission; a small coding request can simply be a prompt to an agent.\n\n## Documentation and execution\nArea notes describe the product. Mission briefs describe the work. A separate area-owned dispatch contains the PM’s instructions to the coding orchestrator. Code and engineering documentation remain in the repository.\n\nSee [[Mission workflow]] for approvals and [[Notes and navigation]] for moving through this context.', updatedBy: 'Project manager', updatedAt: '09:24' },
        { id: 'project-interface-notes-navigation-note', title: 'Notes and navigation', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Notes and navigation\n\n## Short documents\nStart with the area overview/index, then follow links to focused notes roughly one or two pages long. The Notes button at the chat header opens available documents, index first. Choosing a note changes the reading document without changing the conversation. A mission can consult its area’s product knowledge this way.\n\n## Local links\n[[Product model]] is a direct local name. [[Mission refactor - Review Mission refactor UX]] follows a mission to a task. Names resolve among siblings and children; a spaced hyphen descends into a named container. Typing offers only names within that scope, not a global search.\n\nThe brackets remain normal text. Clicking opens the target. Dragging selects text, arrow keys can enter the name, and copy, cut, and delete work normally.\n\n## Navigation and editing\nKeep the full area/mission list expanded. Supporting notes are slightly indented below their index. A mission’s task and artifact rows appear when that mission is centered. Tasks open beside it, so its context stays visible.\n\nUse muted yellow for notes, red for missions, and blue for tasks, alongside icons. Keep Markdown directly editable with uniform-size syntax-colored text; no separate edit mode or duplicate mission card.\n\n## Visible changes\nPM edits take effect immediately. Local History shows only the current note’s before/after changes without navigating away. Global Changes collects changes across the project with author and time. No note-approval queue.', updatedBy: 'Project manager', updatedAt: '09:24' },
        { id: 'project-interface-artifacts-chat-note', title: 'Artifacts and conversations', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Artifacts and conversations\n\n## Keep the parent visible\nA prototype, image, or leaf-note artifact opens in the right pane while its parent document stays on the left. It replaces the normal chat surface, not the parent document. Ordinary artifacts use their parent’s conversation rather than acquiring another channel.\n\nMission tasks also open in the artifact pane. The mission remains centered, and the floating conversation belongs to that task. Closing the task returns to the mission chat. The PM dispatch is area-owned, so it opens beside the area document instead.\n\n## Floating messages\nCollapsed chat leaves the artifact unobscured. A small bottom chat/writing control shows unread messages without permanently displaying history or a composer.\n\nAn incoming message can briefly float over the artifact, with Dismiss and Reply. Ignoring it removes the temporary bubble after a few seconds, not the message from history.\n\nOpening chat shows floating history and the composer, with the artifact still visible underneath and blurred while chat has attention. Reply opens writing; collapse returns focus to the artifact. Reading history clears the displayed unread count.\n\nPreserve drafts when changing context. Sending a message or expanding history must not reset the artifact under review. See [[Project agent]] for awareness across conversations.', updatedBy: 'Project manager', updatedAt: '09:24' },
        { id: 'project-interface-mission-workflow-note', title: 'Mission workflow', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Mission workflow\n\n## Define before planning\nThe PM and humans discuss intended behavior, rationale, scope, outcomes, and delivery conditions. Shared product knowledge stays in the area notes; the mission brief references it and records the proposed change. Group discovery can include prototyping before the direction is ready.\n\n## Two human approvals\n1. Humans approve the product-level mission. This permits implementation planning, not immediate implementation.\n2. Humans approve the implementation plan. This permits implementation work.\n\nBetween those approvals, the PM creates a separate area-owned dispatch with instructions and references for the coding orchestrator. A draft dispatch is not evidence that work was sent.\n\nThe coding orchestrator commissions planning agents to investigate the codebase, judges whether their approach should satisfy the delivery conditions, and presents a credible plan to humans. Human plan approval is plan verification; there is no separate plan-verification agent or third universal approval.\n\n## Execute and deliver\nAfter plan approval, the orchestrator dispatches implementation sub-agents and coordinates their work. Humans may discuss technical work directly with it; the PM is not a relay.\n\nCompletion requires the delivery conditions. Some checks are agent-verifiable; others require humans to use the product and judge the experience. Automated success does not replace required human checks.\n\nSmall standalone work does not need this workflow. See [[Human work and board]] for the tasks that support it.', updatedBy: 'Project manager', updatedAt: '09:24' },
        { id: 'project-interface-human-work-note', title: 'Human work and board', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Human work and board\n\n## Human work is real work\nWriting a brief, reviewing a mission, approving a plan, dispatching work, and running acceptance checks are tasks with status, named assignees, and due dates. They must not exist only as buttons hidden inside a mission.\n\nThe PM sets priorities and recommends what should happen next. Humans set delivery dates. Both can assign human work; the coding orchestrator assigns technical implementation work to its sub-agents.\n\nA shared task may have several assignees, and any one can complete it. Separate required reviews remain separate tasks: one person completing a shared task is not everyone signing off.\n\n## Project view\nThe compact Note / Project toggle keeps documentation and the work view close. Project mode starts with current tasks for all people. Expanding the board reveals To do, In progress, and Done, plus My work / All work.\n\nMission cards expand to show their tasks; standalone tasks stay separate. Details expand in place. Dragging moves tasks instead of adding Done buttons or status menus to every card. Dates, people, and priorities remain visible.\n\nMoving a card does not replace the approvals or delivery conditions in [[Mission workflow]]. Opening a mission task shows its document and floating conversation beside the mission.', updatedBy: 'Project manager', updatedAt: '09:24' },
        { id: 'project-interface-project-agent-note', title: 'Project agent', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: '# Project agent\n\n## One shared product manager\nThe project has one PM agent, not an additional manager for every area. It helps people describe intended behavior, asks focused questions, incorporates different perspectives, and records decisions in area product notes. The first reply is not automatically the group’s conclusion; unresolved choices remain visible.\n\nIt can identify useful work proactively, propose areas with context, create missions, set priorities, and assign human work. It maintains notes immediately, with changes available for review rather than waiting in an approval queue.\n\n## Context across rooms\nThe PM can read new messages across project, area, mission, and task chats, load relevant notes, and choose where a reply helps. It is not confined to the room currently open on screen and need not answer every message.\n\nParticipation can be live or catch-up after a quiet period. Catch-up tracks messages the agent has not processed separately from human unread state. An offline runner can catch up when it returns; always-on hosting is not a prerequisite.\n\n## Product, not engineering\nThe PM works from product documentation, not code inspection. Research agents can investigate an existing product and report findings for the PM to turn into area knowledge. A new product can begin with group conversation before a repository or coding team exists.\n\nTechnical planning and implementation belong to the coding orchestrator through [[Mission workflow]]. [[Create the project agent]] is the mission for shaping and delivering this experience.', updatedBy: 'Project manager', updatedAt: '09:24' },
    ];
    const scopedMissionNotes = [
        { id: 'beta-invitations-note', title: 'Make beta invitations effortless', areaId: 'beta', parentNoteId: 'beta-overview', content: '# Make beta invitations effortless\n\nA beta participant can accept an invitation, enter the right project, and find their first action without assistance.\n\n## Current step\nInvitation and project-opening flow are ready for review.', updatedBy: 'Project manager', updatedAt: '09:18' },
        { id: 'beta-feedback-loop-note', title: 'Turn beta findings into product decisions', areaId: 'beta', parentNoteId: 'beta-feedback', content: '# Turn beta findings into product decisions\n\nCapture confusing moments from each beta session and turn repeated findings into explicit product decisions.\n\n## Current step\nGroup recurring observations before choosing the next change.', updatedBy: 'Project manager', updatedAt: '09:28' },
        { id: 'launch-readiness-note', title: 'Make the public launch promise clear', areaId: 'launch', parentNoteId: 'launch-brief', content: '# Make the public launch promise clear\n\nA first-time visitor understands what Fizzer helps a team do and can start a project without a guided explanation.\n\n## Language review\n- [ ] [[Review the first-run launch language]] — Diego checks the promise against participant evidence.\n\n## Current step\nRefine first-run language against beta evidence.', updatedBy: 'Project manager', updatedAt: '09:38' },
        { id: 'partner-onboarding-note', title: 'Make first-run onboarding clear', areaId: 'launch', parentNoteId: 'launch-brief', content: '# Make first-run onboarding clear\n\nA new visitor can start a project, understand where their first action belongs, and return to the work without a guided explanation.\n\n## Current step\nObserve one bounded first-run path with a design partner.', updatedBy: 'Project manager', updatedAt: '09:35' },
    ];
    const scopedTaskNotes = [
        { id: 'approve-mission-note', title: 'Approve the beta invitation mission', areaId: 'beta', parentNoteId: 'beta-invitations-note', content: '# Approve the beta invitation mission\n\nReview the intended behavior, rationale, and delivery conditions before the beta invitation mission proceeds.\n\n- [[Make beta invitations effortless]]', updatedBy: 'Project manager', updatedAt: '09:18' },
        { id: 'approve-plan-beta-note', title: 'Approve the beta invitation implementation plan', areaId: 'beta', parentNoteId: 'beta-invitations-note', content: '# Approve the beta invitation implementation plan\n\nReview the orchestrator’s accepted plan before implementation starts.\n\n- [[Make beta invitations effortless]]', updatedBy: 'Project manager', updatedAt: '09:18' },
        { id: 'beta-session-review-note', title: 'Review the first beta session plan', areaId: 'beta', parentNoteId: 'beta-overview', content: '# Review the first beta session plan\n\nConfirm which participant moments Fred and Diego will observe during the first round.\n\n- [[Beta test overview]]', updatedBy: 'Project manager', updatedAt: '09:18' },
        { id: 'beta-cohort-note', title: 'Choose the first beta cohort', areaId: 'beta', parentNoteId: 'beta-participants', content: '# Choose the first beta cohort\n\nSelect participants representing solo and shared-project workflows.\n\n- [[Beta participants]]', updatedBy: 'Tyler', updatedAt: '09:15' },
        { id: 'feedback-synthesis-note', title: 'Synthesize recurring beta findings', areaId: 'beta', parentNoteId: 'beta-feedback-loop-note', content: '# Synthesize recurring beta findings\n\nGroup the first session observations in the Feedback and findings note.\n\n- [[Turn beta findings into product decisions]]', updatedBy: 'Project manager', updatedAt: '09:28' },
        { id: 'approve-launch-mission-note', title: 'Approve the public launch mission', areaId: 'launch', parentNoteId: 'launch-readiness-note', content: '# Approve the public launch mission\n\nReview the launch outcome and authorize technical planning.\n\n- [[Make the public launch promise clear]]', updatedBy: 'Tyler', updatedAt: '09:19' },
        { id: 'launch-copy-review-note', title: 'Review the first-run launch language', areaId: 'launch', parentNoteId: 'launch-readiness-note', content: '# Review the first-run launch language\n\nRead the launch brief and identify language that needs a participant’s perspective.\n\n- [[Make the public launch promise clear]]', updatedBy: 'Project manager', updatedAt: '09:16' },
        { id: 'launch-stakeholder-review-note', title: 'Review launch readiness with Tyler', areaId: 'launch', parentNoteId: 'launch-brief', content: '# Review launch readiness with Tyler\n\nAgree on the public promise and the evidence still needed before September 30.\n\n- [[Launch brief]]', updatedBy: 'Project manager', updatedAt: '09:25' },
        { id: 'launch-message-agent-note', title: 'Refine the first-run product message', areaId: 'launch', parentNoteId: 'launch-readiness-note', content: '# Refine the first-run product message\n\nCompare the launch promise with beta findings and propose clear visitor-facing language.\n\n- [[Make the public launch promise clear]]', updatedBy: 'Project manager', updatedAt: '09:22' },
        { id: 'partner-approve-mission-note', title: 'Approve the first-run onboarding mission', areaId: 'launch', parentNoteId: 'partner-onboarding-note', content: '# Approve the first-run onboarding mission\n\nConfirm the onboarding outcome and its launch guardrails.\n\n- [[Make first-run onboarding clear]]', updatedBy: 'Fred', updatedAt: '09:20' },
        { id: 'partner-context-agent-note', title: 'Connect the first visitor to a project area', areaId: 'launch', parentNoteId: 'partner-onboarding-note', content: '# Connect the first visitor to a project area\n\nPrepare the first-run context path from the launch brief and beta findings.\n\n- [[Make first-run onboarding clear]]', updatedBy: 'Project manager', updatedAt: '09:21' },
        { id: 'partner-work-agent-note', title: 'Make the first task visible', areaId: 'launch', parentNoteId: 'partner-onboarding-note', content: '# Make the first task visible\n\nEnsure a new visitor can identify accountable work after entering the project.\n\n- [[Make first-run onboarding clear]]', updatedBy: 'Project manager', updatedAt: '09:23' },
        { id: 'partner-human-check-note', title: 'Run the first-run onboarding session', areaId: 'launch', parentNoteId: 'partner-onboarding-note', content: '# Run the first-run onboarding session\n\nObserve whether a new visitor can start without our team taking over the explanation.\n\n- [[Make first-run onboarding clear]]', updatedBy: 'Project manager', updatedAt: '09:25' },
        { id: 'public-date-note', title: 'Confirm the September 30 launch date', areaId: 'launch', parentNoteId: 'launch-brief', content: '# Confirm the September 30 launch date\n\nChoose the public date after reviewing beta evidence and launch readiness.\n\n- [[Launch brief]]', updatedBy: 'Tyler', updatedAt: '09:24' },
    ];
    const scopedMissionChannels = [
        { id: 'beta-invitations-channel', name: 'beta-invitations', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'bi1', author: 'Project manager', role: 'pm', body: 'Let’s review the invitation outcome and delivery conditions before implementation work starts.', at: '09:18' }] },
        { id: 'beta-feedback-loop-channel', name: 'beta-feedback-loop', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'bfl1', author: 'Fred', role: 'human', body: 'I am grouping the recurring session findings here before we choose the next product decision.', at: '09:29' }] },
        { id: 'launch-readiness-channel', name: 'launch-readiness', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'lr1', author: 'Project manager', role: 'pm', body: 'This mission has its own language gate; Diego’s evidence review remains separate from the launch area discussion.', at: '09:38' }] },
        { id: 'partner-onboarding-channel', name: 'partner-onboarding', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'po1', author: 'Project manager', role: 'pm', body: 'Keep this first-run experiment bounded to one design partner and its explicit onboarding criteria.', at: '09:35' }] },
    ];
    const scopedTaskChannels = [
        { id: 'approve-mission-channel', name: 'approve-beta-mission', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'am1', author: 'Project manager', role: 'pm', body: 'Please review the beta invitation mission before we move its plan forward.', at: '09:18' }] },
        { id: 'approve-plan-beta-channel', name: 'approve-beta-plan', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'apb1', author: 'Coding orchestrator', role: 'orchestrator', body: 'The implementation plan is ready for human review; no work starts until it is accepted.', at: '09:20' }] },
        { id: 'beta-session-review-channel', name: 'beta-session-review', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'bsr1', author: 'Fred', role: 'human', body: 'I will bring the participant moments we need to observe into this review.', at: '09:18' }] },
        { id: 'beta-cohort-channel', name: 'beta-cohort', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'bc1', author: 'Tyler', role: 'human', body: 'I am selecting a cohort that covers both solo and shared-project workflows.', at: '09:15' }] },
        { id: 'feedback-synthesis-channel', name: 'feedback-synthesis', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'fs1', author: 'Project manager', role: 'pm', body: 'Let’s connect repeated findings to an explicit follow-up decision.', at: '09:28' }] },
        { id: 'approve-launch-mission-channel', name: 'approve-launch-mission', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'alm1', author: 'Tyler', role: 'human', body: 'I am reviewing the launch outcome and the evidence needed before technical planning.', at: '09:19' }] },
        { id: 'launch-copy-review-channel', name: 'launch-copy-review', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'lcr1', author: 'Diego', role: 'human', body: 'I will compare the first-run language with what participants actually asked us.', at: '09:37' }] },
        { id: 'launch-stakeholder-review-channel', name: 'launch-stakeholder-review', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'lsr1', author: 'Project manager', role: 'pm', body: 'Let’s agree on the public promise and keep the remaining evidence visible.', at: '09:25' }] },
        { id: 'launch-message-agent-channel', name: 'launch-message-agent', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'lma1', author: 'Coding orchestrator', role: 'orchestrator', body: 'I will compare the launch promise with beta findings and return a language proposal.', at: '09:22' }] },
        { id: 'partner-approve-mission-channel', name: 'approve-onboarding-mission', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'pam1', author: 'Fred', role: 'human', body: 'I am checking the onboarding outcome and the launch guardrails.', at: '09:20' }] },
        { id: 'partner-context-agent-channel', name: 'partner-context-agent', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'pca1', author: 'Coding orchestrator', role: 'orchestrator', body: 'I am preparing the path from the launch brief to the first project area.', at: '09:21' }] },
        { id: 'partner-work-agent-channel', name: 'partner-work-agent', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'pwa1', author: 'Coding orchestrator', role: 'orchestrator', body: 'I am keeping the first accountable task visible after project entry.', at: '09:23' }] },
        { id: 'partner-human-check-channel', name: 'partner-human-check', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'phc1', author: 'Fred', role: 'human', body: 'I will observe whether a new visitor can start without us taking over the explanation.', at: '09:25' }] },
        { id: 'public-date-channel', name: 'public-date', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [{ id: 'pd1', author: 'Tyler', role: 'human', body: 'I will confirm the date after checking the beta evidence and launch readiness.', at: '09:24' }] },
    ];
    const artifactReviewNotes = '# Mission refactor review notes\n\n## Human UX checks\n\n- Fred: review the project-facing workflow and call out what is ready.\n- Diego: review the language and handoff flow.\n- Tyler: review team coordination and shared context.\n\n## Open question\nDoes the artifact make the mission section easier to discuss without becoming another hierarchy level?';
    const missionRefactorPrototypeHtml = '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#11151d;color:#e8edf5;font:14px system-ui,sans-serif;padding:24px}main{max-width:520px;margin:auto;border:1px solid #394454;border-radius:10px;padding:18px;background:#1a202b}h1{font-size:18px;margin:0 0 6px}p{color:#aab4c4;line-height:1.5}button{border:1px solid #65748b;border-radius:5px;background:#243044;color:#e8edf5;padding:8px 11px;cursor:pointer}button[data-ready="true"]{border-color:#76d6aa;color:#76d6aa}.state{display:inline-block;margin-left:8px;color:#aab4c4;font-size:12px}</style></head><body><main><small>MISSION REFACTOR · UI REFINEMENT</small><h1>Shared mission note</h1><p>Keep the decision context beside the work, then ask each person whether the UX is ready.</p><button id="ready" type="button">Mark my UX review ready</button><span class="state" id="state">Not reviewed</span></main><script>document.getElementById("ready").addEventListener("click",function(){this.dataset.ready="true";document.getElementById("state").textContent="Ready to discuss";});</script></body></html>';
    const missionRefactorRelationshipSvg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300"><rect width="640" height="300" rx="18" fill="#171c26"/><g fill="none" stroke="#7da9ff" stroke-width="3"><path d="M160 150h110M370 150h110"/></g><g fill="#242d3d" stroke="#566983"><rect x="40" y="100" width="120" height="100" rx="10"/><rect x="270" y="100" width="100" height="100" rx="10"/><rect x="480" y="100" width="120" height="100" rx="10"/></g><g fill="#edf2fa" font-family="system-ui" text-anchor="middle"><text x="100" y="142" font-size="16">Project</text><text x="100" y="166" font-size="13">Fizzer</text><text x="320" y="142" font-size="16">Area</text><text x="320" y="166" font-size="13">Interface</text><text x="540" y="142" font-size="16">Mission</text><text x="540" y="166" font-size="13">Refactor</text></g></svg>')}`;
    const betaFeedback = '# Feedback and findings\n\n## Questions for the first round\n- Is it clear what requires a human action?\n- Can participants navigate from a project to its missions?\n- Can they tell who is responsible for product decisions and technical execution?\n\n## Findings\nParticipants want their own due dates visible without opening every mission. Two people looked for the mission conversation beside the work list.';
    const productOverviewBefore = '# Fizzer\n\nA shared place for humans and agents to define a product and deliver it together.\n\n## Current priority\nMake the beta useful.';
    const productOverview = '# Fizzer\n\nA shared place for humans and agents to define a product and deliver it together.\n\n## Current priority\nMake the beta useful: collaborative product discovery, clear human responsibilities, and understandable mission execution.\n\n## Near-term direction\nUse the beta evidence to shape a confident public launch promise.';
    const launchBriefBefore = '# Public launch\n\n## Intended outcome\nHelp people understand Fizzer and start a shared project.\n\n## Open questions\nWhat have we learned from the beta?';
    const launchBrief = '# Public launch\n\n## Intended outcome\nHelp people understand Fizzer and start a shared project.\n\n## Positioning\nFizzer helps a small team turn product conversations into visible, accountable work.\n\n## Launch readiness\nUse beta findings to explain the project, area, and mission relationship without requiring a guided tour. The public date is September 30.\n\n## Language review\nDiego will verify the launch language against participant evidence before this mission is complete.';
    const launchBriefBeforeLanguage = '# Public launch\n\n## Intended outcome\nHelp people understand Fizzer and start a shared project.\n\n## Positioning\nFizzer helps a small team turn product conversations into visible, accountable work.\n\n## Launch readiness\nUse beta findings to explain the project, area, and mission relationship without requiring a guided tour. The public date is September 30.';
    const partnerBriefBefore = '# Partner pilot\n\n## Open questions\nWhich partner workflow is a useful next test?';
    const partnerBrief = '# Partner pilot\n\n## Intended outcome\nTest Fizzer with one design partner whose team already documents product decisions.\n\n## Guardrails\nStart with a single workspace and a short onboarding session. Do not promise integrations or shared hosting in this pilot.';

    return { ...base,
        areas: [
            { id: 'project-interface', name: 'Project Interface', noteId: 'project-interface-note', summary: 'Refine how Fizzer turns shared product decisions into accountable mission work.', status: 'active', noteIds: ['project-interface-note', 'project-interface-product-model-note', 'project-interface-notes-navigation-note', 'project-interface-artifacts-chat-note', 'project-interface-mission-workflow-note', 'project-interface-human-work-note', 'project-interface-project-agent-note'], channelId: 'project-interface-channel' },
            { id: 'beta', name: 'Beta test', noteId: 'beta-overview', summary: 'Help 20 participants try a complete project workflow and turn their experience into improvements.', status: 'active', noteIds: ['beta-overview', 'beta-index', 'beta-participants', 'beta-feedback'], channelId: 'beta-channel' },
            { id: 'launch', name: 'Public launch', noteId: 'launch-brief', summary: 'Turn the beta evidence into a clear public promise and a calm first-run experience.', status: 'active', noteIds: ['launch-brief', 'launch-index'], channelId: 'launch-channel' },
            { id: 'partner', name: 'Partner pilot', noteId: 'partner-brief', summary: 'Proposed focused pilot with one design partner after the beta invitation workflow is understood.', status: 'proposed', noteIds: ['partner-brief', 'partner-index'], channelId: 'partner-channel' },
        ],
        notes: [
            { id: 'product-overview', title: 'Fizzer', areaId: null, parentNoteId: null, content: `${productOverview}\n\n## Areas\n- [[Project Interface]] — shared mission and interface work`, updatedBy: 'Project manager', updatedAt: '09:12' },
            { id: 'project-interface-note', title: 'Project Interface', areaId: 'project-interface', parentNoteId: 'product-overview', content: projectInterfaceNote, updatedBy: 'Project manager', updatedAt: '09:24' },
            ...projectProductNotes,
            { id: 'mission-overhaul-note', title: 'Mission refactor', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: missionRefactorNote, updatedBy: 'Project manager', updatedAt: '09:28' },
            { id: 'create-project-agent-note', title: 'Create the project agent', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: createProjectAgentNote, updatedBy: 'Project manager', updatedAt: '09:28' },
            { id: 'overhaul-review-fred-note', title: 'Review Mission refactor UX', areaId: 'project-interface', parentNoteId: 'mission-overhaul-note', content: reviewerNotes.fred, updatedBy: 'Fred', updatedAt: '09:30' },
            { id: 'overhaul-review-diego-note', title: 'Review Mission refactor handoff', areaId: 'project-interface', parentNoteId: 'mission-overhaul-note', content: reviewerNotes.diego, updatedBy: 'Diego', updatedAt: '09:30' },
            { id: 'overhaul-review-tyler-note', title: 'Review Mission refactor coordination', areaId: 'project-interface', parentNoteId: 'mission-overhaul-note', content: reviewerNotes.tyler, updatedBy: 'Tyler', updatedAt: '09:30' },
            { id: 'mission-overhaul-dispatch-note', title: 'Mission refactor dispatch', areaId: 'project-interface', parentNoteId: 'project-interface-note', content: dispatchNote, updatedBy: 'Project manager', updatedAt: '09:31' },
            ...scopedMissionNotes,
            ...scopedTaskNotes,
            { id: 'beta-index', title: 'Beta test · context index', areaId: 'beta', parentNoteId: 'beta-overview', content: '# Beta test context\n\nThe project manager uses this index to load the product notes relevant to the beta.\n\n- [[Beta test overview]] — goals and questions\n- [[Beta participants]] — cohort and consent\n- [[Feedback and findings]] — what people are telling us\n- [[Fizzer]] — shared product direction\n\nImplementation details remain in the engineering repository.', updatedBy: 'Project manager', updatedAt: '09:18' },
            { id: 'beta-overview', title: 'Beta test overview', areaId: 'beta', parentNoteId: 'product-overview', content: `${betaOverview}\n\n## Make beta invitations effortless\n### Current step\nPrepare the invitation and first-task experience for usability review.`, updatedBy: 'Project manager', updatedAt: '09:18' },
            { id: 'beta-participants', title: 'Beta participants', areaId: 'beta', parentNoteId: 'beta-overview', content: betaParticipants, updatedBy: 'Tyler', updatedAt: '09:22' },
            { id: 'beta-feedback', title: 'Feedback and findings', areaId: 'beta', parentNoteId: 'beta-overview', content: `${betaFeedback}\n\n## Turn beta findings into product decisions\n### Current step\nGroup repeated findings and make the next product decision explicit.`, updatedBy: 'Fred', updatedAt: '09:28' },
            { id: 'launch-index', title: 'Public launch · context index', areaId: 'launch', parentNoteId: 'launch-brief', content: '# Public launch context\n\nThe project manager uses this index to connect launch decisions to beta evidence.\n\n- [[Launch brief]] — promise and readiness\n- [[Fizzer]] — shared direction\n- [[Feedback and findings]] — observed beta experience', updatedBy: 'Project manager', updatedAt: '09:30' },
            { id: 'launch-brief', title: 'Launch brief', areaId: 'launch', parentNoteId: 'product-overview', content: `${launchBrief}\n\n## Make the public launch promise clear\n### Current step\nRefine first-run language against beta evidence.\n\n## Make first-run onboarding clear\n### Current step\nKeep the first human action visible to a new visitor.`, updatedBy: 'Project manager', updatedAt: '09:38' },
            { id: 'partner-index', title: 'Partner pilot · context index', areaId: 'partner', parentNoteId: 'partner-brief', content: '# Partner pilot context\n\nProposed context for a focused design-partner conversation.\n\n- [[Partner pilot brief]] — scope and guardrails\n- [[Fizzer]] — shared direction', updatedBy: 'Project manager', updatedAt: '09:35' },
            { id: 'partner-brief', title: 'Partner pilot brief', areaId: 'partner', parentNoteId: 'product-overview', content: `${partnerBrief}\n\n## Make first-run onboarding clear\n### Current step\nKeep the partner workflow bounded to one design partner.`, updatedBy: 'Project manager', updatedAt: '09:35' },
            { id: 'mission-refactor-review-notes', title: 'Mission refactor review notes', areaId: 'project-interface', parentNoteId: 'mission-overhaul-note', content: artifactReviewNotes, updatedBy: 'Project manager', updatedAt: '09:30' },
        ],
        artifacts: [
            { id: 'mission-refactor-prototype', parentNoteId: 'mission-overhaul-note', missionId: 'mission-overhaul', title: 'Mission refactor prototype', kind: 'prototype', html: missionRefactorPrototypeHtml },
            { id: 'mission-refactor-layout-image', parentNoteId: 'mission-overhaul-note', missionId: 'mission-overhaul', title: 'Mission refactor relationship map', kind: 'image', src: missionRefactorRelationshipSvg, alt: 'Diagram connecting Fizzer, Project Interface, and Mission refactor.' },
            { id: 'mission-refactor-review-notes', parentNoteId: 'mission-overhaul-note', missionId: 'mission-overhaul', title: 'Mission refactor review notes', kind: 'note', noteId: 'mission-refactor-review-notes' },
            { id: 'mission-overhaul-dispatch', parentNoteId: 'project-interface-note', missionId: 'mission-overhaul', title: 'Mission refactor dispatch', kind: 'note', noteId: 'mission-overhaul-dispatch-note' },
        ],
        changes: [
            { id: 'change-cohort', noteId: 'beta-overview', title: 'Beta test overview', before: betaOverviewBefore, after: betaOverview, author: 'Project manager', at: '09:18' },
            { id: 'change-participants', noteId: 'beta-participants', title: 'Beta participants', before: betaParticipantsBefore, after: betaParticipants, author: 'Tyler', at: '09:22' },
            { id: 'change-feedback', noteId: 'beta-feedback', title: 'Feedback and findings', before: betaFeedbackBefore, after: betaFeedback, author: 'Fred', at: '09:28' },
            { id: 'change-positioning', noteId: 'launch-brief', title: 'Launch brief', before: launchBriefBefore, after: launchBriefBeforeLanguage, author: 'Project manager', at: '09:31' },
            { id: 'change-launch-language-assignment', noteId: 'launch-brief', title: 'Launch brief · language review', before: launchBriefBeforeLanguage, after: launchBrief, author: 'Project manager', at: '09:16' },
            { id: 'change-direction', noteId: 'product-overview', title: 'Product overview', before: productOverviewBefore, after: productOverview, author: 'Project manager', at: '09:12' },
            { id: 'change-partner-scope', noteId: 'partner-brief', title: 'Partner pilot brief', before: partnerBriefBefore, after: partnerBrief, author: 'Project manager', at: '09:35' },
        ],
        noteActivity: [
            { noteId: 'launch-brief', person: 'Diego', kind: 'reviewing', anchor: 'Language review' },
            { noteId: 'launch-brief', person: 'Tyler', kind: 'present', anchor: 'Positioning' },
            { noteId: 'project-interface-note', person: 'Fred', kind: 'reviewing', anchor: 'Mission refactor' },
            { noteId: 'project-interface-note', person: 'Diego', kind: 'reviewing', anchor: 'UX readiness' },
            { noteId: 'project-interface-note', person: 'Tyler', kind: 'present', anchor: 'Create the project agent' },
        ],
        channels: [...base.channels,
            { id: 'project-interface-channel', name: 'project-interface', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'pi1', author: 'Project manager', role: 'pm', body: 'I am carrying the project-chat question into the Project Interface note: what should a mission artifact make easier for the whole team?', at: '09:33' },
                    { id: 'pi2', author: 'Coding orchestrator', role: 'orchestrator', body: 'I saw the group discussion in #product. I am keeping the shared brainstorming context here while the Mission refactor prototype is refined.', at: '09:34' },
                    { id: 'pi3', kind: 'action', author: 'Coding orchestrator', role: 'orchestrator', body: 'Linked project-chat context to the Project Interface note; no Mission refactor UX gate is marked ready yet.', at: '09:35', action: { type: 'cross-chat', missionId: 'mission-overhaul', noteId: 'project-interface-note' } },
                    { id: 'pi4', author: 'Tyler', role: 'human', body: 'Keep the Create the project agent mission in this area with its own document, but do not treat its group-scoping stage as prototype-ready.', at: '09:37' },
                ] },
            { id: 'mission-overhaul-channel', name: 'mission-refactor', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'mr1', author: 'Project manager', role: 'pm', body: 'Mission refactor is its own product document now. We are refining the UX before asking the coding orchestrator for a plan.', at: '09:40' },
                    { id: 'mr2', author: 'Coding orchestrator', role: 'orchestrator', body: 'I can read the Project Interface context and the Mission refactor document, then propose a plan when the human UX reviews are ready.', at: '09:41' },
                    { id: 'mr3', author: 'Diego', role: 'human', body: 'I am reviewing the language and handoff in the mission document, not approving an execution prompt.', at: '09:43' },
                ] },
            { id: 'create-project-agent-channel', name: 'create-project-agent', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'ca1', author: 'Project manager', role: 'pm', body: 'Start with group scoping and ideation here. The prototype comes after the group understands what it wants.', at: '09:45' },
                    { id: 'ca2', author: 'Coding orchestrator', role: 'orchestrator', body: 'I am collecting the group’s questions first; I will not turn this discussion into a plan yet.', at: '09:46' },
                ] },
            { id: 'overhaul-review-fred-channel', name: 'review-mission-refactor-fred', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'rf1', author: 'Fred', role: 'human', body: 'I am checking whether Mission refactor helps me make a product decision without losing the surrounding context.', at: '09:48' },
                ] },
            { id: 'overhaul-review-diego-channel', name: 'review-mission-refactor-diego', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'rd1', author: 'Diego', role: 'human', body: 'I am checking whether the handoff from the mission document to work remains clear and reviewable.', at: '09:49' },
                ] },
            { id: 'overhaul-review-tyler-channel', name: 'review-mission-refactor-tyler', areaId: 'project-interface', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'rt1', author: 'Tyler', role: 'human', body: 'I am checking whether coordination stays visible without treating one person’s response as team approval.', at: '09:50' },
                ] },
            { id: 'beta-channel', name: 'beta-test', areaId: 'beta', mode: 'catch-up', quietMinutes: 15, processedCount: 1, messages: [
                    { id: 'b1', author: 'Fred', role: 'human', body: 'Let’s test with 20 people, and watch them use the project view without explaining it first.', at: '09:00' },
                    { id: 'b2', author: 'Tyler', role: 'human', body: 'I can coordinate invitations. We should ask whether the human approval tasks are easy to find.', at: '09:22' },
                    { id: 'b3', author: 'Diego', role: 'human', body: 'I’ll join the first session. Let’s collect the confusing moments, not just a satisfaction score.', at: '09:24' },
                    { id: 'b4', author: 'Project manager', role: 'pm', body: 'The first round should compare solo and shared-project workflows, then record the moments that need a product decision.', at: '09:26' },
                ] },
            { id: 'beta-feedback-channel', name: 'beta-findings', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'bf1', author: 'Fred', role: 'human', body: 'Two participants searched the project overview for their assigned due date instead of opening the mission.', at: '09:29' },
                    { id: 'bf2', author: 'Tyler', role: 'human', body: 'Let’s make that confusion a finding and decide whether the project overview or mission needs to carry the reminder.', at: '09:31' },
                    { id: 'bf3', author: 'Project manager', role: 'pm', body: 'I linked the finding to the beta notes so the next product decision has the session context attached.', at: '09:33' },
                ] },
            { id: 'launch-channel', name: 'public-launch', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'l1', author: 'Tyler', role: 'human', body: 'The launch story should start with the outcome, not an explanation of our internal roles.', at: '09:32' },
                    { id: 'l2', author: 'Project manager', role: 'pm', body: 'I hear two useful directions: lead with the outcome, or lead with the conversation that produces it. Let’s keep both open until we compare them with the beta notes.', at: '09:34' },
                    { id: 'l3', author: 'Diego', role: 'human', body: 'I can review the first-run language against what participants actually asked us.', at: '09:37' },
                ] },
            { id: 'partner-channel', name: 'partner-pilot', areaId: 'partner', mode: 'catch-up', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'p1', author: 'Project manager', role: 'pm', body: 'The partner pilot remains a proposed area until the beta flow gives us a confident onboarding promise.', at: '09:48' },
                ] },
            ...scopedMissionChannels,
            ...scopedTaskChannels,
        ],
        missions: [
            { id: 'mission-overhaul', title: 'Mission refactor', areaId: 'project-interface', noteId: 'mission-overhaul-note', channelId: 'mission-overhaul-channel', phase: 'planning', currentStep: 'UI refinement', planningPrerequisites: ['overhaul-ux-fred', 'overhaul-ux-diego', 'overhaul-ux-tyler'],
                behavior: 'Mission refactor is its own product document within Project Interface, with work and approvals visible beside the decision context.',
                why: 'Every human must explicitly say the refined UX is ready before implementation planning begins.',
                plan: '## Current step\nUI refinement. The prototype is being tested and refined; implementation planning remains gated on three individual UX-ready calls.',
                conditions: [
                    { id: 'overhaul-ux-fred', text: 'Fred says the Mission refactor UX is ready for the product workflow.', owner: 'human', assignees: ['Fred'], done: false },
                    { id: 'overhaul-ux-diego', text: 'Diego says the Mission refactor UX is ready for language and handoff.', owner: 'human', assignees: ['Diego'], done: false },
                    { id: 'overhaul-ux-tyler', text: 'Tyler says the Mission refactor UX is ready for team coordination.', owner: 'human', assignees: ['Tyler'], done: false },
                    { id: 'overhaul-implementation-plan', text: 'The team agrees on the implementation plan after the UX gate.', owner: 'agent', done: false },
                    { id: 'overhaul-delivery', text: 'The implemented Mission refactor meets the agreed delivery criteria.', owner: 'agent', done: false },
                ],
            },
            { id: 'create-project-agent', title: 'Create the project agent', areaId: 'project-interface', noteId: 'create-project-agent-note', channelId: 'create-project-agent-channel', phase: 'proposal', currentStep: 'Group scoping and ideation',
                behavior: 'The project agent helps the group shape what it wants before a prototype or implementation direction is chosen.',
                why: 'The group needs shared intent before the agent can help prototype or deliver anything.',
                plan: '## Current step\nGroup scoping and ideation in the group chat.\n\n## Next steps\nPrototype the agreed direction, then settle implementation and delivery criteria.',
                conditions: [
                    { id: 'agent-group-scope', text: 'The group agrees on the desired outcome and constraints before prototyping.', owner: 'human', done: false },
                    { id: 'agent-prototype', text: 'A prototype reflects the scoped group direction.', owner: 'agent', done: false },
                    { id: 'agent-delivery', text: 'Implementation and delivery criteria are agreed after prototype review.', owner: 'agent', done: false },
                ],
            },
            { id: 'beta-invitations', title: 'Make beta invitations effortless', areaId: 'beta', noteId: 'beta-invitations-note', channelId: 'beta-invitations-channel', phase: 'plan-review',
                behavior: 'A beta participant can accept an invitation, enter the right project, and find their first action without assistance.',
                why: 'The first beta session should teach us about the product—not be spent troubleshooting access.',
                plan: '# Implementation plan\n\n## Approach\nTrace invitation and project-opening flow while keeping the first human task visible.',
                conditions: [
                    { id: 'invite-check', text: 'New and returning participants reach the invited project.', owner: 'agent', done: false },
                    { id: 'task-check', text: 'Assigned human work remains visible after opening the project.', owner: 'agent', done: false },
                    { id: 'human-check', text: 'Try the invitation flow with a participant, without explaining the interface.', owner: 'human', done: false },
                ],
            },
            { id: 'beta-feedback-loop', title: 'Turn beta findings into product decisions', areaId: 'beta', noteId: 'beta-feedback-loop-note', channelId: 'beta-feedback-loop-channel', phase: 'proposal',
                behavior: 'After each beta session, the team can capture a confusing moment, connect it to the relevant note, and decide what should change next.',
                why: 'Repeated observations should become shared product decisions rather than scattered comments.',
                plan: '## Proposed approach\nCapture session findings in the beta notes and review resulting priorities in the beta channel.',
                conditions: [
                    { id: 'feedback-note', text: 'Each session produces a dated finding linked from the beta notes.', owner: 'human', done: false },
                    { id: 'feedback-decision', text: 'Repeated findings become an explicit product decision or follow-up task.', owner: 'human', done: false },
                ],
            },
            { id: 'launch-readiness', title: 'Make the public launch promise clear', areaId: 'launch', noteId: 'launch-readiness-note', channelId: 'launch-readiness-channel', phase: 'planning',
                behavior: 'A first-time visitor understands what Fizzer helps a team do and can start a project without a guided explanation.',
                why: 'The public launch should make the product’s core promise legible before adding more surface area.',
                plan: '## Planning direction\nUse beta evidence to refine first-run language and review the path with people who did not join the beta.',
                conditions: [
                    { id: 'launch-message', text: 'The launch page explains the product outcome in language participants understand.', owner: 'agent', done: false },
                    { id: 'launch-language-review', text: 'Diego reviews the launch language against participant evidence.', owner: 'human', assignees: ['Diego'], done: false },
                    { id: 'launch-first-run', text: 'A new visitor can start a project without a guided explanation.', owner: 'human', done: false },
                ],
            },
            { id: 'partner-onboarding', title: 'Make first-run onboarding clear', areaId: 'launch', noteId: 'partner-onboarding-note', channelId: 'partner-onboarding-channel', phase: 'executing',
                behavior: 'A new visitor can start a project, understand where their first action belongs, and return to the work without a guided explanation.',
                why: 'Beta participants repeatedly looked for the first task after entering a project.',
                plan: '## Execution plan\nPrepare one guided first-run path and observe whether the resulting work is understandable.',
                conditions: [
                    { id: 'partner-entry', text: 'A visitor reaches the intended first project area.', owner: 'agent', done: true },
                    { id: 'partner-work', text: 'The visitor can identify the first task after entering the project.', owner: 'agent', done: false },
                    { id: 'partner-human', text: 'A new visitor starts the workflow without our team taking over the explanation.', owner: 'human', done: false },
                ],
            },
        ],
        tasks: [
            { id: 'overhaul-review-fred', title: 'Review Mission refactor UX', description: 'Review the Mission refactor document and say whether the UX is ready for the product workflow.', areaId: 'project-interface', missionId: 'mission-overhaul', noteId: 'overhaul-review-fred-note', kind: 'human', assignees: ['Fred'], dueDate: '', priority: 'P1', status: 'todo', conditionId: 'overhaul-ux-fred', channelId: 'overhaul-review-fred-channel', action: 'verify' },
            { id: 'overhaul-review-diego', title: 'Review Mission refactor handoff', description: 'Review the Mission refactor document and say whether language and handoff UX are ready.', areaId: 'project-interface', missionId: 'mission-overhaul', noteId: 'overhaul-review-diego-note', kind: 'human', assignees: ['Diego'], dueDate: '', priority: 'P1', status: 'todo', conditionId: 'overhaul-ux-diego', channelId: 'overhaul-review-diego-channel', action: 'verify' },
            { id: 'overhaul-review-tyler', title: 'Review Mission refactor coordination', description: 'Review the Mission refactor document and say whether team coordination UX is ready.', areaId: 'project-interface', missionId: 'mission-overhaul', noteId: 'overhaul-review-tyler-note', kind: 'human', assignees: ['Tyler'], dueDate: '', priority: 'P1', status: 'todo', conditionId: 'overhaul-ux-tyler', channelId: 'overhaul-review-tyler-channel', action: 'verify' },
            { id: 'approve-mission', title: 'Approve the beta invitation mission', description: 'Review the intended behavior, rationale, and delivery conditions.', areaId: 'beta', missionId: 'beta-invitations', noteId: 'approve-mission-note', channelId: 'approve-mission-channel', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-16', priority: 'P1', status: 'done', action: 'approve-mission', completedBy: 'Fred' },
            { id: 'approve-plan-beta', title: 'Approve the beta invitation implementation plan', description: 'Review the orchestrator’s accepted plan before implementation starts.', areaId: 'beta', missionId: 'beta-invitations', noteId: 'approve-plan-beta-note', channelId: 'approve-plan-beta-channel', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-plan' },
            { id: 'beta-session-review', title: 'Review the first beta session plan', description: 'Confirm which participant moments Fred and Diego will observe during the first round.', areaId: 'beta', missionId: null, noteId: 'beta-session-review-note', channelId: 'beta-session-review-channel', kind: 'human', assignees: ['Fred', 'Diego'], dueDate: '2026-09-17', priority: 'P1', status: 'in-progress' },
            { id: 'beta-cohort', title: 'Choose the first beta cohort', description: 'Select participants representing solo and shared-project workflows.', areaId: 'beta', missionId: null, noteId: 'beta-cohort-note', channelId: 'beta-cohort-channel', kind: 'human', assignees: ['Tyler'], dueDate: '2026-09-15', priority: 'P1', status: 'done' },
            { id: 'feedback-synthesis', title: 'Synthesize recurring beta findings', description: 'Group the first session observations in the Feedback and findings note.', areaId: 'beta', missionId: 'beta-feedback-loop', noteId: 'feedback-synthesis-note', channelId: 'feedback-synthesis-channel', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-23', priority: 'P1', status: 'todo' },
            { id: 'approve-launch-mission', title: 'Approve the public launch mission', description: 'Review the launch outcome and authorize technical planning.', areaId: 'launch', missionId: 'launch-readiness', noteId: 'approve-launch-mission-note', channelId: 'approve-launch-mission-channel', kind: 'human', assignees: ['Tyler', 'Fred'], dueDate: '2026-09-19', priority: 'P1', status: 'done', action: 'approve-mission', completedBy: 'Tyler' },
            { id: 'launch-copy-review', title: 'Review the first-run launch language', description: 'Read the launch brief and identify language that needs a participant’s perspective.', areaId: 'launch', missionId: 'launch-readiness', channelId: 'launch-copy-review-channel', noteId: 'launch-copy-review-note', kind: 'human', assignees: ['Diego'], dueDate: '2026-09-25', priority: 'P2', status: 'todo', conditionId: 'launch-language-review', action: 'verify' },
            { id: 'launch-stakeholder-review', title: 'Review launch readiness with Tyler', description: 'Agree on the public promise and the evidence still needed before September 30.', areaId: 'launch', missionId: null, noteId: 'launch-stakeholder-review-note', channelId: 'launch-stakeholder-review-channel', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-25', priority: 'P1', status: 'in-progress' },
            { id: 'launch-message-agent', title: 'Refine the first-run product message', description: 'Compare the launch promise with beta findings and propose clear visitor-facing language.', areaId: 'launch', missionId: 'launch-readiness', noteId: 'launch-message-agent-note', channelId: 'launch-message-agent-channel', kind: 'agent', assignees: ['Language agent'], dueDate: '2026-09-22', priority: 'P1', status: 'todo', conditionId: 'launch-message' },
            { id: 'partner-approve-mission', title: 'Approve the first-run onboarding mission', description: 'Confirm the onboarding outcome and its launch guardrails.', areaId: 'launch', missionId: 'partner-onboarding', noteId: 'partner-approve-mission-note', channelId: 'partner-approve-mission-channel', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-20', priority: 'P2', status: 'done', action: 'approve-mission', completedBy: 'Fred' },
            { id: 'partner-context-agent', title: 'Connect the first visitor to a project area', description: 'Prepare the first-run context path from the launch brief and beta findings.', areaId: 'launch', missionId: 'partner-onboarding', noteId: 'partner-context-agent-note', channelId: 'partner-context-agent-channel', kind: 'agent', assignees: ['Context agent'], dueDate: '2026-09-21', priority: 'P2', status: 'done', conditionId: 'partner-entry' },
            { id: 'partner-work-agent', title: 'Make the first task visible', description: 'Ensure a new visitor can identify accountable work after entering the project.', areaId: 'launch', missionId: 'partner-onboarding', noteId: 'partner-work-agent-note', channelId: 'partner-work-agent-channel', kind: 'agent', assignees: ['Workflow agent'], dueDate: '2026-09-23', priority: 'P2', status: 'in-progress', conditionId: 'partner-work' },
            { id: 'partner-human-check', title: 'Run the first-run onboarding session', description: 'Observe whether a new visitor can start without our team taking over the explanation.', areaId: 'launch', missionId: 'partner-onboarding', noteId: 'partner-human-check-note', channelId: 'partner-human-check-channel', conditionId: 'partner-human', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-25', priority: 'P1', status: 'todo', action: 'verify-mission' },
            { id: 'public-date', title: 'Confirm the September 30 launch date', description: 'Choose the public date after reviewing beta evidence and launch readiness.', areaId: 'launch', missionId: null, noteId: 'public-date-note', channelId: 'public-date-channel', kind: 'human', assignees: ['Tyler'], dueDate: '2026-09-24', priority: 'P1', status: 'todo' },
        ],
    };
}
