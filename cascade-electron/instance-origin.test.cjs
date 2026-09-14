const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HOSTED_ORIGIN,
  isSameOrigin,
  parseInstanceOrigin,
  rendererUrlForOrigin,
  resolveInstanceOrigin,
  shouldUseEmbeddedBackend,
} = require('./instance-origin.cjs');

test('packaged desktop defaults to its embedded instance', () => {
  assert.equal(shouldUseEmbeddedBackend({ packaged: true, env: {}, argv: [] }), true);
  assert.equal(resolveInstanceOrigin({ packaged: true, env: {}, argv: [] }), HOSTED_ORIGIN);
  assert.equal(rendererUrlForOrigin(HOSTED_ORIGIN), 'https://cscd.online/app');
});

test('packaged desktop honors an explicit HTTPS self-host', () => {
  assert.equal(
    shouldUseEmbeddedBackend({ packaged: true, env: { CASCADE_APP_URL: 'https://fizzer.example.ts.net:8443/' }, argv: [] }),
    false,
  );
  assert.equal(
    resolveInstanceOrigin({ packaged: true, env: { CASCADE_APP_URL: 'https://fizzer.example.ts.net:8443/' }, argv: [] }),
    'https://fizzer.example.ts.net:8443',
  );
  assert.equal(
    resolveInstanceOrigin({ packaged: true, env: {}, argv: ['--instance-url=https://other.example.test'] }),
    'https://other.example.test',
  );
});

test('source desktop can opt into the embedded instance', () => {
  assert.equal(shouldUseEmbeddedBackend({ packaged: false, env: { FIZZER_EMBEDDED_BACKEND: '1' }, argv: [] }), true);
  assert.equal(shouldUseEmbeddedBackend({ packaged: true, env: { FIZZER_EMBEDDED_BACKEND: '0' }, argv: [] }), false);
});

test('instance validation allows HTTP only on loopback', () => {
  assert.equal(parseInstanceOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(parseInstanceOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(parseInstanceOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  assert.throws(() => parseInstanceOrigin('http://fizzer.example.test'), /must use HTTPS/u);
});

test('instance validation rejects malformed or authority-expanding values', () => {
  for (const value of [
    'fizzer.example.test',
    'file:///tmp/fizzer',
    'https://user:pass@example.test',
    'https://example.test/app',
    'https://example.test/?instance=other',
    'https://example.test/#other',
  ]) {
    assert.throws(() => parseInstanceOrigin(value));
  }
});

test('navigation and runner comparison require the exact selected origin', () => {
  assert.equal(isSameOrigin('https://fizzer.example.test/app', 'https://fizzer.example.test'), true);
  assert.equal(isSameOrigin('https://fizzer.example.test:444/app', 'https://fizzer.example.test'), false);
  assert.equal(isSameOrigin('https://sub.fizzer.example.test/app', 'https://fizzer.example.test'), false);
  assert.equal(isSameOrigin('http://fizzer.example.test/app', 'https://fizzer.example.test'), false);
});
