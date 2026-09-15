'use strict';
// Named task operations. Transport and serialisation remain the existing private socket.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = code => { throw new Error(code); };
const canonical = x => JSON.stringify(x && typeof x === 'object' ? Array.isArray(x) ? x.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(x).sort().map(k => [k, JSON.parse(canonical(x[k]))])) : x);
const hash = x => createHash('sha256').update(canonical(x)).digest('hex');
const reads = { missions: ['vaultId'], mission: ['vaultId', 'missionId'], workItem: ['vaultId', 'workItemId'], taskItems: ['vaultId'], run: ['vaultId', 'runId'], runEvents: ['vaultId', 'runId'], agentExecution: ['vaultId','channelId','registrationId'], agentSettings: ['vaultId', 'channelId', 'registrationId', 'vaultAgentId', 'hermesProfile'] };
const writes = {
  createWorkItem: ['vaultId', 'title', 'brief', 'contract', 'verification'],
  updateWorkItem: ['vaultId', 'workItemId', 'patch'],
  createMission: ['vaultId', 'missionId', 'title', 'coordinatorIdentityId', 'briefContent', 'channelId', 'rootMessageId', 'coordinatorRegistrationId'],
  updateMission: ['vaultId', 'missionId', 'noteId', 'content'],
  approveMission: ['vaultId', 'missionId'],
  createMissionTask: ['vaultId', 'missionId', 'assigneeRegistrationId', 'title', 'prompt', 'purpose', 'workspaceMode'],
  updateMissionTask: ['vaultId', 'missionId', 'taskId', 'status', 'summary'],
  startRun: ['vaultId', 'workItemId', 'agent', 'model', 'prompt', 'cwd', 'sandbox'],
  cancelRun: ['vaultId', 'runId'],
  updateAgentSettings: [...reads.agentSettings, 'patch'],
};
const consequential = new Set(['createMission', 'startRun', 'cancelRun', 'updateAgentSettings', 'updateMission', 'approveMission', 'createMissionTask', 'updateMissionTask']);
function exact(o, keys) { if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o,k))) fail('invalid_request'); }
function id(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(v)) fail('invalid_id'); }
function text(v, n, empty = false) { if (typeof v !== 'string' || v.length > n || (!empty && !v.trim()) || v !== v.trim()) fail('invalid_request'); }
function validate(action, a, c, op) {
  // Historical receipts remain readable, but cannot authorize another channel allocation.
  const legacyReconcile = action === 'createMission' && op === 'appReconcile' && a && !Object.hasOwn(a, 'channelId');
  exact(a, legacyReconcile ? ['vaultId', 'missionId', 'title', 'coordinatorIdentityId', 'briefContent'] : reads[action] || writes[action] || []);
  for (const [k,v] of Object.entries(a)) {
    if (k === 'vaultId') c.checkId(v);
    else if (k === 'runId') { if (!Number.isSafeInteger(v) || v < 1) fail('invalid_id'); }
    else if (k.endsWith('Id')) id(v);
    else if (k === 'content') { if (typeof v !== 'string' || v.length > 65536) fail('invalid_request'); }
    else if (k !== 'patch') text(v, k === 'title' ? 180 : ['brief', 'verification'].includes(k) ? 8000 : 12000, ['brief', 'contract', 'verification', 'cwd'].includes(k));
  }
  if (action === 'startRun' && (!['codex','claude-code'].includes(a.agent) || !['read-only','default'].includes(a.sandbox))) fail('invalid_request');
  if (action === 'createMissionTask' && (!['research','implementation','fix','integration'].includes(a.purpose) || !['shared','isolated'].includes(a.workspaceMode))) fail('invalid_request');
  if (action === 'updateMissionTask' && !['blocked','canceled','failed'].includes(a.status)) fail('invalid_request');
  if (a.patch) {
    const allowed = action === 'updateWorkItem' ? ['title','brief','contract','verification','summary','status','priority','repository'] : ['model','reasoningEffort','contextPrompt','finalReplyOnly'];
    if (typeof a.patch !== 'object' || Array.isArray(a.patch) || !Object.keys(a.patch).length || Object.keys(a.patch).some(k => !allowed.includes(k))) fail('invalid_request');
    for (const [k,v] of Object.entries(a.patch)) {
      if (k === 'repository') {
        // Binding may unblock an existing paid-capable dispatch. Never combine it
        // with status, branch, worktree, cwd or privilege changes.
        // Match WorkItems.update's stored bound: never silently truncate a path.
        text(v, 500);
        if (Object.keys(a.patch).length !== 1 || !path.isAbsolute(v) || v.includes('\0') || path.normalize(v) !== v) fail('invalid_request');
        if (!fs.statSync(v).isDirectory() || !fs.existsSync(path.join(v, '.git'))) fail('invalid_repository');
      }
      if (k === 'priority') { if (!Number.isInteger(v) || v < -100 || v > 100) fail('invalid_request'); }
      else if (k === 'finalReplyOnly') { if (typeof v !== 'boolean') fail('invalid_request'); }
      else text(v, k === 'title' ? 180 : k === 'summary' ? 4000 : k === 'model' ? 160 : 8000, !['title','status','model'].includes(k));
      if (k === 'status' && !['open','blocked','review','done','canceled'].includes(v)) fail('invalid_request');
      if (k === 'reasoningEffort' && !['','low','medium','high','xhigh'].includes(v)) fail('invalid_request');
    }
  }
}
function privateJSON(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.size > 262144) fail('unsafe_receipt');
  try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { fail('uncertain_write'); }
}
async function control(input, c) {
  const a = input.args, action = input.action;
  const repositoryBinding = action === 'updateWorkItem' && Object.hasOwn(a?.patch || {}, 'repository');
  const requiresGrant = consequential.has(action) || repositoryBinding;
  if (!reads[action] && !writes[action]) fail('invalid_request');
  exact(input, input.op === 'appRead' ? ['op','action','args'] : input.op === 'appPlan' ? ['op','action','args','requestId'] : ['op','action','args','requestId','planDigest']);
  validate(action, a, c, input.op);
  if ((await c.browser('/api/me')).user?.id !== c.ownerId) fail('owner_scope_mismatch');
  const base = `/api/vaults/${a.vaultId}`;
  const audience = await access(input.op !== 'appRead');
  if (input.op === 'appRead') { if (!reads[action]) fail('invalid_request'); return read(action, a); }
  if (!['appPlan','appApply','appReconcile'].includes(input.op) || !writes[action]) fail('invalid_request');
  if (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId)) fail('invalid_request_id');
  const intent = { contract: 'fizzer_task_control_v1', origin: c.scope.origin, ownerId: c.ownerId, actor: c.author, action, args:a, requestId:input.requestId };
  const file = path.join(c.receiptDir, 'task-' + hash({origin:c.scope.origin, ownerId:c.ownerId, requestId:input.requestId}) + '.json');
  let r;
  if (fs.existsSync(file)) {
    r = privateJSON(file);
    if (r.intentDigest !== hash(intent)) fail('idempotency_conflict');
    if (input.op !== 'appPlan' && input.planDigest !== r.planDigest) fail('stale_plan');
  } else {
    if (input.op !== 'appPlan') fail('intent_not_found');
    if (fs.readdirSync(c.receiptDir).length >= 1000) fail('receipt_limit');
    const before = await snapshot();
    const plan = {...intent, before, audience, requiresGrant, atomicPrecondition:action === 'updateAgentSettings' || action === 'updateMission',
      effects: repositoryBinding ? 'Binds only this unbound isolated mission work item repository; the existing pending dispatch may retry and spend provider tokens under unchanged assignee settings. No new task, run, approval, cwd or privilege change. Fresh whole-item guard, not backend atomic CAS.' : action === 'createMission' ? 'Creates a mission brief in the explicit existing channel rooted at its existing message; preserves coordinator membership and queues planning model dispatch. No new channel. NOT a draft.' : action === 'startRun' ? 'Starts a paid-capable owner run with yolo false, then links its exact ID to the work item. Stop is separate.' : action === 'updateMission' ? 'Edits exact mission brief/note; approved revisions may become stale and coordinator awareness can cause later model work. Does not approve.' : ['approveMission','createMissionTask','updateMissionTask'].includes(action) ? 'Mission scheduler may dispatch paid-capable work; task cancellation can stop its linked run. Exact whole before-state is previewed.' : 'Exact named resource only; work-item status metadata does not stop runs.',
      attribution:'Along local receipt; backend account attribution. Shared/public writes unavailable.'};
    r = {intentDigest:hash(intent), plan, planDigest:hash(plan), state:'planned'};
    c.durableWrite(file,r,true);
  }
  if (input.op === 'appPlan') return {...r.plan, planDigest:r.planDigest, state:r.state};
  if (input.op === 'appReconcile' && r.state === 'planned') return {state:'planned', applied:false};
  if (r.state === 'planned') {
    if (requiresGrant) grant(r.planDigest);
    const fresh = await snapshot();
    // A run's streamed output changes continuously; Stop binds its immutable ID,
    // vault and owner-only GET authorization, not a frozen output/status snapshot.
    const stale = action === 'cancelRun' ? fresh.id !== r.plan.before.id || fresh.vault_id !== r.plan.before.vault_id : hash(fresh) !== hash(r.plan.before);
    if (hash(audience) !== hash(r.plan.audience) || stale) fail('stale_plan');
    r.state = 'uncertain';
    r.target = action === 'createMission' ? a.missionId : action === 'updateWorkItem' ? a.workItemId : action === 'cancelRun' ? a.runId : action === 'updateMission' ? a.noteId : action === 'updateAgentSettings' ? a.registrationId : null;
    if (action === 'approveMission') r.target = a.missionId;
    if (action === 'updateMissionTask') r.target = a.taskId;
    c.durableWrite(file,r);
    await mutate();
  }
  if (!r.target) return {state:'uncertain', replayAllowed:false, reason:'creation_response_unknown'};
  const result = await verify();
  if (action === 'startRun' && result.linkVerified === false) return {state:'uncertain',reason:'run_link_not_verified',replayAllowed:false,result,planDigest:r.planDigest};
  r.state = 'verified'; c.durableWrite(file,r);
  return {state:'verified', planDigest:r.planDigest, result, replayed:false, actor:c.author};

  async function access(write) {
    const {vault,role} = await c.browser(base);
    if (vault?.id !== a.vaultId || !['owner','editor','viewer'].includes(role)) fail('vault_out_of_scope');
    if (!write) return {vaultId:vault.id,role};
    const {members,role:memberRole} = await c.browser(base+'/members');
    if (role !== 'owner' || vault.created_by !== c.ownerId || memberRole !== 'owner') fail('owner_scope_mismatch');
    if (vault.visibility !== 'private' || !Array.isArray(members) || members.length !== 1 || members[0].userId !== c.ownerId || members[0].role !== 'owner') fail('specific_approval_required');
    return {vaultId:vault.id,visibility:vault.visibility,role,ownerId:c.ownerId};
  }
  async function item(i) {
    const d = await c.browser(`/api/work-items/${i}`);
    if (d.item?.id !== i || d.item.vaultId !== a.vaultId) fail('readback_mismatch');
    return d;
  }
  async function run(i) {
    const d = await c.browser(`/api/runs/${i}`);
    // Backend owner-only GET is authoritative; never widen to an all-account endpoint.
    if (d.run?.id !== i || d.run.vault_id !== a.vaultId) fail('readback_mismatch');
    return d;
  }
  async function mission(i) {
    const d = await c.browser(base+`/missions/${i}`);
    if (d.mission?.id !== i || d.mission.vaultId !== a.vaultId) fail('readback_mismatch');
    return d;
  }
  function settingsRoute() { return base+`/channels/${a.channelId}/agents/${a.registrationId}/settings-v1?vaultAgentId=${a.vaultAgentId}&hermesProfile=${encodeURIComponent(a.hermesProfile)}`; }
  async function settings() {
    const d = await c.browser(settingsRoute());
    if (d.contract !== 'registration_settings_v1' || d.registration?.id !== a.registrationId || d.registration.vaultAgentId !== a.vaultAgentId || d.registration.ownerUserId !== c.ownerId || d.registration.hermesProfile !== a.hermesProfile || d.registration.localVaultId !== a.vaultId || d.registration.localChannelId !== a.channelId) fail('readback_mismatch');
    return d;
  }
  async function read(which, arg) {
    if (which === 'agentExecution') return execution(arg.channelId,arg.registrationId);
    if (which === 'missions') return c.browser(base+'/missions');
    if (which === 'mission') return mission(arg.missionId);
    if (which === 'taskItems') return c.browser(base+'/work-items');
    if (which === 'workItem') return item(arg.workItemId);
    if (which === 'agentSettings') return settings();
    const d = await run(arg.runId);
    return which === 'runEvents' ? {...d, ...await c.browser(`/api/runs/${arg.runId}/events`)} : d;
  }
  async function missionNote() {
    const m = (await mission(a.missionId)).mission;
    if (!m.notes?.some(n => n.noteId === a.noteId)) fail('note_out_of_scope');
    const d = await c.browser(`/api/notes/${a.noteId}`);
    if (d.note?.id !== a.noteId || d.note.vault_id !== a.vaultId || !d.note.revision) fail('readback_mismatch');
    const executionSettings = [];
    for (const registrationId of [...new Set([m.coordinatorRegistrationId, ...(m.tasks || []).map(t => t.assigneeRegistrationId)])]) {
      id(m.channelId); id(registrationId);
      const e = await execution(m.channelId, registrationId);
      if (e.yolo !== false) fail('specific_approval_required');
      executionSettings.push(e);
    }
    return {note:d.note, missionId:m.id, executionSettings};
  }
  async function execution(channelId, registrationId) {
    const d = await c.browser(base+`/channels/${channelId}/agents/${registrationId}/execution-v1`);
    if (d.contract !== 'registration_execution_select_only_v1' || d.ownerUserId !== c.ownerId || d.vaultId !== a.vaultId || d.channelId !== channelId || d.registrationId !== registrationId) fail('readback_mismatch');
    return d;
  }
  async function snapshot() {
    if (action === 'createMission') {
      const e = await execution(a.channelId, a.coordinatorRegistrationId);
      if (e.yolo !== false) fail('specific_approval_required');
      return e;
    }
    if (action === 'updateWorkItem' || action === 'startRun') {
      const d = await item(a.workItemId);
      if (d.item.createdBy !== c.ownerId) fail('owner_scope_mismatch');
      if (repositoryBinding) {
        const w = d.item;
        if (w.sourceKind !== 'mission' || w.workspaceMode !== 'isolated' || w.status !== 'open' || w.runIds?.length || w.leaseHolder || w.worktreePath || w.baseCommit || w.repository) fail('running_work');
        id(w.channelId); id(w.assigneeRegistrationId); id(w.sourceId);
        const e = await execution(w.channelId, w.assigneeRegistrationId);
        if (e.yolo !== false) fail('specific_approval_required');
        // Entire item (including source task, runs and updatedAt) and SELECT-only
        // execution settings are compared again immediately before the PATCH.
        // Backend work-item PATCH has no atomic revision CAS; preview says so.
        return {item:w, executionSettings:e};
      }
      if (action === 'startRun' && (!['open','blocked','review'].includes(d.item.status) || d.item.runIds?.length)) fail('running_work');
      return d.item;
    }
    if (action === 'cancelRun') return (await run(a.runId)).run;
    if (action === 'updateAgentSettings') return settings();
    if (action === 'updateMission') return missionNote();
    if (['approveMission','createMissionTask','updateMissionTask'].includes(action)) {
      const m = (await mission(a.missionId)).mission;
      id(m.channelId); id(m.coordinatorRegistrationId);
      if (action === 'createMissionTask' && a.assigneeRegistrationId === m.coordinatorRegistrationId) fail('invalid_request');
      if (a.taskId && !m.tasks?.some(t => t.id === a.taskId)) fail('readback_mismatch');
      const registrations = [...new Set([m.coordinatorRegistrationId, ...m.tasks.map(t => t.assigneeRegistrationId), ...(a.assigneeRegistrationId ? [a.assigneeRegistrationId] : [])])];
      const executionSettings = [];
      for (const registrationId of registrations) {
        id(registrationId);
        const d = await execution(m.channelId,registrationId);
        if (d.yolo !== false) fail('specific_approval_required');
        executionSettings.push(d);
      }
      m.executionSettings = executionSettings;
      if (action === 'approveMission') {
        m.approvalNotes = [];
        for (const n of m.notes) {
          id(n.noteId);
          const d = await c.browser(`/api/notes/${n.noteId}`);
          if (d.note?.id !== n.noteId || d.note.vault_id !== a.vaultId || d.note.revision !== n.revision) fail('readback_mismatch');
          m.approvalNotes.push(d.note);
        }
      }
      return m;
    }
    return null;
  }
  function grant(planDigest) {
    const f = path.join(c.receiptDir, 'task-grant-'+planDigest+'.json');
    if (!fs.existsSync(f)) fail('specific_approval_required');
    const g = privateJSON(f);
    if (g.contract !== 'along_task_grant_v1' || g.planDigest !== planDigest || g.ownerId !== c.ownerId || g.origin !== c.scope.origin || !Number.isSafeInteger(g.expiresAt) || g.expiresAt < Date.now() || typeof g.ownerTurn !== 'string' || !g.ownerTurn.trim()) fail('specific_approval_required');
  }
  async function mutate() {
    let d;
    if (action === 'createWorkItem') {
      d = await c.browser(base+'/work-items','POST',{title:a.title,brief:a.brief,contract:a.contract,verification:a.verification,sourceKind:'manual',sourceId:'along:'+input.requestId,workspaceMode:'shared',priority:0,tokenBudget:0,dependsOn:[],channelId:null,assigneeRegistrationId:null});
      r.target = d.item?.id;
    } else if (action === 'updateWorkItem') await c.browser(`/api/work-items/${a.workItemId}`,'PATCH',a.patch);
    else if (action === 'createMission') await c.browser(base+'/missions','POST',{id:a.missionId,title:a.title,coordinatorIdentityId:a.coordinatorIdentityId,briefContent:a.briefContent,channelId:a.channelId,rootMessageId:a.rootMessageId,coordinatorRegistrationId:a.coordinatorRegistrationId});
    else if (action === 'updateMission') await c.browser(`/api/notes/${a.noteId}`,'PUT',{content:a.content,expectedRevision:r.plan.before.note.revision});
    else if (action === 'approveMission') await c.browser(base+`/missions/${a.missionId}/approve`,'POST',{expectedRevisions:Object.fromEntries(r.plan.before.notes.map(n => [n.noteId,n.revision]))});
    else if (action === 'createMissionTask') {
      d = await c.browser(base+`/channels/${r.plan.before.channelId}/missions/${a.missionId}/tasks`,'POST',{coordinatorRegistrationId:r.plan.before.coordinatorRegistrationId,title:a.title,assignee:a.assigneeRegistrationId,prompt:a.prompt,purpose:a.purpose,briefNoteId:null,briefRevisions:null,dependsOn:[],priority:0,reasoningEffort:'',anonymous:false,workspaceMode:a.workspaceMode});
      r.target = d.task?.id;
    }
    else if (action === 'updateMissionTask') await c.browser(base+`/channels/${r.plan.before.channelId}/missions/tasks/${a.taskId}`,'PATCH',{status:a.status,summary:a.summary,finding:false,reviewOutcome:null,verificationPassed:null});
    else if (action === 'updateAgentSettings') await c.browser(settingsRoute(),'PATCH',{expectedRevision:r.plan.before.revision,patch:a.patch});
    else if (action === 'cancelRun') await c.browser(`/api/runs/${a.runId}/cancel`,'POST',{steering:false});
    else {
      d = await c.browser(base+'/runs','POST',{agent:a.agent,model:a.model,prompt:a.prompt,cwd:a.cwd,sandbox:a.sandbox === 'read-only' ? 'read-only' : null,yolo:false,contextMode:'self-contained',note_id:null,conversation_id:null,images:[]});
      r.target = d.run?.id;
      if (!Number.isSafeInteger(r.target) || r.target < 1) fail('readback_mismatch');
      c.durableWrite(file,r);
      await run(r.target);
      // Link write is also never retried automatically after an uncertain response.
      await c.browser(`/api/work-items/${a.workItemId}/runs`,'POST',{runId:r.target});
    }
    if (r.target == null) fail('readback_mismatch');
    c.durableWrite(file,r);
  }
  async function verify() {
    if ((await c.browser('/api/me')).user?.id !== c.ownerId) fail('owner_scope_mismatch');
    await access(true);
    if (action === 'createWorkItem' || action === 'updateWorkItem') {
      const d = await item(r.target), expected = action === 'createWorkItem' ? {title:a.title,brief:a.brief,contract:a.contract,verification:a.verification,sourceId:'along:'+input.requestId} : a.patch;
      if (Object.entries(expected).some(([k,v]) => d.item[k] !== v)) fail('readback_mismatch');
      return d;
    }
    if (action === 'createMission') { const d = await mission(r.target); if (d.mission.title !== a.title || d.mission.objective !== a.briefContent || (a.channelId && (d.mission.channelId !== a.channelId || d.mission.coordinatorRegistrationId !== a.coordinatorRegistrationId))) fail('readback_mismatch'); return d; }
    if (action === 'updateMission') { const d = await missionNote(); if (d.note.content !== a.content) fail('readback_mismatch'); return d; }
    if (['approveMission','createMissionTask','updateMissionTask'].includes(action)) {
      const d = await mission(a.missionId);
      if (action === 'approveMission') {
        const expected = Object.fromEntries(r.plan.before.notes.map(n => [n.noteId,n.revision]));
        if (hash(d.mission.approvedRevisions) !== hash(expected) || d.mission.approvedBy !== c.ownerId) fail('readback_mismatch');
      } else {
        const task = d.mission.tasks?.find(t => t.id === r.target);
        if (!task || (action === 'createMissionTask' ? task.title !== a.title : task.status !== a.status || task.summary !== a.summary)) fail('readback_mismatch');
      }
      return d;
    }
    if (action === 'updateAgentSettings') {
      const d = await settings();
      if (hash(d.settings) !== hash({...r.plan.before.settings,...a.patch}) || hash(d.protected) !== hash(r.plan.before.protected)) fail('readback_mismatch');
      return d;
    }
    const d = await run(r.target);
    if (action === 'cancelRun' && !['canceled','completed','failed','interrupted'].includes(d.run.status)) fail('readback_mismatch');
    if (action === 'startRun') { const w = await item(a.workItemId); return {...d,item:w.item,linkVerified:w.item.runIds?.includes(r.target) === true}; }
    return d;
  }
}
module.exports = {control, reads, writes, hash};
