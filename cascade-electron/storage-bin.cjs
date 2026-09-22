'use strict';
const fs = require('node:fs');
const path = require('node:path');

function storageBinary() {
  if (process.env.FIZZER_STORAGE_BIN) return process.env.FIZZER_STORAGE_BIN;
  return [
    process.resourcesPath && path.join(process.resourcesPath, 'embedded-runtime', 'agent-account-setup', 'fizzer-storage'),
    path.join(__dirname, '..', '.native-tools', 'fizzer-storage'),
    '/usr/local/libexec/fizzer/fizzer-storage',
  ].find(file => file && fs.existsSync(file)) || 'fizzer-storage';
}

function runStorage(args, options = {}) {
  const { execFileSync } = require('node:child_process');
  try {
    const stdout = execFileSync(storageBinary(), args, { encoding: 'utf8', ...options });
    return options.raw ? stdout : JSON.parse(stdout);
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim() || error.message;
    const err = new Error(stderr.replace(/^Error:\s*/, ''));
    if (/ENOENT|no such file/i.test(stderr)) err.code = 'ENOENT';
    throw err;
  }
}

module.exports = { storageBinary, runStorage };
