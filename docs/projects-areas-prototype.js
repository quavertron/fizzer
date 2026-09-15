// Three project-view layouts on the existing mission prototype: ?variant=A|B|C.
// All state is local sample data. No API, storage, socket, or agent dispatch.
import { createPrototypeState, editPrototypeNote, patchPrototypeTask, PEOPLE, PHASE_LABELS, STATUS_LABELS, newId, nowLabel } from './projects-areas-prototype-model.js';
import { renderContext } from './projects-areas-prototype-context.js';
import { renderMission } from './projects-areas-prototype-mission.js';

const variants = ['A', 'B', 'C'];
const variantNames = { A: 'Work board', B: 'People & dates', C: 'Area overview' };
const params = new URLSearchParams(location.search);
let variant = variants.includes(params.get('variant')) ? params.get('variant') : 'A';
let workFilter = 'all';
let noticeTimer;
const collapsedAreas = new Set();
const expandedCards = new Set();
const chatDrafts = new Map();
let boardExpanded = false;
let updatesOpen = true;

const app = {
  state: createPrototypeState(params.get('scenario') === 'greenfield'),
  view: { kind: 'project' },
  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  },
  navigate(view) {
    app.view = view;
    const related = [...app.state.channels, ...app.state.missions].find(item => item.id === view.id);
    if (view.kind === 'area') collapsedAreas.delete(view.id);
    else if (related?.areaId) collapsedAreas.delete(related.areaId);
    const url = new URL(location.href);
    url.searchParams.set('view', view.kind);
    if (view.id) url.searchParams.set('id', view.id); else url.searchParams.delete('id');
    history.pushState(null, '', url);
    document.getElementById('prototypeShell').classList.remove('pp-mobile-nav');
    app.render();
  },
  notice(message) {
    const element = document.getElementById('prototypeNotice');
    element.textContent = message;
    element.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => element.classList.add('hidden'), 5000);
  },
  recordNote(id, content, author) {
    app.state = editPrototypeNote(app.state, id, content, author);
    renderNavigation();
  },
  openTask,
  mountChat,
  render() {
    const state = app.state;
    document.getElementById('projectName').textContent = state.projectName;
    document.getElementById('currentUser').value = state.currentUser;
    document.getElementById('userAvatar').textContent = state.currentUser[0];
    document.getElementById('runnerOnline').checked = state.runnerOnline;
    document.getElementById('variantLabel').textContent = `${variant} — ${variantNames[variant]}`;
    const root = document.getElementById('prototypeContent');
    root.onclick = null;
    root.oninput = null;
    root.onchange = null;
    root.className = `pp-content pp-variant-${variant.toLowerCase()}`;
    renderNavigation();
    if (app.view.kind === 'project') renderProject(root);
    else if (app.view.kind === 'setup') renderSetup(root);
    else if (app.view.kind === 'mission') renderMission(app, root, app.view.id);
    else renderContext(app, root);
    const item = [...state.areas, ...state.notes, ...state.channels, ...state.missions].find(record => record.id === app.view.id);
    document.getElementById('currentViewTab').textContent = item?.title || item?.name || ({ project: 'Overview', setup: 'New project', changes: 'Changes', notes: 'Notes' }[app.view.kind]) || 'Project';
    document.getElementById('stateContent').textContent = JSON.stringify({ variant, view: app.view, ...state }, null, 2);
    document.title = `${state.projectName} — Fizzer UI prototype`;
  },
};

