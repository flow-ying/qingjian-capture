'use strict';
const fs=require('node:fs'),net=require('node:net'),path=require('node:path'),crypto=require('node:crypto');
const {read,write,writeFast}=require('./store.cjs');
const READS=new Set(['task_graph_status','task_graph_list_projects','task_graph_list_graphs','task_graph_read_summary','task_graph_read_page','task_graph_read_chunk']);
const safeId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
function address(vault){return '\\\\.\\pipe\\personal-workbench-task-graph-'+crypto.createHash('sha256').update(path.resolve(vault).replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase()).digest('hex').slice(0,32);}
function request(vault,name,args={}){
 if(!READS.has(name)&&name!=='desktop_task_graph_cycle_status')return Promise.reject(Error('悬浮窗只允许读取任务图及人工切换状态'));
 return new Promise((resolve,reject)=>{const socket=net.createConnection(address(vault));let input='',bytes=0,settled=false;const timer=setTimeout(()=>finish(Error(name==='desktop_task_graph_cycle_status'?'保存结果未知，请点击同一节点核对上次操作':'任务图连接超时')),name==='desktop_task_graph_cycle_status'?30000:5000);
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);}
  socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify({name,args})+'\n'));
  socket.on('error',()=>finish(Object.assign(Error('未连接工作台，请打开 Obsidian 并启用 Personal Workbench'),{code:'DISCONNECTED'})));
  socket.on('data',chunk=>{input+=chunk;bytes+=Buffer.byteLength(chunk);if(bytes>4*1024*1024)return finish(Error('任务图响应超过大小限制'));const end=input.indexOf('\n');if(end<0)return;try{const r=JSON.parse(input.slice(0,end));if(!r.ok){const e=Error(r.error?.message||'任务图读取失败');e.code=r.error?.code;finish(e);}else finish(null,r.data);}catch(e){finish(e);}});
  socket.on('end',()=>finish(Error('任务图连接提前关闭')));
 });
}
function cleanGraph(g){
 if(!g||!safeId(g.id)||!safeId(g.projectId)||!Number.isSafeInteger(g.revision)||typeof g.title!=='string'||!Array.isArray(g.nodes)||g.nodes.length>1000||!Array.isArray(g.edges)||g.edges.length>10000)throw Error('任务图结构无法读取');
 const ids=new Set();for(const n of g.nodes){if(!safeId(n.id)||ids.has(n.id)||typeof n.title!=='string'||typeof n.description!=='string'||!['todo','in_progress','review','done'].includes(n.status))throw Error('任务图节点无效');ids.add(n.id);}
 for(const e of g.edges)if(!ids.has(e.from)||!ids.has(e.to))throw Error('任务图连线无效');
 const positions={};
 if(g.positions&&typeof g.positions==='object'){
  for(const [nid,pt]of Object.entries(g.positions))if(ids.has(nid)&&pt&&Number.isFinite(pt.x)&&Number.isFinite(pt.y)&&pt.x>=0&&pt.y>=0)positions[nid]={x:pt.x,y:pt.y};
 }
 return {id:g.id,projectId:g.projectId,title:g.title,revision:g.revision,archived:!!g.archived,deleted:!!g.deleted,nodes:g.nodes.map(n=>Object.fromEntries(['id','title','description','summary','expected','number','status','inputs','plan','promptVersion','delivery'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]]))),edges:g.edges.map(e=>({from:e.from,to:e.to})),requirements:g.requirements||[],...(Object.keys(positions).length?{positions}:{})};
}
function samePositions(a,b){
 const ka=a?Object.keys(a).sort():[],kb=b?Object.keys(b).sort():[];
 if(ka.length!==kb.length)return false;
 for(let i=0;i<ka.length;i++){const k=ka[i];if(k!==kb[i]||a[k].x!==b[k].x||a[k].y!==b[k].y)return false;}
 return true;
}
function view(v){if(!v||!['zoom','x','y'].every(k=>Number.isFinite(v[k]))||v.zoom<.15||v.zoom>2.5||Math.abs(v.x)>1e7||Math.abs(v.y)>1e7)throw Error('任务图视角无效');return {zoom:v.zoom,x:v.x,y:v.y};}
// Only publish a fully reconstructed, single-snapshot projection. Never cache partial pages.
async function readGraph(vault,id,rpc=request,cached){
 for(let attempt=0;attempt<2;attempt++)try{
  const meta=await rpc(vault,'task_graph_read_summary',{graphId:id});
  if(meta.graphId!==id||!Number.isSafeInteger(meta.revision)||!/^[a-f0-9]{64}$/.test(meta.snapshot)||!meta.counts)throw Error('任务图概要无效');
  const same=r=>{if(r.graphId!==id||r.revision!==meta.revision||r.snapshot!==meta.snapshot)throw Object.assign(Error('图内容已改变，请刷新'),{code:'REVISION_CONFLICT'});};
  if(meta.archived||meta.deleted)throw Error('该任务图已移除或归档，请刷新列表');
  if(cached?.snapshot===meta.snapshot){const nextPos=meta.positions!==undefined?meta.positions:cached.graph?.positions;return {graph:cleanGraph({...cached.graph,positions:nextPos}),snapshot:meta.snapshot};}
  const args={graphId:id,expectedRevision:meta.revision,expectedSnapshot:meta.snapshot};
  const graph={...meta,id};
  for(const section of ['nodes','edges','requirements']){
   const values=[],seen=new Set();let cursor;
   if(!Number.isSafeInteger(meta.counts[section])||meta.counts[section]<0)throw Error('任务图数量无效');
   do{
    const page=await rpc(vault,'task_graph_read_page',{...args,section,limit:100,...(cursor?{cursor}:{})});same(page);
    if(page.section!==section||page.total!==meta.counts[section]||!Array.isArray(page.items))throw Error('任务图分页无效');
    for(const item of page.items){
     if(item.index!==values.length)throw Error('任务图分页顺序无效');
     let value=item.value;
     if(value===null){
      if(!item.ref?.chunked||item.ref.section!==section||item.ref.index!==item.index)throw Error('任务图分段引用无效');
      let offset=0,total,text='';
      do{
       const chunk=await rpc(vault,'task_graph_read_chunk',{...args,section,index:item.index,offset});same(chunk);
       if(chunk.section!==section||chunk.index!==item.index||chunk.offset!==offset||chunk.encoding!=='json-text'||typeof chunk.text!=='string'||!Number.isSafeInteger(chunk.totalCodeUnits)||chunk.totalCodeUnits<0)throw Error('任务图分段无效');
       if(total!==undefined&&total!==chunk.totalCodeUnits)throw Error('任务图分段长度变化');total=chunk.totalCodeUnits;text+=chunk.text;
       if(chunk.complete){if(chunk.nextOffset!==null||text.length!==total)throw Error('任务图分段未读完整');break;}
       if(chunk.nextOffset!==text.length||chunk.nextOffset<=offset||chunk.nextOffset>=total)throw Error('任务图分段位置无效');offset=chunk.nextOffset;
      }while(true);
      value=JSON.parse(text);
     }
     values.push(value);
    }
    if(page.complete){if(page.nextCursor!==null||values.length!==meta.counts[section])throw Error('任务图分页未读完整');break;}
    if(!page.items.length||typeof page.nextCursor!=='string'||!page.nextCursor||seen.has(page.nextCursor)||values.length>=meta.counts[section])throw Error('任务图分页无法继续');
    cursor=page.nextCursor;seen.add(cursor);
   }while(true);
   graph[section]=values;
  }
  const endMeta=await rpc(vault,'task_graph_read_summary',{graphId:id});same(endMeta);
  if(endMeta.positions!==undefined)graph.positions=endMeta.positions;
  return {graph:cleanGraph(graph),snapshot:meta.snapshot};
 }catch(e){if(e.code==='UNKNOWN_TOOL')throw Error('工作台版本不支持大图读取，请更新 Personal Workbench 至 0.1.54 或以上');if(e.code!=='REVISION_CONFLICT'||attempt===1)throw e;}
}
function pinnedGraphOrder(vault){
 try{
  const f=path.join(vault,'.obsidian/plugins/personal-workbench/state/workbenches.json');
  if(!fs.existsSync(f))return [];
  const wb=JSON.parse(fs.readFileSync(f,'utf8')),ids=[];
  for(const b of wb.workbenches||[])for(const m of b.modules||[])if(m.type==='task-graph'&&Array.isArray(m.options?.graphIds))for(const id of m.options.graphIds)if(safeId(id)&&!ids.includes(id))ids.push(id);
  return ids;
 }catch{return [];}
}
function sortByPinnedOrder(rows,vault){
 const pins=pinnedGraphOrder(vault);if(!pins.length)return rows;
 const rank=new Map(pins.map((id,i)=>[id,i]));
 return [...rows].sort((a,b)=>(rank.get(a.id)??9999)-(rank.get(b.id)??9999));
}
function localDevicePositions(tgRoot,graphId){
 try{
  const devRoot=path.join(tgRoot,'devices');if(!fs.existsSync(devRoot))return undefined;
  const dirs=fs.readdirSync(devRoot,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>{const pf=path.join(devRoot,d.name,'preferences.json');try{return {pf,mtime:fs.statSync(pf).mtimeMs};}catch{return null;}}).filter(Boolean).sort((a,b)=>b.mtime-a.mtime);
  let best=null,bestCount=0;
  for(const {pf} of dirs){
   const prefs=JSON.parse(fs.readFileSync(pf,'utf8'));
   for(const [ck,comp] of Object.entries(prefs.components||{})){
    const pos=comp?.graphs?.[graphId]?.positions,cnt=pos&&typeof pos==='object'?Object.keys(pos).length:0;
    if(cnt>bestCount||(cnt===bestCount&&cnt>0&&ck.endsWith('_windows')&&!best?.windows)){best={pos,windows:ck.endsWith('_windows')};bestCount=cnt;}
   }
  }
  return best?.pos;
 }catch{}
 return undefined;
}
function readLocalVault(vault,selectedId){
 if(typeof vault!=='string'||!vault)return null;
 const tgRoot=path.join(vault,'.obsidian/plugins/personal-workbench/state/task-graphs'),projFile=path.join(tgRoot,'projects.json'),graphsDir=path.join(tgRoot,'graphs');
 if(!fs.existsSync(projFile)||!fs.existsSync(graphsDir))return null;
 const registry=JSON.parse(fs.readFileSync(projFile,'utf8'));
 if(!Array.isArray(registry?.projects))throw Error('本地任务图项目列表格式无效');
 const projMap=new Map();for(const p of registry.projects)if(safeId(p.id)&&typeof p.name==='string')projMap.set(p.id,p.name);
 const rows=[],rawById=new Map();
 for(const fname of fs.readdirSync(graphsDir).filter(f=>f.endsWith('.json'))){
  const raw=fs.readFileSync(path.join(graphsDir,fname),'utf8'),g=JSON.parse(raw);
  if(!safeId(g.id)||!projMap.has(g.projectId)||g.deleted||g.archived)continue;
  rows.push({id:g.id,title:g.title,projectId:g.projectId,revision:g.revision,archived:false,nodeCount:Array.isArray(g.nodes)?g.nodes.length:0,projectName:projMap.get(g.projectId)});
  rawById.set(g.id,{raw,parsed:g});
 }
 const ordered=sortByPinnedOrder(rows,vault),chosen=ordered.some(g=>g.id===selectedId)?selectedId:(ordered[0]?.id||'');
 let loaded=null;
 if(chosen&&rawById.has(chosen)){
  const {raw,parsed}=rawById.get(chosen),snapshot=crypto.createHash('sha256').update(raw).digest('hex'),positions=localDevicePositions(tgRoot,chosen);
  loaded={graph:cleanGraph({...parsed,...(positions?{positions}:{})}),snapshot};
 }
 return {catalog:ordered,selected:chosen,loaded};
}
function localProjectTags(vault){
 const tags=[];const add=raw=>{const clean=String(raw||'').replace(/^[《「【\s]+|[》」】\s]+$/g,'').trim();if(!clean)return;const m=clean.match(/^([^·:：]{1,10}?)\s*(?:[·:：]|——|--)/);const short=(m&&m[1]?m[1]:clean).replace(/\s+/g,'').slice(0,12);if(short&&!/[#\[\]|<>]/.test(short)&&!tags.includes(short))tags.push(short);};
 try{
  const tgRoot=path.join(vault,'.obsidian/plugins/personal-workbench/state/task-graphs'),graphsDir=path.join(tgRoot,'graphs'),projFile=path.join(tgRoot,'projects.json');
  if(fs.existsSync(graphsDir)){const ordered=[];for(const f of fs.readdirSync(graphsDir).filter(x=>x.endsWith('.json'))){try{const g=JSON.parse(fs.readFileSync(path.join(graphsDir,f),'utf8'));if(g&&!g.archived&&!g.deleted&&safeId(g.id))ordered.push(g);}catch{}}for(const g of sortByPinnedOrder(ordered,vault))add(g.title);}
  if(fs.existsSync(projFile)){const reg=JSON.parse(fs.readFileSync(projFile,'utf8'));for(const p of reg?.projects||[])add(p.name);}
 }catch{}
 return tags.slice(0,12);
}
class GraphClient{
 constructor(vault,root,rpc=request){this.vault=vault;this.file=path.join(root,'task-graph-cache.json');this.rpc=rpc;this.catalogAt=0;this.inflight=null;this.viewDirty=false;this.cacheError='';try{this.cache=read(this.file,{schema:1,catalog:[],graphs:{},views:{},selected:''});if(this.cache.schema!==1||!Array.isArray(this.cache.catalog)||!this.cache.graphs||!this.cache.views)throw Error('任务图缓存格式不支持');}catch(e){this.cacheError=e.message;this.cache={schema:1,catalog:[],graphs:{},views:{},selected:''};}}
 save(durable=false){if(this.cacheError)throw Error('旧任务图缓存无法读取，已保留原文件；'+this.cacheError);this.viewDirty=false;(durable?write:writeFast)(this.file,this.cache);}
 flushSync(){if(this.viewDirty&&!this.cacheError)this.save(false);}
 pruneRemoved(rows){const active=new Set(rows.map(g=>g.id));let changed=false;for(const id of Object.keys(this.cache.graphs))if(!active.has(id)){delete this.cache.graphs[id];changed=true;}return changed;}
 async catalog(force=false){if(!force&&Date.now()-this.catalogAt<15000)return this.cache.catalog;
  const registry=await this.rpc(this.vault,'task_graph_list_projects');if(!Array.isArray(registry?.projects))throw Error('项目列表格式无效');
  for(const p of registry.projects)if(!safeId(p.id)||typeof p.name!=='string')throw Error('项目列表无效');
  const lists=await Promise.all(registry.projects.map(async p=>({p,result:await this.rpc(this.vault,'task_graph_list_graphs',{projectId:p.id})})));
  const rows=[];
  for(const {p,result} of lists){if(!Array.isArray(result?.graphs)||result.errors?.length)throw Error('部分任务图无法读取，请在工作台检查');for(const g of result.graphs){if(!safeId(g.id)||typeof g.title!=='string')throw Error('图列表无效');if(!g.archived)rows.push({...g,projectName:p.name});}}
  const ordered=sortByPinnedOrder(rows,this.vault);
  this.catalogAt=Date.now();const pruned=this.pruneRemoved(ordered);if(pruned||JSON.stringify(ordered)!==JSON.stringify(this.cache.catalog)){this.cache.catalog=ordered;this.save();}return ordered;
 }
 async snapshot(id,force=false){if(id!==undefined&&id!==''&&!safeId(id))throw Error('图编号无效');let selected=id||this.cache.selected;let online=false,localDisk=false,connected=false,canCycle=false,editorBusy=false,error='',checkedAt=null;
  try{const rows=await this.catalog(force);if(!rows.some(g=>g.id===selected))selected=rows[0]?.id||'';
   if(selected){const prev=this.cache.graphs[selected],result=await readGraph(this.vault,selected,this.rpc,prev);if(!prev||prev.snapshot!==result.snapshot||!samePositions(prev.graph?.positions,result.graph?.positions)){this.cache.graphs[selected]={...result,at:new Date().toISOString()};this.save();}}
   checkedAt=new Date().toISOString();online=true;connected=true;const status=await this.rpc(this.vault,'task_graph_status',{});canCycle=status.capabilities?.includes('desktop-status-cycle')===true;editorBusy=status.editorBusy===true;
  }catch(e){
   let handledLocal=false;
   if(!this.cacheError){
    try{
     const local=readLocalVault(this.vault,selected);
     if(local){
      selected=local.selected;checkedAt=new Date().toISOString();localDisk=true;handledLocal=true;
      let dirty=this.pruneRemoved(local.catalog);
      if(JSON.stringify(local.catalog)!==JSON.stringify(this.cache.catalog)){this.cache.catalog=local.catalog;dirty=true;}
      if(local.loaded){const prev=this.cache.graphs[selected];if(!prev||prev.snapshot!==local.loaded.snapshot||!samePositions(prev.graph?.positions,local.loaded.graph?.positions)){this.cache.graphs[selected]={...local.loaded,at:checkedAt};dirty=true;}}
      if(dirty)this.save();
     }
    }catch(le){error=le.message;}
   }
   if(!handledLocal){error=e.message;try{connected=(await this.rpc(this.vault,'task_graph_status',{}))?.connected===true;}catch{}}
  }
  if(selected!==this.cache.selected){this.cache.selected=selected;try{this.save();}catch(e){error=e.message;}}
  const cached=this.cache.graphs[selected];return {catalog:this.cache.catalog,selected,graph:cached?.graph||null,cachedAt:cached?.at||null,checkedAt,online,localDisk,connected,canCycle:online&&canCycle&&!editorBusy&&!this.cacheError,editorBusy,pendingStatus:this.cache.pendingStatus?{graphId:this.cache.pendingStatus.graphId,nodeId:this.cache.pendingStatus.nodeId}:null,snapshot:cached?.snapshot||null,error:error||this.cacheError,view:this.cache.views[selected]||null};
 }
 async cycle(data){
  if(!data||!safeId(data.graphId)||!safeId(data.nodeId))throw Error('节点编号无效');
  const existing=this.cache.pendingStatus;
  if(existing&&(existing.graphId!==data.graphId||existing.nodeId!==data.nodeId))throw Error('请先点击上次操作的节点核对保存结果');
  if(!existing){
   const cached=this.cache.graphs[data.graphId],node=cached?.graph.nodes.find(n=>n.id===data.nodeId);
   if(!node||cached.graph.revision!==data.expectedRevision||cached.snapshot!==data.expectedSnapshot||node.status!==data.expectedStatus)throw Error('显示内容已变化，请刷新后再选择状态');
   this.cache.pendingStatus={requestId:crypto.randomUUID(),graphId:data.graphId,nodeId:data.nodeId,expectedRevision:data.expectedRevision,expectedSnapshot:data.expectedSnapshot,expectedStatus:data.expectedStatus};
   try{this.save(true);}catch(e){delete this.cache.pendingStatus;throw e;}
  }
  let result;
  try{result=await this.rpc(this.vault,'desktop_task_graph_cycle_status',this.cache.pendingStatus);}
  catch(e){
   if(['REVISION_CONFLICT','EDITOR_BUSY','INACTIVE_GRAPH','UNKNOWN_TOOL','INVALID_INPUT','REQUEST_REUSED','LIMIT','NOT_FOUND','REJECTED'].includes(e.code)){
    delete this.cache.pendingStatus;this.save(true);
    if(e.code==='UNKNOWN_TOOL')throw Error('工作台尚不支持状态切换，请更新 Personal Workbench 至0.1.57或以上');
    throw e;
   }
   throw Error('保存结果未确认；请点击同一节点核对上次操作，不会重复切换。'+e.message);
  }
  if(result?.saved!==true||result.graphId!==data.graphId||result.nodeId!==data.nodeId)throw Error('保存回执无效；请点击同一节点核对上次操作');
  const pending=this.cache.pendingStatus;delete this.cache.pendingStatus;
  try{this.save(true);}catch(e){this.cache.pendingStatus=pending;throw Error('已保存，但本机回执未保存；请点击同一节点核对。'+e.message);}
  this.catalogAt=0;
  return {saved:true,replayed:result.replayed===true,status:result.status};
 }
 setView(id,value){if(!safeId(id))throw Error('图编号无效');this.cache.views[id]=view(value);this.save(false);}
}
module.exports={address,request,cleanGraph,GraphClient,safeId,view,readGraph,readLocalVault,sortByPinnedOrder,samePositions,localProjectTags};
