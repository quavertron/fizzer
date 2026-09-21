'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
let child, nextId = 0;
const pending = new Map();
function stop(error = new Error('Awatch engine stopped')) {
  const old = child; child = null;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear(); old?.kill();
}
function start() {
  if (child) return child;
  const binary = [process.resourcesPath && path.join(process.resourcesPath, 'embedded-runtime', 'agent-account-setup', 'awatch'),
    path.join(__dirname, '..', '.native-tools', 'awatch')].find(p => p && fs.existsSync(p));
  if (!binary) throw new Error('Build the Awatch Go engine with node scripts/build-awatch.mjs.');
  const processChild = spawn(binary, ['--analyze'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child = processChild;
  processChild.on('error', error => { if (child === processChild) stop(error); });
  processChild.on('exit', () => { if (child === processChild) stop(); });
  processChild.stdin.on('error', error => { if (child === processChild) stop(error); });
  readline.createInterface({ input: processChild.stdout }).on('line', line => {
    try {
      const result = JSON.parse(line), request = pending.get(result.id);
      if (!request) return;
      pending.delete(result.id); clearTimeout(request.timer);
      if (result.error) request.reject(new Error(result.error)); else request.resolve(result);
    } catch (error) { stop(error); }
  });
  return processChild;
}
function analyze(input) {
  for (const key of ['old_lines', 'new_lines']) if (!Array.isArray(input?.[key]) || input[key].some(v => typeof v !== 'string')) return Promise.reject(new Error('Invalid Awatch lines'));
  const id = ++nextId, data = JSON.stringify({ id, old_lines: input.old_lines, new_lines: input.new_lines,
    kind: input.kind, result: input.result, detail: input.detail, conflict_agent: input.conflict_agent,
    agent: input.agent, author: input.author, line_start: input.line_start, line_end: input.line_end,
    conflict_line_start: input.conflict_line_start, conflict_line_end: input.conflict_line_end });
  if (Buffer.byteLength(data) > 4 * 1024 * 1024 || pending.size >= 512) return Promise.reject(new Error('Awatch analysis capacity exceeded'));
  return new Promise((resolve, reject) => {
    const worker = start();
    const timer = setTimeout(() => stop(new Error('Awatch analysis timed out')), 30000);
    pending.set(id, { resolve, reject, timer });
    worker.stdin.write(data + '\n');
  });
}
module.exports = { analyze, stop };
