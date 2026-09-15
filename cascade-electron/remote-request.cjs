'use strict';
function remoteRequest(url, options = {}, timeoutMs = 10_000) {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
}
module.exports = { remoteRequest };
