import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const engine = createRequire(import.meta.url)('../cascade-electron/awatch-engine.cjs');
import { pickPort } from './lib/test-ports.mjs';

const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PaneGrid } from '/src/components/PaneGrid.tsx';
import { AwatchPane } from '/src/components/AwatchPane.tsx';
import { attachActivity } from '/src/activity.ts';
import * as Layout from '/src/layout/tree.ts';
import '/src/index.css';
window.commands = [];
const listeners = new Map();
const events = [
  {id:'epoch:1',kind:'edit',agent:'codex',author:'Codex',file:'/workspace/app.ts',old_lines:['const value = 1;'],new_lines:['const value = 2;'],line_start:8,line_end:8,timestamp:1770000000},
  {id:'epoch:2',kind:'lock',agent:'claude',file:'/workspace/app.ts',result:'conflict',conflict_agent:'codex',timestamp:1770000001},
];
const socket = {
 connected: true,
 on: (name, callback) => listeners.set(name, callback),
 off: name => listeners.delete(name),
 emit: (name, ...args) => {
   window.commands.push({name,args});
   if (name === 'awatch:replay') queueMicrotask(() => listeners.get('vault:activity')?.({vaultId:'test',events,cursor:{epoch:'epoch',seq:2}}));
 },
};
window.reconnect = () => { listeners.get('disconnect')?.(); listeners.get('connect')?.(); };
const detach = attachActivity(socket, 'test', 'fixture');
window.detachActivity = detach;
function Fixture() {
  const [tabs, setTabs] = React.useState([{id:'note',title:'Note',type:'note'}]);
  const [tree, setTree] = React.useState(() => Layout.createPane(['note'], 'note'));
  return React.createElement(PaneGrid, {
    node: tree, openTabs: tabs, focusedPaneId: Layout.getFirstPane(tree).id,
    onFocusPane: () => {}, onSelectTab: (pane, tab) => setTree(Layout.setActiveTab(tree,pane,tab)),
    onCloseTab: id => { setTabs(tabs.filter(tab => tab.id !== id)); setTree(Layout.simplify(Layout.removeTab(tree,id))); },
    onCloseOtherTabs: () => {}, onDropNote: () => {},
    onDropTab: (payload, pane, side) => setTree(side === 'center' ? Layout.moveTab(tree,payload.tabId,pane) : Layout.splitPaneWithTab(tree,pane,side,payload.tabId)),
    onResize: (id, sizes) => setTree(Layout.setSplitSizes(tree,id,sizes)),
    onCreateTab: () => {}, sidebarOpen: false, onToggleSidebar: () => {},
    onOpenAwatch: pane => { setTabs([...tabs,{id:'awatch',title:'Awatch',type:'awatch'}]); setTree(Layout.addTabToPane(tree,pane,'awatch')); },
    renderContent: tab => tab.type === 'awatch' ? React.createElement(AwatchPane,{activityKey:'fixture'}) : React.createElement('div',{},'Note content'),
  });
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex:1}</style></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: await pickPort() },
  plugins: [{ name: 'awatch-fixture', configureServer(server) {
    server.middlewares.use('/awatch-test.html', async (_req, res) => {
      res.setHeader('Content-Type','text/html');
      res.end(await server.transformIndexHtml('/awatch-test.html',fixture));
    });
  } }],
});
let browser;
let page;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.exposeFunction('analyzeAwatch', input => engine.analyze(input));
  await page.addInitScript(() => { window.electronAPI = { analyzeAwatch: input => window.analyzeAwatch(input) }; });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0] + 'awatch-test.html');
  await page.getByRole('button',{name:'New tab',exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'Awatch',exact:true}).click();
  await page.getByText('Lock conflict',{exact:true}).waitFor();
  await page.evaluate(() => window.reconnect());
  assert.equal(await page.locator('.awatch-event').count(),2);
  await page.locator('.awatch-added').getByText('+const value = 2;',{exact:true}).waitFor();
  const stats = page.getByLabel('Activity statistics', {exact:true});
  assert.match(await stats.innerText(), /~1/);
  await page.getByRole('button', {name:'Collapse all diffs',exact:true}).click();
  assert.equal(await page.locator('.awatch-diff').count(), 0);
  assert.match(await stats.innerText(), /~1/);
  await page.getByRole('button', {name:'Expand diff for /workspace/app.ts',exact:true}).click();
  assert.equal(await page.locator('.awatch-diff').count(), 1);
  await page.getByRole('button', {name:'Expand all diffs',exact:true}).click();
  await page.getByRole('button', {name:'Collapse diff for /workspace/app.ts',exact:true}).click();
  assert.equal(await page.locator('.awatch-diff').count(), 0);
  await page.getByLabel('Activity log',{exact:true}).focus();
  await page.keyboard.press('Control+o');
  await page.keyboard.press('Control+o');
  assert.equal(await page.locator('.awatch-diff').count(), 1);
  await page.getByRole('textbox',{name:'Filter Awatch activity'}).fill('claude');
  assert.equal(await page.locator('.awatch-event').count(),1);
  assert.match(await stats.innerText(), /~1/);
  await page.getByRole('textbox',{name:'Filter Awatch activity'}).fill('');
  const content = page.locator('.pane-content');
  const rect = await content.boundingBox();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.setData('application/x-cascade-tab', JSON.stringify({tabId:'awatch',fromPaneId:'unused'}));
    return data;
  });
  await content.dispatchEvent('drop',{dataTransfer:transfer,clientX:rect.x+rect.width-5,clientY:rect.y+rect.height/2});
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2);
  await page.getByText('Lock conflict',{exact:true}).waitFor();
  await page.locator('.awatch-diff .awatch-added').waitFor();
  await page.screenshot({path:'/tmp/fizzer-awatch-pane.png'});
  await page.setViewportSize({width:700,height:600});
  assert.equal(await page.locator('.awatch-pane').count(),1);
  await page.getByRole('button',{name:'Clear activity view'}).click();
  await page.getByText('Watching for activity',{exact:true}).waitFor();
  assert.match(await stats.innerText(), /~0/);
  const awatch = page.locator('.tab-item').filter({hasText:'Awatch'});
  await awatch.locator('.tab-close').click();
  await page.evaluate(() => window.detachActivity());
  assert.deepEqual(errors, []);
  console.log('Awatch pane: selection, native diffs, filtering, splitting, resize and cleanup passed');
} catch (error) {
  await page?.screenshot({path:'/tmp/fizzer-awatch-pane-failure.png'});
  throw error;
} finally { engine.stop(); await browser?.close(); await server.close(); }
