// Headless lifecycle extension of the completed voice research reproduction.
import assert from 'node:assert/strict';
import http from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const localBase=process.argv.includes('--local-relative')?'':'https://local-api.invalid';
const source=new URL('..',import.meta.url).pathname;
const fake = `
export const Track = {Source:{Microphone:'microphone'},Kind:{Audio:'audio'}};
export const RoomEvent = Object.fromEntries(['TrackSubscribed','TrackUnsubscribed','ParticipantConnected','ParticipantDisconnected','TrackMuted','TrackUnmuted','LocalTrackPublished','LocalTrackUnpublished','ActiveSpeakersChanged','ParticipantAttributesChanged','Reconnecting','SignalReconnecting','Reconnected','Disconnected','MediaDevicesError'].map(x=>[x,x]));
export async function createLocalAudioTrack(){if(window.delayCapture)await new Promise(r=>window.releaseCapture=r);return {stop(){window.stops++},async unmute(){}}}
export class Room {
 constructor(){window.rooms.push(this);this.remoteParticipants=new Map();this.events={};this.localParticipant={identity:'u7-fixture',name:'Alex',attributes:{},isMicrophoneEnabled:true,trackPublications:new Map(),getTrackPublication(){},async publishTrack(track){this.trackPublications.set('mic',{track})},async setMicrophoneEnabled(value){this.isMicrophoneEnabled=value}}}
 on(event,fn){this.events[event]=fn;return this} removeAllListeners(){this.events={}}
 async connect(){this.connected=true} async disconnect(){window.disconnects++;this.connected=false} async startAudio(){}
}`;

