import { PHASE_LABELS, STATUS_LABELS, newId, patchPrototypeTask } from './projects-areas-prototype-model.js';

const tabsByApp = new WeakMap();

const text = value => String(value ?? '');
const escape = (app, value) => app.escape(text(value));
const missionFor = (app, missionId) => app.state.missions.find(item => item.id === missionId);
const tasksFor = (app, missionId) => app.state.tasks.filter(item => item.missionId === missionId);
const taskForAction = (app, missionId, action) => tasksFor(app, missionId).find(item => item.action === action);
const conditionFor = (mission, id) => mission?.conditions?.find(item => item.id === id);

function taskStatus(app, missionId, conditionId) {
    return tasksFor(app, missionId).find(item => item.conditionId === conditionId)?.status;
}

function phaseChip(app, mission) {
    return `<span class="pp-chip prototype-mission-phase">${escape(app, PHASE_LABELS[mission.phase] || mission.phase)}</span>`;
}

function previewPlan(mission) {
    const conditions = (mission.conditions || []).map(condition => `- Confirm: ${condition.text}`).join('\n');
    return `## Delivery approach\n\nClarify the current flow, make the smallest change that satisfies the intended behavior, and review the outcome against the delivery conditions.\n\n## Delivery conditions\n${conditions}`;
}

function previewControls(app, mission) {
    const actions = [];
    if (mission.phase === 'planning')
        actions.push('<button class="pp-button primary" data-action="simulate-planning">Simulate planning result</button>');
    if (mission.phase === 'executing')
        actions.push('<button class="pp-button primary" data-action="simulate-implementation">Simulate implementation results</button>');
    if (!actions.length)
        return '';
    return `<details class="prototype-mission-preview-controls"><summary>Preview controls</summary><div>${actions.join('')}<span>Advances local workflow state; no external work is started.</span></div></details>`;
}

function renderBrief(app, mission) {
    const conditions = (mission.conditions || []).map(condition => `
        <li class="prototype-mission-condition-edit">
            <span class="prototype-mission-owner-chip">${escape(app, condition.owner === 'human' ? 'Human check' : 'Agent check')}</span>
            <input class="pp-field" data-condition-id="${escape(app, condition.id)}" aria-label="Delivery condition" value="${escape(app, condition.text)}">
        </li>`).join('');
    return `<section class="mission-view prototype-mission-view" data-view="brief" aria-labelledby="mission-brief-heading">
        <div class="prototype-mission-heading">
            <div><div class="eyebrow">Mission definition</div><h1 id="mission-brief-heading">What should be delivered</h1></div>
            <span class="pp-muted">Edits are local to this session</span>
        </div>
        <div class="note-document prototype-mission-definition">
            <label class="prototype-mission-field-label" for="mission-behavior">Intended behavior</label>
            <textarea id="mission-behavior" class="pp-field prototype-mission-textarea" data-mission-field="behavior">${escape(app, mission.behavior)}</textarea>
            <label class="prototype-mission-field-label" for="mission-why">Rationale</label>
            <textarea id="mission-why" class="pp-field prototype-mission-textarea" data-mission-field="why">${escape(app, mission.why)}</textarea>
            <div class="prototype-mission-checklist-head"><label class="prototype-mission-field-label" for="mission-condition-first">Delivery checklist</label><span class="pp-muted">${escape(app, mission.conditions.filter(item => item.done).length)}/${escape(app, mission.conditions.length)} complete</span></div>
            <ul class="prototype-mission-condition-editor" id="mission-condition-first">${conditions}</ul>
        </div>
        ${mission.phase === 'proposal' ? `<div class="prototype-mission-approval"><div><strong>Human approval required</strong><p>Approve this product definition to authorize planning. One assigned human is enough.</p></div><button class="pp-button primary" data-action="approve-mission">Approve mission</button>${taskForAction(app, mission.id, 'approve-mission') ? `<button class="pp-button" data-open-task="${escape(app, taskForAction(app, mission.id, 'approve-mission').id)}">Open approval task</button>` : ''}</div>` : ''}
        ${taskForAction(app, mission.id, 'approve-mission')?.status === 'done' ? `<div class="prototype-mission-success">Mission approved by ${escape(app, taskForAction(app, mission.id, 'approve-mission').completedBy || app.state.currentUser)}.</div>` : ''}
    </section>`;
}