function renderNavigation() {
  const query = document.getElementById('navSearch').value.toLowerCase().trim();
  const s = app.state;
  function link(kind, id, title, icon, extra = '') {
    const active = app.view.kind === kind && (!id || app.view.id === id) || kind === 'notes' && app.view.kind === 'note';
    return `<button class="tree-item ${kind === 'channel' ? 'is-channel' : ''} ${active ? 'active' : ''}" title="${app.escape(title)}" data-view="${kind}" ${id ? `data-id="${app.escape(id)}"` : ''}><span class="tree-icon">${icon}</span><span class="tree-label">${app.escape(title)}</span>${extra}</button>`;
  }
  const mainChannel = s.channels.find(channel => channel.id === 'general');
  const missionChannels = new Set(s.missions.map(mission => mission.channelId));
  const areaTree = s.areas.map(area => {
    const channels = s.channels.filter(channel => channel.areaId === area.id && !missionChannels.has(channel.id));
    const missions = s.missions.filter(item => item.areaId === area.id);
    if (query && ![area.name, ...channels.map(channel => channel.name), ...missions.map(item => item.title)].some(title => title.toLowerCase().includes(query))) return '';
    const open = query || !collapsedAreas.has(area.id);
    const pending = s.tasks.filter(task => task.areaId === area.id && task.kind === 'human' && task.status !== 'done').length;
    return `<section class="pp-area-nav" data-area-id="${app.escape(area.id)}"><div class="pp-area-nav-heading"><button class="pp-area-toggle" data-toggle-area="${app.escape(area.id)}" aria-label="${open ? 'Collapse' : 'Expand'} ${app.escape(area.name)}" aria-expanded="${Boolean(open)}">${open ? '⌄' : '›'}</button>${link('area', area.id, area.name, '◇', area.status === 'proposed' ? '<small class="pp-proposed-dot">Proposed</small>' : `<small>${pending || ''}</small>`)}</div><div class="tree-children pp-area-nav-children" ${open ? '' : 'hidden'}>${channels.map(channel => link('channel', channel.id, channel.name, '#')).join('')}${missions.map(mission => link('mission', mission.id, mission.title, '⬡', mission.phase === 'complete' ? '<small title="Complete">✓</small>' : '')).join('')}</div></section>`;
  }).join('');
  document.getElementById('projectNavigation').innerHTML = [
    link('project', '', 'Overview', '▦'),
    mainChannel ? link('channel', mainChannel.id, mainChannel.name, '#') : '',
    link('notes', '', 'Notes', '▤', `<small>${s.notes.length}</small>`),
    link('changes', '', 'Changes', '±', `<small>${s.changes.length || ''}</small>`),
    '<div class="sidebar-section-label">Areas</div>', areaTree,
    areaTree ? '' : `<p class="pp-nav-empty">${query ? 'No matching areas' : 'No areas yet'}</p>`,
  ].join('');
}

