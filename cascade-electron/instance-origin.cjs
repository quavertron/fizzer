const HOSTED_ORIGIN = 'https://cscd.online';
const DEVELOPMENT_ORIGIN = 'http://localhost:5173';

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]';
}

function parseInstanceOrigin(value, label = 'instance URL') {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not include a query or fragment`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${label} must be an origin without a path`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error(`${label} must use HTTPS (plain HTTP is allowed only for loopback)`);
  }
  return parsed.origin;
}

function commandLineInstanceUrl(argv = []) {
  for (const arg of argv) {
    const match = /^--(?:instance-url|APP_URL)=(.*)$/u.exec(String(arg));
    if (match) return match[1];
  }
  return '';
}

function configuredInstanceUrl(env = process.env, argv = process.argv.slice(2)) {
  return String(env.CASCADE_APP_URL || env.APP_URL || commandLineInstanceUrl(argv) || '').trim();
}

function shouldUseEmbeddedBackend({ packaged = false, env = process.env, argv = process.argv.slice(2) } = {}) {
  if (configuredInstanceUrl(env, argv)) return false;

  const override = String(env.FIZZER_EMBEDDED_BACKEND || env.CASCADE_EMBEDDED_BACKEND || '').trim().toLowerCase();
  if (override) return !['0', 'false', 'no', 'off'].includes(override);
  return packaged;
}

function resolveInstanceOrigin({ packaged = false, env = process.env, argv = process.argv.slice(2) } = {}) {
  const configured = configuredInstanceUrl(env, argv);
  const fallback = packaged ? HOSTED_ORIGIN : DEVELOPMENT_ORIGIN;
  return parseInstanceOrigin(configured || fallback, configured ? 'Configured instance URL' : 'Default instance URL');
}

function rendererUrlForOrigin(origin) {
  return `${parseInstanceOrigin(origin)}/app`;
}

function isSameOrigin(value, expectedOrigin) {
  try {
    return new URL(value).origin === parseInstanceOrigin(expectedOrigin);
  } catch {
    return false;
  }
}

module.exports = {
  DEVELOPMENT_ORIGIN,
  HOSTED_ORIGIN,
  isLoopbackHostname,
  isSameOrigin,
  parseInstanceOrigin,
  rendererUrlForOrigin,
  resolveInstanceOrigin,
  shouldUseEmbeddedBackend,
};
