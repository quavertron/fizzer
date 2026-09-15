import { newId, nowLabel, PHASE_LABELS, STATUS_LABELS, getNoteLinkTargets, resolveNoteLink } from './projects-areas-prototype-model.js';

const esc = (app, value) => app.escape(String(value ?? ''));
const byId = (items, id) => items.find(item => item.id === id);
const areaNotes = (state, area) => (area?.noteIds || []).map(id => byId(state.notes, id)).filter(Boolean);
const indexNote = (state, area) => areaNotes(state, area).find(note => /context\s+index/i.test(note.title)) || areaNotes(state, area)[0];
const areaChannel = (state, area) => byId(state.channels, area?.channelId);
const areaMissions = (state, area) => state.missions.filter(mission => mission.areaId === area?.id);
const areaTasks = (state, area) => state.tasks.filter(task => task.areaId === area?.id && task.kind === 'human' && task.status !== 'done').sort((a, b) => a.priority.localeCompare(b.priority) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
const formatStatus = status => status === 'proposed' ? 'Proposed' : 'Active';
const humanMessages = (channel, start = channel?.processedCount || 0) => (channel?.messages || []).slice(start).filter(message => message.role === 'human');



function button(app, label, action, options = {}) {
    const classes = `pp-button ${options.primary ? 'primary ' : ''}${options.className || ''}`.trim();
    const disabled = options.disabled ? ' disabled' : '';
    return `<button type="button" class="${classes}" data-context-action="${esc(app, action)}"${disabled}>${esc(app, label)}</button>`;
}

function breadcrumb(app, state, area, current) {
    const areaPart = area
        ? `<button type="button" class="context-breadcrumb-link" data-context-action="open-area" data-area-id="${esc(app, area.id)}">${esc(app, area.name)}</button><span aria-hidden="true">/</span>`
        : '';
    return `<div class="context-breadcrumb"><button type="button" class="context-breadcrumb-link" data-context-action="open-project">${esc(app, state.projectName || 'Project')}</button><span aria-hidden="true">/</span>${areaPart}<strong>${esc(app, current)}</strong></div>`;
}

function renderNoteLink(app, note, index) {
    if (!note)
        return '';
    const indexLabel = index ? ' · context index' : '';
    return `<li><button type="button" class="context-index-link" data-context-action="open-note" data-note-id="${esc(app, note.id)}"><span>${esc(app, note.title)}</span><small>${esc(app, indexLabel || 'product note')}</small></button></li>`;
}

function newNoteForm(app, state, area) {
    return `<form class="context-new-note" data-context-form="new-note"><div class="context-form-heading"><strong>New note</strong><button type="button" class="context-inline-close" data-context-action="close-new-note" aria-label="Close new note form">×</button></div><label class="pp-field">Title<input name="title" required placeholder="Note title" autocomplete="off"></label>${area ? '' : `<label class="pp-field">Area<select name="areaId"><option value="">Project-wide</option>${state.areas.map(item => `<option value="${esc(app, item.id)}">${esc(app, item.name)}</option>`).join('')}</select></label>`}<label class="pp-field">Content<textarea name="content" rows="5" placeholder="Write a product note…"></textarea></label><div class="context-form-actions"><button type="submit" class="pp-button primary">Create note</button></div></form>`;
}

function renderArea(app, root, state, area) {
    if (!area)
        return renderMissing(app, root, state, 'Area not found', 'The selected area is no longer in this in-memory sample.');
    const index = indexNote(state, area);
    const notes = areaNotes(state, area);
    const channel = areaChannel(state, area);
    const missions = areaMissions(state, area);
    const tasks = areaTasks(state, area);
    const proposed = area.status === 'proposed';
    const preview = note => String(note.content || '').replace(/^#+\s*/gm, '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 150);
    const noteForm = root.dataset.newNoteArea === area.id ? newNoteForm(app, state, area) : '';
    root.innerHTML = `<div class="context-shell context-area-view">
        <header class="context-toolbar"><div>${breadcrumb(app, state, null, area.name)}</div><div class="context-toolbar-actions">${channel ? button(app, `# ${channel.name}`, 'open-channel', { className: 'secondary' }) : ''}${proposed ? button(app, 'Accept area', 'accept-area', { primary: true }) : ''}</div></header>
        <main class="context-scroll">
            <section class="context-area-hero">
                <div class="context-area-title"><h1>${esc(app, area.name)}</h1><span class="pp-chip ${proposed ? 'is-proposed' : 'is-active'}">${esc(app, formatStatus(area.status))}</span></div>
                <p class="context-purpose">${esc(app, area.summary || 'No purpose written yet.')}</p>
                <div class="context-area-actions"><button type="button" class="pp-button secondary" data-context-action="toggle-area-edit" aria-expanded="false">Edit details</button>${index ? button(app, 'Open context index', 'open-note', { className: 'secondary' }) : ''}${button(app, 'View changes', 'open-changes', { className: 'secondary' })}</div>
                <div class="context-area-edit" data-area-edit hidden><div class="context-edit-grid"><label class="pp-field">Area name<input data-area-field="name" value="${esc(app, area.name)}" aria-label="Area name"></label><label class="pp-field context-purpose-field">Purpose<textarea data-area-field="summary" rows="3" aria-label="Area purpose">${esc(app, area.summary || '')}</textarea></label></div><p class="context-save-hint">Saves when a field loses focus.</p></div>
            </section>
            <div class="context-area-grid">
                <section class="context-panel context-work-section"><div class="context-panel-heading"><h2>Needs attention</h2><button class="pp-text-button" data-action="new-task">New task</button></div>${tasks.length ? `<div class="context-card-list">${tasks.map(task => `<article class="context-work-card" data-task-id="${esc(app, task.id)}"><div><h3>${esc(app, task.title)}</h3><p>${esc(app, task.description || '')}</p><small>${esc(app, (task.assignees || []).join(', ') || 'Unassigned')}${task.dueDate ? ` · ${esc(app, new Date(`${task.dueDate}T12:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' }))}` : ''}</small></div><div class="context-card-actions"><span class="pp-chip">${esc(app, task.priority)} · ${esc(app, STATUS_LABELS[task.status])}</span>${button(app, 'Open task', 'open-task', { className: 'secondary' })}</div></article>`).join('')}</div>` : '<p class="context-empty-row">Nothing waiting on the team.</p>'}<div class="context-subsection-heading"><span>Missions</span>${proposed ? '' : '<button class="pp-text-button" data-action="new-mission">New mission</button>'}</div>${missions.length ? `<div class="context-card-list">${missions.map(mission => `<article class="context-work-card" data-mission-id="${esc(app, mission.id)}"><div><h3>${esc(app, mission.title)}</h3><p>${esc(app, mission.behavior || '')}</p><small>${mission.conditions.filter(condition => condition.done).length}/${mission.conditions.length} delivery checks</small></div><div class="context-card-actions"><span class="pp-chip">${esc(app, PHASE_LABELS[mission.phase])}</span>${button(app, 'Open mission', 'open-mission', { className: 'secondary' })}</div></article>`).join('')}</div>` : '<p class="context-empty-row">No missions yet.</p>'}</section>
                <section class="context-panel context-documents"><div class="context-panel-heading"><h2>Product notes</h2>${button(app, 'New note', 'new-note', { className: 'secondary' })}</div><div class="context-document-list">${notes.map(note => `<button type="button" class="context-document-row" data-context-action="open-note" data-note-id="${esc(app, note.id)}"><span><strong>${esc(app, note.title)}</strong><small>${esc(app, preview(note) || 'Empty note')}</small></span><time>${esc(app, note.updatedAt || '—')}</time></button>`).join('') || '<p class="context-empty-row">No product notes yet.</p>'}</div>${noteForm}</section>
                <section class="context-panel context-recent"><div class="context-panel-heading"><h2>${channel ? `# ${esc(app, channel.name)}` : 'Conversation'}</h2>${channel ? button(app, 'Open channel', 'open-channel', { className: 'secondary' }) : ''}</div>${channel?.messages?.length ? `<div class="context-recent-list">${channel.messages.slice(-3).map(message => `<div class="context-recent-message"><div><strong>${esc(app, message.author)}</strong><time>${esc(app, message.at || '—')}</time></div><p>${esc(app, message.body.replace(/\*\*/g, ''))}</p></div>`).join('')}</div>` : '<p class="context-empty-row">No messages yet.</p>'}</section>
            </div>
        </main>
    </div>`;
    root.querySelector('[data-context-action="toggle-area-edit"]')?.addEventListener('click', event => {
        const details = root.querySelector('[data-area-edit]');
        const open = details?.hasAttribute('hidden');
        if (!details)
            return;
        details.toggleAttribute('hidden', !open);
        event.currentTarget.setAttribute('aria-expanded', String(open));
    });
    root.querySelectorAll('[data-area-field]').forEach(field => field.addEventListener('blur', () => {
        const key = field.dataset.areaField;
        const value = field.value.trim();
        if ((key === 'name' && !value) || value === area[key])
            return;
        const nextAreas = state.areas.map(item => item.id === area.id ? { ...item, [key]: value } : item);
        const currentIndex = indexNote(state, area);
        const nextNotes = key === 'name' && currentIndex?.title === `${area.name} · context index`
            ? state.notes.map(item => item.id === currentIndex.id ? { ...item, title: `${value} · context index` } : item)
            : state.notes;
        app.state = { ...app.state, areas: nextAreas, notes: nextNotes };
        app.render();
    }));
    bindContextActions(app, root, state, area);
    bindNewNoteForm(app, root, state, area);
}





function resolveSourceLink(app, noteId, title) {
    return resolveNoteLink(app.state, noteId, String(title || '').trim()) || null;
}

function openSourceLink(app, target) {
    if (!target)
        return;
    if (target.kind === 'artifact')
        return app.openArtifact?.(target.id);
    if (target.kind === 'mission')
        return app.openMission?.(target.id);
    if (target.kind === 'task')
        return app.openTaskWorkspace?.(target.id);
    if (target.kind === 'note')
        return app.showNote?.(target.noteId || target.id);
}

function sourceSyntaxMarkup(app, noteId, content) {
    return String(content || '').split(/\r?\n/).map(line => {
        let markup = '';
        let last = 0;
        const links = /\[\[([^\]]+)\]\]/g;
        let match;
        while ((match = links.exec(line))) {
            markup += esc(app, line.slice(last, match.index));
            const target = resolveSourceLink(app, noteId, match[1]);
            const kind = target?.kind || 'unknown';
            markup += `<span class="source-syntax-link source-syntax-link-${kind}" data-source-link-kind="${kind}"${target ? ` data-source-link-id="${esc(app, target.id)}"` : ''}>${esc(app, match[0])}</span>`;
            last = match.index + match[0].length;
        }
        markup += esc(app, line.slice(last));
        if (/^#{1,4}\s/.test(line))
            markup = `<span class="source-syntax-heading">${markup}</span>`;
        else {
            markup = markup.replace(/(\*\*[^*]+\*\*)/g, '<span class="source-syntax-strong">$1</span>');
            markup = markup.replace(/(`[^`]+`)/g, '<span class="source-syntax-code">$1</span>');
        }
        markup = markup.replace(/\[([ xX])\]/g, (marker, mark) => `<span class="source-checkbox ${mark.toLowerCase() === 'x' ? 'is-checked' : ''}">${marker}</span>`);
        return markup;
    }).join('\n');
}

