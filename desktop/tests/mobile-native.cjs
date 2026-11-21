'use strict';
// Real Electron process + loopback fake relay: DPAPI token storage, pull→local queue→attachment download, projects push, silent when unconfigured.
// Obsidian is intentionally absent (bridge offline), which is exactly the "desktop Obsidian closed" path: records must queue durably, not be acked.
const {_electron}=require('playwright'),path=require('node:path'),fs=require('node:fs'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {envelope,sha}=require('../standalone/core.cjs');
const root=path.resolve(__dirname,'..'),testRoot=path.join(root,'artifacts','mobile-native-'+Date.now()),vault=path.join(testRoot,'fake-vault');
const TOKEN='NativeTest'+crypto.randomBytes(18).toString('hex');
const tg=path.join(vault,'.obsidian/plugins/personal-workbench/state/task-graphs');fs.mkdirSync(tg,{recursive:true});
fs.writeFileSync(path.join(tg,'projects.json'),JSON.stringify({projects:[{name:'清笺原生测试'},{name:'Sid'}]}));
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex'),att={id:crypto.randomUUID(),name:'p.png',ext:'.png',hash:sha(png),size:png.length};
const env=envelope(crypto.randomUUID(),{type:'note',body:'原生进程拉取的手机记录',source:'',thought:'',due:'',tags:'',attachments:[att]});
const relay={requests:[],projects:null,acks:[]};
const server=http.createServer((req,res)=>{
 let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  relay.requests.push(req.method+' '+req.url+' auth='+(req.headers.authorization===('Bearer '+TOKEN)));
  const send=(code,obj)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(obj));};
  if(req.headers.authorization!=='Bearer '+TOKEN)return send(401,{ok:false,error:'unauthorized'});
  if(req.url==='/health')return send(200,{ok:true,role:'desktop',protocol:1,version:'native-fake'});
  if(req.url.startsWith('/desktop/pull'))return send(200,{ok:true,ops:[{opId:relay.opId,seq:1,deviceId:'my-phone',kind:'upsert',captureId:env.id,revision:1,digest:env.digest,state:'pulled',envelope:env}],more:false});
  if(req.url==='/desktop/attachments/'+att.hash){res.writeHead(200,{'content-type':'application/octet-stream'});return res.end(png);}
  if(req.url==='/desktop/ack'){relay.acks.push(...JSON.parse(body).acks);return send(200,{ok:true,results:JSON.parse(body).acks.map(a=>({opId:a.opId,ok:true,state:a.state}))});}
  if(req.url==='/meta/projects'&&req.method==='PUT'){relay.projects=JSON.parse(body).projects;return send(200,{ok:true,count:relay.projects.length});}
  send(404,{ok:false,error:'not-found'});
 });
});
relay.opId=crypto.randomUUID();
async function wait(fn){for(let i=0;i<200;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out');}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const app=await _electron.launch({args:[path.join(root,'dist/desktop-capture'),'--vault='+vault,'--qa-root='+testRoot],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined}});
 try{
  await wait(()=>app.evaluate(()=>Boolean(globalThis.captureQA)));
  await new Promise(r=>setTimeout(r,4500));   // start() schedules a first cycle after 3s; unconfigured => must stay silent
  assert.equal(relay.requests.length,0,'unconfigured desktop sent network requests');
  assert.equal(await app.evaluate(()=>globalThis.captureQA.mobile.status().configured),false);
  const info=await app.evaluate(async(_e,{base,token})=>{globalThis.captureQA.mobile.setBaseUrl(base);return globalThis.captureQA.mobile.setToken(token);},{base,token:TOKEN});
  assert.equal(info.role,'desktop');
  await wait(()=>relay.projects);   // setToken schedules the first real cycle
  assert.deepEqual(relay.projects.map(p=>p.slug).sort(),['Sid','清笺原生测试']);
  const opFile=path.join(testRoot,'operations',env.id+'-1.json');await wait(()=>fs.existsSync(opFile));
  const op=JSON.parse(fs.readFileSync(opFile,'utf8'));assert.equal(op.origin,'mobile');assert.equal(op.status,'pending');
  const local=path.join(testRoot,'attachments',att.id+att.ext);assert.ok(fs.existsSync(local));assert.equal(sha(fs.readFileSync(local)),att.hash);
  assert.equal(relay.acks.length,0,'record must not be acked as landed while Obsidian bridge is offline');
  const tokenFile=path.join(testRoot,'mobile-sync.token');assert.ok(fs.existsSync(tokenFile));
  const raw=fs.readFileSync(tokenFile);assert.equal(raw.includes(Buffer.from(TOKEN)),false,'token stored in plaintext');
  for(const f of ['mobile-sync.json','mobile-sync-state.json','settings.json'])assert.equal(fs.readFileSync(path.join(testRoot,f),'utf8').includes(TOKEN),false,f+' leaked token');
  const status=await app.evaluate(()=>globalThis.captureQA.mobile.status());assert.equal(status.configured,true);assert.equal(status.tracked,1);assert.equal(status.projects,2);assert.equal(status.lastError,'');
  const snapshot=await app.evaluate(()=>globalThis.captureQA.snapshot());assert.equal(snapshot.version,'0.4.2');assert.equal(snapshot.records.some(r=>r.id===env.id),true);
  // Clipboard-free path: password-type input window, token never shown, saved only after role check.
  await app.evaluate(()=>globalThis.captureQA.mobile.clearToken());assert.equal(await app.evaluate(()=>globalThis.captureQA.mobile.status().configured),false);
  await app.evaluate(()=>globalThis.captureQA.promptMobileToken());
  const prompt=await wait(async()=>(await app.windows()).find(w=>w.url().endsWith('/ui/token.html')));
  assert.equal(await prompt.locator('#token').getAttribute('type'),'password');
  await prompt.locator('#token').fill('short');await prompt.locator('#save').click();await wait(async()=>(await prompt.locator('#msg').textContent()).includes('不像云端令牌'));
  await prompt.locator('#token').fill(TOKEN);await prompt.locator('#save').click();
  await wait(async()=>await app.evaluate(()=>globalThis.captureQA.mobile.status().configured));
  assert.equal(fs.readFileSync(tokenFile).includes(Buffer.from(TOKEN)),false,'token stored in plaintext after prompt import');
  fs.writeFileSync(path.join(testRoot,'mobile-native-result.json'),JSON.stringify({ok:true,requests:relay.requests.length,status,tokenEncryptedBytes:raw.length},null,2));
  console.log('PASS native mobile-sync; evidence:',testRoot);
 }finally{await app.evaluate(()=>globalThis.captureQA?.quit?.()).catch(()=>{});await app.close().catch(()=>{});server.close();}
})().catch(e=>{console.error(e);process.exit(1);});
