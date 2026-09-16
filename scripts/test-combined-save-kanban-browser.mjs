import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({configFile:false,root:path.resolve('client'),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
await server.listen();
const browser=await chromium.launch({headless:true,args:['--mute-audio']});
const evidence={fixture:'Combined exact candidates, real App Kanban; controlled API, separate backend proof',writes:[],checks:[],errors:[]};
let fail=false, slow=false, releases=[], failureStatus=500, networkFailure=false, role='owner';
const notes=Object.fromEntries(['a','b'].map(id=>[id,{id,title:`Fixture ${id}`,content:`Original ${id}`,content_preview:`Original ${id}`,revision:'note-v1:1',vault_id:'v0',folder_id:null,tags:[],position:0,is_listed:1,updated_at:'2026-09-16T00:00:00Z'}]));
try {
 const page=await browser.newPage();
 page.on('pageerror',e=>evidence.errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname;
  if(u.origin!==new URL(server.resolvedUrls.local[0]).origin || p.includes('socket.io'))return route.abort();
  if(p==='/src/socket.ts')return route.fulfill({contentType:'application/javascript',body:`
    export function connectVaultSocket(){
      const handlers=new Map();
      const socket={connected:true,active:true,on(event,fn){const list=handlers.get(event)||[];list.push(fn);handlers.set(event,list);return socket;},off(event,fn){handlers.set(event,(handlers.get(event)||[]).filter(f=>f!==fn));return socket;},emit(){return socket;},disconnect(){handlers.clear();},connect(){return socket;},receive(event,data){for(const fn of handlers.get(event)||[])fn(data);}};
      (window.__fixtureSockets??=[]).push(socket);return socket;
    }
    export const connectRunsSocket=connectVaultSocket;
  `});
  if(!p.startsWith('/api/'))return route.continue();
  let data={},status=200;
  const user={id:1,username:'fixture',displayName:'Fixture'};
  if(p==='/api/session')data={authenticated:true,user,owner:false};
  else if(p==='/api/vaults')data={vaults:[{id:'v0',name:'Fixture',role}]};
  else if(p.endsWith('/folders'))data={folders:[]};
  else if(p==='/api/vaults/v0/notes')data={notes:Object.values(notes)};
  else if(/^\/api\/notes\/[ab]$/.test(p)){
   const id=p.split('/').pop();
   if(req.method()==='PUT'){
    const body=req.postDataJSON(); const write={id,...body}; evidence.writes.push(write);
    if(slow)await new Promise(r=>releases.push(r));
    if(networkFailure){write.status='network';return route.abort('failed');}
    if(fail){status=failureStatus;data={error:'fixture failure'};}
    else if(body.expectedRevision!==notes[id].revision){status=409;data={error:'revision_conflict',note:notes[id]};}
    else {notes[id]={...notes[id],content:body.content,content_preview:body.content.replace(/\s+/g,' '),revision:`note-v1:${Number(notes[id].revision.split(':')[1])+1}`};data={note:notes[id]};}
   write.status=status;
   }else data={note:notes[id]};
  }
  else if(p.endsWith('/members'))data={members:[{...user,userId:1,role:'owner'}],role:'owner'};
  else if(p.endsWith('/agents')||p.endsWith('/vault-agents'))data={agents:[]};
  else if(p.includes('/community/updates'))data={updates:[],counts:{byVault:{},byTarget:{},total:0}};
  await route.fulfill({status,json:data});
 });

 const initial='---\nkanban-plugin: board\nsuperkanban: true\n---\n## Queue\n- [ ] First\n- [ ] Second\n\n## Accepted\n- [ ] Existing\n';
 const reset=()=>{notes.a={...notes.a,content:initial,content_preview:initial.replace(/\s+/g,' '),revision:'note-v1:1'};};reset();
 await page.goto(`${server.resolvedUrls.local[0]}app.html`);
 const board=page.locator('#editor-kanban, .note-editor .kanban-view').first();
 const localBoard=page.locator('.kanban-view').filter({has:page.getByRole('button',{name:'More options for Accepted'})}).first();
 const lane=name=>localBoard.locator('.kanban-column').filter({has:page.locator('header strong',{hasText:new RegExp(`^${name}$`)})});
 const card=name=>localBoard.locator('.kanban-card').filter({hasText:name});
 const waitFor=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await page.waitForTimeout(25);}throw Error('Timed out');};
 async function flag(){await localBoard.getByRole('button',{name:'More options for Accepted'}).click();await localBoard.getByRole('menuitemcheckbox',{name:'Complete cards on entry'}).click();}
 async function drag(){await card('First').dragTo(lane('Accepted').locator('header'));}
 const status=()=>page.locator('#editor-status-bar').innerText();
 await localBoard.waitFor();
 // Keep aggregate tab open before local writes; return to already-open board.
 await page.getByRole('button',{name:'New tab',exact:true}).click({button:'right'});await page.getByText('Superkanban',{exact:true}).click();
 await page.getByLabel('Superkanban',{exact:true}).waitFor();
 await page.locator('#note-a').click();await localBoard.waitFor();
 slow=true;await flag();await drag();await page.keyboard.press('Control+s');await waitFor(()=>releases.length===1);
 assert.match(evidence.writes.at(-1).content,/fizzer:complete-on-entry/);
 assert.match(evidence.writes.at(-1).content,/\[x\] First/);
 assert.equal(notes.a.content,initial);assert.match(await status(),/Saving/i);
 slow=false;releases.forEach(r=>r());releases=[];await waitFor(()=>notes.a.content.includes('[x] First'));await page.waitForTimeout(200);
 assert.equal(await page.locator('#search-overlay').count(),0);
 // Existing aggregate receives acknowledgement without closing/reopening it.
 await page.locator('.tab-item').filter({hasText:'Superkanban'}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('.superkanban-view .kanban-card.is-complete')].some(e=>e.textContent.includes('First')));
 evidence.checks.push('Actual App category flag + drag + Ctrl-S persists whole board; already-open Superkanban updates only after acknowledgement');
 await page.locator('#note-a').click();await page.reload();await localBoard.waitFor();
 assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),1);
 await localBoard.getByRole('button',{name:'More options for Accepted'}).click();assert.equal(await localBoard.getByRole('menuitemcheckbox').getAttribute('aria-checked'),'true');await page.keyboard.press('Escape');
 await card('Second').dragTo(lane('Accepted').locator('header'));await waitFor(()=>notes.a.content.includes('[x] Second'));await page.reload();await localBoard.waitFor();assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),2);
 evidence.checks.push('Category flag and checked destination survive hard reload; next drag autosaves and reloads');
 for(const failure of [403,409,'network']){
  fail=false;networkFailure=false;reset();await page.reload();await localBoard.waitFor();
  fail=failure!=='network';failureStatus=failure;networkFailure=failure==='network';
  await flag();await drag();await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status===failure);
  await page.waitForTimeout(150);assert.equal(notes.a.content,initial);assert.match(await status(),failure===409?/Conflict/i:/Save failed/i);assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),1);
  const count=evidence.writes.length;await page.waitForTimeout(1000);assert.equal(evidence.writes.length,count);
  await page.locator('#note-b').click();await page.locator('#note-a').click();await localBoard.waitFor();assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),1);
  fail=false;networkFailure=false;await page.keyboard.press('Control+s');
  if(failure==='network'){await waitFor(()=>notes.a.content.includes('[x] First'));await page.reload();await localBoard.waitFor();assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),1);}
  else {await page.waitForTimeout(150);assert.equal(evidence.writes.length,count);assert.equal(notes.a.content,initial);}
  evidence.checks.push(`${failure}: whole flagged/moved/checked draft retained through navigation; no false saved or loop; ${failure==='network'?'explicit retry and reload pass':'blocked retry, no overwrite'}`);
 }
 assert.deepEqual(evidence.errors,[]);
 fs.writeFileSync(process.env.REVIEW_EVIDENCE,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();await server.close();}