function noteDocumentMarkup(app, state, note, embedded) {
    return `<article class="note-document context-note-document"><div class="context-note-editor-wrap"><pre class="context-note-mirror" aria-hidden="true"></pre><textarea class="context-note-editor context-note-source" data-note-editor rows="24" spellcheck="true" aria-label="Edit ${esc(app, note.title)}">${esc(app, note.content)}</textarea><div class="context-note-completion" data-note-completion hidden role="listbox"></div></div></article>`;
}


function sourceLinkAt(content, position, app, noteId) {
    const source = String(content || '');
    const links = /\[\[([^\]\n]+)\]\]/g;
    let match;
    while ((match = links.exec(source))) {
        const end = match.index + match[0].length;
        if (position >= match.index && position <= end)
            return resolveSourceLink(app, noteId, match[1]);
    }
    return null;
}

function completionQuery(value, position) {
    const match = /\[\[([^\]\n]*)$/.exec(String(value || '').slice(0, position));
    if (!match)
        return null;
    const parts = match[1].split(/\s+-\s*/);
    const leaf = parts.pop().trim().toLowerCase();
    return { start: position - match[0].length, containerPath: parts.join(' - ').trim(), leaf };
}

function bindNoteEditor(app, root, note) {
    const editor = root.querySelector('[data-note-editor]');
    const mirror = root.querySelector('.context-note-mirror');
    const completion = root.querySelector('[data-note-completion]');
    if (!editor || !mirror)
        return;
    let timer;
    let pointerStart;
    let completionIndex = 0;
    const sync = () => {
        mirror.innerHTML = sourceSyntaxMarkup(app, note.id, editor.value);
        mirror.scrollTop = editor.scrollTop;
        mirror.scrollLeft = editor.scrollLeft;
    };
    const commit = content => {
        const current = byId(app.state.notes, note.id);
        if (!current || content === current.content)
            return;
        app.recordNote(note.id, content, app.state.currentUser);
    };
    const scheduleCommit = () => {
        clearTimeout(timer);
        timer = setTimeout(() => commit(editor.value), 900);
    };
    const hideCompletion = () => {
        if (completion)
            completion.hidden = true;
    };
    const activeOptions = () => {
        const query = completionQuery(editor.value, editor.selectionStart);
        if (!query)
            return null;
        const targets = getNoteLinkTargets(app.state, note.id, query.containerPath)
            .filter(target => !query.leaf || String(target.title || '').toLowerCase().includes(query.leaf));
        return { query, targets };
    };
    const renderCompletion = () => {
        if (!completion)
            return;
        const active = activeOptions();
        if (!active?.targets.length) {
            hideCompletion();
            return;
        }
        completionIndex = Math.min(completionIndex, active.targets.length - 1);
        completion.innerHTML = active.targets.map((target, index) => `<button type="button" role="option" class="context-note-completion-option${index === completionIndex ? ' is-active' : ''}" data-completion-index="${index}"><span class="context-note-completion-kind context-note-completion-kind-${target.kind}">${esc(app, target.kind)}</span><span>${esc(app, target.title)}</span></button>`).join('');
        completion.hidden = false;
    };
    const chooseCompletion = index => {
        const active = activeOptions();
        const target = active?.targets[index];
        if (!active || !target)
            return;
        const path = active.query.containerPath ? `${active.query.containerPath} - ${target.title}` : target.title;
        const insert = `[[${path}]]`;
        editor.value = `${editor.value.slice(0, active.query.start)}${insert}${editor.value.slice(editor.selectionStart)}`;
        const cursor = active.query.start + insert.length;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(cursor, cursor);
        sync();
        scheduleCommit();
        hideCompletion();
    };
    sync();
    completion?.addEventListener('mousedown', event => event.preventDefault());
    completion?.addEventListener('click', event => {
        const option = event.target.closest('[data-completion-index]');
        if (option)
            chooseCompletion(Number(option.dataset.completionIndex));
    });
    editor.addEventListener('pointerdown', event => {
        pointerStart = { x: event.clientX, y: event.clientY };
    });
    editor.addEventListener('click', event => {
        const start = pointerStart;
        pointerStart = null;
        if (start && (Math.abs(start.x - event.clientX) > 3 || Math.abs(start.y - event.clientY) > 3))
            return;
        const target = sourceLinkAt(editor.value, editor.selectionStart, app, note.id);
        if (target)
            openSourceLink(app, target);
    });
    editor.addEventListener('input', () => {
        sync();
        scheduleCommit();
        completionIndex = 0;
        renderCompletion();
    });
    editor.addEventListener('keydown', event => {
        const active = activeOptions();
        if (!active?.targets.length)
            return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            completionIndex = (completionIndex + (event.key === 'ArrowDown' ? 1 : -1) + active.targets.length) % active.targets.length;
            renderCompletion();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            chooseCompletion(completionIndex);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            hideCompletion();
        }
    });
    editor.addEventListener('scroll', sync);
    editor.addEventListener('blur', () => {
        clearTimeout(timer);
        commit(editor.value);
        setTimeout(hideCompletion, 0);
    });
}

