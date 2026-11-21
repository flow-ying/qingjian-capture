const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {GraphClient,request,cleanGraph,view}=require('../standalone/task-graph-client.cjs'),{layout,prompt,shortPrompt,defaultPrompt,sessionTitle,shortTag,canvasSummary,parseSummary,isDiscussionNode,parseRouting,computeDynamicOverride,buildCalibratePrompt,buildDigestReviewPrompt,appendOverrideHint}=require('../standalone/ui/graph-model.js');
const {createQuotaClient}=require('../standalone/quota-client.cjs');
const graph={id:'g',projectId:'p',revision:1,title:'真实格式测试',nodes:[{id:'a',title:'前置',description:'前置描述',status:'done'},{id:'b',title:'后续',description:'保留完整描述',status:'review'}],edges:[{from:'a',to:'b'}]};
test('read-only boundary rejects writes before opening a pipe',async()=>{await assert.rejects(request('unused','task_graph_update',{}),/只允许读取/);});
test('cache persists selected graph/view and survives disconnect without fabricating live state',async()=>{const dir=path.resolve('artifacts','graph-client-'+Date.now());fs.mkdirSync(dir,{recursive:true});let online=true;const calls=[];const rpc=async(_v,name,args)=>{calls.push(name);if(!online)throw Error('offline');if(name==='task_graph_list_projects')return {projects:[{id:'p',name:'项目'}]};if(name==='task_graph_list_graphs')return {graphs:[{id:'g',title:graph.title,projectId:'p'}],errors:[]};return require('./graph-rpc-fixture.cjs')(graph,name,args);};const c=new GraphClient('fake-identity',dir,rpc),first=await c.snapshot();assert.equal(first.online,true);assert.equal(first.graph.nodes[1].status,'review');c.setView('g',{zoom:.9,x:-33,y:80});online=false;const r=new GraphClient('fake-identity',dir,rpc),offline=await r.snapshot();assert.equal(offline.online,false);assert.equal(offline.graph.title,graph.title);assert.deepEqual(offline.view,{zoom:.9,x:-33,y:80});assert.equal(offline.checkedAt,null);assert.ok(offline.cachedAt);assert.ok(calls.every(n=>/list_projects|list_graphs|graph_read|graph_status/.test(n)));});
test('unknown graph/corrupt cache never replaces original user cache',async()=>{const dir=path.resolve('artifacts','graph-corrupt-'+Date.now());fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'task-graph-cache.json');fs.writeFileSync(file,'broken original');const c=new GraphClient('fake',dir,async()=>{throw Error('offline')});await c.snapshot();assert.throws(()=>c.setView('g',{zoom:1,x:0,y:0}),/保留原文件/);assert.equal(fs.readFileSync(file,'utf8'),'broken original');assert.throws(()=>view({zoom:NaN,x:0,y:0}));assert.throws(()=>view({zoom:4,x:0,y:0}));});
test('layout handles branching, prefers persisted Workbench positions with collision-free fallback, and rejects cyclic graph',()=>{const g=cleanGraph(graph),l=layout(g);assert.ok(l.positions.b.x>l.positions.a.x);const withPos=cleanGraph({...graph,positions:{a:{x:120,y:240},ghost:{x:1,y:1}}});assert.deepEqual(withPos.positions,{a:{x:120,y:240}});const l2=layout(withPos);assert.deepEqual(l2.positions.a,{x:120,y:240});assert.ok(l2.positions.b.x>=120+218+48,'Fallback child stays strictly right of dragged parent');assert.equal(l2.positions.b.y,240);
 const partial={id:'wb',projectId:'p',revision:44,title:'工作台 · 升级',nodes:[{id:'n03',title:'3',description:'',status:'in_progress'},{id:'n05',title:'5',description:'',status:'review'},{id:'n07',title:'7',description:'',status:'review'},{id:'n08',title:'8',description:'',status:'in_progress'},{id:'n14',title:'14',description:'',status:'todo'}],edges:[{from:'n05',to:'n07'},{from:'n05',to:'n08'},{from:'n05',to:'n14'}],positions:{n03:{x:370,y:216},n05:{x:24,y:600},n07:{x:370,y:696},n08:{x:370,y:504}}};
 const lp=layout(partial),pts=Object.entries(lp.positions);
 assert.equal(lp.positions.n14.x,370,'New child aligns with sibling column x=370');
 for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){const [,p]=pts[i],[,q]=pts[j];assert.equal(Math.abs(p.x-q.x)<234&&Math.abs(p.y-q.y)<116,false,`Nodes ${pts[i][0]} and ${pts[j][0]} must never overlap`);}
 const compact={id:'cmp',projectId:'p',revision:1,title:'紧凑旧图',nodes:[{id:'c1',title:'1',description:'',status:'todo'},{id:'c2',title:'2',description:'',status:'todo'}],edges:[],positions:{c1:{x:24,y:200},c2:{x:24,y:260}}};
 const lc=layout(compact);assert.equal(lc.positions.c1.y,200);assert.ok(lc.positions.c2.y>=200+116,'Overlapping compact saved coordinates are separated in 218x100 card space');
 assert.throws(()=>layout({...g,edges:[...g.edges,{from:'b',to:'a'}]}),/循环/);assert.throws(()=>cleanGraph({...g,edges:[{from:'missing',to:'a'}]}),/连线/);});
