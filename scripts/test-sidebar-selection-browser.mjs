/** Built or public-served App; all API data isolated, no personal desktop. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
assert.ok(!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY, 'unset personal displays');
const port = await pickPort();
const base = process.env.SIDEBAR_APP_URL || `http://127.0.0.1:${port}`;
const preview = process.env.SIDEBAR_APP_URL ? null : spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
let browser;
const evidence=[];
try {
  let ready=false;
  for(let i=0;i<100;i++){if(await fetch(`${base}/app.html`).then(r=>r.ok).catch(()=>false)){ready=true;break;}await delay(100);}
  assert.ok(ready);
  browser=await chromium.launch({headless:true,args:['--mute-audio']});
  for(const width of [1280,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[],writes=[],assets=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/assets/'))assets.push(r.url());});
    await page.route('**/socket.io/**',r=>r.abort());
    await page.route('**/api/**',async route=>{
      const req=route.request(),p=new URL(req.url()).pathname;
      if(req.method()!=='GET')writes.push(p);
      const user={id:1,username:'fixture',displayName:'Fixture'};
      const note={id:'milgen',title:'milgen',content_preview:'cascade://chat-channel',content:'cascade://chat-channel',vault_id:'v0',folder_id:'inner',tags:[],position:0,is_listed:1};
      let data={};
      if(p==='/api/session')data={authenticated:true,user,owner:false};
      else if(p==='/api/vaults')data={vaults:[{id:'v0',name:'My Vault fixture',role:'owner'}]};
      else if(p.endsWith('/folders'))data={folders:[{id:'outer',vault_id:'v0',name:'Projects',parent_id:null,position:0},{id:'inner',vault_id:'v0',name:'Milbooru',parent_id:'outer',position:0}]};
      else if(p.endsWith('/notes'))data={notes:[note]};
      else if(p.startsWith('/api/notes/'))data={note};
      else if(p.endsWith('/messages'))data={messages:[{id:'queued',channelId:'milgen',actorUserId:1,author:'Along',agentId:'hermes',body:'Queued...',status:'queued',runId:null,seq:1,createdAt:'2026-09-15T23:05:58Z'}],hasMore:false};
      else if(p.endsWith('/members'))data={members:[{...user,userId:1,role:'owner'}],role:'owner'};
      else if(p.endsWith('/agents')||p.endsWith('/vault-agents'))data={agents:[]};
      else if(p.includes('/community/updates'))data={updates:[],counts:{byVault:{},byTarget:{},total:0}};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(`${base}/app.html`);
    await page.locator('#folder-outer').waitFor({state:'attached'});
    if (!(await page.locator('#folder-outer').isVisible())) await page.keyboard.press('Control+Backslash');
    await page.locator('#folder-outer').waitFor();
    await page.locator('#folder-outer').click();
    await page.locator('#folder-inner').click();
    await page.locator('#note-milgen').click();
    if (!(await page.locator('#note-milgen').isVisible())) await page.keyboard.press('Control+Backslash');
    const frames=[];
    async function check(id){
      await page.waitForFunction(id=>document.querySelectorAll('.sidebar .tree-item.active').length===1&&document.getElementById(id)?.classList.contains('active'),id);
      await page.waitForFunction(id=>{
        const side=document.querySelector('.sidebar').getBoundingClientRect(),target=document.getElementById(id).getBoundingClientRect();
        const d=document.querySelector('.vault-selection-connector path')?.getAttribute('d')||'';
        const n=d.match(/-?\d+(?:\.\d+)?/g)?.map(Number)||[];
        return Math.abs(n[6]-(target.left-side.left))<1&&Math.abs(n[7]-(target.top-side.top))<1&&Math.abs(n[9]-(target.bottom-side.top))<1;
      },id);
      frames.push(await page.evaluate(id=>({id,active:[...document.querySelectorAll('.sidebar .tree-item.active')].map(x=>x.id),path:document.querySelector('.vault-selection-connector path').getAttribute('d')}),id));
    }
    await check('note-milgen');
    await page.getByLabel('Agent work queued — not running',{exact:true}).first().waitFor();
    assert.equal(await page.locator('.activity-dot.is-agent-running').count(),0);
    assert.ok(await page.locator('.activity-dot.is-agent-queued').count()>0);
    await page.locator('#folder-inner').click();await check('folder-inner');
    assert.equal(await page.locator('#note-milgen').count(),0);
    await page.locator('#folder-outer').click();await check('folder-outer');
    await page.locator('#folder-outer').click();await check('folder-inner');
    await page.locator('#folder-inner').click();await check('note-milgen');
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    evidence.push({width,base,frames,queuedVisible:true,orangeCount:0,errors,writes,assets:[...new Set(assets)]});
    await page.screenshot({path:`${process.env.SIDEBAR_SCREENSHOT_PREFIX||'/tmp/sidebar-target'}-${width}.png`});
    await page.close();
  }
  if(process.env.SIDEBAR_EVIDENCE)fs.writeFileSync(process.env.SIDEBAR_EVIDENCE,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally {await browser?.close();preview?.kill('SIGTERM');}
