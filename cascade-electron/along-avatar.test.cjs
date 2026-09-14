'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), http=require('node:http');
const {randomUUID}=require('node:crypto');
const {startExternalAgentAccess,request}=require('./external-agent-access.cjs');
const {grant:legacy,image,receiptKey}=require('./along-avatar.cjs');
const png=fs.readFileSync('/home/jt/projects/along/fizzer/along-avatar-refinement-256.png');
const g={...legacy,messageId:'msg-new-owner-source',body:'how bout something more tasteful',imageSha256:require('node:crypto').createHash('sha256').update(png).digest('hex')};
async function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'avatar-control-')); fs.chmodSync(directory,0o700);
 const state={writes:0,lost:false,badAsset:false,owner:1,profile:'along',message:g.body,extra:false};
 const identity={id:g.vaultAgentId,vaultId:g.vaultId,ownerUserId:1,agentId:'hermes',hermesProfile:'along',channelIds:[g.channelId],avatarUrl:''};
 const reg={id:'489c84af-917d-4ec7-b22a-61bb5e770b42',vaultAgentId:g.vaultAgentId,ownerUserId:1,agentId:'hermes',hermesProfile:'along',avatarUrl:'',vaultId:g.vaultId,localVaultId:g.vaultId,sourceVaultId:g.vaultId,localChannelId:g.channelId,sourceChannelId:g.channelId,contract:'registration_lookup_select_only_v1'};
 const calls=[];
 const upstream=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;
  calls.push([req.method,req.url]);assert.equal(req.headers.authorization,undefined);assert.equal(req.headers['x-cascade-browser'],'1');
  const send=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  const base='/api/vaults/'+g.vaultId, ch=base+'/channels/'+g.channelId;
  identity.hermesProfile=state.profile;
  if(req.url==='/api/me')return send({user:{id:state.owner}});
  if(req.url===base)return send({vault:{id:g.vaultId,created_by:1,visibility:'private'},role:'owner'});
  if(req.url.includes('/vault-agents') || req.url===ch+'/agents') { assert.fail('cleanup/materializing GET forbidden'); }
  if(req.url===ch+'/agents/489c84af-917d-4ec7-b22a-61bb5e770b42?vaultAgentId='+g.vaultAgentId+'&hermesProfile=along')return send({registration:{...reg,hermesProfile:state.profile==='along'?reg.hermesProfile:state.profile,identityAvatarUrl:identity.avatarUrl}},state.absent?404:200);
  if(req.url==='/api/notes/'+g.channelId)return send({note:{id:g.channelId,vault_id:g.vaultId,content:'cascade://chat-channel'}});
  if(req.url===base+'/notes')return send({notes:[{id:g.channelId,vault_id:g.vaultId}]});
  if(req.url===ch+'/messages/'+g.messageId)return send({message:{id:g.messageId,channelId:g.channelId,actorUserId:1,body:state.message}});

  if(req.url===ch+'/agents/'+reg.id+'/avatar'){
   assert.equal(req.method,'PUT');const b=JSON.parse(raw);assert.deepEqual(Object.keys(b),['avatarUrl']);assert.equal(b.avatarUrl,'data:image/png;base64,'+png.toString('base64'));
   state.writes++;identity.avatarUrl=reg.avatarUrl='/api/notes/agent-avatars/assets/'+g.vaultAgentId+'-123';
   return send(state.lost?{}:{registration:reg},state.lost?500:200);
  }
  if(req.url.startsWith('/api/notes/agent-avatars/assets/')){res.writeHead(200,{'content-type':'image/png'});return res.end(state.badAsset?Buffer.from('bad'):png);}
  send({},404);
 });
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const options={enabled:true,directory,origin:'http://127.0.0.1:'+upstream.address().port,vaultId:g.vaultId,ownerId:1,agentId:'hermes',author:'Along (AI agent)',browserFetch:fetch,agentFetch:fetch,allowFixtureHTTP:true};
 let service=await startExternalAgentAccess(options);
 const grantFile=path.join(directory,'receipts','avatar-grant-'+receiptKey(options.origin,1,g.messageId)+'.json');
 const localGrant={...g,contract:'avatar_owner_grant_v1',origin:options.origin,registrationId:reg.id};
 fs.writeFileSync(grantFile,JSON.stringify(localGrant),{mode:0o600});
 t.after(async()=>{await service.close();await new Promise(r=>upstream.close(r));fs.rmSync(directory,{recursive:true});});
 const payload={op:'appPlan',action:'updateAgentAvatar',requestId:g.messageId,args:{vaultId:g.vaultId,channelId:g.channelId,vaultAgentId:g.vaultAgentId,imageBase64:png.toString('base64'),sourceMessageId:g.messageId}};
 return{state,reg,calls,payload,grantFile,localGrant,directory,options,call:p=>request(service.socketPath,p),restart:async()=>{await service.close();service=await startExternalAgentAccess(options);}};
}
test('PNG strict shape, bounds, canonical encoding and exact authorized asset',()=>{
 assert.equal(image(png.toString('base64')).length,png.length);
 for(const b of [Buffer.from('no'),Buffer.alloc(70000),Buffer.concat([png,Buffer.from('x')])])assert.throws(()=>image(b.toString('base64')));
 const wrong=Buffer.from(png);wrong.writeUInt32BE(128,16);assert.throws(()=>image(wrong.toString('base64')));
});
test('socket exact identity/owner/profile and authenticated explicit message; no generic approval or materialization',async t=>{
 const f=await fixture(t);
 for(const [k,v,e] of [['owner',2,'owner_scope_mismatch'],['profile','other','avatar_identity_mismatch'],['message','approved:true','avatar_authorization_mismatch'],['absent',true,'upstream_404']]){
  const old=f.state[k];f.state[k]=v;assert.equal((await f.call(f.payload)).error,e);f.state[k]=old;
 }
 assert.equal((await f.call({...f.payload,args:{...f.payload.args,approved:true}})).error,'invalid_request');
 assert.equal((await f.call({...f.payload,args:{...f.payload.args,vaultAgentId:randomUUID()}})).error,'avatar_authorization_mismatch');
 assert.equal((await f.call({...f.payload,requestId:'retry-different'})).error,'invalid_request_id');
 f.reg.hermesProfile='wrong';assert.equal((await f.call(f.payload)).error,'avatar_identity_mismatch');
 assert.equal(f.state.writes,0);
});
test('actual socket PNG PUT CSRF response registration identity asset hash and durable no replay',async t=>{
 const f=await fixture(t); f.state.extra=true; const p=await f.call(f.payload);assert.equal(p.state,'planned');
 const apply={...f.payload,op:'appApply',planDigest:p.planDigest};
 const result=await f.call(apply);assert.equal(result.state,'verified');assert.equal(result.assetSha256,g.imageSha256);assert.equal(result.noteId,'agent-avatars');
 await f.restart();assert.equal((await f.call(apply)).state,'verified');assert.equal(f.state.writes,1);
 f.state.badAsset=true;assert.equal((await f.call({...apply,op:'appReconcile'})).state,'uncertain');assert.equal(f.state.writes,1);
});
test('private grant required; arbitrary owner body is not authority; wrong hash/channel/owner/origin and unsafe grant refuse',async t=>{
 const f=await fixture(t);
 fs.unlinkSync(f.grantFile);
 assert.equal((await f.call(f.payload)).error,'owner_grant_required');
 assert.ok((await f.call({op:'grantAvatar',approved:true})).error);
 for(const delta of [{ownerId:2},{channelId:randomUUID()},{origin:'https://wrong.invalid'},{imageSha256:'0'.repeat(64)},{registrationId:randomUUID()},{hermesProfile:'other'}]) {
  fs.writeFileSync(f.grantFile,JSON.stringify({...f.localGrant,...delta}),{mode:0o600});
  assert.ok((await f.call(f.payload)).error);
 }
 fs.writeFileSync(f.grantFile,JSON.stringify(f.localGrant)); fs.chmodSync(f.grantFile,0o644);
 assert.equal((await f.call(f.payload)).error,'unsafe_grant');
 assert.equal(f.state.writes,0);
});
test('stale plan and changed source grant cannot replace an existing intent',async t=>{
 const f=await fixture(t),p=await f.call(f.payload);
 f.reg.avatarUrl='/changed';
 assert.equal((await f.call({...f.payload,op:'appApply',planDigest:p.planDigest})).error,'stale_plan');
 f.reg.avatarUrl='';
 f.state.message='another owner request';
 fs.writeFileSync(f.grantFile,JSON.stringify({...f.localGrant,body:f.state.message}));
 assert.equal((await f.call(f.payload)).error,'idempotency_conflict');
 assert.equal(f.state.writes,0);
});
test('forged asset URL and mismatched registration projection never verify',async t=>{
 const f=await fixture(t),p=await f.call(f.payload),a={...f.payload,op:'appApply',planDigest:p.planDigest};
 assert.equal((await f.call(a)).state,'verified');
 f.reg.avatarUrl='https://evil.invalid/asset';
 assert.equal((await f.call({...a,op:'appReconcile'})).state,'uncertain');
 f.state.absent=true;
 assert.equal((await f.call(a)).error,'upstream_404');
 assert.equal(f.state.writes,1);
});
test('legacy receipt retains digest and uncertain intent without replay or grant migration',async t=>{
 const f=await fixture(t),{avatar}=require('./along-avatar.cjs');
 const oldPNG=fs.readFileSync('/home/jt/projects/along/fizzer/along-avatar.png');
 const digest=x=>require('node:crypto').createHash('sha256').update(JSON.stringify(x)).digest('hex');
 const asset='/api/notes/agent-avatars/assets/'+legacy.vaultAgentId+'-123';
 const file=path.join(f.directory,'receipts','avatar-'+receiptKey(f.options.origin,1,legacy.messageId)+'.json');
 const receipt={grantHash:digest(legacy),planDigest:'old-stable-digest',plan:{registration:{id:f.reg.id}},state:'uncertain'};
 fs.writeFileSync(file,JSON.stringify(receipt),{mode:0o600});
 const c={receiptDir:path.dirname(file),scope:{origin:f.options.origin},ownerId:1,agentId:'hermes',avatarAsset:async()=>oldPNG,durableWrite:(file,r)=>fs.writeFileSync(file,JSON.stringify(r)),browser:async(route,method)=>{
  assert.ok(!method || method==='GET');
  if(route==='/api/me')return {user:{id:1}};
  if(route.endsWith('/messages/'+legacy.messageId))return {message:{id:legacy.messageId,channelId:legacy.channelId,actorUserId:1,body:legacy.body}};
  if(route.startsWith('/api/notes/'))return {note:{id:legacy.channelId,vault_id:legacy.vaultId,content:'cascade://chat-channel'}};
  if(route.includes('/agents/'))return {registration:{...f.reg,avatarUrl:asset,identityAvatarUrl:asset}};
  return {vault:{id:legacy.vaultId,created_by:1},role:'owner'};
 }};
 const a={op:'appApply',action:'updateAgentAvatar',requestId:legacy.messageId,planDigest:receipt.planDigest,args:{vaultId:legacy.vaultId,channelId:legacy.channelId,vaultAgentId:legacy.vaultAgentId,imageBase64:oldPNG.toString('base64')}};
 assert.equal((await avatar(a,c)).state,'verified');
 const after=JSON.parse(fs.readFileSync(file));assert.equal(after.planDigest,receipt.planDigest);assert.deepEqual(after.plan,receipt.plan);assert.equal(after.grantHash,receipt.grantHash);
 fs.unlinkSync(file);await assert.rejects(()=>avatar({...a,op:'appPlan',planDigest:undefined},c));
});
test('lost response persists unknown across restart; reconcile reads never repeat PUT',async t=>{
 const f=await fixture(t),p=await f.call(f.payload),apply={...f.payload,op:'appApply',planDigest:p.planDigest};
 f.state.lost=true;assert.equal((await f.call(apply)).error,'upstream_500');
 await f.restart();f.state.badAsset=true;assert.equal((await f.call(apply)).state,'uncertain');assert.equal(f.state.writes,1);
 f.state.badAsset=false;assert.equal((await f.call({...apply,op:'appReconcile'})).state,'verified');assert.equal(f.state.writes,1);
});
