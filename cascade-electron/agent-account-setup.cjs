'use strict';
const account = require('./agent-account.cjs');

async function offerAgentAccountSetup({ dialog, clipboard, window, packaged, resourcesPath }) {
  if (process.platform === 'win32') return;
  const command = account.setupCommand({ packaged, resourcesPath });
  const { response } = await dialog.showMessageBox(window, {
    type: 'info', title: 'Agent file-write coordination (alock)',
    message: account.enabled() ? 'Agent file-write coordination is enabled' : 'Optional advanced agent setup',
    detail: 'Optional setup creates a separate fizzer account. All agents can create, edit and delete files across your computer through your human-owned alock bridge, without root privileges. Your editors retain write access; direct human edits can still race. Directory deletion, rename and write-capable API helpers are not supported. Setup asks for sudo in your terminal and offers to copy selected provider credentials.\n\nRun this command in a terminal:\n\n' + command,
    buttons: ['Copy setup command', 'Close'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 0) clipboard.writeText(command);

}
module.exports = { offerAgentAccountSetup };
