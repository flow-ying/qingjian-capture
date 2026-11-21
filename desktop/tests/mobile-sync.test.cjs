'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module');
const {envelope,sha,removeBlock,transition}=require('../standalone/core.cjs');
const {Store}=require('../standalone/store.cjs');
const {createMobileSync,normalizeBase}=require('../standalone/mobile-sync.cjs');
const bridgeFile=path.resolve(__dirname,'../standalone/bridge/main.cjs'),baseRequire=createRequire(bridgeFile);
class MarkdownView{}
// Real bridge class running against an in-memory vault (same technique as standalone-bridge.test.cjs, plus trash/binary/links).
function makeBridge(localRoot){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(bridgeFile,'utf8'),{module,exports:module.exports,require:n=>n==='obsidian'?{Plugin:class{},Notice:class{},MarkdownView}:baseRequire(n),console,setTimeout,clearTimeout,process,Buffer});
 const bridge=new module.exports(),files=new Map(),leaves=[],trashed=[],links={};
 bridge.receipts={};bridge.closed=false;bridge.localRoot=localRoot;
 bridge.app={workspace:{getLeavesOfType:()=>leaves},metadataCache:{resolvedLinks:links},vault:{
  adapter:{exists:async p=>files.has(p),readBinary:async p=>{const b=files.get(p);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);}},
  getAbstractFileByPath:p=>files.has(p)?{path:p}:null,createFolder:async p=>files.set(p,null),
  create:async(p,c)=>{if(files.has(p))throw Error('exists');files.set(p,c);return {path:p};},
  createBinary:async(p,ab)=>{files.set(p,Buffer.from(ab));return {path:p};},
  read:async f=>files.get(f.path),process:async(f,fn)=>files.set(f.path,fn(files.get(f.path))),
  trash:async(f)=>{trashed.push(f.path);files.delete(f.path);}}};
 let disk;bridge.saveData=async v=>{disk=JSON.parse(JSON.stringify(v));};
 return {bridge,files,leaves,trashed,links,disk:()=>disk};
}
function rig({token='T'.repeat(32)}={}){
 const root=path.resolve(__dirname,'../artifacts/mobile-sync-'+crypto.randomUUID());
 const store=new Store(root),env=makeBridge(root),relay={ops:[],attachments:new Map(),acks:[],projects:null,projectPuts:0,calls:0,failAck:0,role:'desktop',authFail:false};
 let online=true,secret=token;
 const request=async m=>{if(!online)throw Error('Obsidian 响应超时');if(m.method==='submit')return env.bridge.submit(m.envelope);if(m.method==='delete')return env.bridge.remove(m);throw Error('未知操作');};
 const syncLocal=async()=>{if(!online)return;const blocked=new Set();for(const op of store.operations.filter(o=>o.status!=='saved'&&!store.isInactive(o.envelope.id))){if(blocked.has(op.envelope.id))continue;try{store.mark(op,'saved',await request({method:'submit',envelope:op.envelope}));}catch(e){store.mark(op,'pending',null,e.message);blocked.add(op.envelope.id);}}};
 const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,init={})=>{
  relay.calls++;const u=new URL(url),route=u.pathname.replace('/mobile-capture/v1',''),method=init.method||'GET';
  if(relay.authFail)return json(401,{ok:false,error:'unauthorized'});
  if(route==='/health')return json(200,{ok:true,role:relay.role,protocol:1,version:'1.0.0'});
  if(route==='/desktop/pull')return json(200,{ok:true,ops:relay.ops.filter(o=>['queued','pulled'].includes(o.state)).slice(0,Number(u.searchParams.get('limit'))),more:false});
  if(route.startsWith('/desktop/attachments/')){const b=relay.attachments.get(route.split('/').pop());return b?new Response(b,{status:200}):json(404,{ok:false,error:'attachment-missing'});}
  if(route==='/desktop/ack'){
   if(relay.failAck>0){relay.failAck--;return json(500,{ok:false,error:'boom'});}
   const results=[];for(const a of JSON.parse(init.body).acks){const op=relay.ops.find(o=>o.opId===a.opId);if(!op){results.push({opId:a.opId,ok:false,error:'op-not-found'});continue;}if(['landed','deleted','conflict','failed'].includes(op.state)){results.push({opId:a.opId,ok:op.state===a.state,error:op.state===a.state?undefined:'already-terminal',replayed:true});continue;}op.state=a.state;relay.acks.push(a);results.push({opId:a.opId,ok:true,state:a.state});}
   return json(200,{ok:true,results});
  }
  if(route==='/meta/projects'&&method==='PUT'){relay.projects=JSON.parse(init.body).projects;relay.projectPuts++;return json(200,{ok:true,count:relay.projects.length});}
  return json(404,{ok:false,error:'not-found'});
 };
 let projectList=['工作台','Sid'];
 const mobile=createMobileSync({root,store,bridge:{request},syncLocal,isOnline:()=>online,projects:()=>projectList,secret:{get:()=>secret,set:v=>{secret=v;},clear:()=>{secret=null;}},fetch:fetchImpl});
 let seq=0;
 const upsert=(e,extra={})=>{const op={opId:crypto.randomUUID(),seq:++seq,deviceId:'my-phone',kind:'upsert',captureId:e.id,revision:e.revision,digest:e.digest,state:'queued',envelope:e,...extra};relay.ops.push(op);return op;};
 const del=(captureId,rev,digest)=>{const op={opId:crypto.randomUUID(),seq:++seq,deviceId:'my-tablet',kind:'delete',captureId,revision:rev,state:'queued',target:{targetRevision:rev,expectedDigest:digest}};relay.ops.push(op);return op;};
 return {root,store,env,relay,mobile,upsert,del,setOnline:v=>{online=v;},setProjects:v=>{projectList=v;},secret:()=>secret};
}
const note=(body,extra={})=>({type:'note',body,source:'',thought:'',due:'',tags:'',attachments:[],...extra});
const png=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const attachment=bytes=>({id:crypto.randomUUID(),name:'photo.png',ext:'.png',hash:sha(bytes),size:bytes.length});

