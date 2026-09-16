'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {randomUUID} = require('node:crypto');
const {startExternalAgentAccess, request} = require('./external-agent-access.cjs');
const {reads,writes,hash} = require('./task-control.cjs');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'fizzer-task-'));
  fs.chmodSync(directory,0o700);
  const v = randomUUID(), w = randomUUID(), m = randomUUID(), registrationId = randomUUID(), identityId = randomUUID(), channelId = randomUUID();
  const items = new Map([[w,{id:w,vaultId:v,title:'Fixture task',brief:'test',contract:'',verification:'',status:'open',createdBy:1,runIds:[]}]]);
  const missions = new Map(), runs = new Map(), notes = new Map(), calls=[];
  const messages = new Map([['owner-source',{id:'owner-source',channelId,actorUserId:1,body:'Authorized original scope'}]]);
  const state = {owner:1,shared:false,lost:false,linkLost:false,wrong:false};
  const settings = {contract:'registration_settings_v1',registration:{id:registrationId,vaultAgentId:identityId,ownerUserId:1,hermesProfile:'along',localVaultId:v,localChannelId:channelId},settings:{model:'model-a',reasoningEffort:'',contextPrompt:'preserve',finalReplyOnly:false},protected:{yolo:false,ambientGroupChat:false},revision:'initial'};
  const server = http.createServer(async(req,res) => {
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body=raw ? JSON.parse(raw):null, u=new URL(req.url,'http://fixture'), p=u.pathname, get=req.method==='GET';
    calls.push({method:req.method,path:p,body});
    assert.equal(req.headers['x-cascade-browser'],'1');
    assert.equal(req.headers.authorization,undefined);
    const reply=(code,data)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(data));};
    const changed=data=>reply(state.lost ? 500:200,state.lost ? {error:'PRIVATE BACKEND DETAIL'}:data);
    if(p==='/api/me') return reply(200,{user:{id:state.owner}});
    if(p===`/api/vaults/${v}`) return reply(200,{vault:{id:v,created_by:1,visibility:'private'},role:'owner'});
    if(p===`/api/vaults/${v}/members`) return reply(200,{role:'owner',members:[{userId:1,role:'owner'},...(state.shared ? [{userId:2,role:'viewer'}]:[])]});
    if(p.startsWith(`/api/vaults/${v}/channels/${channelId}/messages/`)) {
      const id=p.split('/')[7];
      if(get) return messages.has(id) ? reply(200,{message:messages.get(id)}) : reply(404,{});
      assert.equal(p,`/api/vaults/${v}/channels/${channelId}/messages/owner-source/collaborate`);
      assert.equal(body.target,registrationId);assert.equal(body.relationship,'builds_on');
      const message={id:body.requestId,channelId,actorUserId:1,body:'@fixture '+body.instruction,replyTo:{messageId:id,relationship:body.relationship}};
      messages.set(message.id,message);return changed({message,dispatch:{id:'fixture-dispatch',registrationId}});
    }
    if(p===`/api/vaults/${v}/work-items`) {
      if(get) return reply(200,{items:[...items.values()]});
      assert.equal(body.sourceKind,'manual');assert.equal(body.tokenBudget,0);assert.equal(body.assigneeRegistrationId,null);
      const item={...body,id:randomUUID(),vaultId:v,createdBy:1,status:'open',runIds:[]};items.set(item.id,item);return changed({item});
    }
    if(p.startsWith('/api/work-items/')) {
      const [, , , id,suffix]=p.split('/'), item=items.get(id);
      if(!item) return reply(404,{});
      if(suffix==='repository-binding-v1') {
        const binding={taskId:item.sourceId,ownerId:1,vaultId:v,workItemId:id};
        const revision=hash(JSON.parse(JSON.stringify({item,binding})));
        if(get) return reply(200,{binding:{contract:'repository_binding_atomic_v1',item,binding,revision}});
        assert.equal(req.method,'PUT');assert.equal(body.expectedRevision,revision);
        item.repository=body.repository;return changed({item});
      }
      if(!get && suffix==='runs') {assert.equal(typeof body.runId,'number');item.runIds.push(body.runId);if(state.linkLost)return reply(500,{});}
      else if(!get) Object.assign(item,body);
      return get ? reply(200,{item:state.wrong?{...item,vaultId:'wrong'}:item,reviews:[],siblings:[]}):changed({item});
    }
    if(p===`/api/vaults/${v}/runs`) {
      assert.equal(body.yolo,false);assert.equal(body.contextMode,'self-contained');assert.equal(body.conversation_id,null);
      const run={id:runs.size+1,vault_id:v,status:'running',summary:'',agent:body.agent};runs.set(run.id,run);return changed({run});
    }
    if(p.startsWith('/api/runs/')) {
      const [, , , rawId,suffix]=p.split('/'), run=runs.get(Number(rawId));
      if(!run)return reply(404,{});
      if(suffix==='events')return reply(200,{events:[{type:'status',data:{status:run.status}}]});
      if(!get){assert.deepEqual(body,{steering:false});run.status='canceled';return changed({success:true});}
      return reply(200,{run});
    }
    if(p===`/api/vaults/${v}/missions`) {
      if(get)return reply(200,{missions:[...missions.values()]});
      assert.equal(body.channelId,channelId); assert.equal(body.rootMessageId,'existing-root'); assert.equal(body.coordinatorRegistrationId,registrationId);
      const mission={id:body.id,vaultId:v,channelId:body.channelId,coordinatorRegistrationId:registrationId,title:body.title,objective:body.briefContent,phase:'planning',status:'active',blockedReason:null,notes:[{noteId:'mission-brief-'+body.id,revision:'1'}],tasks:[]};
      missions.set(body.id,mission);notes.set('mission-brief-'+body.id,{id:'mission-brief-'+body.id,vault_id:v,content:body.briefContent,revision:'1'});return changed({mission});
    }
    if(p.endsWith('/approve')) {
      const mission=missions.get(m);assert.deepEqual(body,{expectedRevisions:Object.fromEntries(mission.notes.map(n=>[n.noteId,n.revision]))});
      mission.approvedRevisions=body.expectedRevisions;mission.approvedBy=1;mission.phase='executing';return changed({mission});
    }
    if(p===`/api/vaults/${v}/channels/${channelId}/missions/${m}/tasks`) {
      const mission=missions.get(m);assert.equal(body.coordinatorRegistrationId,registrationId);assert.equal(body.anonymous,false);assert.equal(body.workspaceMode,'shared');
      const task={id:randomUUID(),assigneeRegistrationId:body.assignee,title:body.title,status:'pending',summary:'',workItemId:w};mission.tasks.push(task);return changed({task,mission,scheduled:false});
    }
    if(p.startsWith(`/api/vaults/${v}/channels/${channelId}/missions/tasks/`)) {
      const mission=missions.get(m),task=mission.tasks.find(t=>t.id===p.split('/').at(-1));assert.equal(body.finding,false);assert.equal(body.verificationPassed,null);Object.assign(task,{status:body.status,summary:body.summary});return changed({mission});
    }
    if(p.startsWith(`/api/vaults/${v}/missions/`))return reply(200,{mission:missions.get(p.split('/').at(-1))});
    if(p.startsWith('/api/notes/')) {
      const note=notes.get(p.split('/').at(-1));if(!note)return reply(404,{});
      if(!get){assert.equal(body.expectedRevision,note.revision);note.content=body.content;note.revision='2';missions.get(m).notes[0].revision='2';return changed({note});}return reply(200,{note});
    }
    if(p.endsWith('/execution-v1')) {
      const parts=p.split('/');return reply(200,{contract:'registration_execution_select_only_v1',ownerUserId:1,vaultId:v,channelId:parts[5],registrationId:parts[7],vaultAgentId:identityId,agentId:'codex',yolo:state.yolo === true,model:state.executionModel || 'fixture-model'});
    }
    if(p===`/api/vaults/${v}/channels/${channelId}/agents/${registrationId}/settings-v1`) {
      assert.equal(u.searchParams.get('hermesProfile'),'along');
      if(!get){assert.equal(body.expectedRevision,settings.revision);Object.assign(settings.settings,body.patch);settings.revision='updated';return changed(settings);}return reply(200,settings);
    }
    return reply(404,{});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const options={enabled:true,directory,origin,vaultId:v,ownerId:1,agentId:'hermes',author:'Along (AI agent)',browserFetch:fetch,agentFetch:fetch,allowFixtureHTTP:true};
  let service=await startExternalAgentAccess(options);
  t.after(async()=>{await service.close();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true});});
  const call=p=>request(service.socketPath,p);
  const plan=(action,args,requestId=randomUUID())=>call({op:'appPlan',action,args,requestId});
  const apply=(p,op='appApply')=>call({op,action:p.action,args:p.args,requestId:p.requestId,planDigest:p.planDigest});
  const grant=(p,changes={})=>fs.writeFileSync(path.join(directory,'receipts','task-grant-'+p.planDigest+'.json'),JSON.stringify({contract:'along_task_grant_v1',origin,ownerId:1,ownerTurn:'fixture-only',planDigest:p.planDigest,expiresAt:Date.now()+60000,...changes}),{mode:0o600});
  return {v,w,m,registrationId,identityId,channelId,messages,items,runs,missions,notes,state,settings,calls,call,plan,apply,grant,directory,socketPath:service.socketPath,restart:async()=>{await service.close();service=await startExternalAgentAccess(options);}};
}
const taskArgs=f=>({vaultId:f.v,title:'Synthetic only',brief:'brief',contract:'acceptance',verification:'offline check'});
const startArgs=f=>({vaultId:f.v,workItemId:f.w,agent:'codex',model:'test-model',prompt:'synthetic prompt',cwd:'',sandbox:'read-only'});
const settingArgs=f=>({vaultId:f.v,channelId:f.channelId,registrationId:f.registrationId,vaultAgentId:f.identityId,hermesProfile:'along'});
const missionArgs=f=>({vaultId:f.v,missionId:f.m,title:'Synthetic mission',coordinatorIdentityId:f.identityId,briefContent:'Synthetic brief',channelId:f.channelId,rootMessageId:'existing-root',coordinatorRegistrationId:f.registrationId});
const count=f=>f.calls.filter(c=>c.method!=='GET').length;
const collaborationArgs=f=>({vaultId:f.v,channelId:f.channelId,sourceMessageId:'owner-source',registrationId:f.registrationId,vaultAgentId:f.identityId,instruction:'Continue only the authorized source with your own workers.'});
test('owner collaboration preserves yolo guard and CSRF, exact grant and stable no-replay reconciliation',async t=>{
  const f=await fixture(t);f.state.yolo=true;
  assert.equal((await f.plan('createMission',missionArgs(f))).error,'specific_approval_required');
  const p=await f.plan('collaborateOwnerSource',collaborationArgs(f));assert.equal(p.before.executionSettings.yolo,true);assert.equal(p.requiresGrant,true);
  assert.equal((await f.apply(p)).error,'specific_approval_required');assert.equal(count(f),0);
  f.grant(p);const result=await f.apply(p);assert.equal(result.state,'verified',JSON.stringify(result));assert.equal(result.result.dispatch.registrationId,f.registrationId);
  await f.restart();assert.equal((await f.apply(p,'appReconcile')).state,'verified');assert.equal((await f.apply(p)).state,'verified');assert.equal(count(f),1);
  assert.deepEqual(f.calls.filter(c=>c.method!=='GET').map(c=>c.body),[{requestId:p.requestId,target:f.registrationId,relationship:'builds_on',instruction:p.args.instruction}]);
  assert.equal((await f.plan('collaborateOwnerSource',{...p.args,instruction:'Changed'},p.requestId)).error,'idempotency_conflict');
  const lost=await f.plan('collaborateOwnerSource',collaborationArgs(f));f.grant(lost);f.state.lost=true;assert.equal((await f.apply(lost)).error,'upstream_500');
  f.state.lost=false;await f.restart();const n=count(f),r=await f.apply(lost,'appReconcile');assert.equal(r.state,'verified');assert.equal(r.result.dispatch,null);assert.equal(count(f),n);
});
test('owner collaboration rejects source/target changes, agent sources, unsafe grants and privilege edits',async t=>{
  const f=await fixture(t),a=collaborationArgs(f),source=f.messages.get(a.sourceMessageId);
  for(const patch of [{actorUserId:2},{agentId:'codex'},{registrationId:f.registrationId}]){
    Object.assign(source,patch);assert.equal((await f.plan('collaborateOwnerSource',a)).error,'owner_scope_mismatch');
    Object.assign(source,{actorUserId:1});delete source.agentId;delete source.registrationId;
  }
  assert.equal((await f.plan('collaborateOwnerSource',{...a,vaultAgentId:randomUUID()})).error,'owner_scope_mismatch');
  for(const patch of [{yolo:false},{relationship:'question'},{instruction:'🎵'.repeat(2100)}])assert.equal((await f.plan('collaborateOwnerSource',{...a,...patch})).error,'invalid_request');
  let p=await f.plan('collaborateOwnerSource',a);f.grant(p,{expiresAt:1});assert.equal((await f.apply(p)).error,'specific_approval_required');
  f.grant(p,{ownerId:2});assert.equal((await f.apply(p)).error,'specific_approval_required');
  f.grant(p);source.body='Edited';assert.equal((await f.apply(p)).error,'stale_plan');
  p=await f.plan('collaborateOwnerSource',a);f.grant(p);f.state.yolo=true;assert.equal((await f.apply(p)).error,'stale_plan');
  f.state.shared=true;assert.equal((await f.plan('collaborateOwnerSource',a)).error,'specific_approval_required');assert.equal(count(f),0);
});
const repositoryArgs=f=>{
  const repository=path.join(f.directory,'repo');fs.mkdirSync(repository);fs.mkdirSync(path.join(repository,'.git'));
  Object.assign(f.items.get(f.w),{sourceKind:'mission',sourceId:randomUUID(),workspaceMode:'isolated',repository:'',worktreePath:'',baseCommit:'',channelId:f.channelId,assigneeRegistrationId:f.registrationId,updatedAt:'revision-1'});
  return {vaultId:f.v,workItemId:f.w,patch:{repository}};
};
test('repository-only binding requires owner grant and reconciles a lost response without replay',async t=>{
  const f=await fixture(t),args=repositoryArgs(f),p=await f.plan('updateWorkItem',args);
  assert.equal(p.requiresGrant,true);assert.equal(p.atomicPrecondition,true);assert.match(p.effects,/existing pending dispatch/);
  assert.equal((await f.apply(p)).error,'specific_approval_required');assert.equal(count(f),0);
  f.grant(p);f.state.lost=true;assert.equal((await f.apply(p)).error,'upstream_500');
  f.state.lost=false;await f.restart();const n=count(f),r=await f.apply(p,'appReconcile');
  assert.equal(r.state,'verified');assert.equal(r.result.item.repository,args.patch.repository);assert.equal(count(f),n);
  assert.deepEqual(f.calls.filter(c=>c.method!=='GET').map(c=>[c.method,c.path,c.body]),[['PUT',`/api/work-items/${f.w}/repository-binding-v1`,{repository:args.patch.repository,expectedRevision:p.before.binding.revision}]]);
});
test('repository binding rejects mixed patches, running/bound work, yolo and changed item/settings',async t=>{
  const f=await fixture(t),args=repositoryArgs(f);
  for(const patch of [{repository:'relative'},{...args.patch,status:'open'},{...args.patch,branch:'new'},{repository:'/tmp/../tmp'},{repository:'/'+ 'a'.repeat(500)}]) assert.equal((await f.plan('updateWorkItem',{...args,patch})).error,'invalid_request');
  f.state.yolo=true;assert.equal((await f.plan('updateWorkItem',args)).error,'specific_approval_required');f.state.yolo=false;
  for(const [key,value] of [['runIds',[1]],['worktreePath','/tmp/work'],['baseCommit','abc'],['repository','/tmp/repo'],['leaseHolder','worker'],['status','done']]){
    const item=f.items.get(f.w),old=item[key];item[key]=value;
    assert.equal((await f.plan('updateWorkItem',args)).error,'running_work');item[key]=old;
  }
  let p=await f.plan('updateWorkItem',args);f.grant(p);f.items.get(f.w).updatedAt='revision-2';assert.equal((await f.apply(p)).error,'stale_plan');
  p=await f.plan('updateWorkItem',args);f.grant(p);f.state.executionModel='changed';assert.equal((await f.apply(p)).error,'stale_plan');
  assert.equal(count(f),0);
});
test('legacy channel-allocating mission requests cannot plan another write',async t=>{
  const f=await fixture(t), args=missionArgs(f);
  delete args.channelId; delete args.rootMessageId; delete args.coordinatorRegistrationId;
  const before=count(f);
  assert.equal((await f.plan('createMission',args)).error,'invalid_request');
  assert.equal(count(f),before);
});
test('named lifecycle over real private Unix socket and HTTP fixtures; all task reads and writes',async t=>{
  const f=await fixture(t);
  const cap=await f.call({op:'appCapabilities'});
  for(const action of [...Object.keys(reads),...Object.keys(writes)])assert.ok(cap.operations.some(o=>o.action===action&&o.implemented),action);
  const created=await f.apply(await f.plan('createWorkItem',taskArgs(f)));assert.equal(created.state,'verified',JSON.stringify(created));
  const update=await f.plan('updateWorkItem',{vaultId:f.v,workItemId:created.result.item.id,patch:{title:'Changed',status:'blocked',summary:'Needs owner decision'}});
  assert.equal((await f.apply(update)).result.item.summary,'Needs owner decision');
  const mission=await f.plan('createMission',missionArgs(f));assert.match(mission.effects,/NOT a draft/);f.grant(mission);
  assert.equal((await f.apply(mission)).state,'verified');
  const edit=await f.plan('updateMission',{vaultId:f.v,missionId:f.m,noteId:'mission-brief-'+f.m,content:'Changed brief'});f.grant(edit);assert.equal((await f.apply(edit)).result.note.content,'Changed brief');
  const approval=await f.plan('approveMission',{vaultId:f.v,missionId:f.m});assert.equal((await f.apply(approval)).error,'specific_approval_required');f.grant(approval);assert.equal((await f.apply(approval)).result.mission.approvedBy,1);
  const add=await f.plan('createMissionTask',{vaultId:f.v,missionId:f.m,assigneeRegistrationId:randomUUID(),title:'Synthetic subtask',prompt:'Fixture only',purpose:'implementation',workspaceMode:'shared'});assert.equal((await f.apply(add)).error,'specific_approval_required');f.grant(add);const added=await f.apply(add);assert.equal(added.state,'verified',JSON.stringify(added));
  const task=added.result.mission.tasks[0];const block=await f.plan('updateMissionTask',{vaultId:f.v,missionId:f.m,taskId:task.id,status:'blocked',summary:'Missing fixture dependency'});f.grant(block);assert.equal((await f.apply(block)).result.mission.tasks[0].summary,'Missing fixture dependency');
  const start=await f.plan('startRun',startArgs(f));f.grant(start);const running=await f.apply(start);assert.equal(running.state,'verified',JSON.stringify(running));assert.deepEqual(running.result.item.runIds,[1]);
  const change=await f.plan('updateAgentSettings',{...settingArgs(f),patch:{model:'model-b'}});f.grant(change);const changed=await f.apply(change);assert.equal(changed.result.settings.model,'model-b');assert.equal(changed.result.settings.contextPrompt,'preserve');assert.equal(changed.result.protected.yolo,false);
  const values={...settingArgs(f),missionId:f.m,workItemId:f.w,runId:1};
  for(const [action,fields] of Object.entries(reads)){const r=await f.call({op:'appRead',action,args:Object.fromEntries(fields.map(k=>[k,values[k]]))});assert.equal(r.status,200,action+JSON.stringify(r));}
  const stop=await f.plan('cancelRun',{vaultId:f.v,runId:1});f.grant(stop);f.runs.get(1).summary='stream changed after preview';assert.equal((await f.apply(stop)).result.run.status,'canceled');
  assert.ok(!f.calls.some(c=>/agent-token|\/search|\/agents$/.test(c.path)));
});
test('mission-note editing previews execution settings and refuses unsafe or changed dispatch context', async t => {
  const f = await fixture(t);
  const create = await f.plan('createMission', missionArgs(f)); f.grant(create);
  assert.equal((await f.apply(create)).state, 'verified');
  const args = {vaultId:f.v, missionId:f.m, noteId:'mission-brief-'+f.m, content:'New authorized brief'};
  const n = count(f);
  f.state.yolo = true;
  assert.equal((await f.plan('updateMission', args)).error, 'specific_approval_required');
  f.state.yolo = false;
  const edit = await f.plan('updateMission', args);
  assert.equal(edit.before.executionSettings[0].yolo, false); f.grant(edit);
  f.state.executionModel = 'concurrently-changed';
  assert.equal((await f.apply(edit)).error, 'stale_plan');
  assert.equal(count(f), n);
  assert.equal(f.notes.get(args.noteId).content, 'Synthetic brief');
});
test('consequential actions refuse missing, expired, wrong owner grants and booleans; no network mutation',async t=>{
  const f=await fixture(t);
  for(const [action,args] of [['startRun',startArgs(f)],['createMission',missionArgs(f)],['updateAgentSettings',{...settingArgs(f),patch:{finalReplyOnly:true}}]]){
    const p=await f.plan(action,args);assert.equal((await f.apply(p)).error,'specific_approval_required');
    f.grant(p,{expiresAt:1});assert.equal((await f.apply(p)).error,'specific_approval_required');
    f.grant(p,{ownerId:2});assert.equal((await f.apply(p)).error,'specific_approval_required');
    assert.equal((await f.call({op:'appApply',action,args,requestId:p.requestId,planDigest:p.planDigest,approved:true})).error,'invalid_request');
  }
  assert.equal((await f.plan('updateAgentSettings',{...settingArgs(f),patch:{yolo:true}})).error,'invalid_request');
  assert.equal((await f.plan('startRun',{...startArgs(f),agent:'hermes'})).error,'invalid_request');
  assert.equal((await f.plan('startRun',{...startArgs(f),yolo:true})).error,'invalid_request');
  assert.equal((await f.plan('cancelRun',{vaultId:f.v,runId:'1'})).error,'invalid_id');
  assert.equal(count(f),0);
});
test('unknown creation and run-start never replay across service restart; known run still inspectable',async t=>{
  const f=await fixture(t),p=await f.plan('createWorkItem',taskArgs(f));f.state.lost=true;
  assert.equal((await f.apply(p)).error,'upstream_500');const n=count(f);await f.restart();f.state.lost=false;
  assert.equal((await f.apply(p)).state,'uncertain');assert.equal(count(f),n);
  const s=await f.plan('startRun',startArgs(f));f.grant(s);f.state.lost=true;assert.equal((await f.apply(s)).error,'upstream_500');await f.restart();f.state.lost=false;
  const n2=count(f);assert.equal((await f.apply(s)).state,'uncertain');assert.equal(count(f),n2);assert.equal(f.runs.size,1);
});
test('lost known-target writes reconcile without replay, including separately uncertain link',async t=>{
  const f=await fixture(t),p=await f.plan('updateWorkItem',{vaultId:f.v,workItemId:f.w,patch:{summary:'updated'}});
  f.state.lost=true;assert.equal((await f.apply(p)).error,'upstream_500');f.state.lost=false;const n=count(f);assert.equal((await f.apply(p,'appReconcile')).state,'verified');assert.equal(count(f),n);
  const s=await f.plan('startRun',startArgs(f));f.grant(s);f.state.linkLost=true;assert.equal((await f.apply(s)).error,'upstream_500');f.state.linkLost=false;const n2=count(f);assert.equal((await f.apply(s,'appReconcile')).state,'verified');assert.equal(count(f),n2);
  f.items.get(f.w).runIds=[];
  const unlinked=await f.apply(s,'appReconcile');assert.equal(unlinked.state,'uncertain');assert.equal(unlinked.reason,'run_link_not_verified');assert.equal(unlinked.result.run.id,1);assert.equal(unlinked.replayAllowed,false);assert.equal(count(f),n2);
});
test('stale plans, changed intent, wrong audience/account/resource fail closed',async t=>{
  const f=await fixture(t),p=await f.plan('updateWorkItem',{vaultId:f.v,workItemId:f.w,patch:{title:'new'}});
  f.items.get(f.w).brief='concurrent';assert.equal((await f.apply(p)).error,'stale_plan');
  assert.equal((await f.plan(p.action,{...p.args,patch:{title:'other'}},p.requestId)).error,'idempotency_conflict');
  f.state.shared=true;assert.equal((await f.plan('createWorkItem',taskArgs(f))).error,'specific_approval_required');
  f.state.shared=false;f.state.wrong=true;assert.equal((await f.call({op:'appRead',action:'workItem',args:{vaultId:f.v,workItemId:f.w}})).error,'readback_mismatch');
  f.state.owner=2;assert.equal((await f.plan('createWorkItem',taskArgs(f))).error,'owner_scope_mismatch');assert.equal(count(f),0);
});
test('actual Along CLI parser and durable intent through Node private socket to HTTP', {skip: !process.env.ALONG_FIZZER_CLI}, async t=>{
  const f=await fixture(t), {spawn}=require('node:child_process');
  const code = `import sys\nsys.path.insert(0, sys.argv.pop(1))\nimport app, wiki\nwiki.SOCKET = sys.argv.pop(1)\nclass FixtureLive(wiki.Live):\n def __init__(self): self.last=0\n def preflight(self): pass\napp.AppLive = FixtureLive\nsys.exit(app.main())\n`;
  const cli=argv=>new Promise((resolve,reject)=>{
    const p=spawn('python3',['-c',code,process.env.ALONG_FIZZER_CLI,f.socketPath,...argv],{env:{PATH:process.env.PATH,HOME:f.directory}});let out='',err='';
    p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',n=>n===0?resolve(JSON.parse(out)):reject(new Error(out+err)));
  });
  const intent=path.join(f.directory,'cli-intent.json');
  assert.equal((await cli(['plan','createWorkItem','--request-id','cli-fixture','--intent',intent,'--args',JSON.stringify(taskArgs(f))])).state,'planned');
  const applied=await cli(['apply','--intent',intent]);assert.equal(applied.state,'verified');
  const n=count(f);assert.equal((await cli(['reconcile','--intent',intent])).state,'verified');assert.equal(count(f),n);
  assert.equal((await cli(['read','workItem','--args',JSON.stringify({vaultId:f.v,workItemId:applied.result.item.id})])).item.title,'Synthetic only');
});
