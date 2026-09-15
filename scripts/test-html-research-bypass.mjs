import { chromium } from 'playwright';
import assert from 'node:assert/strict';
// Research design counterexample. No actual network ICE servers used.
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 await page.setContent(`<iframe sandbox="allow-scripts" id="guard"></iframe>`);
 const artifact = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; style-src 'unsafe-inline'"><body><script>
 for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) Object.defineProperty(window,key,{value:undefined,writable:false,configurable:false});
 const child=document.createElement('iframe');
 child.srcdoc='<script>try {const p=new RTCPeerConnection({iceServers:[]});top.postMessage({bypass:true,state:p.signalingState},"*");p.close();}catch(e){top.postMessage({bypass:false,error:e.name},"*");}<\\/script>';
 document.body.appendChild(child);
 </script>`;
 const guard = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'"><iframe sandbox="allow-scripts" srcdoc="${artifact.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}"></iframe>`;
 const result = await page.evaluate(guard=>new Promise(resolve=>{addEventListener('message',e=>resolve(e.data),{once:true});document.querySelector('#guard').srcdoc=guard;}),guard);
 console.log(JSON.stringify(result)); assert.equal(result.bypass,true);
} finally { await browser.close(); }