function visibleTasks() {
  const tasks = app.state.tasks.filter(task => workFilter === 'all' || (task.kind === 'human' && task.assignees.includes(app.state.currentUser)));
  return tasks.sort((a, b) => a.priority.localeCompare(b.priority) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

function taskCard(task, compact = false) {
  const area = app.state.areas.find(item => item.id === task.areaId);
  const key = `task:${task.id}`;
  return `<article class="pp-task ${compact ? 'pp-task-row' : ''}" draggable="true" data-drag-task="${app.escape(task.id)}">
    <details data-expand-card="${app.escape(key)}" ${expandedCards.has(key) ? 'open' : ''}><summary class="pp-task-open"><span class="pp-task-top"><span class="pp-priority ${task.priority.toLowerCase()}">${app.escape(task.priority)}</span><span>${task.kind === 'human' ? 'Human task' : 'Agent task'}</span><span class="pp-card-caret">›</span></span><strong>${app.escape(task.title)}</strong><span class="pp-task-meta"><span>${app.escape(task.assignees.join(' + ') || 'Unassigned')}</span><time>${task.dueDate ? app.escape(new Date(`${task.dueDate}T12:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' })) : 'No due date'}</time></span>${!task.missionId ? `<span class="pp-task-area">${app.escape(area?.name || 'Project')}</span>` : ''}</summary><div class="pp-task-detail"><p>${app.escape(task.description)}</p><span class="pp-chip">${STATUS_LABELS[task.status]}</span><button class="pp-text-button" data-task="${app.escape(task.id)}">Edit task</button></div></details>
  </article>`;
}

function missionColumn(mission) {
  return mission.phase === 'complete' ? 'done' : mission.phase === 'proposal' ? 'todo' : 'in-progress';
}

function missionCard(mission) {
  const tasks = app.state.tasks.filter(task => task.missionId === mission.id && (workFilter === 'all' || (task.kind === 'human' && task.assignees.includes(app.state.currentUser))));
  const area = app.state.areas.find(item => item.id === mission.areaId);
  const key = `mission:${mission.id}`;
  const done = tasks.filter(task => task.status === 'done').length;
  return `<article class="pp-board-mission" draggable="true" data-drag-mission="${app.escape(mission.id)}"><details data-expand-card="${app.escape(key)}" ${expandedCards.has(key) ? 'open' : ''}><summary class="pp-mission-summary"><span class="pp-task-top"><span class="pp-mission-kind">Mission</span><span>${PHASE_LABELS[mission.phase]}</span><span class="pp-card-caret">›</span></span><strong>${app.escape(mission.title)}</strong><span class="pp-task-area">${app.escape(area?.name || 'Project')}</span><span class="pp-mission-progress"><span>${tasks.length} tasks</span><span>${done} completed</span></span><progress value="${done}" max="${tasks.length || 1}" aria-label="${done} of ${tasks.length} tasks complete"></progress></summary><div class="pp-mission-tasks">${['todo', 'in-progress', 'done'].map(status => {
    const group = tasks.filter(task => task.status === status);
    return group.length ? `<section class="pp-mission-task-group" data-task-group="${status}"><h4><span class="pp-status-dot ${status}"></span>${STATUS_LABELS[status]}<span>${group.length}</span></h4>${group.map(task => taskCard(task, true)).join('')}</section>` : '';
  }).join('') || '<p class="pp-empty">No tasks yet</p>'}</div></details><footer><button class="pp-text-button" data-view="mission" data-id="${app.escape(mission.id)}">Open mission ↗</button></footer></article>`;
}

function missionList() {
  const missions = app.state.missions.filter(mission => mission.phase !== 'complete');
  return `<section class="pp-panel"><div class="pp-section-title"><h2>Active missions <span class="pp-muted">${missions.length}</span></h2><button class="pp-text-button" data-action="new-mission">New</button></div>${missions.map(mission => `<div class="pp-mission-card"><small class="pp-muted">${app.escape(app.state.areas.find(area => area.id === mission.areaId)?.name || '')}</small><h3>${app.escape(mission.title)}</h3><div class="pp-mission-card-footer"><span class="pp-chip">${PHASE_LABELS[mission.phase]}</span><button class="pp-text-button" data-view="mission" data-id="${app.escape(mission.id)}">Open mission ↗</button></div></div>`).join('') || '<p class="pp-empty">No active missions</p>'}</section>`;
}

function recentChanges(collapsible = false) {
  const entries = `${app.state.changes.slice(0, 4).map(change => `<button class="pp-change-row" data-view="changes"><span class="pp-change-icon">±</span><span><strong>${app.escape(change.title)}</strong><small>${app.escape(change.author)} · ${app.escape(change.at)}</small></span></button>`).join('') || '<p class="pp-empty">No new changes</p>'}${app.state.areas.filter(area => area.status === 'proposed').map(area => `<div class="pp-proposal"><span class="pp-eyebrow">Area to consider</span><h3>${app.escape(area.name)}</h3><p>${app.escape(area.summary)}</p><button class="pp-text-button" data-view="area" data-id="${app.escape(area.id)}">Review proposal ↗</button></div>`).join('')}`;
  return collapsible
    ? `<details class="pp-home-updates" ${updatesOpen ? 'open' : ''}><summary>Since your last look <span>${app.state.changes.length}</span></summary><div class="pp-updates-body">${entries}<button class="pp-text-button pp-all-changes" data-view="changes">All changes ↗</button></div></details>`
    : `<section class="pp-panel"><div class="pp-section-title"><h2>Since your last look</h2><button class="pp-text-button" data-view="changes">All changes</button></div>${entries}</section>`;
}

function renderProject(root) {
  const tasks = visibleTasks();
  const assigned = app.state.tasks.filter(task => task.kind === 'human' && task.assignees.includes(app.state.currentUser) && task.status !== 'done');
  const next = assigned.sort((a, b) => a.priority.localeCompare(b.priority))[0];
  root.innerHTML = `<div class="pp-page pp-dashboard ${variant === 'A' ? `pp-dashboard-workspace ${boardExpanded ? 'pp-board-expanded' : ''}` : ''}"><header class="pp-project-header"><div><h1>${app.escape(app.state.projectName)}</h1><p>${app.state.setup === 'greenfield' ? 'Define the product together.' : 'Beta opens 23 Sep · Launch 30 Sep'}</p></div><div class="pp-header-actions"><button class="pp-button" data-action="new-mission">New mission</button><button class="pp-button primary" data-action="new-task">+ New task</button></div></header>
    ${variant !== 'A' && next ? `<section class="pp-next"><span class="pp-avatar">PM</span><div><strong>Next for ${app.escape(app.state.currentUser)}</strong><p>${app.escape(next.title)}</p></div><button class="pp-button" data-task="${app.escape(next.id)}">View task</button></section>` : ''}
    <div class="pp-work-toolbar"><div class="pp-filter" role="group" aria-label="Work filter" ${variant === 'A' && !boardExpanded ? 'hidden' : ''}><button data-filter="mine" class="${workFilter === 'mine' ? 'active' : ''}">My work <span>${assigned.length}</span></button><button data-filter="all" class="${workFilter === 'all' ? 'active' : ''}">All work</button></div>${variant === 'A' ? `<button class="pp-text-button" id="expandBoard" aria-expanded="${boardExpanded}">${boardExpanded ? '← Focus in progress' : 'Expand board →'}</button>` : `<span class="pp-muted pp-small">${tasks.length} tasks</span>`}</div><div id="dashboardLayout"></div></div>`;
  const layout = root.querySelector('#dashboardLayout');
  if (variant === 'A') {
    const missions = app.state.missions.filter(mission => workFilter === 'all' || app.state.tasks.some(task => task.missionId === mission.id && task.kind === 'human' && task.assignees.includes(app.state.currentUser)));
    const standalone = tasks.filter(task => !task.missionId);
    layout.innerHTML = `<div class="pp-workspace-grid ${boardExpanded ? 'pp-board-expanded' : ''}"><section class="pp-board" aria-label="Mission and task Kanban">${['todo', 'in-progress', 'done'].map(status => {
      const columnMissions = missions.filter(mission => missionColumn(mission) === status);
      const columnTasks = standalone.filter(task => task.status === status);
      const label = !boardExpanded && status === 'in-progress' ? 'Current tasks' : STATUS_LABELS[status];
      return `<section class="pp-column" data-drop-status="${status}"><header><span class="pp-status-dot ${status}"></span><h2>${label}</h2><span>${columnMissions.length + columnTasks.length}</span></header><div class="pp-column-tasks">${columnMissions.map(missionCard).join('')}${columnTasks.map(task => taskCard(task)).join('')}${columnMissions.length || columnTasks.length ? '' : '<p class="pp-empty">Drop work here</p>'}</div></section>`;
    }).join('')}</section><aside class="pp-home-activity"><section class="pp-home-chat" aria-label="Project conversation"></section>${recentChanges(true)}</aside></div>`;
    app.mountChat(root.querySelector('.pp-home-chat'), 'general');
    root.querySelector('#expandBoard').onclick = () => setBoardExpanded(!boardExpanded);
    root.querySelector('.pp-home-updates > summary').onclick = event => { updatesOpen = !event.currentTarget.parentElement.open; };
    setBoardExpanded(boardExpanded);
  } else if (variant === 'B') {
    const dates = [...new Set(tasks.map(task => task.dueDate))].sort((a, b) => (a || '9999').localeCompare(b || '9999'));
    layout.innerHTML = `<div class="pp-agenda-layout"><section class="pp-agenda"><div class="pp-section-title"><h2>Delivery dates</h2><span class="pp-muted pp-small">${app.escape(app.state.currentUser)}'s work and shared responsibilities</span></div>${dates.map(date => `<section class="pp-date-group"><header><strong>${date ? app.escape(new Date(`${date}T12:00:00`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })) : 'Not scheduled'}</strong><small>${date ? 'Deliver by this date' : 'Choose a delivery date'}</small></header><div>${tasks.filter(task => task.dueDate === date).map(task => taskCard(task, true)).join('')}</div></section>`).join('') || '<p class="pp-empty">No work scheduled yet.</p>'}</section><aside class="pp-dashboard-side">${missionList()}${recentChanges()}</aside></div>`;
  } else {
    layout.innerHTML = `<section class="pp-area-overview" aria-label="Areas and their work">${app.state.areas.map(area => `<article class="pp-area-lane"><div class="pp-area-intro"><span class="pp-eyebrow">${area.status === 'proposed' ? 'Proposed area' : 'Area'}</span><h2>${app.escape(area.name)}</h2><p>${app.escape(area.summary)}</p><button class="pp-button" data-view="area" data-id="${app.escape(area.id)}">${area.status === 'proposed' ? 'Review proposal' : 'Open area'}</button><small>${area.noteIds.length} notes · ${app.state.missions.filter(mission => mission.areaId === area.id).length} missions</small></div><div class="pp-area-work"><h3>Tasks</h3>${tasks.filter(task => task.areaId === area.id).map(task => taskCard(task, true)).join('') || '<p class="pp-empty">No tasks assigned</p>'}</div><div class="pp-area-missions"><h3>Missions</h3>${app.state.missions.filter(mission => mission.areaId === area.id).map(mission => `<div><span class="pp-chip">${PHASE_LABELS[mission.phase]}</span><h4>${app.escape(mission.title)}</h4><button class="pp-button" data-view="mission" data-id="${app.escape(mission.id)}">Open mission ↗</button></div>`).join('') || '<p class="pp-empty">No missions yet</p>'}</div></article>`).join('') || '<div class="pp-empty">No areas yet. Start in the project channel.</div>'}${tasks.some(task => !task.areaId) ? `<section class="pp-panel"><h2>Project-wide work</h2>${tasks.filter(task => !task.areaId).map(task => taskCard(task, true)).join('')}</section>` : ''}</section><div class="pp-area-footer">${recentChanges()}</div>`;
  }
  root.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { workFilter = button.dataset.filter; app.render(); });
  root.querySelectorAll('[data-expand-card] > summary').forEach(summary => summary.onclick = () => {
    const details = summary.parentElement;
    if (details.open) expandedCards.delete(details.dataset.expandCard); else expandedCards.add(details.dataset.expandCard);
  });
  root.querySelectorAll('[data-drag-task], [data-drag-mission]').forEach(card => {
    card.ondragstart = event => {
      if (card.dataset.dragMission && event.target.closest('[data-drag-task]')) return;
      event.stopPropagation();
      event.dataTransfer.setData('text/plain', JSON.stringify(card.dataset.dragTask ? { kind: 'task', id: card.dataset.dragTask } : { kind: 'mission', id: card.dataset.dragMission }));
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('pp-dragging');
      setBoardExpanded(true);
    };
    card.ondragend = event => {
      event.stopPropagation();
      card.classList.remove('pp-dragging');
      root.querySelectorAll('.pp-dragover').forEach(column => column.classList.remove('pp-dragover'));
    };
  });
  root.querySelectorAll('[data-drop-status]').forEach(column => {
    column.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('pp-dragover'); };
    column.ondragleave = event => { if (!column.contains(event.relatedTarget)) column.classList.remove('pp-dragover'); };
    column.ondrop = event => {
      event.preventDefault();
      column.classList.remove('pp-dragover');
      let card;
      try { card = JSON.parse(event.dataTransfer.getData('text/plain')); } catch { return; }
      if (card?.kind === 'task') changeTaskStatus(card.id, column.dataset.dropStatus);
      else if (card?.kind === 'mission') moveMission(card.id, column.dataset.dropStatus);
    };
  });
}

