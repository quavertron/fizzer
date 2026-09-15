'use strict';
// Executed as fizzer via sudo, never as the human runner.
const runner = require('./agent-runner.cjs');
const { verifyReadOnlyProject } = require('./agent-account-permissions.cjs');
let input = '', runId;
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.on('SIGTERM', async () => {
  if (runId !== undefined) await runner.cancelLocalAgentRun(runId);
  await runner.shutdownLocalAgentHost();
  process.exit(143);
});
process.stdin.on('end', async () => {
  try {
    const { opts, api, root, grants } = JSON.parse(input);
    input = '';
    runId = opts.runId;
    await verifyReadOnlyProject(root);
    runner.setNoteApiConfig(api);
    const instruction = `\nFile writes are coordinated by alock. You run as the fizzer Unix account. Your working directory is ${JSON.stringify(root)}; it does not restrict these human-authorized write locations: ${JSON.stringify(grants)}. Choose a matching root and its socket. For root "/", /Users/example/file becomes path "Users/example/file". Run /usr/local/libexec/fizzer/alock bridge stage --socket SOCKET --path PATH_RELATIVE_TO_ROOT (no leading slash or ..). Existing files return their baseline; new files return an empty proposal and remain absent until commit. The JSON response contains ticket and file. Edit ONLY that temporary file using any edit tool, then run /usr/local/libexec/fizzer/alock bridge commit --socket SOCKET --ticket TICKET --file TEMP_PATH using the same socket. A new-file commit fails if somebody else created the destination. To delete a file or symlink, stage with --delete, then commit with --delete instead of --file. To replace an existing symlink with a regular file, stage with --replace-symlink and write the new file contents into the proposal. To change an existing symlink's target, stage with --symlink and write only the new target path into the proposal (no trailing newline or NUL). Both symlink operations use the normal --file commit and act on the link itself, never its referent. For missing parent directories run /usr/local/libexec/fizzer/alock bridge mkdir --socket SOCKET --path RELATIVE_DIRECTORY, one parent at a time; mkdir creates a directory immediately and never replaces an existing entry. Stage before editing; tickets expire after 60 seconds. On conflict, stage again and reconcile. Grants do not provide root privileges: unsafe permissions, ACLs, symlink parents and protected system files may still be rejected. Never chmod project files or bypass the bridge. Directory deletion and rename are not supported.\n`;
    let author = String(opts.chatAuthor || opts.agent || 'fizzer').replace(/[\x00-\x1f\x7f]/g, '').trim() || 'fizzer';
    while (Buffer.byteLength(author, 'utf8') > 32) author = [...author].slice(0, -1).join('');
    const quotedAuthor = "'" + author.replaceAll("'", "'\\''") + "'";
    const attribution = `\nREQUIRED: append --author ${quotedAuthor} to EVERY bridge stage, commit and mkdir command above. Alock rejects mutations without --author. The author identifies you in awatch and nab history.\n`;
    const result = await runner.startLocalAgentRun({ ...opts, prompt: opts.prompt + instruction + attribution }, event => output({ event }));
    output({ result });
    await runner.shutdownLocalAgentHost();
    process.exit(0);
  } catch (error) {
    output({ error: error.message });
    await runner.shutdownLocalAgentHost().catch(() => {});
    process.exit(1);
  }
});