function bindWorkspaceNoteActions(app, root) {
    root.querySelectorAll('[data-workspace-conversation]').forEach(link => link.addEventListener('click', () => {
        if (app.openConversation)
            app.openConversation({ kind: link.dataset.workspaceConversation, id: link.dataset.conversationId });
    }));
    root.querySelectorAll('[data-workspace-note-id]').forEach(link => link.addEventListener('click', () => {
        if (app.showNote)
            app.showNote(link.dataset.workspaceNoteId);
    }));
}

function renderNote(app, root, state, note) {
    if (!note)
        return renderMissing(app, root, state, 'Note not found', 'The selected product note is no longer in this in-memory sample.');
    const area = note.areaId ? byId(state.areas, note.areaId) : null;
    root.innerHTML = `<div class="context-shell context-note-view">
        <header class="context-toolbar"><div>${breadcrumb(app, state, area, note.title)}</div><div class="context-toolbar-actions"><button type="button" class="workspace-note-history-button" data-context-action="open-note-history" data-note-id="${esc(app, note.id)}" aria-label="Open note history" title="Open note history">↶</button></div></header>
        <main class="context-scroll context-note-scroll ${area ? '' : 'context-note-solo'}"><div class="workspace-note-main">${noteDocumentMarkup(app, state, note, false)}</div></main>
    </div>`;
    bindNoteEditor(app, root, note);
    bindContextActions(app, root, state, area);
}


