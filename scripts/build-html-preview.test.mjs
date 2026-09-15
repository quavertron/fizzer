import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildHtmlPreview } from './build-html-preview.mjs';

for (const layout of ['hoisted', 'workspace']) {
  test(`preview bundles and preserves mandatory licenses with ${layout} dependencies`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fizzer-preview-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const put = (relative, body) => {
      const file = join(root, relative);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, body);
    };
    put('client/package.json', '{"name":"client","type":"module"}');
    put('client/src/htmlPreviewGuard.ts', 'globalThis.previewGuard = true;');
    const modules = layout === 'hoisted' ? 'node_modules' : 'client/node_modules';
    for (const name of ['dompurify', 'livekit-client']) {
      put(`${modules}/${name}/package.json`, JSON.stringify({ name, exports: './dist/index.js' }));
      put(`${modules}/${name}/dist/index.js`, 'module.exports = {};');
      put(`${modules}/${name}/LICENSE`, `${name} license fixture\n`);
    }
    await buildHtmlPreview(root);
    assert.match(readFileSync(join(root, 'backend_elixir/priv/html-preview-guard.js'), 'utf8'), /previewGuard/);
    for (const [output, name] of [
      ['backend_elixir/priv/html-preview-DOMPurify-LICENSE.txt', 'dompurify'],
      ['client/public/third-party/DOMPurify-LICENSE.txt', 'dompurify'],
      ['client/public/third-party/LiveKit-LICENSE.txt', 'livekit-client'],
    ]) assert.equal(readFileSync(join(root, output), 'utf8'), `${name} license fixture\n`);
    rmSync(join(root, modules, 'livekit-client/LICENSE'));
    await assert.rejects(buildHtmlPreview(root), { code: 'ENOENT' });
  });
}
