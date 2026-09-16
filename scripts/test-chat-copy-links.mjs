import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = path.resolve('client');
const fixture = await mkdtemp(path.join(root, '.copy-links-test-'));
const body = '<!-- fizzer-next:msg-1788698639490-uckmv8 -->\n\nI found no user-facing push or desktop notification implementation.\n\nRead **[[Team plan#launch|the plan]]** and *[[Team plan]]*.\n\n[Evidence](https://example.com/evidence)\n\n```html\n<widget data-value="keep">legitimate code</widget>\n```';
let server, browser;
try {
  await writeFile(path.join(fixture, 'index.html'), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(path.join(fixture, 'main.tsx'), `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatView} from '../src/components/ChatView';
    import {NoteEditor} from '../src/components/NoteEditor';
    import {chatMessageStore} from '../src/chat/messageStore';
    import {findEmbeddedNote} from '../src/docEmbeds';
    import '../src/index.css';
    const notes = [{id:'plan',title:'Team plan',content_preview:'Launch checklist'}, {id:'editor',title:'Editor',content_preview:''}];
    window.opens=[];
    chatMessageStore.set('fixture', [{id:'message',channelId:'fixture',author:'Astra',body:${JSON.stringify(body)},createdAt:'2026-09-06T12:00:00Z'}]);
    const noop=()=>{};
    function Fixture() {
      const [content,setContent]=useState('First line\\n\\n[[Team plan#launch|the plan]]\\n');
      return <><div style={{height:650}}><ChatView channelId="fixture" channelName="test" currentUser="owner" membersOpen={false} onMembersOpenChange={noop}
        presence={{participants:[],online:[]}} availableAgents={[]} registeredAgents={[]}
        onRegisterAgent={noop} onRemoveAgent={noop} onInviteUser={async()=>{}}
        onSendMessage={noop} onCancelRun={noop} notes={notes} onOpenNote={id=>window.opens.push(id)} /></div>
        <NoteEditor note={{id:'editor',title:'Editor'}} content={content} onContentChange={setContent}
          onSave={async()=>{}} notes={notes} onOpenNote={id=>window.opens.push(id)}
          onOpenWikilink={target=>window.opens.push(findEmbeddedNote(notes,target)?.id)} />
        <textarea aria-label="Paste result" />
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `);
  server=await createServer({configFile:false,root,server:{host:'127.0.0.1',port:0},esbuild:{jsx:'automatic'}});
  await server.listen();
  browser=await chromium.launch({headless:true});
  for (const width of [1100,390]) {
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage();
    page.setDefaultTimeout(6000);
    await page.route('**/api/notes/*',route=>route.fulfill({json:{note:{id:'plan',title:'Team plan',content:'# Launch destination'}}}));
    await page.goto(server.resolvedUrls.local[0]+path.basename(fixture)+'/index.html');
    const message=page.locator('[data-message-id="message"]').first();
    await message.waitFor();
    await message.click({button:'right'});
    const copy = page.getByRole('menuitem',{name:'Copy text',exact:true});
    if (width === 390) await copy.tap(); else await copy.click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),body.replace(/<!--.*?-->\n\n/,'').trim());
    await page.getByRole('textbox',{name:'Paste result'}).focus();
    await page.keyboard.press('Control+V');
    assert.equal(await page.getByRole('textbox',{name:'Paste result'}).inputValue(),body.replace(/<!--.*?-->\n\n/,'').trim());
    const link=page.locator('.chat-message-body strong .chat-wikilink').first();
    await link.click();
    await page.getByRole('heading',{name:'Launch destination'}).waitFor();
    await page.getByRole('button',{name:'Open note',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.opens),['plan']);
    await page.getByRole('button',{name:'Close note preview'}).click();
    await page.locator('.chat-message-body em .chat-wikilink').click();
    await page.getByRole('heading',{name:'Launch destination'}).waitFor();
    await page.locator('.cm-wikilink').first().click();
    assert.deepEqual(await page.evaluate(()=>window.opens),['plan','plan']);
    assert.equal((await page.locator('code').first().innerText()).trimEnd(),'<widget data-value="keep">legitimate code</widget>');
    if (width === 390) {
      await page.getByRole('button',{name:'Link note',exact:true}).click();
      await page.getByRole('dialog',{name:'Link a note'}).getByRole('button',{name:'Team plan',exact:true}).tap();
      assert.match(await page.locator('.cm-content').innerText(), /\[\[Team plan\]\]/);
    }
    console.log('Copy clipboard + paste, formatted links + exact note destination, editor alias resolution: '+width+' passed');
    await context.close();
  }
} finally {
  await browser?.close(); await server?.close(); await rm(fixture,{recursive:true,force:true});
}
