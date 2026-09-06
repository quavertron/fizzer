import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the helpers' permissive flag/value rules and command-specific aliases.
export function parseArgs(argv, aliases = {}) {
  const flags = { json: ['json', true], help: ['help', true], ...aliases };
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') args.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (Object.hasOwn(flags, key)) {
        const [name, value] = flags[key];
        args[name] = value;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) args[key] = true;
        else { args[key] = next; i++; }
      }
    } else args._.push(arg);
  }
  return args;
}

export function httpError(method, path, status, text, message, arrow = '->') {
  let details;
  try { details = text ? JSON.parse(text) : {}; } catch { details = { raw: text }; }
  const description = details?.code === 'revision_conflict' ? JSON.stringify(details) : (details?.error || text);
  return Object.assign(new Error(message ?? `${method} ${path} ${arrow} ${status}: ${description}`), {
    code: typeof details?.code === 'string' ? details.code : 'http_error',
    status, method, path, details,
  });
}

export function createCli(command, aliases) {
  const args = parseArgs(process.argv.slice(2), aliases);
  function fail(error, exitCode = 1) {
    const cause = error?.cause instanceof Error ? ` (${error.cause.message})` : '';
    const message = error instanceof Error ? `${error.message}${cause}` : String(error);
    const code = error?.code || error?.cause?.code || 'cli_error';
    const output = args.json
      ? JSON.stringify({ error: { command, code, message, exitCode,
        ...(error?.status !== undefined ? { status: error.status, method: error.method, path: error.path, details: error.details } : {}),
      } })
      : `${command}: ${message}`;
    process.stderr.write(output + '\n');
    process.exit(exitCode);
  }
  return { args, fail };
}

export function isExpiredJwt(token) {
  if (typeof token !== 'string' || !token) return true;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number') {
      return (Date.now() / 1000) > (payload.exp - 10);
    }
  } catch {
    return false;
  }
  return false;
}

export function readDiskToken() {
  if (process.env.CASCADE_NOTE_TOKEN === '') return '';
  try {
    const p = path.join(os.homedir(), '.cascade', 'token');
    if (fs.existsSync(p)) {
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t && !isExpiredJwt(t)) return t;
    }
  } catch {}
  return '';
}

export function helperConfigPath() {
  const fromEnv = String(process.env.CASCADE_HELPER_CONFIG || '').trim();
  if (fromEnv) return fromEnv;
  const runId = String(process.env.CASCADE_RUN_ID || '').trim();
  if (runId) {
    return path.join(os.homedir(), '.cascade', 'run-contexts', `${runId}.json`);
  }
  const convId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  if (convId) {
    const convPath = path.join(os.homedir(), '.cascade', 'conversations', `${convId}.json`);
    if (fs.existsSync(convPath)) return convPath;
  }
  const defaultPath = path.join(os.homedir(), '.cascade', 'agent-helper-context.json');
  try {
    const runDir = path.join(os.homedir(), '.cascade', 'run-contexts');
    if (fs.existsSync(runDir)) {
      const files = fs.readdirSync(runDir).filter((f) => f.endsWith('.json'));
      let newestFile = '';
      let newestMtime = 0;
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(runDir, f));
          if (stat.mtimeMs > newestMtime) {
            newestMtime = stat.mtimeMs;
            newestFile = path.join(runDir, f);
          }
        } catch {}
      }
      let defaultMtime = 0;
      try {
        defaultMtime = fs.statSync(defaultPath).mtimeMs;
      } catch {}
      const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
      if (newestFile && newestMtime > fifteenMinutesAgo && newestMtime > defaultMtime) {
        return newestFile;
      }
    }
  } catch {}
  return defaultPath;
}

export function readHelperConfig() {
  try {
    const raw = fs.readFileSync(helperConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveToken(argsToken, configToken) {
  if (argsToken) return String(argsToken).trim();
  const envToken = String(process.env.CASCADE_NOTE_TOKEN || '').trim();
  if (envToken && !isExpiredJwt(envToken)) return envToken;
  const cfgToken = String(configToken || '').trim();
  if (cfgToken && !isExpiredJwt(cfgToken)) return cfgToken;
  const diskToken = readDiskToken();
  if (diskToken) return diskToken;
  const explicit = envToken || cfgToken;
  if (explicit && process.env.CASCADE_NOTE_TOKEN !== '') return explicit;
  return '';
}
