const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');

function alockBinary() {
  if (process.env.FIZZER_ALOCK_BIN) return process.env.FIZZER_ALOCK_BIN;
  return [
    process.resourcesPath && path.join(process.resourcesPath, 'embedded-runtime', 'agent-account-setup', 'alock'),
    path.join(__dirname, '..', '.native-tools', 'alock'),
    '/usr/local/libexec/fizzer/alock',
  ].find(file => file && fs.existsSync(file)) || 'alock';
}

// Subscribe to the existing alock command socket; no separate collector.
function createAwatchViewer(emit, { socketPath = '/tmp/alock/daemon.sock', binary = alockBinary(), retryMs = 2000, batchMs = 50, tail = false } = {}) {
  let socket, retry, flush, closed = false, cursor = {}, pending = [], pendingBytes = 0;
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const readyTimer = setTimeout(() => readyResolve(false), 6000);
  const send = () => {
    clearTimeout(flush);
    flush = null;
    if (pending.length && !closed) emit({ events: pending });
    pending = [];
    pendingBytes = 0;
  };
  let nextEnsure = 0;
  const startCollector = () => {
    if (Date.now() < nextEnsure) return;
    nextEnsure = Date.now() + 2000;
    execFile(binary, ['events', '--ensure'], { timeout: 5000 }, (error, stdout) => {
      if (closed) return;
      if (error) { emit({ status: 'Cannot connect to alock activity: ' + error.message }); return; }
      try { socketPath = JSON.parse(stdout).socket || socketPath; } catch {}
    });
  };
  const connect = () => {
    if (closed) return;
    let buffer = '', connected = false;
    socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify({ cmd: 'watch', cursor, ...(tail && !cursor.Epoch ? { tail: true } : {}) }));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
      socket.setTimeout(5000, () => socket.destroy());
    });
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const packet = JSON.parse(line);
          if (!connected) { connected = true; socket.setTimeout(0); clearTimeout(readyTimer); readyResolve(true); emit({ status: '', connected: true }); }
          if (packet.Event && packet.Cursor?.Epoch && Number.isSafeInteger(packet.Cursor.Seq)) {
            if (packet.Cursor.Epoch === cursor.Epoch && packet.Cursor.Seq <= cursor.Seq) continue;
            cursor = packet.Cursor;
            pending.push({ ...packet.Event, id: packet.Event.id || cursor.Epoch + ':' + cursor.Seq });
            pendingBytes += line.length;
            if (batchMs === 0 || pending.length >= 128 || pendingBytes >= 1024 * 1024) send();
            else if (!flush) flush = setTimeout(send, batchMs);
          } else if ('Status' in packet) {
            if (packet.Cursor?.Epoch && Number.isSafeInteger(packet.Cursor.Seq)) cursor = packet.Cursor;
            if (packet.Status) emit({ gap: packet.Status });
          }
        } catch { socket.destroy(); return; }
      }
      if (buffer.length > 32 * 1024 * 1024) socket.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      send();
      if (closed) return;
      emit({ connected: false, status: 'Reconnecting to alock activity…' });
      if (!connected) startCollector();
      retry = setTimeout(connect, retryMs);
    });
  };
  connect();
  return { ready, close() {
    closed = true;
    clearTimeout(readyTimer);
    readyResolve(false);
    clearTimeout(retry);
    clearTimeout(flush);
    socket?.destroy();
    pending = [];
  } };
}

module.exports = { createAwatchViewer, alockBinary };
