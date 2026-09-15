export const PEOPLE = ['Fred', 'Tyler', 'Diego'];
export const PHASE_LABELS = {
    proposal: 'Mission approval', planning: 'Planning', 'plan-review': 'Plan approval',
    executing: 'Executing', verification: 'Delivery checks', complete: 'Complete',
};
export const STATUS_LABELS = { todo: 'To do', 'in-progress': 'In progress', done: 'Done' };
export const nowLabel = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const newId = () => crypto.randomUUID();
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
        areas: [], tasks: [], notes: [], changes: [], missions: [],
        channels: [{ id: 'general', name: 'product', areaId: null, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'g1', author: 'Tyler', role: 'human', body: greenfield ? 'Let’s shape the product together before we start building.' : 'Our next priority is a useful beta, not a bigger feature list.', at: '09:10' },
                    { id: 'g2', author: 'Project manager', role: 'pm', body: greenfield ? 'Who is this product for, and what should become easier for them?' : 'The beta invitation flow is the next priority. I have proposed a separate Public launch area for the next release.', at: '09:12' },
                    { id: 'g3', author: 'Diego', role: 'human', body: greenfield ? 'Let’s start with the people and situations this should serve.' : 'I can review the launch language once the beta sessions give us stronger evidence.', at: '09:15' },
                ] }],
    };
    if (greenfield)
        return base;

    const betaOverviewBefore = '# Beta test\n\nLearn whether new participants can start a useful project without assistance.\n\n## Participants\nInvite 12 people from the early-access list.\n\n## What we need to learn\n- Can people understand projects and areas?\n- Can they find work assigned to them?';
    const betaOverview = '# Beta test\n\nLearn whether new participants can start a useful project without assistance.\n\n## Participants\nInvite 20 people from the early-access list.\n\n## What we need to learn\n- Can people understand projects and areas?\n- Can they find work assigned to them?\n- Can they distinguish the project manager from the coding orchestrator?';
    const betaParticipantsBefore = '# Beta participants\n\nCohort: 12 people from the early-access list.\n\nTyler coordinates invitations. Fred runs the first usability sessions.';
    const betaParticipants = '# Beta participants\n\nCohort: 20 people from the early-access list.\n\nTyler coordinates invitations. Fred runs the first usability sessions. Diego observes the first three sessions and records confusing moments.\n\n## Consent\nParticipants opt in through the invitation and may withdraw after each session.';
    const betaFeedbackBefore = '# Feedback and findings\n\n## Questions for the first round\n- Is it clear what requires a human action?\n- Can participants navigate from a project to its missions?';
    const betaFeedback = '# Feedback and findings\n\n## Questions for the first round\n- Is it clear what requires a human action?\n- Can participants navigate from a project to its missions?\n- Can they tell who is responsible for product decisions and technical execution?\n\n## Findings\nParticipants want their own due dates visible without opening every mission. Two people looked for the mission conversation beside the work list.';
    const productOverviewBefore = '# Fizzer\n\nA shared place for humans and agents to define a product and deliver it together.\n\n## Current priority\nMake the beta useful.';
    const productOverview = '# Fizzer\n\nA shared place for humans and agents to define a product and deliver it together.\n\n## Current priority\nMake the beta useful: collaborative product discovery, clear human responsibilities, and understandable mission execution.\n\n## Near-term direction\nUse the beta evidence to shape a confident public launch promise.';
    const launchBriefBefore = '# Public launch\n\n## Intended outcome\nHelp people understand Fizzer and start a shared project.\n\n## Open questions\nWhat have we learned from the beta?';
    const launchBrief = '# Public launch\n\n## Intended outcome\nHelp people understand Fizzer and start a shared project.\n\n## Positioning\nFizzer helps a small team turn product conversations into visible, accountable work.\n\n## Launch readiness\nUse beta findings to explain the project, area, and mission relationship without requiring a guided tour. The public date is September 30.';
    const partnerBriefBefore = '# Partner pilot\n\n## Open questions\nWhich partner workflow is a useful next test?';
    const partnerBrief = '# Partner pilot\n\n## Intended outcome\nTest Fizzer with one design partner whose team already documents product decisions.\n\n## Guardrails\nStart with a single workspace and a short onboarding session. Do not promise integrations or shared hosting in this pilot.';

    return { ...base,
        areas: [
            { id: 'beta', name: 'Beta test', summary: 'Help 20 participants try a complete project workflow and turn their experience into improvements.', status: 'active', noteIds: ['beta-index', 'beta-overview', 'beta-participants', 'beta-feedback'], channelId: 'beta-channel' },
            { id: 'launch', name: 'Public launch', summary: 'Turn the beta evidence into a clear public promise and a calm first-run experience.', status: 'active', noteIds: ['launch-index', 'launch-brief'], channelId: 'launch-channel' },
            { id: 'partner', name: 'Partner pilot', summary: 'Proposed focused pilot with one design partner after the beta invitation workflow is understood.', status: 'proposed', noteIds: ['partner-index', 'partner-brief'], channelId: 'partner-channel' },
        ],
        notes: [
            { id: 'product-overview', title: 'Product overview', areaId: null, content: productOverview, updatedBy: 'Project manager', updatedAt: '09:12' },
            { id: 'beta-index', title: 'Beta test · context index', areaId: 'beta', content: '# Beta test context\n\nThe project manager uses this index to load the product notes relevant to the beta.\n\n- [[Beta test overview]] — goals and questions\n- [[Beta participants]] — cohort and consent\n- [[Feedback and findings]] — what people are telling us\n- [[Product overview]] — shared product direction\n\nImplementation details remain in the engineering repository.', updatedBy: 'Project manager', updatedAt: '09:18' },
            { id: 'beta-overview', title: 'Beta test overview', areaId: 'beta', content: betaOverview, updatedBy: 'Project manager', updatedAt: '09:18' },
            { id: 'beta-participants', title: 'Beta participants', areaId: 'beta', content: betaParticipants, updatedBy: 'Tyler', updatedAt: '09:22' },
            { id: 'beta-feedback', title: 'Feedback and findings', areaId: 'beta', content: betaFeedback, updatedBy: 'Fred', updatedAt: '09:28' },
            { id: 'launch-index', title: 'Public launch · context index', areaId: 'launch', content: '# Public launch context\n\nThe project manager uses this index to connect launch decisions to beta evidence.\n\n- [[Launch brief]] — promise and readiness\n- [[Product overview]] — shared direction\n- [[Feedback and findings]] — observed beta experience', updatedBy: 'Project manager', updatedAt: '09:30' },
            { id: 'launch-brief', title: 'Launch brief', areaId: 'launch', content: launchBrief, updatedBy: 'Project manager', updatedAt: '09:31' },
            { id: 'partner-index', title: 'Partner pilot · context index', areaId: 'partner', content: '# Partner pilot context\n\nProposed context for a focused design-partner conversation.\n\n- [[Partner pilot brief]] — scope and guardrails\n- [[Product overview]] — shared direction', updatedBy: 'Project manager', updatedAt: '09:35' },
            { id: 'partner-brief', title: 'Partner pilot brief', areaId: 'partner', content: partnerBrief, updatedBy: 'Project manager', updatedAt: '09:35' },
        ],
        changes: [
            { id: 'change-cohort', noteId: 'beta-overview', title: 'Beta test overview', before: betaOverviewBefore, after: betaOverview, author: 'Project manager', at: '09:18' },
            { id: 'change-participants', noteId: 'beta-participants', title: 'Beta participants', before: betaParticipantsBefore, after: betaParticipants, author: 'Tyler', at: '09:22' },
            { id: 'change-feedback', noteId: 'beta-feedback', title: 'Feedback and findings', before: betaFeedbackBefore, after: betaFeedback, author: 'Fred', at: '09:28' },
            { id: 'change-positioning', noteId: 'launch-brief', title: 'Launch brief', before: launchBriefBefore, after: launchBrief, author: 'Project manager', at: '09:31' },
            { id: 'change-direction', noteId: 'product-overview', title: 'Product overview', before: productOverviewBefore, after: productOverview, author: 'Project manager', at: '09:12' },
            { id: 'change-partner-scope', noteId: 'partner-brief', title: 'Partner pilot brief', before: partnerBriefBefore, after: partnerBrief, author: 'Project manager', at: '09:35' },
        ],
        channels: [...base.channels,
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
                    { id: 'l2', author: 'Project manager', role: 'pm', body: 'I am carrying the beta findings into the launch brief so the promise stays grounded in observed behavior.', at: '09:34' },
                    { id: 'l3', author: 'Diego', role: 'human', body: 'I will review the first-run language against what participants actually asked us.', at: '09:37' },
                ] },
            { id: 'mission-channel', name: 'beta-invitations', areaId: 'beta', mode: 'live', quietMinutes: 15, processedCount: 1, messages: [
                    { id: 'o1', author: 'Coding orchestrator', role: 'orchestrator', body: 'The mission definition is approved. I have accepted the planning result and am waiting for one human approval of the implementation plan.', at: '09:40' },
                    { id: 'o2', author: 'Fred', role: 'human', body: 'I want the plan to preserve the invited project destination for both new and returning participants.', at: '09:42' },
                    { id: 'o3', author: 'Tyler', role: 'human', body: 'The first human task must remain visible after the participant enters the project.', at: '09:44' },
                ] },
            { id: 'launch-readiness-channel', name: 'launch-readiness', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'lr1', author: 'Coding orchestrator', role: 'orchestrator', body: 'The launch-readiness mission is in planning. I am organizing the work around the promise in the launch brief.', at: '09:46' },
                ] },
            { id: 'partner-channel', name: 'partner-pilot', areaId: 'partner', mode: 'catch-up', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'p1', author: 'Project manager', role: 'pm', body: 'The partner pilot remains a proposed area until the beta flow gives us a confident onboarding promise.', at: '09:48' },
                ] },
            { id: 'partner-onboarding-channel', name: 'first-run-onboarding', areaId: 'launch', mode: 'live', quietMinutes: 15, processedCount: 0, messages: [
                    { id: 'po1', author: 'Coding orchestrator', role: 'orchestrator', body: 'The first-run onboarding slice is underway against the launch brief and the beta findings.', at: '09:50' },
                ] },
        ],
        missions: [
            { id: 'beta-invitations', title: 'Make beta invitations effortless', areaId: 'beta', channelId: 'mission-channel', phase: 'plan-review',
                behavior: 'A beta participant can accept an invitation, enter the right project, and find their first action without assistance.',
                why: 'The first beta session should teach us about the product—not be spent troubleshooting access.',
                plan: '# Implementation plan\n\n## Approach\n1. Trace the existing invitation and project-opening flow for new and returning accounts.\n2. Add a clear invitation landing state while preserving the intended project destination.\n3. Keep the first human task visible from the project overview.\n4. Exercise both account paths and prepare evidence for the usability session.\n\n## Assignments\n- Access agent: invitation and project entry.\n- Experience agent: first-task visibility and UI states.\n- Validation: automated flow checks and evidence for the human usability session.',
                conditions: [
                    { id: 'invite-check', text: 'New and returning participants reach the invited project.', owner: 'agent', done: false },
                    { id: 'task-check', text: 'Assigned human work remains visible after opening the project.', owner: 'agent', done: false },
                    { id: 'human-check', text: 'Try the invitation flow with a participant, without explaining the interface.', owner: 'human', done: false },
                ],
            },
            { id: 'beta-feedback-loop', title: 'Turn beta findings into product decisions', areaId: 'beta', channelId: 'beta-feedback-channel', phase: 'proposal',
                behavior: 'After each beta session, the team can capture a confusing moment, connect it to the relevant note, and decide what should change next.',
                why: 'Fast learning only helps when observations become shared product decisions rather than scattered comments.',
                plan: '## Proposed approach\nCapture session findings in the beta notes, group repeated moments, and review the resulting priorities in the beta channel.',
                conditions: [
                    { id: 'feedback-note', text: 'Each session produces a dated finding linked from the beta notes.', owner: 'human', done: false },
                    { id: 'feedback-decision', text: 'Repeated findings become an explicit product decision or follow-up task.', owner: 'human', done: false },
                ],
            },
            { id: 'launch-readiness', title: 'Make the public launch promise clear', areaId: 'launch', channelId: 'launch-readiness-channel', phase: 'planning',
                behavior: 'A first-time visitor understands what Fizzer helps a team do and can start a project without a guided explanation.',
                why: 'The public launch should make the product’s core promise legible before adding more surface area.',
                plan: '## Planning direction\nUse beta evidence to refine the first-run language, connect the launch brief to the project view, and review the path with people who did not join the beta.',
                conditions: [
                    { id: 'launch-message', text: 'The launch page explains the product outcome in language participants understand.', owner: 'agent', done: false },
                    { id: 'launch-first-run', text: 'A new visitor can start a project without a guided explanation.', owner: 'human', done: false },
                ],
            },
            { id: 'partner-onboarding', title: 'Make first-run onboarding clear', areaId: 'launch', channelId: 'partner-onboarding-channel', phase: 'executing',
                behavior: 'A new visitor can start a project, understand where their first action belongs, and return to the work without a guided explanation.',
                why: 'Beta participants repeatedly looked for the first task after entering a project; the public launch should make that path obvious.',
                plan: '## Execution plan\nPrepare one guided first-run path, connect the visitor’s first question to a project area, and observe whether the resulting mission and tasks are understandable.',
                conditions: [
                    { id: 'partner-entry', text: 'A visitor reaches the intended first project area.', owner: 'agent', done: true },
                    { id: 'partner-work', text: 'The visitor can identify the first task after entering the project.', owner: 'agent', done: false },
                    { id: 'partner-human', text: 'A new visitor starts the workflow without our team taking over the explanation.', owner: 'human', done: false },
                ],
            },
        ],
        tasks: [
            { id: 'approve-mission', title: 'Approve the beta invitation mission', description: 'Review the intended behavior, rationale, and delivery conditions.', areaId: 'beta', missionId: 'beta-invitations', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-16', priority: 'P1', status: 'done', action: 'approve-mission', completedBy: 'Fred' },
            { id: 'approve-plan-beta', title: 'Approve the beta invitation implementation plan', description: 'Review the orchestrator’s accepted plan before implementation starts.', areaId: 'beta', missionId: 'beta-invitations', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-plan' },
            { id: 'beta-session-review', title: 'Review the first beta session plan', description: 'Confirm which participant moments Fred and Diego will observe during the first round.', areaId: 'beta', missionId: null, kind: 'human', assignees: ['Fred', 'Diego'], dueDate: '2026-09-17', priority: 'P1', status: 'in-progress' },
            { id: 'beta-cohort', title: 'Choose the first beta cohort', description: 'Select participants representing solo and shared-project workflows.', areaId: 'beta', missionId: null, kind: 'human', assignees: ['Tyler'], dueDate: '2026-09-15', priority: 'P1', status: 'done' },
            { id: 'feedback-synthesis', title: 'Synthesize recurring beta findings', description: 'Group the first session observations in the Feedback and findings note.', areaId: 'beta', missionId: 'beta-feedback-loop', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-23', priority: 'P1', status: 'todo' },
            { id: 'approve-launch-mission', title: 'Approve the public launch mission', description: 'Review the launch outcome and authorize technical planning.', areaId: 'launch', missionId: 'launch-readiness', kind: 'human', assignees: ['Tyler', 'Fred'], dueDate: '2026-09-19', priority: 'P1', status: 'done', action: 'approve-mission', completedBy: 'Tyler' },
            { id: 'launch-copy-review', title: 'Review the first-run launch language', description: 'Read the launch brief and identify language that needs a participant’s perspective.', areaId: 'launch', missionId: null, kind: 'human', assignees: ['Diego'], dueDate: '2026-09-25', priority: 'P2', status: 'todo' },
            { id: 'launch-stakeholder-review', title: 'Review launch readiness with Tyler', description: 'Agree on the public promise and the evidence still needed before September 30.', areaId: 'launch', missionId: null, kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-25', priority: 'P1', status: 'in-progress' },
            { id: 'launch-message-agent', title: 'Refine the first-run product message', description: 'Compare the launch promise with beta findings and propose clear visitor-facing language.', areaId: 'launch', missionId: 'launch-readiness', kind: 'agent', assignees: ['Language agent'], dueDate: '2026-09-22', priority: 'P1', status: 'todo', conditionId: 'launch-message' },
            { id: 'partner-approve-mission', title: 'Approve the first-run onboarding mission', description: 'Confirm the onboarding outcome and its launch guardrails.', areaId: 'launch', missionId: 'partner-onboarding', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-20', priority: 'P2', status: 'done', action: 'approve-mission', completedBy: 'Fred' },
            { id: 'partner-context-agent', title: 'Connect the first visitor to a project area', description: 'Prepare the first-run context path from the launch brief and beta findings.', areaId: 'launch', missionId: 'partner-onboarding', kind: 'agent', assignees: ['Context agent'], dueDate: '2026-09-21', priority: 'P2', status: 'done', conditionId: 'partner-entry' },
            { id: 'partner-work-agent', title: 'Make the first task visible', description: 'Ensure a new visitor can identify accountable work after entering the project.', areaId: 'launch', missionId: 'partner-onboarding', kind: 'agent', assignees: ['Workflow agent'], dueDate: '2026-09-23', priority: 'P2', status: 'in-progress', conditionId: 'partner-work' },
            { id: 'partner-human-check', title: 'Run the first-run onboarding session', description: 'Observe whether a new visitor can start without our team taking over the explanation.', areaId: 'launch', missionId: 'partner-onboarding', conditionId: 'partner-human', kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '2026-09-25', priority: 'P1', status: 'todo', action: 'verify-mission' },
            { id: 'public-date', title: 'Confirm the September 30 launch date', description: 'Choose the public date after reviewing beta evidence and launch readiness.', areaId: 'launch', missionId: null, kind: 'human', assignees: ['Tyler'], dueDate: '2026-09-24', priority: 'P1', status: 'todo' },
        ],
    };
}
