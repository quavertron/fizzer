import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Real App, Sidebar and AccountSettings. HTTP responses are isolated fixtures,
// never production data. Native IPC is a spy; no runner or installer is started.
const server = await createServer({ configFile: new URL('../client/vite.config.js', import.meta.url).pathname, root: new URL('../client', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 } });
const artifacts = process.env.FIZZER_TEST_ARTIFACTS;
if (artifacts) await mkdir(artifacts, {recursive:true});
let browser;
try {
  await server.listen();
  const origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
  let authenticated = false;
  let owner = 1;
  let vaults = [{id:'z',name:'Zebra vault',role:'owner',root_path:''},{id:'a',name:'Alpha vault',role:'owner',root_path:''}];
  let releaseAuth, releaseVaults;
  let authGate = new Promise(r=>{releaseAuth=r;});
  let vaultGate = new Promise(r=>{releaseVaults=r;});
  let vaultFailure = false;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/socket.io')) return route.continue();
    let body = {};
    let status = 200;
    if (url.pathname === '/api/session') { await authGate; body = {authenticated,user:authenticated?{id:owner,username:'fixture',displayName:'Fixture User'}:undefined}; }
    else if (url.pathname === '/api/auth/login') { authenticated=true; body={user:{id:owner,username:'fixture',displayName:'Fixture User'}}; }
    else if (url.pathname === '/api/vaults') {
      await vaultGate;
      if (vaultFailure) {status=503;body={error:'Fixture access lookup failed'};}
      else if (route.request().method()==='POST') { const input=route.request().postDataJSON(); const vault={id:'created',name:input.name,role:'owner',root_path:''}; vaults=[vault];body={vault}; }
      else body={vaults};
    }
    else if (url.pathname.endsWith('/notes')) body={notes:[]};
    else if (url.pathname.endsWith('/folders')) body={folders:[]};
    else if (url.pathname.endsWith('/missions')) body={missions:[]};
    else if (url.pathname.endsWith('/agents')) body={agents:[]};
    else if (url.pathname.endsWith('/members')) body={members:[]};
    else if (url.pathname.includes('updates')) body={counts:{total:0,byVault:{},byTarget:{}},updates:[]};
    else if (url.pathname.startsWith('/socket.io')) {status=503;}
    else {status=404;body={error:'Not part of isolated fixture'};}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.addInitScript(() => {
    window.setupCalls=0; window.frames=[];
    window.electronAPI={getRemoteVaults:async()=>[],rememberServerSession:async()=>{},showAgentAccountSetup:async()=>{window.setupCalls++;}};
    const record=()=>{window.frames.push(document.body?.innerText || '');requestAnimationFrame(record);};requestAnimationFrame(record);
  });
  const shot=async name=>{if(artifacts)await page.screenshot({path:artifacts+'/'+name+'.png',fullPage:true});};
  const noChooser=async()=>assert.equal(await page.getByRole('heading',{name:'Choose a vault',exact:true}).count(),0);
  const active=async id=>page.locator('.vault-rail-button.is-active[data-vault-id="'+id+'"]').waitFor();
  await page.goto(origin+'app.html');
  await page.locator('#auth-pending').waitFor();
  await noChooser();
  releaseAuth();
  await page.locator('#auth-panel').waitFor();
  await shot('signin');
  await page.locator('#username').fill('fixture');
  await page.locator('#password').fill('fixture-not-a-real-password');
  await page.locator('#auth-submit').click();
  await page.locator('#desktop-startup-pending').waitFor();
  assert.ok((await page.evaluate(()=>window.frames)).every(t=>!t.includes('Choose a vault')&&!t.includes('Alpha vault')&&!t.includes('Zebra vault')));
  releaseVaults();
  await active('a'); await noChooser();
  assert.equal(await page.evaluate(()=>window.setupCalls),0);
  await page.getByRole('button',{name:'Open vault Zebra vault',exact:true}).click();
  await active('z'); await shot('sidebar-switcher');
  await page.reload(); await active('z');
  await page.getByTitle('Account settings',{exact:true}).click();
  await page.getByRole('tab',{name:/Preferences/}).click();
  const setup=page.getByRole('button',{name:'Agent file-write coordination (alock)',exact:true});
  await setup.waitFor(); assert.equal(await page.evaluate(()=>window.setupCalls),0);
  await shot('settings-alock'); await setup.click();
  assert.equal(await page.evaluate(()=>window.setupCalls),1);
  await page.getByRole('button',{name:'Close account settings',exact:true}).click();
  // Account-bound saved selection is rejected even when its vault remains accessible.
  owner=2; await page.reload(); await active('a');
  // A failed access lookup is retryable, not an empty-success workspace.
  vaultFailure=true; await page.reload();
  await page.getByText('Could not load workspaces.',{exact:true}).waitFor();
  assert.equal(await page.locator('#sidebar').count(),0);
  vaultFailure=false; vaults=[];
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await page.locator('#sidebar').waitFor();
  await page.getByText('Create or join a vault',{exact:true}).waitFor();
  await noChooser(); await shot('zero-vaults');
  await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await page.getByRole('dialog').waitFor();
  await shot('zero-vault-create');
  await page.getByRole('textbox',{name:'New vault name',exact:true}).fill('Created vault');
  await page.getByRole('textbox',{name:'New vault name',exact:true}).press('Enter');
  await active('created');
  assert.ok((await page.evaluate(()=>window.frames)).every(t=>!t.includes('Choose a vault')));
  assert.deepEqual(errors,[]);
  console.log('PASS real App signin and delayed access, no startup popup/chooser, stable default, existing Sidebar switch + reload persistence, owner isolation, lookup failure/retry, empty-access create dialog, explicit Settings IPC action; isolated fixture screenshots only');
} finally { await browser?.close(); await server.close(); }
