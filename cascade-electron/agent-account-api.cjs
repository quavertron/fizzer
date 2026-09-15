'use strict';
const http = require('node:http');
const { randomBytes } = require('node:crypto');

// Keep the owner's write-capable vault token out of the agent account. Only
// GETs inside the selected vault are forwarded; all mutations fail closed.
async function startReadOnlyApi(api, vaultId) {
  if (!api?.url || !api?.token || !vaultId) return { config: { url: '', token: '' }, close: async () => {} };
  const origin = new URL(api.url).origin;
  const token = randomBytes(32).toString('hex');
  const prefix = `/api/vaults/${encodeURIComponent(vaultId)}`;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    try {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end('{}'); return; }
      const target = new URL(request.url, origin);
      if (request.method !== 'GET' || target.origin !== origin ||
          /%2f|%5c|%00/i.test(target.pathname) ||
          !(target.pathname === prefix || target.pathname.startsWith(prefix + '/'))) {
        response.writeHead(403).end(JSON.stringify({ error: 'Agent-account API access is read-only and vault-scoped. Use the alock bridge for file edits.' }));
        return;
      }
      const upstream = await fetch(target, {
        headers: { authorization: `Bearer ${api.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      // Context payloads should be small; do not buffer arbitrary file downloads.
      let size = 0;
      for await (const chunk of upstream.body || []) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw new Error('Context response exceeds limit');
        response.write(chunk);
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    config: { url: `http://127.0.0.1:${server.address().port}`, token },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}
module.exports = { startReadOnlyApi };