function renderPlan(app, mission) {
    if (mission.phase === 'proposal') return `<section class="mission-view prototype-mission-view"><h1>Product definition first</h1><p class="pp-muted">Approve the mission before the coding orchestrator commissions planning.</p><button class="pp-button" data-mission-tab="brief">Review mission definition</button></section>`;
    const planTask = taskForAction(app, mission.id, 'approve-plan');
    const canApprove = mission.phase === 'plan-review' && Boolean(planTask);
    return `<section class="mission-view prototype-mission-view" data-view="plan" aria-labelledby="mission-plan-heading">
        <div class="prototype-mission-heading">
            <div><div class="eyebrow">Implementation plan</div><h1 id="mission-plan-heading">How the work will be done</h1></div>
            ${mission.phase === 'planning' ? '<span class="pp-muted">Planning result is not accepted yet</span>' : ''}
        </div>
        <div class="prototype-mission-plan-card">
            <label class="prototype-mission-field-label" for="mission-plan">Editable plan</label>
            <textarea id="mission-plan" class="pp-field prototype-mission-plan" data-mission-field="plan">${escape(app, mission.plan)}</textarea>
        </div>
        ${previewControls(app, mission)}
        ${canApprove ? `<div class="prototype-mission-approval"><div><strong>Human approval required</strong><p>Review the plan, then approve implementation. One assigned human is enough.</p></div><button class="pp-button primary" data-action="approve-plan">Approve implementation plan</button><button class="pp-button" data-open-task="${escape(app, planTask.id)}">Open approval task</button></div>` : ''}
        ${planTask?.status === 'done' ? `<div class="prototype-mission-success">Implementation plan approved by ${escape(app, planTask.completedBy || app.state.currentUser)}.</div>` : ''}
    </section>`;
}

function conditionRow(app, mission, condition) {
    const linkedTask = tasksFor(app, mission.id).find(item => item.conditionId === condition.id);
    const isHuman = condition.owner === 'human';
    const canCheck = isHuman && ['verification', 'complete'].includes(mission.phase) && Boolean(linkedTask);
    return `<li class="prototype-mission-condition ${condition.done ? 'is-done' : ''}">
        ${canCheck ? `<input type="checkbox" data-condition-toggle="${escape(app, condition.id)}" aria-label="Mark delivery condition complete" ${condition.done ? 'checked' : ''}>` : `<span class="prototype-mission-condition-mark" aria-hidden="true">${condition.done ? '✓' : '○'}</span>`}
        <span class="prototype-mission-condition-copy"><strong>${escape(app, condition.text)}</strong><small>${escape(app, isHuman ? 'Human acceptance check' : 'Agent-verifiable condition')} · ${escape(app, condition.done ? 'Complete' : (taskStatus(app, mission.id, condition.id) === 'in-progress' ? 'In progress' : 'Not started'))}</small></span>
        ${linkedTask ? `<button class="pp-button" data-open-task="${escape(app, linkedTask.id)}">${isHuman ? 'Open task' : 'View task'}</button>` : ''}
    </li>`;
}

function workerDetails(app, mission) {
    if (!['verification', 'complete'].includes(mission.phase)) return '';
    const agentTasks = tasksFor(app, mission.id).filter(item => item.kind === 'agent');
    if (!agentTasks.length) return '';
    const rows = agentTasks.map(task => `<li><strong>${escape(app, task.title)}</strong><span>${escape(app, task.assignee || (task.assignees || []).join(', ') || 'Coding agent')} · ${escape(app, STATUS_LABELS[task.status] || task.status)}</span></li>`).join('');
    return `<section class="prototype-mission-worker-panel" data-worker-panel hidden aria-labelledby="worker-details-heading"><div class="prototype-mission-worker-head"><div><h2 id="worker-details-heading">Sample worker details</h2><p>Illustrative implementation activity for this mission.</p></div><button class="pp-button" data-action="hide-worker-details">Hide details</button></div><ul>${rows}</ul><div class="prototype-mission-trace"><strong>Illustrative trace</strong><code>coding agent → inspect invitation flow → record result</code><small>Simulated trace; elapsed time and cost are not available.</small></div></section>`;
}

