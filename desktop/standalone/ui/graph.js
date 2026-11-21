'use strict';
const q=s=>document.querySelector(s),api=window.taskGraph,M=window.GraphModel;
let current=null,catalog=[],selectedNode=null,camera={zoom:1,x:0,y:0},layout=null,sequence=0,loading=0,saveTimer=null,frame=null,pan=null,drag=null,lastCatalog='',closed=false;
const views=new Map();
let currentSnapshot=null,canCycle=false,statusSaving=false,pendingStatus=null,statusNotice='',editorBusy=false,quotaState=null,quotaLoading=false,includeOverrideInCopy=true;
const nextStatus=s=>({todo:'in_progress',in_progress:'review',review:'done',done:'todo'}[s]);
function poolStateKey(id,info){if(!info)return 'unknown';if(info.exhausted||(id==='C'&&['guard','expired'].includes(info.advice?.state||'')))return 'exhausted';if(info.burn?.warn==='fast')return 'fast';if(info.burn?.warn==='slow')return 'slow';return info.weekly?.usedPct==null?'unknown':'ok';}
function flashEl(btn,base){btn.textContent='✓ 已复制';setTimeout(()=>{if(btn.isConnected)btn.textContent=base;},1500);}
function closeQuotaPopover(restore=false){const pop=q('#quota-popover');if(!pop||pop.hidden)return;pop.hidden=true;q('#quota-toggle')?.setAttribute('aria-expanded','false');if(restore)q('#quota-toggle')?.focus({preventScroll:true});}
function placeQuotaPopover(){const pop=q('#quota-popover'),bar=q('#quota-bar');if(!pop||pop.hidden||!bar)return;const r=bar.getBoundingClientRect();pop.style.top=Math.max(40,Math.round(r.bottom+5))+'px';pop.style.maxHeight=Math.max(160,Math.round(innerHeight-r.bottom-16))+'px';}
function renderQuotaBar(){
 const bar=q('#quota-bar'),toggle=q('#quota-toggle'),stamp=q('#quota-stamp');if(!bar||!toggle)return;
 const st=quotaState?.status;
 if(!quotaState||(!quotaState.available&&!st)){bar.hidden=true;closeQuotaPopover();return;}
 bar.hidden=false;toggle.replaceChildren();
 if(!st){const err=document.createElement('span');err.className='q-err';err.textContent='算力读取失败（点击查看）';toggle.append(err);if(stamp)stamp.textContent='';if(!q('#quota-popover').hidden)renderQuotaPopover();return;}
 for(const id of M.POOL_ORDER){
  const info=st.pools?.[id];if(!info)continue;
  const stKey=poolStateKey(id,info),chip=document.createElement('span');chip.className='q-chip';chip.dataset.pool=id;chip.dataset.state=stKey;
  if(st.primary===id||st.relay===id){const r=document.createElement('span');r.className='q-role '+(st.primary===id?'is-primary':'is-relay');r.textContent=st.primary===id?'主':'接';chip.append(r);}
  const name=document.createElement('strong');name.textContent=id;
  const pct=document.createElement('span');pct.textContent=M.formatPctCompact(info.weekly);
  const rst=document.createElement('span');rst.className='q-rst';rst.textContent=M.formatHoursCompact(info.hoursToReset);
  chip.append(name,pct,rst);
  const arrow=stKey==='exhausted'?'!':stKey==='fast'?'↑':stKey==='slow'?'↓':'';
  if(arrow){const w=document.createElement('span');w.className='q-warn';w.textContent=arrow;chip.append(w);}
  toggle.append(chip);
 }
 if(st.uncalibrated?.length){const u=document.createElement('span');u.className='q-uncal';u.textContent='未校'+st.uncalibrated.length;toggle.append(u);}
 if(st.digest?.pendingReview){const d=document.createElement('span');d.className='q-digest-pill';d.textContent='● 日报变动';toggle.append(d);}
 if(stamp){const t=M.formatClockHHMM(quotaState.fetchedAt||st.now);stamp.textContent=t.split(' ').pop()||'';stamp.title=quotaState.error||('算力快照：'+t);}
 if(!q('#quota-popover').hidden)renderQuotaPopover();
}
function renderQuotaPopover(){
 const pop=q('#quota-popover');if(!pop)return;pop.replaceChildren();
 const res=quotaState,st=res?.status;
 const head=document.createElement('div');head.className='q-pop-head';
 const title=document.createElement('div');title.className='q-pop-title';
 const strong=document.createElement('strong');strong.textContent='四池实时算力';title.append(strong);
 if(st){const sub=document.createElement('span');sub.className='q-pop-sub';sub.textContent=`主攻 ${st.primary} · 接力 ${st.relay}`;title.append(sub);}
 const acts=document.createElement('div');acts.className='q-pop-actions';
 const refBtn=document.createElement('button');refBtn.type='button';refBtn.textContent='刷新';refBtn.disabled=quotaLoading;refBtn.onclick=()=>void refreshQuota(true);
 const clsBtn=document.createElement('button');clsBtn.type='button';clsBtn.className='q-pop-close';clsBtn.textContent='×';clsBtn.setAttribute('aria-label','关闭算力浮窗');clsBtn.onclick=()=>closeQuotaPopover(true);
 acts.append(refBtn,clsBtn);head.append(title,acts);pop.append(head);
 const body=document.createElement('div');body.className='q-pop-body';pop.append(body);
 if(res?.error){const wb=document.createElement('p');wb.className='q-warn-banner';wb.textContent=res.error;body.append(wb);}
 if(!st){const em=document.createElement('p');em.className='q-empty';em.textContent='暂未能读取 quota.py 输出，请检查本机 Python 环境。';body.append(em);return;}
 if(st.digest){
  const d=st.digest,dbox=document.createElement('div');dbox.className='q-digest'+(d.pendingReview?' is-pending':'');
  if(d.pendingReview){
   const dh=document.createElement('div');dh.className='q-digest-head';
   const dot=document.createElement('span');dot.className='q-digest-dot';dot.textContent='● 今日 X 日报有实质变动待核实';
   const cb=document.createElement('button');cb.type='button';cb.className='q-copy-btn';cb.textContent='复制日报核实指令';
   cb.onclick=()=>{void api.call('copy',{text:M.buildDigestReviewPrompt(st)}).then(()=>{flashEl(cb,'复制日报核实指令');message('已复制日报核实指令');}).catch(e=>message('复制失败：'+e.message));};
   dh.append(dot,cb);
   const dt=document.createElement('p');dt.className='q-digest-text';dt.textContent=`${d.date} · ${d.headline||'请查看 X-AI-Digest 日报正文'}`;
   dbox.append(dh,dt);
  }else{
   const dm=document.createElement('span');dm.className='q-digest-muted';
   dm.textContent=!d.landed?`今日 X 日报（${d.date}）：尚未落盘`:d.hasChange?`今日 X 日报（${d.date}）：变动已核实入表`:`今日 X 日报（${d.date}）：无影响路由表变动`;
   dbox.append(dm);
  }
  body.append(dbox);
 }
 const list=document.createElement('div');list.className='q-pools';body.append(list);
 const uncal=new Set(st.uncalibrated||[]);
 for(const id of M.POOL_ORDER){
  const info=st.pools?.[id];if(!info)continue;
  const stKey=poolStateKey(id,info),card=document.createElement('div');card.className='q-pool-card';card.dataset.pool=id;card.dataset.state=stKey;
  const r1=document.createElement('div');r1.className='q-pool-head';
  const badge=document.createElement('span');badge.className='q-pool-badge';badge.textContent=id;
  const nm=document.createElement('strong');nm.textContent=info.label;
  r1.append(badge,nm);
  if(st.primary===id||st.relay===id){const t=document.createElement('span');t.className='q-tag '+(st.primary===id?'is-primary':'is-relay');t.textContent=st.primary===id?'主攻':'接力';r1.append(t);}
  if(uncal.has(id)){const t=document.createElement('span');t.className='q-tag is-uncal';t.textContent='未校准';r1.append(t);}
  const ph=document.createElement('span');ph.className='q-pool-phase';ph.textContent=`${info.phase} · ${info.hoursToReset!=null?'距重置 '+info.hoursToReset+'h':'周窗未开'}`;r1.append(ph);
  const tr=document.createElement('div');tr.className='q-track';
  const fl=document.createElement('div');fl.className='q-fill';fl.style.width=Math.max(0,Math.min(100,info.weekly?.usedPct??0))+'%';tr.append(fl);
  if(info.reservePct>0){const rz=document.createElement('div');rz.className='q-reserve';rz.style.width=Math.min(40,info.reservePct)+'%';rz.title=`禁 Claude 应急预留 ${info.reservePct}%`;tr.append(rz);}
  if(info.burn?.targetUsedNowPct!=null){const tm=document.createElement('div');tm.className='q-target';tm.style.left=Math.max(0,Math.min(100,info.burn.targetUsedNowPct))+'%';tm.title=`第 ${info.burn.targetDays} 天达 ${info.burn.targetPct}% 目标线：当前基准 ~${info.burn.targetUsedNowPct}%`;tr.append(tm);}
  const conf=M.CONFIDENCE_LABELS[info.weekly?.confidence]||info.weekly?.confidence||'';
  const metaParts=[`周：${M.formatPctExact(info.weekly)}（${conf}）`];
  if(info.burn)metaParts.push(`目标第 ${info.burn.targetDays} 天 ${info.burn.targetPct}% · 基准 ~${info.burn.targetUsedNowPct}%（${info.burn.ratio}x）`);
  if(info.burn?.warn==='fast'&&info.burn.dailyBudgetPct!=null)metaParts.push(`超速 · 日均 <= ${info.burn.dailyBudgetPct}%`);
  else if(info.burn?.warn==='slow')metaParts.push('偏慢 · 建议加码');
  const m1=document.createElement('div');m1.className='q-meta';m1.textContent=metaParts.join(' · ');
  card.append(r1,tr,m1);
  if(info.fiveHour){
   const fh=info.fiveHour,ft=document.createElement('div');ft.className='q-track is-slim';
   const ff=document.createElement('div');ff.className='q-fill';ff.style.width=Math.max(0,Math.min(100,fh.usedPct??0))+'%';ft.append(ff);
   const fConf=M.CONFIDENCE_LABELS[fh.confidence]||fh.confidence||'';
   const fReset=fh.resetsAt?' · 回血 '+M.formatClockHHMM(fh.resetsAt):'';
   const paceTxt=info.pace?` · 每窗≈${info.pace.windowPctOfWeek}%，剩${info.pace.windowsLeft}窗`+(info.pace.projectedWastePct>0?`，预废${info.pace.projectedWastePct}%`:''):'';
   const m2=document.createElement('div');m2.className='q-meta is-sub';m2.textContent=`5h：${M.formatPctExact(fh)}（${fConf}）${fReset}${paceTxt}`;
   card.append(ft,m2);
  }
  if(info.advice?.text){const m3=document.createElement('div');m3.className='q-meta is-sub';m3.textContent=info.advice.text;card.append(m3);}
  list.append(card);
 }
 const foot=document.createElement('div');foot.className='q-foot';
 const un=document.createElement('span');un.className='q-uncal-note';un.textContent=st.uncalibrated?.length?`未校准分母：${st.uncalibrated.join('、')}（粘贴 /usage 截图即可反推）`:'四池周分母已全部校准';
 const cb=document.createElement('button');cb.type='button';cb.className='q-copy-btn';cb.textContent='复制 /usage 校准指令';
 cb.onclick=()=>{void api.call('copy',{text:M.buildCalibratePrompt(st)}).then(()=>{flashEl(cb,'复制 /usage 校准指令');message('已复制 /usage 校准指令');}).catch(e=>message('复制失败：'+e.message));};
 foot.append(un,cb);body.append(foot);
 const tips=(st.tips||[]).filter(t=>!t.startsWith('今日 X 日报有实质变动'));
 if(tips.length){const ul=document.createElement('ul');ul.className='q-tips';for(const t of tips.slice(0,4)){const li=document.createElement('li');li.textContent=t;ul.append(li);}body.append(ul);}
}
function updateNodeOverrides(){
 if(!current)return;
 for(const card of q('#nodes').children){
  const n=current.nodes.find(x=>x.id===card.dataset.id),badge=card.querySelector('.node-override');
  if(!n||!badge)continue;
  const ov=M.computeDynamicOverride(n,quotaState?.status,current.title);
  card.classList.toggle('has-override',!!ov);badge.hidden=!ov;
  if(ov){badge.textContent=`⚡改走 ${ov.targetShort}`;badge.title=`${ov.reason} → 建议改走 ${ov.targetLabel}`;}
  else{badge.textContent='';badge.title='';}
 }
 if(!q('#detail').hidden)renderDetail();
}
async function refreshQuota(force=false){
 if(quotaLoading&&!force)return;
 quotaLoading=true;if(q('#quota-refresh'))q('#quota-refresh').disabled=true;
 try{quotaState=await api.call('quota',{force});renderQuotaBar();updateNodeOverrides();}
 catch{/* Non-blocking */}
 finally{quotaLoading=false;if(q('#quota-refresh'))q('#quota-refresh').disabled=false;if(!q('#quota-popover').hidden)renderQuotaPopover();}
}
function statusControls(){
 const reason=editorBusy?'请先保存或关闭 Obsidian 中未保存的图编辑':!canCycle?'请先打开 Obsidian 工作台后再切换状态（当前可正常查看最新任务图并复制提示词）':'';
 for(const b of document.querySelectorAll('.node-state,#node-status')){
  const id=b.id==='node-status'?selectedNode:b.dataset.nodeId,n=current?.nodes.find(n=>n.id===id);if(!n)continue;
  const pending=pendingStatus?.graphId===current.id&&pendingStatus?.nodeId===id;
  b.disabled=statusSaving||!canCycle||!!pendingStatus&&!pending;
  b.title=reason||(pending?'核对上次操作的保存结果，不会再次推进状态':'切换到'+M.labels[nextStatus(n.status)]+'；'+M.display(current,n).hint);
  b.setAttribute('aria-label',pending?'核对上次状态操作：'+n.title:'切换状态：'+n.title+'，'+M.labels[n.status]+' → '+M.labels[nextStatus(n.status)]);
  const state=M.display(current,n);b.textContent=pending?'核对上次操作':b.id==='node-status'?state.label:M.number(current,n)+' · '+state.label+(state.hint&&state.state!=='ready'?' ⓘ':'');
 }
 q('#graphs').disabled=statusSaving;q('#refresh').disabled=statusSaving||loading>0;
}
async function cycleNode(id){
 if(statusSaving||!canCycle||!current)return;const n=current.nodes.find(n=>n.id===id);if(!n)return;
 const graphId=current.id,prevStatus=n.status,hadPending=pendingStatus?.graphId===graphId&&pendingStatus?.nodeId===id;
 statusSaving=true;
 if(!hadPending){
  n.status=nextStatus(prevStatus);
  for(const card of q('#nodes').children){const cn=current.nodes.find(x=>x.id===card.dataset.id);if(cn)card.dataset.status=M.display(current,cn).state;}
 }
 statusNotice='正在同步状态…';message(statusNotice);statusControls();
 try{await api.call('cycle',{graphId,nodeId:id,expectedRevision:current.revision,expectedSnapshot:currentSnapshot,expectedStatus:prevStatus});statusNotice='状态已保存';}
 catch(e){n.status=prevStatus;for(const card of q('#nodes').children){const cn=current.nodes.find(x=>x.id===card.dataset.id);if(cn)card.dataset.status=M.display(current,cn).state;}statusNotice=e.message;}
 finally{await refresh(graphId);statusSaving=false;statusControls();message(statusNotice);}
}

