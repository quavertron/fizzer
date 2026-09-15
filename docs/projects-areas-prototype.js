// Three project-view layouts on the existing mission prototype: ?variant=A|B|C.
// All state is local sample data. No API, storage, socket, or agent dispatch.
import { createPrototypeState, editPrototypeNote, patchPrototypeTask, PEOPLE, PHASE_LABELS, STATUS_LABELS, newId, nowLabel } from './projects-areas-prototype-model.js';
import { renderContext, renderWorkspaceNote } from './projects-areas-prototype-context.js';
import { mountPrototypeChat } from './projects-areas-prototype-chat.js';

const variants = ['A', 'B', 'C'];
const params = new URLSearchParams(location.search);
let variant = variants.includes(params.get('variant')) ? params.get('variant') : 'A';
let workFilter = 'all';
let noticeTimer;
const expandedCards = new Set();
let boardExpanded = false;
let updatesOpen = true;

function areaForNote(state, noteId) {
  const note = state.notes.find(item => item.id === noteId);
  return state.areas.find(area => area.noteId === noteId || (area.noteIds || []).includes(noteId) || area.id === note?.areaId);
}

function canonicalNoteId(state, area) {
  return area?.noteId || area?.noteIds?.[0] || state.projectNoteId || state.notes.find(note => note.id === 'product-overview')?.id || null;
}

function canonicalChannelId(state, area) {
  return area?.channelId || state.projectChannelId || 'general';
}

