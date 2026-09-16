import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// Component + real workspace save/reconcile contract; fixture HTTP is not backend proof.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const fixture = await mkdtemp(path.join(root, '.kanban-completion-test-'));
let server;
let browser;
let saved = '## Queue\n\n- [ ] First\n- [ ] Second\n\n## Accepted\n\n- [ ] Existing\n\n## Done\n';
let revision = 1;
let denied = 0;
try {
  await writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(path.join(fixture, 'main.tsx'), `
    import React, { useSyncExternalStore, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { KanbanView } from '../src/components/KanbanView';
    import { WorkspaceStore, reconcileWorkspaceNoteContent } from '../src/workspace';
    import { emptySession } from '../src/chat/session';
    import '../src/index.css';
    const store = new WorkspaceStore(emptySession());
    store.switchVault('fixture');
    store.openTab({id: 'board', title: 'Board', type: 'note', dirty: false});
    const note = await fetch('/fixture-note').then(r => r.json());
    store.set('noteContents', { board: {note, draft: note.content, baseRevision: note.revision} });
    window.store = store;
    window.remote = () => store.set('noteContents', prev => ({board: reconcileWorkspaceNoteContent(prev.board, {...prev.board.note, content: 'Remote', revision: 'note-v1:99'})}));
    function App() {
      const [, render] = useState(0);
      const [error, setError] = useState('');
      React.useEffect(() => store.subscribe(() => render(n => n + 1)), []);
      const entry = store.active.noteContents.board;
      return <><button onClick={async () => {
        const draft = entry.draft;
        const response = await fetch('/fixture-note', {method:'PUT', body: JSON.stringify({content:draft, expectedRevision:entry.baseRevision})});
        if (!response.ok) {setError('Save rejected ' + response.status); return;}
        store.completeSave('fixture', 'board', draft, await response.json(), store.epoch);
        setError('');
      }}>Save fixture</button><output>{error || (store.active.openTabs[0].dirty ? 'Unsaved' : 'Saved')}</output>
      <KanbanView content={entry.draft} onContentChange={draft => store.set('noteContents', prev => ({board:{...prev.board,draft}}))} />
      <KanbanView content={entry.draft} onContentChange={() => {throw Error('Foreign board accepted drop')}} />
      </>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `);
  server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/fixture-note', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      if (denied || body.expectedRevision !== `note-v1:${revision}`) {
        await route.fulfill({ status: denied || 409, json: { error: 'Rejected fixture save' } });
        return;
      }
      saved = body.content;
      revision++;
    }
    await route.fulfill({ json: { id: 'board', title: 'Board', content: saved, revision: `note-v1:${revision}` } });
  });
  const url = `${server.resolvedUrls.local[0]}${path.basename(fixture)}/index.html`;
  await page.goto(url);
  const board = page.locator('.kanban-view').first();
  const lane = name => board.locator('.kanban-column').filter({ has: page.locator('header strong', { hasText: new RegExp(`^${name}$`) }) });
  const card = name => board.locator('.kanban-card').filter({ hasText: name });
  await board.getByRole('button', { name: 'More options for Accepted' }).click();
  await board.getByRole('menuitemcheckbox', { name: 'Complete cards on entry' }).click();
  assert.equal(await card('Existing').getByRole('button', {name:'Mark complete', exact:true}).count(), 1);
  await page.getByRole('button', {name:'Save fixture'}).click();
  await page.waitForFunction(() => document.querySelector('output').textContent === 'Saved');
  await page.reload();
  await board.getByRole('button', { name: 'More options for Accepted' }).click();
  assert.equal(await board.getByRole('menuitemcheckbox').getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await card('First').dragTo(lane('Accepted').locator('header'));
  assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(), 1);
  await card('First').dragTo(lane('Done').locator('header'));
  assert.equal(await lane('Done').locator('.kanban-card.is-complete').count(), 1);
  await card('Second').dragTo(lane('Done').locator('header'));
  assert.equal(await card('Second').getByRole('button', {name:'Mark complete', exact:true}).count(), 1);
  await card('Second').dragTo(card('Existing'));
  assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(), 1);
  assert.equal(await card('Existing').getByRole('button', {name:'Mark complete', exact:true}).count(), 1);
  // Same-column reorder must leave this unchecked card unchanged.
  await card('Existing').dragTo(card('Second'));
  assert.equal(await card('Existing').getByRole('button', {name:'Mark complete', exact:true}).count(), 1);
  const committedBefore = saved;
  for (const status of [403, 409]) {
    denied = status;
    await page.getByRole('button', {name:'Save fixture'}).click();
    await page.waitForFunction(status => document.querySelector('output').textContent === 'Save rejected ' + status, status);
    assert.equal(saved, committedBefore);
    assert.equal(await page.evaluate(() => window.store.active.openTabs[0].dirty), true);
    assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(), 1);
  }
  // Refresh with newer authoritative content must retain the draft and old base revision.
  const draft = await page.evaluate(() => window.store.active.noteContents.board.draft);
  await page.evaluate(() => window.remote());
  assert.equal(await page.evaluate(() => window.store.active.noteContents.board.draft), draft);
  assert.equal(await page.evaluate(() => window.store.active.noteContents.board.baseRevision), `note-v1:${revision}`);
  // Stale drag after content changed must not act on a reused line index.
  const data = await page.evaluateHandle(() => new DataTransfer());
  await card('Existing').dispatchEvent('dragstart', {dataTransfer:data});
  await card('Existing').getByRole('button', {name:'Mark complete',exact:true}).click();
  const changed = await page.evaluate(() => window.store.active.noteContents.board.draft);
  await lane('Queue').dispatchEvent('drop', {dataTransfer:data});
  assert.equal(await page.evaluate(() => window.store.active.noteContents.board.draft), changed);
  // Cross-board payload alone cannot move another board's line-derived ID.
  await card('Existing').dispatchEvent('dragstart', {dataTransfer:data});
  await page.locator('.kanban-view').last().locator('.kanban-column').first().dispatchEvent('drop', {dataTransfer:data});
  await card('Existing').dispatchEvent('dragend', {dataTransfer:data});
  denied = 0;
  await page.getByRole('button', {name:'Save fixture'}).click();
  await page.waitForFunction(() => document.querySelector('output').textContent === 'Saved');
  await page.reload();
  await card('Second').waitFor();
  assert.equal(await lane('Accepted').locator('.kanban-card.is-complete').count(), 2);
  assert.deepEqual(errors, []);
  console.log('PASS: category opt-in/reload, native background/card drops, no reopen/retroactive/reorder completion, stale/foreign drag rejection, 403/409 draft retention, refresh/retry/reload. Fixture save contract only; App/backend remain separate integration checks.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, {recursive:true, force:true});
}