export function renderWorkspaceNote(app, root, noteId) {
    const state = app.state;
    return renderWorkspaceNoteSurface(app, root, state, byId(state.notes, noteId));
}
function renderWorkspaceNoteSurface(app, root, state, note) {
    if (!note)
        return renderMissing(app, root, state, 'Note not found', 'The selected product note is no longer in this in-memory sample.');
    const area = note.areaId ? byId(state.areas, note.areaId) : null;
    root.innerHTML = `<div class="context-shell context-note-view context-note-embedded"><main class="context-scroll context-note-workspace-scroll"><button type="button" class="workspace-note-history-button" data-context-action="open-note-history" data-note-id="${esc(app, note.id)}" aria-label="Open note history" title="Open note history">↶</button><div class="workspace-note-main">${noteDocumentMarkup(app, state, note, true)}</div><div class="workspace-note-context"></div></main><div class="context-note-live" aria-live="polite"></div></div>`;
    bindNoteEditor(app, root, note);
    bindWorkspaceNoteActions(app, root);
    bindContextActions(app, root, state, area);
}
function renderNotes(app, root, state) {
    const areaGroups = new Map();
    const productNotes = state.notes.filter(note => !note.areaId);
    state.areas.forEach(area => areaGroups.set(area.id, { area, notes: state.notes.filter(note => note.areaId === area.id) }));
    const noteCard = note => {
        const area = note.areaId ? byId(state.areas, note.areaId) : null;
        const preview = String(note.content || '').replace(/^#+\s*/gm, '').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 170);
        return `<button type="button" class="context-library-card" data-context-action="open-note" data-note-id="${esc(app, note.id)}" data-note-search="${esc(app, `${note.title} ${note.content} ${area?.name || 'Project'}`.toLowerCase())}" data-note-area="${esc(app, note.areaId || 'project')}"><span class="context-library-card-copy"><strong>${esc(app, note.title)}</strong><small>${esc(app, preview || 'Empty note')}</small></span><time>${esc(app, note.updatedBy || 'Unknown')} · ${esc(app, note.updatedAt || '—')}</time></button>`;
    };
    const group = (title, notes) => notes.length ? `<section class="context-library-group" data-note-group><div class="context-library-group-heading"><h2>${esc(app, title)}</h2><span>${notes.length} note${notes.length === 1 ? '' : 's'}</span></div><div class="context-library-grid">${notes.map(noteCard).join('')}</div></section>` : '';
    root.innerHTML = `<div class="context-shell context-notes-view"><header class="context-toolbar"><div>${breadcrumb(app, state, null, 'Notes')}</div><div class="context-toolbar-actions">${button(app, 'New note', 'new-note', { primary: true })}${button(app, 'View changes', 'open-changes', { className: 'secondary' })}</div></header><main class="context-scroll"><section class="context-library-head"><h1>Notes</h1><div class="context-library-filters"><label class="pp-field">Search notes<input type="search" data-note-search-input placeholder="Title or text" aria-label="Search notes"></label><label class="pp-field">Area<select data-note-area-filter aria-label="Filter notes by area"><option value="all">All areas</option><option value="project">Project notes</option>${state.areas.map(area => `<option value="${esc(app, area.id)}">${esc(app, area.name)}</option>`).join('')}</select></label></div></section>${root.dataset.newNoteArea === 'project' ? `<div class="context-library-form">${newNoteForm(app, state, null)}</div>` : ''}<div class="context-library-groups">${group('Project', productNotes)}${Array.from(areaGroups.values()).map(({ area, notes }) => group(area.name, notes)).join('')}<p class="context-library-empty pp-empty" data-note-empty ${state.notes.length ? 'hidden' : ''}>No product notes yet.</p></div></main></div>`;
    const filter = () => {
        const query = root.querySelector('[data-note-search-input]')?.value.trim().toLowerCase() || '';
        const area = root.querySelector('[data-note-area-filter]')?.value || 'all';
        let visible = 0;
        root.querySelectorAll('[data-note-group]').forEach(groupNode => {
            let groupVisible = 0;
            groupNode.querySelectorAll('[data-note-search]').forEach(card => {
                const show = (!query || card.dataset.noteSearch.includes(query)) && (area === 'all' || card.dataset.noteArea === area);
                card.hidden = !show;
                if (show) groupVisible += 1;
            });
            groupNode.hidden = !groupVisible;
            visible += groupVisible;
        });
        const empty = root.querySelector('[data-note-empty]');
        if (empty) {
            empty.hidden = visible > 0;
            empty.textContent = state.notes.length ? 'No notes match this search.' : 'No product notes yet.';
        }
    };
    root.querySelector('[data-note-search-input]')?.addEventListener('input', filter);
    root.querySelector('[data-note-area-filter]')?.addEventListener('change', filter);
    bindContextActions(app, root, state, null);
    bindNewNoteForm(app, root, state, null);
}

function diffLines(before, after) {
    const left = String(before || '').split(/\r?\n/);
    const right = String(after || '').split(/\r?\n/);
    const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let i = left.length - 1; i >= 0; i -= 1)
        for (let j = right.length - 1; j >= 0; j -= 1)
            dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const removed = [];
    const added = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        if (left[i] === right[j]) {
            i += 1;
            j += 1;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            removed.push(left[i]);
            i += 1;
        } else {
            added.push(right[j]);
            j += 1;
        }
    }
    while (i < left.length) removed.push(left[i++]);
    while (j < right.length) added.push(right[j++]);
    return { removed, added };
}