const app = {
  state: createPrototypeState(params.get('scenario') === 'greenfield'),
  view: { kind: 'workspace' },
  workspace: {
    mode: 'note',
    noteId: params.get('scenario') === 'greenfield' ? null : 'project-interface-note',
    contextNoteId: params.get('scenario') === 'greenfield' ? null : 'project-interface-note',
    missionId: undefined,
    channelId: params.get('scenario') === 'greenfield' ? 'general' : 'project-interface-channel',
  },
  chatDrafts: new Map(),
  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  },
  mountChat(element, channelId, options = {}) {
    return mountPrototypeChat(app, element, channelId, options);
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
  },
  getContextNotes() {
    const current = app.state.notes.find(note => note.id === (app.workspace.contextNoteId || app.workspace.noteId));
    const area = current ? areaForNote(app.state, current.id) : null;
    const indexId = area?.noteId || (current?.id === app.state.projectNoteId ? current.id : app.state.projectNoteId) || 'product-overview';
    const mission = app.state.missions.find(item => item.noteId === app.workspace.noteId);
    const taskNoteIds = new Set(app.state.tasks.map(task => task.noteId).filter(Boolean));
    const artifactNoteIds = new Set((app.state.artifacts || []).map(artifact => artifact.noteId).filter(Boolean));
    const ordinary = app.state.notes.filter(note => !taskNoteIds.has(note.id) && !artifactNoteIds.has(note.id) && (note.id === indexId || note.parentNoteId === indexId || (area?.noteIds || []).includes(note.id) || note.id === mission?.noteId));
    return [...new Map(ordinary.sort((a, b) => Number(b.id === indexId) - Number(a.id === indexId)).map(note => [note.id, note])).values()];
  },
  selectContextNote(noteId) {
    if (!app.getContextNotes().some(note => note.id === noteId)) return;
    app.workspace = { ...app.workspace, contextNoteId: noteId };
    app.render();
  },
  showNote(noteId, options = {}) {
    const fallbackId = app.state.notes.find(item => item.id === 'project-interface-note')?.id || app.state.projectNoteId || app.state.notes.find(item => item.id === 'product-overview')?.id;
    const note = app.state.notes.find(item => item.id === noteId) || app.state.notes.find(item => item.id === fallbackId);
    const task = app.state.tasks.find(item => item.noteId === note?.id);
    if (task?.missionId) return app.openTaskWorkspace(task.id, options);
    const area = areaForNote(app.state, note?.id);
    const mission = app.state.missions.find(item => item.noteId === note?.id);
    const channelId = task?.channelId || mission?.channelId || (area ? canonicalChannelId(app.state, area) : (note?.id === app.state.projectNoteId || note?.id === 'product-overview') ? (app.state.projectChannelId || 'general') : app.workspace.channelId || 'general');
    app.workspace = { ...app.workspace, mode: 'note', noteId: note?.id || null, contextNoteId: note?.id || null, channelId, taskId: undefined, missionId: mission?.id, artifactId: undefined };
    app.view = { kind: 'workspace' };
    writeUrl('note', note?.id || null, options.replace);
    closeMobileNav();
    app.render();
  },
  openArtifact(artifactId, options = {}) {
    const artifact = (app.state.artifacts || []).find(item => item.id === artifactId);
    const parentNote = artifact ? app.state.notes.find(note => note.id === artifact.parentNoteId) : null;
    if (!artifact || !parentNote) return app.notice('That artifact is unavailable in this preview.');
    const area = areaForNote(app.state, parentNote.id);
    const task = app.state.tasks.find(item => item.noteId === parentNote.id);
    const mission = app.state.missions.find(item => item.noteId === parentNote.id);
    const channelId = task?.channelId || mission?.channelId || canonicalChannelId(app.state, area);
    app.workspace = { ...app.workspace, mode: 'note', noteId: parentNote.id, contextNoteId: parentNote.id, channelId, missionId: mission?.id || task?.missionId, taskId: task?.id, artifactId: artifact.id };
    app.view = { kind: 'workspace' };
    writeUrl('note', parentNote.id, options.replace, { artifact: artifact.id });
    closeMobileNav();
    app.render();
  },
  closeArtifact(options = {}) {
    const virtualTask = app.workspace.artifactId?.startsWith('task:') ? app.state.tasks.find(item => `task:${item.id}` === app.workspace.artifactId) : null;
    if (virtualTask?.missionId) return app.openMission(virtualTask.missionId, { replace: options.replace });
    app.workspace = { ...app.workspace, artifactId: undefined };
    app.view = { kind: 'workspace' };
    writeUrl('note', app.workspace.noteId, options.replace);
    app.render();
  },
  openMission(missionId, options = {}) {
    let mission = app.state.missions.find(item => item.id === missionId);
    if (!mission) return app.notice('That mission document is unavailable in this preview.');
    const area = mission.areaId ? app.state.areas.find(item => item.id === mission.areaId) : null;
    const noteId = mission.noteId || `${mission.id}-note`;
    const channelId = mission.channelId || `${mission.id}-channel`;
    let state = app.state;
    mission = { ...mission, noteId, channelId };
    if (!state.notes.some(note => note.id === noteId)) {
      const note = { id: noteId, title: mission.title, areaId: mission.areaId || null, parentNoteId: area?.noteId || null, content: `# ${mission.title}\n\n## Current step\n${mission.currentStep || 'Group discussion'}\n\n## Intended behavior\n${mission.behavior || 'Describe what should become possible.'}\n\n## Rationale\n${mission.why || 'The team is deciding this together.'}`, updatedBy: state.currentUser, updatedAt: nowLabel() };
      state = { ...state, notes: [...state.notes, note] };
    }
    if (!state.channels.some(channel => channel.id === channelId)) state = { ...state, channels: [...state.channels, { id: channelId, name: mission.title, areaId: mission.areaId || null, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] }] };
    state = { ...state, missions: state.missions.map(item => item.id === mission.id ? mission : item) };
    app.state = state;
    app.workspace = { ...app.workspace, mode: 'note', noteId, contextNoteId: noteId, channelId, missionId: mission.id, taskId: options.taskId, artifactId: undefined };
    app.view = { kind: 'workspace' };
    writeUrl('mission', mission.id, options.replace);
    closeMobileNav();
    app.render();
  },
  openTaskWorkspace(taskId, options = {}) {
    let task = app.state.tasks.find(item => item.id === taskId);
    if (!task) return app.notice('That task document is unavailable in this preview.');
    let state = app.state;
    const noteId = task.noteId || `${task.id}-note`;
    const channelId = task.channelId || `${task.id}-channel`;
    if (!task.noteId || !state.notes.some(note => note.id === noteId)) {
      const mission = task.missionId ? state.missions.find(item => item.id === task.missionId) : null;
      const note = { id: noteId, title: task.title || 'Task discussion', areaId: task.areaId || null, parentNoteId: mission?.noteId || null, content: `# ${task.title || 'Task discussion'}\n\n${task.description || 'Discuss the intended work and next step here.'}${mission ? `\n\n[[${mission.title}]]` : ''}`, updatedBy: state.currentUser, updatedAt: nowLabel() };
      task = { ...task, noteId };
      state = { ...state, tasks: state.tasks.map(item => item.id === task.id ? task : item), notes: [...state.notes, note] };
    }
    if (!task.channelId || !state.channels.some(channel => channel.id === channelId)) {
      task = { ...task, channelId };
      state = { ...state, tasks: state.tasks.map(item => item.id === task.id ? task : item), channels: [...state.channels, { id: channelId, name: task.title || 'task discussion', areaId: task.areaId || null, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] }] };
    }
    const mission = task.missionId ? state.missions.find(item => item.id === task.missionId) : null;
    const centerNoteId = mission?.noteId || noteId;
    app.state = state;
    app.workspace = { ...app.workspace, mode: 'note', noteId: centerNoteId, contextNoteId: centerNoteId, channelId, taskId: task.id, missionId: mission?.id, artifactId: mission ? `task:${task.id}` : undefined };
    writeUrl('task', task.id, options.replace);
    closeMobileNav();
    app.render();
  },
  openConversation(target, options = {}) {
    const kind = target?.kind;
    if (kind === 'mission') return app.openMission(target.id, options);
    if (kind === 'task') return app.openTaskWorkspace(target.id, options);
    const channel = kind === 'channel' ? app.state.channels.find(record => record.id === target.id) : null;
    if (!channel) return app.notice('That conversation is unavailable in this preview.');
    const task = app.state.tasks.find(record => record.channelId === channel.id);
    if (task) return app.openTaskWorkspace(task.id, options);
    const mission = app.state.missions.find(record => record.channelId === channel.id);
    if (mission) return app.openMission(mission.id, options);
    const area = channel.areaId ? app.state.areas.find(record => record.id === channel.areaId) : null;
    const noteId = area ? canonicalNoteId(app.state, area) : channel.id === app.state.projectChannelId ? app.state.projectNoteId : app.workspace.noteId;
    app.workspace = { ...app.workspace, mode: 'note', channelId: channel.id, noteId, contextNoteId: noteId, taskId: undefined, missionId: undefined, artifactId: undefined };
    app.view = { kind: 'workspace' };
    writeUrl('note', noteId, options.replace);
    closeMobileNav();
    app.render();
  },

  openTask,
  render() {
    const state = app.state;
    document.getElementById('projectName').textContent = state.projectName;
    document.getElementById('currentUser').value = state.currentUser;
    document.getElementById('userAvatar').textContent = state.currentUser[0];
    const root = document.getElementById('prototypeContent');
    root.onclick = null;
    root.oninput = null;
    root.onchange = null;
    root.className = `pp-content pp-variant-${variant.toLowerCase()}`;
    renderNavigation();
    if (app.view.kind === 'workspace') {
      if (app.workspace.mode === 'project') renderProject(root);
      else renderNoteWorkspace(root);
    } else if (app.view.kind === 'project') {
      renderProject(root);
    } else if (app.view.kind === 'setup') renderSetup(root);
    else renderContext(app, root);
    const item = [...state.areas, ...state.notes, ...state.channels, ...state.missions].find(record => record.id === app.view.id);
    const title = app.view.kind === 'workspace'
      ? (app.workspace.mode === 'note' ? (state.tasks.find(task => task.id === app.workspace.taskId)?.title || state.missions.find(mission => mission.id === app.workspace.missionId)?.title || state.notes.find(note => note.id === app.workspace.noteId)?.title || 'Product conversation') : 'Project work')
      : item?.title || item?.name || ({ project: 'Overview', setup: 'New project', changes: 'Changes', notes: 'Notes' }[app.view.kind]) || 'Project';
    document.getElementById('currentViewTab').textContent = title;
    document.getElementById('stateContent').textContent = JSON.stringify({ variant, view: app.view, workspace: app.workspace, ...state }, null, 2);
    document.title = `${state.projectName} — Fizzer UI prototype`;
  },
  navigate(view, options = {}) {
    if (view.kind === 'note') return app.showNote(view.id, options);
    if (view.kind === 'channel') return app.openConversation({ kind: 'channel', id: view.id }, options);
    if (view.kind === 'area') {
      const area = app.state.areas.find(item => item.id === view.id);
      return app.showNote(area?.noteId || area?.noteIds?.[0], options);
    }
    if (view.kind === 'mission') return app.openMission(view.id, options);
    if (view.kind === 'task') return app.openTaskWorkspace(view.id, options);
    if (view.kind === 'artifact') return app.openArtifact(view.id, options);
    if (view.kind === 'project') {
      app.workspace = { ...app.workspace, mode: 'project', artifactId: undefined };
      app.view = { kind: 'workspace' };
      writeUrl('project', null, options.replace);
      closeMobileNav();
      return app.render();
    }
    app.view = view;
    writeUrl(view.kind, view.id, options.replace);
    closeMobileNav();
    app.render();
  },
};

