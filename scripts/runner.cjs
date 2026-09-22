#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const { storageBinary } = require(path.join(__dirname, '..', 'cascade-electron', 'storage-bin.cjs'));

const child = spawn(storageBinary(), ['runner'], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