function diffLinesMarkup(app, lines, kind) {
    if (!lines.length)
        return `<p class="context-diff-empty">No ${kind} lines.</p>`;
    return `<ul class="context-diff-lines ${kind}">${lines.map(line => `<li><span aria-hidden="true">${kind === 'added' ? '+' : '−'}</span><code>${esc(app, line || ' ')}</code></li>`).join('')}</ul>`;
}
function openLocalHistory(app, root, noteId) {
    const note = app.state.notes.find(item => item.id === noteId);
    if (!note)
        return;
    root.querySelector('.context-note-history-popover')?.remove();
    const changes = (app.state.changes || []).filter(change => change.noteId === note.id);
    const body = changes.length ? changes.map(change => {
        const diff = diffLines(change.before, change.after);
        return `<article class="context-note-history-entry"><header><div><strong>${esc(app, change.author || 'Unknown')}</strong><time>${esc(app, change.at || '—')}</time></div><span>${esc(app, change.title || note.title)}</span></header><div class="context-diff-columns"><section><h3>Removed</h3>${diffLinesMarkup(app, diff.removed, 'removed')}</section><section><h3>Added</h3>${diffLinesMarkup(app, diff.added, 'added')}</section></div></article>`;
    }).join('') : '<p class="context-empty-row">No saved changes for this note yet.</p>';
    root.insertAdjacentHTML('beforeend', `<div class="context-note-history-popover" role="presentation"><section class="context-note-history-dialog" role="dialog" aria-modal="true" aria-labelledby="context-note-history-title"><header><div><span class="context-kicker">Local note history</span><h2 id="context-note-history-title">${esc(app, note.title)}</h2></div><button type="button" class="context-inline-close" data-close-note-history aria-label="Close note history">×</button></header><div class="context-note-history-list">${body}</div></section></div>`);
    const popover = root.querySelector('.context-note-history-popover');
    const close = () => {
        popover?.remove();
    };
    popover?.addEventListener('click', event => {
        if (event.target === popover || event.target.closest('[data-close-note-history]'))
            close();
    });
    popover?.addEventListener('keydown', event => {
        if (event.key === 'Escape')
            close();
    });
    popover?.querySelector('[data-close-note-history]')?.focus();
}