function writeUrl(kind, id, replace = false, extra = {}) {
  const url = new URL(location.href);
  url.searchParams.set('view', kind);
  if (id) url.searchParams.set('id', id); else url.searchParams.delete('id');
  Object.entries(extra).forEach(([key, value]) => value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  if (!Object.hasOwn(extra, 'artifact')) url.searchParams.delete('artifact');
  (replace ? history.replaceState : history.pushState).call(history, null, '', url);
}

function closeMobileNav() {
  document.getElementById('prototypeShell').classList.remove('pp-mobile-nav');
}

function workspaceModeToggle() {
  return `<div class="pp-workspace-mode" role="group" aria-label="Workspace mode"><button data-workspace-mode="note" class="${app.workspace.mode === 'note' ? 'active' : ''}">Note</button><button data-workspace-mode="project" class="${app.workspace.mode === 'project' ? 'active' : ''}">Project</button></div>`;
}

function renderNoteWorkspace(root) {
  const channel = app.state.channels.find(item => item.id === app.workspace.channelId) || app.state.channels.find(item => item.id === 'general');
  const note = app.state.notes.find(item => item.id === (app.workspace.contextNoteId || app.workspace.noteId));
  const area = note ? areaForNote(app.state, note.id) : null;
  const mission = app.workspace.missionId ? app.state.missions.find(item => item.id === app.workspace.missionId) : null;
  const projectNoteId = app.state.projectNoteId || app.state.notes.find(item => item.id === 'product-overview')?.id;
  const task = app.workspace.taskId ? app.state.tasks.find(item => item.id === app.workspace.taskId) : null;
  const breadcrumb = [`<button class="pp-note-crumb" data-view="note" data-id="${app.escape(projectNoteId || '')}">${app.escape(app.state.projectName || 'Fizzer')}</button>`, area ? `<span class="pp-note-crumb-sep" aria-hidden="true">/</span><button class="pp-note-crumb" data-view="note" data-id="${app.escape(canonicalNoteId(app.state, area) || '')}">${app.escape(area.name)}</button>` : '', mission ? `<span class="pp-note-crumb-sep" aria-hidden="true">/</span><button class="pp-note-crumb" data-view="mission" data-id="${app.escape(mission.id)}">${app.escape(mission.title)}</button>` : '', task ? `<span class="pp-note-crumb-sep" aria-hidden="true">/</span><button class="pp-note-crumb" data-view="task" data-id="${app.escape(task.id)}">${app.escape(task.title)}</button>` : ''].join('');
  const storedArtifact = (app.state.artifacts || []).find(item => item.id === app.workspace.artifactId);
  const virtualTask = app.workspace.artifactId?.startsWith('task:') ? app.state.tasks.find(item => `task:${item.id}` === app.workspace.artifactId) : null;
  const artifact = storedArtifact || (virtualTask ? { id: `task:${virtualTask.id}`, parentNoteId: app.workspace.noteId, missionId: virtualTask.missionId, taskId: virtualTask.id, title: virtualTask.title, kind: 'note', noteId: virtualTask.noteId } : null);
  const rightPane = artifact
    ? `<aside class="pp-artifact-pane" aria-label="${app.escape(artifact.title)}"><header class="pp-artifact-header"><div><span class="pp-eyebrow">Artifact</span><h2>${app.escape(artifact.title)}</h2></div><button class="pp-text-button" data-close-artifact aria-label="Close artifact">Close</button></header><div class="pp-artifact-surface" data-artifact-surface></div><div class="pp-artifact-chat" data-artifact-chat></div></aside>`
    : `<aside class="pp-note-chat" aria-label="${app.escape(channel?.name || 'product')} conversation"><div class="pp-note-chat-mount" data-note-chat></div></aside>`;
  root.innerHTML = `<div class="pp-note-workspace${artifact ? ' pp-artifact-open' : ''}"><header class="pp-note-toolbar"><span class="pp-note-breadcrumb">${breadcrumb}</span>${workspaceModeToggle()}</header><div class="pp-note-layout"><main class="pp-note-main"><div class="pp-note-context" data-note-context></div>${!note ? `<section class="pp-note-empty"><span class="pp-note-empty-mark" aria-hidden="true">✦</span><h2>Start with the team conversation</h2><p>No product notes exist yet. Discuss the product in <strong>#${app.escape(channel?.name || 'product')}</strong>; the first note can emerge from that room.</p><button class="pp-button primary" data-view="channel" data-id="${app.escape(channel?.id || 'general')}">Open #${app.escape(channel?.name || 'product')}</button></section>` : ''}</main>${rightPane}</div></div>`;
  const noteRoot = root.querySelector('[data-note-context]');
  if (note) renderWorkspaceNote(app, noteRoot, note.id);
  if (artifact) {
    const surface = root.querySelector('[data-artifact-surface]');
    if (artifact.kind === 'prototype') surface.innerHTML = `<iframe title="${app.escape(artifact.title)}" sandbox="allow-scripts" srcdoc="${app.escape(artifact.html || '')}"></iframe>`;
    else if (artifact.kind === 'image') surface.innerHTML = `<img src="${app.escape(artifact.src || '')}" alt="${app.escape(artifact.alt || artifact.title)}">`;
    else if (artifact.kind === 'note') renderWorkspaceNote(app, surface, artifact.noteId);
    app.mountChat(root.querySelector('[data-artifact-chat]'), virtualTask?.channelId || channel?.id || 'general', { artifactId: artifact.id, noteId: note?.id });
    root.querySelector('[data-close-artifact]').onclick = () => virtualTask ? app.openMission(virtualTask.missionId) : app.closeArtifact();
  } else app.mountChat(root.querySelector('[data-note-chat]'), channel?.id || 'general', { noteId: note?.id });
  bindWorkspaceControls(root);
}

function bindWorkspaceControls(root) {
  root.querySelectorAll('[data-workspace-mode]').forEach(button => button.onclick = () => {
    if (button.dataset.workspaceMode === 'project') {
      app.workspace = { ...app.workspace, mode: 'project', artifactId: undefined };
      app.view = { kind: 'workspace' };
      writeUrl('project');
      app.render();
    } else app.showNote(app.workspace.noteId);
  });
}

function renderNavigation() {
  const query = document.getElementById('navSearch').value.toLowerCase().trim();
  const s = app.state;
  function link(kind, id, title, icon, extra = '') {
    const active = kind === 'note'
      ? app.workspace.mode === 'note' && app.view.kind === 'workspace' && app.workspace.noteId === id
      : kind === 'mission'
        ? app.view.kind === 'workspace' && app.workspace.missionId === id
        : kind === 'task'
          ? app.view.kind === 'workspace' && app.workspace.taskId === id
          : kind === 'changes'
            ? app.view.kind === 'changes'
            : kind === 'project' && app.workspace.mode === 'project' && app.view.kind === 'workspace';
    return `<button class="tree-item pp-kind-${kind} ${active ? 'active' : ''}" title="${app.escape(title)}" data-view="${kind}" ${id ? `data-id="${app.escape(id)}"` : ''}><span class="tree-icon">${icon}</span><span class="tree-label">${app.escape(title)}</span>${extra}</button>`;
  }
  const projectNoteId = s.projectNoteId || s.notes.find(note => note.id === 'product-overview')?.id;
  const centeredMission = s.missions.find(mission => mission.noteId === app.workspace.noteId);
  const missionNoteIds = new Set(s.missions.map(mission => mission.noteId).filter(Boolean));
  const taskNoteIds = new Set(s.tasks.map(task => task.noteId).filter(Boolean));
  const areaTree = s.areas.map(area => {
    const rootNoteId = canonicalNoteId(s, area);
    const missions = s.missions.filter(mission => mission.areaId === area.id);
    const standaloneTasks = s.tasks.filter(task => task.areaId === area.id && !task.missionId);
    const supportingNotes = s.notes.filter(note => (note.parentNoteId === rootNoteId || (area.noteIds || []).includes(note.id)) && note.id !== rootNoteId && !missionNoteIds.has(note.id) && !taskNoteIds.has(note.id));
    const missionRows = missions.map(mission => {
      const children = centeredMission?.id === mission.id
        ? [...s.tasks.filter(task => task.missionId === mission.id).map(task => link('task', task.id, task.title, '·')), ...(s.artifacts || []).filter(artifact => artifact.parentNoteId === mission.noteId).map(artifact => link('artifact', artifact.id, artifact.title, '↗'))].join('')
        : '';
      return `${link('mission', mission.id, mission.title, '⬡', mission.phase === 'complete' ? '<small>done</small>' : '')}${children ? `<div class="tree-children">${children}</div>` : ''}`;
    });
    const items = [...missionRows, ...standaloneTasks.map(task => link('task', task.id, task.title, '·')), ...supportingNotes.map(note => link('note', note.id, note.title, '·'))];
    const visible = !query || [area.name, ...missions.map(mission => mission.title), ...standaloneTasks.map(task => task.title), ...supportingNotes.map(note => note.title)].some(title => title.toLowerCase().includes(query));
    if (!visible) return '';
    return `<section class="pp-area-nav" data-area-id="${app.escape(area.id)}"><div class="pp-area-nav-heading">${link('note', rootNoteId, area.name, '◇', area.status === 'proposed' ? '<small class="pp-proposed-dot">Proposed</small>' : '')}</div><div class="tree-children pp-area-nav-children">${items.filter(item => !query || item.toLowerCase().includes(query)).join('') || '<p class="pp-nav-empty">No matching area items</p>'}</div></section>`;
  }).join('');
  const projectNotes = s.notes.filter(note => note.parentNoteId === projectNoteId && !missionNoteIds.has(note.id) && !taskNoteIds.has(note.id)).map(note => link('note', note.id, note.title, '·')).filter(item => !query || item.toLowerCase().includes(query));
  document.getElementById('projectNavigation').innerHTML = [
    link('note', projectNoteId, s.projectName || 'Fizzer', '◇'),
    projectNotes.length ? `<div class="sidebar-section-label">Project notes</div>${projectNotes.join('')}` : '',
    link('changes', '', 'Changes', '±', `<small>${s.changes.length || ''}</small>`),
    '<div class="sidebar-section-label">Areas & notes</div>', areaTree,
    areaTree ? '' : `<p class="pp-nav-empty">${query ? 'No matching notes' : 'No areas yet'}</p>`,
  ].join('');
}

function visibleTasks() {
  return app.state.tasks.filter(task => workFilter === 'all' || (task.kind === 'human' && task.assignees.includes(app.state.currentUser))).sort((a, b) => a.priority.localeCompare(b.priority) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
}

function taskCard(task, compact = false) {
  const area = app.state.areas.find(item => item.id === task.areaId);
  const key = `task:${task.id}`;
  return `<article class="pp-task ${compact ? 'pp-task-row' : ''}" draggable="true" data-drag-task="${app.escape(task.id)}"><details data-expand-card="${app.escape(key)}" ${expandedCards.has(key) ? 'open' : ''}><summary class="pp-task-open"><span class="pp-task-top"><span class="pp-priority ${task.priority.toLowerCase()}">${app.escape(task.priority)}</span><span>${task.kind === 'human' ? 'Human task' : 'Agent task'}</span><span class="pp-card-caret">›</span></span><strong>${app.escape(task.title)}</strong><span class="pp-task-meta"><span>${app.escape(task.assignees.join(' + ') || 'Unassigned')}</span><time>${task.dueDate ? app.escape(new Date(`${task.dueDate}T12:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' })) : 'No due date'}</time></span>${!task.missionId ? `<span class="pp-task-area">${app.escape(area?.name || 'Project')}</span>` : ''}</summary><div class="pp-task-detail"><p>${app.escape(task.description)}</p><span class="pp-chip">${STATUS_LABELS[task.status]}</span><button class="pp-text-button" data-task="${app.escape(task.id)}">Edit task</button><button class="pp-text-button" data-open-chat-task="${app.escape(task.id)}">Open chat</button></div></details></article>`;
}

function missionColumn(mission) {
  return mission.phase === 'complete' ? 'done' : mission.phase === 'proposal' ? 'todo' : 'in-progress';
}

function missionCard(mission) {
  const tasks = app.state.tasks.filter(task => task.missionId === mission.id && (workFilter === 'all' || (task.kind === 'human' && task.assignees.includes(app.state.currentUser))));
  const area = app.state.areas.find(item => item.id === mission.areaId);
  const key = `mission:${mission.id}`;
  const done = tasks.filter(task => task.status === 'done').length;
  return `<article class="pp-board-mission" draggable="true" data-drag-mission="${app.escape(mission.id)}"><details data-expand-card="${app.escape(key)}" ${expandedCards.has(key) ? 'open' : ''}><summary class="pp-mission-summary"><span class="pp-task-top"><span class="pp-mission-kind">Mission</span><span>${PHASE_LABELS[mission.phase]}</span><span class="pp-card-caret">›</span></span><strong>${app.escape(mission.title)}</strong><span class="pp-task-area">${app.escape(area?.name || 'Project')}</span><span class="pp-mission-progress"><span>${tasks.length} tasks</span><span>${done} completed</span></span><progress value="${done}" max="${tasks.length || 1}" aria-label="${done} of ${tasks.length} tasks complete"></progress></summary><div class="pp-mission-tasks">${['todo', 'in-progress', 'done'].map(status => { const group = tasks.filter(task => task.status === status); return group.length ? `<section class="pp-mission-task-group" data-task-group="${status}"><h4><span class="pp-status-dot ${status}"></span>${STATUS_LABELS[status]}<span>${group.length}</span></h4>${group.map(task => taskCard(task, true)).join('')}</section>` : ''; }).join('') || '<p class="pp-empty">No tasks yet</p>'}</div></details><footer><button class="pp-text-button" data-open-chat-mission="${app.escape(mission.id)}">Open chat</button><button class="pp-text-button" data-view="mission" data-id="${app.escape(mission.id)}">Open mission ↗</button></footer></article>`;
}

function missionList() {
  const missions = app.state.missions.filter(mission => mission.phase !== 'complete');
  return `<section class="pp-panel"><div class="pp-section-title"><h2>Active missions <span class="pp-muted">${missions.length}</span></h2><button class="pp-text-button" data-action="new-mission">New</button></div>${missions.map(mission => `<div class="pp-mission-card"><small class="pp-muted">${app.escape(app.state.areas.find(area => area.id === mission.areaId)?.name || '')}</small><h3>${app.escape(mission.title)}</h3><div class="pp-mission-card-footer"><span class="pp-chip">${PHASE_LABELS[mission.phase]}</span><span><button class="pp-text-button" data-open-chat-mission="${app.escape(mission.id)}">Open chat</button> <button class="pp-text-button" data-view="mission" data-id="${app.escape(mission.id)}">Open mission ↗</button></span></div></div>`).join('') || '<p class="pp-empty">No active missions</p>'}</section>`;
}

function recentChanges(collapsible = false) {
  const entries = `${app.state.changes.slice(0, 4).map(change => `<button class="pp-change-row" data-view="changes"><span class="pp-change-icon">±</span><span><strong>${app.escape(change.title)}</strong><small>${app.escape(change.author)} · ${app.escape(change.at)}</small></span></button>`).join('') || '<p class="pp-empty">No new changes</p>'}${app.state.areas.filter(area => area.status === 'proposed').map(area => `<div class="pp-proposal"><span class="pp-eyebrow">Area to consider</span><h3>${app.escape(area.name)}</h3><p>${app.escape(area.summary)}</p><button class="pp-text-button" data-view="area" data-id="${app.escape(area.id)}">Review proposal ↗</button></div>`).join('')}`;
  return collapsible ? `<details class="pp-home-updates" ${updatesOpen ? 'open' : ''}><summary>Since your last look <span>${app.state.changes.length}</span></summary><div class="pp-updates-body">${entries}<button class="pp-text-button pp-all-changes" data-view="changes">All changes ↗</button></div></details>` : `<section class="pp-panel"><div class="pp-section-title"><h2>Since your last look</h2><button class="pp-text-button" data-view="changes">All changes</button></div>${entries}</section>`;
}

function renderProject(root) {
  const tasks = visibleTasks();
  const assigned = app.state.tasks.filter(task => task.kind === 'human' && task.assignees.includes(app.state.currentUser) && task.status !== 'done');
  const next = assigned.sort((a, b) => a.priority.localeCompare(b.priority))[0];
  root.innerHTML = `<div class="pp-page pp-dashboard ${variant === 'A' ? `pp-dashboard-workspace ${boardExpanded ? 'pp-board-expanded' : ''}` : ''}"><header class="pp-project-header"><div><span class="pp-eyebrow">Project work</span><h1>${app.escape(app.state.projectName)}</h1><p>${app.state.setup === 'greenfield' ? 'Define the product together.' : 'Current tasks, missions, and delivery context.'}</p></div><div class="pp-header-actions">${workspaceModeToggle()}<button class="pp-button" data-action="new-mission">New mission</button><button class="pp-button primary" data-action="new-task">+ New task</button></div></header>${variant !== 'A' && next ? `<section class="pp-next"><span class="pp-avatar">PM</span><div><strong>Next for ${app.escape(app.state.currentUser)}</strong><p>${app.escape(next.title)}</p></div><button class="pp-button" data-task="${app.escape(next.id)}">View task</button></section>` : ''}<div class="pp-work-toolbar"><div class="pp-filter" role="group" aria-label="Work filter" ${variant === 'A' && !boardExpanded ? 'hidden' : ''}><button data-filter="mine" class="${workFilter === 'mine' ? 'active' : ''}">My work <span>${assigned.length}</span></button><button data-filter="all" class="${workFilter === 'all' ? 'active' : ''}">All work</button></div>${variant === 'A' ? `<button class="pp-text-button" id="expandBoard" aria-expanded="${boardExpanded}">${boardExpanded ? '← Focus in progress' : 'Expand board →'}</button>` : `<span class="pp-muted pp-small">${tasks.length} tasks</span>`}</div><div id="dashboardLayout"></div></div>`;
  const layout = root.querySelector('#dashboardLayout');
  if (variant === 'A') {
    const missions = app.state.missions.filter(mission => workFilter === 'all' || app.state.tasks.some(task => task.missionId === mission.id && task.kind === 'human' && task.assignees.includes(app.state.currentUser)));
    const standalone = tasks.filter(task => !task.missionId);
    layout.innerHTML = `<div class="pp-workspace-grid ${boardExpanded ? 'pp-board-expanded' : ''}"><section class="pp-board" aria-label="Mission and task Kanban">${['todo', 'in-progress', 'done'].map(status => { const columnMissions = missions.filter(mission => missionColumn(mission) === status); const columnTasks = standalone.filter(task => task.status === status); const label = !boardExpanded && status === 'in-progress' ? 'Current tasks' : STATUS_LABELS[status]; return `<section class="pp-column" data-drop-status="${status}"><header><span class="pp-status-dot ${status}"></span><h2>${label}</h2><span>${columnMissions.length + columnTasks.length}</span></header><div class="pp-column-tasks">${columnMissions.map(missionCard).join('')}${columnTasks.map(task => taskCard(task)).join('')}${columnMissions.length || columnTasks.length ? '' : '<p class="pp-empty">Drop work here</p>'}</div></section>`; }).join('')}</section><aside class="pp-home-activity"><section class="pp-home-chat" aria-label="Project conversation"></section>${recentChanges(true)}</aside></div>`;
    app.mountChat(root.querySelector('.pp-home-chat'), 'general', { noteId: app.state.projectNoteId || 'product-overview' });
    root.querySelector('#expandBoard').onclick = () => setBoardExpanded(!boardExpanded);
    root.querySelector('.pp-home-updates > summary').onclick = event => { updatesOpen = !event.currentTarget.parentElement.open; };
    setBoardExpanded(boardExpanded);
  } else if (variant === 'B') {
    const dates = [...new Set(tasks.map(task => task.dueDate))].sort((a, b) => (a || '9999').localeCompare(b || '9999'));
    layout.innerHTML = `<div class="pp-agenda-layout"><section class="pp-agenda"><div class="pp-section-title"><h2>Delivery dates</h2><span class="pp-muted pp-small">${app.escape(app.state.currentUser)}'s work and shared responsibilities</span></div>${dates.map(date => `<section class="pp-date-group"><header><strong>${date ? app.escape(new Date(`${date}T12:00:00`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })) : 'Not scheduled'}</strong><small>${date ? 'Deliver by this date' : 'Choose a delivery date'}</small></header><div>${tasks.filter(task => task.dueDate === date).map(task => taskCard(task, true)).join('')}</div></section>`).join('') || '<p class="pp-empty">No work scheduled yet.</p>'}</section><aside class="pp-dashboard-side">${missionList()}${recentChanges()}</aside></div>`;
  } else {
    layout.innerHTML = `<section class="pp-area-overview" aria-label="Areas and their work">${app.state.areas.map(area => { const areaTasks = tasks.filter(task => task.areaId === area.id); const areaMissions = app.state.missions.filter(mission => mission.areaId === area.id); return `<article class="pp-area-lane"><div class="pp-area-intro"><span class="pp-eyebrow">${area.status === 'proposed' ? 'Proposed area' : 'Area'}</span><h2>${app.escape(area.name)}</h2><p>${app.escape(area.summary)}</p><button class="pp-button" data-view="note" data-id="${app.escape(area.noteId || area.noteIds?.[0] || '')}">${area.status === 'proposed' ? 'Review note' : 'Open note'}</button><small>${area.noteIds?.length || 0} notes · ${areaMissions.length} missions</small></div><div class="pp-area-work"><h3>Tasks</h3>${areaTasks.map(task => taskCard(task, true)).join('') || '<p class="pp-empty">No tasks assigned</p>'}</div><div class="pp-area-missions"><h3>Missions</h3>${areaMissions.map(mission => `<div><span class="pp-chip">${PHASE_LABELS[mission.phase]}</span><h4>${app.escape(mission.title)}</h4><button class="pp-button" data-open-chat-mission="${app.escape(mission.id)}">Open chat</button> <button class="pp-button" data-view="mission" data-id="${app.escape(mission.id)}">Open section ↗</button></div>`).join('') || '<p class="pp-empty">No missions yet</p>'}</div></article>`; }).join('') || '<div class="pp-empty">No areas yet. Start in the project channel.</div>'}${tasks.some(task => !task.areaId) ? `<section class="pp-panel"><h2>Project-wide work</h2>${tasks.filter(task => !task.areaId).map(task => taskCard(task, true)).join('')}</section>` : ''}</section><div class="pp-area-footer">${recentChanges()}</div>`;
  }
  bindProjectInteractions(root);
}

function bindProjectInteractions(root) {
  root.querySelectorAll('[data-workspace-mode]').forEach(button => button.onclick = () => button.dataset.workspaceMode === 'note' ? app.showNote(app.workspace.noteId) : (app.workspace = { ...app.workspace, mode: 'project', artifactId: undefined }, app.view = { kind: 'workspace' }, writeUrl('project'), app.render()));
  root.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { workFilter = button.dataset.filter; app.render(); });
  root.querySelectorAll('[data-expand-card] > summary').forEach(summary => summary.onclick = () => { const details = summary.parentElement; if (details.open) expandedCards.delete(details.dataset.expandCard); else expandedCards.add(details.dataset.expandCard); });
  root.querySelectorAll('[data-drag-task], [data-drag-mission]').forEach(card => {
    card.ondragstart = event => { if (card.dataset.dragMission && event.target.closest('[data-drag-task]')) return; event.stopPropagation(); event.dataTransfer.setData('text/plain', JSON.stringify(card.dataset.dragTask ? { kind: 'task', id: card.dataset.dragTask } : { kind: 'mission', id: card.dataset.dragMission })); event.dataTransfer.effectAllowed = 'move'; card.classList.add('pp-dragging'); setBoardExpanded(true); };
    card.ondragend = event => { event.stopPropagation(); card.classList.remove('pp-dragging'); root.querySelectorAll('.pp-dragover').forEach(column => column.classList.remove('pp-dragover')); };
  });
  root.querySelectorAll('[data-drop-status]').forEach(column => {
    column.ondragover = event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('pp-dragover'); };
    column.ondragleave = event => { if (!column.contains(event.relatedTarget)) column.classList.remove('pp-dragover'); };
    column.ondrop = event => { event.preventDefault(); column.classList.remove('pp-dragover'); let card; try { card = JSON.parse(event.dataTransfer.getData('text/plain')); } catch { return; } if (card?.kind === 'task') changeTaskStatus(card.id, column.dataset.dropStatus); else if (card?.kind === 'mission') moveMission(card.id, column.dataset.dropStatus); };
  });
}