test('unchanged graph snapshot still refreshes updated Workbench device positions in online and local-disk modes',async()=>{
 const dir=path.resolve('artifacts','graph-pos-sync-'+Date.now());fs.mkdirSync(dir,{recursive:true});
 let livePositions={a:{x:24,y:600}};
 const rpc=async(_v,name,args)=>{
  if(name==='task_graph_list_projects')return {projects:[{id:'p',name:'项目'}]};
  if(name==='task_graph_list_graphs')return {graphs:[{id:'g',title:graph.title,projectId:'p'}],errors:[]};
  const base=require('./graph-rpc-fixture.cjs')(graph,name,args);
  return name==='task_graph_read_summary'?{...base,positions:livePositions}:base;
 };
 const c=new GraphClient('fake-pos-vault',dir,rpc);
 const s1=await c.snapshot('',true);
 assert.deepEqual(s1.graph.positions,{a:{x:24,y:600}});
 livePositions={a:{x:24,y:600},b:{x:370,y:600}};
 const s2=await c.snapshot('',true);
 assert.equal(s2.snapshot,s1.snapshot);
 assert.deepEqual(s2.graph.positions,{a:{x:24,y:600},b:{x:370,y:600}});
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'task-graph-cache.json'),'utf8'));
 assert.deepEqual(saved.graphs.g.graph.positions,{a:{x:24,y:600},b:{x:370,y:600}});
});
test('copy retains description, [图简称#编号] identity, anti-stripping short MCP prompt and unmet prerequisite warning',()=>{const text=prompt(graph,graph.nodes[1],'项目名');assert.equal(sessionTitle(graph,graph.nodes[1],'项目名'),'[真实格式测试#02] 后续');assert.match(text,/\[真实格式测试#02\] 后续/);assert.match(text,/保留完整描述/);assert.match(text,/勾选完成不代表可用/);assert.equal(shortTag('工作台 · 工作流、多端与采集体验升级','Obsidian 工作系统'),'工作台');assert.match(shortPrompt(graph,graph.nodes[1],'项目名'),/请执行任务「真实格式测试02 后续」/);assert.match(shortPrompt(graph,graph.nodes[1],'项目名'),/读取图 g 的第 02 号节点/);assert.equal(defaultPrompt(graph,graph.nodes[1],'项目名'),shortPrompt(graph,graph.nodes[1],'项目名'));assert.equal(defaultPrompt(graph,{...graph.nodes[1],summary:'【首选：Grok · Grok 4.7 (Think) ｜ 平替：Gemini Web · Deep Research ｜ 用量：S · C】\n社区核查'},'项目名').includes('保留完整描述'),true);assert.equal(canvasSummary('【首选：Antigravity · Orchestrator (Carbon) ｜ 平替：Sonnet ｜ 用量：L · A1】\n升级交互体验'),'Orchestrator (Carbon) · 升级交互体验');const qSummary='原问题：想了解 Git 心智与 Codex 自动代码审查？\n暂聊方向：对比现有工具查漏补缺。\n【首选：Antigravity · Gemini 4 Carbon (High) ｜ 平替：Opus ｜ 用量：M · A1】';assert.equal(parseSummary(qSummary).humanBody.includes('【首选：'),false);assert.equal(canvasSummary(qSummary),'原问题：想了解 Git 心智与 Codex 自动代码审查？ · Gemini 4 Carbon (High)');const disc={...graph.nodes[1],title:'💬 想了解 Git 心智与 Codex 自动代码审查？',summary:qSummary};assert.equal(isDiscussionNode(disc),true);assert.match(shortPrompt(graph,disc,'项目名'),/请先陪我讨论问题「真实格式测试02 想了解Git心智」/);assert.match(shortPrompt(graph,disc,'项目名'),/我的原问题：想了解 Git 心智与 Codex 自动代码审查？/);assert.match(shortPrompt(graph,disc,'项目名'),/核对无阻塞后先调 task_graph_set_progress 置为处理中/);});
test('offline Vault fallback reads live local task-graphs directly, sorts by pinned order, and prunes archived cache entries',async()=>{
 const base=path.resolve('artifacts','graph-local-sync-'+Date.now()),vault=path.join(base,'vault'),cacheDir=path.join(base,'cache');
 const tg=path.join(vault,'.obsidian/plugins/personal-workbench/state/task-graphs');
 fs.mkdirSync(path.join(tg,'graphs'),{recursive:true});fs.mkdirSync(cacheDir,{recursive:true});
 fs.writeFileSync(path.join(vault,'.obsidian/plugins/personal-workbench/state/workbenches.json'),JSON.stringify({workbenches:[{modules:[{type:'task-graph',options:{graphIds:['g_wb','g_sid']}}]}]}));
 fs.writeFileSync(path.join(tg,'projects.json'),JSON.stringify({projects:[{id:'p_sid',name:'私人助手'},{id:'p_wb',name:'工作系统'}]}));
 fs.writeFileSync(path.join(tg,'graphs/g_sid.json'),JSON.stringify({id:'g_sid',projectId:'p_sid',revision:1,title:'Sid · 调优',archived:false,deleted:false,nodes:[{id:'n1',title:'去蠢',description:'d',status:'todo'}],edges:[]}));
 fs.writeFileSync(path.join(tg,'graphs/g_wb.json'),JSON.stringify({id:'g_wb',projectId:'p_wb',revision:2,title:'工作台 · 升级',archived:false,deleted:false,nodes:[{id:'n2',title:'同步',description:'d2',status:'in_progress'}],edges:[]}));
 fs.writeFileSync(path.join(tg,'graphs/g_old.json'),JSON.stringify({id:'g_old',projectId:'p_wb',revision:9,title:'旧归档图',archived:true,deleted:false,nodes:[],edges:[]}));
 fs.writeFileSync(path.join(cacheDir,'task-graph-cache.json'),JSON.stringify({schema:1,catalog:[{id:'g_old',title:'旧归档图',projectId:'p_wb',projectName:'工作系统'}],graphs:{g_old:{graph:{id:'g_old',projectId:'p_wb',revision:9,title:'旧归档图',nodes:[],edges:[]},snapshot:'0'.repeat(64),at:'2026-11-01T00:00:00Z'}},views:{},selected:'g_old'}));
 const client=new GraphClient(vault,cacheDir,async()=>{const e=Error('disconnected');e.code='DISCONNECTED';throw e;});
 const snap=await client.snapshot('',false);
 assert.equal(snap.online,false);assert.equal(snap.localDisk,true);assert.equal(snap.canCycle,false);
 assert.deepEqual(snap.catalog.map(g=>g.id),['g_wb','g_sid']);
 assert.equal(snap.selected,'g_wb');assert.equal(snap.graph.title,'工作台 · 升级');
 const saved=JSON.parse(fs.readFileSync(path.join(cacheDir,'task-graph-cache.json'),'utf8'));
 assert.equal('g_old' in saved.graphs,false);
});
test('quota-client caches, respects force/lastGood, degrades quietly when script is missing',async()=>{
 const dir=path.resolve('artifacts','quota-client-'+Date.now()),script=path.join(dir,'quota.py');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(script,'# stub');
 let calls=0,fail=false;
 const client=createQuotaClient({scriptPath:script,ttlMs:60000,runner:async()=>{calls++;if(fail)throw Error('boom');return JSON.stringify({now:'n'+calls,primary:'A1',relay:'A2',order:['A1','A2','B'],digest:{date:'2026-11-21',landed:true,hasChange:true,pendingReview:true,headline:'h'},pools:{},tips:[],uncalibrated:[]});}});
 const r1=await client.get(false);assert.equal(r1.available,true);assert.equal(r1.status.now,'n1');
 const r2=await client.get(false);assert.equal(r2.status.now,'n1');assert.equal(calls,1);
 const r3=await client.get(true);assert.equal(r3.status.now,'n2');assert.equal(calls,2);
 fail=true;const r4=await client.get(true);assert.equal(r4.available,true);assert.equal(r4.status.now,'n2');assert.match(r4.error,/保留上次快照/);
 const missing=createQuotaClient({scriptPath:path.join(dir,'none.py')});
 const rm=await missing.get(true);assert.equal(rm.available,false);assert.equal(rm.status,null);assert.equal(rm.error,'');
});
test('graph-model dynamic override enforces 禁派全系 Claude, non-todo guard, and prompt builders',()=>{
 const quota={now:'2026-11-21T17:10+0900',primary:'A1',relay:'A2',order:['A1','A2','B'],digest:{date:'2026-11-21',landed:true,hasChange:true,pendingReview:true,headline:'Neon扩容'},pools:{
  B:{label:'Claude Pro',hoursToReset:120,reservePct:0,phase:'平稳期',weekly:{usedPct:48.8,lowerBound:true,confidence:'estimated'},burn:{targetDays:5.5,targetPct:100,targetUsedNowPct:31.1,ratio:1.57,dailyBudgetPct:13.5,warn:'fast'},exhausted:false},
  A2:{label:'Ultra Claude',hoursToReset:95,reservePct:0,phase:'平稳期',weekly:{usedPct:60,lowerBound:true,confidence:'anchor-only'},burn:{targetDays:5.5,targetPct:100,targetUsedNowPct:54.9,ratio:1.09},exhausted:false},
  A1:{label:'Ultra Gemini',hoursToReset:93,reservePct:12,phase:'平稳期',weekly:{usedPct:55,lowerBound:true,confidence:'anchor-only+'},burn:{targetDays:6,targetPct:88,targetUsedNowPct:45.9,ratio:1.2},exhausted:false},
  C:{label:'Grok',hoursToReset:75,reservePct:0,phase:'平稳期',weekly:{usedPct:8,lowerBound:false,confidence:'anchor-only'},burn:{targetDays:5.5,targetPct:100,targetUsedNowPct:70.3,ratio:0.11,warn:'slow'},exhausted:false,advice:{state:'open',text:'可放开用'}}
 },tips:[],uncalibrated:['A2','A1','C']};
 const bTodo={status:'todo',summary:'原问题：开源\n【首选：Claude Desktop (Code 页签) · Claude Sonnet 5.5 (medium) ｜ 平替：Antigravity · Gemini 4 Neon (Medium) ｜ 用量：M · B】'};
 const ov=computeDynamicOverride(bTodo,quota,'副业 · 开源');
 assert.equal(ov.targetPool,'A1');assert.equal(ov.source,'fallback');
 assert.equal(computeDynamicOverride({...bTodo,status:'in_progress'},quota,'副业 · 开源'),null);
 assert.equal(parseRouting('原问题：测试\n【首选：Antigravity · Orchestrator (Neon) ｜ 平替：Claude Desktop · Sonnet ｜ 用量：M · A1】','工作台').forbidClaude,false);
 quota.pools.A1.exhausted=true;
 const noClaudeTodo={status:'todo',summary:'原问题：反爬调试\n【首选：Antigravity · Gemini 4 Neon (Medium) ｜ 平替：Claude Desktop · Opus / Grok · Grok 4.7 (Think) ｜ 用量：M · A1 ｜ 禁派全系 Claude】'};
 const safe=computeDynamicOverride(noClaudeTodo,quota,'隐私边界 · 值守');
 assert.equal(safe.targetPool,'C');
 quota.pools.C.advice={state:'guard',text:'预留'};
 assert.equal(computeDynamicOverride(noClaudeTodo,quota,'隐私边界 · 值守'),null);
 assert.match(buildCalibratePrompt(quota),/--logged-share/);
 assert.match(buildDigestReviewPrompt(quota),/ack-digest 2026-11-21/);
 assert.match(appendOverrideHint('请执行任务「a」',ov),/实时算力参考/);
});
