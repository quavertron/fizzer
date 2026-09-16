import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const output=process.env.SIDEBAR_BROWSER_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(),'fizzer-sidebar-fixture-'));
fs.mkdirSync(output,{recursive:true});
const fixture = `<!doctype html><html><body style="margin:0;background:#111827;color:#e5e7eb;font:14px sans-serif"><p>Isolated sidebar-bridge geometry fixture — not a live app screenshot</p><svg width="320" height="900"><rect x="16" y="300" width="44" height="36" fill="#334155"/><path id="bridge" fill="#64748b"/><rect id="target" x="86" width="214" height="32" fill="#334155"/></svg><script type="module">
import {vaultSelectionConnectorPath} from '/src/components/Sidebar.tsx';
window.draw = offset => {
 document.querySelector('#target').setAttribute('y',300+offset);
 const d=vaultSelectionConnectorPath({left:0,right:320,top:0,bottom:900},{left:16,right:60,top:300,bottom:336},{left:86,right:300,top:300+offset,bottom:332+offset});
 document.querySelector('#bridge').setAttribute('d',d);return d;
};
</script></body></html>`;
const junctionFixture=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/index.css"></head><body>
<aside class="sidebar" style="width:340px;height:800px"><nav class="vault-rail"><button class="vault-rail-action">F</button><div class="vault-rail-list"><button class="vault-rail-button is-active"><span class="vault-rail-initials">MV</span></button></div></nav><svg class="vault-selection-connector"><path/></svg><div class="sidebar-panel"><div class="tree-item active" style="position:absolute;left:72px;width:268px;height:38px;padding-left:48px">Project — milbooru</div></div></aside>
<script type="module">
import {vaultSelectionConnectorPath} from '/src/components/Sidebar.tsx';
window.draw=offset=>{
const side=document.querySelector('.sidebar'),button=document.querySelector('.vault-rail-button'),target=document.querySelector('.tree-item'),rail=document.querySelector('.vault-rail'),list=document.querySelector('.vault-rail-list');
target.style.top=(48+offset)+'px';
const s=side.getBoundingClientRect(),b=button.getBoundingClientRect(),t=target.getBoundingClientRect(),l=list.getBoundingClientRect();
const d=vaultSelectionConnectorPath(s,b,t);
document.querySelector('path').setAttribute('d',d);
return {sidebar:s.toJSON(),button:b.toJSON(),target:t.toJSON(),list:l.toJSON(),rail:rail.getBoundingClientRect().toJSON(),d,clippedRight:Math.max(0,b.right-l.right),background:getComputedStyle(button).backgroundColor,fill:getComputedStyle(document.querySelector('path')).fill};
};</script></body></html>`;

const server=await createServer({configFile:false,root:new URL('../client',import.meta.url).pathname,esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'bridge-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(['/bridge-fixture.html','/junction-fixture.html'].includes(req.url)){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,req.url==='/bridge-fixture.html'?fixture:junctionFixture));}else next();});}}]});
let browser;
try{
 await server.listen();browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:360,height:980}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(server.resolvedUrls.local[0]+'bridge-fixture.html');await page.waitForFunction(()=>typeof window.draw==='function');
 const frames=await page.evaluate(async()=>{
  const rows=[];for(let offset=-200;offset<=500;offset+=5){
   window.draw(offset);await new Promise(requestAnimationFrame);
   const path=document.querySelector('#bridge'),b=path.getBBox();
   rows.push({offset,left:b.x,right:b.x+b.width,height:b.height});
  }return rows;
 });
 assert.equal(frames.length,141);
 for(const f of frames){assert.ok(f.left>=57-0.01);assert.ok(f.right<=86+0.01);assert.ok(f.height>0);}
 await page.evaluate(()=>window.draw(200));
 await page.screenshot({path:path.join(output,'sidebar-fixture.png')});
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({frames:frames.length,errors,exactHorizontalBounds:[57,86],screenshot:'sidebar-fixture.png',scope:'Actual Sidebar exported geometry in headless Chromium SVG; not signed-in app or live user animation'},null,2));
 console.log('PASS: 141 animation frames use actual exported Sidebar geometry, no horizontal fold/overflow; headless SVG screenshot saved.');

 // Use product rail/list/button CSS and the production path: no diagnostic overrides.
 // Effective DPR samples fractional raster scales; this does not drive browser zoom.
 const junctions=[];
 for(const width of [390,900,901,1280]) for(const dpr of [1,1.1,1.25,1.5,2]) {
  const sample=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:dpr});
  sample.on('pageerror',e=>errors.push(e.message));
  await sample.goto(server.resolvedUrls.local[0]+'junction-fixture.html');
  await sample.waitForFunction(()=>typeof window.draw==='function');
  for(const offset of [-40,0,140,300]) {
   const metrics=await sample.evaluate(o=>window.draw(o),offset);
   const name=`width-${width}-dpr-${dpr}-offset-${offset}`;
   const png=await sample.screenshot({path:path.join(output,name+'.png'),clip:{x:0,y:0,width:340,height:420}});
   // Decode the screenshot in Chromium to avoid adding a PNG library dependency.
   const pixels=await sample.evaluate(async ({png,button,list,dpr})=>{
    const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const left=Math.floor(Math.min(button.right,list.right)*dpr)-1;
    const right=Math.ceil(button.right*dpr)+1;
    // Stay away from text/decal and legitimate antialiasing along the curved edges.
    const y=Math.floor((button.top+12)*dpr);
    const data=ctx.getImageData(left,y,right-left+1,1).data;
    return {left,right,y,rgb:Array.from({length:right-left+1},(_,i)=>Array.from(data.slice(i*4,i*4+3)))};
   },{png:png.toString('base64'),button:metrics.button,list:metrics.list,dpr});
   const maxRgbError=Math.max(...pixels.rgb.flatMap(p=>p.map((c,i)=>Math.abs(c-[59,51,40][i]))));
   junctions.push({name,width,dpr,offset,...metrics,...pixels,maxRgbError,continuous:maxRgbError<=2});
  }
  await sample.close();
 }
 fs.writeFileSync(path.join(output,'junctions.json'),JSON.stringify({browser:browser.version(),scope:'Synthetic fixture with product CSS and exported path; settled frames, no live app or animation proof',junctions},null,2));
 const failures=junctions.filter(r=>!r.continuous);
 console.log(`Junction pixels: ${junctions.length-failures.length}/${junctions.length} pass; evidence: ${output}`);
 assert.deepEqual(errors,[]);
 assert.equal(failures.length,0,`Discontinuous junctions: ${failures.map(r=>r.name).join(', ')}`);
}finally{await browser?.close();await server.close();}