function setBoardExpanded(expanded) {
  if (variant !== 'A') return;
  const grid = document.querySelector('.pp-workspace-grid');
  const dashboard = document.querySelector('.pp-dashboard-workspace');
  if (!grid || !dashboard) return;
  const changed = boardExpanded !== expanded;
  if (!expanded && workFilter === 'mine') { workFilter = 'all'; boardExpanded = false; if (changed) updatesOpen = true; app.render(); return; }
  boardExpanded = expanded;
  dashboard.classList.toggle('pp-board-expanded', expanded);
  grid.classList.toggle('pp-board-expanded', expanded);
  const filter = dashboard.querySelector('.pp-filter');
  if (filter) filter.hidden = !expanded;
  const button = dashboard.querySelector('#expandBoard');
  if (button) { button.setAttribute('aria-expanded', String(expanded)); button.textContent = expanded ? '← Focus in progress' : 'Expand board →'; }
  if (changed) updatesOpen = !expanded;
  grid.querySelectorAll('[data-drop-status]').forEach(column => { const focused = column.dataset.dropStatus === 'in-progress'; column.hidden = !expanded && !focused; const heading = column.querySelector('h2'); if (heading) heading.textContent = !expanded && focused ? 'Current tasks' : STATUS_LABELS[column.dataset.dropStatus]; });
  const updates = grid.querySelector('.pp-home-updates');
  if (updates) updates.open = updatesOpen;
}

