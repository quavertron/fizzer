import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
const fixture = await mkdtemp(path.join(root, '.note-preview-test-'));
let server;
let browser;
try {
  await writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(path.join(fixture, 'main.tsx'), `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { ChatMessageText } from '../src/components/ChatMarkdown';
    import '../src/index.css';
    window.opens = [];
    createRoot(document.getElementById('root')).render(<ChatMessageText
      messageId="message" body="Read [[Local]], [[Shared]], [[Missing]], [[Slow]], or ![[Card]]."
      mentionableAliases={[]} notes={[
        { id: 'local', title: 'Local' }, { id: 'card', title: 'Card' },
      ]} onOpenNote={id => window.opens.push(id)}
      onOpenSharedNote={async (_message, title) => {
        if (title === 'Slow') await new Promise(resolve => setTimeout(resolve, 600));
        return title === 'Missing' ? null : { id: title, title, content: '**' + title + ' findings**' };
      }} />);
  `);
  server = await createServer({ configFile: false, root, server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let requests = 0;
  await page.route('**/api/notes/*', async route => {
    requests++;
    const id = route.request().url().split('/').pop();
    await route.fulfill({ json: { note: { id, title: id === 'local' ? 'Local' : 'Card', content: '# Full findings\n\nDetailed **evidence**\n\n![remote](https://example.com/image.png)' } } });
  });
  await page.goto(`${server.resolvedUrls.local[0]}${path.basename(fixture)}/index.html`);
  await page.getByRole('button', { name: 'Local', exact: true }).waitFor();
  assert.equal(requests, 0, 'fetch only on expansion');
  await page.getByRole('button', { name: 'Local', exact: true }).click();
  await page.getByRole('heading', { name: 'Full findings' }).waitFor();
  assert.equal(await page.locator('.chat-note-preview strong').last().textContent(), 'evidence');
  assert.equal(await page.locator('.chat-note-preview img').count(), 0, 'external image stays opt-in');
  assert.deepEqual(await page.evaluate(() => window.opens), []);
  await page.getByRole('button', { name: 'Open note', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.opens), ['local']);
  await page.getByRole('button', { name: 'Shared', exact: true }).click();
  await page.getByText('Shared findings', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open note', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Slow', exact: true }).click();
  await page.getByText('Loading note…').waitFor();
  await page.getByRole('button', { name: 'Shared', exact: true }).click();
  await page.waitForTimeout(700);
  assert.equal(await page.getByText('Slow findings', { exact: true }).count(), 0, 'ignore superseded response');
  await page.getByRole('button', { name: 'Missing', exact: true }).click();
  await page.getByText('This note is unavailable.').waitFor();
  await page.getByRole('button', { name: 'Close note preview' }).click();
  assert.equal(await page.locator('.chat-note-preview').count(), 0);
  await page.locator('.chat-doc-embed').click();
  await page.getByRole('heading', { name: 'Full findings' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Linked-note preview: local/shared, lazy fetch, Markdown, missing, stale response, close, open, and embed checks passed.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixture, { recursive: true, force: true });
}