function setBoardExpanded(expanded) {
  if (variant !== 'A') return;
  const grid = document.querySelector('.pp-workspace-grid');
  const dashboard = document.querySelector('.pp-dashboard-workspace');
  if (!grid || !dashboard) return;
  const changed = boardExpanded !== expanded;
  if (!expanded && workFilter === 'mine') {
    workFilter = 'all';
    boardExpanded = false;
    if (changed) updatesOpen = true;
    app.render();
    return;
  }
  boardExpanded = expanded;
  dashboard.classList.toggle('pp-board-expanded', expanded);
  grid.classList.toggle('pp-board-expanded', expanded);
  const filter = dashboard.querySelector('.pp-filter');
  if (filter) filter.hidden = !expanded;
  const button = dashboard.querySelector('#expandBoard');
  if (button) {
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? '← Focus in progress' : 'Expand board →';
  }
  if (changed) updatesOpen = !expanded;
  grid.querySelectorAll('[data-drop-status]').forEach(column => {
    const focused = column.dataset.dropStatus === 'in-progress';
    column.hidden = !expanded && !focused;
    const heading = column.querySelector('h2');
    if (heading) heading.textContent = !expanded && focused ? 'Current tasks' : STATUS_LABELS[column.dataset.dropStatus];
  });
  const updates = grid.querySelector('.pp-home-updates');
  if (updates) updates.open = updatesOpen;
}

