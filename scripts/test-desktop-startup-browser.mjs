import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Actual startup hook with controlled auth/list inputs; no live accounts or cookies.
const fixture = `
import React, {useState, useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {useDesktopStartup} from '/src/desktopStartup.ts';
import {StartupPending} from '/src/components/StartupPending.tsx';
window.committedFrames = [];
function Fixture() {
 const [owner, setOwner] = useState(null);
 const [ready, setReady] = useState(false);
 const [failed, setFailed] = useState(false);
 const [vaults, setVaults] = useState([]);
 const [active, setActive] = useState('private-cached');
 const startup = useDesktopStartup(true, owner, active, vaults, ready, setActive);
 useLayoutEffect(() => { window.committedFrames.push(document.getElementById('root').textContent); });
 window.authenticate = setOwner;
 window.failListing = () => { setFailed(true); setReady(false); };
 window.hydrate = (owner, vaults) => { setOwner(owner); setVaults(vaults); setReady(true); };
 if (!owner) return React.createElement('div', {}, 'Authenticating');
 if (startup.pending) return React.createElement(StartupPending, {kind:'vault', failed, onRetry:()=>{setFailed(false);window.retried=true;}});
 return React.createElement('div', {}, React.createElement('span', {}, 'Workspace '+active), ...vaults.map(v=>React.createElement('button', {key:v.id,onClick:()=>{setActive(v.id);startup.remember(v.id);}}, v.name)));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const html = '<div id="root"></div><script type="module" src="/@id/desktop-startup-fixture"></script>';
const server = await createServer({ root: new URL('../client', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'desktop-startup-fixture', resolveId(id) { if (id === 'desktop-startup-fixture') return id; }, load(id) { if (id === 'desktop-startup-fixture') return fixture; }, configureServer(server) { server.middlewares.use('/__desktop_startup_test.html', async (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__desktop_startup_test.html', html)); }); } }] });
let browser;
try {
 await server.listen();
 browser = await chromium.launch({headless:true});
 const page = await browser.newPage();
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 const origin = server.resolvedUrls.local[0];
 const vaults = [{id:'other',name:'Other vault'},{id:'chosen',name:'Remembered vault'}];
 const boot = async () => { await page.goto(origin+'__desktop_startup_test.html?chooser=1'); await page.waitForFunction(()=>typeof window.hydrate==='function'); };
 const hydrate = async (owner='1', available=vaults) => page.evaluate(({owner,available})=>window.hydrate(owner,available), {owner,available});
 const sample = async () => page.evaluate(async () => { for(let i=0;i<8;i++) await new Promise(resolve=>requestAnimationFrame(()=>{window.committedFrames.push(document.getElementById('root').textContent);resolve();})); });
 await boot();
 await sample();
 await page.evaluate(()=>window.authenticate('1'));
 await sample();
 await page.getByText('Loading workspace…',{exact:true}).waitFor();
 await page.evaluate(()=>window.failListing());
 await page.getByRole('button',{name:'Retry',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.retried),true);
 assert.ok((await page.evaluate(()=>window.committedFrames)).every(text=>!text.includes('vault')&&!text.includes('private-cached')&&!text.includes('Workspace chosen')));
 await hydrate();
 await page.getByText('Workspace chosen',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Other vault',exact:true}).click();
 await hydrate();
 await page.getByText('Workspace other',{exact:true}).waitFor();
 await boot(); await hydrate();
 await page.getByText('Workspace other',{exact:true}).waitFor();
 await hydrate('2');
 await page.getByText('Workspace chosen',{exact:true}).waitFor();
 await boot(); await hydrate('1', [{id:'chosen',name:'Remembered vault'}]);
 await page.getByText('Workspace chosen',{exact:true}).waitFor();
 await hydrate('1', []);
 await page.getByText('Workspace null',{exact:true}).waitFor();
 await hydrate();
 await page.getByText('Workspace other',{exact:true}).waitFor();
 assert.ok((await page.evaluate(()=>window.committedFrames)).every(text=>!text.includes('Choose a vault')&&!text.includes('private-cached')));
 assert.deepEqual(errors, []);
 console.log('PASS committed/animation frames, delayed auth/access, failure/retry, deterministic default, sidebar-style switch persists through listing refresh and reboot, changed owner/deleted vault/zero vault/recovery; no chooser even with legacy chooser=1');
} finally { await browser?.close(); await server.close(); }
