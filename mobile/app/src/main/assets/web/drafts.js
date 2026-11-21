// Multi-draft bundle logic shared by the UI and unit tests (mirrors desktop Qingjian 0.4.x semantics:
// “+ 新草稿” pinned first, newest slot in front, at most 12 slots, editing slots carry a `base`).
export const MAX_SLOTS=12;
export const MARKERS={note:'[~]',diary:'·',task:'[!]',issue:'[?]',idea:'[I]',link:'[L]'};
export const LABELS={note:'随手记',diary:'日记',task:'任务',issue:'问题',idea:'想法',link:'链接'};
const uuid=()=>globalThis.crypto.randomUUID();
export function blankPayload(){return {type:'note',body:'',source:'',thought:'',due:'',tags:'',project:'',attachments:[]};}
// base = last submitted version {revision,digest,date,createdAt} when the slot edits an existing record.
export function makeBlankDraft(id=uuid()){return {id,base:null,panels:{},payload:blankPayload()};}
export function normalizeDraft(d){
 const base=d&&typeof d==='object'?d:{};
 const b=base.base&&Number.isInteger(base.base.revision)&&/^[a-f0-9]{64}$/.test(base.base.digest||'')?base.base:null;
 return {id:typeof base.id==='string'&&base.id?base.id:uuid(),base:b,panels:base.panels&&typeof base.panels==='object'?base.panels:{},payload:{...blankPayload(),...(base.payload||{}),attachments:Array.isArray(base.payload?.attachments)?base.payload.attachments:[]}};
}
export function filled(d){return ['body','source','thought'].some(k=>String(d?.payload?.[k]||'').trim())||(d?.payload?.attachments?.length||0)>0;}
export function normalizeBundle(saved){
 const items=Array.isArray(saved?.items)?saved.items.slice(0,MAX_SLOTS).map(normalizeDraft):[];
 if(!items.length){const fresh=makeBlankDraft();return {activeId:fresh.id,items:[fresh]};}
 const activeId=items.some(x=>x.id===saved.activeId)?saved.activeId:items[0].id;
 return {activeId,items};
}
export function active(bundle){return bundle.items.find(x=>x.id===bundle.activeId)||bundle.items[0];}
export function upsertActive(bundle,draft){
 const items=bundle.items.slice(),idx=items.findIndex(x=>x.id===draft.id);
 if(idx>=0)items[idx]=structuredClone(draft);else items.unshift(structuredClone(draft));
 return {activeId:draft.id,items};
}
// Returns {bundle,error}. `initial` lets “修改” / 分享 load content into a fresh slot in front.
export function addSlot(bundle,initial){
 if(bundle.items.length>=MAX_SLOTS)return {bundle,error:`最多同时保留 ${MAX_SLOTS} 个草稿槽`};
 const next=initial?normalizeDraft(structuredClone(initial)):makeBlankDraft();
 if(bundle.items.some(x=>x.id===next.id))return {bundle:{...bundle,activeId:next.id},error:null};
 return {bundle:{activeId:next.id,items:[next,...bundle.items]},error:null};
}
export function removeSlot(bundle,id){
 if(bundle.items.length<=1){const fresh=makeBlankDraft();return {activeId:fresh.id,items:[fresh]};}
 const idx=bundle.items.findIndex(x=>x.id===id);
 const items=bundle.items.filter(x=>x.id!==id);
 const activeId=bundle.activeId===id?items[Math.max(0,Math.min(idx,items.length-1))].id:bundle.activeId;
 return {activeId,items};
}
// After saving: drop the saved slot; if it was the only one, leave a fresh blank slot.
export function afterSave(bundle,savedId){return removeSlot(bundle,savedId);}
export function tabLabel(item,idx){
 const raw=String(item.payload?.body||item.payload?.source||item.payload?.thought||'').trim().split('\n')[0]||'';
 const summary=raw?raw.slice(0,9)+(raw.length>9?'…':''):(item.payload?.attachments?.length?'图片 '+item.payload.attachments.length:'草稿 '+(idx+1));
 return (item.base?'✎ ':(MARKERS[item.payload?.type]||'[~]')+' ')+summary;
}
// Frequency-ranked recent idea tags (without '#') for one-tap chips.
export function recentTags(records,limit=8){
 const count=new Map();
 for(const r of records||[])for(const t of String(r?.payload?.tags||'').split(/\s+/))if(t.startsWith('#')&&t.length>1)count.set(t.slice(1),(count.get(t.slice(1))||0)+1);
 return [...count.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit).map(([t])=>t);
}
export function toggleTag(tags,tag){
 const list=String(tags||'').split(/[\s,，]+/).filter(Boolean).map(t=>t.replace(/^#/,''));
 const at=list.indexOf(tag);
 if(at>=0)list.splice(at,1);else if(list.length<3)list.push(tag);
 return list.join(' ');
}
