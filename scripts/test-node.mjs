#!/usr/bin/env node
// Keep successful agent/tool output bounded without discarding diagnostics.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const typescript = args[0] === '--typescript';
if (typescript) args.shift();
if (!args.length) {
  console.error('Usage: node scripts/test-node.mjs [--typescript] <test files/options>');
  process.exit(2);
}
const log = join(mkdtempSync(join(tmpdir(), 'fizzer-tests-')), 'diagnostics.log');
console.log(`Full test diagnostics: ${log}`);
const child = spawn(process.execPath, [
  ...(typescript ? ['--import', 'tsx'] : []),
  '--test', '--test-reporter=dot', '--test-reporter-destination=stdout',
  '--test-reporter=spec', `--test-reporter-destination=${log}`, ...args,
], { stdio: 'inherit' });
// Preserve cancellation: never leave test servers/providers behind when the
// calling agent or terminal interrupts the wrapper.
let interruptedSignal;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interruptedSignal = signal;
    child.kill(signal);
  });
}
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  signal ??= interruptedSignal;
  if (code !== 0 && !signal) {
    try { process.stderr.write(readFileSync(log)); }
    catch (error) { console.error(`Cannot read test diagnostics: ${error.message}`); }
  }
  console.log(`\nTests ${code === 0 && !signal ? 'passed' : 'failed'}; full diagnostics: ${log}`);
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
