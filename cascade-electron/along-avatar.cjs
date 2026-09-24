'use strict';
// Host-private, immutable owner grants. No grant-creation socket operation exists.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const grant = Object.freeze({ vaultId: '21b2b809-6f53-4e41-9a58-fe30762d3657', channelId: 'b8871984-357a-46b6-b0d8-07f2ee6223d8', vaultAgentId: '26f13c5b-f357-443b-98fe-b5d272a36054', ownerId: 1, agentId: 'hermes', hermesProfile: 'along', messageId: 'msg-1789091231980-k4f82e', body: '@along can you set a profile picture', imageSha256: '9c55c898e17219e063304428f1a6a486709397cb52394bca81d78f39e90aac1b' });
const legacyFields = ['vaultId', 'channelId', 'vaultAgentId', 'imageBase64'];
const fields = [...legacyFields, 'sourceMessageId'];
const fail = code => { throw new Error(code); };
const hash = x => createHash('sha256').update(x).digest('hex');
const exact = (o, keys) => { if (!o || Array.isArray(o) || Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o,k))) fail('invalid_request'); };
const view = a => Object.fromEntries(['id','vaultAgentId','ownerUserId','agentId','hermesProfile','avatarUrl'].map(k => [k,a[k] ?? null]));
function image(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('invalid_avatar_image');
  const b = Buffer.from(encoded,'base64');
  if (b.toString('base64') !== encoded || b.length < 57 || b.length > 65536 || b.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') fail('invalid_avatar_image');
  let p=8, idat=[], kinds=[];
  while(p < b.length) {
    if(p+12>b.length) fail('invalid_avatar_image');
    const n=b.readUInt32BE(p), kind=b.toString('ascii',p+4,p+8); if(p+12+n>b.length) fail('invalid_avatar_image');
    const chunk=b.subarray(p+4,p+8+n); let crc=0xffffffff;
    for(const v of chunk) { crc^=v; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
    if(((crc^0xffffffff)>>>0)!==b.readUInt32BE(p+8+n)) fail('invalid_avatar_image');
    if(!['IHDR','IDAT','IEND'].includes(kind)) fail('invalid_avatar_image');
    if(kind==='IHDR' && (p!==8 || n!==13 || b.readUInt32BE(p+8)!==256 || b.readUInt32BE(p+12)!==256 || b.subarray(p+16,p+21).toString('hex')!=='0802000000')) fail('invalid_avatar_image');
    if(kind==='IDAT') idat.push(b.subarray(p+8,p+8+n));
    if(kind==='IEND' && (n!==0 || p+12!==b.length)) fail('invalid_avatar_image');
    kinds.push(kind); p+=n+12;
  }
  if(kinds[0]!=='IHDR' || kinds.at(-1)!=='IEND' || kinds.filter(x=>x==='IHDR').length!==1 || kinds.filter(x=>x==='IEND').length!==1 || !idat.length) fail('invalid_avatar_image');
  let pixels; try { pixels=zlib.inflateSync(Buffer.concat(idat),{maxOutputLength:256*769}); } catch { fail('invalid_avatar_image'); }
  if(pixels.length!==256*769) fail('invalid_avatar_image');
  for(let i=0;i<256;i++) if(pixels[i*769]>4) fail('invalid_avatar_image');
  return b;
}
function privateJSON(file) {
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const st=fs.fstatSync(fd);
    if(!st.isFile() || st.uid!==process.getuid() || (st.mode&0o777)!==0o600 || st.size>65536) fail('unsafe_grant');
    return JSON.parse(fs.readFileSync(fd,'utf8'));
  } finally { if(fd!==undefined) fs.closeSync(fd); }
}
const receiptKey = (origin,owner,message) => hash(JSON.stringify([origin,owner,message]));
function ownerGrant(input,c) {
  const source=input.args?.sourceMessageId;
  if(source===undefined) {
    // Compatibility is receipt-only: never create another hardcoded legacy intent.
    exact(input.args,legacyFields);
    const file=path.join(c.receiptDir,'avatar-'+receiptKey(c.scope.origin,c.ownerId,input.requestId)+'.json');
    if(input.requestId!==grant.messageId || !fs.existsSync(file)) fail('owner_grant_required');
    return grant;
  }
  exact(input.args,fields);
  if(typeof source!=='string' || !/^[A-Za-z0-9_-]{1,80}$/.test(source) || source!==input.requestId) fail('invalid_request_id');
  const file=path.join(c.receiptDir,'avatar-grant-'+receiptKey(c.scope.origin,c.ownerId,source)+'.json');
  if(!fs.existsSync(file)) fail('owner_grant_required');
  const g=privateJSON(file);
  exact(g,['contract','origin','vaultId','channelId','vaultAgentId','registrationId','ownerId','agentId','hermesProfile','messageId','body','imageSha256']);
  if(g.contract!=='avatar_owner_grant_v1' || g.origin!==c.scope.origin || g.ownerId!==c.ownerId || g.agentId!==c.agentId || g.messageId!==source || typeof g.body!=='string' || g.body.length>16000 || !/^[a-f0-9]{64}$/.test(g.imageSha256) || typeof g.hermesProfile!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(g.hermesProfile)) fail('avatar_authorization_mismatch');
  for(const k of ['vaultId','channelId','vaultAgentId','registrationId']) c.checkId(g[k]);
  // Stable property order across JSON serializers; legacy grant hashing is unchanged.
  return Object.fromEntries(['contract','origin','vaultId','channelId','vaultAgentId','registrationId','ownerId','agentId','hermesProfile','messageId','body','imageSha256'].map(k=>[k,g[k]]));
}
async function avatar(input,c) {
  exact(input,input.op==='appPlan'?['op','action','args','requestId']:['op','action','args','requestId','planDigest']);
  if(!['appPlan','appApply','appReconcile'].includes(input.op) || input.action!=='updateAgentAvatar') fail('invalid_request');
  const grant=ownerGrant(input,c), a=input.args;
  const registrationId=grant.registrationId || '489c84af-917d-4ec7-b22a-61bb5e770b42';
  if(['vaultId','channelId','vaultAgentId'].some(k=>a[k]!==grant[k]) || c.ownerId!==grant.ownerId || c.agentId!==grant.agentId) fail('avatar_authorization_mismatch');
  if(hash(image(a.imageBase64))!==grant.imageSha256) fail('avatar_authorization_mismatch');
  // A single durable grant receipt prevents replay under a new caller request ID.
  if(input.requestId!==grant.messageId) fail('invalid_request_id');
  const base=`/api/vaults/${grant.vaultId}`, channel=`${base}/channels/${grant.channelId}`;
  async function authority() {
    if((await c.browser('/api/me')).user?.id!==grant.ownerId) fail('owner_scope_mismatch');
    const v=await c.browser(base);
    if(v.vault?.id!==grant.vaultId || v.vault.created_by!==grant.ownerId || v.role!=='owner') fail('owner_scope_mismatch');
    const m=(await c.browser(`${channel}/messages/${grant.messageId}`)).message;
    if(m?.id!==grant.messageId || m.channelId!==grant.channelId || m.actorUserId!==grant.ownerId || m.body!==grant.body || m.agentId || m.registrationId) fail('avatar_authorization_mismatch');
    const n=(await c.browser(`/api/notes/${grant.channelId}`)).note;
    if(n?.id!==grant.channelId || n.vault_id!==grant.vaultId || n.content!=='cascade://chat-channel') fail('note_out_of_scope');
    const reg=await lookup();
    return view({...reg,id:grant.vaultAgentId,avatarUrl:reg.identityAvatarUrl});
  }
  async function lookup() {
    // Exact historical handle must still exist: never list, repair, or recreate.
    const r=(await c.browser(`${channel}/agents/${registrationId}?vaultAgentId=${grant.vaultAgentId}&hermesProfile=${grant.hermesProfile}`)).registration;
    if(r?.contract!=='registration_lookup_select_only_v1' || r.id!==registrationId || r.vaultAgentId!==grant.vaultAgentId || r.vaultId!==grant.vaultId || r.localVaultId!==grant.vaultId || r.sourceVaultId!==grant.vaultId || r.localChannelId!==grant.channelId || r.sourceChannelId!==grant.channelId || r.ownerUserId!==grant.ownerId || r.agentId!==grant.agentId || r.hermesProfile!==grant.hermesProfile) fail('avatar_identity_mismatch');
    return r;
  }
  async function registration() { return view(await lookup()); }
  const current=await authority();
  const file=path.join(c.receiptDir,'avatar-'+hash(JSON.stringify([c.scope.origin,grant.ownerId,grant.messageId]))+'.json');
  let r;
  if(fs.existsSync(file)) {
    const st=fs.lstatSync(file); if(!st.isFile() || st.isSymbolicLink() || st.uid!==process.getuid() || (st.mode&0o777)!==0o600) fail('unsafe_receipt');
    try { r=JSON.parse(fs.readFileSync(file,'utf8')); } catch { fail('uncertain_write'); }
    if(r.grantHash!==hash(JSON.stringify(grant))) fail('idempotency_conflict');
    if(input.op!=='appPlan' && input.planDigest!==r.planDigest) fail('stale_plan');
  } else {
    if(input.op!=='appPlan') fail('intent_not_found');
    const reg=await registration();
    const plan={action:input.action,requestId:grant.messageId,origin:c.scope.origin,grant, before:current, registration:reg, projection:'vault-agent and all its channel avatars; publicly renderable asset', registrationDiscovery:'registration_lookup_select_only_v1; exact existing owner/profile-bound registration; no cleanup or materialization'};
    r={grantHash:hash(JSON.stringify(grant)),plan,planDigest:hash(JSON.stringify(plan)),state:'planned'};
    c.durableWrite(file,r,true);
  }
  if(input.op==='appPlan') return {...r.plan,planDigest:r.planDigest,state:r.state};
  async function verify() {
    const agent=await authority();
    if(!new RegExp('^/api/notes/agent-avatars/assets/'+grant.vaultAgentId+'-[0-9]+$').test(agent.avatarUrl || '')) fail('readback_mismatch');
    if(r.assetUrl && r.assetUrl!==agent.avatarUrl) fail('readback_mismatch');
    const bytes=await c.avatarAsset(agent.avatarUrl,grant.vaultAgentId);
    if(hash(bytes)!==grant.imageSha256) fail('readback_mismatch');
    const reg=await registration();
    if(reg.id!==r.plan.registration.id || reg.avatarUrl!==agent.avatarUrl) fail('readback_mismatch');
    r.state='verified'; r.assetUrl=agent.avatarUrl; c.durableWrite(file,r);
    return {state:'verified',planDigest:r.planDigest,registration:reg,identity:agent,assetUrl:r.assetUrl,assetSha256:grant.imageSha256,noteId:'agent-avatars',replayed:false};
  }
  if(r.state!=='planned') {
    try { return await verify(); } catch(e) { if(e.message==='readback_mismatch') return {state:'uncertain',replayAllowed:false}; throw e; }
  }
  if(input.op==='appReconcile') return {state:'planned',applied:false};
  if(JSON.stringify(current)!==JSON.stringify(r.plan.before) || JSON.stringify(await registration())!==JSON.stringify(r.plan.registration)) fail('stale_plan');
  r.state='uncertain'; c.durableWrite(file,r);
  const response=await c.browser(`${channel}/agents/${r.plan.registration.id}/avatar`,'PUT',{avatarUrl:'data:image/png;base64,'+a.imageBase64});
  const reg=response.registration;
  if(!reg || reg.id!==r.plan.registration.id || reg.vaultAgentId!==grant.vaultAgentId || reg.ownerUserId!==grant.ownerId || reg.agentId!==grant.agentId || reg.hermesProfile!==grant.hermesProfile) fail('readback_mismatch');
  r.assetUrl=reg.avatarUrl; c.durableWrite(file,r);
  return verify();
}
module.exports={avatar,grant,fields,image,receiptKey};
