'use strict';
// Named app actions over the existing owner-private socket; never a route proxy.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = code => { throw new Error(code); };
const canonical = x => JSON.stringify(x && typeof x === 'object' ? Array.isArray(x) ? x.map(x => JSON.parse(canonical(x))) : Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))])) : x);
const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const noteFields = ['id', 'vault_id', 'folder_id', 'title', 'content', 'content_preview', 'revision', 'is_listed', 'is_pinned', 'is_archived', 'position', 'tags', 'updated_at'];
const vaultFields = ['id', 'name', 'visibility', 'created_by', 'role', 'memberCount'];
const folderFields = ['id', 'vault_id', 'parent_id', 'name', 'position'];
const reads = {
  identity: [], vaults: [], vault: ['vaultId'], navigation: ['vaultId'],
  notes: ['vaultId'], note: ['vaultId', 'noteId'], folders: ['vaultId'], members: ['vaultId'],
  tags: ['vaultId'], graph: ['vaultId'], versions: ['vaultId', 'noteId'], backlinks: ['vaultId', 'noteId'],
  channelHistory: ['vaultId', 'channelId'], channelSettings: ['vaultId', 'channelId'],
  vaultAgents: ['vaultId'], runs: ['vaultId'], activeSessions: ['vaultId'],
  workItems: ['vaultId'], entitlement: ['vaultId'], runnerStatus: [], dmSettings: [],
};
const writes = {
  createVault: ['name'], createNote: ['vaultId', 'title', 'content', 'folderId'],
  createChannel: ['vaultId', 'title', 'folderId'], createFolder: ['vaultId', 'name', 'parentId'],
  renameVault: ['vaultId', 'name'], renameNote: ['vaultId', 'noteId', 'title'],
  moveNote: ['vaultId', 'noteId', 'folderId'], renameFolder: ['vaultId', 'folderId', 'name'],
  updateAgentAvatar: require('./along-avatar.cjs').fields,
};
const blocked = {
  updateNote: 'revision_contract_required', deleteNote: 'deletion', deleteFolder: 'deletion', deleteVault: 'deletion',
  publishNote: 'public_publication', unpublishNote: 'public_publication', sendMessage: 'public_message_or_model_dispatch',
  shareVault: 'sharing', changeVisibility: 'sharing', inviteMember: 'sharing', changeMemberRole: 'account_security',
  updateProfile: 'account_security', changePassword: 'account_security', updateDmSettings: 'account_security',
  updateChannelSettings: 'agent_execution_configuration', registerAgent: 'agent_execution_configuration',
  removeAgent: 'agent_execution_configuration', startRun: 'model_execution_and_spend', cancelRun: 'running_work',
  approveMessage: 'execution_approval', mergeMessage: 'repository_mutation', updateEntitlement: 'billing',
  createMission: 'agent_execution', updateWorkItem: 'agent_execution', semanticSearch: 'possible_model_execution',
  channelAgents: 'GET_materializes_membership', desktopNavigation: 'renderer_adapter_required',
  worktreeManagement: 'local_filesystem_and_repository_mutation', appRestart: 'desktop_lifecycle',
};
function exact(o, fields) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length !== fields.length || fields.some(k => !Object.hasOwn(o, k))) fail('invalid_request');
}
function specification(action, args, c) {
  const fields = reads[action] || writes[action];
  if (!fields) fail(blocked[action] ? 'action_not_implemented' : 'invalid_request');
  exact(args, fields);
  for (const key of fields) {
    const value = args[key];
    if (key.endsWith('Id')) { if (value === null && ['folderId', 'parentId'].includes(key)) continue; c.checkId(value); }
    else if (key === 'content') { if (typeof value !== 'string' || value.length > 65536 || value.includes('cascade://')) fail('invalid_note_content'); }
    else if (typeof value !== 'string' || !value.trim() || value.length > 160) fail('invalid_title');
  }
}
async function control(input, c) {
  if (input.action === 'updateAgentAvatar') return require('./along-avatar.cjs').avatar(input, c);
  if (input.op === 'appCapabilities') {
    exact(input, ['op']);
    await identity();
    return { contract: 'fizzer_app_control_v1', authority: { ownerId: c.ownerId, vaultSelection: 'explicit_current_access', writes: 'current_owner_only' },
      attribution: { actorUserId: c.ownerId, agentId: c.agentId, author: c.author, backendNotes: 'user_account_only', publicWrites: 'disabled_until_attribution_and_approval_integration' },
      operations: [
        ...Object.entries(reads).map(([action, fields]) => ({ action, mode: 'read', fields, implemented: true, invokesModel: false })),
        ...Object.entries(writes).map(([action, fields]) => ({ action, mode: 'plan_apply_reconcile', fields, implemented: true, confirmation: 'shared_or_public_requires_specific_approval', sharedApply: false })),
        ...Object.entries(blocked).map(([action, reason]) => ({ action, implemented: false, confirmation: 'specific_owner_action', reason })),
      ], limits: { responseBytes: 1048576, historyWindow: 40, atomicMetadataCAS: false },
      receiptSemantics: 'write_ahead_no_automatic_replay_of_uncertain_mutations' };
  }
  if (input.op === 'appRead') {
    exact(input, ['op', 'action', 'args']);
    if (!reads[input.action]) fail('invalid_request');
    specification(input.action, input.args, c);
    await identity();
    if (input.args.vaultId) await access(input.args.vaultId);
    return read(input.action, input.args);
  }
  if (!['appPlan', 'appApply', 'appReconcile'].includes(input.op)) fail('invalid_request');
  exact(input, input.op === 'appPlan' ? ['op', 'action', 'args', 'requestId'] : ['op', 'action', 'args', 'requestId', 'planDigest']);
  if (!writes[input.action]) fail(blocked[input.action] ? 'action_not_implemented' : 'invalid_request');
  specification(input.action, input.args, c);
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)) fail('invalid_request_id');
  if (input.op !== 'appPlan' && (typeof input.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.planDigest))) fail('invalid_request');
  await identity();
  const a = input.args;
  const permission = a.vaultId ? await access(a.vaultId, true) : null;
  const intent = { contract: 'fizzer_app_control_v1', origin: c.scope.origin, ownerId: c.ownerId,
    action: input.action, args: a, requestId: input.requestId, actedBy: c.author };
  const file = path.join(c.receiptDir, 'app-' + digest({ origin: c.scope.origin, ownerId: c.ownerId, requestId: input.requestId }) + '.json');
  let receipt;
  if (fs.existsSync(file)) {
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) fail('unsafe_receipt');
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('uncertain_write'); }
    if (receipt.intentDigest !== digest(intent)) fail('idempotency_conflict');
    if (input.op !== 'appPlan' && input.planDigest !== receipt.planDigest) fail('stale_plan');
    if (input.op === 'appPlan') return { ...receipt.plan, planDigest: receipt.planDigest, state: receipt.state };
  } else {
    if (input.op !== 'appPlan') fail('intent_not_found');
    if (fs.readdirSync(c.receiptDir).length >= 1000) fail('receipt_limit');
    const before = await snapshot(input.action, a);
    const plan = { ...intent, before, audience: permission,
      requiresConfirmation: !!permission && !permission.privateSoleOwner,
      atomicPrecondition: false, provenance: 'Local receipt records Along acting on behalf; note backend attributes account only.' };
    receipt = { intentDigest: digest(intent), planDigest: digest(plan), plan, state: 'planned' };
    c.durableWrite(file, receipt, true);
    return { ...plan, planDigest: receipt.planDigest, state: receipt.state };
  }
  if (input.op === 'appReconcile' || receipt.state !== 'planned') {
    if (receipt.state === 'planned') return { state: 'planned', applied: false };
    if (!receipt.id) return { state: 'uncertain', replayAllowed: false, reason: 'creation_response_unknown' };
    const result = await verify(input.action, a, receipt);
    receipt.state = 'verified'; c.durableWrite(file, receipt);
    return { state: 'verified', result, planDigest: receipt.planDigest, replayed: false };
  }
  // A plan/boolean/content field is not human approval. Shared writes stay blocked
  // until a trusted owner approval adapter AND backend agent provenance are wired.
  if (permission && !permission.privateSoleOwner) fail('specific_approval_required');
  if (digest(permission) !== digest(receipt.plan.audience) || digest(await snapshot(input.action, a)) !== digest(receipt.plan.before)) fail('stale_plan');
  receipt.state = 'uncertain';
  // Known targets permit read-only reconciliation even if the HTTP reply is lost.
  receipt.id = a.noteId || (input.action === 'renameFolder' ? a.folderId : input.action === 'renameVault' ? a.vaultId : null);
  c.durableWrite(file, receipt);
  const result = await mutate(input.action, a);
  c.checkId(result?.id); receipt.id = result.id; c.durableWrite(file, receipt);
  const verified = await verify(input.action, a, receipt);
  receipt.state = 'verified'; c.durableWrite(file, receipt);
  return { state: 'verified', result: verified, planDigest: receipt.planDigest, actedBy: c.author, actorUserId: c.ownerId };

  async function identity() {
    const me = await c.browser('/api/me');
    if (me.user?.id !== c.ownerId) fail('owner_scope_mismatch');
    return { user: pick(me.user, ['id', 'username', 'displayName']) };
  }
  async function access(id, write = false) {
    c.checkId(id);
    const { vaults } = await c.browser('/api/vaults');
    const listed = vaults?.find(v => v.id === id);
    if (!listed || !['owner', 'editor', 'viewer'].includes(listed.role)) fail('vault_out_of_scope');
    const { vault, role } = await c.browser(`/api/vaults/${id}`);
    if (vault?.id !== id || role !== listed.role) fail('vault_out_of_scope');
    if (write && (role !== 'owner' || vault.created_by !== c.ownerId)) fail('owner_scope_mismatch');
    // Read permission does NOT require ownership, private visibility, or sole membership.
    if (!write) return { vault: pick(vault, vaultFields), role };
    const { members, role: memberRole } = await c.browser(`/api/vaults/${id}/members`);
    if (memberRole !== 'owner' || !Array.isArray(members) || !members.some(m => m.userId === c.ownerId && m.role === 'owner')) fail('owner_scope_mismatch');
    return { vaultId: id, visibility: vault.visibility, role, members: members.map(m => pick(m, ['userId', 'role'])).sort((x,y) => x.userId-y.userId),
      privateSoleOwner: vault.visibility === 'private' && members.length === 1 && members[0].userId === c.ownerId };
  }
  async function listing(id, resource) {
    const data = await c.browser(`/api/vaults/${id}/${resource}`);
    const rows = data[resource];
    if (!Array.isArray(rows) || data.has_more || data.next_cursor || rows.some(n => n.vault_id !== id)) fail('readback_mismatch');
    return rows;
  }
  async function note(a, channel = false) {
    const rows = await listing(a.vaultId, 'notes');
    const id = a.noteId || a.channelId;
    if (!rows.some(n => n.id === id)) fail('note_out_of_scope');
    const { note: n } = await c.browser(`/api/notes/${id}`);
    if (n?.id !== id || n.vault_id !== a.vaultId || (channel && n.content !== 'cascade://chat-channel')) fail('note_out_of_scope');
    return pick(n, noteFields);
  }
  async function read(action, a) {
    const base = `/api/vaults/${a.vaultId}`;
    if (action === 'identity') return identity();
    if (action === 'vaults') {
      const { vaults } = await c.browser('/api/vaults');
      if (!Array.isArray(vaults)) fail('readback_mismatch');
      return { vaults: vaults.map(v => pick(v, vaultFields)) };
    }
    if (action === 'vault') return access(a.vaultId);
    if (action === 'notes') return { notes: (await listing(a.vaultId, 'notes')).map(n => pick(n, noteFields)) };
    if (action === 'folders') return { folders: (await listing(a.vaultId, 'folders')).map(f => pick(f, folderFields)) };
    if (action === 'navigation') return { ...(await access(a.vaultId)), ...(await read('folders', a)), ...(await read('notes', a)), desktopNavigation: false };
    if (action === 'note') return { note: await note(a) };
    if (['versions', 'backlinks'].includes(action)) { await note(a); return c.browser(`/api/notes/${a.noteId}/${action}`); }
    if (action === 'members') {
      const r = await c.browser(`${base}/members`);
      if (!Array.isArray(r.members)) fail('readback_mismatch');
      return { role: r.role, members: r.members.map(m => pick(m, ['userId', 'username', 'displayName', 'role'])) };
    }
    if (action === 'channelSettings' || action === 'channelHistory') {
      await note(a, true);
      const route = `${base}/channels/${a.channelId}/`;
      if (action === 'channelSettings') return c.browser(route + 'settings');
      const r = await c.browser(route + 'messages?limit=40');
      if (!Array.isArray(r.messages) || r.messages.some(m => m.channelId !== a.channelId)) fail('readback_mismatch');
      return { messages: r.messages.map(m => pick(m, ['id', 'channelId', 'body', 'author', 'actorUserId', 'agentId', 'registrationId', 'createdAt', 'status'])), windowLimit: 40, completeArchive: false };
    }
    if (action === 'vaultAgents') {
      const r = await c.browser(base + '/vault-agents');
      if (!Array.isArray(r.agents)) fail('readback_mismatch');
      return { agents: r.agents.map(m => pick(m, ['id', 'name', 'agentId', 'ownerUserId', 'model', 'hermesProfile', 'avatarUrl', 'mentionName', 'taggableByAgents', 'taggableByUsers', 'ambientGroupChat', 'bypassApprovals'])) };
    }
    const routes = { tags: base + '/tags', graph: base + '/graph', runs: base + '/runs', activeSessions: base + '/active-sessions', workItems: base + '/work-items', entitlement: base + '/managed-agent/entitlement', runnerStatus: '/api/me/desktop-runner', dmSettings: '/api/me/dm-settings' };
    return c.browser(routes[action]);
  }
  async function snapshot(action, a) {
    if (a.folderId !== undefined && a.folderId !== null && action !== 'renameFolder' || a.parentId != null) {
      const id = a.parentId || a.folderId;
      if (!(await listing(a.vaultId, 'folders')).some(f => f.id === id)) fail('note_out_of_scope');
    }
    if (a.noteId) return note(a);
    if (action === 'renameFolder') {
      const f = (await listing(a.vaultId, 'folders')).find(f => f.id === a.folderId);
      if (!f) fail('note_out_of_scope'); return pick(f, folderFields);
    }
    if (action === 'renameVault') return (await access(a.vaultId)).vault;
    return null;
  }
  async function mutate(action, a) {
    const base = `/api/vaults/${a.vaultId}`;
    if (action === 'createVault') return (await c.browser('/api/vaults', 'POST', { name: a.name, visibility: 'private' })).vault;
    if (action === 'renameVault') return (await c.browser(base, 'PATCH', { name: a.name })).vault;
    if (action === 'createFolder') return (await c.browser(base + '/folders', 'POST', { name: a.name, parent_id: a.parentId })).folder;
    if (action === 'renameFolder') return (await c.browser(`/api/folders/${a.folderId}`, 'PATCH', { name: a.name })).folder;
    if (action === 'createNote' || action === 'createChannel') return (await c.browser(base + '/notes', 'POST', { title: a.title, content: action === 'createChannel' ? 'cascade://chat-channel' : a.content, folder_id: a.folderId, is_listed: true })).note;
    if (action === 'renameNote') return (await c.browser(`/api/notes/${a.noteId}/rename`, 'POST', { title: a.title })).note;
    return (await c.browser(`/api/notes/${a.noteId}/move`, 'POST', { folder_id: a.folderId })).note;
  }
  async function verify(action, a, r) {
    await identity();
    const vId = action === 'createVault' ? r.id : a.vaultId;
    const audience = await access(vId, true);
    if (!audience.privateSoleOwner) fail('readback_mismatch');
    let result;
    if (action.endsWith('Vault')) {
      result = (await access(vId)).vault;
      if (result.name !== a.name) fail('readback_mismatch');
    } else if (action.endsWith('Folder')) {
      result = (await listing(vId, 'folders')).find(f => f.id === r.id);
      if (!result || result.name !== a.name || result.parent_id !== (action === 'createFolder' ? a.parentId : r.plan.before.parent_id)) fail('readback_mismatch');
      result = pick(result, folderFields);
    } else {
      result = await note({ vaultId: vId, noteId: r.id });
      const before = r.plan.before;
      const expected = action === 'createNote' || action === 'createChannel'
        ? { title: a.title, content: action === 'createChannel' ? 'cascade://chat-channel' : a.content, folder_id: a.folderId }
        : { title: action === 'renameNote' ? a.title : before.title, content: before.content, folder_id: action === 'moveNote' ? a.folderId : before.folder_id };
      if (Object.entries(expected).some(([k,v]) => result[k] !== v) || !result.is_listed) fail('readback_mismatch');
    }
    return result;
  }
}
module.exports = { control, reads, writes, blocked };
