import { PEOPLE, newId, nowLabel, resolveNoteLink } from './projects-areas-prototype-model.js';

const ACTION_ICON = '<svg class="pp-chat-action-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.25 17 5.7v4.8c0 3.45-2.95 6.3-7 7.25-4.05-.95-7-3.8-7-7.25V5.7l7-3.45Z"/><path d="m6.7 10.15 2.15 2.15 4.55-4.55"/></svg>';

const escape = (app, value) => app.escape(String(value ?? ''));
const byId = (items, id) => (items || []).find(item => item.id === id);
const artifactUiStates = new WeakMap();

function noteLink(app, title, sourceNoteId) {
  const target = resolveNoteLink(app.state, sourceNoteId || app.state.projectNoteId, title);
  if (!target) return escape(app, title);
  const kind = target.kind === 'artifact' ? 'artifact' : target.kind;
  return `<button class="pp-chat-note" data-source-link-kind="${escape(app, kind)}" data-chat-open="${escape(app, kind)}" data-id="${escape(app, target.id)}" data-note-id="${escape(app, target.noteId || '')}">${escape(app, title)}</button>`;
}

function renderBody(app, body, sourceNoteId) {
  return escape(app, body)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([^\]]+)\]\]/g, (_, title) => noteLink(app, title, sourceNoteId));
}

function actionLink(app, kind, id, label) {
  if (!id) return '';
  return `<button class="pp-chat-link" data-source-link-kind="${escape(app, kind)}" data-chat-open="${escape(app, kind)}" data-id="${escape(app, id)}">${escape(app, label)}</button>`;
}

function renderAction(app, message) {
  const action = message.action || {};
  const taskIds = action.taskIds || (action.taskId ? [action.taskId] : []);
  const tasks = taskIds.map(id => byId(app.state.tasks, id)).filter(Boolean);
  const mission = byId(app.state.missions, action.missionId);
  const note = byId(app.state.notes, action.noteId);
  const links = [
    ...tasks.map(task => actionLink(app, 'task', task.id, task.title)),
    actionLink(app, 'mission', mission?.id, mission?.title || 'Mission'),
    actionLink(app, 'note', note?.id, note?.title || 'Note'),
  ].filter(Boolean).join('<span class="pp-chat-link-separator">·</span>');
  const verb = action.type === 'note-updated' ? 'Note updated' : action.type === 'review-requested' ? 'UX reviews requested' : action.type === 'cross-chat' ? 'Cross-chat context' : 'Task assigned';
  return `<div class="pp-chat-action" role="status"><div class="pp-chat-action-mark">${ACTION_ICON}</div><div class="pp-chat-action-copy"><div class="pp-chat-action-label"><strong>${escape(app, verb)}</strong><time>${escape(app, message.at)}</time></div><p>${escape(app, message.body)}</p><div class="pp-chat-action-links">${links}</div></div></div>`;
}

