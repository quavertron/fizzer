import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Actual chooser and startup hook, with controlled authenticated/listing inputs.
// No production account, runner, cookies or network data are used.
const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useDesktopStartup} from '/src/desktopStartup.ts';
import {DesktopVaultChooser} from '/src/components/DesktopVaultChooser.tsx';
window.electronAPI = {};
function Fixture() {
 const [owner, setOwner] = useState(null);
 const [ready, setReady] = useState(false);
 const [vaults, setVaults] = useState([]);
 const [active, setActive] = useState(localStorage.getItem('test_active'));
 const startup = useDesktopStartup(true, owner, active, vaults, ready);
 window.hydrate = (owner, vaults) => { setOwner(owner); setVaults(vaults); setReady(true); };
 const select = id => { setActive(id); localStorage.setItem('test_active', id); };
 if (!owner || !ready) return React.createElement('div', {}, 'Authenticating');
 return startup.open ? React.createElement(DesktopVaultChooser, {vaults, activeVaultId:active, onSelect:select, onCreate:async()=>false, onContinue:startup.continue}) : React.createElement('div', {}, React.createElement('span', {}, 'Workspace '+active), React.createElement('button', {onClick:startup.choose}, 'Switch workspace'));
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
 page.on('pageerror', error => console.error(error));
 page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
 const origin = server.resolvedUrls.local[0];
 const boot = async (owner='1', vaults=[{id:'chosen',name:'Remembered vault'},{id:'other',name:'Other vault'}]) => {
  await page.goto(origin+'__desktop_startup_test.html');
  await page.waitForFunction(()=>typeof window.hydrate==='function');
  assert.equal(await page.getByText('Authenticating', {exact:true}).count(),1);
  await page.evaluate(({owner,vaults})=>window.hydrate(owner,vaults),{owner,vaults});
 };
 await boot();
 await page.getByRole('heading',{name:'Choose a vault'}).waitFor();
 for (const name of ['＋ Create local vault','↗ Join online vault','Open selected vault']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
 await page.getByRole('button',{name:/Remembered vault/}).click();
 await page.getByRole('button',{name:'Open selected vault'}).click();
 await page.getByText('Workspace chosen',{exact:true}).waitFor();
 await boot(); // renderer update/reboot rehydrates auth before restoring
 await page.getByText('Workspace chosen',{exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Choose a vault'}).count(),0);
 await page.getByRole('button',{name:'Switch workspace'}).click();
 await page.evaluate(()=>window.hydrate('1',[{id:'chosen',name:'Remembered vault'},{id:'other',name:'Other vault'}]));
 await page.getByRole('heading',{name:'Choose a vault'}).waitFor();
 await page.getByRole('button',{name:/Other vault/}).click();
 await page.getByRole('button',{name:'Open selected vault'}).click();
 await boot();
 await page.getByText('Workspace other',{exact:true}).waitFor();
 await boot('2');
 await page.getByRole('heading',{name:'Choose a vault'}).waitFor();
 await boot('1', [{id:'chosen',name:'Remembered vault'}]);
 await page.getByRole('heading',{name:'Choose a vault'}).waitFor();
 await page.evaluate(()=>localStorage.setItem('test_active','moved'));
 await boot();
 await page.getByRole('heading',{name:'Choose a vault'}).waitFor();
 console.log('PASS exact chooser, first launch, explicit open, update/reboot hydration, manual chooser survives listing refresh, explicit switch persistence, account isolation, deleted/moved target fallback');
} finally { await browser?.close(); await server.close(); }
