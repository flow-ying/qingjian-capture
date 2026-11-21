// Qingjian mobile UI controller — adapted from desktop standalone/ui/capture.js (0.4.x Scheme A):
// front-pinned “+ 新草稿”, ≤12 persisted slots, floating “最近” popover, 5 palettes, #项目 chips.
import {envelope,payload as normalizePayload,plainMarkdown,PALETTE_LIST,resolvePalette} from './core.js';
import {cleanShareText,clipboardSuggestion} from './share-clean.js';
import {MARKERS,LABELS,makeBlankDraft,normalizeBundle,normalizeDraft,filled,active,upsertActive,addSlot,removeSlot,afterSave,tabLabel,recentTags,toggleTag} from './drafts.js';
import {describe,syncSummary} from './status.js';
import {capture,isNative} from './bridge.js';

const q=s=>document.querySelector(s),qa=s=>[...document.querySelectorAll(s)];
let state={records:[],online:false,pending:0,palette:'obsidian-indigo',pinned:false,projects:[],settings:{}};
let bundle=normalizeBundle(null),draft=active(bundle),saving=false,timer=null,noticeTimer=null,draftChain=Promise.resolve(),lastProjectsKey='',clipText='',confirmDelete='';

function notify(message,sticky=false){clearTimeout(noticeTimer);q('.notice').textContent=message;if(!sticky)noticeTimer=setTimeout(()=>q('.notice').textContent='',4200);}
function applyTheme(id){const theme=resolvePalette(id);for(const[k,v]of Object.entries(theme))if(typeof v==='string')document.documentElement.style.setProperty('--'+k,v);document.documentElement.style.colorScheme=theme.dark?'dark':'light';document.documentElement.dataset.dark=String(Boolean(theme.dark));}

// ------------------------------------------------------------------ drafts
function readForm(){
 for(const key of ['body','source','thought','due','tags'])draft.payload[key]=q('.'+key).value;
 draft.payload.project=q('.project-select').value||'';
 draft.panels={source:!q('.source-block').hidden,thought:!q('.thought-block').hidden};
 bundle=upsertActive(bundle,draft);
}
function persist(){
 clearTimeout(timer);readForm();
 const value=structuredClone(bundle);
 draftChain=draftChain.catch(()=>{}).then(()=>capture.call('drafts',value)).then(()=>{q('.draft-status').textContent=filled(draft)?'草稿已保存在本机':'空白记录';}).catch(e=>{q('.draft-status').textContent='草稿保存失败';notify(e.message,true);});
 return draftChain;
}
function changed(){q('.draft-status').textContent='正在保存草稿…';readForm();renderDraftTabs();clearTimeout(timer);timer=setTimeout(()=>void persist(),250);refreshClipHint();}
function loadDraft(value){
 draft=normalizeDraft(value);
 for(const key of ['body','source','thought','due','tags'])q('.'+key).value=draft.payload[key]||'';
 renderProjects();
 for(const key of ['source','thought']){
  const open=draft.panels?.[key]??Boolean(draft.payload[key]);
  q('.'+key+'-block').hidden=!open;q('.add-'+key).setAttribute('aria-expanded',String(open));
 }
 renderType();renderFiles();renderSave();
}
function setBundle(next){bundle=next;loadDraft(active(bundle));renderDraftTabs();}
function renderDraftTabs(){
 const host=q('.draft-tabs');host.replaceChildren();
 bundle.items.forEach((item,idx)=>{
  const tab=document.createElement('button');tab.type='button';
  tab.className='draft-tab'+(item.id===bundle.activeId?' is-active':'');
  tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(item.id===bundle.activeId));
  const label=document.createElement('span');label.className='draft-tab-label';label.textContent=tabLabel(item,idx);tab.append(label);
  if(bundle.items.length>1){
   const close=document.createElement('span');close.className='draft-tab-close';close.textContent='×';close.title='关闭此草稿槽';
   close.onclick=e=>{e.stopPropagation();if(saving)return;readForm();setBundle(removeSlot(bundle,item.id));void persist();};
   tab.append(close);
  }
  tab.onclick=()=>{if(saving||item.id===bundle.activeId)return;readForm();setBundle({...bundle,activeId:item.id});void persist();};
  host.append(tab);
 });
}
function newSlot(initial){
 if(saving)return false;readForm();
 const {bundle:next,error}=addSlot(bundle,initial);
 if(error){notify(error,true);return false;}
 setBundle(next);void persist();return true;
}
// Put content into the current slot when it is empty, otherwise into a new front slot.
function intoDraft(initial){
 readForm();
 if(!filled(draft)&&!draft.base){
  const merged=normalizeDraft({...initial,id:initial.id||draft.id});
  setBundle({activeId:merged.id,items:bundle.items.map(x=>x.id===draft.id?merged:x)});
  void persist();return true;
 }
 return newSlot(initial);
}