function renderMessage(app, message, sourceNoteId) {
  if (message.kind === 'action' || message.action) return renderAction(app, message);
  const roleClass = message.role === 'human' ? 'human' : message.role === 'pm' ? 'pm' : 'orchestrator';
  const initials = message.role === 'pm' ? 'PM' : message.role === 'orchestrator' ? 'CO' : escape(app, message.author?.[0] || '?');
  return `<div class="chat-message-group pp-chat-message ${roleClass}"><span class="chat-avatar ${roleClass !== 'human' ? 'agent' : ''}">${initials}</span><div class="chat-message-body"><div class="chat-message-meta"><strong>${escape(app, message.author)}</strong><span class="pp-chat-role">${message.role === 'pm' ? 'PM' : message.role === 'orchestrator' ? 'orchestrator' : 'human'}</span><time>${escape(app, message.at)}</time></div><p class="chat-message-text">${renderBody(app, message.body, sourceNoteId)}</p></div></div>`;
}
function appendPreviewUpdate(app, channelId) {
  if (app.state.chatPreviewApplied) return false;
  const note = byId(app.state.notes, 'mission-overhaul-note');
  const task = byId(app.state.tasks, 'overhaul-review-diego');
  const mission = byId(app.state.missions, 'mission-overhaul');
  if (!note || !task || !mission) return false;
  const marker = '## Diego prototype feedback';
  const updatedContent = note.content.includes(marker)
    ? note.content
    : `${note.content}\n\n${marker}\nDiego reviewed the Mission refactor document and found the note-to-task handoff understandable; he is checking one remaining coordination edge before calling the UX ready.`;
  if (updatedContent !== note.content) app.recordNote(note.id, updatedContent, 'Diego');
  task.description = 'Review the Mission refactor document and say whether language and handoff UX are ready. Diego added prototype feedback; the individual UX-ready call remains open.';
  task.status = 'in-progress';
  mission.conditions = mission.conditions.map(condition => condition.id === 'overhaul-ux-diego' ? { ...condition, done: false, assignees: ['Diego'] } : condition);
  app.state.noteActivity = (app.state.noteActivity || []).filter(activity => !(activity.noteId === note.id && activity.person === 'Diego' && activity.kind === 'reviewing'));
  app.state.noteActivity.push({ noteId: note.id, person: 'Diego', kind: 'editing', anchor: 'Mission refactor' });
  const channel = byId(app.state.channels, channelId);
  if (channel) {
    channel.messages.push(
      { id: newId(), author: 'Diego', role: 'human', body: 'I added feedback to the [[Mission refactor]] document. The handoff looks understandable so far; my separate UX-ready call remains open.', at: nowLabel() },
      { id: newId(), kind: 'action', author: 'Project manager', role: 'pm', body: 'Updated the Mission refactor document and Diego’s review task from prototype feedback.', at: nowLabel(), action: { type: 'note-updated', taskId: task.id, missionId: mission.id, noteId: note.id, assignee: 'Diego' } },
    );
  }
  app.state.chatPreviewApplied = true;
  return true;
}
function notePickerMarkup(app) {
  const notes = app.getContextNotes?.() || [];
  if (!notes.length) return '<p class="pp-notes-empty">No supporting notes in this scope.</p>';
  return notes.map(note => `<button type="button" class="pp-note-picker-item" data-note-select="${escape(app, note.id)}"><span class="pp-note-picker-kind">NOTE</span><span>${escape(app, note.title)}</span></button>`).join('');
}

function wireChatOpeners(app, element) {
  element.querySelectorAll('[data-chat-open]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      const kind = button.dataset.chatOpen;
      const id = button.dataset.id;
      if (kind === 'note') app.showNote?.(id);
      else if (kind === 'artifact') app.openArtifact?.(id);
      else app.openConversation?.({ kind, id });
    });
  });
  const picker = element.querySelector('[data-pp-notes-picker]');
  const pickerButton = element.querySelector('[data-pp-notes-toggle]');
  pickerButton?.addEventListener('click', () => {
    const open = picker?.toggleAttribute('hidden') === false;
    pickerButton.setAttribute('aria-expanded', String(open));
    if (open && picker) picker.innerHTML = notePickerMarkup(app);
  });
  picker?.addEventListener('click', event => {
    const button = event.target.closest('[data-note-select]');
    if (!button) return;
    app.selectContextNote?.(button.dataset.noteSelect);
    picker.hidden = true;
  });
}
function artifactBubbleMarkup(app, ui) {
  return ui.incoming.map(item => `<article class="pp-artifact-bubble" data-incoming-id="${escape(app, item.message.id)}"><strong>${escape(app, item.message.author)}</strong><p>${escape(app, item.message.body)}</p><div><button type="button" data-artifact-dismiss="${escape(app, item.message.id)}">Dismiss</button><button type="button" data-artifact-reply="${escape(app, item.message.id)}">Reply</button></div></article>`).join('');
}

