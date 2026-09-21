'use strict';
// Interactive provider sign-in for CLI agents. A failed run whose transcript
// says "Not logged in" / "token could not be refreshed" needs a human OAuth
// flow (browser + keychain), so this opens a real terminal running the right
// login command as the account the agent actually runs as:
//   • agent-account enabled  → the agent runs as the locked-down `fizzer` user,
//     which has no login keychain. Codex stores its own auth under fizzer's
//     HOME (`sudo -H -u fizzer codex login`); Claude cannot read a keychain
//     there, so we mint a long-lived token with `claude setup-token` and save
//     it to ~/.fizzer/claude-oauth-token, which agent-account.cjs forwards as
//     CLAUDE_CODE_OAUTH_TOKEN.
//   • agent-account disabled → the agent runs as the human; the provider's
//     normal login command in a terminal is enough.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const account = require('./agent-account.cjs');

const SUPPORTED = new Set(['claude', 'codex']);

function providerBinary(agent) {
  if (agent === 'claude') return process.env.CLAUDE_BIN || 'claude';
  return process.env.CODEX_BIN || 'codex';
}

/** Single-quote a value for safe inclusion in a POSIX shell command. */
function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

function stateDirectory() {
  return process.env.CASCADE_DATA_DIR || path.join(os.homedir(), '.fizzer');
}

/**
 * The bash body run inside the opened terminal. Pure string builder so the
 * command shape is unit-testable without launching a terminal.
 */
function loginScript(agent, enabled, { bin = providerBinary(agent), tokenFile } = {}) {
  if (!SUPPORTED.has(agent)) throw new Error(`Unsupported login agent: ${agent}`);
  const quotedBin = shellQuote(bin);
  if (agent === 'codex') {
    // Codex persists its own auth.json under the runner account's HOME.
    return enabled
      ? `sudo -H -u fizzer ${quotedBin} login`
      : `${quotedBin} login`;
  }
  // Claude
  if (!enabled) {
    return `printf 'Run /login inside Claude to sign in, then /quit to close.\\n\\n'; ${quotedBin}`;
  }
  const file = tokenFile || path.join(stateDirectory(), 'claude-oauth-token');
  const quotedFile = shellQuote(file);
  // setup-token prints a long-lived token after the browser approval. Read it
  // back from the user rather than parsing setup-token's stdout format, then
  // persist it where the fizzer worker looks for it.
  return [
    `mkdir -p ${shellQuote(path.dirname(file))}`,
    `printf 'A browser will open for Claude. Approve it, then copy the printed token.\\n\\n'`,
    `${quotedBin} setup-token || true`,
    `printf '\\nPaste the Claude token above, then press Enter: '`,
    `read -r FIZZER_CLAUDE_TOKEN`,
    `printf '%s\\n' "$FIZZER_CLAUDE_TOKEN" > ${quotedFile}`,
    `chmod 600 ${quotedFile}`,
    `printf '\\nSaved. You can close this window.\\n'`,
  ].join('\n');
}

/** Terminal launcher for the platform, given a script file to execute. */
function terminalInvocation(scriptPath, platform = process.platform) {
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e', `tell application "Terminal" to do script "bash ${scriptPath}"`,
        '-e', 'tell application "Terminal" to activate',
      ],
    };
  }
  if (platform === 'linux') {
    // x-terminal-emulator is the Debian alternative that points at whichever
    // terminal is installed; keep the shell open so the user sees the result.
    return {
      command: 'x-terminal-emulator',
      args: ['-e', 'bash', '-lc', `bash ${shellQuote(scriptPath)}; exec bash`],
    };
  }
  throw new Error('Agent login is not supported on this platform');
}

async function runAgentLogin({ agent, platform = process.platform, enabled = account.enabled(), spawnFn = spawn } = {}) {
  if (!SUPPORTED.has(agent)) throw new Error(`Unsupported login agent: ${agent}`);
  if (platform === 'win32') throw new Error('Agent login is not supported on Windows');
  const script = loginScript(agent, enabled);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fizzer-login-'));
  const scriptPath = path.join(directory, `${agent}-login.sh`);
  fs.writeFileSync(scriptPath, `#!/bin/bash\nset -e\n${script}\n`, { mode: 0o700 });
  const { command, args } = terminalInvocation(scriptPath, platform);
  const child = spawnFn(command, args, { stdio: 'ignore', detached: true });
  child.unref?.();
  return { success: true };
}

module.exports = { runAgentLogin, loginScript, terminalInvocation, providerBinary, SUPPORTED };
