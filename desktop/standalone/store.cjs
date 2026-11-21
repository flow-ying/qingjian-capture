'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {UUID,sha,envelope,validate,payload}=require('./core.cjs');
const asyncChains=new Map();
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2),'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
function writeFast(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');fs.renameSync(tmp,file);}
function writeAsync(file,value){const snapshot=JSON.stringify(value,null,2);const prev=asyncChains.get(file)||Promise.resolve();const next=prev.catch(()=>{}).then(async()=>{await fsp.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await fsp.writeFile(tmp,snapshot,'utf8');await fsp.rename(tmp,file);});asyncChains.set(file,next);return next;}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('本机保存文件无法读取，已保留原文件');}}
function blankDraft(){return {id:crypto.randomUUID(),expectedRevision:0,payload:{type:'note',body:'',source:'',thought:'',due:'',tags:'',project:'',attachments:[]}};}
class Store{
 sourceStates(){return this._sourceStates??=read(path.join(this.root,'source-states.json'),{});}
 isMissing(id){return this.sourceStates()[id]?.state==='missing';}
 isInactive(id){return ['missing','archived'].includes(this.sourceStates()[id]?.state);}
 reconcile(results){const next={...this.sourceStates()};for(const result of results){if(!UUID.test(result.id)||!['present','missing','archived'].includes(result.state)||!this.latest(result.id))continue;next[result.id]={state:result.state,path:result.path??next[result.id]?.path,revision:result.revision??next[result.id]?.revision};}if(JSON.stringify(next)!==JSON.stringify(this.sourceStates())){write(path.join(this.root,'source-states.json'),next);this._sourceStates=next;}}
 constructor(root){this.root=root;this.operations=[];fs.mkdirSync(path.join(root,'operations'),{recursive:true});fs.mkdirSync(path.join(root,'attachments'),{recursive:true});for(const name of fs.readdirSync(path.join(root,'operations'))){if(!/^[a-f0-9-]+-\d+\.json$/.test(name))continue;const op=read(path.join(root,'operations',name));validate(op.envelope);this.operations.push(op);}this.operations.sort((a,b)=>a.envelope.createdAt.localeCompare(b.envelope.createdAt)||a.envelope.revision-b.envelope.revision);}
 file(e){return path.join(this.root,'operations',e.id+'-'+e.revision+'.json');}
 latest(id){return this.operations.filter(o=>o.envelope.id===id).sort((a,b)=>b.envelope.revision-a.envelope.revision)[0];}
 list(){return [...new Set(this.operations.map(o=>o.envelope.id))].filter(id=>!this.isInactive(id)).map(id=>this.latest(id)).sort((a,b)=>b.envelope.createdAt.localeCompare(a.envelope.createdAt)).slice(0,20).map(o=>({id:o.envelope.id,revision:o.envelope.revision,date:o.envelope.date,createdAt:o.envelope.createdAt,payload:o.envelope.payload,status:o.status,error:o.error||'',path:o.receipt?.path??this.sourceStates()[o.envelope.id]?.path??`00_Inbox/Daily/${o.envelope.date}.md`}));}
 save(request){if(!request||!UUID.test(request.id)||!Number.isInteger(request.expectedRevision)||request.expectedRevision<0)throw Error('保存请求无效');const latest=this.latest(request.id),p=payload(request.payload);
  if(this.isMissing(request.id))throw Error('原记录已在 Obsidian 删除，不能覆盖或重新写回');
  if(this.sourceStates()[request.id]?.state==='archived')throw Error('原记录已在工作台归档或结案，请新建草稿保存');
  if(latest&&latest.envelope.revision===request.expectedRevision+1&&JSON.stringify(latest.envelope.payload)===JSON.stringify(p))return latest;
  if((latest?.envelope.revision??0)!==request.expectedRevision)throw Error('记录已改变，请重新打开最近记录');
  for(const a of p.attachments){const file=path.join(this.root,'attachments',a.id+a.ext);if(!fs.existsSync(file)||sha(fs.readFileSync(file))!==a.hash)throw Error('附件未完整保存，请重新添加');}
  const e=envelope(request.id,p,latest?.envelope),op={envelope:e,status:'pending',error:''};write(this.file(e),op);this.operations.push(op);return op;
 }
 // Queue an already-signed envelope that came from the cloud relay (phone/tablet). Never overwrites a newer or different local version.
 importRemote(e){
  const clean=validate(e),id=clean.id,existing=this.operations.find(o=>o.envelope.id===id&&o.envelope.revision===e.revision);
  if(existing){if(existing.envelope.digest===e.digest)return {op:existing,already:true};throw Error(`电脑端已有第 ${e.revision} 版且内容不同，手机的修改基于旧版本，未覆盖`);}
  if(this.isMissing(id))throw Error('原记录已在 Obsidian 删除，不能覆盖或重新写回');
  if(this.sourceStates()[id]?.state==='archived')throw Error('原记录已在工作台归档或结案，请在手机上新建记录');
  const latest=this.latest(id);
  if(e.revision===1){if(latest)throw Error('记录编号已存在，内容不一致');}
  else if(!latest||latest.envelope.revision!==e.revision-1||latest.envelope.digest!==e.previousDigest)throw Error(latest?`电脑端该记录已更新到第 ${latest.envelope.revision} 版，手机的修改基于旧版本，未覆盖`:'电脑端没有该记录的前一版本');
  for(const a of clean.payload.attachments){const file=path.join(this.root,'attachments',a.id+a.ext);if(!fs.existsSync(file)||sha(fs.readFileSync(file))!==a.hash)throw Error('附件未完整下载');}
  const op={envelope:{...clean,digest:e.digest},status:'pending',error:'',origin:'mobile'};write(this.file(op.envelope),op);this.operations.push(op);
  this.operations.sort((a,b)=>a.envelope.createdAt.localeCompare(b.envelope.createdAt)||a.envelope.revision-b.envelope.revision);
  return {op,already:false};
 }
 // Drop a never-landed operation (rejected by the bridge) so the record falls back to its real latest version.
 discard(op){fs.rmSync(this.file(op.envelope),{force:true});const at=this.operations.indexOf(op);if(at>=0)this.operations.splice(at,1);}
 mark(op,status,receipt,error=''){const updated={...op,status,receipt,error};write(this.file(op.envelope),updated);Object.assign(op,updated);}
 importBytes(name,bytes){if(typeof name!=='string'||name.length>240||/[\x00-\x1f]/.test(name)||/密码|密钥|凭据|令牌|私密|隐私|(?:^|[_ .-])(private|secret|credentials?|passwords?|tokens?|cookies?|oauth|api[_ -]?keys?)(?:$|[_ .-])/i.test(name))throw Error('此文件名可能包含敏感内容，未导入');const ext=path.extname(name).toLowerCase();if(!['.png','.jpg','.jpeg','.gif','.webp','.bmp','.pdf','.txt','.md','.csv','.docx','.pptx','.xlsx'].includes(ext))throw Error('支持图片、PDF、文字及常见 Office 附件');const buffer=Buffer.from(bytes);if(!buffer.length||buffer.length>25*1024*1024)throw Error('单个附件需小于 25 MB');const a={id:crypto.randomUUID(),name:path.basename(name),ext,hash:sha(buffer),size:buffer.length};const fd=fs.openSync(path.join(this.root,'attachments',a.id+ext),'wx');try{fs.writeFileSync(fd,buffer);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return a;}
 drafts(bundle){
  const draftsFile=path.join(this.root,'drafts.json');
  if(bundle===undefined){
   const saved=read(draftsFile,null);
   if(saved&&Array.isArray(saved.items)&&saved.items.length){
    const activeId=saved.items.some(d=>d&&d.id===saved.activeId)?saved.activeId:saved.items[0].id;
    return {activeId,items:saved.items};
   }
   const legacy=read(path.join(this.root,'draft.json'),null);
   if(legacy&&legacy.id&&legacy.payload)return {activeId:legacy.id,items:[legacy]};
   const initial=blankDraft();
   return {activeId:initial.id,items:[initial]};
  }
  if(!bundle||!Array.isArray(bundle.items)||!bundle.items.length||bundle.items.length>12)throw Error('草稿槽数量无效（最多 12 个）');
  if(Buffer.byteLength(JSON.stringify(bundle))>500000)throw Error('草稿过大');
  const activeId=bundle.items.some(d=>d&&d.id===bundle.activeId)?bundle.activeId:bundle.items[0].id;
  write(draftsFile,{activeId,items:bundle.items});
  const active=bundle.items.find(d=>d.id===activeId)||bundle.items[0];
  write(path.join(this.root,'draft.json'),active);
  return {activeId,items:bundle.items};
 }
 draft(value){
  if(value===undefined){const b=this.drafts();return b.items.find(d=>d.id===b.activeId)||b.items[0]||null;}
  if(value===null){
   const b=this.drafts(),idx=b.items.findIndex(d=>d.id===b.activeId);
   if(b.items.length>1&&idx>=0){const nextItems=b.items.filter((_,i)=>i!==idx);return this.drafts({activeId:nextItems[Math.min(idx,nextItems.length-1)].id,items:nextItems});}
   const fresh=blankDraft();return this.drafts({activeId:fresh.id,items:[fresh]});
  }
  if(Buffer.byteLength(JSON.stringify(value))>200000)throw Error('草稿过大');
  const b=this.drafts(),idx=b.items.findIndex(d=>d.id===value.id);
  const nextItems=idx>=0?b.items.map((d,i)=>i===idx?value:d):[value,...b.items].slice(0,12);
  return this.drafts({activeId:value.id,items:nextItems});
 }
}
module.exports={Store,write,writeFast,writeAsync,read,blankDraft};
