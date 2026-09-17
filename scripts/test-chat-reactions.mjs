#!/usr/bin/env node
// Headless UI regression; API transport is mocked, backend persistence/auth are covered in ExUnit.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from '/src/components/ChatView.tsx';
import { chatMessageStore } from '/src/chat/messageStore.ts';
import { applyRemoteChatMessage } from '/src/chat/runBlocks.ts';
import '/src/index.css';
const noop = () => {};
const root = createRoot(document.getElementById('root'));
window.receive = row => chatMessageStore.update('room', rows => applyRemoteChatMessage(rows, row));
window.rows = () => chatMessageStore.getChannel('room');
const row = await (await fetch('/seed')).json();
chatMessageStore.set('room', [row]);
root.render(React.createElement(ChatView, { channelId:'room', channelName:'Room', currentUser:'alice', currentUserId:1,
vaultId:'vault', presence:{participants:[],online:[]}, availableAgents:[], registeredAgents:[], sidebarMode:'hidden',
onRegisterAgent:noop,onRemoveAgent:noop,onInviteUser:async()=>{},onSendMessage:noop,onCancelRun:noop }));
</script><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname, server: {host:'127.0.0.1',port:await pickPort()},
  plugins:[{name:'reaction-fixture',configureServer(server){ server.middlewares.use('/reaction-test.html',async (_req,res)=>{
    res.setHeader('content-type','text/html');res.end(await server.transformIndexHtml('/reaction-test.html',fixture));
  });}}] });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless:true});
  const context = await browser.newContext();
  let message = {id:'message',channelId:'room',author:'alice',body:'Laugh here',createdAt:'2026-09-17T12:00:00Z',seq:1,reactions:{version:0,items:{}}};
  let fail = false, puts = 0, delay = false;
  const pages = [];
  await context.route('**/seed', route=>route.fulfill({json:message}));
  await context.route('**/api/**', async route=>{
    if (!route.request().url().endsWith('/reactions')) return route.fulfill({json:{messages:[],agents:[],participants:[]}});
    puts++;
    if (fail) return route.fulfill({status:403,json:{error:'Denied'}});
    const {emoji,active} = route.request().postDataJSON();
    const items = {...message.reactions.items};
    const actors = items[emoji] || [];
    items[emoji] = active ? [...new Set([...actors,'user:1'])] : actors.filter(id=>id!=='user:1');
    if (!items[emoji].length) delete items[emoji];
    message = {...message,reactions:{version:message.reactions.version+1,items}};
    const saved = structuredClone(message);
    for (const page of pages) await page.evaluate(row=>window.receive(row), message);
    if (delay) {
      message = {...message,body:'New streamed content',reactions:{version:message.reactions.version+1,items:{'😂':['user:1','user:2']}}};
      for (const page of pages) await page.evaluate(row=>window.receive(row), message);
    }
    return route.fulfill({json:{message:saved}});
  });
  const url = `http://127.0.0.1:${server.config.server.port}/reaction-test.html`;
  for(let i=0;i<2;i++){const page=await context.newPage();pages.push(page);await page.goto(url);await page.getByRole('button',{name:'Add reaction',exact:true}).waitFor();}
  const [page,viewer]=pages;
  await page.getByRole('button',{name:'Add reaction',exact:true}).click();
  await page.getByRole('button',{name:'Laugh',exact:true}).click();
  await page.getByRole('button',{name:'Laugh, 1, your reaction',exact:true}).waitFor();
  assert.equal(await viewer.getByRole('button',{name:'Laugh, 1, your reaction',exact:true}).getAttribute('aria-pressed'),'true');
  await page.reload();
  await page.getByRole('button',{name:'Laugh, 1, your reaction',exact:true}).click();
  await page.waitForFunction(()=>!window.rows()[0].reactions.items['😂']);
  fail=true;
  await page.getByRole('button',{name:'Add reaction',exact:true}).click();
  await page.getByRole('button',{name:'Laugh',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Could not update reaction'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Laugh',exact:true}).getAttribute('aria-pressed'),'false');
  fail=false;delay=true;
  await page.getByRole('button',{name:'Laugh',exact:true}).click();
  await page.getByRole('button',{name:'Laugh, 2, your reaction',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.rows()[0].body),'New streamed content');
  const stale = {...message,reactions:{version:0,items:{}}};
  await page.evaluate(row=>window.receive(row),stale);
  assert.equal(await page.getByRole('button',{name:'Laugh, 2, your reaction',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Add reaction',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Thumbs up',exact:true}).waitFor();
  const touch = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const touchPage=await touch.newPage();
  await touchPage.route('**/seed',route=>route.fulfill({json:message}));
  await touchPage.route('**/api/**',route=>route.fulfill({json:{messages:[],agents:[],participants:[]}}));
  await touchPage.goto(url);
  const add=touchPage.getByRole('button',{name:'Add reaction',exact:true});
  await add.tap();
  const bounds=await touchPage.getByRole('button',{name:'Thumbs up',exact:true}).boundingBox();
  assert(bounds.height>=43.99 && bounds.width>=43.99, JSON.stringify({bounds, coarse: await touchPage.evaluate(()=>matchMedia("(pointer: coarse)").matches)}));
  assert.equal(puts,4);
  console.log('PASS: real ChatView per-message controls, toggle/count/own state, second viewer, reload, failure, stale HTTP/realtime, keyboard and touch targets');
} finally {await browser?.close();await server.close();}