function renderWork(app, mission) {
    const tasks = tasksFor(app, mission.id);
    const humanTasks = tasks.filter(item => item.kind === 'human');
    const agentTasks = tasks.filter(item => item.kind === 'agent');
    const humanCheck = mission.conditions.find(item => item.owner === 'human');
    const verificationTask = humanCheck ? tasks.find(item => item.conditionId === humanCheck.id) : null;
    const canShowWorkers = ['verification', 'complete'].includes(mission.phase);
    return `<section class="mission-view prototype-mission-view" data-view="work" aria-labelledby="mission-work-heading">
        <div class="prototype-mission-heading"><div><div class="eyebrow">Work and delivery</div><h1 id="mission-work-heading">Progress that needs attention</h1></div><span class="pp-muted">${escape(app, mission.conditions.filter(item => item.done).length)}/${escape(app, mission.conditions.length)} conditions complete</span></div>
        <section class="prototype-mission-checklist"><div class="pp-section-title">Delivery conditions</div><ul>${mission.conditions.map(condition => conditionRow(app, mission, condition)).join('')}</ul></section>
        <section class="prototype-mission-tasks"><div class="pp-section-title">Mission tasks</div>${humanTasks.length ? `<div class="prototype-mission-task-group"><h2>Human work</h2>${humanTasks.map(task => `<article class="prototype-mission-task ${task.status === 'done' ? 'is-done' : ''}"><div><strong>${escape(app, task.title)}</strong><p>${escape(app, task.description)}</p><small>${escape(app, (task.assignees || []).join(', '))} · ${escape(app, STATUS_LABELS[task.status] || task.status)}${task.dueDate ? ` · due ${escape(app, task.dueDate)}` : ' · date not set'}</small></div><button class="pp-button" data-open-task="${escape(app, task.id)}">Open task</button></article>`).join('')}</div>` : ''}${agentTasks.length ? `<div class="prototype-mission-task-group"><h2>Implementation work <span class="pp-muted">simulated</span></h2>${agentTasks.map(task => `<article class="prototype-mission-task ${task.status === 'done' ? 'is-done' : ''}"><div><strong>${escape(app, task.title)}</strong><p>${escape(app, task.description)}</p><small>Sample coding agent · ${escape(app, STATUS_LABELS[task.status] || task.status)}</small></div></article>`).join('')}</div>` : '<p class="pp-empty">Implementation workers are not shown until a human approves the plan.</p>'}</section>
        ${canShowWorkers ? `<div class="prototype-mission-worker-actions"><button class="pp-button" data-action="show-worker-details">Show sample worker details</button></div>` : ''}
        ${previewControls(app, mission)}
        ${verificationTask && mission.phase === 'verification' ? `<div class="prototype-mission-verification-callout"><strong>Human delivery check remains</strong><p>Try the flow yourself. Any one assigned human can complete the shared task.</p><button class="pp-button" data-open-task="${escape(app, verificationTask.id)}">Open verification task</button></div>` : ''}
        ${mission.phase === 'complete' ? '<div class="prototype-mission-success">All delivery conditions are complete. Mission complete.</div>' : ''}
    </section>`;
}

function renderEmpty(app) {
    return `<div class="prototype-mission-empty"><p class="pp-empty">This mission is unavailable in the current project.</p><button class="pp-button" data-action="back-project">Back to project</button></div>`;
}

function updateMission(app, missionId, update) {
    app.state = { ...app.state, missions: app.state.missions.map(item => item.id === missionId ? { ...item, ...update } : item) };
}

