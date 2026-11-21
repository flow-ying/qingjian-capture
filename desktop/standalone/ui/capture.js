'use strict';
const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
const labels={note:'随手记',diary:'日记',task:'任务',issue:'问题',idea:'想法',link:'链接'};
const markers={note:'[~]',diary:'·',task:'[!]',issue:'[?]',idea:'[I]',link:'[L]'};
function makeBlankDraft(){return {id:crypto.randomUUID(),expectedRevision:0,payload:{type:'note',body:'',source:'',thought:'',due:'',tags:'',project:'',attachments:[]}};}
let state={records:[],online:false,pinned:false,palette:'obsidian-indigo',palettes:[],projects:[]};
let bundle={activeId:'',items:[]},draft=makeBlankDraft(),timer=null,saving=false,dirty=false,noticeTimer=null,draftChain=Promise.resolve(),imports=Promise.resolve(),draftVersion=0,lastProjectsKey='';
bundle={activeId:draft.id,items:[draft]};

function notify(message,sticky=false){clearTimeout(noticeTimer);q('.notice').textContent=message;if(!sticky)noticeTimer=setTimeout(()=>q('.notice').textContent='',4500);}
function applyTheme(theme){if(!theme)return;for(const[k,v]of Object.entries(theme))if(typeof v==='string')document.documentElement.style.setProperty('--'+k,v);document.documentElement.style.colorScheme=theme.dark?'dark':'light';}
function filled(d=draft){return ['body','source','thought'].some(k=>(d.payload?.[k]||'').trim())||(d.payload?.attachments?.length||0)>0;}
function syncActiveIntoBundle(){
 for(const key of ['body','source','thought','due','tags'])draft.payload[key]=q('.'+key).value;
 draft.payload.project=q('.project-select').value||'';
 draft.panels={source:!q('.source-block').hidden,thought:!q('.thought-block').hidden};
 const idx=bundle.items.findIndex(x=>x.id===draft.id);
 if(idx>=0)bundle.items[idx]=structuredClone(draft);
 else bundle.items.unshift(structuredClone(draft));
 bundle.activeId=draft.id;
 return structuredClone(bundle);
}
function persist(){
 clearTimeout(timer);if(saving)return draftChain;
 const value=syncActiveIntoBundle(),version=draftVersion;
 draftChain=draftChain.catch(()=>{}).then(()=>capture.call('drafts',value)).then(()=>{
  if(version===draftVersion){dirty=false;q('.draft-status').textContent=filled()?'草稿已保存在本机':'空白记录';}
 }).catch(e=>{dirty=true;q('.draft-status').textContent='草稿保存失败';notify(e.message,true);throw e;});
 return draftChain;
}
window.captureFlush=async()=>{clearTimeout(timer);await imports;return saving?draftChain:persist();};
function changed(){draftVersion++;dirty=true;q('.draft-status').textContent='正在保存草稿…';syncActiveIntoBundle();renderDraftTabs();clearTimeout(timer);timer=setTimeout(()=>void persist().catch(()=>{}),280);}
function renderType(){q('.type-select').value=draft.payload.type;q('.date-block').hidden=draft.payload.type!=='task';q('.tags-block').hidden=draft.payload.type!=='idea';}
function renderProjects(projects=[]){
 const sel=q('.project-select'),cur=draft.payload.project||'';
 const list=[...new Set([...projects,...(cur?[cur]:[])])];
 const key=JSON.stringify(list);
 if(key!==lastProjectsKey){
  sel.replaceChildren();
  const none=document.createElement('option');none.value='';none.textContent='#项目';sel.append(none);
  for(const p of list){const o=document.createElement('option');o.value=p;o.textContent='#项目/'+p;sel.append(o);}
  lastProjectsKey=key;
 }
 sel.value=cur;
}
function renderDraftTabs(){
 const host=q('.draft-tabs');host.replaceChildren();
 bundle.items.forEach((item,idx)=>{
  const tab=document.createElement('button');
  tab.type='button';
  tab.className='draft-tab'+(item.id===bundle.activeId?' is-active':'');
  tab.setAttribute('role','tab');
  tab.setAttribute('aria-selected',String(item.id===bundle.activeId));
  const raw=(item.payload?.body||item.payload?.source||item.payload?.thought||'').trim().split('\n')[0]||'';
  const summary=raw?raw.slice(0,9)+(raw.length>9?'…':''):'草稿 '+(idx+1);
  const label=document.createElement('span');
  label.className='draft-tab-label';
  label.textContent=(item.expectedRevision?'✎ ':markers[item.payload?.type||'note']+' ')+summary;
  tab.append(label);
  if(bundle.items.length>1){
   const close=document.createElement('span');
   close.className='draft-tab-close';
   close.textContent='×';
   close.title='关闭此草稿槽';
   close.onclick=e=>{e.stopPropagation();if(saving)return;removeDraftSlot(item.id);};
   tab.append(close);
  }
  tab.onclick=()=>{if(saving||item.id===bundle.activeId)return;switchDraftSlot(item.id);};
  host.append(tab);
 });
}
function switchDraftSlot(id){
 syncActiveIntoBundle();
 const target=bundle.items.find(x=>x.id===id);if(!target)return;
 bundle.activeId=id;
 loadSingleDraft(target);
 renderDraftTabs();
 void persist().catch(()=>{});
 q('.body').focus();
}
function createNewDraftSlot(initial){
 if(saving)return;
 syncActiveIntoBundle();
 if(bundle.items.length>=12){notify('最多同时保留 12 个草稿槽',true);return;}
 const next=initial?{...structuredClone(initial),payload:{project:'',...structuredClone(initial.payload)}}:makeBlankDraft();
 bundle.items.unshift(next);
 bundle.activeId=next.id;
 loadSingleDraft(next);
 renderDraftTabs();
 void persist().catch(()=>{});
 q('.body').focus();
}
function removeDraftSlot(id){
 syncActiveIntoBundle();
 if(bundle.items.length<=1){const fresh=makeBlankDraft();bundle={activeId:fresh.id,items:[fresh]};loadSingleDraft(fresh);}
 else{
  const idx=bundle.items.findIndex(x=>x.id===id);
  bundle.items=bundle.items.filter(x=>x.id!==id);
  if(bundle.activeId===id)bundle.activeId=bundle.items[Math.min(idx,bundle.items.length-1)].id;
  loadSingleDraft(bundle.items.find(x=>x.id===bundle.activeId)||bundle.items[0]);
 }
 renderDraftTabs();
 void persist().catch(()=>{});
}
async function renderFiles(){
 const host=q('.attachments');host.replaceChildren();
 for(const a of draft.payload.attachments){
  const row=document.createElement('div');row.className='attachment';
  if(/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.ext)){
   const img=document.createElement('img');img.alt=a.name;row.append(img);
   capture.call('attachment-preview',a).then(src=>{if(src)img.src=src;}).catch(()=>{});
  }
  const label=document.createElement('span');label.textContent=a.name;
  const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除附件 '+a.name);
  remove.onclick=()=>{if(saving)return;draft.payload.attachments=draft.payload.attachments.filter(f=>f.id!==a.id);void renderFiles();changed();};
  row.append(label,remove);host.append(row);
 }
}
function loadSingleDraft(value){
 const base=value||{...makeBlankDraft()};
 draft={id:base.id||crypto.randomUUID(),expectedRevision:base.expectedRevision||0,panels:base.panels||{},payload:{type:'note',body:'',source:'',thought:'',due:'',tags:'',project:'',attachments:[],...(base.payload||{})}};
 for(const key of ['body','source','thought','due','tags'])q('.'+key).value=draft.payload[key]||'';
 renderProjects(state.projects);
 for(const key of ['source','thought']){
  q('.'+key+'-block').hidden=!(draft.panels?.[key]??Boolean(draft.payload[key]));
  q('.add-'+key).setAttribute('aria-expanded',String(!q('.'+key+'-block').hidden));
 }
 renderType();void renderFiles();renderSave();
 q('.draft-status').textContent=filled()?'草稿已保存在本机':'空白记录';
 q('.destination').textContent=draft.expectedRevision?'修改原 Daily 记录':'当天 Daily';
}
function restoreBundle(savedDrafts,fallbackSingle){
 if(savedDrafts&&Array.isArray(savedDrafts.items)&&savedDrafts.items.length){
  bundle={activeId:savedDrafts.activeId||savedDrafts.items[0].id,items:savedDrafts.items};
 }else if(fallbackSingle&&fallbackSingle.id){
  bundle={activeId:fallbackSingle.id,items:[fallbackSingle]};
 }else{
  const fresh=makeBlankDraft();bundle={activeId:fresh.id,items:[fresh]};
 }
 const active=bundle.items.find(x=>x.id===bundle.activeId)||bundle.items[0];
 bundle.activeId=active.id;
 loadSingleDraft(active);
 renderDraftTabs();
}
function renderSave(){
 q('.save').replaceChildren(document.createTextNode(saving?'保存中…':draft.expectedRevision?'保存修改':'写入'));
 const hint=document.createElement('span');hint.textContent='Ctrl↵';q('.save').append(hint);
 q('.save').disabled=saving;
 q('.save').title=state.pinned?'保存后继续输入':'保存并收起';
 q('.save').setAttribute('aria-label',draft.expectedRevision?'保存修改':state.pinned?'保存后继续输入':'保存并收起');
 q('.type-select').disabled=saving;q('.project-select').disabled=saving;
 for(const el of qa('input,textarea'))el.readOnly=saving;
}
function renderPalettes(){
 const host=q('.palette-popover');host.replaceChildren();
 const items=[...(state.palettes||[]),{id:'workbench',label:'跟随工作台配色',swatch:'#8b92a5'}];
 for(const p of items){
  const btn=document.createElement('button');btn.type='button';btn.className='palette-item';
  btn.setAttribute('aria-checked',String(state.palette===p.id));
  const dot=document.createElement('span');dot.className='palette-dot';dot.style.background=p.swatch;
  const txt=document.createElement('span');txt.textContent=p.label;
  btn.append(dot,txt);
  btn.onclick=()=>{q('.palette-popover').hidden=true;q('.palette-toggle').setAttribute('aria-expanded','false');void capture.call('palette',p.id).catch(e=>notify(e.message,true));};
  host.append(btn);
 }
}
function closePopovers(){
 q('.recent').hidden=true;q('.recent-toggle').setAttribute('aria-expanded','false');
 q('.palette-popover').hidden=true;q('.palette-toggle').setAttribute('aria-expanded','false');
}
function renderRecords(){
 q('.count').textContent=state.records.length;
 const host=q('.recent');host.replaceChildren();
 const head=document.createElement('div');head.className='recent-head';
 const hTitle=document.createElement('span');hTitle.textContent='最近未消化活记录（工作台已处理项自动隐退）';
 const hClose=document.createElement('button');hClose.type='button';hClose.className='recent-close';hClose.textContent='✕';
 hClose.onclick=()=>{q('.recent').hidden=true;q('.recent-toggle').setAttribute('aria-expanded','false');};
 head.append(hTitle,hClose);
 const list=document.createElement('div');list.className='recent-body';
 if(!state.records.length){
  const empty=document.createElement('div');empty.className='recent-empty';empty.textContent='暂无未处理的近期采集记录';list.append(empty);
 }
 for(const record of state.records){
  const row=document.createElement('div');row.className='record';
  const meta=document.createElement('small');
  const projBadge=record.payload.project?` · #项目/${record.payload.project}`:'';
  meta.textContent=(labels[record.payload.type]||'记录')+projBadge+' · '+record.date+' · '+(record.status==='saved'?'已写入 Daily':'已保存到本机，待写入');
  const body=document.createElement('p');
  body.textContent=record.payload.body||record.payload.source||record.payload.attachments?.[0]?.name||'记录';
  row.append(meta,body);
  for(const [key,label]of [['source','来源'],['thought','我的想法']])if(record.payload[key]){const p=document.createElement('small');p.textContent=label+'：'+record.payload[key];row.append(p);}
  if(record.error){const error=document.createElement('small');error.className='error';error.textContent=record.error;row.append(error);}
  const actions=document.createElement('div');actions.className='record-actions';
  const edit=document.createElement('button');edit.type='button';edit.textContent='修改';
  edit.onclick=()=>{
   if(saving)return;
   syncActiveIntoBundle();
   const existingSlot=bundle.items.find(x=>x.id===record.id);
   if(existingSlot){switchDraftSlot(existingSlot.id);}
   else if(!filled()&&draft.expectedRevision===0){
    const loaded={id:record.id,expectedRevision:record.revision,payload:{project:'',...structuredClone(record.payload)}};
    const idx=bundle.items.findIndex(x=>x.id===bundle.activeId);
    bundle.items[idx>=0?idx:0]=loaded;bundle.activeId=loaded.id;
    loadSingleDraft(loaded);renderDraftTabs();changed();
   }else{
    createNewDraftSlot({id:record.id,expectedRevision:record.revision,payload:{project:'',...structuredClone(record.payload)}});
    notify('已在新草稿槽载入修改，原草稿已为您保留');
   }
   closePopovers();
   q('.body').focus();
  };
  actions.append(edit);
  if(record.path){
   const open=document.createElement('button');open.type='button';open.textContent='打开原笔记';
   open.onclick=()=>capture.call('open-record',record.id).then(res=>{closePopovers();if(res?.launchedExternal)notify('正在拉起 Obsidian 并定位原笔记…');}).catch(e=>notify(e.message,true));
   actions.append(open);
  }
  row.append(actions);
  list.append(row);
 }
 host.append(head,list);
}
function update(value){
 state=value;
 let converted=false;
 if(!saving&&value.removedIds?.length){
  for(const item of bundle.items){
   if(item.expectedRevision>0&&value.removedIds.includes(item.id)){
    item.id=crypto.randomUUID();item.expectedRevision=0;converted=true;
   }
  }
  if(converted){
   if(draft.expectedRevision>0){draft.id=crypto.randomUUID();draft.expectedRevision=0;bundle.activeId=draft.id;bundle.items[0]=structuredClone(draft);}
   loadSingleDraft(bundle.items.find(x=>x.id===bundle.activeId)||bundle.items[0]);
   renderDraftTabs();
   void persist().catch(()=>{});
   notify('原记录已删除或归档；当前输入保留为新草稿',true);
  }
 }
 applyTheme(value.theme);
 renderProjects(value.projects||[]);
 renderPalettes();
 q('.pin').setAttribute('aria-pressed',String(state.pinned));
 q('.sync-status').dataset.online=String(Boolean(state.online));
 q('.sync-text').textContent=state.online?(state.pending?state.pending+' 待写':'已连'):'暂存';
 q('.sync-status').title=state.shortcutError||(state.online?'已连接 Obsidian；点击立即同步':'未启动 Obsidian，保存后本机持久化，开启后自动写入');
 renderSave();renderRecords();
}
async function save(){
 if(saving)return;
 try{
  await imports;await persist();syncActiveIntoBundle();
  if(!filled()){notify('请输入内容或添加资料');return;}
  if(draft.payload.type!=='task')draft.payload.due='';
  saving=true;document.body.classList.add('busy');renderSave();
  const res=await capture.call('save',structuredClone(draft));
  if(res?.drafts)restoreBundle(res.drafts,null);
  else removeDraftSlot(draft.id);
  saving=false;document.body.classList.remove('busy');renderSave();
  notify(state.online?'已写入 Daily':'已存本机，Obsidian 打开后自动写入');
  if(!state.pinned)await capture.call('collapse');else q('.body').focus();
 }catch(e){saving=false;document.body.classList.remove('busy');renderSave();notify(e.message,true);}
}
async function copyForAI(){
 syncActiveIntoBundle();
 if(!filled()){notify('当前草稿为空，先写几句再复制吧');return;}
 const p=draft.payload;
 const parts=[`${markers[p.type]||'[~]'} ${labels[p.type]||'随手记'}${p.project?`（#项目/${p.project}）`:''}：`,p.body.trim()];
 if(p.source.trim())parts.push('来源：'+p.source.trim());
 if(p.thought.trim())parts.push('补充想法：'+p.thought.trim());
 await capture.call('copy-text',parts.filter(Boolean).join('\n'));
 notify('已复制草稿与项目上下文，可直接粘贴给桌面 AI');
}

q('.save').onclick=save;
q('.close').onclick=()=>{closePopovers();void capture.call('collapse').catch(e=>notify(e.message,true));};
q('.switch-graph').onclick=()=>{closePopovers();void window.captureFlush().then(()=>capture.call('switch-graph')).catch(e=>notify(e.message,true));};
q('.pin').onclick=()=>capture.call('pin',!state.pinned).catch(e=>notify(e.message));
q('.menu').onclick=()=>capture.call('menu');
q('.new-draft').onclick=()=>createNewDraftSlot();
q('.copy-ai').onclick=()=>void copyForAI().catch(e=>notify(e.message,true));
q('.type-select').onchange=()=>{if(saving)return;draft.payload.type=q('.type-select').value;renderType();changed();};
q('.project-select').onchange=()=>{if(saving)return;draft.payload.project=q('.project-select').value;changed();};
for(const key of ['source','thought'])q('.add-'+key).onclick=()=>{
 const panel=q('.'+key+'-block');panel.hidden=!panel.hidden;
 q('.add-'+key).setAttribute('aria-expanded',String(!panel.hidden));
 if(!panel.hidden)q('.'+key).focus();changed();
};
q('.add-file').onclick=async()=>{try{const attachments=await capture.call('pick-files');if(draft.payload.attachments.length+attachments.length>20)throw Error('每条最多 20 个附件');draft.payload.attachments.push(...attachments);await renderFiles();changed();}catch(e){notify(e.message,true);}};
async function importFiles(files){if(saving)return;try{if(draft.payload.attachments.length+files.length>20)throw Error('每条最多 20 个附件');for(const file of files){if(file.size>25*1024*1024)throw Error('单个附件最多 25 MB');const a=await capture.call('attachment-bytes',{name:file.name||'截图.png',bytes:new Uint8Array(await file.arrayBuffer())});draft.payload.attachments.push(a);changed();}await renderFiles();await persist();}catch(e){notify(e.message,true);}}
document.addEventListener('paste',e=>{if(saving){e.preventDefault();return;}const files=[...e.clipboardData.files];if(files.length){e.preventDefault();imports=imports.then(()=>importFiles(files));}else if(e.target===q('.body')){const t=e.clipboardData.getData('text/plain').trim();if(/^https?:\/\/\S+$/.test(t)){q('.source').value=t;q('.source-block').hidden=false;q('.add-source').setAttribute('aria-expanded','true');changed();}}});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();if(saving)return;const files=[...e.dataTransfer.files];if(files.length)imports=imports.then(()=>importFiles(files));else{q('.body').value+=(q('.body').value?'\n':'')+e.dataTransfer.getData('text/plain');changed();}});
for(const key of ['body','source','thought','due','tags'])q('.'+key).addEventListener('input',changed);
document.addEventListener('keydown',e=>{
 if(e.isComposing)return;
 if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void save();}
 else if((e.ctrlKey||e.metaKey)&&(e.key==='n'||e.key==='N')){e.preventDefault();createNewDraftSlot();}
 else if(e.key==='Escape'){
  e.preventDefault();
  if(!q('.recent').hidden||!q('.palette-popover').hidden){closePopovers();q('.body').focus();}
  else void capture.call('collapse').catch(err=>notify(err.message,true));
 }
});
q('.recent-toggle').onclick=e=>{
 e.stopPropagation();
 const nextHidden=!q('.recent').hidden;
 q('.palette-popover').hidden=true;q('.palette-toggle').setAttribute('aria-expanded','false');
 q('.recent').hidden=nextHidden;
 q('.recent-toggle').setAttribute('aria-expanded',String(!nextHidden));
};
q('.palette-toggle').onclick=e=>{
 e.stopPropagation();
 const nextHidden=!q('.palette-popover').hidden;
 q('.recent').hidden=true;q('.recent-toggle').setAttribute('aria-expanded','false');
 q('.palette-popover').hidden=nextHidden;
 q('.palette-toggle').setAttribute('aria-expanded',String(!nextHidden));
};
document.addEventListener('pointerdown',e=>{
 if(!q('.recent').hidden&&!e.target.closest('.recent,.recent-toggle')){q('.recent').hidden=true;q('.recent-toggle').setAttribute('aria-expanded','false');}
 if(!q('.palette-popover').hidden&&!e.target.closest('.palette-popover,.palette-toggle')){q('.palette-popover').hidden=true;q('.palette-toggle').setAttribute('aria-expanded','false');}
});
q('.sync-status').onclick=()=>capture.call('retry');
capture.onState(update);
capture.onFocus(()=>{closePopovers();q('.body').focus();});
capture.call('state').then(value=>{restoreBundle(value.drafts,value.draft);update(value);q('.body').focus();}).catch(e=>notify(e.message,true));
let panelMoving=false,panelFrame=false;
q('header').addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button,select,label'))return;e.preventDefault();panelMoving=true;q('header').setPointerCapture(e.pointerId);void capture.call('panel-down',{x:e.screenX,y:e.screenY});});
q('header').addEventListener('pointermove',e=>{if(!panelMoving||panelFrame)return;panelFrame=true;requestAnimationFrame(()=>{panelFrame=false;if(panelMoving)void capture.call('panel-move',{x:e.screenX,y:e.screenY});});});
q('header').addEventListener('pointerup',e=>{if(!panelMoving)return;panelMoving=false;void capture.call('panel-up',{x:e.screenX,y:e.screenY});});
q('header').addEventListener('pointercancel',()=>{panelMoving=false;void capture.call('panel-cancel');});
