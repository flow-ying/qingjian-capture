const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const {GraphClient}=require('../standalone/task-graph-client.cjs'),projection=require('./graph-rpc-fixture.cjs');
function setup(){
 const g={id:'g',projectId:'p',revision:1,title:'g',nodes:[{id:'n',title:'n',description:'prompt',status:'todo'}],edges:[]};
 const dir=path.resolve('artifacts','status-'+crypto.randomUUID()),receipts=new Map();let writes=0,mode='ok';
 const rpc=async(v,name,a)=>{
  if(name==='task_graph_list_projects')return {projects:[{id:'p',name:'p'}]};if(name==='task_graph_list_graphs')return {graphs:[{id:'g',title:'g',projectId:'p'}]};
  if(name!=='desktop_task_graph_cycle_status')return projection(g,name,a);
  if(receipts.has(a.requestId))return {...receipts.get(a.requestId),replayed:true};
  if(mode==='busy')throw Object.assign(Error('EDITOR_BUSY'),{code:'EDITOR_BUSY'});
  if(mode==='stale')throw Object.assign(Error('changed'),{code:'REVISION_CONFLICT'});
  writes++;g.nodes[0].status={todo:'in_progress',in_progress:'review',review:'done',done:'todo'}[g.nodes[0].status];g.revision++;
  const r={saved:true,graphId:'g',nodeId:'n',status:g.nodes[0].status};receipts.set(a.requestId,r);
  if(mode==='lost')throw Error('lost response');return r;
 };
 const client=new GraphClient('fake',dir,rpc),data=()=>({graphId:'g',nodeId:'n',expectedRevision:client.cache.graphs.g.graph.revision,expectedSnapshot:client.cache.graphs.g.snapshot,expectedStatus:client.cache.graphs.g.graph.nodes[0].status});
 return {client,dir,rpc,data,g,setMode:m=>mode=m,writes:()=>writes};
}
test('manual cycle confirms write without optimistic cache mutation',async()=>{const e=setup();await e.client.snapshot();assert.equal((await e.client.cycle(e.data())).saved,true);assert.equal(e.client.cache.graphs.g.graph.nodes[0].status,'todo');const s=await e.client.snapshot();assert.equal(s.graph.nodes[0].status,'in_progress');assert.equal(s.canCycle,true);assert.equal(e.client.cache.pendingStatus,undefined);});
test('lost reply survives restart and retries the same receipt without advancing twice',async()=>{const e=setup();await e.client.snapshot();e.setMode('lost');await assert.rejects(e.client.cycle(e.data()),/未确认/);const request=e.client.cache.pendingStatus;const c=new GraphClient('fake',e.dir,e.rpc);await c.snapshot();await c.cycle({graphId:'g',nodeId:'n'});assert.equal(e.writes(),1);assert.equal(e.g.nodes[0].status,'in_progress');assert.ok(request.requestId);assert.equal(c.cache.pendingStatus,undefined);});
test('stale, dirty and different-target requests do not silently overwrite or queue new work',async()=>{const e=setup();await e.client.snapshot();e.setMode('busy');await assert.rejects(e.client.cycle(e.data()),/EDITOR_BUSY/);assert.equal(e.client.cache.pendingStatus,undefined);e.setMode('stale');await assert.rejects(e.client.cycle(e.data()),/changed/);assert.equal(e.writes(),0);e.setMode('lost');await assert.rejects(e.client.cycle(e.data()));await assert.rejects(e.client.cycle({...e.data(),nodeId:'other'}),/上次操作/);assert.equal(e.writes(),1);});