// ------------------------------------------------------------------ form rendering
function renderType(){
 q('.type-select').value=draft.payload.type;
 q('.date-block').hidden=draft.payload.type!=='task';
 q('.tags-block').hidden=draft.payload.type!=='idea';
 renderTagChips();
}
function renderTagChips(){
 const host=q('.tag-chips');host.replaceChildren();
 if(draft.payload.type!=='idea')return;
 const current=String(q('.tags').value||'').split(/[\s,，]+/).filter(Boolean).map(t=>t.replace(/^#/,''));
 for(const t of recentTags(state.records)){
  const b=document.createElement('button');b.type='button';b.className='tag-chip'+(current.includes(t)?' is-on':'');b.textContent='#'+t;
  b.onclick=()=>{q('.tags').value=toggleTag(q('.tags').value,t);changed();renderTagChips();};
  host.append(b);
 }
}
function renderProjects(){
 const sel=q('.project-select'),cur=draft.payload.project||'';
 const list=[...new Set([...(state.projects||[]),...(cur?[cur]:[])])];
 const key=JSON.stringify(list);
 if(key!==lastProjectsKey){
  sel.replaceChildren();
  const none=document.createElement('option');none.value='';none.textContent='#项目';sel.append(none);
  for(const p of list){const o=document.createElement('option');o.value=p;o.textContent='#项目/'+p;sel.append(o);}
  lastProjectsKey=key;
 }
 sel.value=cur;
}
function renderFiles(){
 const host=q('.attachments');host.replaceChildren();
 for(const a of draft.payload.attachments){
  const row=document.createElement('div');row.className='attachment';
  const img=document.createElement('img');img.alt=a.name;row.append(img);
  capture.call('attachment-preview',{hash:a.hash}).then(src=>{if(src)img.src=src;}).catch(()=>{});
  const label=document.createElement('span');label.textContent=a.name;
  const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除图片 '+a.name);
  remove.onclick=()=>{if(saving)return;draft.payload.attachments=draft.payload.attachments.filter(f=>f.id!==a.id);renderFiles();changed();};
  row.append(label,remove);host.append(row);
 }
}
function renderSave(){
 const btn=q('.main-save');
 btn.textContent=saving?'保存中…':draft.base?'保存修改':'写入';
 btn.disabled=saving;
 btn.setAttribute('aria-label',draft.base?'保存修改':state.pinned?'保存后继续输入':'保存并收起');
 q('.type-select').disabled=saving;q('.project-select').disabled=saving;
 for(const el of qa('.editor-area input,.editor-area textarea'))el.readOnly=saving;
}
function renderSync(){
 const s=syncSummary(state);
 q('.sync-status').dataset.online=String(s.online);
 q('.sync-text').textContent=s.text;q('.sync-status').title=s.title;
}

// ------------------------------------------------------------------ popovers
function closePopovers(){
 for(const [panel,toggle]of [['.recent','.recent-toggle'],['.palette-popover','.palette-toggle'],['.settings','.menu']]){q(panel).hidden=true;q(toggle).setAttribute('aria-expanded','false');}
 confirmDelete='';
}
function togglePanel(panel,toggle){
 const open=q(panel).hidden;closePopovers();
 q(panel).hidden=!open;q(toggle).setAttribute('aria-expanded',String(open));
 if(open&&panel==='.recent')renderRecords();
 if(open&&panel==='.settings')renderSettings();
}
function renderPalettes(){
 const host=q('.palette-popover');host.replaceChildren();
 for(const p of PALETTE_LIST){
  const btn=document.createElement('button');btn.type='button';btn.className='palette-item';btn.setAttribute('aria-checked',String(state.palette===p.id));
  const dot=document.createElement('span');dot.className='palette-dot';dot.style.background=p.swatch;
  const txt=document.createElement('span');txt.textContent=p.label;
  btn.append(dot,txt);
  btn.onclick=()=>{closePopovers();state.palette=p.id;applyTheme(p.id);renderPalettes();void capture.call('palette',p.id).catch(e=>notify(e.message,true));};
  host.append(btn);
 }
}
function recordMarkdown(r){return plainMarkdown({id:r.id,revision:r.revision,digest:r.digest,date:r.date,createdAt:r.createdAt,payload:r.payload});}
function renderRecords(){
 const records=state.records||[];
 q('.count').textContent=records.length;
 q('.recent-toggle').dataset.warn=String(records.some(r=>describe(r).warn));
 const host=q('.recent');if(host.hidden)return;host.replaceChildren();
 const head=document.createElement('div');head.className='recent-head';
 const title=document.createElement('span');title.textContent='最近记录 · ⚪待上传 🟡已上云 🟢已落盘 🟠需核对';
 const close=document.createElement('button');close.type='button';close.className='recent-close';close.textContent='✕';close.onclick=closePopovers;
 head.append(title,close);
 const list=document.createElement('div');list.className='recent-body';
 if(!records.length){const empty=document.createElement('div');empty.className='recent-empty';empty.textContent='还没有记录，写下第一条吧';list.append(empty);}
 for(const r of records){
  const d=describe(r);
  const row=document.createElement('div');row.className='record';row.dataset.tone=d.tone;
  const meta=document.createElement('small');
  meta.textContent=`${d.dot} ${d.label} · ${LABELS[r.payload.type]||'记录'}${r.payload.project?' · #项目/'+r.payload.project:''} · ${r.date}${r.revision>1?' · 第 '+r.revision+' 版':''}`;
  const body=document.createElement('p');body.textContent=r.payload.body||r.payload.source||(r.payload.attachments?.length?`图片 ×${r.payload.attachments.length}`:'记录');
  row.append(meta,body);
  if(r.payload.source&&r.payload.body){const s=document.createElement('small');s.textContent='来源：'+r.payload.source;row.append(s);}
  if(r.error){const e=document.createElement('small');e.className='error';e.textContent=r.error;row.append(e);}
  const actions=document.createElement('div');actions.className='record-actions';
  const btn=(text,fn,cls='')=>{const b=document.createElement('button');b.type='button';b.textContent=text;if(cls)b.className=cls;b.onclick=fn;actions.append(b);return b;};
  if(d.canEdit)btn('修改',()=>editRecord(r));
  if(d.canSaveAsNew)btn('另存为新记录',()=>{closePopovers();if(intoDraft({payload:structuredClone(r.payload)}))notify('已载入为新记录，确认后写入');});
  if(d.canDelete)btn(confirmDelete===r.id?'确认删除？':'删除',()=>deleteRecord(r),confirmDelete===r.id?'danger':'');
  btn('复制 Markdown',()=>void capture.call('copy-text',recordMarkdown(r)).then(()=>notify('已复制 Markdown，可直接粘进 Obsidian')).catch(e=>notify(e.message,true)));
  if(d.canForget)btn('移除',()=>void capture.call('forget-record',r.id).catch(e=>notify(e.message,true)));
  row.append(actions);list.append(row);
 }
 host.append(head,list);
}
function editRecord(r){
 if(saving)return;readForm();
 const existing=bundle.items.find(x=>x.id===r.id);
 closePopovers();
 if(existing){setBundle({...bundle,activeId:existing.id});void persist();return;}
 const loaded={id:r.id,base:{revision:r.revision,digest:r.digest,date:r.date,createdAt:r.createdAt},payload:{...structuredClone(r.payload),project:r.payload.project||''}};
 if(intoDraft(loaded))notify(r.status==='landed'?'修改将安全回写到电脑 Daily 原位置':'尚未落盘，修改会作为新版本排在后面一起送达');
 q('.body').focus();
}
function deleteRecord(r){
 if(confirmDelete!==r.id){confirmDelete=r.id;renderRecords();return;}
 confirmDelete='';
 void capture.call('delete-record',r.id).then(res=>{
  notify(res?.local?'已从本机删除（尚未上传）':r.status==='landed'?'删除指令已排队，电脑确认后整块移除':'已取消上传');
  for(const item of bundle.items)if(item.id===r.id&&item.base){item.base=null;item.id=crypto.randomUUID();}
  setBundle(bundle);void persist();
 }).catch(e=>notify(e.message,true));
}
function renderSettings(){
 const s=state.settings||{};
 q('.cfg-url').value=s.serverUrl||'';
 q('.cfg-token').value='';q('.cfg-token').placeholder=s.configured?`已保存（${s.tokenLength||'?'} 位），留空则不修改`:'粘贴 device Token';
 q('.cfg-device').value=s.deviceId||'';
 q('.cfg-clip').checked=s.clipboardHint!==false;
 q('.cfg-edge').checked=Boolean(s.edgeBar);
 q('.cfg-version').textContent=`清笺移动版 ${s.version||''}${isNative?'':' · 浏览器预览'}`;
}
function settingsValue(){const v={serverUrl:q('.cfg-url').value.trim(),deviceId:q('.cfg-device').value.trim(),clipboardHint:q('.cfg-clip').checked,edgeBar:q('.cfg-edge').checked};const t=q('.cfg-token').value.trim();if(t)v.token=t;return v;}

// ------------------------------------------------------------------ clipboard & share
function refreshClipHint(){
 const s=clipText&&state.settings?.clipboardHint!==false?clipboardSuggestion(clipText,draft.payload):null;
 q('.clip-hint').hidden=!s;
 if(s){q('.clip-fill').textContent='[ '+s.label+' ]';q('.clip-fill').dataset.kind=s.kind;}
}
function fillClip(){
 const s=clipboardSuggestion(clipText,draft.payload);if(!s)return;
 if(s.kind==='link'){q('.source').value=s.text;q('.source-block').hidden=false;q('.add-source').setAttribute('aria-expanded','true');if(draft.payload.type==='note'&&!q('.body').value.trim()){draft.payload.type='link';renderType();}}
 else if(s.kind==='share'){applyShared(cleanShareText(s.text),[]);}
 else{const b=q('.body');b.value=b.value?b.value.replace(/\s*$/,'')+'\n'+s.text:s.text;}
 clipText='';changed();q('.body').focus();
}
function applyShared(clean,attachments){
 const p={...draft.payload};
 if(clean.source){p.source=clean.source;}
 if(clean.body)p.body=p.body?p.body.replace(/\s*$/,'')+'\n'+clean.body:clean.body;
 if(clean.type==='link'&&p.type==='note')p.type='link';
 p.attachments=[...p.attachments,...attachments].slice(0,20);
 draft.payload=p;
 for(const key of ['body','source'])q('.'+key).value=p[key]||'';
 if(p.source){q('.source-block').hidden=false;q('.add-source').setAttribute('aria-expanded','true');}
 renderType();renderFiles();
}
function onShare(data){
 const clean=data?.text?cleanShareText(data.text,data.subject||''):{type:null,body:data?.subject||'',source:''};
 const atts=Array.isArray(data?.attachments)?data.attachments:[];
 readForm();
 if(filled(draft)||draft.base){if(!newSlot())return;}
 applyShared(clean,atts);changed();
 if(data?.errors?.length){notify(data.errors.join('；'),true);if(!atts.length&&!clean.body&&!clean.source)return;}
 notify(clean.type==='link'?'已清洗分享内容并预选「链接」，可随时改回':atts.length?`已收到 ${atts.length} 张图片（已轻压缩）`:'已填入分享内容');
}

// ------------------------------------------------------------------ actions
async function save(){
 if(saving)return;
 try{
  await persist();readForm();
  if(!filled(draft)){notify('请输入内容或添加图片');return;}
  if(draft.payload.type!=='task')draft.payload.due='';
  normalizePayload(draft.payload); // surfaces validation errors (idea tags, dates, project) before anything is queued
  saving=true;document.body.classList.add('busy');renderSave();
  const e=await envelope(draft.id,draft.payload,draft.base);
  await capture.call('save',{envelope:e});
  const wasEdit=Boolean(draft.base);
  saving=false;document.body.classList.remove('busy');
  setBundle(afterSave(bundle,draft.id));await persist();
  notify(wasEdit?'修改已存本机，联网后回写电脑':state.online?'已存本机并开始上传':'已存本机，联网后自动上传');
  if(!state.pinned)await capture.call('collapse');else q('.body').focus();
 }catch(e){saving=false;document.body.classList.remove('busy');renderSave();notify(e.message,true);}
}
async function copyForAI(){
 readForm();if(!filled(draft)){notify('当前草稿为空，先写几句再复制吧');return;}
 const p=draft.payload;
 const parts=[`${MARKERS[p.type]||'[~]'} ${LABELS[p.type]||'随手记'}${p.project?`（#项目/${p.project}）`:''}：`,p.body.trim()];
 if(p.source.trim())parts.push('来源：'+p.source.trim());
 if(p.thought.trim())parts.push('补充想法：'+p.thought.trim());
 await capture.call('copy-text',parts.filter(Boolean).join('\n'));
 notify('已复制草稿与项目上下文，可直接粘贴给 AI');
}
function collapse(){closePopovers();void persist().then(()=>capture.call('collapse')).catch(e=>notify(e.message,true));}

// ------------------------------------------------------------------ state from native
function update(value){
 if(!value)return;
 state={...state,...value};
 applyTheme(state.palette);
 renderProjects();renderPalettes();renderSync();renderRecords();renderTagChips();
 q('.pin').setAttribute('aria-pressed',String(Boolean(state.pinned)));
 renderSave();
}

// ------------------------------------------------------------------ wiring
q('.main-save').onclick=()=>void save();
q('.close').onclick=collapse;
q('.scrim').onclick=collapse;
q('.pin').onclick=()=>{state.pinned=!state.pinned;q('.pin').setAttribute('aria-pressed',String(state.pinned));void capture.call('pin',state.pinned).catch(e=>notify(e.message));notify(state.pinned?'保存后保持小窗打开':'保存后自动收起');};
q('.new-draft').onclick=()=>{if(newSlot())q('.body').focus();};
q('.copy-ai').onclick=()=>void copyForAI().catch(e=>notify(e.message,true));
q('.type-select').onchange=()=>{if(saving)return;draft.payload.type=q('.type-select').value;renderType();changed();};
q('.project-select').onchange=()=>{if(saving)return;draft.payload.project=q('.project-select').value;changed();};
for(const key of ['source','thought'])q('.add-'+key).onclick=()=>{const panel=q('.'+key+'-block');panel.hidden=!panel.hidden;q('.add-'+key).setAttribute('aria-expanded',String(!panel.hidden));if(!panel.hidden)q('.'+key).focus();changed();};
q('.add-file').onclick=async()=>{
 try{const room=20-draft.payload.attachments.length;if(room<=0)throw Error('每条最多 20 张图片');
  const got=await capture.call('pick-images',{max:room});if(!got?.length)return;
  draft.payload.attachments.push(...got.slice(0,room));renderFiles();changed();notify(`已添加 ${got.length} 张图片（已轻压缩）`);
 }catch(e){notify(e.message,true);}
};
for(const key of ['body','source','thought','due','tags'])q('.'+key).addEventListener('input',changed);
q('.tags').addEventListener('input',renderTagChips);
q('.body').addEventListener('paste',e=>{const t=e.clipboardData?.getData('text/plain')?.trim();if(t&&/^https?:\/\/\S+$/.test(t)&&!q('.source').value){e.preventDefault();q('.source').value=t;q('.source-block').hidden=false;q('.add-source').setAttribute('aria-expanded','true');changed();}});
q('.recent-toggle').onclick=e=>{e.stopPropagation();togglePanel('.recent','.recent-toggle');};
q('.palette-toggle').onclick=e=>{e.stopPropagation();togglePanel('.palette-popover','.palette-toggle');};
q('.menu').onclick=e=>{e.stopPropagation();togglePanel('.settings','.menu');};
q('.settings-close').onclick=closePopovers;
q('.cfg-save').onclick=()=>void capture.call('settings-save',settingsValue()).then(()=>{q('.cfg-token').value='';q('.cfg-result').textContent='已保存';}).catch(e=>{q('.cfg-result').textContent=e.message;});
q('.cfg-test').onclick=()=>{q('.cfg-result').textContent='正在连接…';void capture.call('test-connection',settingsValue()).then(r=>{q('.cfg-result').textContent=r?.ok?`连接成功 · 协议 v${r.protocol} · 角色 ${r.role}${r.message?' · '+r.message:''}`:(r?.message||'连接失败');}).catch(e=>{q('.cfg-result').textContent=e.message;});};
q('.cfg-sync').onclick=()=>void capture.call('retry').then(()=>{q('.cfg-result').textContent='已触发同步';});
q('.sync-status').onclick=()=>{if(!state.settings?.configured){togglePanel('.settings','.menu');return;}void capture.call('retry').then(()=>notify('正在同步…'));};
q('.clip-fill').onclick=fillClip;
q('.clip-dismiss').onclick=()=>{clipText='';refreshClipHint();};
document.addEventListener('pointerdown',e=>{
 if(!e.target.closest('.recent,.recent-toggle,.palette-popover,.palette-toggle,.settings,.menu'))closePopovers();
});
document.addEventListener('keydown',e=>{
 if(e.isComposing)return;
 if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();void save();}
 else if(e.key==='Escape'){e.preventDefault();if(qa('.recent,.palette-popover,.settings').some(x=>!x.hidden))closePopovers();else collapse();}
});
capture.on('state',update);
capture.on('focus',()=>{closePopovers();q('.body').focus({preventScroll:true});});
capture.on('clipboard',v=>{clipText=String(v?.text||'');refreshClipHint();});
capture.on('share',onShare);
capture.on('back',()=>{if(qa('.recent,.palette-popover,.settings').some(x=>!x.hidden))closePopovers();else collapse();});
capture.on('flush',()=>void persist());
capture.call('state').then(value=>{setBundle(normalizeBundle(value?.drafts));update(value);q('.body').focus({preventScroll:true});void capture.call('ready');}).catch(e=>notify(e.message,true));