function renderArtifactChat(app, element, channelId, options, ui) {
  const channel = byId(app.state.channels, channelId);
  if (!channel) {
    element.innerHTML = '<p class="pp-empty">Channel not found.</p>';
    return;
  }
  const drafts = app.chatDrafts || (app.chatDrafts = new Map());
  const history = (channel.messages || []).map(message => renderMessage(app, message, options.noteId)).join('');
  const unread = ui.unread ? `<span class="pp-artifact-unread">${ui.unread}</span>` : '';
  element.innerHTML = `<div class="pp-artifact-bubbles">${artifactBubbleMarkup(app, ui)}</div><div class="pp-artifact-history" ${ui.expanded ? '' : 'hidden'}><header><strong># ${escape(app, channel.name)}</strong><button type="button" data-artifact-collapse aria-label="Close chat">×</button></header><div class="pp-chat-messages" role="log" aria-label="${escape(app, channel.name)} messages">${history || '<p class="pp-empty">No messages yet</p>'}</div><form class="pp-local-composer"><textarea name="body" rows="2" aria-label="Reply in this chat" placeholder="Reply in this chat…"></textarea><button type="submit" aria-label="Send message">↑</button></form></div><button type="button" class="pp-artifact-chat-launch" data-artifact-expand><span>Chat</span>${unread}</button>`;
  const pane = element.closest('.pp-artifact-pane');
  pane?.classList.toggle('is-chat-expanded', ui.expanded);
  const form = element.querySelector('form');
  if (form) {
    form.elements.body.value = drafts.get(channelId) || '';
    form.elements.body.oninput = () => drafts.set(channelId, form.elements.body.value);
    form.onsubmit = event => {
      event.preventDefault();
      const body = form.elements.body.value.trim();
      if (!body) return;
      channel.messages.push({ id: newId(), author: app.state.currentUser, role: 'human', body, at: nowLabel() });
      drafts.delete(channelId);
      ui.expanded = true;
      ui.unread = 0;
      renderArtifactChat(app, element, channelId, options, ui);
      element.querySelector('textarea')?.focus();
    };
    form.elements.body.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    };
  }
  element.querySelector('[data-artifact-expand]')?.addEventListener('click', () => {
    ui.expanded = true;
    ui.unread = 0;
    renderArtifactChat(app, element, channelId, options, ui);
    element.querySelector('textarea')?.focus();
  });
  element.querySelector('[data-artifact-collapse]')?.addEventListener('click', () => {
    ui.expanded = false;
    pane?.classList.remove('is-chat-expanded');
    renderArtifactChat(app, element, channelId, options, ui);
  });
  element.querySelectorAll('[data-artifact-dismiss]').forEach(button => button.addEventListener('click', () => {
    ui.incoming = ui.incoming.filter(item => item.message.id !== button.dataset.artifactDismiss);
    renderArtifactChat(app, element, channelId, options, ui);
  }));
  element.querySelectorAll('[data-artifact-reply]').forEach(button => button.addEventListener('click', () => {
    ui.expanded = true;
    ui.unread = 0;
    renderArtifactChat(app, element, channelId, options, ui);
    element.querySelector('textarea')?.focus();
  }));
}

