// Synthetic component fixtures; never connects to a personal desktop/session.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
const before = process.env.EXPECT_BEFORE === '1';
const output = process.env.EVIDENCE_DIR || '/tmp/eab8ea-work-summary';
const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ChatWorkTrace} from '/src/components/ChatWorkTrace.tsx';
import {ChatMissionCard} from '/src/components/ChatMissionCard.tsx';
import '/src/index.css';
const noop=()=>{};
const root=createRoot(document.getElementById('root'));
window.seed=(status)=>{
const text='Verified the sidebar selection curve and preserved the human request.';
const message={id:'work',channelId:'fixture',author:'Astra',agentId:'codex',body:text,createdAt:'',status:status==='completed'?undefined:status};
const mission={id:'mission',rootMessageId:'human',title:'Repair sidebar selection',objective:'Preserve selection',status:status==='running'?'active':status==='failed'?'attention':status,coordinator:'Astra',coordinatorRegistrationId:'reg-astra',summary:text,createdAt:'',updatedAt:'',tasks:status==='running'||status==='failed'?[{id:'task',title:'Inspect selection',summary:'Inspecting selection',status,assignee:'Astra',dependsOn:[],waitingFor:[]}]:[]};
root.render(React.createElement(React.Fragment,null,
React.createElement(ChatWorkTrace,{trace:[message],selectedMessageId:null,onCancelRun:noop,onContextMenu:noop,onReply:noop,runningMessageState:new Map()}),
React.createElement(ChatMissionCard,{mission,vaultId:'fixture',channelId:'fixture',replyMessage:{...message,id:'human'},onReply:noop})));
};window.seed('completed');
</script><style>body{margin:16px}#root{max-width:700px}</style>`;
const server=await createServer({root:new URL('../client',import.meta.url).pathname,server:{host:'127.0.0.1',port:await pickPort()},plugins:[{name:'summary-fixture',configureServer(s){s.middlewares.use('/fixture.html',async(_,res)=>{res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml('/fixture.html',html));});}}]});
let browser;
try{
 await mkdir(output,{recursive:true});await server.listen();browser=await chromium.launch({headless:true});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  await page.goto(server.resolvedUrls.local[0]+'fixture.html');
  for(const status of ['running','completed','failed','canceled']){
   await page.evaluate(status=>window.seed(status),status);
   const work=page.locator('.chat-work-trace-toggle');const card=page.locator('.chat-mission-card');
   await page.waitForFunction(status=>document.querySelector('.chat-mission-status')?.textContent===(status==='running'?'working':status==='failed'?'needs attention':status),status);
   if(await card.getAttribute('aria-expanded')==='true') await card.locator('.chat-mission-toggle').click();
   if(!before){
    assert.match(await work.innerText(),/Verified the sidebar/);
    assert.equal(await work.locator('.chat-mission-state').count(),1);
    assert.equal(await work.locator('.chat-mission-state').getAttribute('aria-label'),status);
    assert.match(await card.locator('.chat-mission-toggle strong').innerText(),/Verified the sidebar/);
    assert.equal(await card.locator('.chat-mission-state').count(),1);
    assert.equal(await work.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
    assert.equal(await card.evaluate(el=>getComputedStyle(el).borderLeftWidth),'0px');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   }else if(status==='completed') assert.match(await work.innerText(),/Work details/);
   await page.screenshot({path:output+'/'+(before?'before':'after')+'-'+width+'-'+status+'.png'});
   await work.focus();await page.keyboard.press('Enter');assert.equal(await work.getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Space');assert.equal(await work.getAttribute('aria-expanded'),'false');
   await work.click();assert.equal(await work.getAttribute('aria-expanded'),'true');await work.click();
   await card.focus();await page.keyboard.press('Enter');assert.equal(await card.getAttribute('aria-expanded'),'true');
   await page.keyboard.press('Space');assert.equal(await card.getAttribute('aria-expanded'),'false');
   await card.locator('.chat-mission-toggle').click();assert.equal(await card.getAttribute('aria-expanded'),'true');await card.locator('.chat-mission-toggle').click();
   assert.equal(await card.locator('.chat-mission-stop').count(),status==='running'||status==='failed'?1:0);
   console.log('PASS '+(before?'before baseline':'after summary/status/layout')+' '+width+' '+status+' keyboard/click');
  }
  assert.deepEqual(errors,[]);await page.close();
 }
}finally{await browser?.close();await server.close();}
