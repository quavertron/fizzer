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