function scheduleArtifactIncoming(app, element, channelId, options, ui) {
  if (app.state.artifactIncomingSeeded) return;
  app.state.artifactIncomingSeeded = true;
  const timer = setTimeout(() => {
    if (!element.isConnected) return;
    const channel = byId(app.state.channels, channelId);
    if (!channel) return;
    const message = { id: newId(), author: 'Tyler', role: 'human', body: 'I can see the Mission refactor artifact in the scoped conversation. I am checking whether the surface keeps the team context understandable.', at: nowLabel() };
    channel.messages.push(message);
    ui.incoming.push({ message });
    ui.unread = ui.expanded ? 0 : 1;
    renderArtifactChat(app, element, channelId, options, ui);
    const expiry = setTimeout(() => {
      if (!element.isConnected) return;
      ui.incoming = ui.incoming.filter(item => item.message.id !== message.id);
      renderArtifactChat(app, element, channelId, options, ui);
    }, 5000);
    ui.timers.push(expiry);
  }, 650);
  ui.timers.push(timer);
}
function mountArtifactChat(app, element, channelId, options) {
  let ui = artifactUiStates.get(element);
  if (!ui || ui.artifactId !== options.artifactId) {
    ui?.timers?.forEach(clearTimeout);
    ui = { artifactId: options.artifactId, expanded: false, unread: 0, incoming: [], timers: [] };
    artifactUiStates.set(element, ui);
  }
  renderArtifactChat(app, element, channelId, options, ui);
  scheduleArtifactIncoming(app, element, channelId, options, ui);
}


export function mountPrototypeChat(app, element, channelId, options = {}) {
  if (options.artifactId) {
    mountArtifactChat(app, element, channelId, options);
    return;
  }
  const channel = byId(app.state.channels, channelId);
  if (!channel) {
    element.innerHTML = '<p class="pp-empty">Channel not found.</p>';
    return;
  }
  const drafts = app.chatDrafts || (app.chatDrafts = new Map());
  const isLaunchReview = ['general', 'project-interface-channel', 'launch-channel'].includes(channelId);
  const roleLabel = options.orchestrator ? 'Coding orchestrator' : 'Project manager';
  const sourceNoteId = options.noteId || app.state.workspace?.noteId || app.state.projectNoteId;
  const messageMarkup = (channel.messages || []).map(message => renderMessage(app, message, sourceNoteId)).join('');
  element.classList.add('pp-chat-frame');
  element.innerHTML = `<header class="chat-header pp-chat-header"><div class="chat-header-copy"><span class="pp-chat-context">${options.orchestrator ? 'MISSION CHANNEL' : 'TEAM CHANNEL'}</span><h2># ${escape(app, channel.name)}</h2><span>${roleLabel} · ${channel.mode === 'catch-up' ? 'catch-up' : 'live'}</span></div><div class="pp-chat-header-actions">${isLaunchReview ? '<button class="pp-chat-preview" type="button" title="Play one illustrative team update">Preview update</button>' : ''}<button class="pp-chat-notes-button" type="button" data-pp-notes-toggle aria-expanded="false">Notes</button><div class="pp-notes-picker" data-pp-notes-picker hidden></div></div></header><div class="chat-members pp-chat-members">${escape(app, PEOPLE.join(' · '))} · ${escape(app, roleLabel)}</div><div class="chat-messages pp-chat-messages" role="log" aria-label="${escape(app, channel.name)} messages">${messageMarkup || '<p class="pp-empty">No messages yet</p>'}</div><form class="chat-composer pp-local-composer"><textarea name="body" aria-label="${escape(app, options.orchestrator ? 'Message coding orchestrator' : 'Message project channel')}" placeholder="${escape(app, options.orchestrator ? 'Message the coding orchestrator…' : `Message #${channel.name}…`)}" rows="2"></textarea><button type="submit" aria-label="Send message">↑</button></form>`;
  wireChatOpeners(app, element);
  const form = element.querySelector('form');
  form.elements.body.value = drafts.get(channelId) || '';
  form.elements.body.oninput = () => drafts.set(channelId, form.elements.body.value);
  form.onsubmit = event => {
    event.preventDefault();
    const body = form.elements.body.value.trim();
    if (!body) return;
    channel.messages.push({ id: newId(), author: app.state.currentUser, role: 'human', body, at: nowLabel() });
    drafts.delete(channelId);
    app.render();
    element.querySelector?.('.pp-chat-messages')?.scrollTo({ top: 999999 });
  };
  form.elements.body.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  };
  element.querySelector('.pp-chat-preview')?.addEventListener('click', () => {
    if (appendPreviewUpdate(app, channelId)) app.render();
  });
}