function moveMission(id, status) {
  const mission = app.state.missions.find(item => item.id === id);
  if (!mission || missionColumn(mission) === status) return;
  const tasks = app.state.tasks.filter(task => task.missionId === id);
  const canComplete = status === 'done' && ['executing', 'verification'].includes(mission.phase) && mission.conditions.every(condition => condition.done) && tasks.every(task => task.status === 'done');
  if (canComplete) { app.state = { ...app.state, missions: app.state.missions.map(item => item.id === id ? { ...item, phase: 'complete' } : item) }; app.render(); return; }
  app.navigate({ kind: 'mission', id });
  app.notice(status === 'done' ? 'Complete the remaining delivery checks before finishing this mission.' : 'Mission progress follows its approvals and delivery checks. Move individual tasks within the mission.');
}

function changeTaskStatus(id, status) {
  const task = app.state.tasks.find(item => item.id === id);
  if (!task || !Object.hasOwn(STATUS_LABELS, status)) return;
  if ((task.action?.startsWith('approve') || task.action?.startsWith('verify')) && status === 'done' && task.status !== 'done') { app.navigate({ kind: 'mission', id: task.missionId }); app.notice(task.action.startsWith('approve') ? 'Review and approve this item in the mission view.' : 'Review and complete this delivery check in the mission view.'); return; }
  app.state = patchPrototypeTask(app.state, id, { status });
  app.render();
}

