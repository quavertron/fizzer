#!/usr/bin/env node
'use strict';
// JSON-only client: no token/context file access and no arbitrary HTTP route.
const { request } = require('../cascade-electron/external-agent-access.cjs');
async function main() {
  if (process.argv.length !== 4) throw new Error('usage: node scripts/external-agent-client.cjs SOCKET JSON');
  const result = await request(process.argv[2], JSON.parse(process.argv[3]));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 200) process.exitCode = 1;
}
main().catch(() => { process.stderr.write('external agent request failed\n'); process.exitCode = 1; });
