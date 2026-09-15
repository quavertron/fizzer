const test = require('node:test');
const assert = require('node:assert/strict');
const { resumeInstanceSession } = require('./instance-session.cjs');

test('resumes only the selected instance and requests cookie migration', async () => {
  const written = [];
  const user = await resumeInstanceSession('https://example.test', 'saved-token', {
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.test/api/session');
      assert.equal(options.headers['x-cascade-session-migrate'], '1');
      assert.equal(options.headers.authorization, 'Bearer saved-token');
      return { ok: true, json: async () => ({ authenticated: true, user: { id: 7 } }),
        headers: { getSetCookie: () => ['session=value; HttpOnly; Path=/'] } };
    }, cookies: { set: async value => written.push(value) },
  });
  assert.equal(user.id, 7);
  assert.deepEqual(written, [{ url: 'https://example.test/', name: 'session', value: 'value', path: '/', httpOnly: true, secure: true }]);
});

test('a 200 unauthenticated response cannot silently impersonate a local user', async () => {
  await assert.rejects(resumeInstanceSession('https://example.test', 'expired', {
    fetch: async () => ({ ok: true, json: async () => ({ authenticated: false }) }),
    cookies: { set: () => assert.fail('must not install a cookie') },
  }), /Sign in/);
});