function moveMission(id, status) {
  const mission = app.state.missions.find(item => item.id === id);
  if (!mission || missionColumn(mission) === status) return;
  const tasks = app.state.tasks.filter(task => task.missionId === id);
  const canComplete = status === 'done'
    && ['executing', 'verification'].includes(mission.phase)
    && mission.conditions.every(condition => condition.done)
    && tasks.every(task => task.status === 'done');
  if (canComplete) {
    app.state = { ...app.state, missions: app.state.missions.map(item => item.id === id ? { ...item, phase: 'complete' } : item) };
    app.render();
    return;
  }
  app.navigate({ kind: 'mission', id });
  app.notice(status === 'done' ? 'Complete the remaining delivery checks before finishing this mission.' : 'Mission progress follows its approvals and delivery checks. Move individual tasks within the mission.');
}

function changeTaskStatus(id, status) {
  const task = app.state.tasks.find(item => item.id === id);
  if (!task || !Object.hasOwn(STATUS_LABELS, status)) return;
  if ((task.action?.startsWith('approve') || task.action?.startsWith('verify')) && status === 'done' && task.status !== 'done') {
    app.navigate({ kind: 'mission', id: task.missionId });
    app.notice(task.action.startsWith('approve') ? 'Review and approve this item in the mission view.' : 'Review and complete this delivery check in the mission view.');
    return;
  }
  app.state = patchPrototypeTask(app.state, id, { status });
  app.render();
}

