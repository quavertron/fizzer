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
const server=await createServer({root:new URL('../client',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{name:'bridge-fixture',configureServer(s){s.middlewares.use(async(req,res,next)=>{if(req.url==='/bridge-fixture.html'){res.setHeader('Content-Type','text/html');res.end(await s.transformIndexHtml(req.url,fixture));}else next();});}}]});
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
 for(const f of frames){assert.ok(f.left>=60-0.01);assert.ok(f.right<=86+0.01);assert.ok(f.height>0);}
 await page.evaluate(()=>window.draw(200));
 await page.screenshot({path:path.join(output,'sidebar-fixture.png')});
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify({frames:frames.length,errors,exactHorizontalBounds:[60,86],screenshot:'sidebar-fixture.png',scope:'Actual Sidebar exported geometry in headless Chromium SVG; not signed-in app or live user animation'},null,2));
 console.log('PASS: 141 animation frames use actual exported Sidebar geometry, no horizontal fold/overflow; headless SVG screenshot saved.');
}finally{await browser?.close();await server.close();}