test('unconfigured desktop is completely silent: zero network, zero errors',async()=>{
 const r=rig();r.setOnline(true);const quiet=createMobileSync({root:r.root,store:r.store,bridge:{request:async()=>{}},syncLocal:async()=>{},isOnline:()=>true,projects:()=>['工作台'],secret:{get:()=>null,set(){},clear(){}},fetch:async()=>{throw Error('must not be called');}});
 const st=await quiet.cycle();assert.equal(st.configured,false);assert.equal(st.lastError,'');
});
test('pull lands a phone record with a verified image, acks landed, and survives a lost ack without duplicating',async()=>{
 const r=rig(),att=attachment(png),e=envelope(crypto.randomUUID(),note('手机拍的白板',{attachments:[att]}));
 r.relay.attachments.set(att.hash,png);const op=r.upsert(e);r.relay.failAck=1;
 await r.mobile.cycle();
 const daily=r.env.files.get('00_Inbox/Daily/'+e.date+'.md');
 assert.match(daily,/手机拍的白板/);assert.equal((daily.match(/desktop-capture:/g)||[]).length,2);
 assert.ok(r.env.files.has(`00_Inbox/Attachments/DesktopCapture/${e.date}/${att.id}.png`));
 assert.equal(r.mobile.status().outbox,1,'ack failed once, still queued durably');assert.equal(r.relay.acks.length,0);
 await r.mobile.cycle();   // op is re-delivered by the relay until acked; must stay idempotent
 assert.equal(r.relay.acks.length,1);const ack=r.relay.acks[0];
 assert.equal(ack.state,'landed');assert.equal(ack.revision,1);assert.equal(ack.digest,e.digest);assert.match(ack.blockHash,/^[a-f0-9]{64}$/);assert.equal(ack.path,'00_Inbox/Daily/'+e.date+'.md');
 assert.equal((r.env.files.get('00_Inbox/Daily/'+e.date+'.md').match(/desktop-capture:/g)||[]).length,2);
 assert.equal(r.store.operations.length,1);assert.equal(op.state,'landed');
});
test('corrupted attachment or tampered envelope is rejected as failed, nothing is written',async()=>{
 const r=rig(),att=attachment(png),e=envelope(crypto.randomUUID(),note('带图',{attachments:[att]}));
 r.relay.attachments.set(att.hash,Buffer.from('not the same bytes'));r.upsert(e);
 const bad=envelope(crypto.randomUUID(),note('正文'));r.upsert({...bad,payload:{...bad.payload,body:'被篡改'}});
 await r.mobile.cycle();
 assert.deepEqual(r.relay.acks.map(a=>a.state),['failed','failed']);assert.equal(r.store.operations.length,0);assert.equal(r.env.files.size,0);
});
test('phone edits land in place; a hand-edited Daily block is never overwritten and reports conflict',async()=>{
 const r=rig(),e1=envelope(crypto.randomUUID(),note('第一版'));r.upsert(e1);await r.mobile.cycle();
 const e2=envelope(e1.id,note('手机改成第二版'),e1);r.upsert(e2);await r.mobile.cycle();
 const file='00_Inbox/Daily/'+e1.date+'.md';assert.match(r.env.files.get(file),/手机改成第二版/);assert.doesNotMatch(r.env.files.get(file),/第一版/);
 const land2=r.relay.acks.at(-1);assert.equal(land2.state,'landed');assert.equal(land2.revision,2);
 // User edits the block by hand in Obsidian, then the phone sends revision 3 based on the landed rev 2.
 r.env.files.set(file,r.env.files.get(file).replace('手机改成第二版','我在电脑上手改的内容'));
 const e3=envelope(e1.id,note('手机的第三版'),e2);r.upsert(e3);await r.mobile.cycle();
 assert.match(r.env.files.get(file),/我在电脑上手改的内容/);assert.doesNotMatch(r.env.files.get(file),/手机的第三版/);
 const conflict=r.relay.acks.at(-1);assert.equal(conflict.state,'conflict');assert.match(conflict.error,/已修改或移除/);
 assert.equal(r.store.latest(e1.id).envelope.revision,2,'rejected op is dropped, record falls back to the real latest');
 assert.equal(r.mobile.status().tracked,0);
});
test('phone edit based on an older version than the desktop already saved is rejected without touching Daily',async()=>{
 const r=rig(),e1=envelope(crypto.randomUUID(),note('原文'));r.upsert(e1);await r.mobile.cycle();
 r.store.save({id:e1.id,expectedRevision:1,payload:note('电脑端先改了')});   // desktop orb edit -> revision 2
 await r.mobile.cycle();
 const stale=envelope(e1.id,note('手机基于旧版本的修改'),e1);r.upsert(stale);await r.mobile.cycle();
 const ack=r.relay.acks.at(-1);assert.equal(ack.state,'conflict');assert.match(ack.error,/第 2 版/);assert.equal(ack.revision,2);
 assert.doesNotMatch(r.env.files.get('00_Inbox/Daily/'+e1.date+'.md'),/手机基于旧版本/);
});
test('safe delete removes the block and only orphaned images; shared images and hand-edited blocks are protected',async()=>{
 const r=rig(),a1=attachment(png),a2=attachment(Buffer.concat([png,Buffer.from('2')]));
 const e=envelope(crypto.randomUUID(),note('要被删除的记录',{attachments:[a1,a2]}));
 r.relay.attachments.set(a1.hash,png);r.relay.attachments.set(a2.hash,Buffer.concat([png,Buffer.from('2')]));r.upsert(e);await r.mobile.cycle();
 const file='00_Inbox/Daily/'+e.date+'.md',p1=`00_Inbox/Attachments/DesktopCapture/${e.date}/${a1.id}.png`,p2=`00_Inbox/Attachments/DesktopCapture/${e.date}/${a2.id}.png`;
 r.env.files.set(file,'---\ndate: '+e.date+'\n---\n\n- 手写的无关内容\n\n'+r.env.files.get(file).split('\n\n').slice(1).join('\n\n'));
 r.env.links['06_Other/复用图片.md']={[p2]:1};    // another note still embeds image #2
 // landed receipt blockHash still matches because the block itself is untouched; only text around it changed
 r.del(e.id,1,e.digest);await r.mobile.cycle();
 const ack=r.relay.acks.at(-1);assert.equal(ack.state,'deleted');
 assert.doesNotMatch(r.env.files.get(file),/要被删除的记录/);assert.match(r.env.files.get(file),/手写的无关内容/);assert.doesNotMatch(r.env.files.get(file),/desktop-capture:/);assert.doesNotMatch(r.env.files.get(file),/\n{3,}/);
 assert.deepEqual(r.env.trashed,[p1]);assert.ok(r.env.files.has(p2));assert.equal(r.store.list().length,0);
 assert.equal(r.env.disk().receipts[e.id].deleted,true);
 // replaying the delete is idempotent and a stale upsert can no longer resurrect the record
 const again=r.del(e.id,1,e.digest);await r.mobile.cycle();assert.equal(again.state,'deleted');
});
test('delete of a hand-edited block is refused with conflict and nothing is removed',async()=>{
 const r=rig(),e=envelope(crypto.randomUUID(),note('我马上会手改'));r.upsert(e);await r.mobile.cycle();
 const file='00_Inbox/Daily/'+e.date+'.md';r.env.files.set(file,r.env.files.get(file).replace('我马上会手改','我已经手改'));
 const op=r.del(e.id,1,e.digest);await r.mobile.cycle();
 assert.equal(op.state,'conflict');assert.match(r.relay.acks.at(-1).error,/已修改或移除/);assert.match(r.env.files.get(file),/我已经手改/);assert.deepEqual(r.env.trashed,[]);
 const wrong=r.del(e.id,7,e.digest);await r.mobile.cycle();assert.equal(wrong.state,'conflict');
});
test('delete waits while Obsidian is offline and runs once the bridge is back; dirty editor only delays',async()=>{
 const r=rig(),e=envelope(crypto.randomUUID(),note('等 Obsidian 的删除'));r.upsert(e);await r.mobile.cycle();
 const op=r.del(e.id,1,e.digest);r.setOnline(false);await r.mobile.cycle();
 assert.equal(op.state,'queued');assert.equal(r.mobile.status().tracked,1);
 r.setOnline(true);const file='00_Inbox/Daily/'+e.date+'.md',view=new MarkdownView();view.file={path:file};view.editor={getValue:()=> 'unsaved'};r.env.leaves.push({view});
 await r.mobile.cycle();assert.equal(op.state,'queued','dirty editor must not be interpreted as conflict');assert.match(r.env.files.get(file),/等 Obsidian 的删除/);
 r.env.leaves.length=0;await r.mobile.cycle();assert.equal(op.state,'deleted');
});
test('mobile-originated pending ops survive restart and are acked after Obsidian comes back',async()=>{
 const r=rig(),e=envelope(crypto.randomUUID(),note('关机时到达'));r.setOnline(false);const op=r.upsert(e);await r.mobile.cycle();
 assert.equal(op.state,'pulled'.replace('pulled','queued'));assert.equal(r.store.operations.length,1);
 const reopened=new Store(r.root);assert.equal(reopened.operations.length,1);
 r.setOnline(true);await r.mobile.cycle();assert.equal(op.state,'landed');
});
test('active project list is pushed once, re-pushed only on change, and invalid slugs are dropped',async()=>{
 const r=rig();await r.mobile.cycle();assert.equal(r.relay.projectPuts,1);assert.deepEqual(r.relay.projects,[{slug:'工作台'},{slug:'Sid'}]);
 await r.mobile.cycle();assert.equal(r.relay.projectPuts,1);
 r.setProjects(['工作台','Sid','示例项目','带 空格','#bad']);await r.mobile.cycle();assert.equal(r.relay.projectPuts,2);assert.deepEqual(r.relay.projects.map(p=>p.slug),['工作台','Sid','示例项目']);
 r.setProjects([]);await r.mobile.cycle();assert.equal(r.relay.projectPuts,2,'an empty list never wipes the phone-side picker');
});
test('auth failure stops polling until the token is replaced; wrong-role token is refused',async()=>{
 const r=rig();r.relay.authFail=true;await r.mobile.cycle();const calls=r.relay.calls;assert.equal(r.mobile.status().authFailed,true);await r.mobile.cycle();assert.equal(r.relay.calls,calls,'no request storm after 401');
 r.relay.authFail=false;r.relay.role='device';await assert.rejects(r.mobile.setToken('D'.repeat(40)),/无权拉取/);assert.notEqual(r.secret(),'D'.repeat(40));
 r.relay.role='desktop';const info=await r.mobile.setToken('E'.repeat(40));assert.equal(info.role,'desktop');assert.equal(r.secret(),'E'.repeat(40));
 await assert.rejects(r.mobile.setToken('has space and short'),/不像云端令牌/);
 r.relay.role='desktop';const b64='aB3/xY+z_-9='.repeat(4);assert.equal(b64.length,48);assert.equal((await r.mobile.setToken(b64)).role,'desktop');assert.equal(r.secret(),b64,'base64 tokens containing / + = must be accepted');
 await assert.rejects(r.mobile.setToken(''),/剪贴板是空的/);
});
test('server address must be https (loopback http allowed for tests) and carries no credentials',()=>{
 assert.equal(normalizeBase('https://relay.example.com/mobile-capture/v1/'),'https://relay.example.com/mobile-capture/v1');
 assert.equal(normalizeBase('http://127.0.0.1:8941'),'http://127.0.0.1:8941');
 assert.throws(()=>normalizeBase('http://example.com/x'),/https/);assert.throws(()=>normalizeBase('https://user:pw@example.com'),/账号/);assert.throws(()=>normalizeBase('nope'),/无效/);
});
test('core.removeBlock removes exactly one captured block, keeps neighbours, refuses edits and tolerates already-missing blocks',()=>{
 const a=envelope(crypto.randomUUID(),note('甲')),b=envelope(crypto.randomUUID(),note('乙'));
 let content='---\ndate: 2026-11-20\n---\n';const ra=transition(content,a);content=ra.content;const rb=transition(content,b);content=rb.content;
 const out=removeBlock(content,a.id,{blockHash:ra.blockHash});
 assert.doesNotMatch(out.content,/甲/);assert.match(out.content,/乙/);assert.match(out.content,/^---\ndate: 2026-11-20\n---\n\n<!-- desktop-capture:/);assert.doesNotMatch(out.content,/\n{3,}/);
 const only=removeBlock(out.content,b.id,{blockHash:rb.blockHash});assert.equal(only.content,'---\ndate: 2026-11-20\n---\n');
 assert.throws(()=>removeBlock(content.replace('甲','甲被改'),a.id,{blockHash:ra.blockHash}),/已修改或移除/);
 assert.throws(()=>removeBlock(content,a.id,null),/已修改或移除/);
 assert.equal(removeBlock('no block here',a.id,{blockHash:ra.blockHash}).missing,true);
 assert.throws(()=>removeBlock(content+content,a.id,{blockHash:ra.blockHash}),/重复或损坏/);
});
test('a single slow/failed connect is retried once; a dead network reports a clear error and keeps state',async()=>{
 const r=rig();let calls=0;const flaky=createMobileSync({root:r.root,store:r.store,bridge:{request:async()=>{}},syncLocal:async()=>{},isOnline:()=>true,projects:()=>[],secret:{get:()=>'T'.repeat(32),set(){},clear(){}},retryDelayMs:1,
  fetch:async()=>{calls++;if(calls===1)throw Object.assign(Error('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});return new Response(JSON.stringify({ok:true,role:'desktop'}),{status:200,headers:{'content-type':'application/json'}});}});
 assert.equal((await flaky.setToken('F'.repeat(40))).role,'desktop');assert.equal(calls,2);
 const dead=createMobileSync({root:r.root,store:r.store,bridge:{request:async()=>{}},syncLocal:async()=>{},isOnline:()=>true,projects:()=>[],secret:{get:()=>'T'.repeat(32),set(){},clear(){}},retryDelayMs:1,fetch:async()=>{throw Object.assign(Error('fetch failed'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});}});
 await assert.rejects(dead.setToken('G'.repeat(40)),/无法连接云端中转.*UND_ERR_CONNECT_TIMEOUT/);
});
