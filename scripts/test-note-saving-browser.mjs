import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({configFile:false,root:path.resolve('client'),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
await server.listen();
const browser=await chromium.launch({headless:true,args:['--mute-audio']});
const evidence={fixture:'real App and CodeMirror; in-memory API, no disk persistence claim',writes:[],checks:[],errors:[]};
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
 await page.goto(`${server.resolvedUrls.local[0]}app.html`);
 const editor=page.locator('.cm-content:visible');
 await editor.waitFor();
 async function edit(text){await editor.fill(text);}
 const waitFor = async predicate => { for(let i=0;i<150;i++){if(predicate())return;await page.waitForTimeout(20);}throw Error('Timed out'); };
 await edit('Manual'); await page.keyboard.press('Control+s');await page.waitForTimeout(100);
 assert.equal(evidence.writes.length,1,'Ctrl-S must submit one immediate PUT');
 assert.equal(await page.locator('#search-overlay').count(),0,'Ctrl-S must not open workspace search');
 await waitFor(()=>notes.a.content==='Manual');
 assert.equal(evidence.writes.length,1);assert.equal(await page.locator('#search-overlay').count(),0);
 evidence.checks.push('Ctrl-S sends exactly one revision-aware PUT and never opens search');
 await edit('Command');await page.keyboard.press('Meta+s');await waitFor(()=>notes.a.content==='Command');
 assert.equal(evidence.writes.length,2);assert.equal(await page.locator('#search-overlay').count(),0);
 await page.reload();await editor.waitFor();assert.equal(await editor.innerText(),'Command');
 evidence.checks.push('Cmd-S sends one PUT; reload restores acknowledged content from controlled API');
 await edit('Burst one');await edit('Autosaved');await page.waitForTimeout(1100);
 assert.equal(notes.a.content,'Autosaved');assert.equal(evidence.writes.length,3);
 evidence.checks.push('Burst edits debounce to one PUT');
 await page.keyboard.press('Control+Shift+f');await page.locator('#search-overlay').waitFor();await page.keyboard.press('Escape');
 evidence.checks.push('Search shortcut remains functional');
 slow=true;await edit('Submitted');await page.keyboard.press('Control+s');
 await waitFor(()=>releases.length===1);await edit('Newer while pending');
 assert.match(await page.locator('#editor-status-bar').innerText(),/Saving/i);
 await page.locator('#note-b').click();await page.waitForTimeout(100);
 await page.locator('#note-a').click();await page.waitForTimeout(100);
 assert.equal(await editor.innerText(),'Newer while pending');
 slow=false;releases.forEach(r=>r());releases=[];await waitFor(()=>notes.a.content==='Newer while pending');
 assert.equal(evidence.writes.length,5);assert.equal(evidence.writes[4].expectedRevision,'note-v1:5');
 evidence.checks.push('Slow save preserves newer draft through navigation, coalesces follow-up with acknowledged revision');
 fail=true;await edit('Failure retained');await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status===500);
 await page.waitForTimeout(100);assert.match(await page.locator('#editor-status-bar').innerText(),/Save failed/i);
 const count=evidence.writes.length;await page.waitForTimeout(1200);assert.equal(evidence.writes.length,count);
 await page.locator('#note-b').click();await page.locator('#note-a').click();await page.waitForTimeout(100);
 assert.equal(await editor.innerText(),'Failure retained');
 fail=false;await editor.click();await page.keyboard.press('Control+s');await waitFor(()=>notes.a.content==='Failure retained');
 evidence.checks.push('500 retains draft and error through navigation, no automatic retries; Ctrl-S retries successfully');
 await edit('Closed draft');await page.keyboard.press('Control+w');await page.locator('#note-a').click();await editor.waitFor();
 assert.equal(await editor.innerText(),'Closed draft');await waitFor(()=>notes.a.content==='Closed draft');
 evidence.checks.push('Close and reopen retains pending draft and autosave');
 notes.a={...notes.a,content:'External write',revision:'note-v1:99'};
 await edit('Conflicted draft');await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status===409);
 await page.waitForTimeout(100);assert.match(await page.locator('#editor-status-bar').innerText(),/Conflict/i);
 const conflictCount=evidence.writes.length;await editor.click();await page.keyboard.press('Control+s');await page.waitForTimeout(1000);
 assert.equal(evidence.writes.length,conflictCount);assert.equal(await editor.innerText(),'Conflicted draft');assert.equal(notes.a.content,'External write');
 const protectedUnload=await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});assert.equal(protectedUnload,true);
 evidence.checks.push('Conflict preserves draft, refuses blind retry and protects unresolved unload');
 // Separate page loads create independent main/popout hosts with the same controlled backend.
 await page.goto(`${server.resolvedUrls.local[0]}app.html#popout=${encodeURIComponent(JSON.stringify({id:'b',type:'note',title:'Fixture b',dirty:false}))}`);await page.reload();
 await editor.waitFor();await edit('Popout immediate');const beforePopout=evidence.writes.length;
 await page.keyboard.press('Control+s');await waitFor(()=>notes.b.content==='Popout immediate');
 assert.equal(evidence.writes.length,beforePopout+1);
 slow=true;await edit('Popout submitted');await page.keyboard.press('Meta+s');await waitFor(()=>releases.length===1);
 await edit('Popout newer');slow=false;releases.forEach(r=>r());releases=[];await waitFor(()=>notes.b.content==='Popout newer');
 networkFailure=true;await edit('Popout network draft');await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status==='network');
 await page.waitForTimeout(100);assert.match(await page.locator('#editor-status-bar').innerText(),/Save failed/i);
 assert.equal(await editor.innerText(),'Popout network draft');networkFailure=false;
 await page.keyboard.press('Control+s');await waitFor(()=>notes.b.content==='Popout network draft');
 await edit('Popout autosave');await waitFor(()=>notes.b.content==='Popout autosave');await page.reload();await editor.waitFor();
 assert.equal(await editor.innerText(),'Popout autosave');
 evidence.checks.push('Real PopoutApp uses same revision-aware shortcut, coalescing, autosave, network retry and reload contract');
 await page.goto(`${server.resolvedUrls.local[0]}app.html`);await page.reload();await editor.waitFor();
 fail=true;failureStatus=403;await edit('Denied draft');await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status===403);
 await page.waitForTimeout(100);assert.match(await page.locator('#editor-status-bar').innerText(),/Save failed/i);
 const deniedCount=evidence.writes.length;await page.waitForTimeout(1000);assert.equal(evidence.writes.length,deniedCount);assert.equal(await editor.innerText(),'Denied draft');
 evidence.checks.push('Real App 403 retains visible dirty draft and failure without retry loop');
 fail=false;role='viewer';await page.reload();await editor.waitFor();
 assert.equal(await editor.getAttribute('contenteditable'),'false');
 evidence.checks.push('Viewer editor is read only');
 role='owner';
 const board='---\nkanban-plugin: board\nsuperkanban: true\n---\n## Todo\n- [ ] Aggregate card\n';
 notes.b={...notes.b,content:board,content_preview:board.replace(/\s+/g,' ')};
 await page.reload();await editor.waitFor();
 await page.getByRole('button',{name:'New tab',exact:true}).click({button:'right'});await page.getByText('Superkanban',{exact:true}).click();
 const aggregate=page.getByLabel('Superkanban',{exact:true});await aggregate.waitFor();
 const card=aggregate.locator('.kanban-card').filter({hasText:'Aggregate card'});await card.waitFor();
 assert.equal(await card.evaluate(el=>el.classList.contains('is-complete')),false);
 notes.b={...notes.b,content:board.replace('[ ]','[x]'),revision:'note-v1:100'};
 await page.evaluate(()=>window.__fixtureSockets.forEach(s=>s.receive('vault:noteChanged',{vaultId:'v0',noteId:'b'})));
 await page.waitForFunction(()=>document.querySelector('.superkanban-view .kanban-card.is-complete'));
 evidence.checks.push('Real App noteChanged refreshes already-loaded Superkanban from committed body (controlled socket event/API)');
 assert.deepEqual(evidence.errors,[]);
 fs.writeFileSync('research/note-saving/frontend-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();await server.close();}
