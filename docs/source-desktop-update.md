# Source desktop Update build dependencies

The source desktop Update button fetches/rebases while preserving local edits,
then runs `npm run build` before refreshing hosted renderers. The main process
stays alive. Consequently the build contract must reconcile newly pulled
workspace dependencies, even for an already-running older updater.

The root `prebuild` hook runs `npm install --ignore-scripts --include=dev
--no-audit --no-fund` before TypeScript and HTML preview generation. This is an
incremental, lockfile-aware install, not `npm ci`: it does not delete the live
node_modules tree. Explicit dev inclusion supports production-valued desktop
environments. Lifecycle scripts are disabled to avoid recursively running build
hooks or launching native/model installers during Update. Native ABI changes
still belong to the existing explicit native rebuild/installer flow.

Do not move this solely into Electron main: an existing process would keep the
old updater until restarted. Do not skip mandatory third-party licenses to make
a build green. The preview script resolves dependency entry points from the
client workspace, finds their package roots, and copies the actual licenses;
both hoisted and client-local installs work, and missing licenses remain fatal.
The direct `build:html-preview` subcommand expects dependencies already installed.

Focused regression command (no Electron window, server, or model):

```
node --test cascade-electron/main.test.cjs cascade-electron/macos-updater.test.cjs scripts/build-html-preview.test.mjs
```

Source updater fixtures use real local Git remotes and npm, introduce a new
workspace dev dependency after cloning, and run under NODE_ENV=production.
Failing package install/postinstall sentinels prove lifecycle hooks are not run;
existing dirty-work/upstream/conflict preservation assertions remain in place.
Preview fixtures check bundled output, exact license bytes in both layouts,
package export restrictions, and mandatory-license failure.
