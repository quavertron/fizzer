// Public served App + pure renderer response captured from exact deployed module.
// Intercepted authentication/data: not an authenticated production upload test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
const base=process.env.HTML_BASE || 'https://cscd.online';
const guard=JSON.parse(fs.readFileSync(process.env.HTML_GUARD,'utf8'));
const browser=await chromium.launch({headless:true});
try {
 for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const writes=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/socket.io/**',r=>r.abort());
  await page.route('**/api/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   assert.equal(req.method(),'GET','No live or fixture state changes allowed');
   if(p==='/api/html-previews/c1/a1')return route.fulfill({status:guard.status,headers:guard.headers,body:guard.body});
   const user={id:1,username:'fixture',displayName:'Fixture'};
   const note={id:'c1',title:'HTML acceptance',content_preview:'cascade://chat-channel',content:'cascade://chat-channel',vault_id:'v0',folder_id:null,tags:[]};
   let data={};
   if(p==='/api/session')data={authenticated:true,user,owner:false};
   else if(p==='/api/vaults')data={vaults:[{id:'v0',name:'HTML fixture',role:'owner'}]};
   else if(p.endsWith('/folders'))data={folders:[]};
   else if(p.endsWith('/notes'))data={notes:[note]};
   else if(p.startsWith('/api/notes/'))data={note};
   else if(p.endsWith('/messages'))data={messages:[{id:'html-root',channelId:'c1',actorUserId:1,author:'fixture',body:'HTML attachment acceptance',createdAt:'2026-09-15T10:00:00Z',attachments:[{url:'/api/notes/c1/assets/a1',name:'interactive.html',media_type:'text/html'}]}],hasMore:false};
   else if(p.endsWith('/members'))data={members:[{...user,userId:1,role:'owner'}],role:'owner'};
   else if(p.endsWith('/agents')||p.endsWith('/vault-agents'))data={agents:[]};
   else if(p.includes('/community/updates'))data={updates:[],counts:{byVault:{},byTarget:{},total:0}};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(base+'/app.html');
  await page.getByRole('button',{name:'Preview HTML',exact:true}).click();
  const outer=page.frameLocator('iframe[title="interactive.html"]');
  const inner=outer.frameLocator('#preview');
  await inner.getByRole('button',{name:'Split view',exact:true}).click();
  assert.equal(await inner.locator('#state').textContent(),'Split');
  assert.equal(await page.locator('iframe[title="interactive.html"]').getAttribute('sandbox'),'allow-scripts allow-forms');
  assert.equal(await page.getByRole('link',{name:'Download interactive.html'}).getAttribute('href'),'/api/notes/c1/assets/a1');
  await page.getByRole('button',{name:'Close HTML preview',exact:true}).click();
  assert.equal(await page.locator('iframe').count(),0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,servedApp:base,deployedGuard:true,inlineInteraction:true,sandbox:true,download:true,close:true,scope:'intercepted API; no production upload'}));
  await page.close();
 }
}finally{await browser.close();}