function openTask(id) {
  const existing = app.state.tasks.find(item => item.id === id);
  const task = existing || { id: newId(), title: '', description: '', areaId: app.view.kind === 'area' ? app.view.id : app.state.areas.find(area => area.status === 'active')?.id || null, missionId: null, kind: 'human', assignees: [app.state.currentUser], dueDate: '', priority: 'P2', status: 'todo' };
  const dialog = document.getElementById('taskDialog');
  dialog.innerHTML = `<form id="taskEditForm"><header><div><span class="pp-eyebrow">${task.missionId ? 'Mission task' : 'Standalone task'}</span><h2>${existing ? 'Task details' : 'New task'}</h2></div><button type="button" data-close="taskDialog" aria-label="Close task">×</button></header><label class="pp-field">Title<input name="title" value="${app.escape(task.title)}" required autofocus></label><label class="pp-field">Instructions<textarea name="description" rows="3">${app.escape(task.description)}</textarea></label><div class="pp-form-grid"><label class="pp-field">Area<select name="areaId"><option value="">Project-wide</option>${app.state.areas.filter(area => area.status === 'active').map(area => `<option value="${app.escape(area.id)}" ${task.areaId === area.id ? 'selected' : ''}>${app.escape(area.name)}</option>`).join('')}</select></label><label class="pp-field">Mission<select name="missionId" ${task.action ? 'disabled' : ''}><option value="">Standalone · no mission</option>${app.state.missions.map(mission => `<option value="${app.escape(mission.id)}" ${task.missionId === mission.id ? 'selected' : ''}>${app.escape(mission.title)}</option>`).join('')}</select></label><label class="pp-field">Delivery date<input type="date" name="dueDate" value="${app.escape(task.dueDate)}"></label><label class="pp-field">Priority<select name="priority">${['P1', 'P2', 'P3'].map(priority => `<option ${task.priority === priority ? 'selected' : ''}>${priority}</option>`).join('')}</select></label></div><fieldset class="pp-assignees"><legend>Assigned to · any one can complete</legend>${(task.kind === 'human' ? PEOPLE : task.assignees).map(person => `<label><input type="checkbox" name="assignee" value="${app.escape(person)}" ${task.assignees.includes(person) ? 'checked' : ''}> ${app.escape(person)}</label>`).join('')}</fieldset><label class="pp-field">Status<select name="status" ${task.action?.startsWith('approve') ? 'disabled' : ''}>${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${task.completedBy ? `<p class="pp-muted pp-small">Completed by ${app.escape(task.completedBy)}</p>` : ''}<footer>${task.missionId ? '<button type="button" class="pp-button" id="taskOpenMission">Open mission</button>' : '<button type="button" class="pp-button" id="taskOpenChannel">Discuss in channel</button>'}<button class="pp-button primary" type="submit">Save task</button></footer></form>`;
  dialog.showModal();
  dialog.querySelector('#taskEditForm').onsubmit = event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const missionId = task.action ? task.missionId : form.get('missionId') || null;
    const patch = { title: form.get('title').trim(), description: form.get('description'), areaId: missionId ? app.state.missions.find(mission => mission.id === missionId)?.areaId : form.get('areaId') || null, missionId, dueDate: form.get('dueDate'), priority: form.get('priority'), assignees: form.getAll('assignee'), status: form.get('status') || task.status };
    if (!patch.title) return;
    if (existing) app.state = patchPrototypeTask(app.state, task.id, patch);
    else app.state.tasks.push({ ...task, ...patch });
    dialog.close();
    app.render();
    app.notice('Task saved.');
  };
  dialog.querySelector('#taskOpenMission')?.addEventListener('click', () => { dialog.close(); app.navigate({ kind: 'mission', id: task.missionId }); });
  dialog.querySelector('#taskOpenChannel')?.addEventListener('click', () => { dialog.close(); app.navigate({ kind: 'channel', id: app.state.areas.find(area => area.id === task.areaId)?.channelId || 'general' }); });
}

