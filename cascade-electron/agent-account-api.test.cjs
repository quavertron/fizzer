const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startReadOnlyApi } = require('./agent-account-api.cjs');

test('agent context proxy keeps owner token private and rejects API writes and other vaults', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json'); res.end('{"messages":[]}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startReadOnlyApi({ url: `http://127.0.0.1:${upstream.address().port}`, token: 'owner-secret', writeToken: 'human-write-secret' }, 'vault-a');
  try {
    assert.notEqual(proxy.config.token, 'owner-secret');
    assert.equal(JSON.stringify(proxy.config).includes('human-write-secret'), false);
    const headers = { authorization: `Bearer ${proxy.config.token}` };
    assert.equal((await fetch(proxy.config.url + '/api/vaults/vault-a/channels', { headers })).status, 200);
    for (const [method, route] of [['POST', '/api/vaults/vault-a/notes'], ['GET', '/api/vaults/vault-b/channels'], ['GET', '/api/auth/session']]) {
      assert.equal((await fetch(proxy.config.url + route, { method, headers })).status, 403);
    }
    assert.equal((await fetch(proxy.config.url + '/api/vaults/vault-a')).status, 401);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, 'Bearer owner-secret');
  } finally { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});
