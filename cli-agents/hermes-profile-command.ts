import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Local opt-in only. Never cache routes or turn a broken route into normal Hermes. */
export function getHermesProfileCommand(
  profile: string,
  configPath = path.join(os.homedir(), '.cascade', 'hermes-profile-commands.json'),
): string | undefined {
  const fail = (reason: string): never => {
    // Do not include configuration contents or underlying OS errors in diagnostics.
    throw new Error(`Hermes profile command routing: ${reason}.`);
  };
  if (profile && !profilePattern.test(profile)) fail('invalid profile');
  let fd: number | undefined;
  try {
    // An absent opt-in must not change ordinary Hermes on any desktop platform.
    try {
      fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return fail('cannot securely open config');
    }
    if (typeof process.getuid !== 'function') {
      return fail('profile command routing requires POSIX ownership checks');
    }
    let directory;
    try { directory = fs.lstatSync(path.dirname(configPath)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return fail('cannot inspect config directory');
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) {
      fail('config directory must be owned by the current user and not writable by others');
    }
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) {
      fail('config must be a private regular file owned by the current user');
    }
    if (info.size > 65536) fail('config exceeds 64 KiB');
    const config: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!record(config) || config.version !== 1 || !record(config.profiles)
      || Object.keys(config).some(key => key !== 'version' && key !== 'profiles')) {
      return fail('invalid config schema');
    }
    for (const [name, mapping] of Object.entries(config.profiles)) {
      if (!profilePattern.test(name) || !record(mapping) || Object.keys(mapping).length !== 1
        || typeof mapping.command !== 'string' || !path.isAbsolute(mapping.command)
        || mapping.command.includes('\0')) {
        fail('invalid profile mapping');
      }
    }
    if (!profile || !Object.hasOwn(config.profiles, profile)) return undefined;
    const command = (config.profiles[profile] as { command: string }).command;
    // A launcher may itself be a symlink; its resolved target must be executable and regular.
    if (!fs.statSync(command).isFile()) fail('configured command is not a regular file');
    fs.accessSync(command, fs.constants.X_OK);
    return command;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Hermes profile command routing:')) throw error;
    return fail('config is invalid or configured command is unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
