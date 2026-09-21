import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}

function copyNotices(source, label, destination) {
  if (!fs.existsSync(source)) return;
  const notices = path.join(destination, 'licenses');
  for (const name of fs.readdirSync(source).filter(name => /^(license|copying|notice)/i.test(name))) {
    if (!fs.statSync(path.join(source, name)).isFile()) continue;
    fs.mkdirSync(notices, { recursive: true });
    const target = path.join(notices, `${label.replaceAll('/', '_')}-${name}`);
    if (fs.existsSync(target)) fs.chmodSync(target, 0o644);
    fs.copyFileSync(path.join(source, name), target);
    fs.chmodSync(target, 0o644);
  }
}

// Bundle non-system shared libraries beside purrvect. Its runtime search path is
// relative to the executable, so installed packages do not depend on Homebrew.
function bundleLibraries(binary, destination) {
  const pending = [binary], copied = new Map();
  while (pending.length) {
    const file = pending.pop();
    const mac = process.platform === 'darwin';
    const result = spawnSync(mac ? 'otool' : 'ldd', mac ? ['-L', file] : [file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || `Cannot inspect ${file}`);
    const dependencies = mac ? result.stdout.split('\n').slice(1).map(line => line.trim().split(' ')[0])
      : [...result.stdout.matchAll(/=>\s+(\/\S+)/g)].map(match => match[1]);
    for (const dependency of dependencies) {
      if (!dependency.startsWith('/') || dependency === file) continue;
      const name = path.basename(dependency);
      if (mac ? /^\/(System|usr\/lib)\//.test(dependency)
        : /^(lib(c|m|pthread|dl|rt|stdc\+\+|gcc_s)\.so|ld-linux)/.test(name)) continue;
      const original = fs.realpathSync(dependency);
      const target = path.join(destination, name);
      if (copied.has(name) && copied.get(name) !== original) throw new Error(`Conflicting shared libraries: ${name}`);
      if (!copied.has(name)) {
        copied.set(name, original);
        fs.copyFileSync(original, target);
        copyNotices(path.dirname(path.dirname(original)), name, destination);
        fs.chmodSync(target, 0o755);
        if (mac) run('install_name_tool', ['-id', `@loader_path/${name}`, target]);
        pending.push(target);
      }
      if (mac) run('install_name_tool', ['-change', dependency, `@loader_path/${name}`, file]);
    }
    if (mac) run('codesign', ['--force', '--sign', '-', file]);
  }
}

export function buildAgentTools(destination = path.join(root, '.native-tools')) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Agent tools support macOS and Linux.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-native-'));
  try {
    for (const name of ['alock', 'nab', 'libdtob', 'awatch', 'fizzer-storage']) {
      fs.cpSync(path.join(root, 'vendor', name), path.join(temporary, name), { recursive: true });
    }
    fs.cpSync(path.join(root, 'tui/vendor/purrvect'), path.join(temporary, 'purrvect'), { recursive: true });
    // Preserve upstream relative include paths while sharing one codec build.
    for (const name of ['alock', 'awatch']) fs.symlinkSync('../libdtob', path.join(temporary, name, 'libdtob'));
    fs.symlinkSync('../nab', path.join(temporary, 'alock', 'nab'));
    run('make', ['libdtob.a', 'CC=cc', 'CFLAGS=-O2 -std=c11 -D_POSIX_C_SOURCE=200809L -Ilib -Isrc'], path.join(temporary, 'libdtob'));
    run('make', ['CC=cc'], path.join(temporary, 'alock'));
    // Standalone nab uses the same tested decoder adapter as embedded nab.
    const wrapper = path.join(temporary, 'nab-main.c');
    fs.writeFileSync(wrapper, '#include "alock/src/nab_embed.c"\nint main(int argc, char **argv) { return alock_nab_main(argc, argv); }\n');
    run('cc', ['-O2', '-std=c11', '-Ilibdtob/lib', wrapper, 'libdtob/libdtob.a', '-o', 'nab/nab'], temporary);
    run('go', ['build', '-mod=readonly', '-trimpath', '-o', 'awatch', '.'], path.join(temporary, 'awatch'), { ...process.env, CGO_ENABLED: '1' });
    run('go', ['build', '-mod=readonly', '-trimpath', '-o', 'fizzer-storage', '.'], path.join(temporary, 'fizzer-storage'), { ...process.env, CGO_ENABLED: '0' });
    run('cmake', ['-S', 'purrvect', '-B', 'purrvect-build', '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=$ORIGIN', '-DBUILD_SHARED_LIBS=OFF'], temporary);
    run('cmake', ['--build', 'purrvect-build', '--parallel', '2'], temporary);
    fs.mkdirSync(destination, { recursive: true });
    if (!fs.existsSync(path.join(destination, 'rclone'))) run(process.execPath, [path.join(root, 'scripts/prepare-rclone.mjs'), destination], root);
    const rustMetadata = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1',
      '--manifest-path', path.join(temporary, 'alock/control/Cargo.toml')], { encoding: 'utf8' });
    if (rustMetadata.status !== 0) throw new Error(rustMetadata.stderr || 'Cannot inspect Rust helper dependencies');
    for (const dependency of JSON.parse(rustMetadata.stdout).packages) {
      copyNotices(path.dirname(dependency.manifest_path), `rust-${dependency.name}-${dependency.version}`, destination);
    }
    const modules = spawnSync('go', ['list', '-m', '-f', '{{.Path}}\t{{.Dir}}', 'all'],
      { cwd: path.join(temporary, 'awatch'), encoding: 'utf8' });
    if (modules.status !== 0) throw new Error(modules.stderr);
    for (const line of modules.stdout.trim().split('\n')) {
      const [name, directory] = line.split('\t');
      if (directory) copyNotices(directory, name, destination);
    }
    for (const name of ['alock', 'nab', 'libdtob', 'awatch', 'purrvect', 'fizzer-storage']) copyNotices(path.join(temporary, name), name, destination);
    for (const [name, source] of Object.entries({ alock: 'alock/alock', nab: 'nab/nab', awatch: 'awatch/awatch', purrvect: 'purrvect-build/purrvect', 'fizzer-storage': 'fizzer-storage/fizzer-storage' })) {
      const target = path.join(destination, name);
      fs.copyFileSync(path.join(temporary, source), target);
      fs.chmodSync(target, 0o755);
    }

    bundleLibraries(path.join(destination, 'purrvect'), destination);
    fs.copyFileSync(path.join(root, 'vendor/DEPENDENCIES.json'), path.join(destination, 'DEPENDENCIES.json'));
    return destination;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  buildAgentTools(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
}
