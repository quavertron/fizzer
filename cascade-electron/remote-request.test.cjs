const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { remoteRequest } = require('./remote-request.cjs');

test('remote requests time out while waiting for headers or a stalled body', async t => {
  const server = http.createServer((request, response) => {
    if (request.url === '/body') { response.writeHead(200); response.write('{'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(remoteRequest(`${origin}/headers`, {}, 50), /timeout|aborted/i);
  const response = await remoteRequest(`${origin}/body`, {}, 50);
  await assert.rejects(response.text(), /timeout|aborted/i);
});
