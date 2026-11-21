'use strict';
const {_electron}=require('playwright'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net');
const {pipeName,transition,garden}=require('../standalone/core.cjs');
const root=path.resolve(__dirname,'..'),testRoot=path.join(root,'artifacts','standalone-native-'+Date.now()),identity=path.join(testRoot,'synthetic-identity');
fs.mkdirSync(testRoot,{recursive:true});
let app,server;const clients=new Set(),documents=new Map(),receipts=new Map();
async function wait(fn){for(let i=0;i<220;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');}
(async()=>{
 app=await _electron.launch({args:[path.join(root,'dist/desktop-capture'),'--vault='+identity,'--qa-root='+testRoot],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
 const page=await wait(async()=>(await app.windows()).find(w=>w.url().endsWith('/ui/capture.html')));
 await wait(()=>app.evaluate(()=>Boolean(globalThis.captureQA)));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await app.evaluate(()=>globalThis.captureQA.open());
 await app.evaluate(()=>globalThis.captureQA.getWindow().emit('blur'));await page.waitForTimeout(150);assert.equal(await app.evaluate(()=>globalThis.captureQA.getWindow().isVisible()),true);
 await page.locator('.pin').click();
 const beforeDrag=await app.evaluate(()=>globalThis.captureQA.getWindow().getBounds());
 // A down/up pair can reach IPC after the physical cursor has already moved.
 await page.locator('header').evaluate(el=>{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,screenX:1200,screenY:120}));el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:1,screenX:1100,screenY:180}));});
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.getWindow().getBounds().x)===beforeDrag.x-100);
 assert.equal(await app.evaluate(()=>globalThis.captureQA.getWindow().getBounds().y),beforeDrag.y+60);
 await page.locator('.type-select').selectOption('diary');
 assert.equal(await page.locator('.tags-block').isVisible(),false);
 assert.equal(await page.locator('.date-block').isVisible(),false);
 await page.locator('.body').fill('原生测试记录\n第二行摘录');
 // Inspect the real context-menu event and native roles, without reading or replacing the user's clipboard.
 await app.evaluate(({Menu})=>{globalThis.menuQA={};globalThis.originalPopup=Menu.prototype.popup;Menu.prototype.popup=function(options){globalThis.menuQA={items:this.items.map(i=>({label:i.label,role:i.role,enabled:i.enabled})),windowId:options.window.id};};});
 await page.locator('.body').click({button:'right'});
 await wait(async()=>await app.evaluate(()=>Boolean(globalThis.menuQA.items)));
 const editMenu=await app.evaluate(()=>globalThis.menuQA);
 assert.deepEqual(editMenu.items.filter(i=>i.role).map(i=>i.role),['undo','redo','cut','copy','paste','selectall']);
 assert.equal(editMenu.windowId,await app.evaluate(()=>globalThis.captureQA.getWindow().id));
 await app.evaluate(({Menu})=>{Menu.prototype.popup=globalThis.originalPopup;});
 await page.locator('.add-source').click();await page.locator('.source').fill('https://example.org/resource');
 await page.locator('.add-thought').click();await page.locator('.thought').fill('检验来源与个人想法分开');
 for(const key of ['source','thought']){const value=await page.locator('.'+key).inputValue();await page.locator('.add-'+key).click();assert.equal(await page.locator('.'+key+'-block').isVisible(),false);await page.locator('.add-'+key).click();assert.equal(await page.locator('.'+key).inputValue(),value);}
 await page.waitForTimeout(500);
 await page.locator('.close').click();
 await app.evaluate(()=>globalThis.captureQA.open());
 assert.equal(await page.locator('.body').inputValue(),'原生测试记录\n第二行摘录');
 await page.locator('.save').click();
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.store.list().length===1));
 assert.equal(await app.evaluate(()=>globalThis.captureQA.store.list()[0].status),'pending');
 // Verify front-pinned New Draft button and floating Recent Popover (zero window height stretch!)
 assert.equal(await page.locator('.draft-bar > :first-child').evaluate(el=>el.classList.contains('new-draft')),true);
 const heightBeforeRecent=await app.evaluate(()=>globalThis.captureQA.getWindow().getBounds().height);
 await page.locator('.recent-toggle').click();
 assert.equal(await app.evaluate(()=>globalThis.captureQA.getWindow().getBounds().height),heightBeforeRecent,'recent popover never stretches window height');
 assert.match(await page.locator('.recent').innerText(),/已保存到本机/);
 // Test offline open-record triggers obsidian://open external launch cleanly
 await page.locator('.record button').nth(1).click();
 await wait(async()=>Boolean(await app.evaluate(()=>globalThis.lastOpenedExternalUri)));
 assert.match(await app.evaluate(()=>globalThis.lastOpenedExternalUri),/^obsidian:\/\/open\?vault=/);
 await page.locator('.recent-toggle').click();
 await page.locator('.record button').first().click();await page.locator('.body').fill('离线修改后的记录');
 // Test multi-draft slot switch while half-written edit is open
 await page.locator('.new-draft').click();
 assert.equal(await page.locator('.draft-tab').count(),2);
 await page.locator('.body').fill('临时第二槽草稿');
 await page.locator('.draft-tab').nth(1).click();
 assert.equal(await page.locator('.body').inputValue(),'离线修改后的记录');
 await page.locator('.save').click();
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.store.list()[0].revision===2));
 assert.equal(await page.locator('.body').inputValue(),'临时第二槽草稿');
 await page.locator('.body').fill('');
 // In-memory receiver models the bridge; no test Vault or real note is created.
 server=net.createServer(socket=>{clients.add(socket);socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket));socket.setEncoding('utf8');let input='';socket.on('data',chunk=>{input+=chunk;if(!input.includes('\n'))return;const request=JSON.parse(input.slice(0,input.indexOf('\n')));input='';if(request.method==='subscribe'){socket.write(JSON.stringify({event:'theme',theme:{...garden.light,dark:false}})+'\n');return;}if(request.method==='records'){socket.end(JSON.stringify({ok:true,result:request.ids.map(id=>{const r=receipts.get(id);return {id,state:!r?'unknown':[...documents.values()].some(c=>c.includes('desktop-capture:'+id+':'))?'present':'missing',revision:r?.revision,path:r?.path};})})+'\n');return;}if(request.method==='submit'){const e=request.envelope,prior=receipts.get(e.id),result=transition(documents.get(e.date)||'---\ndate: '+e.date+'\n---\n',e,prior);documents.set(e.date,result.content);const receipt={revision:e.revision,digest:e.digest,blockHash:result.blockHash,path:'00_Inbox/Daily/'+e.date+'.md'};receipts.set(e.id,receipt);socket.end(JSON.stringify({ok:true,result:receipt})+'\n');}});});
 await new Promise(resolve=>server.listen(pipeName(identity),resolve));
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.snapshot().online));
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.store.list()[0].status==='saved'));
 assert.equal(documents.size,1);assert.match([...documents.values()][0],/^- 离线修改后的记录/m);assert.equal(([...documents.values()][0].match(/<!-- desktop-capture:/g)||[]).length,1);assert.doesNotMatch([...documents.values()][0],/^- \[[~!?IL]\]/m);
 // Default standalone palette is Obsidian Indigo (#7c6ff6 -> rgb(124, 111, 246)), NOT overwritten by bridge!
 assert.equal(await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(124, 111, 246)');
 await app.evaluate(()=>globalThis.captureQA.setPalette('warm-paper'));
 await wait(async()=>await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor)==='rgb(200, 109, 45)');
 // Optional workbench mode still syncs bridge light/dark themes cleanly
 await app.evaluate(()=>globalThis.captureQA.setPalette('workbench'));
 await wait(async()=>await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor)==='rgb(55, 95, 80)');
 for(const socket of clients)socket.write(JSON.stringify({event:'theme',theme:{...garden.dark,dark:true}})+'\n');
 await wait(async()=>await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor)==='rgb(193, 209, 162)');
 await app.evaluate(()=>globalThis.captureQA.setPalette('obsidian-indigo'));
 await wait(async()=>await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor)==='rgb(124, 111, 246)');
 await page.screenshot({path:path.join(testRoot,'native-dark.png')});
 // Verify in-window segmented mode switch [速记 | 任务图] + Orb left-click remembering last-closed view
 await page.locator('.switch-graph').click();
 await wait(async()=>await app.evaluate(()=>Boolean(globalThis.captureQA.taskGraph.getWindow()?.isVisible())&&!globalThis.captureQA.getWindow().isVisible()));
 const gPage=await wait(async()=>(await app.windows()).find(w=>w.url().endsWith('/ui/graph.html')));
 await gPage.locator('#close').click();
 await wait(async()=>await app.evaluate(()=>!globalThis.captureQA.taskGraph.getWindow().isVisible()));
 await app.evaluate(()=>globalThis.captureQA.toggleLastActive());
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.taskGraph.getWindow().isVisible()&&!globalThis.captureQA.getWindow().isVisible()));
 await gPage.locator('#switch-capture').click();
 await wait(async()=>await app.evaluate(()=>globalThis.captureQA.getWindow().isVisible()&&!globalThis.captureQA.taskGraph.getWindow().isVisible()));
 await page.locator('.recent-toggle').click();
 await page.locator('.record button').first().click();await page.locator('.body').fill('删除发生时仍在写的草稿');
 const originalDocs=[...documents.entries()];documents.clear();for(const socket of clients)socket.write(JSON.stringify({event:'records-changed'})+'\n');await wait(async()=>await app.evaluate(()=>globalThis.captureQA.store.list().length===0));assert.equal(await page.locator('.count').innerText(),'0');assert.equal(documents.size,0);assert.equal(await page.locator('.body').inputValue(),'删除发生时仍在写的草稿');assert.equal(await app.evaluate(()=>globalThis.captureQA.store.draft().expectedRevision),0);await page.locator('.body').fill('');for(const [key,value]of originalDocs)documents.set(key,value);for(const socket of clients)socket.write(JSON.stringify({event:'records-changed'})+'\n');await wait(async()=>await app.evaluate(()=>globalThis.captureQA.store.list().length===1));
 for(const socket of clients)socket.destroy();await new Promise(resolve=>server.close(resolve));server=null;
 await wait(async()=>await app.evaluate(()=>!globalThis.captureQA.snapshot().online));
 assert.equal(await page.locator('.save').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(124, 111, 246)');
 await page.locator('.body').fill('退出后恢复的草稿');await page.waitForTimeout(500);
 await app.evaluate(()=>globalThis.captureQA.quit());await app.close();app=null;
 app=await _electron.launch({args:[path.join(root,'dist/desktop-capture'),'--vault='+identity,'--qa-root='+testRoot],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
 const reopened=await wait(async()=>(await app.windows()).find(w=>w.url().endsWith('/ui/capture.html')));await wait(()=>app.evaluate(()=>Boolean(globalThis.captureQA)));await app.evaluate(()=>globalThis.captureQA.open());
 assert.equal(await reopened.locator('.body').inputValue(),'退出后恢复的草稿');assert.equal(await app.evaluate(()=>globalThis.captureQA.store.list()[0].status),'saved');
 await wait(()=>app.evaluate(()=>globalThis.captureQA.getOrb().isAlwaysOnTop()&&globalThis.captureQA.getWindow().isAlwaysOnTop()));
 const native=await app.evaluate(()=>({orbTop:globalThis.captureQA.getOrb().isAlwaysOnTop(),orbVisible:globalThis.captureQA.getOrb().isVisible(),captureTop:globalThis.captureQA.getWindow().isAlwaysOnTop(),orbFocusable:globalThis.captureQA.getOrb().isFocusable(),orbBounds:globalThis.captureQA.getOrb().getBounds(),bounds:globalThis.captureQA.getWindow().getBounds()}));
 console.log('Native state: '+JSON.stringify(native));
 assert.equal(native.orbTop,true,'orb stays topmost');assert.equal(native.captureTop,true,'capture stays topmost');assert.equal(native.orbFocusable,false,'orb is nonactivating');
 await reopened.screenshot({path:path.join(testRoot,'native-reopened.png')});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(testRoot,'verification.json'),JSON.stringify({passed:true,native,tests:['diary offline/reconnect/edit and native right-click editing roles','source deletion reconciliation and undo','source/thought repeat toggle preserves text','blur retains independent window','native windows','durable draft','offline save and edit','reconnect with exactly one record','light/dark theme updates','last theme retained offline','restart recovery','topmost nonactivating orb'],limits:['synthetic in-memory receiver; no real notes written','physical multi-monitor hotplug not tested']},null,2));
 console.log('PASS native standalone workflow; evidence: '+testRoot);
})().finally(async()=>{for(const socket of clients)socket.destroy();if(server)server.close();if(app){try{await app.evaluate(()=>globalThis.captureQA.quit());}catch{}await app.close();}}).catch(e=>{console.error(e);process.exitCode=1;});
