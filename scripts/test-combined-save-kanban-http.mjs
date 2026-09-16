import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({configFile:false,root:path.resolve('client'),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
await server.listen();
const browser=await chromium.launch({headless:true,args:['--mute-audio']});
const evidence={fixture:'Combined real App -> loopback Bandit Router -> isolated SQLite and markdown files. Auth session, listing and sockets controlled; note GET/PUT real HTTP.',writes:[],checks:[],errors:[]};
let fail=false, slow=false, releases=[], failureStatus=500, networkFailure=false, role='owner';
const backend=JSON.parse(fs.readFileSync('/tmp/bf273e-server.json','utf8'));
const backendHeaders={Authorization:`Bearer ${backend.token}`};
const backendURL=`http://127.0.0.1:${backend.port}`;
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
   const write=req.method()==='PUT'?{id,...req.postDataJSON()}:null;
   if(write){evidence.writes.push(write);if(slow)await new Promise(r=>releases.push(r));if(networkFailure){write.status='network';return route.abort('failed');}}
   const response=await route.fetch({url:backendURL+p,headers:{...req.headers(),...backendHeaders}});
   data=await response.json();status=response.status();if(write)write.status=status;
   if(status===200)notes[id]=data.note;
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

 assert.equal(fs.readFileSync(backend.files.a,'utf8'),notes.a.content);
 evidence.checks.push('Real note GET/PUT traversed isolated HTTP backend; actual markdown file matches flagged moved checked board after reload');
 networkFailure=true;await card('First').getByRole('button',{name:'Mark incomplete',exact:true}).click();await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status==='network');
 await page.waitForTimeout(100);assert.match(await status(),/Save failed/i);assert.match(fs.readFileSync(backend.files.a,'utf8'),/\[x\] First/);
 networkFailure=false;await page.keyboard.press('Control+s');await waitFor(()=>notes.a.content.includes('[ ] First'));await page.reload();await localBoard.waitFor();assert.match(fs.readFileSync(backend.files.a,'utf8'),/\[ \] First/);
 evidence.checks.push('Browser network failure retains draft; explicit retry persists to real backend/file and survives reload');
 const external=await fetch(backendURL+'/api/notes/a',{method:'PUT',headers:{...backendHeaders,'Content-Type':'application/json'},body:JSON.stringify({content:notes.a.content+'\nExternal revision\n',expectedRevision:notes.a.revision})});assert.equal(external.status,200);
 const externalNote=(await external.json()).note;
 await card('First').getByRole('button',{name:'Mark complete',exact:true}).click();await page.keyboard.press('Control+s');await waitFor(()=>evidence.writes.at(-1).status===409);await page.waitForTimeout(100);
 assert.match(await status(),/Conflict/i);assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(),2);assert.equal(fs.readFileSync(backend.files.a,'utf8'),externalNote.content);
 evidence.checks.push('Genuine concurrent backend revision returns HTTP 409, retains checked draft and leaves externally committed file unchanged');
 assert.deepEqual(evidence.errors,[]);
 fs.writeFileSync(process.env.REVIEW_EVIDENCE,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();await server.close();}