const entry = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useVoiceSession,VoiceContext,VoiceControls,VoiceParticipants} from '${source}/client/src/components/VoiceRoom';
import {registerVaultOrigin,setActiveVaultOrigin} from '${source}/client/src/api';
window.rooms=[];window.stops=0;window.disconnects=0;window.requests=[];
window.roster=[{identity:'u7-fixture',name:'Alex',muted:false,deafened:false,avatarUrl:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'}];
window.fetch=async(url,opts)=>{
 window.requests.push({url,authorization:opts?.headers?.Authorization,credentials:opts?.credentials});
 if(url.endsWith('/participants')&&window.offline)throw new TypeError('Failed to fetch');
 if(url.endsWith('/join')&&window.delayJoin)await new Promise(r=>window.releaseJoin=r);
 const participants=structuredClone(window.roster);
 if(url.endsWith('/participants')&&window.delayRoster)await new Promise(r=>window.releaseRoster=r);
 return {ok:!window.denied,status:window.denied?403:200,json:async()=>({url:'ws://synthetic.invalid',token:'synthetic-only',identity:'u7-fixture',participants})};
};
// Accelerate only the production roster polling interval.
const timeout=window.setTimeout;window.setTimeout=(f,ms,...args)=>timeout(f,ms===5000?50:ms,...args);
window.routing={registerVaultOrigin,setActiveVaultOrigin};
function Fixture(){const [vault,setVault]=React.useState('source');const [user,setUser]=React.useState(7);const [epoch,setEpoch]=React.useState(0);const [open,setOpen]=React.useState(true);const voice=useVoiceSession(vault,user,'Vault '+vault,epoch);Object.assign(window,{voice,setVault,setUser,setEpoch,setOpen});return <VoiceContext.Provider value={voice}><div ref={voice.audio} data-audio-host/>{open?<aside><VoiceControls/></aside>:<footer><VoiceControls/></footer>}<VoiceParticipants channelId="room"/></VoiceContext.Provider>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const result=await build({stdin:{contents:entry,loader:'tsx',resolveDir:source},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':JSON.stringify({VITE_API_URL:localBase}),'process.env.NODE_ENV':'"test"'},plugins:[{name:'synthetic-room',setup(b){b.onResolve({filter:/^livekit-client$/},()=>({path:'fake',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fake,loader:'js'}));}}]});
const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?result.outputFiles[0].text:'<div id="root"></div><script src="/fixture.js"></script>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;const checks=[];
try{
 browser=await chromium.launch({headless:true,args:['--mute-audio'],env:Object.fromEntries(Object.entries(process.env).filter(([k])=>!['DISPLAY','WAYLAND_DISPLAY','SWAYSOCK','PULSE_SERVER'].includes(k)))});
 const page=await browser.newPage();page.setDefaultTimeout(10000);
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.voice);
 await page.waitForFunction(()=>document.querySelector('.voice-avatar img'));checks.push('idle authorized avatar');
 for(const failure of ['offline','denied']){
  await page.evaluate(key=>{window[key]=true},failure);
  await page.waitForFunction(()=>!document.querySelector('.voice-participants'));
  assert.equal(await page.locator('.voice-roster-status').count(),0,'passive roster failure should stay quiet');
  assert.equal(await page.locator('body').innerText(),'');
  assert.equal(await page.evaluate(()=>rooms.length),0);
  await page.evaluate(key=>{window[key]=false},failure);
  await page.waitForFunction(()=>document.querySelector('.voice-avatar img'));
 }
 checks.push('passive network/access failures clear stale roster silently, recover on retry, and never join');
 await page.evaluate(()=>{window.denied=true;return voice.join({id:'room',title:'Denied room'})});
 await page.waitForFunction(()=>voice.channel===null&&voice.error);
 assert.match(await page.locator('[role="alert"]').innerText(),/Click the room to retry/);
 await page.evaluate(()=>{window.denied=false;voice.clearError();window.rooms=[];window.disconnects=0});
 checks.push('explicit failed join retains actionable alert');
 await page.evaluate(()=>voice.join({id:'room',title:'Source room'}));await page.waitForFunction(()=>voice.status==='Connected'&&document.querySelector('.voice-avatar img'));
 await page.evaluate(()=>{window.roster=window.roster.map(({avatarUrl,...p})=>p)});await page.waitForTimeout(150);
 assert.ok(await page.locator('.voice-avatar img').count());
 await page.evaluate(()=>{window.roster=window.roster.map(p=>({...p,avatarUrl:''}))});await page.waitForFunction(()=>!document.querySelector('.voice-avatar img'));checks.push('connected absent preserves and explicit clear removes');
 await page.evaluate(()=>{window.audioElement=document.createElement('audio');rooms[0].events.TrackSubscribed({kind:'audio',attach:()=>audioElement});});
 for(const destination of ['local-other','remote','source']){
  await page.evaluate(d=>{if(d==='remote')routing.registerVaultOrigin(d,'https://remote.invalid','remote-token');routing.setActiveVaultOrigin('https://browsed.invalid','browsed-token');setVault(d);},destination);
  await page.waitForFunction(d=>voice.vaultId===d,destination);
  assert.deepEqual(await page.evaluate(()=>({rooms:rooms.length,disconnects,stops,source:voice.source.vaultId,audio:audioElement===document.querySelector('[data-audio-host] audio')})),{rooms:1,disconnects:0,stops:0,source:'source',audio:true});
 }
 await page.evaluate(()=>{routing.registerVaultOrigin('source','https://replacement.invalid','replacement-token');setVault('remote')});await page.waitForFunction(()=>voice.vaultId==='remote');
 await page.evaluate(()=>voice.change('deafened'));
 const localDeafen=await page.evaluate(()=>requests.findLast(r=>r.url.endsWith('/deafen')));
 assert.equal(localDeafen.url,localBase+'/api/vaults/source/channels/room/voice/deafen');assert.equal(localDeafen.authorization,undefined);assert.equal(localDeafen.credentials,'include');
 await page.evaluate(()=>setOpen(false));await page.waitForFunction(()=>document.querySelector('footer .voice-controls'));
 assert.equal(await page.evaluate(()=>audioElement===document.querySelector('[data-audio-host] audio')&&audioElement.muted),true);
 checks.push('local effective API_BASE and auth pinned after mapping replacement; navigation and control remount retain audio');
 await page.evaluate(()=>voice.join({id:'room',title:'Remote room'}));await page.waitForFunction(()=>voice.status==='Connected'&&rooms.length===2);
 assert.equal(await page.evaluate(()=>disconnects),1);assert.equal(await page.evaluate(()=>voice.deafened),true);
 await page.evaluate(()=>{routing.registerVaultOrigin('remote','https://replaced.invalid','replaced-token');setVault('remote2');routing.registerVaultOrigin('remote2','https://remote2.invalid','remote2-token')});await page.waitForFunction(()=>voice.vaultId==='remote2');
 await page.evaluate(()=>voice.change('deafened'));
 const remoteDeafen=await page.evaluate(()=>requests.findLast(r=>r.url.endsWith('/deafen')));
 assert.equal(remoteDeafen.url,'https://remote.invalid/api/vaults/remote/channels/room/voice/deafen');assert.equal(remoteDeafen.authorization,'Bearer remote-token');
 assert.equal(await page.evaluate(()=>voice.isCurrent('room')),false);
 await page.evaluate(()=>setVault('local-other'));await page.waitForFunction(()=>voice.vaultId==='local-other');assert.equal(await page.evaluate(()=>voice.source.vaultId),'remote');
 checks.push('explicit same-ID room switch and remote to remote/local navigation retain source and privacy');
 await page.evaluate(()=>setEpoch(1));await page.waitForFunction(()=>voice.channel===null);assert.equal(await page.evaluate(()=>disconnects),2);checks.push('same-user auth replacement disconnects');
 await page.evaluate(()=>{window.delayJoin=true;void voice.join({id:'room',title:'Delayed'})});await page.waitForFunction(()=>window.releaseJoin);
 await page.evaluate(()=>{void voice.leave();routing.registerVaultOrigin('local-other','https://late.invalid','late-token');window.delayJoin=false;releaseJoin()});await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>voice.channel),null);
 const lateLeave=await page.evaluate(()=>requests.findLast(r=>r.url.endsWith('/leave')));assert.ok(lateLeave.url.startsWith(localBase+'/api/vaults/local-other/'));assert.equal(lateLeave.authorization,undefined);checks.push('late token cancellation leaves through captured source');
 await page.evaluate(()=>{window.delayCapture=true;void voice.join({id:'room',title:'Capture'})});await page.waitForFunction(()=>window.releaseCapture);
 const stopped=await page.evaluate(()=>stops);await page.evaluate(()=>{setUser(undefined);});await page.waitForFunction(()=>voice.channel===null);await page.evaluate(()=>{window.delayCapture=false;releaseCapture()});await page.waitForFunction(s=>stops>s,stopped);checks.push('logout fences delayed capture');
 await page.evaluate(()=>setUser(7));await page.waitForFunction(()=>voice.channel===null);await page.waitForTimeout(50);
 await page.evaluate(()=>voice.join({id:'room',title:'Revoked'}));await page.waitForFunction(()=>voice.status==='Connected');
 await page.evaluate(()=>{window.denied=true});await page.waitForFunction(()=>voice.channel===null);assert.equal(await page.locator('[data-audio-host] audio').count(),0);assert.match(await page.locator('[role="alert"]').innerText(),/Voice access ended/);checks.push('source authorization failure disconnects, clears audio, and retains actionable alert');
 // A delayed old source roster must not hydrate a newly browsed same-ID room.
 await page.evaluate(()=>{window.denied=false;window.roster=[{identity:'u7-fixture',name:'Alex',muted:false,deafened:false,avatarUrl:'old-source-photo'}];window.delayRoster=true;window.releaseRoster=undefined;setVault('late-source')});
 await page.waitForFunction(()=>window.releaseRoster);
 await page.evaluate(()=>{window.oldRosterRelease=window.releaseRoster;window.delayRoster=false;window.roster=[];setVault('fresh-source')});
 await page.waitForFunction(()=>voice.vaultId==='fresh-source');
 await page.evaluate(()=>oldRosterRelease());await page.waitForTimeout(100);
 assert.equal(await page.locator('.voice-avatar img').count(),0);checks.push('late source roster cannot paint new source');
 console.log(JSON.stringify({checks,passed:checks.length,kind:'React headless; mocked SFU/HTTP; no device capture'},null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
