'use strict';
// Executed as fizzer via sudo, never as the human runner.
const runner = require('./agent-runner.cjs');
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
    process.env.FIZZER_ALOCK_ACTIVITY_SOCKET = (grants.find(grant => grant.remote) || grants[0]).socket;
    runner.setNoteApiConfig(api);
    const instruction = `\nFile writes are coordinated by alock. You run as the fizzer Unix account. Working directory: ${JSON.stringify(root)}. Human-authorized bridges: ${JSON.stringify(grants)}. Use ${process.env.FIZZER_ALOCK_BIN || '/usr/local/libexec/fizzer/alock'} account stage --socket SOCKET --path RELATIVE_PATH --lines START-END --author AUTHOR, edit only the returned temporary file with your normal editor, then account commit --socket SOCKET --ticket TICKET --file TEMP_PATH --author AUTHOR. The proposal metadata stays beside the temp file as .alock. Local paths are relative to the selected root; for root / omit the leading slash. Remote-vault grants address paths relative to that vault: provide --base LOCAL_BASELINE_FILE or --sha256 CONTENT_SHA256 when staging. The remote daemon is authoritative. Each remote grant supplies mirrorRoot: read baseline files there and pass them with --base. Rclone refreshes that read-only mirror from the server; submit all edits over the remote bridge, never through a local bridge or by modifying mirror files. Stage before editing. Normal locks survive commits until each assistant turn concludes. Use --persistent SECONDS only when needed (maximum 600); these locks survive conclude until their deadline. Commit renews an expired/unclaimed lock only if the complete master content is unchanged and the range is available. On conflict, reread and reconcile. A rejected local commit leaves your edited temp file intact. Configured syntax checks gate acceptance. Use account abort --socket SOCKET --ticket TICKET to release an abandoned proposal. Never chmod project files or bypass the bridge.\n`;
    let author = String(opts.chatAuthor || opts.agent || 'fizzer').replace(/[\x00-\x1f\x7f]/g, '').trim() || 'fizzer';
    while (Buffer.byteLength(author, 'utf8') > 32) author = [...author].slice(0, -1).join('');
    const quotedAuthor = "'" + author.replaceAll("'", "'\\''") + "'";
    const attribution = `\nUse --author ${quotedAuthor} for every account stage and commit command above.\n`;
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