function openTask(id) {
  const existing = app.state.tasks.find(item => item.id === id);
  const task = existing || { id: newId(), title: '', description: '', areaId: app.view.kind === 'area' ? app.view.id : app.state.areas.find(area => area.status === 'active')?.id || null, missionId: null, kind: 'human', assignees: [app.state.currentUser], dueDate: '', priority: 'P2', status: 'todo' };
  const dialog = document.getElementById('taskDialog');
  dialog.innerHTML = `<form id="taskEditForm"><header><div><span class="pp-eyebrow">${task.missionId ? 'Mission task' : 'Standalone task'}</span><h2>${existing ? 'Task details' : 'New task'}</h2></div><button type="button" data-close="taskDialog" aria-label="Close task">×</button></header><label class="pp-field">Title<input name="title" value="${app.escape(task.title)}" required autofocus></label><label class="pp-field">Instructions<textarea name="description" rows="3">${app.escape(task.description)}</textarea></label><div class="pp-form-grid"><label class="pp-field">Area<select name="areaId"><option value="">Project-wide</option>${app.state.areas.filter(area => area.status === 'active').map(area => `<option value="${app.escape(area.id)}" ${task.areaId === area.id ? 'selected' : ''}>${app.escape(area.name)}</option>`).join('')}</select></label><label class="pp-field">Mission<select name="missionId" ${task.action ? 'disabled' : ''}><option value="">Standalone · no mission</option>${app.state.missions.map(mission => `<option value="${app.escape(mission.id)}" ${task.missionId === mission.id ? 'selected' : ''}>${app.escape(mission.title)}</option>`).join('')}</select></label><label class="pp-field">Delivery date<input type="date" name="dueDate" value="${app.escape(task.dueDate)}"></label><label class="pp-field">Priority<select name="priority">${['P1', 'P2', 'P3'].map(priority => `<option ${task.priority === priority ? 'selected' : ''}>${priority}</option>`).join('')}</select></label></div><fieldset class="pp-assignees"><legend>Assigned to · any one can complete</legend>${(task.kind === 'human' ? PEOPLE : task.assignees).map(person => `<label><input type="checkbox" name="assignee" value="${app.escape(person)}" ${task.assignees.includes(person) ? 'checked' : ''}> ${app.escape(person)}</label>`).join('')}</fieldset><label class="pp-field">Status<select name="status" ${task.action?.startsWith('approve') ? 'disabled' : ''}>${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>${task.completedBy ? `<p class="pp-muted pp-small">Completed by ${app.escape(task.completedBy)}</p>` : ''}<footer>${task.missionId ? '<button type="button" class="pp-button" id="taskOpenMission">Open mission</button>' : '<button type="button" class="pp-button" id="taskOpenChannel">Discuss in channel</button>'}${existing ? `<button type="button" class="pp-button" id="taskOpenChat">Open chat</button>` : ''}<button class="pp-button primary" type="submit">Save task</button></footer></form>`;
  dialog.showModal();
  dialog.querySelector('#taskEditForm').onsubmit = event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const missionId = task.action ? task.missionId : form.get('missionId') || null;
    const patch = { title: form.get('title').trim(), description: form.get('description'), areaId: missionId ? app.state.missions.find(mission => mission.id === missionId)?.areaId : form.get('areaId') || null, missionId, dueDate: form.get('dueDate'), priority: form.get('priority'), assignees: form.getAll('assignee'), status: form.get('status') || task.status };
    if (!patch.title) return;
    let nextState = existing ? { ...app.state, tasks: app.state.tasks.map(item => item.id === task.id ? { ...item, ...patch } : item) } : { ...app.state, tasks: [...app.state.tasks, { ...task, ...patch }] };
    let savedTask = nextState.tasks.find(item => item.id === task.id);
    const noteId = savedTask.noteId || `${savedTask.id}-note`;
    const channelId = savedTask.channelId || `${savedTask.id}-channel`;
    savedTask = { ...savedTask, noteId, channelId };
    nextState = { ...nextState, tasks: nextState.tasks.map(item => item.id === savedTask.id ? savedTask : item) };
    if (!nextState.notes.some(note => note.id === noteId)) nextState.notes = [...nextState.notes, { id: noteId, title: savedTask.title, areaId: savedTask.areaId || null, parentNoteId: savedTask.missionId ? nextState.missions.find(mission => mission.id === savedTask.missionId)?.noteId || null : null, content: `# ${savedTask.title}\n\n${savedTask.description || 'Discuss the intended work and next step here.'}${savedTask.missionId ? `\n\n[[${nextState.missions.find(mission => mission.id === savedTask.missionId)?.title || 'Mission'}]]` : ''}`, updatedBy: nextState.currentUser, updatedAt: nowLabel() }];
    if (!nextState.channels.some(channel => channel.id === channelId)) nextState.channels = [...nextState.channels, { id: channelId, name: savedTask.title, areaId: savedTask.areaId || null, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] }];
    app.state = nextState;
    dialog.close();
    app.render();
    app.notice('Task saved.');
  };
  dialog.querySelector('#taskOpenMission')?.addEventListener('click', () => { dialog.close(); app.navigate({ kind: 'mission', id: task.missionId }); });
  dialog.querySelector('#taskOpenChannel')?.addEventListener('click', () => { dialog.close(); app.openConversation({ kind: 'task', id: task.id }); });
  dialog.querySelector('#taskOpenChat')?.addEventListener('click', () => { dialog.close(); app.openConversation({ kind: 'task', id: task.id }); });
}

