const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rememberSession } = require('../cascade-electron/server-sessions.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-runner-login-'));
process.env.CASCADE_DATA_DIR = directory;
process.env.CASCADE_TOKEN_PATH = path.join(directory, 'token');
delete process.env.CASCADE_TOKEN;

const { resolveToken, decodeTokenExp, parseRenewedSessionCookie } = require('./desktop-runner-daemon.cjs');

function jwt(exp) {
  const body = Buffer.from(JSON.stringify({ exp, id: 2, access: 'user' })).toString('base64url');
  return `e30.${body}.sig`;
}

test('runner login prefers the newest unexpired credential', t => {
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Math.floor(Date.now() / 1000);
  const expired = jwt(now - 3600);
  const current = jwt(now + 7 * 24 * 60 * 60);
  fs.writeFileSync(process.env.CASCADE_TOKEN_PATH, `${expired}\n`, { mode: 0o600 });
  assert.equal(rememberSession(directory, 'local', current), true);
  assert.equal(resolveToken(), current);
  assert.ok(decodeTokenExp(resolveToken()) > now);

  const longerFile = jwt(now + 2 * 24 * 60 * 60);
  const shorterSession = jwt(now + 60 * 60);
  fs.writeFileSync(process.env.CASCADE_TOKEN_PATH, `${longerFile}\n`, { mode: 0o600 });
  assert.equal(rememberSession(directory, 'local', shorterSession), true);
  assert.equal(resolveToken(), longerFile);
});

test('session renewal keeps the cookie that expires latest', () => {
  const now = Math.floor(Date.now() / 1000);
  const older = jwt(now + 60);
  const newer = jwt(now + 7 * 24 * 60 * 60);
  const chosen = parseRenewedSessionCookie([
    `cascade_session=${encodeURIComponent(older)}; Path=/; HttpOnly`,
    `__Host-cascade_session=${encodeURIComponent(newer)}; Path=/; HttpOnly; Secure`,
  ]);
  assert.equal(chosen, newer);
});
