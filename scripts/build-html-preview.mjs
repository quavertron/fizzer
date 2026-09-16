import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from the consuming workspace, not an assumed npm hoisting layout.
// LICENSE is often not a public package export; find its owning package root.
export function packageLicense(name, clientManifest) {
  const require = createRequire(clientManifest);
  let directory = dirname(require.resolve(name));
  while (true) {
    try {
      if (JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name === name) {
        return join(directory, 'LICENSE');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate package root for ${name}`);
    directory = parent;
  }
}

export async function buildHtmlPreview(root = fileURLToPath(new URL('../', import.meta.url))) {
  const clientManifest = join(root, 'client/package.json');
  const dompurifyLicense = packageLicense('dompurify', clientManifest);
  const livekitLicense = packageLicense('livekit-client', clientManifest);
  await build({ absWorkingDir: root, entryPoints: ['client/src/htmlPreviewGuard.ts'], bundle: true,
    format: 'iife', minify: true, legalComments: 'inline', outfile: 'backend_elixir/priv/html-preview-guard.js' });
  mkdirSync(join(root, 'client/public/third-party'), { recursive: true });
  copyFileSync(dompurifyLicense, join(root, 'backend_elixir/priv/html-preview-DOMPurify-LICENSE.txt'));
  copyFileSync(dompurifyLicense, join(root, 'client/public/third-party/DOMPurify-LICENSE.txt'));
  copyFileSync(livekitLicense, join(root, 'client/public/third-party/LiveKit-LICENSE.txt'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHtmlPreview();
}
