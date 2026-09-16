// Composed ChatView regression, adapted from research039a5be5. Synthetic data only.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';

const html = `<!doctype html><div id="root"></div><script type="module">
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChatView } from '/src/components/ChatView.tsx';
import { chatMessageStore } from '/src/chat/messageStore.ts';
import { applyRemoteChatMessage, captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot } from '/src/chat/runBlocks.ts';
import { segmentTranscript } from '/src/chat/workTrace.ts';
import '/src/index.css';
const noop = () => {};
const human = {id:'human-root', channelId:'fixture', author:'Human', actorUserId:1,
  body:'CONTROLLED HUMAN REQUEST: keep this original text', createdAt:'2026-09-16T18:46:30Z', seq:1,
  replyTo:{messageId:'earlier-request',author:'Human',body:'Earlier context'},
  attachments:[{url:'/fixture.txt',name:'fixture.txt',media_type:'text/plain'}],
  mission:{id:'m1',rootMessageId:'human-root',title:'Controlled mission',objective:'Controlled fixture',
    status:'active',coordinator:'Astra',coordinatorMention:'astra',coordinatorRegistrationId:'reg-astra',
    tasks:[],summary:'',createdAt:'',updatedAt:''}};
const initialTrace = {id:'agent-trace',channelId:'fixture',author:'Astra',agentId:'codex',registrationId:'reg-astra',
  body:'Researching',status:'running',runId:42,seq:2,createdAt:'2026-09-16T18:47:00Z',
  replyTo:{messageId:human.id,author:human.author,body:human.body}};
let root = human, trace = initialTrace;
window.seed = (kind = 'human') => {
  root = {...human}; trace = {...initialTrace};
  if (kind === 'attachment') root.body = '';
  if (kind === 'ordinary') delete root.mission;
  if (kind === 'agent') root = {...root,author:'Astra',agentId:'codex',registrationId:'reg-astra',body:'Agent mission prose'};
  chatMessageStore.set('fixture',[root]);
};
window.trace = () => chatMessageStore.update('fixture', rows => applyRemoteChatMessage(rows,trace));
window.interrupt = () => {trace = {...trace,status:'canceled',body:'Researching. Steered into the continuation below.',hasHarness:true}; window.trace()};
window.refresh = (deleted = false) => {
  const rows = chatMessageStore.getChannel('fixture');
  chatMessageStore.set('fixture',reconcileChatMessageSnapshot(rows,deleted ? [trace] : [root,trace],captureChatMessageSnapshotBaseline(rows)));
};
window.state = () => ({root,rows:chatMessageStore.getChannel('fixture'),segments:segmentTranscript(chatMessageStore.getChannel('fixture'))});
window.remove = () => chatMessageStore.update('fixture',rows => rows.filter(row => row.id !== root.id));
window.seed();
if (new URLSearchParams(location.search).has('fresh')) {window.trace();window.interrupt();window.refresh()}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ChatView,{
  vaultId:'fixture-vault',channelId:'fixture',channelName:'Fixture',currentUser:'Human',
  presence:{participants:[],online:[]},availableAgents:[],registeredAgents:[],sidebarMode:'hidden',
  onRegisterAgent:noop,onRemoveAgent:noop,onInviteUser:async()=>{},onSendMessage:noop,onCancelRun:noop}));
</script><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style>`;
const server = await createServer({
  root:new URL('../client',import.meta.url).pathname,
  server:{host:'127.0.0.1',port:await pickPort()},
  plugins:[{name:'human-content-fixture',configureServer(server) {
    server.middlewares.use('/fixture.html',async (_req,res) => {
      res.setHeader('Content-Type','text/html');
      res.end(await server.transformIndexHtml('/fixture.html',html));
    });
  }}],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1000,height:900}});
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**',async route => {
    const request = route.request();
    if (request.method() !== 'GET') writes.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});
    await route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  const url = server.resolvedUrls.local[0] + 'fixture.html';
  await page.goto(url);
  const row = page.locator('.chat-message-chunk[data-message-id="human-root"]');
  const card = page.locator('[data-mission-id="m1"]');
  async function check(stage, {attachmentOnly = false, ordinary = false} = {}) {
    await row.waitFor();
    // Allow the external-store notification and React commit to settle.
    await page.waitForTimeout(100);
    assert.equal(await row.count(),1,stage);
    const state = await page.evaluate(() => JSON.parse(JSON.stringify(window.state())));
    assert.deepEqual(state.rows.find(message => message.id === 'human-root'),state.root,stage + ': stored root');
    const artifact = state.segments.find(segment => segment.id === 'human-root')?.carrier;
    const body = row.locator('p');
    if (attachmentOnly) assert.equal(await body.count(),0,stage);
    else {
      assert.equal(await body.count(),1,stage + ': original body rendered once');
      assert.equal(await body.innerText(),state.root.body,stage);
    }
    if (artifact) assert.deepEqual(artifact,state.root,stage + ': artifact identity and content');
    assert.equal(await row.locator('a[download="fixture.txt"]').count(),1,stage);
    assert.equal(await row.locator('xpath=ancestor::article').locator('.chat-message-meta strong').innerText(),'Human',stage);
    if (!ordinary) {
      assert.equal(await card.count(),1,stage);
      const coordinator = card.locator('xpath=ancestor::article');
      assert.equal(await coordinator.locator('.chat-message-meta strong').innerText(),'Astra',stage);
      if (state.root.body) assert.equal(await coordinator.getByText(state.root.body,{exact:true}).count(),0,stage + ': no duplicate body');
    }
    console.log('PASS ' + stage);
  }
  await check('root before linked trace');
  await page.evaluate(() => window.trace());
  await check('linked running trace');
  await page.evaluate(() => {window.trace();window.trace()});
  await check('duplicate trace upserts');
  await page.evaluate(() => window.interrupt());
  await check('interruption');
  await page.evaluate(() => window.refresh());
  await check('reconnect snapshot');
  await page.goto(url + '?fresh=1');
  await check('fresh mount from canonical rows');

  await card.click({button:'right'});
  await page.getByRole('menuitem',{name:'Reply',exact:true}).click();
  assert.match(await page.locator('.chat-reply-bar-preview').innerText(),/CONTROLLED HUMAN REQUEST/);
  await page.keyboard.press('Escape');
  await card.getByRole('button',{name:/Stop/}).click();
  assert.deepEqual(writes,[{path:'/api/vaults/fixture-vault/channels/fixture/missions/m1/finish',body:{status:'canceled',coordinatorRegistrationId:'reg-astra',summary:'Stopped by user.'}}]);
  console.log('PASS original reply context and exact coordinator Stop');

  await page.evaluate(() => window.remove());
  await row.waitFor({state:'detached'});
  assert.equal(await card.count(),0);
  console.log('PASS explicit deletion');
  await page.evaluate(() => {window.seed();window.trace();window.refresh(true)});
  await row.waitFor({state:'detached'});
  assert.equal(await page.evaluate(() => window.state().rows.some(row => row.id === 'human-root')),false);
  console.log('PASS authoritative offline deletion');

  await page.evaluate(() => {window.seed('attachment');window.trace()});
  await check('attachment-only mission root',{attachmentOnly:true});
  await page.evaluate(() => window.seed('ordinary'));
  await check('ordinary human',{ordinary:true});
  await page.evaluate(() => {window.seed('agent');window.trace()});
  await card.waitFor();
  await row.waitFor({state:'detached'});
  assert.equal(await page.getByText('Agent mission prose',{exact:true}).count(),0);
  assert.equal(await card.count(),1);
  assert.equal(await card.locator('xpath=ancestor::article').locator('.chat-message-meta strong').innerText(),'Astra');
  console.log('PASS agent-created mission without duplicate prose');
  assert.deepEqual(errors,[]);
} finally {
  await browser?.close();
  await server.close();
}
