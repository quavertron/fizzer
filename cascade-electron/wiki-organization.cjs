'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = code => { throw new Error(code); };
const contentHash = text => createHash('sha256').update(text).digest('hex');
async function organize(input, c) {
  const fields = { listFolders: ['op'], createFolder: ['op', 'requestId', 'name'],
    moveNote: ['op', 'requestId', 'noteId', 'folderId', 'expectedFolderId', 'expectedContentHash'],
    updateNote: ['op', 'requestId', 'noteId', 'content', 'expectedFolderId', 'expectedContentHash'] }[input.op];
  if (!fields || Object.keys(input).length !== fields.length || fields.some(k => !(k in input))) fail('invalid_request');
  if (input.op !== 'listFolders' && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId))) fail('invalid_request_id');
  if (input.op === 'createFolder' && (typeof input.name !== 'string' || !/^[A-Za-z][A-Za-z -]{0,79}$/.test(input.name))) fail('invalid_title');
  if (['moveNote', 'updateNote'].includes(input.op)) {
    c.checkId(input.noteId);
    for (const id of (input.op === 'moveNote' ? [input.folderId, input.expectedFolderId] : [input.expectedFolderId])) if (id !== null) c.checkId(id);
    if (typeof input.expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedContentHash)) fail('invalid_request');
  }
  if (input.op === 'updateNote' && (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 65536 || input.content.includes('cascade://'))) fail('invalid_note_content');
  await c.authorize();
  await c.privateVault();
  const folders = async () => {
    const { folders: list } = await c.browser(`${c.base}/folders`);
    if (!Array.isArray(list) || list.some(f => f.vault_id !== c.vaultId)) fail('readback_mismatch');
    return list;
  };
  const read = async id => {
    const { notes } = await c.browser(`${c.base}/notes`);
    if (!notes?.some(n => n.id === id)) fail('note_out_of_scope');
    const { note } = await c.browser(`/api/notes/${id}`);
    if (note?.id !== id || note.vault_id !== c.vaultId || typeof note.content !== 'string' || note.content.includes('cascade://') || !note.is_listed) fail('note_out_of_scope');
    return note;
  };
  const list = await folders();
  if (input.op === 'listFolders') return { folders: list };
  if (input.op === 'moveNote' && input.folderId !== null && !list.some(f => f.id === input.folderId)) fail('note_out_of_scope');
  const file = path.join(c.receiptDir, c.hash({ scope: c.scope, requestId: input.requestId }) + '.json');
  const digest = c.hash(input);
  let receipt;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail('unsafe_receipt');
    try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('uncertain_write'); }
    if (receipt.digest !== digest) fail('idempotency_conflict');
    if (!receipt.id) fail('uncertain_write');
  } else {
    if (fs.readdirSync(c.receiptDir).length >= 1000) fail('receipt_limit');
    receipt = { digest };
    if (input.op === 'createFolder') {
      if (list.some(f => f.parent_id === null && f.name === input.name)) fail('wiki_already_exists');
    } else {
      const n = await read(input.noteId);
      if (n.folder_id !== input.expectedFolderId || contentHash(n.content) !== input.expectedContentHash) fail('readback_mismatch');
      receipt.before = { title: n.title, contentHash: contentHash(n.content), folderId: n.folder_id, listed: n.is_listed };
      if (input.op === 'updateNote') {
        if (typeof n.revision !== 'string' || !/^note-v1:[1-9][0-9]*$/.test(n.revision)) fail('readback_mismatch');
        receipt.before.revision = n.revision;
      }
    }
    c.durableWrite(file, receipt, true);
    if (input.op === 'createFolder') {
      const { folder } = await c.browser(`${c.base}/folders`, 'POST', { name: input.name, parent_id: null });
      c.checkId(folder?.id); receipt.id = folder.id;
    } else {
      if (input.op === 'updateNote') await c.browser(`/api/notes/${input.noteId}`, 'PUT', { content: input.content, expectedRevision: receipt.before.revision });
      else await c.browser(`/api/notes/${input.noteId}/move`, 'POST', { folder_id: input.folderId });
      receipt.id = input.noteId;
    }
    c.durableWrite(file, receipt);
  }
  let result;
  if (input.op === 'createFolder') {
    const folder = (await folders()).find(f => f.id === receipt.id);
    if (!folder || folder.name !== input.name || folder.parent_id !== null) fail('readback_mismatch');
    result = { folder };
  } else {
    const note = await read(receipt.id);
    const targetFolder = input.op === 'updateNote' ? input.expectedFolderId : input.folderId;
    const targetHash = input.op === 'updateNote' ? contentHash(input.content) : receipt.before?.contentHash;
    if (!receipt.before || note.folder_id !== targetFolder || note.title !== receipt.before.title ||
      contentHash(note.content) !== targetHash || note.is_listed !== receipt.before.listed ||
      (input.op === 'updateNote' && note.content !== input.content)) fail('readback_mismatch');
    result = { note };
  }
  await c.privateVault();
  return result;
}
module.exports = { organize };
