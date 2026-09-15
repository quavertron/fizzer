'use strict';
// Private, bounded PNG publication. Normal browser CSRF upload; bearer-only
// versioned no-invoke creation. Every uncertain network write blocks replay.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateSync } = require('node:zlib');
const { isDeepStrictEqual } = require('node:util');
const fail = code => { throw new Error(code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX = 8 * 1024 * 1024;
const RID = /^[A-Za-z0-9_-]{1,80}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,155}\.png$/;
function png(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX / 3) * 4) fail('invalid_media');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > MAX || bytes.toString('base64') !== data ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') fail('invalid_media');
  let at = 8, width, height, channels, end = false, compressed = [], seenData = false;
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (length > MAX || at + 12 + length > bytes.length || end) fail('invalid_media');
    let crc = 0xffffffff;
    for (const value of bytes.subarray(at + 4, at + 8 + length)) {
      crc ^= value;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(at + 8 + length)) fail('invalid_media');
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (at === 8 && type !== 'IHDR') fail('invalid_media');
    if (type === 'IHDR') {
      if (width || length !== 13) fail('invalid_media');
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
      channels = ({ 2: 3, 6: 4 })[chunk[9]];
      if (!width || !height || width > 8192 || height > 8192 || width * height > 16000000 ||
          chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) fail('invalid_media');
    } else if (type === 'IDAT') { compressed.push(chunk); seenData = true; }
    else if (type === 'IEND') { if (length || !seenData) fail('invalid_media'); end = true; }
    else if (!/^[a-z]/.test(type)) fail('invalid_media');
    at += length + 12;
  }
  if (!end || at !== bytes.length) fail('invalid_media');
  const stride = width * channels + 1, expected = stride * height;
  let pixels; try { pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); } catch { fail('invalid_media'); }
  if (pixels.length !== expected) fail('invalid_media');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) fail('invalid_media');
  return { bytes, sha256: sha(bytes), size: bytes.length, width, height };
}
async function control(input, ctx) {
  const { ownerId, agentId, author, receiptDir, durableWrite, authorize, browser, asset, checkId } = ctx;
  if (input.op === 'mediaCapabilities') {
    if (Object.keys(input).length !== 1) fail('invalid_request');
    await authorize(true);
    return { contract: 'fizzer_media_control_v1', actions: ['mediaUpload', 'mediaSend'], modes: ['apply', 'reconcile'],
      maxBytes: MAX, minImages: 0, maxImages: 4, textOnly: true, formats: ['PNG RGB/RGBA 8-bit noninterlaced'], backendContract: 'channel_png_assets_v1' };
  }
  const fields = input.op === 'mediaUpload' ? ['op', 'mode', 'requestId', 'vaultId', 'channelId', 'name', 'data'] :
    input.op === 'mediaSend' ? ['op', 'mode', 'requestId', 'vaultId', 'channelId', 'body', 'uploads'] : null;
  if (!fields || fields.some(k => !(k in input)) || Object.keys(input).some(k => !fields.includes(k)) ||
      !['apply', 'reconcile'].includes(input.mode) || typeof input.requestId !== 'string' || !RID.test(input.requestId)) fail('invalid_request');
  checkId(input.channelId);
  checkId(input.vaultId);
  const scope = { ...ctx.scope, vaultId: input.vaultId };
  let image;
  if (input.op === 'mediaUpload') {
    if (typeof input.name !== 'string' || !NAME.test(input.name)) fail('invalid_media');
    image = png(input.data);
  } else if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > 8000 || /@|\/compact/i.test(input.body) ||
      !Array.isArray(input.uploads) || input.uploads.length > 4 ||
      input.uploads.some(r => typeof r !== 'string' || !RID.test(r)) || new Set(input.uploads).size !== input.uploads.length) fail('invalid_request');
  const api = await authorize(false, input.vaultId);
  const { notes } = await api(`/api/vaults/${input.vaultId}/notes`);
  if (!Array.isArray(notes) || !notes.some(n => n.id === input.channelId)) fail('note_out_of_scope');
  const { note } = await api(`/api/notes/${input.channelId}`);
  if (note?.id !== input.channelId || note.vault_id !== input.vaultId || note.content !== 'cascade://chat-channel') fail('note_out_of_scope');
  const route = `/api/vaults/${scope.vaultId}/channels/${input.channelId}`;
  const quiet = route + '/messages-no-invoke-v1';
  const capability = await api(quiet);
  if (capability.contract !== 'messages_no_invoke_v1' || capability.mediaContract !== 'channel_png_assets_v1' ||
      capability.actorUserId !== ownerId || capability.vaultId !== scope.vaultId || capability.channelId !== input.channelId) fail('nonping_backend_unsupported');
  const fileFor = id => path.join(receiptDir, sha(JSON.stringify({ scope, mediaRequestId: id })) + '.json');
  function read(file) {
    if (!fs.existsSync(file)) return null;
    const s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) fail('unsafe_receipt');
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('uncertain_write'); }
  }
  async function verifyUpload(r) {
    if (!r || r.op !== 'mediaUpload' || r.channelId !== input.channelId || !r.url) fail('uncertain_write');
    const actual = await asset(r.url, input.channelId);
    if (actual.length !== r.size || sha(actual) !== r.sha256) fail('readback_mismatch');
    return { name: r.name, media_type: 'image/png', data: '', url: r.url };
  }
  const intent = { ...input }; delete intent.mode;
  if (image) intent.data = image.sha256;
  const digest = sha(JSON.stringify(intent)), file = fileFor(input.requestId);
  let r = read(file);
  if (r && r.digest !== digest) fail('idempotency_conflict');
  if (!r && input.mode === 'reconcile') fail('intent_not_found');
  const images = [];
  if (input.op === 'mediaSend') for (const id of input.uploads) images.push(await verifyUpload(read(fileFor(id))));
  if (!r) {
    if (fs.readdirSync(receiptDir).length >= 1000) fail('receipt_limit');
    r = { digest, op: input.op, channelId: input.channelId, ...(image ? { name: input.name,
      sha256: image.sha256, size: image.size, width: image.width, height: image.height } : {}) };
    durableWrite(file, r, true);
    if (image) {
      const result = await browser(`/api/notes/${input.channelId}/assets`, 'POST', { media_type: 'image/png', data: input.data });
      if (typeof result.asset_id !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(result.asset_id) ||
          result.url !== `/api/notes/${input.channelId}/assets/${result.asset_id}`) fail('readback_mismatch');
      r.url = result.url; r.assetId = result.asset_id;
    } else {
      const result = await api(quiet, 'POST', { body: input.body, author, agentId, registrationId: null,
        status: 'completed', replyTo: null, runId: null, blocks: null, images, attachments: [] });
      // Save an authoritative returned ID before checking the rest of the response.
      checkId(result.message?.id); r.id = result.message.id; durableWrite(file, r);
      if (result.contract !== 'messages_no_invoke_v1' || !Array.isArray(result.dispatches) || result.dispatches.length) fail('unexpected_dispatch');
    }
    durableWrite(file, r);
  }
  if (image) {
    await verifyUpload(r);
    return { contract: 'fizzer_media_control_v1', upload: { requestId: input.requestId, channelId: r.channelId,
      assetId: r.assetId, name: r.name, sha256: r.sha256, size: r.size, width: r.width, height: r.height, media_type: 'image/png' } };
  }
  if (!r.id) fail('uncertain_write');
  const { message: m } = await api(route + '/messages/' + r.id);
  if (!m || m.id !== r.id || m.channelId !== input.channelId || m.body !== input.body || m.actorUserId !== ownerId ||
      m.agentId !== agentId || m.author !== author || m.registrationId != null || m.runId != null || m.replyTo != null ||
      m.status !== 'completed' || !isDeepStrictEqual(m.images === null && !images.length ? [] : m.images, images) || (m.attachments || []).length) fail('readback_mismatch');
  return { contract: 'fizzer_media_control_v1', message: m, verifiedUploads: input.uploads };
}
module.exports = { control, png };
