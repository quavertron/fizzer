import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Render the real Sidebar with controlled activity, without a backend or account.
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Sidebar } from './client/src/components/Sidebar';
    const noop = () => {};
    const folders = [
      { id: 'outer', parent_id: null, name: 'Outer', position: 0 },
      { id: 'inner', parent_id: 'outer', name: 'Inner', position: 0 },
      { id: 'deep', parent_id: 'inner', name: 'Deep', position: 0 },
      { id: 'other', parent_id: null, name: 'Other', position: 1 },
    ];
    const notes = [['direct', 'outer'], ['nested', 'deep'], ['second', 'inner'], ['unlisted', 'other'], ['root', null]]
      .map(([id, folder_id]) => ({ id, folder_id, tags: [], title: id, content_preview: 'cascade://chat-channel', is_listed: id === 'unlisted' ? 0 : 1, position: 0 }));
    let props = {
      user: { id: 1, username: 'one', displayName: 'One' },
      vaults: [{ id: 'vault', name: 'Vault' }], activeVaultId: 'vault',
      folders, notes, activeNoteId: null, showAgentMemory: false,
      updateCounts: { byVault: {}, byTarget: {} }, agentActivity: {}, channelVaultIds: {},
      onSelectNote: id => { window.selections.push(id); update({ activeNoteId: id }); },
      onMoveNote: (...args) => window.moves.push(args),
      onMoveFolder: (...args) => window.moves.push(args),
      onOpenAccount: noop, onOpenDirectMessages: noop, onOpenPublicVaults: noop,
    };
    window.selections = []; window.moves = [];
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
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#folder-outer').waitFor();
  const update = async props => {
    await page.evaluate(next => window.updateSidebar(next), props);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const running = id => page.locator(`#${id} > .activity-dot.is-agent-running`);
  await update({ agentActivity: { direct: 'running' } });
  assert.equal(await running('folder-outer').count(), 1, 'collapsed folder exposes direct running descendant');
  assert.equal(await running('folder-outer').getAttribute('aria-label'), 'Agent work in progress');
  await update({ agentActivity: { nested: 'running', second: 'running' } });
  assert.equal(await running('folder-outer').count(), 1, 'multiple nested descendants produce one dot');
  assert.equal(await running('folder-other').count(), 0, 'unrelated folder stays quiet');
  await page.locator('#folder-outer').click();
  assert.equal(await running('folder-outer').count(), 0, 'expanded parent defers activity to visible descendants');
  assert.equal(await running('folder-inner').count(), 1, 'collapsed inner folder exposes deep activity');
  await page.locator('#folder-inner').click();
  assert.equal(await running('folder-deep').count(), 1);
  assert.equal(await running('note-second').count(), 1);
  await page.locator('#folder-deep').click();
  assert.equal(await running('note-nested').count(), 1, 'expanded path retains existing note indicator');
  await page.locator('#note-nested').click();
  assert.deepEqual(await page.evaluate(() => window.selections), ['nested']);
  await page.locator('#folder-outer').click();
  assert.equal(await running('folder-outer').count(), 1);
  assert.equal(await page.locator('#folder-outer').evaluate(el => el.classList.contains('active')), true, 'collapsed selected ancestor remains selected');
  await update({ agentActivity: { nested: 'finished', second: 'running' } });
  assert.equal(await running('folder-outer').count(), 1, 'one settling descendant does not clear another');
  await update({ agentActivity: { nested: 'finished', second: 'queued', direct: 'finished' }, updateCounts: { byVault: {}, byTarget: { direct: 1 } } });
  assert.equal(await running('folder-outer').count(), 0, 'finished, queued and human updates do not imply running');
  await update({ agentActivity: { nested: 'running' } });
  assert.equal(await running('folder-outer').count(), 1);
  await update({ agentActivity: {} });
  assert.equal(await running('folder-outer').count(), 0, 'removing activity clears the folder dot');
  await update({ agentActivity: { unlisted: 'running', root: 'running', unknown: 'running' } });
  assert.equal(await page.locator('.is-folder > .activity-dot').count(), 0, 'root, unlisted and unknown content do not light unrelated folders');
  assert.deepEqual(await page.locator('.is-folder').evaluateAll(rows => rows.map(row => row.id)), ['folder-outer', 'folder-other'], 'saved folder order is unchanged');
  assert.equal(await page.locator('#folder-outer').getAttribute('draggable'), 'true');
  await page.locator('#folder-outer').click();
  const source = page.locator('#note-second');
  const target = page.locator('#folder-other');
  const box = await target.boundingBox();
  await source.dragTo(target, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  assert.deepEqual(await page.evaluate(() => window.moves), [['second', 'other', 0]], 'note drag still reaches existing move handler');
  assert.deepEqual(errors, []);
  console.log('PASS: direct/nested/multiple activity, expand/collapse, selection, settle/remove clearing, false-signal exclusions, saved folder order and native note drag');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
