'use strict';

const { execFile } = require('child_process');

const FIZZER_REPOSITORY = 'grm4871/fizzer';
const ISSUE_TITLE_MAX_LENGTH = 256;
const ISSUE_BODY_MAX_LENGTH = 65_536;
const GH_TIMEOUT_MS = 60_000;
const GH_MAX_BUFFER_BYTES = 1024 * 1024;
const ALLOWED_LABELS = new Set(['bug', 'enhancement']);

const ERRORS = Object.freeze({
  missingGh: 'GitHub CLI (gh) is not installed or is not available on PATH.',
  auth: 'GitHub CLI is not authenticated. Run "gh auth login" and try again.',
  permission: `GitHub CLI does not have permission to create issues in ${FIZZER_REPOSITORY}.`,
  general: 'Could not create the GitHub issue. Try again.',
});

function runGh(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function validationError(input) {
  const { title, body, label } = input && typeof input === 'object' ? input : {};
  if (typeof title !== 'string' || title.trim().length === 0) {
    return 'Issue title must not be empty.';
  }
  if (title.length > ISSUE_TITLE_MAX_LENGTH) {
    return `Issue title must be ${ISSUE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    return 'Issue body must not be empty.';
  }
  if (body.length > ISSUE_BODY_MAX_LENGTH) {
    return `Issue body must be ${ISSUE_BODY_MAX_LENGTH} characters or fewer.`;
  }
  if (!ALLOWED_LABELS.has(label)) {
    return 'Issue label must be "bug" or "enhancement".';
  }
  return null;
}

function commandError(error, stderr) {
  if (error && (error.code === 'ENOENT' || error.errno === -2)) return ERRORS.missingGh;

  const detail = `${stderr || ''}\n${error && error.message ? error.message : ''}`;
  if (/not logged (?:in|into)|gh auth login|authentication|bad credentials|http 401/i.test(detail)) {
    return ERRORS.auth;
  }
  if (/http 403|resource not accessible|permission|not authorized|insufficient scope/i.test(detail)) {
    return ERRORS.permission;
  }
  return ERRORS.general;
}

function parseCreatedIssue(stdout) {
  const match = String(stdout || '').match(
    /https:\/\/github\.com\/grm4871\/fizzer\/issues\/([1-9]\d*)\b/,
  );
  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return null;
  return { url: match[0], number };
}

async function createFizzerIssue(input = {}, runner = runGh) {
  const invalid = validationError(input);
  if (invalid) return { ok: false, error: invalid };

  const { title, body, label } = input;
  const args = [
    'issue',
    'create',
    '--repo',
    FIZZER_REPOSITORY,
    '--title',
    title,
    '--body',
    body,
    '--label',
    label,
  ];

  let result;
  try {
    result = await runner('gh', args, {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER_BYTES,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    return { ok: false, error: commandError(error, '') };
  }

  const error = result && result.error;
  const stderr = result && result.stderr;
  if (error) return { ok: false, error: commandError(error, stderr) };

  const issue = parseCreatedIssue(result && result.stdout);
  if (!issue) return { ok: false, error: ERRORS.general };
  return { ok: true, ...issue };
}

module.exports = {
  createFizzerIssue,
  parseCreatedIssue,
  ERRORS,
  FIZZER_REPOSITORY,
  ISSUE_TITLE_MAX_LENGTH,
  ISSUE_BODY_MAX_LENGTH,
  GH_TIMEOUT_MS,
};