function openMissionForm() {
  const areas = app.state.areas.filter(area => area.status === 'active');
  if (!areas.length) { app.navigate({ kind: 'channel', id: 'general' }); app.notice('Create an area before proposing a mission.'); return; }
  const dialog = document.getElementById('missionDialog');
  dialog.innerHTML = `<form id="newMissionForm"><header><div><span class="pp-eyebrow">Mission proposal</span><h2>Propose a mission</h2></div><button type="button" data-close="missionDialog" aria-label="Close mission form">×</button></header><label class="pp-field">Mission title<input name="title" required autofocus></label><label class="pp-field">Area<select name="areaId">${areas.map(area => `<option value="${app.escape(area.id)}" ${app.view.kind === 'area' && app.view.id === area.id ? 'selected' : ''}>${app.escape(area.name)}</option>`).join('')}</select></label><label class="pp-field">Intended behavior<textarea name="behavior" required rows="3"></textarea></label><label class="pp-field">Why it matters<textarea name="why" required rows="2"></textarea></label><label class="pp-field">Human delivery condition<input name="condition" required placeholder="What should a person try and confirm?"></label><footer><button class="pp-button primary">Propose mission</button></footer></form>`;
  dialog.showModal();
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = newId(), channelId = newId();
    const mission = { id, title: form.get('title').trim(), areaId: form.get('areaId'), channelId, behavior: form.get('behavior'), why: form.get('why'), phase: 'proposal', plan: '', conditions: [{ id: newId(), text: form.get('condition'), owner: 'human', done: false }] };
    app.state.missions.push(mission);
    app.state.channels.push({ id: channelId, name: mission.title, areaId: mission.areaId, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] });
    app.state.tasks.push({ id: newId(), title: `Approve mission: ${mission.title}`, description: 'Review the intended behavior and delivery conditions.', areaId: mission.areaId, missionId: id, kind: 'human', assignees: [app.state.currentUser], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-mission' });
    dialog.close(); app.navigate({ kind: 'mission', id });
  };
}

function mountChat(element, channelId, options = {}) {
  const channel = app.state.channels.find(item => item.id === channelId);
  if (!channel) { element.innerHTML = '<p class="pp-empty">Channel not found.</p>'; return; }
  element.classList.add('pp-chat-frame');
  const messages = channel.messages.map(message => {
    const body = app.escape(message.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[\[([^\]]+)\]\]/g, (match, title) => {
      const note = app.state.notes.find(item => app.escape(item.title) === title);
      return note ? `<button class="pp-chat-note" data-view="note" data-id="${app.escape(note.id)}">${title}</button>` : title;
    });
    return `<div class="chat-message-group"><span class="chat-avatar ${message.role !== 'human' ? 'agent' : ''}">${message.role === 'pm' ? 'PM' : message.role === 'orchestrator' ? 'CO' : app.escape(message.author[0])}</span><div class="chat-message-body"><div class="chat-message-meta"><strong>${app.escape(message.author)}</strong><time>${app.escape(message.at)}</time></div><p class="chat-message-text">${body}</p></div></div>`;
  }).join('');
  element.innerHTML = `<header class="chat-header"><div class="chat-header-copy"><h2># ${app.escape(channel.name)}</h2><span>${options.orchestrator ? 'Coding orchestrator' : 'Project manager'}</span></div></header><div class="chat-members">${app.escape(PEOPLE.join(' · '))} · ${options.orchestrator ? 'Coding orchestrator' : 'PM'}</div><div class="chat-messages" role="log" aria-label="${app.escape(channel.name)} messages">${messages || '<p class="pp-empty">No messages yet</p>'}</div><form class="chat-composer pp-local-composer"><textarea name="body" aria-label="${options.orchestrator ? 'Message coding orchestrator' : 'Message project channel'}" placeholder="${options.orchestrator ? 'Message the coding orchestrator…' : `Message #${app.escape(channel.name)}…`}" required rows="2"></textarea><button class="btn-icon chat-send-btn" aria-label="Send message" title="Send message">↑</button></form>`;
  const form = element.querySelector('form');
  form.elements.body.value = chatDrafts.get(channelId) || '';
  form.elements.body.oninput = () => chatDrafts.set(channelId, form.elements.body.value);
  form.onsubmit = event => {
    event.preventDefault();
    const body = form.elements.body.value.trim();
    if (!body) return;
    channel.messages.push({ id: newId(), author: app.state.currentUser, role: 'human', body, at: nowLabel() });
    chatDrafts.delete(channelId);
    app.render();
    const log = document.querySelector('.pp-chat-frame .chat-messages');
    if (log) log.scrollTop = log.scrollHeight;
    document.querySelector('.pp-local-composer textarea')?.focus();
  };
  form.elements.body.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  };
}

