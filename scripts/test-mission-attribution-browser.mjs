// Actual built App and exact public served assets, isolated intercepted API only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
const port = await pickPort();
const base = process.env.ATTRIBUTION_BASE || `http://127.0.0.1:${port}`;
const preview = process.env.ATTRIBUTION_BASE ? null : spawn('npm', ['--workspace=client','run','preview','--','--host','127.0.0.1','--port',String(port)], {stdio:'ignore'});
let browser;
try {
  for (let n=0;n<100;n++) { if(await fetch(`${base}/app.html`).then(r=>r.ok).catch(()=>false)) break; await delay(100); }
  browser=await chromium.launch({headless:true});
  for(const width of [1280,390]) {
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[], writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/socket.io/**',r=>r.abort());
    await page.route('**/api/**',async route=>{
      const req=route.request(), p=new URL(req.url()).pathname;
      let data={};
      const user={id:1,username:'fixture',displayName:'Fixture'};
      const note={id:'c1',title:'Existing conversation',content_preview:'cascade://chat-channel',content:'cascade://chat-channel',vault_id:'v0',folder_id:null,tags:[]};
      const mission={id:'m1',rootMessageId:'human-root',title:'Requested repair',objective:'Repair',status:'active',coordinator:'Astra',coordinatorMention:'astra',coordinatorRegistrationId:'exact-astra-registration',tasks:[],summary:'',createdAt:'2026-09-15T10:00:00Z',updatedAt:'2026-09-15T10:00:00Z'};
      if(req.method()!=='GET') writes.push({path:p,body:req.postDataJSON()});
      if(p==='/api/session') data={authenticated:true,user,owner:false};
      else if(p==='/api/vaults') data={vaults:[{id:'v0',name:'Attribution fixture',role:'owner'}]};
      else if(p.endsWith('/folders')) data={folders:[]};
      else if(p.endsWith('/notes')) data={notes:[note]};
      else if(p.startsWith('/api/notes/')) data={note};
      else if(p.endsWith('/messages')) data={messages:[{id:'human-root',channelId:'c1',actorUserId:1,author:'fixture',body:'Original human request remains here',createdAt:'2026-09-15T10:00:00Z',mission}],hasMore:false};
      else if(p.endsWith('/members')) data={members:[{...user,userId:1,role:'owner'}],role:'owner'};
      else if(p.endsWith('/agents')||p.endsWith('/vault-agents')) data={agents:[]};
      else if(p.includes('/community/updates')) data={updates:[],counts:{byVault:{},byTarget:{},total:0}};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto(`${base}/app.html`);
    await page.getByText('Original human request remains here',{exact:true}).waitFor();
    const card=page.locator('[data-mission-id="m1"]');
    assert.equal(await card.count(),1);
    const group=card.locator('xpath=ancestor::article');
    assert.equal(await group.locator('.chat-message-meta strong').innerText(),'Astra');
    assert.equal(await group.locator('.chat-avatar-agent').count(),1);
    assert.equal(await group.getByText('Original human request remains here',{exact:true}).count(),0);
    assert.equal(await page.locator('[data-message-id="human-root"]').count()>=1,true);
    await card.click({button:'right'});
    await page.getByRole('menuitem',{name:'Reply',exact:true}).click();
    assert.equal(await page.locator('.chat-reply-preview').count()>0 || await page.getByText('Original human request remains here',{exact:true}).count()>1,true);
    await page.keyboard.press('Escape');
    await card.getByRole('button',{name:/Stop/}).click();
    assert.equal(writes.length,1);
    assert.equal(writes[0].path,'/api/vaults/v0/channels/c1/missions/m1/finish');
    assert.equal(writes[0].body.coordinatorRegistrationId,'exact-astra-registration');
    assert.equal(writes[0].body.status,'canceled');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,oneCoordinatorCard:true,humanRootPreserved:true,exactStop:true,contextReplyPreserved:true,source:base}));
    await page.close();
  }
} finally {await browser?.close();preview?.kill('SIGTERM');}