function approveMission(app, mission) {
    let task = taskForAction(app, mission.id, 'approve-mission');
    if (mission.phase !== 'proposal') return;
    let state = app.state;
    if (!task) {
        task = { id: newId(), title: `Approve the ${mission.title} mission`, description: 'Review the intended behavior, rationale, and delivery conditions.', areaId: mission.areaId, missionId: mission.id, kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-mission' };
        state = { ...state, tasks: [...state.tasks, task] };
    }
    app.state = patchPrototypeTask(state, task.id, { status: 'done', completedBy: app.state.currentUser });
    updateMission(app, mission.id, { phase: 'planning' });
    app.render();
    app.notice('Mission approved. Planning can now be commissioned.');
}

function simulatePlanning(app, mission) {
    if (mission.phase !== 'planning') return;
    const existing = taskForAction(app, mission.id, 'approve-plan');
    let state = app.state;
    if (!existing) state = { ...state, tasks: [...state.tasks, { id: newId(), title: `Approve the implementation plan for ${mission.title}`, description: 'Review the orchestrator’s accepted plan before implementation starts.', areaId: mission.areaId, missionId: mission.id, kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-plan' }] };
    const plan = String(mission.plan || '').trim() ? mission.plan : previewPlan(mission);
    app.state = { ...state, missions: state.missions.map(item => item.id === mission.id ? { ...item, phase: 'plan-review', plan } : item) };
    app.render();
    app.notice('Planning result accepted; human plan approval is ready.');
}

function approvePlan(app, mission) {
    const task = taskForAction(app, mission.id, 'approve-plan');
    if (!task || mission.phase !== 'plan-review') return;
    let state = patchPrototypeTask(app.state, task.id, { status: 'done', completedBy: app.state.currentUser });
    const currentTasks = state.tasks.filter(item => item.missionId === mission.id);
    const hasAgents = currentTasks.some(item => item.kind === 'agent');
    if (!hasAgents) {
        const agentConditions = mission.conditions.filter(item => item.owner === 'agent');
        const newTasks = (agentConditions.length ? agentConditions : [{ text: `Carry out the approved plan for ${mission.title}` }]).map((condition, index) => ({ id: newId(), title: condition.text, description: 'Commissioned implementation task for the approved plan.', areaId: mission.areaId, missionId: mission.id, conditionId: condition.id, kind: 'agent', assignees: [`Implementation agent ${index + 1}`], dueDate: '', priority: 'P1', status: 'in-progress' }));
        state = { ...state, tasks: [...state.tasks, ...newTasks] };
    }
    state = { ...state, missions: state.missions.map(item => item.id === mission.id ? { ...item, phase: 'executing' } : item) };
    app.state = state;
    app.render();
    app.notice('Implementation work is now visible.');
}

function simulateImplementation(app, mission) {
    if (mission.phase !== 'executing') return;
    let state = app.state;
    state.tasks.filter(item => item.missionId === mission.id && item.kind === 'agent').forEach(task => { state = patchPrototypeTask(state, task.id, { status: 'done' }); });
    for (const condition of mission.conditions.filter(item => item.owner === 'human')) {
        if (!state.tasks.some(item => item.missionId === mission.id && item.conditionId === condition.id)) {
            state = { ...state, tasks: [...state.tasks, { id: newId(), title: condition.text, description: 'Try the delivered flow and confirm this human acceptance condition.', areaId: mission.areaId, missionId: mission.id, conditionId: condition.id, kind: 'human', assignees: ['Fred', 'Tyler'], dueDate: '', priority: 'P1', status: 'todo', action: 'verify' }] };
        }
    }
    state = { ...state, missions: state.missions.map(item => item.id === mission.id ? { ...item, phase: item.conditions.every(condition => condition.done) ? 'complete' : 'verification' } : item) };
    app.state = state;
    app.render();
    app.notice('Simulated implementation results are ready for human delivery checks.');
}

function toggleCondition(app, mission, conditionId, checked) {
    const condition = conditionFor(mission, conditionId);
    const task = tasksFor(app, mission.id).find(item => item.conditionId === conditionId);
    if (!condition || condition.owner !== 'human' || !task || !['verification', 'complete'].includes(mission.phase)) return;
    let state = patchPrototypeTask(app.state, task.id, { status: checked ? 'done' : 'todo', completedBy: checked ? app.state.currentUser : undefined });
    const updatedMission = state.missions.find(item => item.id === mission.id);
    const allDone = updatedMission.conditions.every(item => item.done);
    state = { ...state, missions: state.missions.map(item => item.id === mission.id ? { ...item, phase: allDone ? 'complete' : 'verification' } : item) };
    app.state = state;
    app.render();
    app.notice(allDone ? 'All delivery conditions complete.' : (checked ? 'Human delivery check completed.' : 'Human delivery check reopened.'));
}

export function renderMission(app, root, missionId) {
    const mission = missionFor(app, missionId);
    if (!mission) { root.innerHTML = renderEmpty(app); root.onclick = event => { if (event.target.closest('[data-action="back-project"]')) app.navigate({ kind: 'project' }); }; return; }
    const activeTab = tabsByApp.get(app) || 'brief';
    const tabButton = (id, label) => `<button class="workspace-tab ${activeTab === id ? 'active' : ''}" data-mission-tab="${id}" aria-selected="${activeTab === id}">${label}</button>`;
    root.innerHTML = `<section class="mission-workspace prototype-mission-workspace">
        <header class="mission-toolbar prototype-mission-toolbar"><button class="pp-button prototype-mission-back" data-action="back-project">← Back to project</button><div class="mission-title"><span class="prototype-mission-title-mark" aria-hidden="true">◆</span><span>${escape(app, mission.title)}</span></div>${phaseChip(app, mission)}<span class="local-label">preview</span><nav class="workspace-tabs" aria-label="Mission views">${tabButton('brief', 'Brief')}${tabButton('plan', 'Plan')}${tabButton('work', 'Work')}</nav></header>
        <div class="mission-layout prototype-mission-layout"><main class="mission-main prototype-mission-main">${activeTab === 'brief' ? renderBrief(app, mission) : activeTab === 'plan' ? renderPlan(app, mission) : renderWork(app, mission)}</main><aside class="mission-chat prototype-mission-chat" aria-label="Mission conversation"><div class="prototype-mission-chat-label">Coding orchestrator · mission channel</div><div data-mission-chat></div></aside></div>
    </section>`;
    const chat = root.querySelector('[data-mission-chat]');
    if (chat && mission.channelId) app.mountChat(chat, mission.channelId, { orchestrator: true });
    root.onclick = event => {
        const tab = event.target.closest('[data-mission-tab]');
        if (tab) { tabsByApp.set(app, tab.dataset.missionTab); app.render(); return; }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'back-project') { app.navigate({ kind: 'project' }); return; }
        if (action === 'approve-mission') { approveMission(app, mission); return; }
        if (action === 'simulate-planning') { simulatePlanning(app, mission); return; }
        if (action === 'approve-plan') { approvePlan(app, mission); return; }
        if (action === 'simulate-implementation') { simulateImplementation(app, mission); return; }
        if (action === 'show-worker-details') { const panel = root.querySelector('[data-worker-panel]'); if (panel) panel.hidden = false; return; }
        if (action === 'hide-worker-details') { const panel = root.querySelector('[data-worker-panel]'); if (panel) panel.hidden = true; return; }
        const openTask = event.target.closest('[data-open-task]')?.dataset.openTask;
        if (openTask) { app.openTask(openTask); return; }
    };
    root.oninput = event => {
        const field = event.target.closest('[data-mission-field]');
        if (field) { const current = missionFor(app, missionId); if (current) current[field.dataset.missionField] = field.value; return; }
        const conditionField = event.target.closest('[data-condition-id]');
        if (conditionField) { const current = missionFor(app, missionId); const condition = conditionFor(current, conditionField.dataset.conditionId); if (condition) condition.text = conditionField.value; }
    };
    root.onchange = event => { const checkbox = event.target.closest('[data-condition-toggle]'); if (checkbox) toggleCondition(app, mission, checkbox.dataset.conditionToggle, checkbox.checked); };
}