function renderChanges(app, root, state) {
    const changes = state.changes || [];
    root.innerHTML = `<div class="context-shell context-changes-view"><header class="context-toolbar"><div>${breadcrumb(app, state, null, 'Changes')}</div><div class="context-toolbar-actions"><button class="pp-button" data-view="notes">Notes</button></div></header><main class="context-scroll"><section class="context-changes-hero"><h1>Changes</h1></section><section class="context-change-list">${changes.length ? changes.map(change => { const diff = diffLines(change.before, change.after); return `<article class="context-change-card"><header><div><h2>${esc(app, change.title || 'Untitled note')}</h2><p><strong>${esc(app, change.author || 'Unknown')}</strong> · <time>${esc(app, change.at || '—')}</time></p></div>${button(app, 'Open note', 'open-note-from-change', { className: 'secondary' })}</header><div class="context-diff-summary"><span class="diff-added">+${diff.added.length} added</span><span class="diff-removed">−${diff.removed.length} removed</span></div><div class="context-diff-columns"><section><h3>Removed</h3>${diffLinesMarkup(app, diff.removed, 'removed')}</section><section><h3>Added</h3>${diffLinesMarkup(app, diff.added, 'added')}</section></div></article>`; }).join('') : '<p class="pp-empty">No note changes yet.</p>'}</section></main></div>`;
    root.querySelectorAll('[data-context-action="open-note-from-change"]').forEach((action, index) => action.addEventListener('click', () => {
        const change = changes[index];
        if (change?.noteId)
            app.navigate({ kind: 'note', id: change.noteId });
    }));
    bindContextActions(app, root, state, null);
}

function renderPendingMessages(app, channel) {
    const pending = humanMessages(channel);
    if (!pending.length)
        return '<p class="context-empty-row">No pending human messages for the PM.</p>';
    return `<ul class="context-pending-list">${pending.map(message => `<li><span class="context-message-author">${esc(app, message.author)}</span><span>${esc(app, message.body)}</span><time>${esc(app, message.at || '—')}</time></li>`).join('')}</ul>`;
}

function proposalNotes(state) {
    const timestamp = nowLabel();
    const areaId = newId();
    const indexId = newId();
    const overviewId = newId();
    const participantsId = newId();
    const channelId = newId();
    const notes = [
        { id: indexId, title: 'Beta test · context index', areaId, content: '# Beta test context\n\nProposed context files:\n- [[Beta test overview]] — intended outcome\n- [[Beta participants]] — participant context\n\nThis proposal remains unactivated until it is accepted.', updatedBy: 'Project manager', updatedAt: timestamp },
        { id: overviewId, title: 'Beta test overview', areaId, content: '# Beta test overview\n\n## Intended outcome\nLearn whether a new participant can start a useful shared project without assistance.\n\nProposed product context for discussion.', updatedBy: 'Project manager', updatedAt: timestamp },
        { id: participantsId, title: 'Beta participants', areaId, content: '# Beta participants\n\n## Proposed cohort\nInvite a small group representing solo and shared-project workflows.\n\nParticipant context for discussion.', updatedBy: 'Project manager', updatedAt: timestamp },
    ];
    return { areaId, channelId, notes, area: { id: areaId, name: 'Beta test', summary: 'Learn whether new participants can begin a shared project without assistance.', status: 'proposed', noteIds: [indexId, overviewId, participantsId], channelId }, channel: { id: channelId, name: 'beta-test', areaId, mode: 'catch-up', quietMinutes: 15, processedCount: 0, messages: [{ id: newId(), author: 'Project manager', role: 'pm', body: 'I suggest keeping participant research and onboarding findings together in Beta test. The overview and participant notes are ready for us to refine.', at: timestamp }] } };
}

function simulateProposal(app) {
    const state = app.state;
    if (state.areas.some(area => area.name.toLowerCase() === 'beta test')) {
        app.notice('Beta test already exists.');
        return;
    }
    const proposal = proposalNotes(state);
    const general = state.channels.find(channel => channel.areaId === null) || state.channels[0];
    const response = { id: newId(), author: 'Project manager', role: 'pm', body: 'I proposed Beta test with an overview and participant notes. Please review its scope before we start inviting people.', at: nowLabel() };
    const nextChannels = state.channels.map(channel => channel.id === general?.id ? { ...channel, messages: [...channel.messages, response] } : channel);
    app.state = { ...state, areas: [...state.areas, proposal.area], notes: [...state.notes, ...proposal.notes], channels: [...nextChannels, proposal.channel] };
    app.notice('Beta test is ready to review.');
    app.render();
}

