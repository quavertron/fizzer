'use strict';

/**
 * Thin wrapper over `fizzer-storage worktree …` (Go). Shared git/gh logic lives
 * there; this file only marshals arguments and keeps the Electron IPC surface.
 *
 * @module cascade-electron/worktrees
 */

const { runStorage } = require('./storage-bin.cjs');

function workspacesRoot() {
  return runStorage(['worktree', 'root'], { raw: true }).trim();
}

function normalizeSlug(input) {
  const result = runStorage(['worktree', 'normalize-slug', JSON.stringify({ input: String(input || '') })]);
  return result === null ? null : result;
}

function resolveRepo(dir) {
  return runStorage(['worktree', 'resolve-repo', JSON.stringify({ dir: dir || '' })]);
}

async function defaultBaseBranch(root) {
  return runStorage(['worktree', 'status', JSON.stringify({ dir: root })]).baseBranch || 'HEAD';
}

async function listWorkspaces(dir) {
  return runStorage(['worktree', 'list', JSON.stringify({ dir: dir || '' })]);
}

async function workspaceStatus(dir) {
  return runStorage(['worktree', 'status', JSON.stringify({ dir: dir || '' })]);
}

async function workspaceDiff(dir) {
  return runStorage(['worktree', 'diff', JSON.stringify({ dir: dir || '' })]);
}

async function workspaceFileDiff(opts = {}) {
  return runStorage(['worktree', 'file-diff', JSON.stringify(opts)]);
}

async function createWorkspace(opts = {}) {
  return runStorage(['worktree', 'create', JSON.stringify(opts)]);
}

async function prepareWorkspace(opts = {}) {
  return runStorage(['worktree', 'prepare', JSON.stringify(opts)]);
}

async function removeWorkspace(opts = {}) {
  return runStorage(['worktree', 'remove', JSON.stringify(opts)]);
}

async function pruneWorkspaces(opts = {}) {
  return runStorage(['worktree', 'prune', JSON.stringify(opts)]);
}

async function createPullRequest(opts = {}) {
  return runStorage(['worktree', 'pr-create', JSON.stringify(opts)]);
}

async function pullRequestStatus(dir) {
  return runStorage(['worktree', 'pr-status', JSON.stringify({ dir: dir || '' })]);
}

module.exports = {
  workspacesRoot,
  normalizeSlug,
  resolveRepo,
  defaultBaseBranch,
  listWorkspaces,
  workspaceStatus,
  workspaceDiff,
  workspaceFileDiff,
  createWorkspace,
  prepareWorkspace,
  removeWorkspace,
  pruneWorkspaces,
  createPullRequest,
  pullRequestStatus,
};
