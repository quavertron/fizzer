import DOMPurify from 'dompurify';

// This code runs in the opaque, trusted OUTER frame. Never evaluate artifact code here.
const source = document.getElementById('artifact')!.textContent!;
const bytes = Uint8Array.from(atob(source), c => c.charCodeAt(0));
const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const parsed = new DOMParser().parseFromString(html, 'text/html');
const scripts = Array.from(parsed.querySelectorAll('script'))
  .filter(s => !s.src && (!s.type || /^(application|text)\/javascript$/i.test(s.type)))
  .map(s => s.textContent || '');
const styles = Array.from(parsed.querySelectorAll('style')).map(s => s.outerHTML).join('');
// Strip nested realms before parsing the artifact, and prohibit all later HTML/script
// sinks using Trusted Types. CSP frame-src alone does NOT block nested srcdoc.
const clean = DOMPurify.sanitize(styles + parsed.body.innerHTML, {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS: ['iframe', 'frame', 'frameset', 'object', 'embed', 'template', 'meta', 'base', 'link'],
  WHOLE_DOCUMENT: false,
});
const frame = document.getElementById('preview') as HTMLIFrameElement;
if (!('trustedTypes' in window)) {
  frame.setAttribute('sandbox', '');
  document.getElementById('notice')!.textContent = 'This browser supports visual preview only. Restricted JavaScript requires Trusted Types support.';
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">${clean}`;
} else {
  const prelude = `for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});`;
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
  // Closing script sequences are escaped in generated JS, never inserted as markup.
  const js = scripts.map(s => `<script>${s.replace(/<\/script/gi, '<\\/script')}</script>`).join('');
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${prelude}</script>${clean}${js}`;
}
