import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
await build({ entryPoints: ['client/src/htmlPreviewGuard.ts'], bundle: true, format: 'iife', minify: true,
  legalComments: 'inline', outfile: 'backend_elixir/priv/html-preview-guard.js' });
mkdirSync('client/public/third-party', { recursive: true });
copyFileSync('node_modules/dompurify/LICENSE', 'backend_elixir/priv/html-preview-DOMPurify-LICENSE.txt');
copyFileSync('node_modules/dompurify/LICENSE', 'client/public/third-party/DOMPurify-LICENSE.txt');
copyFileSync('node_modules/livekit-client/LICENSE', 'client/public/third-party/LiveKit-LICENSE.txt');
