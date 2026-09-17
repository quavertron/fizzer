import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const server = await createServer({configFile:false,root:path.resolve('client'),server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
await server.listen();
const browser=await chromium.launch({headless:true,args:['--mute-audio']});
const evidence={fixture:'real App and CodeMirror; in-memory API, no disk persistence claim',writes:[],checks:[],errors:[]};
let role='owner';
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
    if(body.expectedRevision!==notes[id].revision){status=409;data={error:'revision_conflict',note:notes[id]};}
    else {notes[id]={...notes[id],content:body.content,content_preview:body.content.replace(/\s+/g,' '),revision:`note-v1:${Number(notes[id].revision.split(':')[1])+1}`};data={note:notes[id]};}
   write.status=status;
   }else data={note:notes[id]};
  }
  else if(p.endsWith('/members'))data={members:[{...user,userId:1,role:'owner'}, {userId:2,username:'diego',displayName:'Diego Example',role:'editor'}],role:'owner'};
  else if(p.endsWith('/agents')||p.endsWith('/vault-agents'))data={agents:[]};
  else if(p.includes('/community/updates'))data={updates:[],counts:{byVault:{},byTarget:{},total:0}};
  await route.fulfill({status,json:data});
 });
 await page.goto(`${server.resolvedUrls.local[0]}app.html`);
 const editor=page.locator('.cm-content:visible');
 await editor.waitFor();

 await editor.fill('CWD? ');
 await page.keyboard.press('End');
 await page.keyboard.type('@di');
 const option = page.getByRole('option').filter({hasText:'@diego'});
 await option.waitFor(); await page.waitForTimeout(100);
 assert.match(await option.innerText(), /Diego Example/);
 await page.keyboard.press('Enter');
 assert.equal(await editor.innerText(), 'CWD? @diego ');
 await page.locator('.cm-note-mention').waitFor();
 assert.equal(await page.locator('.cm-note-mention').innerText(), '@diego');
 await page.keyboard.press('Control+s');
 await page.waitForFunction(() => document.querySelector('#editor-status-bar')?.textContent?.includes('Saved'));
 assert.equal(notes.a.content, 'CWD? @diego ');
 await page.reload();
 await page.locator('.cm-note-mention').waitFor();
 assert.equal(await editor.innerText(), 'CWD? @diego ');
 evidence.checks.push('Typing @ opens member picker, Enter inserts ordinary Markdown, highlight survives save and reload');
 await editor.fill('Next '); await page.keyboard.press('End'); await page.keyboard.type('@exam');
 await option.waitFor(); await page.waitForTimeout(100); await page.keyboard.press('Tab');
 assert.equal(await editor.innerText(), 'Next @diego ');
 evidence.checks.push('Display name search and Tab completion');
 await editor.fill('Mouse '); await page.keyboard.press('End'); await page.keyboard.type('@di');
 await option.waitFor(); await page.waitForTimeout(100); await option.click();
 assert.equal(await editor.innerText(), 'Mouse @diego ');
 await editor.fill('Cancel '); await page.keyboard.press('End'); await page.keyboard.type('@di');
 await option.waitFor(); await page.waitForTimeout(100); await page.keyboard.press('Escape');
 assert.equal(await page.getByRole('option').count(),0);
 assert.equal(await editor.innerText(), 'Cancel @di');
 evidence.checks.push('Mouse selection and Escape dismissal');
 await editor.fill('`@diego` email@diego https://example.test/@diego @stranger');
 assert.equal(await page.locator('.cm-note-mention').count(),0);
 await page.keyboard.press('Control+s');
 await page.waitForTimeout(200);
 role='viewer'; await page.reload(); await editor.waitFor();
 assert.equal(await editor.getAttribute('contenteditable'),'false');
 assert.equal(await page.getByRole('option').count(),0);
 evidence.checks.push('Literal contexts are not highlighted; viewer note is read-only');
 assert.deepEqual(evidence.errors,[]);
 console.log(JSON.stringify(evidence,null,2));
} finally { await browser.close(); await server.close(); }