function captureForCatchUp(app, channel, pending) {
    const state = app.state;
    const area = channel.areaId ? byId(state.areas, channel.areaId) : null;
    const index = area ? indexNote(state, area) : null;
    let target = areaNotes(state, area).find(note => note.id !== index?.id) || index || state.notes.find(note => note.id === 'product-overview' || note.areaId === null);
    if (!target) {
        target = { id: newId(), title: 'Product overview', areaId: null, content: '# Product overview', updatedBy: 'Project manager', updatedAt: nowLabel() };
        app.state.notes.push(target);
    }
    if (target) {
        const capture = `\n\n## Discussion · ${nowLabel()}\n\n${pending.map(message => `- ${message.author}: ${message.body}`).join('\n')}`;
        app.recordNote(target.id, `${target.content}${capture}`, 'Project manager');
    }
    const afterNoteState = app.state;
    const currentChannel = byId(afterNoteState.channels, channel.id);
    if (!currentChannel)
        return;
    const reply = { id: newId(), author: 'Project manager', role: 'pm', body: `I captured the ${pending.length} new message${pending.length === 1 ? '' : 's'} in [[${target.title}]] so we can refer to this discussion later.`, at: nowLabel() };
    const messages = [...currentChannel.messages, reply];
    app.state = { ...afterNoteState, channels: afterNoteState.channels.map(item => item.id === channel.id ? { ...item, messages, processedCount: messages.length } : item) };
    app.notice('Product notes updated.');
    app.render();
}

function renderChannel(app, root, state, channel) {
    if (!channel) return renderMissing(app, root, state, 'Channel not found', 'This channel is no longer available.');
    const area = channel.areaId ? byId(state.areas, channel.areaId) : null;
    const index = area ? indexNote(state, area) : null;
    const pending = humanMessages(channel);
    const offline = !state.runnerOnline;
    root.innerHTML = `<div class="context-shell context-channel-view">
        <header class="context-toolbar">${breadcrumb(app, state, area, `#${channel.name}`)}<div class="context-toolbar-actions">${index ? button(app, 'Context index', 'open-index', { className: 'secondary' }) : ''}</div></header>
        <div class="context-channel-body"><section class="context-chat-mount" data-chat-mount aria-label="Channel messages"></section>
        <aside class="context-channel-info"><section class="context-panel"><div class="context-panel-heading"><h2>Project manager</h2><span class="context-runner-state ${offline ? 'is-offline' : ''}"><span class="context-status-dot"></span>${offline ? 'Offline' : 'Online'}</span></div>
        <p class="context-pending-summary">${pending.length ? `<strong>${pending.length}</strong> unprocessed message${pending.length === 1 ? '' : 's'}` : 'All caught up'}</p>
        ${pending.length ? `<details class="context-pending-details"><summary>Unprocessed messages</summary>${renderPendingMessages(app, channel)}</details>` : ''}
        <details class="context-settings"><summary>PM settings</summary><div class="context-channel-control-grid"><label class="pp-field">Participation<select data-channel-field="mode" aria-label="PM participation mode"><option value="live" ${channel.mode === 'live' ? 'selected' : ''}>Live</option><option value="catch-up" ${channel.mode === 'catch-up' ? 'selected' : ''}>Catch-up</option></select></label><label class="pp-field">Quiet period (minutes)<input type="number" min="1" max="240" value="${esc(app, channel.quietMinutes)}" data-channel-field="quietMinutes" aria-label="Quiet period in minutes"></label></div></details>
        </section><details class="context-preview-controls"><summary>Preview controls</summary><div class="context-channel-actions">${button(app, 'Run PM catch-up', 'catch-up', { disabled: offline || channel.mode !== 'catch-up' || !pending.length })}${state.setup === 'greenfield' && !state.areas.length ? button(app, 'Generate area proposal', 'simulate-proposal') : ''}</div></details></aside></div></div>`;
    app.mountChat(root.querySelector('[data-chat-mount]'), channel.id, { orchestrator: false });
    root.querySelectorAll('[data-channel-field]').forEach(field => field.addEventListener('change', () => {
        const key = field.dataset.channelField;
        const value = key === 'quietMinutes' ? Math.max(1, Math.min(240, Number(field.value) || 15)) : field.value;
        app.state = { ...app.state, channels: app.state.channels.map(item => item.id === channel.id ? { ...item, [key]: value } : item) };
        app.render();
    }));
    bindContextActions(app, root, state, area);
}

function renderMissing(app, root, state, title, message) {
    root.innerHTML = `<div class="context-shell"><main class="context-scroll"><section class="context-hero context-missing"><span class="context-eyebrow">In-memory prototype</span><h1>${esc(app, title)}</h1><p>${esc(app, message)}</p>${button(app, 'Back to project', 'open-project', { primary: true })}</section></main></div>`;
    bindContextActions(app, root, state, null);
}

function bindNewNoteForm(app, root, state, area) {
    const form = root.querySelector('[data-context-form="new-note"]');
    if (!form) return;
    form.addEventListener('submit', event => {
        event.preventDefault();
        const title = form.elements.title.value.trim();
        if (!title) return;
        const scope = area || byId(app.state.areas, form.elements.areaId?.value);
        const content = form.elements.content.value.trim() || `# ${title}`;
        const note = { id: newId(), title, areaId: scope?.id || null, content: '', updatedBy: app.state.currentUser, updatedAt: nowLabel() };
        const index = scope ? indexNote(app.state, scope) : null;
        const areas = app.state.areas.map(item => item.id === scope?.id ? { ...item, noteIds: [...item.noteIds, note.id] } : item);
        app.state = { ...app.state, notes: [...app.state.notes, note], areas };
        app.recordNote(note.id, content);
        if (index) app.recordNote(index.id, `${index.content.trimEnd()}\n- [[${title.replace(/\]\]/g, '')}]]`);
        root.dataset.newNoteArea = '';
        app.navigate({ kind: 'note', id: note.id });
        app.notice('Note created.');
    });
}

