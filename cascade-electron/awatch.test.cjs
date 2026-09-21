const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createAwatchViewer } = require('./awatch.cjs');

async function waitFor(check) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('run subscription starts at the current tail and resumes from its acknowledged cursor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awatch-tail-'));
  const socketPath = path.join(root, 'events');
  const sockets = [], requests = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.once('data', data => {
      requests.push(JSON.parse(data.subarray(4)));
      socket.write('{"Status":"","Cursor":{"Epoch":"tail","Seq":100}}\n');
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  const viewer = createAwatchViewer(() => {}, { socketPath, tail: true, retryMs: 20 });
  t.after(async () => {
    viewer.close();
    sockets.forEach(socket => socket.destroy());
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(await viewer.ready, true);
  assert.equal(requests[0].tail, true);
  sockets[0].destroy();
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests[1].cursor, { Epoch: 'tail', Seq: 100 });
  assert.equal(requests[1].tail, undefined, 'Reconnect must replay missed events');
});

test('alock socket replay, reconnect cursor, deduplication and independent viewers', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'awatch-gui-'));
  const socketPath = path.join(root,'events');
  const sockets = [], cursors = [], first = [], second = [];
  const packet = seq => JSON.stringify({Cursor:{Epoch:'test',Seq:seq},Event:{kind:'edit',file:'café.ts',old_lines:['before'],new_lines:['after']}}) + '\n';
  const server = net.createServer(socket => {
    sockets.push(socket);
    socket.once('data', data => {
      assert.equal(data.readUInt32LE(0), data.length - 4);
      const request = JSON.parse(data.subarray(4));
      assert.equal(request.cmd, 'watch');
      cursors.push(request.cursor);
      socket.write('{"Status":""}\n');
      // Split a UTF-8 event over socket chunks.
      const bytes = Buffer.from(packet(1));
      const split = bytes.indexOf(Buffer.from('é')) + 1;
      socket.write(bytes.subarray(0,split));
      socket.write(bytes.subarray(split));
      if (cursors.at(-1).Seq) socket.write(packet(2));
    });
  });
  server.listen(socketPath);
  await once(server,'listening');
  const a = createAwatchViewer(message => first.push(message),{socketPath,retryMs:20});
  const b = createAwatchViewer(message => second.push(message),{socketPath,retryMs:20});
  t.after(async () => {
    a.close(); b.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const events = messages => messages.flatMap(message => message.events || []);
  await waitFor(() => events(first).length === 1 && events(second).length === 1);
  assert.equal(events(first)[0].file,'café.ts');
  sockets[0].destroy();
  await waitFor(() => events(first).length === 2);
  assert.deepEqual(cursors.at(-1),{Epoch:'test',Seq:1});
  assert.deepEqual(events(first).map(event => event.id),['test:1','test:2']);
  a.close();
  const count = first.length;
  sockets[1].write(packet(3));
  await waitFor(() => events(second).length === 2);
  assert.equal(first.length,count);
  assert.equal(fs.existsSync(socketPath),true);
  sockets[1].write('{"Status":"History expired"}\n');
  await waitFor(() => second.some(message => message.gap === 'History expired'));
});
