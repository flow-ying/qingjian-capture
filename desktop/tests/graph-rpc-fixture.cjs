'use strict';
const crypto=require('node:crypto');
module.exports=function projection(g,name,a={}){
 const meta={graphId:g.id,projectId:g.projectId,title:g.title,revision:g.revision,snapshot:crypto.createHash('sha256').update(JSON.stringify(g)).digest('hex')};
 if(a.expectedRevision!==undefined&&(a.expectedRevision!==meta.revision||a.expectedSnapshot!==meta.snapshot))throw Object.assign(Error('changed'),{code:'REVISION_CONFLICT'});
 if(name==='task_graph_status')return {connected:true,capabilities:['desktop-status-cycle']};
 if(name==='task_graph_read_summary')return {...meta,counts:{nodes:g.nodes.length,edges:g.edges.length,requirements:g.requirements?.length||0,history:g.history?.length||0}};
 const rows=g[a.section]||[];
 if(name==='task_graph_read_page'){
  const start=Number(a.cursor||0),items=rows.slice(start,start+1).map((value,i)=>JSON.stringify(value).length>200?{index:start+i,value:null,ref:{chunked:true,section:a.section,index:start+i}}:{index:start+i,value}),end=start+items.length;
  return {...meta,section:a.section,total:rows.length,items,complete:end===rows.length,nextCursor:end===rows.length?null:String(end)};
 }
 if(name==='task_graph_read_chunk'){
  const raw=JSON.stringify(rows[a.index]),offset=a.offset||0,end=Math.min(offset+71,raw.length);
  return {...meta,section:a.section,index:a.index,encoding:'json-text',offset,text:raw.slice(offset,end),totalCodeUnits:raw.length,nextOffset:end===raw.length?null:end,complete:end===raw.length};
 }
 throw Error('Unexpected method '+name);
};