function bindContextActions(app, root, state, area) {
    root.querySelectorAll('[data-context-action]').forEach(action => action.addEventListener('click', () => {
        const type = action.dataset.contextAction;
        if (type === 'open-project')
            return app.navigate({ kind: 'project' });
        if (type === 'open-area')
            return app.navigate({ kind: 'area', id: action.dataset.areaId || area?.id });
        if (type === 'open-note') {
            const noteId = action.dataset.noteId || (type === 'open-note' && action.closest('.context-panel')?.querySelector('[data-note-link]')?.dataset.noteLink);
            const target = noteId || indexNote(state, area)?.id;
            if (target)
                return app.showNote ? app.showNote(target) : app.navigate({ kind: 'note', id: target });
            return;
        }
        if (type === 'open-index') {
            const target = indexNote(app.state, area);
            if (target)
                return app.showNote ? app.showNote(target.id) : app.navigate({ kind: 'note', id: target.id });
            return;
        }
        if (type === 'open-note-from-change')
            return;
        if (type === 'open-channel') {
            const channel = areaChannel(app.state, area);
            if (channel)
                app.navigate({ kind: 'channel', id: channel.id });
            return;
        }
        if (type === 'open-note-history') {
            const noteId = action.dataset.noteId || app.workspace?.noteId || app.view?.id;
            return openLocalHistory(app, root, noteId);
        }
        if (type === 'open-mission') {
            const missionId = action.closest('.context-work-card')?.dataset.missionId;
            const mission = app.state.missions.find(item => item.id === missionId && item.areaId === area?.id);
            if (mission)
                return app.openMission(mission.id);
            return;
        }
        if (type === 'open-task') {
            const taskId = action.closest('.context-work-card')?.dataset.taskId;
            const task = app.state.tasks.find(item => item.id === taskId && item.areaId === area?.id);
            if (task)
                return app.openTaskWorkspace(task.id);
            return;
        }
        if (type === 'new-note') {
            root.dataset.newNoteArea = area?.id || 'project';
            app.render();
            return;
        }
        if (type === 'close-new-note') {
            root.dataset.newNoteArea = '';
            app.render();
            return;
        }
        if (type === 'accept-area') {
            const target = app.state.areas.find(item => item.id === area?.id);
            if (!target)
                return;
            app.state = { ...app.state, areas: app.state.areas.map(item => item.id === target.id ? { ...item, status: 'active' } : item) };
            app.notice(`Area “${target.name}” is active.`);
            app.render();
            return;
        }
        if (type === 'catch-up') {
            const current = byId(app.state.channels, app.view?.id);
            const pending = humanMessages(current);
            if (!current || current.mode !== 'catch-up' || app.state.runnerOnline === false || !pending.length)
                return;
            captureForCatchUp(app, current, pending);
            return;
        }
        if (type === 'simulate-proposal') {
            simulateProposal(app);
        }
    }));
    root.querySelectorAll('[data-note-link]').forEach(link => link.addEventListener('click', () => app.showNote ? app.showNote(link.dataset.noteLink) : app.navigate({ kind: 'note', id: link.dataset.noteLink })));
    root.querySelectorAll('[data-open-artifact]').forEach(link => link.addEventListener('click', () => app.openArtifact?.(link.dataset.openArtifact)));
}

export function renderContext(app, root) {
    const state = app.state;
    const view = app.view || {};
    if (view.kind === 'area')
        return renderArea(app, root, state, byId(state.areas, view.id));
    if (view.kind === 'notes')
        return renderNotes(app, root, state);
    if (view.kind === 'note')
        return renderNote(app, root, state, byId(state.notes, view.id));
    if (view.kind === 'channel')
        return renderChannel(app, root, state, byId(state.channels, view.id));
    if (view.kind === 'changes')
        return renderChanges(app, root, state);
    return renderMissing(app, root, state, 'Context view unavailable', 'Choose an area, note, channel, or changes view from the project dashboard.');
}