function message(text){q('#notice').textContent=text;}
function copyTextWithOverride(n,proj,mode){const base=mode==='full'?M.prompt(current,n,proj):M.defaultPrompt(current,n,proj);const ov=includeOverrideInCopy?M.computeDynamicOverride(n,quotaState?.status,current.title):null;return M.appendOverrideHint(base,ov);}
async function copyNode(id,button,mode='default'){const n=current?.nodes.find(n=>n.id===id);if(!n)return;const original=button.textContent,proj=catalog.find(g=>g.id===current.id)?.projectName||current.title,titleLine=M.sessionTitle(current,n,proj);const payload=mode==='title'?titleLine:{title:titleLine,text:copyTextWithOverride(n,proj,mode)};button.disabled=true;try{await api.call('copy',payload);message(mode==='title'?'会话标题已复制':mode==='full'?'完整提示词已复制':(M.isDiscussionNode(n)?'讨论短令已复制（含原问题，Win+V 含 #标题）':'启动短令已复制（Win+V 含 #标题）'));button.textContent='已复制';}catch(e){message('复制失败：'+e.message);button.textContent='复制失败';}finally{button.disabled=false;setTimeout(()=>{if(button.isConnected)button.textContent=original;},1800);}}
let currentPalette='obsidian-indigo',paletteOptions=[];
function renderGraphPalettes(){
 const host=q('#palette-popover');if(!host)return;host.replaceChildren();
 const items=[...(paletteOptions||[]),{id:'workbench',label:'跟随工作台配色',swatch:'#8b92a5'}];
 for(const p of items){
  const btn=document.createElement('button');btn.type='button';btn.className='palette-item';
  btn.setAttribute('aria-checked',String(currentPalette===p.id));
  const dot=document.createElement('span');dot.className='palette-dot';dot.style.background=p.swatch;
  const txt=document.createElement('span');txt.textContent=p.label;
  btn.append(dot,txt);
  btn.onclick=()=>{host.hidden=true;q('#palette-btn')?.setAttribute('aria-expanded','false');void api.call('palette',p.id).then(theme).catch(e=>message(e.message));};
  host.append(btn);
 }
}
function theme(data){if(!data)return;if(data.palette)currentPalette=data.palette;if(Array.isArray(data.palettes))paletteOptions=data.palettes;if(data.theme){for(const k of ['surface','container','text','muted','outline','primary','onPrimary','tint'])if(typeof data.theme[k]==='string')document.documentElement.style.setProperty('--'+k,data.theme[k]);document.documentElement.style.colorScheme=data.theme.dark?'dark':'light';document.documentElement.dataset.mode=data.theme.dark?'dark':'light';}if(typeof data.pinned==='boolean')q('#pin').setAttribute('aria-pressed',String(data.pinned));renderGraphPalettes();}
function paint(){frame=null;q('#plane').style.transform=`translate(${camera.x}px,${camera.y}px) scale(${camera.zoom})`;q('#zoom').textContent=Math.round(camera.zoom*100)+'%';}
function updateCamera(save=true){if(!frame)frame=requestAnimationFrame(paint);if(save&&current){views.set(current.id,{...camera});clearTimeout(saveTimer);saveTimer=setTimeout(()=>flushView().catch(e=>message(e.message)),200);}}
async function flushView(){clearTimeout(saveTimer);saveTimer=null;if(current){const id=current.id,value={...camera};views.set(id,value);await api.call('view',{id,view:value});}}
window.flushGraphView=flushView;
function fit(save=true){if(!layout)return;const box=q('#canvas');camera={zoom:Math.max(.15,Math.min(1,(box.clientWidth-32)/layout.width,(box.clientHeight-24)/layout.height)),x:0,y:0};camera.x=(box.clientWidth-layout.width*camera.zoom)/2;camera.y=(box.clientHeight-layout.height*camera.zoom)/2;updateCamera(save);}
function zoom(mult,x=q('#canvas').clientWidth/2,y=q('#canvas').clientHeight/2){const old=camera.zoom;camera.zoom=Math.max(.15,Math.min(2.5,old*mult));camera.x=x-(x-camera.x)*camera.zoom/old;camera.y=y-(y-camera.y)*camera.zoom/old;updateCamera();}
function closeDetail(restore=false){q('#detail').hidden=true;if(restore&&selectedNode){const b=[...q('#nodes').children].find(b=>b.dataset.id===selectedNode);b?.querySelector('.node-open')?.focus({preventScroll:true});}}
function place(x,y){const box=q('#detail');box.style.left=Math.max(10,Math.min(innerWidth-box.offsetWidth-10,x))+'px';box.style.top=Math.max(12,Math.min(innerHeight-box.offsetHeight-12,y))+'px';}
function renderDetail(){const n=current?.nodes.find(n=>n.id===selectedNode);if(!n){closeDetail();return;}const proj=catalog.find(g=>g.id===current.id)?.projectName||current.title;q('#node-title').textContent=M.sessionTitle(current,n,proj);const state=M.display(current,n);q('#node-status').textContent=state.label;q('#node-status').title=state.hint;q('#node-version').textContent='提示词 v'+(n.promptVersion||1);q('#human').replaceChildren();const parsed=M.parseSummary(n.summary);const values=n.summary||n.expected?[parsed.humanBody,n.expected?'预期成果：'+n.expected:'']:[n.description.length<=1600?n.description:'此节点尚无简要说明，请展开下方完整执行提示词。'];if(state.hint)values.push(state.hint);for(const text of values.filter(Boolean)){const p=document.createElement('p');p.textContent=text;q('#human').append(p);}if(parsed.routing){const r=document.createElement('p');r.className='routing-meta';r.textContent='算力路由 · '+parsed.routing;q('#human').append(r);}const ov=M.computeDynamicOverride(n,quotaState?.status,current.title);if(ov){const box=document.createElement('div');box.className='override-callout';const t=document.createElement('strong');t.textContent='⚡ 当前建议改走：'+ov.targetLabel;const rs=document.createElement('span');rs.textContent=`原因：${ov.reason}（仅渲染层叠加，不改动任务图 JSON）`;const lb=document.createElement('label');const ck=document.createElement('input');ck.type='checkbox';ck.checked=includeOverrideInCopy;ck.onchange=()=>{includeOverrideInCopy=ck.checked;q('#prompt').textContent=copyTextWithOverride(n,proj,'full');};lb.append(ck,document.createTextNode(' 复制提示词时附带此实时算力建议'));box.append(t,rs,lb);q('#human').append(box);}q('#prompt').textContent=copyTextWithOverride(n,proj,'full');statusControls();}
function openDetail(id,button){selectedNode=id;for(const b of q('#nodes').children){b.dataset.selected=String(b.dataset.id===id);b.querySelector('.node-open').setAttribute('aria-pressed',String(b.dataset.id===id));}q('#ai').open=false;renderDetail();q('#detail').hidden=false;const r=button.getBoundingClientRect();let x=r.right+12;if(x+q('#detail').offsetWidth>innerWidth-10)x=r.left-q('#detail').offsetWidth-12;place(x,r.top+10);q('#close-detail').focus({preventScroll:true});}
function draw(g,newGraph,savedView){const wasOpen=!q('#detail').hidden,scroll=q('.detail-content').scrollTop;current=g;layout=M.layout(g);q('#nodes').replaceChildren();q('#wires').replaceChildren();q('#plane').style.width=layout.width+'px';q('#plane').style.height=layout.height+'px';q('#wires').setAttribute('width',layout.width);q('#wires').setAttribute('height',layout.height);
 const ns='http://www.w3.org/2000/svg',defs=document.createElementNS(ns,'defs'),marker=document.createElementNS(ns,'marker');marker.id='arrow';marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','6');marker.setAttribute('markerHeight','6');marker.setAttribute('orient','auto-start-reverse');const arrow=document.createElementNS(ns,'path');arrow.setAttribute('d','M0 0L10 5L0 10Z');marker.append(arrow);defs.append(marker);q('#wires').append(defs);
 for(const e of g.edges){const a=layout.positions[e.from],b=layout.positions[e.to],p=document.createElementNS(ns,'path'),dx=(b.x+109)-(a.x+109),dy=(b.y+50)-(a.y+50),vert=Math.abs(dy)>Math.abs(dx)&&Math.abs(dx)<218;if(vert){const down=dy>=0,sx=a.x+109,sy=down?a.y+100:a.y,ex=b.x+109,ey=down?b.y:b.y+100,c=Math.max(30,Math.round(Math.abs(ey-sy)*.45))*(down?1:-1);p.setAttribute('d',`M${sx} ${sy} C${sx} ${sy+c},${ex} ${ey-c},${ex} ${ey}`);}else{const right=dx>=0,sx=right?a.x+218:a.x,sy=a.y+50,ex=right?b.x:b.x+218,ey=b.y+50,c=Math.max(36,Math.round(Math.abs(ex-sx)*.45))*(right?1:-1);p.setAttribute('d',`M${sx} ${sy} C${sx+c} ${sy},${ex-c} ${ey},${ex} ${ey}`);}p.setAttribute('marker-end','url(#arrow)');q('#wires').append(p);}
 for(const n of g.nodes){const b=document.createElement('article');b.className='node';b.dataset.id=n.id;const state=M.display(g,n);b.dataset.status=state.state;b.dataset.selected=String(n.id===selectedNode);b.style.left=layout.positions[n.id].x+'px';b.style.top=layout.positions[n.id].y+'px';const small=document.createElement('button');small.className='node-state';small.dataset.nodeId=n.id;small.onclick=e=>{e.stopPropagation();void cycleNode(n.id);};small.textContent=M.number(g,n)+' · '+state.label+(state.hint&&state.state!=='ready'?' ⓘ':'');const title=document.createElement('strong');title.textContent=n.title;const proj=catalog.find(x=>x.id===g.id)?.projectName||g.title;b.title=[M.sessionTitle(g,n,proj),n.summary?M.canvasSummary(n.summary):'',state.hint].filter(Boolean).join('\n');const open=document.createElement('button');open.className='node-open';open.setAttribute('aria-pressed',String(n.id===selectedNode));open.append(title);open.onclick=()=>openDetail(n.id,b);const foot=document.createElement('div');foot.className='node-foot';const copy=document.createElement('button');copy.className='node-copy';copy.textContent='复制提示词';copy.setAttribute('aria-label','复制提示词：'+n.title);copy.onclick=e=>{e.stopPropagation();void copyNode(n.id,copy);};const ovBadge=document.createElement('span');ovBadge.className='node-override';const ov=M.computeDynamicOverride(n,quotaState?.status,g.title);if(ov){b.classList.add('has-override');ovBadge.textContent=`⚡改走 ${ov.targetShort}`;ovBadge.title=`${ov.reason} → 建议改走 ${ov.targetLabel}`;}else ovBadge.hidden=true;foot.append(copy,ovBadge);b.append(small,open,foot);b.onclick=e=>{if(!e.target.closest('button'))openDetail(n.id,b);};q('#nodes').append(b);}
 q('#count').textContent=g.nodes.length+' 个节点';q('#empty').hidden=g.nodes.length>0;q('#empty').textContent='这张任务图还没有节点';
 if(newGraph){closeDetail();selectedNode=null;const view=views.get(g.id)||savedView;if(view){camera={...view};updateCamera(false);}else fit(false);}else if(wasOpen){renderDetail();q('.detail-content').scrollTop=scroll;place(parseFloat(q('#detail').style.left),parseFloat(q('#detail').style.top));}
}
function renderCatalog(rows,id){const fingerprint=JSON.stringify(rows.map(g=>[g.id,g.title,g.projectName]));if(lastCatalog!==fingerprint){const select=q('#graphs');select.replaceChildren();const groups=new Map();for(const g of rows){let group=groups.get(g.projectId);if(!group){group=document.createElement('optgroup');group.label=g.projectName;groups.set(g.projectId,group);select.append(group);}const o=document.createElement('option');o.value=g.id;o.textContent=g.title;group.append(o);}if(!rows.length){const o=document.createElement('option');o.value='';o.textContent='暂无任务图';select.append(o);}lastCatalog=fingerprint;}q('#graphs').value=id||'';}
async function refresh(id,force=false){const ticket=++sequence;loading++;q('#refresh').disabled=true;try{const s=await api.call('snapshot',{id,force});if(ticket!==sequence)return;theme(s);canCycle=s.canCycle===true;editorBusy=s.editorBusy===true;pendingStatus=s.pendingStatus;currentSnapshot=s.snapshot;catalog=s.catalog;renderCatalog(catalog,s.selected);const date=s.checkedAt||s.cachedAt;const stamp=date?new Date(date).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';q('#connection').textContent=s.online?'已连接工作台 · '+stamp:s.localDisk?'本地实时图库 · '+stamp+'（开 Obsidian 可改状态）':(s.connected?(s.graph?'更新失败 · 显示最近快照 · '+stamp:'已连接工作台 · 读取失败'):(s.graph?'离线快照 · '+stamp:'未连接工作台'));q('#connection').title=s.error||(s.localDisk?'Obsidian 未开启，当前直接读取本地 Vault 最新任务图文件（只读防冲突）':'每 5 秒核对当前图，每 15 秒更新图列表');if(statusNotice==='状态已保存'&&!s.online)statusNotice='状态已保存，但刷新失败：'+(s.error||'请稍后刷新');message(statusNotice||s.error||'');if(s.graph){if(!current||current.id!==s.graph.id||JSON.stringify(current)!==JSON.stringify(s.graph))draw(s.graph,current?.id!==s.graph.id,s.view);}else{current=null;closeDetail();q('#nodes').replaceChildren();q('#wires').replaceChildren();q('#count').textContent='';q('#empty').hidden=false;q('#empty').textContent=(s.online||s.localDisk)?'尚无活跃任务图，请先在工作台创建或取消归档。':s.connected?'任务图暂时读取失败，请查看底部原因并点击刷新。':'请打开 Obsidian 并启用 Personal Workbench。\n首次读取成功后，可在离线时查看最近的快照。';}}catch(e){if(ticket===sequence)message(e.message);}finally{loading--;if(!loading)q('#refresh').disabled=false;statusControls();}}
q('#graphs').onchange=async e=>{const id=e.target.value;try{await flushView();}catch(error){message(error.message);}closeDetail();refresh(id);};
q('#refresh').onclick=()=>{statusNotice='';refresh(q('#graphs').value,true);void refreshQuota(true);};q('#in').onclick=()=>zoom(1.15);q('#out').onclick=()=>zoom(1/1.15);q('#fit').onclick=()=>fit();
q('#quota-toggle').onclick=e=>{e.stopPropagation();const pop=q('#quota-popover');if(!pop)return;if(!pop.hidden){closeQuotaPopover();return;}if(!quotaState||(!quotaState.status&&!quotaState.error))return;renderQuotaPopover();pop.hidden=false;placeQuotaPopover();q('#quota-toggle').setAttribute('aria-expanded','true');};
q('#quota-refresh').onclick=e=>{e.stopPropagation();void refreshQuota(true);};
q('#pin').onclick=async()=>{try{const pinned=await api.call('pin',q('#pin').getAttribute('aria-pressed')!=='true');q('#pin').setAttribute('aria-pressed',String(pinned));}catch(e){message(e.message);}};
q('#close').onclick=async()=>{try{q('#palette-popover').hidden=true;closeQuotaPopover();await flushView();closeDetail();await api.call('close');}catch(e){message(e.message);}};
q('#switch-capture').onclick=async()=>{try{q('#palette-popover').hidden=true;closeQuotaPopover();await flushView();closeDetail();await api.call('switch-capture');}catch(e){message(e.message);}};
q('#palette-btn').onclick=e=>{e.stopPropagation();closeQuotaPopover();const next=!q('#palette-popover').hidden;q('#palette-popover').hidden=next;q('#palette-btn').setAttribute('aria-expanded',String(!next));};
q('#node-status').onclick=()=>cycleNode(selectedNode);q('#close-detail').onclick=()=>closeDetail(true);q('#copy').onclick=()=>copyNode(selectedNode,q('#copy'));q('#copy-title').onclick=()=>copyNode(selectedNode,q('#copy-title'),'title');q('#copy-full').onclick=()=>copyNode(selectedNode,q('#copy-full'),'full');
q('#canvas').addEventListener('wheel',e=>{if(!current)return;e.preventDefault();const r=e.currentTarget.getBoundingClientRect();zoom(Math.exp(-Math.sign(e.deltaY)*.12),e.clientX-r.left,e.clientY-r.top);},{passive:false});
q('#canvas').onpointerdown=e=>{if(e.button!==0||e.target.closest('button'))return;e.preventDefault();pan={x:e.clientX,y:e.clientY,start:{...camera}};e.currentTarget.setPointerCapture(e.pointerId);};q('#canvas').onpointermove=e=>{if(!pan)return;camera.x=pan.start.x+e.clientX-pan.x;camera.y=pan.start.y+e.clientY-pan.y;updateCamera(false);};q('#canvas').onpointerup=()=>{if(pan){pan=null;updateCamera();}};q('#canvas').onpointercancel=()=>{if(pan){camera=pan.start;pan=null;updateCamera(false);}};
document.addEventListener('pointerdown',e=>{if(!q('#detail').hidden&&!q('#detail').contains(e.target)&&!e.target.closest('.node'))closeDetail();if(!q('#palette-popover').hidden&&!e.target.closest('#palette-popover,#palette-btn')){q('#palette-popover').hidden=true;q('#palette-btn').setAttribute('aria-expanded','false');}if(!q('#quota-popover').hidden&&!e.target.closest('#quota-popover,#quota-toggle'))closeQuotaPopover();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!q('#palette-popover').hidden){q('#palette-popover').hidden=true;q('#palette-btn').setAttribute('aria-expanded','false');}else if(!q('#quota-popover').hidden)closeQuotaPopover(true);else if(!q('#detail').hidden)closeDetail(true);else q('#close').click();}if(e.target.closest('button,select,summary,pre'))return;const delta={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,40],ArrowDown:[0,-40]}[e.key];if(delta){e.preventDefault();camera.x+=delta[0];camera.y+=delta[1];updateCamera();}});
q('#detail-head').onpointerdown=e=>{if(e.button!==0||e.target.closest('#close-detail'))return;e.preventDefault();drag={x:e.clientX,y:e.clientY,left:q('#detail').offsetLeft,top:q('#detail').offsetTop};e.currentTarget.setPointerCapture(e.pointerId);};q('#detail-head').onpointermove=e=>{if(drag)place(drag.left+e.clientX-drag.x,drag.top+e.clientY-drag.y);};q('#detail-head').onpointerup=q('#detail-head').onpointercancel=()=>drag=null;
q('#move-detail').onkeydown=e=>{const d={ArrowLeft:[-12,0],ArrowRight:[12,0],ArrowUp:[0,-12],ArrowDown:[0,12]}[e.key];if(d){e.preventDefault();place(q('#detail').offsetLeft+d[0],q('#detail').offsetTop+d[1]);}};
q('#ai').ontoggle=()=>{if(!q('#detail').hidden)place(q('#detail').offsetLeft,q('#detail').offsetTop);};window.addEventListener('resize',()=>{if(!q('#detail').hidden)place(q('#detail').offsetLeft,q('#detail').offsetTop);placeQuotaPopover();});
api.onTheme(theme);api.onRefresh(s=>{theme(s);closed=false;refresh(current?.id);void refreshQuota(false);});document.addEventListener('visibilitychange',()=>{closed=document.hidden;if(!closed&&!loading){refresh(current?.id);void refreshQuota(false);}});
setInterval(()=>{if(!document.hidden&&!closed&&!loading&&!statusSaving)refresh(q('#graphs').value||current?.id);},5000);refresh();void refreshQuota(false);