function renderSetup(root) {
  root.innerHTML = `<div class="pp-page pp-setup"><span class="pp-eyebrow">Two ways to begin</span><h1>Start with understanding.</h1><p class="pp-lead">A project can begin with a group conversation or an existing product. Coding can come later.</p><div class="pp-setup-options"><section class="pp-panel"><span class="pp-chip">Greenfield</span><h2>Define a new product together</h2><p>Bring people into a channel with the PM. Talk through the product; let the notes and areas emerge.</p><form id="greenfieldForm"><label class="pp-field">Project name<input name="name" placeholder="What are you working on?" required></label><button class="pp-button primary">Start product conversation</button></form><small>No repository, completed spec, or coding agents required.</small></section><section class="pp-panel"><span class="pp-chip">Existing product</span><h2>Build on what already exists</h2><p>Research agents investigate the application. The PM shapes product-facing notes and proposes areas for your team to refine.</p><button class="pp-button" data-action="reset">Load Fizzer example</button><small>This loads sample research and product context, not a real repository investigation.</small></section></div></div>`;
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name').trim();
    if (!name) return;
    app.state = createPrototypeState(true); app.state.projectName = name;
    const url = new URL(location.href); url.searchParams.set('scenario', 'greenfield'); history.replaceState(null, '', url);
    app.navigate({ kind: 'channel', id: 'general' });
  };
}

function cycleVariant(direction) {
  variant = variants[(variants.indexOf(variant) + direction + variants.length) % variants.length];
  const url = new URL(location.href); url.searchParams.set('variant', variant); history.replaceState(null, '', url);
  app.view = { kind: 'project' };
  url.searchParams.set('view', 'project'); url.searchParams.delete('id'); history.replaceState(null, '', url);
  app.render();
}

function restoreView() {
  const query = new URLSearchParams(location.search);
  variant = variants.includes(query.get('variant')) ? query.get('variant') : 'A';
  const kind = query.get('view');
  app.view = ['area', 'note', 'channel', 'mission'].includes(kind) && query.get('id') ? { kind, id: query.get('id') }
    : { kind: ['project', 'changes', 'notes', 'setup'].includes(kind) ? kind : 'project' };
  app.render();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) app.navigate({ kind: button.dataset.view, ...(button.dataset.id ? { id: button.dataset.id } : {}) });
  else if (button.dataset.toggleArea) {
    const id = button.dataset.toggleArea;
    if (collapsedAreas.has(id)) collapsedAreas.delete(id); else collapsedAreas.add(id);
    renderNavigation();
  }
  else if (button.dataset.task) app.openTask(button.dataset.task);
  else if (button.dataset.close) document.getElementById(button.dataset.close).close();
  else if (button.dataset.action === 'new-task') app.openTask();
  else if (button.dataset.action === 'new-mission') openMissionForm();
  else if (button.dataset.action === 'reset') {
    app.state = createPrototypeState();
    workFilter = 'all';
    boardExpanded = false;
    updatesOpen = true;
    collapsedAreas.clear();
    expandedCards.clear();
    chatDrafts.clear();
    const url = new URL(location.href); url.searchParams.delete('scenario'); history.replaceState(null, '', url);
    app.navigate({ kind: 'project' }); app.notice('Preview reset.');
  }
});
document.getElementById('navSearch').oninput = renderNavigation;
document.getElementById('currentUser').onchange = event => { app.state.currentUser = event.target.value; app.render(); };
document.getElementById('runnerOnline').onchange = event => { app.state.runnerOnline = event.target.checked; app.render(); app.notice(app.state.runnerOnline ? 'PM is online. Pending messages are ready for catch-up.' : 'PM is offline. New messages will wait for catch-up.'); };
document.getElementById('sidebarToggle').onclick = () => {
  const shell = document.getElementById('prototypeShell');
  if (matchMedia('(max-width: 720px)').matches) shell.classList.toggle('pp-mobile-nav'); else shell.classList.toggle('sidebar-collapsed');
};
document.getElementById('currentViewTab').onclick = () => document.getElementById('prototypeContent').scrollTo({ top: 0, behavior: 'smooth' });
document.getElementById('previousVariant').onclick = () => cycleVariant(-1);
document.getElementById('nextVariant').onclick = () => cycleVariant(1);
document.getElementById('variantLabel').onclick = () => app.navigate({ kind: 'project' });
document.getElementById('showState').onclick = () => { document.getElementById('stateContent').textContent = JSON.stringify({ variant, view: app.view, ...app.state }, null, 2); document.getElementById('stateDialog').showModal(); };
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable], dialog') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); cycleVariant(event.key === 'ArrowLeft' ? -1 : 1); }
});
window.addEventListener('popstate', restoreView);
// This HTML is not included in production app builds; hide its review switcher on non-local hosts as well.
document.getElementById('prototypeSwitcher').hidden = !['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
restoreView();
