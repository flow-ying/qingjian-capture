'use strict';
// Cloud relay puller living inside the already-resident desktop orb process (no third background daemon).
// Protocol: `docs/protocol.md` (v1, desktop role).
// Contract: never overwrite a hand-edited Daily block, never lose a pulled op (persisted + at-least-once ack), stay silent when unconfigured.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {UUID,sha,validate}=require('./core.cjs');
const {read,write}=require('./store.cjs');
const DEFAULT_URL=process.env.QINGJIAN_RELAY_URL||'https://relay.example.com/mobile-capture/v1';
const ALLOWED_EXT=['.png','.jpg','.jpeg','.gif','.webp','.bmp','.pdf','.txt','.md','.csv','.docx','.pptx','.xlsx'];
const MAX_BLOB=9*1024*1024,HOUR=3600*1000;
// Bridge/store errors that can never succeed on retry: report `conflict` instead of retrying forever.
const PERMANENT=/已修改或移除|记录编号已存在|版本已改变|前一版本尚未确认|边界重复或损坏|已在 Obsidian 删除|已归档或结案/;
const SLUG=/^[^\s#\[\]|<>\u0000]{1,60}$/;
class RelayError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function normalizeBase(value){
 const text=String(value||'').trim().replace(/\/+$/,'');let url;
 try{url=new URL(text);}catch{throw Error('服务器地址无效');}
 const local=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw Error('服务器地址必须是 https（仅本机测试允许 http://127.0.0.1）');
 if(url.username||url.password||url.search||url.hash)throw Error('服务器地址不能带账号、参数或锚点');
 return text;
}
const short=(message,max=480)=>String(message||'未知错误').replace(/\s+/g,' ').slice(0,max);
function createMobileSync(deps){
 const {root,store,bridge,syncLocal,isOnline,projects,secret,onChange=()=>{}}=deps,fetchImpl=deps.fetch||globalThis.fetch,now=deps.now||(()=>Date.now()),log=deps.log||(()=>{});
 const stateFile=path.join(root,'mobile-sync-state.json'),configFile=path.join(root,'mobile-sync.json');
 let state=read(stateFile,null);
 if(!state||typeof state!=='object'||state.version!==1)state={version:1,ops:{},outbox:{},projects:null};
 state.ops??={};state.outbox??={};
 let config=read(configFile,{}),running=false,again=false,timer=null,pushTimer=null,lastOkAt=0,lastEnd=0,lastError='',authFailed=false,stopped=false;
 const saveState=()=>write(stateFile,state),saveConfig=()=>write(configFile,config);
 const baseUrl=()=>normalizeBase(config.baseUrl||DEFAULT_URL);
 const configured=()=>Boolean(secret.get());
 const paused=()=>config.paused===true;
 const bySeq=(a,b)=>(a[1].seq??0)-(b[1].seq??0);
 async function http(method,route,{body,raw,token,limit=2*1024*1024}={}){
  const key=token??secret.get();if(!key)throw new RelayError(0,'not-configured','尚未配置云端令牌');
  let res,failure;
  // One quick retry: the first TLS connect through a proxy/TUN is occasionally slow; an interactive token import should not fail on that.
  for(let attempt=0;attempt<2&&!res;attempt++){
   try{res=await fetchImpl(baseUrl()+route,{method,redirect:'error',headers:{Authorization:'Bearer '+key,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(attempt?25000:15000)});}
   catch(e){failure=e;if(attempt===0)await new Promise(r=>setTimeout(r,deps.retryDelayMs??800));}
  }
  if(!res)throw new RelayError(0,'network',failure?.name==='TimeoutError'?'云端响应超时':'无法连接云端中转（'+short(failure?.cause?.code||failure?.message,80)+'）');
  if(raw){
   if(!res.ok)throw new RelayError(res.status,'http-'+res.status,'下载失败 '+res.status);
   const declared=Number(res.headers.get('content-length')||0);if(declared>limit)throw new RelayError(res.status,'too-large','附件过大');
   const bytes=Buffer.from(await res.arrayBuffer());if(bytes.length>limit)throw new RelayError(res.status,'too-large','附件过大');return bytes;
  }
  const data=await res.json().catch(()=>({}));
  if(res.status===401||res.status===403)throw new RelayError(res.status,data.error||'unauthorized','云端令牌无效或角色不符（需电脑端令牌）');
  if(!res.ok)throw new RelayError(res.status,data.error||'http-'+res.status,short(data.message||data.error||('HTTP '+res.status)));
  return data;
 }
 function queueAck(opId,ack){state.outbox[opId]={opId,...ack};delete state.ops[opId];saveState();}
 function localInfo(id){
  const latest=store.latest(id);if(!latest)return {};
  const info={revision:latest.envelope.revision,digest:latest.envelope.digest};
  if(latest.status==='saved'&&/^[a-f0-9]{64}$/.test(latest.receipt?.blockHash||''))info.blockHash=latest.receipt.blockHash;
  return info;
 }
 async function fetchAttachments(envelope){
  for(const a of envelope.payload.attachments){
   if(!ALLOWED_EXT.includes(a.ext))throw Object.assign(Error('不支持的附件类型 '+a.ext),{permanent:true});
   const file=path.join(store.root,'attachments',a.id+a.ext);
   if(fs.existsSync(file)&&sha(fs.readFileSync(file))===a.hash)continue;
   let bytes;
   try{bytes=await http('GET','/desktop/attachments/'+a.hash,{raw:true,limit:MAX_BLOB});}
   catch(e){if(e.status===404||e.status===410||e.code==='too-large')throw Object.assign(Error('云端附件已不可用：'+e.message),{permanent:true});throw e;}
   if(sha(bytes)!==a.hash||bytes.length!==a.size)throw Object.assign(Error('附件校验失败（SHA-256 或大小不符）'),{permanent:true});
   fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,bytes);fs.renameSync(tmp,file);
  }
 }
 function intake(op,blocked){
  const opId=op?.opId;if(typeof opId!=='string'||state.outbox[opId]||state.ops[opId])return null;
  const captureId=op.captureId,seq=op.seq;
  if(op.kind==='delete'){
   const t=op.target||{};
   if(!UUID.test(captureId||'')||!Number.isInteger(t.targetRevision)||typeof t.expectedDigest!=='string'){queueAck(opId,{state:'failed',error:'删除指令缺少记录版本信息'});return null;}
   state.ops[opId]={kind:'delete',captureId,seq,targetRevision:t.targetRevision,expectedDigest:t.expectedDigest};saveState();return null;
  }
  if(op.kind!=='upsert'){queueAck(opId,{state:'failed',error:'未知操作类型 '+short(op.kind,40)});return null;}
  if(blocked.has(captureId)){queueAck(opId,{state:'conflict',error:'同一记录更早的手机操作未能写入，已按顺序拒绝后续操作',...localInfo(captureId)});return null;}
  const e=op.envelope;
  try{validate(e);if(e.id!==captureId||e.revision!==op.revision||e.digest!==op.digest)throw Error('信封与操作头不一致');}
  catch(err){blocked.add(captureId);queueAck(opId,{state:'failed',error:short('记录无效：'+err.message)});return null;}
  return async()=>{
   try{await fetchAttachments(e);}
   catch(err){if(!err.permanent)throw err;blocked.add(captureId);queueAck(opId,{state:'failed',error:short(err.message)});return;}
   try{store.importRemote(e);}
   catch(err){blocked.add(captureId);queueAck(opId,{state:'conflict',error:short(err.message),...localInfo(captureId)});return;}
   state.ops[opId]={kind:'upsert',captureId,seq,revision:e.revision,digest:e.digest};saveState();
  };
 }
 async function pullAll(){
  const blocked=new Set();
  for(let page=0;page<10;page++){
   const result=await http('GET','/desktop/pull?limit=50');
   const ops=(Array.isArray(result.ops)?result.ops:[]).slice().sort((a,b)=>(a.seq??0)-(b.seq??0));
   let fresh=0;
   for(const op of ops){const known=Boolean(op&&(state.outbox[op.opId]||state.ops[op.opId]));if(!known)fresh++;const job=intake(op,blocked);if(job)await job();}
   // No cursor in the protocol: when every returned op is already known the page cannot advance until acks flow.
   if(!result.more||!fresh)break;
  }
 }
 async function processTracked(){
  const waiting=new Set();let changed=false;
  for(const [opId,t] of Object.entries(state.ops).sort(bySeq)){
   if(waiting.has(t.captureId))continue;
   if(t.kind==='upsert'){
    const local=store.operations.find(o=>o.envelope.id===t.captureId&&o.envelope.revision===t.revision&&o.envelope.digest===t.digest);
    if(!local){queueAck(opId,{state:'conflict',error:'电脑端本机队列中已找不到该版本，未写入',...localInfo(t.captureId)});changed=true;continue;}
    if(local.status==='saved'&&local.receipt){queueAck(opId,{state:'landed',revision:t.revision,digest:t.digest,blockHash:local.receipt.blockHash,path:local.receipt.path});changed=true;continue;}
    if(local.error&&PERMANENT.test(local.error)){const message=local.error;store.discard(local);queueAck(opId,{state:'conflict',error:short(message),...localInfo(t.captureId)});changed=true;continue;}
    waiting.add(t.captureId);continue;
   }
   if(!isOnline()){waiting.add(t.captureId);continue;}
   try{
    const result=await bridge.request({method:'delete',id:t.captureId,revision:t.targetRevision,digest:t.expectedDigest});
    store.reconcile([{id:t.captureId,state:'missing',path:result?.path,revision:t.targetRevision}]);
    queueAck(opId,{state:'deleted',...(result?.path?{path:result.path}:{})});changed=true;
   }catch(err){
    if(PERMANENT.test(err.message)||/尚未写入|删除请求无效/.test(err.message)){queueAck(opId,{state:'conflict',error:short(err.message),...localInfo(t.captureId)});changed=true;}
    else{waiting.add(t.captureId);lastError=/未知操作/.test(err.message)?'Obsidian 采集桥版本过旧，请升级到 0.2.4 并重启 Obsidian 后再删除':short(err.message);}
   }
  }
  if(changed)onChange();
 }
 async function flushOutbox(){
  const entries=Object.entries(state.outbox);if(!entries.length)return;
  for(let i=0;i<entries.length;i+=100){
   const chunk=entries.slice(i,i+100),result=await http('POST','/desktop/ack',{body:{acks:chunk.map(([,ack])=>ack)}});
   for(const item of Array.isArray(result.results)?result.results:[]){
    const key=item?.opId;if(!key||!state.outbox[key])continue;
    if(item.ok||['already-terminal','op-not-found'].includes(item.error))delete state.outbox[key];
    else if(item.error==='invalid-ack'&&state.outbox[key].state!=='failed'){state.outbox[key]={opId:key,state:'failed',error:short('电脑端回执被云端拒绝：'+(item.message||item.error))};}
    else if(item.error==='invalid-ack')delete state.outbox[key];
    else lastError=short(item.message||item.error);
   }
  }
  saveState();
 }
 async function pushProjects(force){
  const list=[...new Set((projects()||[]).map(String))].filter(s=>SLUG.test(s)).slice(0,200).map(slug=>({slug}));
  if(!list.length)return;
  const hash=sha(JSON.stringify(list));
  if(!force&&state.projects?.hash===hash&&now()-(state.projects.at||0)<6*HOUR)return;
  await http('PUT','/meta/projects',{body:{projects:list}});
  state.projects={hash,at:now(),count:list.length};saveState();
 }
 async function cycle({force=false}={}){
  if(stopped)return status();
  if(!configured()||paused())return status();
  if(authFailed&&!force)return status();
  if(running){again=true;return status();}
  running=true;authFailed=false;
  try{
   lastError='';
   await flushOutbox();
   await pullAll();
   await syncLocal();
   await processTracked();
   await flushOutbox();
   await pushProjects(force);
   lastOkAt=now();
  }catch(e){
   if(e.status===401||e.status===403)authFailed=true;
   lastError=short(e.message);log('mobile-sync',lastError);
  }finally{running=false;lastEnd=now();onChange();}
  if(again){again=false;scheduleSoon(800);}
  return status();
 }
 function scheduleSoon(delay=1500){if(stopped)return;clearTimeout(pushTimer);pushTimer=setTimeout(()=>{void cycle();},delay);pushTimer.unref?.();}
 function status(){return {configured:configured(),paused:paused(),authFailed,running,lastOkAt,lastError,tracked:Object.keys(state.ops).length,outbox:Object.keys(state.outbox).length,projects:state.projects?.count??0,baseUrl:(()=>{try{return baseUrl();}catch{return '';}})()};}
 return {
  cycle,status,
  trigger:(force=false)=>{if(force)authFailed=false;scheduleSoon(force?100:Math.max(1500,5000-(now()-lastEnd)));},
  hasWork:()=>Object.keys(state.ops).length>0||Object.keys(state.outbox).length>0,
  start(intervalMs=45000){stopped=false;clearInterval(timer);timer=setInterval(()=>{void cycle();},intervalMs);timer.unref?.();scheduleSoon(3000);},
  stop(){stopped=true;clearInterval(timer);clearTimeout(pushTimer);},
  setPaused(value){config.paused=Boolean(value);saveConfig();onChange();if(!config.paused)scheduleSoon(200);},
  setBaseUrl(value){config.baseUrl=normalizeBase(value);saveConfig();state.projects=null;saveState();authFailed=false;scheduleSoon(200);return config.baseUrl;},
  async setToken(raw){
   const token=String(raw||'').trim();
   if(!/^[!-~]{20,200}$/.test(token))throw Error((token?'剪贴板内容不像云端令牌（需 20–200 个可见 ASCII 字符、无空格换行，当前 '+token.length+' 个字符）':'剪贴板是空的')+'；请先运行“复制移动采集Token到剪贴板.cmd desktop”');
   const health=await http('GET','/health',{token});
   if(health.role!=='desktop')throw Error('这是 '+short(health.role,20)+' 角色令牌，无权拉取队列；请复制 desktop 令牌');
   secret.set(token);state.projects=null;saveState();authFailed=false;lastError='';onChange();scheduleSoon(200);
   return {role:health.role,protocol:health.protocol,version:health.version};
  },
  clearToken(){secret.clear();authFailed=false;onChange();},
 };
}
module.exports={createMobileSync,normalizeBase,DEFAULT_URL,PERMANENT};
