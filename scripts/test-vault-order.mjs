import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Exercise the real Sidebar in a disposable browser; no account or backend required.
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Sidebar } from './client/src/components/Sidebar';
    const noop = () => {};
    let props = {
      user: { id: 1, username: 'one', displayName: 'One' },
      vaults: ['a', 'b', 'c'].map(id => ({ id, name: id, role: 'owner' })),
      activeVaultId: 'a', folders: [], notes: [], activeNoteId: null,
      updateCounts: { byVault: {}, byNote: {} }, agentActivity: {}, channelVaultIds: {},
      onSelectVault: id => { window.selections.push(id); update({ activeVaultId: id }); },
      onOpenAccount: noop, onOpenDirectMessages: noop, onOpenPublicVaults: noop,
    };
    window.selections = [];
    const root = createRoot(document.getElementById('root'));
    function update(next) { props = { ...props, ...next }; root.render(<Sidebar {...props} />); }
    window.updateSidebar = update;
    update({});
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic',
  define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"development"' },
});
const css = await readFile('client/src/index.css', 'utf8') + '\n' + (bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : req.url === '/style.css' ? 'text/css' : 'text/html');
  res.end(req.url === '/app.js' ? bundle.outputFiles.find(file => file.path.endsWith('.js')).text : req.url === '/style.css' ? css : '<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  const rail = id => page.locator(`.vault-rail-button[data-vault-id="${id}"]`);
  const order = async expected => {
    await page.waitForFunction(ids => JSON.stringify([...document.querySelectorAll('.vault-rail-button')].map(el => el.dataset.vaultId)) === JSON.stringify(ids), expected);
  };
  const drag = async (source, target, after = true) => {
    const box = await target.boundingBox();
    await source.dragTo(target, { targetPosition: { x: box.width / 2, y: box.height * (after ? 0.8 : 0.2) } });
  };
  await page.goto(url);
  await order(['a', 'b', 'c']);
  assert.equal(await rail('a').getAttribute('draggable'), 'true', 'vault buttons support direct dragging');
  await drag(rail('a'), rail('c'));
  await order(['b', 'c', 'a']);
  assert.deepEqual(await page.evaluate(() => window.selections), [], 'drag does not select a vault');
  assert.equal(await rail('a').getAttribute('aria-current'), 'page');
  await page.reload();
  await order(['b', 'c', 'a']);
  await drag(rail('a'), rail('b'), false);
  await order(['a', 'b', 'c']);
  await rail('b').click();
  assert.equal(await rail('b').getAttribute('aria-current'), 'page');
  await page.getByRole('button', { name: 'Manage vaults', exact: true }).click();
  const cards = page.locator('.vault-manager-row > button:first-child');
  await drag(cards.nth(2), cards.nth(0), false);
  await order(['c', 'a', 'b']);
  assert.deepEqual(await cards.allTextContents().then(items => items.map(s => s.trim().slice(0, 1))), ['c', 'a', 'b']);
  await cards.nth(0).click();
  assert.equal(await rail('c').getAttribute('aria-current'), 'page');
  assert.equal(await cards.count(), 0, 'switcher click still closes the dialog');
  await page.evaluate(() => window.updateSidebar({ vaults: ['a', 'c', 'd'].map(id => ({ id, name: id })) }));
  await order(['c', 'a', 'd']);
  await page.evaluate(() => window.updateSidebar({ user: { id: 2, username: 'two' } }));
  await order(['a', 'c', 'd']);
  await drag(rail('d'), rail('a'), false);
  await order(['d', 'a', 'c']);
  await page.evaluate(() => window.updateSidebar({ user: { id: 1, username: 'one' } }));
  await order(['c', 'a', 'd']);
  // A note drag is not a vault reorder.
  await rail('a').dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => { const data = new DataTransfer(); data.setData('application/x-cascade-note', 'c'); return data; }) });
  await order(['c', 'a', 'd']);
  await drag(rail('a'), rail('a'));
  await order(['c', 'a', 'd']);
  // Bad/obsolete preferences must not hide or duplicate vaults.
  await page.evaluate(() => localStorage.setItem('cascade_vault_order:1', '["c","c","gone",42]'));
  await page.reload();
  await order(['c', 'a', 'b']);
  await page.evaluate(() => localStorage.setItem('cascade_vault_order:1', '{broken'));
  await page.reload();
  await order(['a', 'b', 'c']);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('storage unavailable'); }; });
  await drag(rail('c'), rail('a'), false);
  await order(['c', 'a', 'b']);
  assert.deepEqual(errors, []);
  console.log('PASS: native drag both directions, rail/dialog parity, reload persistence, selection/click, new/deleted IDs, account isolation, foreign/self drops, malformed and unavailable storage');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
