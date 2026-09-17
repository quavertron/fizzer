// Controlled real ChatView composition. Public replay only; all API calls intercepted.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
const replay = JSON.parse(await readFile(new URL('./fixtures/mission-preview-public-replay.json', import.meta.url)));
const output = process.env.EVIDENCE_DIR || '/tmp/mission-preview-evidence';
const before = process.env.EXPECT_BEFORE === '1';
const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatView} from '/src/components/ChatView.tsx';
import {chatMessageStore} from '/src/chat/messageStore.ts';
import {applyRemoteChatMessage,captureChatMessageSnapshotBaseline,reconcileChatMessageSnapshot} from '/src/chat/runBlocks.ts';
import '/src/index.css';
const replay=${JSON.stringify(replay)};
const noop=()=>{};
const mission={id:replay.missionId,rootMessageId:'msg-1789641872208-9thexw',title:'Quick mission UX test',objective:'Controlled replay',status:'active',coordinator:'Astra',coordinatorMention:'astra',coordinatorRegistrationId:'exact-coordinator',summary:'',createdAt:'',updatedAt:'',tasks:[{id:replay.taskId,title:'Inspect toolbar',status:'running',runId:4244,assignee:'Astra',summary:'',dependsOn:[],waitingFor:[]}]};
const human={id:mission.rootMessageId,channelId:'fixture',author:'Human',body:'CONTROLLED HUMAN REQUEST',createdAt:'2026-09-17T10:00:00Z',seq:1,mission};
const worker={id:replay.messageId,channelId:'fixture',author:'Astra',agentId:'codex',registrationId:'worker-registration',missionTaskId:replay.taskId,runId:4244,body:'',status:'running',createdAt:'2026-09-17T10:00:02Z',seq:3};
const coordinator={id:'coordinator-4243',channelId:'fixture',author:'Astra',agentId:'codex',runId:4243,body:'Separate coordinator answer',createdAt:'2026-09-17T10:00:01Z',seq:2};
window.mission=mission;
window.replay=(limit=27)=>{
 chatMessageStore.set('fixture',[human,coordinator]);
 let body='',status='running';
 for(const event of replay.events.filter(e=>e.seq<=limit)){
  if(event.type==='text') body+=(event.payload.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  if(event.type==='status'){status=event.payload.status;if(event.payload.summary) body=event.payload.summary;}
  const row={...worker,body,status:status==='completed'?undefined:status};
  // Increasing projections and repeated delivery of each same snapshot.
  chatMessageStore.update('fixture',rows=>applyRemoteChatMessage(applyRemoteChatMessage(rows,row),row));
 }
 const rows=chatMessageStore.getChannel('fixture');
 chatMessageStore.set('fixture',reconcileChatMessageSnapshot(rows,rows,captureChatMessageSnapshotBaseline(rows)));
 return {body,rows:chatMessageStore.getChannel('fixture')};
};
window.sameAnswer=()=>chatMessageStore.update('fixture',rows=>applyRemoteChatMessage(rows,{...coordinator,id:'independent-identical',runId:5000,body:rows.find(r=>r.id===worker.id).body}));
const root=createRoot(document.getElementById('root'));
window.mount=(channelId='fixture',channelName='new-channel')=>root.render(React.createElement(ChatView,{vaultId:'fixture-vault',channelId,channelName,currentUser:'Human',presence:{participants:[],online:[]},availableAgents:[],registeredAgents:[],sidebarMode:'hidden',onRegisterAgent:noop,onRemoveAgent:noop,onInviteUser:async()=>{},onSendMessage:noop,onCancelRun:noop}));
window.replay();window.mount();
</script><style>html,body,#root{height:100%;margin:0}#root{display:flex;overflow:hidden}</style>`;
const server=await createServer({root:new URL('../client',import.meta.url).pathname,server:{host:'127.0.0.1',port:await pickPort()},plugins:[{name:'mission-preview-fixture',configureServer(s){s.middlewares.use('/fixture.html',async(_,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/fixture.html',html));});}}]});
let browser;
try{
 await mkdir(output,{recursive:true});await server.listen();browser=await chromium.launch({headless:true});
 for(const [name,width,paneWidth] of [['desktop',1280,1280],['narrow',390,390],['split',1280,420]]){
  const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);
  const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',async route=>{
   const req=route.request();
   if(req.method()!=='GET') writes.push({path:new URL(req.url()).pathname,body:req.postDataJSON()});
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messages:[],hasMore:false,beforeSeq:null,settings:{cwd:""},events:[]})});
  });
  await page.goto(server.resolvedUrls.local[0]+'fixture.html');
  await page.locator('.chat-mission-card').waitFor();
  await page.locator('#root').evaluate((el,w)=>{el.style.width=w+'px'},paneWidth);
  const card=page.locator('.chat-messages .chat-mission-card');
  const sentence=await page.evaluate(()=>window.replay().body.trim().slice(0,60));
  await page.waitForTimeout(100);
  const occurrences=(await card.innerText()).split(sentence).length-1;
  assert.equal(occurrences,before?2:1,name+': visible live sentence count');
  assert.equal(await page.getByText('CONTROLLED HUMAN REQUEST',{exact:true}).count(),1);
  assert.equal(await page.getByText('Separate coordinator answer',{exact:true}).count(),1);
  const collapsedBackground=await card.evaluate(el=>getComputedStyle(el).backgroundImage);
  assert.equal(collapsedBackground==='none',before,name+': collapsed background');
  await page.screenshot({path:output+'/'+(before?'before':'after')+'-'+name+'.png'});
  await card.locator('.chat-mission-toggle').click();
  assert.equal(await card.locator('.chat-work-trace-body').count(),1);
  const expandedBackground=await card.evaluate(el=>getComputedStyle(el).backgroundImage);
  assert.notEqual(expandedBackground,'none');
  if(!before) assert.equal(collapsedBackground,expandedBackground);
  await page.screenshot({path:output+'/'+(before?'before':'after')+'-'+name+'-expanded.png'});
  assert.equal((await card.innerText()).split(sentence).length-1,1);
  await card.locator('.chat-mission-toggle').click();
  await card.locator('.chat-mission-stop').click();
  assert.deepEqual(writes,[{path:'/api/vaults/fixture-vault/channels/fixture/missions/'+replay.missionId+'/finish',body:{coordinatorRegistrationId:'exact-coordinator',status:'canceled',summary:'Stopped by user.'}}]);
  const result=await page.evaluate(()=>window.replay(144));
  assert.equal(result.rows.filter(r=>r.id===replay.messageId).length,1);
  assert.equal(result.rows.find(r=>r.id===replay.messageId).body,replay.events.at(-1).payload.summary);
  await page.evaluate(()=>window.sameAnswer());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('Completed and recorded task evidence.',{exact:true}).count(),2,'independent identical final answers retained');
  assert.equal(await page.getByText(/Cannot read properties/).count(),0);
  assert.deepEqual(errors,[]);console.log('PASS '+name+': replay, identities, expansion, exact Stop; '+(before?'baseline has duplicate preview and missing collapsed background':'single preview and persistent collapsed/expanded background'));
  await page.close();
 }
}finally{await browser?.close();await server.close();}