function openMissionForm() {
  const areas = app.state.areas.filter(area => area.status === 'active');
  if (!areas.length) { app.openConversation({ kind: 'channel', id: app.state.projectChannelId || 'general' }); app.notice('Create an area before proposing a mission.'); return; }
  const selectedArea = app.view.kind === 'area' ? app.state.areas.find(area => area.id === app.view.id) : areaForNote(app.state, app.workspace.noteId);
  const dialog = document.getElementById('missionDialog');
  const defaultSection = '## New mission\n\n### Current step\nGroup discussion and shared product definition.\n\n### Intended behavior\nDescribe what should become possible.\n\n### Rationale\nExplain why this matters now.\n\n### Checklist\n- [ ] Review this mission section with the team';
  dialog.innerHTML = `<form id="newMissionForm"><header><div><span class="pp-eyebrow">Product documentation</span><h2>Create mission note</h2></div><button type="button" data-close="missionDialog" aria-label="Close mission form">×</button></header><p class="pp-muted pp-small">Capture the mission context as its own editable note and conversation. Execution planning stays separate.</p><label class="pp-field">Area<select name="areaId">${areas.map(area => `<option value="${app.escape(area.id)}" ${area.id === selectedArea?.id ? 'selected' : ''}>${app.escape(area.name)}</option>`).join('')}</select></label><label class="pp-field">Mission document · Markdown<textarea name="section" rows="16" required spellcheck="true">${app.escape(defaultSection)}</textarea></label><footer><button type="button" class="pp-button" data-close="missionDialog">Cancel</button><button class="pp-button primary">Create mission</button></footer></form>`;
  dialog.showModal();
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const content = String(form.get('section') || '').trim();
    const area = app.state.areas.find(item => item.id === String(form.get('areaId') || ''));
    const areaNote = area && app.state.notes.find(note => note.id === area.noteId);
    if (!content || !area || !areaNote) return;
    const lines = content.split(/\r?\n/);
    const title = (lines.find(line => /^##\s+/.test(line)) || '## Untitled mission').replace(/^##\s+/, '').trim() || 'Untitled mission';
    const section = heading => {
      const start = lines.findIndex(line => new RegExp(`^###\\s+${heading}\\s*$`, 'i').test(line.trim()));
      if (start < 0) return '';
      const end = lines.findIndex((line, index) => index > start && /^###\s+/.test(line.trim()));
      return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
    };
    const checklist = lines.filter(line => /^\s*-\s*\[\s\]\s+/.test(line)).map(line => line.replace(/^\s*-\s*\[\s\]\s+/, '').trim()).filter(Boolean);
    const id = newId();
    const conditions = (checklist.length ? checklist : ['Review and agree on this mission section before planning.']).map(text => ({ id: newId(), text, owner: 'human', done: false }));
    const missionNoteId = `${id}-note`;
    const missionChannelId = `${id}-channel`;
    const missionBody = content.replace(/^##\s+[^\n]+\s*/i, '').trim();
    const mission = { id, title, noteId: missionNoteId, channelId: missionChannelId, areaId: area.id, behavior: section('Intended behavior') || section('Behavior') || title, why: section('Rationale') || section('Why') || 'The team is deciding this together.', currentStep: section('Current step') || 'Group discussion', phase: 'proposal', plan: '', conditions };
    const approvalTaskId = newId();
    const approvalTask = { id: approvalTaskId, title: `Approve mission: ${title}`, description: 'Review the mission document and its human checklist before planning.', areaId: area.id, missionId: id, noteId: `${approvalTaskId}-note`, channelId: `${approvalTaskId}-channel`, kind: 'human', assignees: [app.state.currentUser], dueDate: '', priority: 'P1', status: 'todo', action: 'approve-mission' };
    const missionNote = { id: missionNoteId, title, areaId: area.id, parentNoteId: area.noteId, content: `# ${title}\n\n${missionBody}`, updatedBy: app.state.currentUser, updatedAt: nowLabel() };
    const taskNote = { id: approvalTask.noteId, title: approvalTask.title, areaId: area.id, parentNoteId: missionNoteId, content: `# ${approvalTask.title}\n\n${approvalTask.description}\n\n[[${title}]]`, updatedBy: app.state.currentUser, updatedAt: nowLabel() };
    const channels = [{ id: missionChannelId, name: title, areaId: area.id, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] }, { id: approvalTask.channelId, name: approvalTask.title, areaId: area.id, mode: 'live', quietMinutes: 15, processedCount: 0, messages: [] }];
    app.state = { ...app.state, missions: [...app.state.missions, mission], tasks: [...app.state.tasks, approvalTask], notes: [...app.state.notes, missionNote, taskNote], channels: [...app.state.channels, ...channels] };
    dialog.close();
    app.openMission(id, {});
    app.notice(`Mission section “${title}” was added to ${area.name}.`);
  };
}

function renderSetup(root) {
  root.innerHTML = `<div class="pp-page pp-setup"><span class="pp-eyebrow">Two ways to begin</span><h1>Start with understanding.</h1><p class="pp-lead">A project can begin with a group conversation or an existing product. Coding can come later.</p><div class="pp-setup-options"><section class="pp-panel"><span class="pp-chip">Greenfield</span><h2>Define a new product together</h2><p>Bring people into a channel with the PM. Talk through the product; let the notes and areas emerge.</p><form id="greenfieldForm"><label class="pp-field">Project name<input name="name" placeholder="What are you working on?" required></label><button class="pp-button primary">Start product conversation</button></form><small>No repository, completed spec, or coding agents required.</small></section><section class="pp-panel"><span class="pp-chip">Existing product</span><h2>Connect a project to its context</h2><p>Start with product notes, then let conversations shape accountable missions and tasks.</p><button class="pp-button" data-view="project">Use Fizzer sample</button></section></div></div>`;
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get('name').trim();
    if (!name) return;
    app.state = createPrototypeState(true);
    app.state.projectName = name;
    const projectNote = { id: 'product-overview', title: name, areaId: null, content: `# ${name}\n\n## Product direction\n\nUse the team conversation to shape the product note before creating areas or missions.`, updatedBy: app.state.currentUser, updatedAt: nowLabel() };
    app.state = { ...app.state, projectNoteId: 'product-overview', projectChannelId: 'general', notes: [projectNote] };
    const url = new URL(location.href);
    url.searchParams.set('scenario', 'greenfield');
    history.replaceState(null, '', url);
    app.workspace = { mode: 'note', noteId: 'product-overview', channelId: 'general' };
    app.openConversation({ kind: 'channel', id: 'general' }, { replace: true });
  };
}


function restoreView() {
  const query = new URLSearchParams(location.search);
  variant = variants.includes(query.get('variant')) ? query.get('variant') : 'A';
  const kind = query.get('view');
  if (kind === 'project') { app.workspace = { ...app.workspace, mode: 'project', artifactId: undefined }; app.view = { kind: 'workspace' }; return app.render(); }
  if (kind === 'note') return query.get('artifact') ? app.openArtifact(query.get('artifact'), { replace: true }) : app.showNote(query.get('id') || app.workspace.noteId, { replace: true });
  if (kind === 'mission' && query.get('id')) return app.openMission(query.get('id'), { replace: true });
  if (kind === 'task' && query.get('id')) return app.openTaskWorkspace(query.get('id'), { replace: true });
  if (kind === 'channel' && query.get('id')) return app.openConversation({ kind: 'channel', id: query.get('id') }, { replace: true });
  app.workspace = { ...app.workspace, mode: 'note', noteId: app.state.notes.find(note => note.id === 'project-interface-note')?.id || app.state.projectNoteId || app.state.notes.find(note => note.id === 'product-overview')?.id || null, contextNoteId: app.state.notes.find(note => note.id === 'project-interface-note')?.id || app.state.projectNoteId || app.state.notes.find(note => note.id === 'product-overview')?.id || null, missionId: undefined, channelId: app.state.channels.find(channel => channel.id === 'project-interface-channel')?.id || app.state.projectChannelId || 'general' };
  app.view = { kind: 'workspace' };
  app.render();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) app.navigate({ kind: button.dataset.view, ...(button.dataset.id ? { id: button.dataset.id } : {}) });
  else if (button.dataset.openChatTask) app.openConversation({ kind: 'task', id: button.dataset.openChatTask });
  else if (button.dataset.openChatMission) app.openConversation({ kind: 'mission', id: button.dataset.openChatMission });
  else if (button.dataset.task) app.openTask(button.dataset.task);
  else if (button.dataset.close) document.getElementById(button.dataset.close).close();
  else if (button.dataset.action === 'new-task') app.openTask();
  else if (button.dataset.action === 'reset') { app.state = createPrototypeState(); workFilter = 'all'; boardExpanded = false; updatesOpen = true; expandedCards.clear(); app.chatDrafts.clear(); app.workspace = { mode: 'note', noteId: 'project-interface-note', missionId: undefined, channelId: 'project-interface-channel' }; app.view = { kind: 'workspace' }; const url = new URL(location.href); url.searchParams.delete('scenario'); url.searchParams.delete('view'); url.searchParams.delete('id'); url.searchParams.delete('artifact'); history.replaceState(null, '', url); app.render(); app.notice('Preview reset to the Project Interface note.'); }
});
document.getElementById('navSearch').oninput = renderNavigation;
document.getElementById('currentUser').onchange = event => { app.state.currentUser = event.target.value; app.render(); };
document.getElementById('sidebarToggle').onclick = () => { const shell = document.getElementById('prototypeShell'); if (matchMedia('(max-width: 720px)').matches) shell.classList.toggle('pp-mobile-nav'); else shell.classList.toggle('sidebar-collapsed'); };
document.getElementById('currentViewTab').onclick = () => document.getElementById('prototypeContent').scrollTo({ top: 0, behavior: 'smooth' });
window.addEventListener('popstate', restoreView);
restoreView();
