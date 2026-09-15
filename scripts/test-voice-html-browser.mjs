import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const c = JSON.parse(process.env.FIZZER_MEDIA_FIXTURE);
const base = `/api/vaults/${c.vault}/channels/${c.channel}`;
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import ReactDOM from 'react-dom/client';import {VoiceRoom} from '/src/components/VoiceRoom.tsx';import {HtmlAttachment} from '/src/components/HtmlAttachment.tsx';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.showVoice=()=>root.render(React.createElement(VoiceRoom,{vaultId:${JSON.stringify(c.vault)},channelId:${JSON.stringify(c.channel)}}));
window.showHTML=attachment=>root.render(React.createElement(HtmlAttachment,{attachment}));window.showVoice();
</script></body></html>`;
const server = await createServer({ root: new URL('../client', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0 },
 plugins: [{ name:'media-fixture', configureServer(s) { s.middlewares.use(async (req,res,next) => {
  if (req.url === '/fixture.html') { res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml(req.url,fixture));return; }
  if (req.url?.startsWith('/api/')) {
   const parts=[];for await (const part of req) parts.push(part);
   const headers={...req.headers};delete headers.host;delete headers['content-length'];delete headers['accept-encoding'];
   const r=await fetch(c.upstream+req.url,{method:req.method,headers,body:parts.length?Buffer.concat(parts):undefined});
   res.statusCode=r.status;for(const [k,v] of r.headers) if(!['content-length','content-encoding','transfer-encoding'].includes(k))res.setHeader(k,v);
   res.end(Buffer.from(await r.arrayBuffer()));return;
  } next();
 });} }],
});
const synthetic = ({denied=false}={}) => {
 window.fixtureStreams=[]; window.fixturePCs=[];
 window.fixtureSockets=[];const NativeWS=window.WebSocket;
 window.WebSocket=class extends NativeWS {constructor(...args){super(...args);window.fixtureSockets.push(this);}};
 const Native=window.RTCPeerConnection;
 const relayConfig=config=>({...config,iceTransportPolicy:'relay',iceServers:(config?.iceServers||[]).filter(s=>/turn:(127\.|172\.|10\.|192\.168\.)/.test(JSON.stringify(s.urls)))});
 window.RTCPeerConnection=class extends Native {constructor(config,...args){super(relayConfig(config),...args);window.fixturePCs.push(this);}setConfiguration(config){return super.setConfiguration(relayConfig(config));}};
 Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[{deviceId:'default',kind:'audioinput',label:'Synthetic oscillator',groupId:'fixture',toJSON(){return this;}}]});
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async constraints=>{
  if(denied)throw new DOMException('Fixture permission denial','NotAllowedError');
  if(constraints.video)throw new Error('No video permitted');
  const ctx=new AudioContext();const osc=ctx.createOscillator();osc.frequency.value=440;
  const dest=ctx.createMediaStreamDestination();osc.connect(dest);osc.start();await ctx.resume();
  const stream=dest.stream;window.fixtureStreams.push(stream);stream.getTracks().forEach(t=>{const stop=t.stop.bind(t);t.stop=()=>{stop();osc.stop();void ctx.close();};});return stream;
 }});
};
const receipt={};let browser;
const output=process.env.FIZZER_MEDIA_OUTPUT;
if(output)fs.mkdirSync(output,{recursive:true,mode:0o700});
try {
 await server.listen();const origin=server.resolvedUrls.local[0];
 browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required',...(output?[`--log-net-log=${path.join(output,'browser-netlog.json')}`]:[])]});
 const contexts=[];const pages=[];
 for(const [i,token] of c.tokens.entries()) {
  const context=await browser.newContext();contexts.push(context);
  await context.addCookies([{name:'cascade_session',value:token,url:origin}]);await context.addInitScript(synthetic,{});
  const page=await context.newPage();pages.push(page);await page.goto(origin+'fixture.html');
  await page.getByRole('button',{name:'Join voice',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.fixtureStreams.length),0);
  await page.getByRole('button',{name:'Join voice',exact:true}).click();
  try {await page.getByRole('button',{name:'Mute',exact:true}).waitFor({timeout:20000});}catch(e){console.error(await page.locator('body').innerText());console.error(await page.evaluate(()=>window.fixturePCs.map(p=>({state:p.connectionState,ice:p.iceConnectionState,servers:p.getConfiguration().iceServers?.map(s=>s.urls)}))));throw e;}
 }
 let [a,b]=pages;
 await b.waitForFunction(()=>document.querySelectorAll('audio').length>0);
 await b.evaluate(()=>{const ctx=new AudioContext();const analyser=ctx.createAnalyser();ctx.createMediaStreamSource(document.querySelector('audio').srcObject).connect(analyser);window.fixtureAnalyser=analyser;window.fixtureAnalyserContext=ctx;});
 const energy=()=>b.evaluate(()=>{const x=new Float32Array(window.fixtureAnalyser.fftSize);window.fixtureAnalyser.getFloatTimeDomainData(x);return Math.sqrt(x.reduce((s,n)=>s+n*n,0)/x.length);});
 await b.waitForFunction(()=>{const x=new Float32Array(window.fixtureAnalyser.fftSize);window.fixtureAnalyser.getFloatTimeDomainData(x);return x.some(n=>Math.abs(n)>0.01);});
 receipt.audioEnergy=await energy();assert.ok(receipt.audioEnergy>0.01);
 receipt.inboundRtp=await b.evaluate(async()=>{const result=[];for(const pc of window.fixturePCs)for(const s of (await pc.getStats()).values())if(s.type==='inbound-rtp'&&s.kind==='audio')result.push({bytes:s.bytesReceived,packets:s.packetsReceived,connectionState:pc.connectionState,iceConnectionState:pc.iceConnectionState});return result;});
 assert.ok(receipt.inboundRtp.some(s=>s.bytes>100&&s.connectionState==='connected'));
 receipt.selectedCandidates=await b.evaluate(async()=>{const result=[];for(const pc of window.fixturePCs){const stats=await pc.getStats();for(const s of stats.values())if(s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded'){const candidate=stats.get(s.localCandidateId);result.push({type:candidate.candidateType,protocol:candidate.protocol,address:candidate.address});}}return result;});
 assert.ok(receipt.selectedCandidates.length>0&&receipt.selectedCandidates.every(s=>s.type==='relay'));
 await a.getByRole('button',{name:'Mute',exact:true}).click();
 await a.getByRole('button',{name:'Unmute',exact:true}).waitFor();
 await b.waitForFunction(()=>document.querySelector('[aria-label="Voice participants"]').textContent.includes('(muted)'));
 await a.getByRole('button',{name:'Unmute',exact:true}).click();
 await b.getByRole('button',{name:'Deafen',exact:true}).click();
 await b.getByRole('button',{name:'Undeafen',exact:true}).waitFor();
 assert.equal(await b.locator('audio').evaluateAll(es=>es.every(e=>e.muted)),true);
 assert.equal(await b.evaluate(()=>window.fixtureStreams.flatMap(s=>s.getAudioTracks()).every(t=>!t.enabled||t.readyState==='ended')),true);
 await b.getByRole('button',{name:'Undeafen',exact:true}).click();
 // Close the actual signaling websocket using CDP network interruption and wait
 // for the UI's real reconnect state, not merely a connected state that never left.
 await contexts[0].setOffline(true);
 await a.waitForTimeout(1000);
 await a.evaluate(()=>window.fixtureSockets.filter(s=>s.url.includes(':17880/')).forEach(s=>s.close(4000,'fixture disconnect')));
 await a.getByRole('status').filter({hasText:'Reconnecting'}).waitFor({timeout:15000});
 await contexts[0].setOffline(false);
 await a.getByRole('status').filter({hasText:'Connected'}).waitFor({timeout:30000});
 receipt.reconnect=true;
 await a.getByRole('button',{name:'Leave voice',exact:true}).click();
 await a.getByRole('button',{name:'Join voice',exact:true}).waitFor();
 assert.equal(await a.evaluate(()=>window.fixtureStreams.flatMap(s=>s.getTracks()).every(t=>t.readyState==='ended')),true);
 await b.waitForFunction(()=>document.querySelectorAll('[aria-label="Voice participants"] li').length===1);
 await a.getByRole('button',{name:'Join voice',exact:true}).click();
 await a.getByRole('button',{name:'Mute',exact:true}).waitFor();
 await b.waitForFunction(()=>document.querySelectorAll('[aria-label="Voice participants"] li').length===2);
 const revokeStart=Date.now();const revoked=await fetch(c.upstream+'/fixture/revoke',{method:'POST',headers:{'x-fixture-key':c.key}});assert.equal(revoked.status,200);
 await b.getByRole('button',{name:'Join voice',exact:true}).waitFor({timeout:15000});
 receipt.revocationLatencyMs=Date.now()-revokeStart;
 await b.getByRole('button',{name:'Join voice',exact:true}).click();
 await b.getByRole('alert').waitFor();receipt.revocation=true;
 await a.getByRole('button',{name:'Leave voice',exact:true}).click();
 const denied=await browser.newContext();await denied.addCookies([{name:'cascade_session',value:c.tokens[0],url:origin}]);await denied.addInitScript(synthetic,{denied:true});
 const dp=await denied.newPage();await dp.goto(origin+'fixture.html');await dp.getByRole('button',{name:'Join voice',exact:true}).click();await dp.getByRole('alert').filter({hasText:'NotAllowedError'}).waitFor();receipt.permissionDenial=true;
 await denied.close();

 // HTML security runs in a fresh context with NO media/API overrides.
 const htmlContext=await browser.newContext();
 await htmlContext.addCookies([{name:'cascade_session',value:c.tokens[0],url:origin}]);
 contexts[0]=htmlContext;a=await htmlContext.newPage();await a.goto(origin+'fixture.html');
 await a.waitForFunction(()=>typeof window.showHTML==='function');

 // Actual CLI -> authenticated HTTP upload -> persisted message -> exact bytes.
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fizzer-html-cli-'));
 const html=`<!doctype html><style>body{font:18px system-ui;background:#eaf4fa}#panel{padding:20px}</style><div id="panel"><button id="toggle">Split view</button><p id="state">Single</p><form id="form"><input id="entry"><button>Save</button></form><p id="value"></p><details><summary>Details</summary>Local content</details></div><script>document.getElementById('toggle').addEventListener('click',()=>document.getElementById('state').textContent='Split');document.getElementById('form').addEventListener('submit',e=>{e.preventDefault();document.getElementById('value').textContent=document.getElementById('entry').value;});</script>`;
 const file=path.join(temporary,'interactive.html');fs.writeFileSync(file,html);
 let cliOut='';try {
  await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['cli-agents/cascade-chat','send','--url',c.upstream,'--vault',c.vault,'--channel',c.channel,'--message','Synthetic HTML attachment','--file',file],{env:{...process.env,CASCADE_NOTE_TOKEN:c.agent,CASCADE_HELPER_CONFIG:'',CASCADE_RUN_ID:'',CASCADE_HELPER_PORT:''}});p.stdout.on('data',x=>cliOut+=x);p.stderr.on('data',x=>cliOut+=x);p.on('close',code=>code===0?resolve():reject(new Error(cliOut)));});
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 const sentId=/sent (\S+)/.exec(cliOut)?.[1];assert.ok(sentId,cliOut);
 const metadata=await (await fetch(c.upstream+base+'/messages/'+sentId,{headers:{authorization:'Bearer '+c.agent}})).json();const attachment=metadata.message.attachments[0];
 assert.equal(await (await fetch(c.upstream+attachment.url,{headers:{authorization:'Bearer '+c.agent}})).text(),html);
 await a.evaluate(x=>window.showHTML(x),attachment);await a.getByRole('button',{name:'Preview HTML',exact:true}).click();
 const outer=a.frameLocator('iframe');const inner=outer.frameLocator('#preview');
 await inner.getByRole('button',{name:'Split view',exact:true}).click();assert.equal(await inner.locator('#state').textContent(),'Split');
 await inner.locator('#entry').fill('Local form works');await inner.getByRole('button',{name:'Save',exact:true}).click();assert.equal(await inner.locator('#value').textContent(),'Local form works');
 receipt.cliUploadDownload=true;receipt.localInteraction=true;
 if(output)await a.screenshot({path:path.join(output,'interactive-preview.png'),fullPage:true});
 if(process.env.FIZZER_ORIGINAL_HTML_FIXTURE){
  const original=fs.readFileSync(process.env.FIZZER_ORIGINAL_HTML_FIXTURE);
  const r=await fetch(c.upstream+base+'/html-assets-v1',{method:'POST',headers:{authorization:'Bearer '+c.agent,'content-type':'application/json'},body:JSON.stringify({media_type:'text/html',filename:'session-monitor.html',data:original.toString('base64')})});assert.equal(r.status,201);
  await a.evaluate(x=>window.showHTML(x),await r.json());
  await inner.getByRole('button',{name:'Split view',exact:true}).click();
  await inner.getByRole('button',{name:'Single pane',exact:true}).waitFor();
  await inner.locator('[data-session="Sol"]').click();assert.match(await inner.locator('#fm-active').textContent(),/^Sol/);
  await inner.locator('#fm-input').fill('Synthetic steering');await inner.locator('#fm-form button').click();
  assert.match(await inner.locator('#fm-notice').textContent(),/preview|Preview/);
  receipt.originalSessionMonitor=true;
  if(output)await a.screenshot({path:path.join(output,'original-session-monitor.png'),fullPage:true});
 }
 const hostile=`<!doctype html><iframe srcdoc="<script>top.postMessage('static-bypass','*')</script>"></iframe><link rel="dns-prefetch" href="//hostile.invalid"><link rel="preconnect" href="https://hostile.invalid"><img src="https://hostile.invalid/image"><style>@import url('https://hostile.invalid/css');</style><body><script>
 const checks={};const attempt=(key,fn)=>{try{fn();checks[key]='allowed';}catch(e){checks[key]=e.name;}};
 attempt('parentDOM',()=>parent.document.body.textContent);attempt('storage',()=>localStorage.setItem('x','y'));attempt('cookie',()=>document.cookie='x=y');
 attempt('rtc',()=>new RTCPeerConnection({iceServers:[]}));checks.fetch='pending';fetch('https://hostile.invalid/fetch').then(()=>checks.fetch='network-response',e=>checks.fetch=e.name);checks.socket='pending';try{const ws=new WebSocket('wss://hostile.invalid/socket');ws.onerror=()=>checks.socket='blocked';ws.onopen=()=>checks.socket='network-connected';}catch(e){checks.socket=e.name;}
 attempt('srcdoc',()=>{const f=document.createElement('iframe');f.srcdoc='<script>new RTCPeerConnection()<\\/script>';document.body.append(f);});
 attempt('innerHTML',()=>document.body.innerHTML='<iframe></iframe>');attempt('policy',()=>trustedTypes.createPolicy('evil',{createHTML:x=>x}));checks.popup=window.open('https://hostile.invalid/popup')===null?'blocked':'opened';
 attempt('blankRealm',()=>{const f=document.createElement('iframe');document.body.append(f);try{new f.contentWindow.RTCPeerConnection({iceServers:[]});}finally{f.remove();}});
 attempt('topNav',()=>top.location='https://hostile.invalid/top');window.results=checks;
 </script>`;
 const up=await fetch(c.upstream+base+'/html-assets-v1',{method:'POST',headers:{authorization:'Bearer '+c.agent,'content-type':'application/json'},body:JSON.stringify({media_type:'text/html',filename:'hostile.html',data:Buffer.from(hostile).toString('base64')})});assert.equal(up.status,201);const hostileAsset=await up.json();
 const external=[];await contexts[0].route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname==='hostile.invalid'){external.push(u.pathname);return route.abort();}return route.continue();});
 await a.evaluate(x=>window.showHTML({...x,name:'hostile.html'}),hostileAsset);
 // Component persists its open state; the changed src should load the new guard.
 await inner.locator('body').waitFor();
 const artifact=()=>a.frames().find(f=>f.parentFrame()?.url().includes('/api/html-previews/'));
 await a.waitForTimeout(300);
 const hostileFrame=artifact();assert.ok(hostileFrame);
 await hostileFrame.waitForFunction(()=>window.results&&window.results.fetch!=='pending'&&window.results.socket!=='pending');
 receipt.hostile=await hostileFrame.evaluate(()=>window.results);
 assert.equal(receipt.hostile.parentDOM,'SecurityError');assert.equal(receipt.hostile.storage,'SecurityError');assert.equal(receipt.hostile.rtc,'TypeError');assert.equal(receipt.hostile.srcdoc,'TypeError');assert.equal(receipt.hostile.innerHTML,'TypeError');assert.equal(receipt.hostile.policy,'TypeError');assert.equal(receipt.hostile.topNav,'SecurityError');
 assert.equal(receipt.hostile.fetch,'TypeError');assert.equal(receipt.hostile.socket,'blocked');assert.equal(receipt.hostile.popup,'blocked');assert.equal(receipt.hostile.blankRealm,'SecurityError');
 assert.equal(await hostileFrame.locator('iframe').count(),0);
 // Guard frame-src must also stop the artifact's own navigation.
 await hostileFrame.evaluate(()=>{location.href='https://hostile.invalid/self';});await a.waitForTimeout(300);
 await a.evaluate(()=>{window.escapeMessages=[];addEventListener('message',e=>{if(e.data?.escapeRTC)window.escapeMessages.push(e.data);});});
 await hostileFrame.evaluate(()=>{location.href='data:text/html,<script>top.postMessage({escapeRTC:typeof RTCPeerConnection},"*")</script>';});await a.waitForTimeout(200);
 await hostileFrame.evaluate(()=>{location.href=`javascript:'<script>top.postMessage({escapeRTC:typeof RTCPeerConnection},"*")<\\/script>'`;});await a.waitForTimeout(200);
 assert.deepEqual(await a.evaluate(()=>window.escapeMessages),[]);
 assert.deepEqual(external,[]);assert.equal(contexts[0].pages().length,1);
 receipt.blockedExternalRequests=external.length;
 if(output)fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt,null,2));console.log('PASS: real UI + SFU synthetic audio, auth/revocation/leave/rejoin, CLI HTML roundtrip and hostile sandbox');
} finally {await browser?.close();await server.close();}
