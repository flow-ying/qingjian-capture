import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_SLOTS,makeBlankDraft,normalizeBundle,addSlot,removeSlot,afterSave,tabLabel,filled,recentTags,toggleTag,upsertActive} from '../app/src/main/assets/web/drafts.js';
import {describe,syncSummary,STATUS} from '../app/src/main/assets/web/status.js';

test('新草稿置前、最多 12 槽、满槽拒绝',()=>{
 let b=normalizeBundle(null);assert.equal(b.items.length,1);
 for(let i=1;i<MAX_SLOTS;i++){const r=addSlot(b);assert.equal(r.error,null);b=r.bundle;assert.equal(b.items[0].id,b.activeId);}
 assert.equal(b.items.length,12);
 const full=addSlot(b);assert.match(full.error,/12/);assert.equal(full.bundle.items.length,12);
});
test('关闭当前槽切到相邻槽；关闭最后一槽留下空白槽',()=>{
 let b=normalizeBundle(null);b=addSlot(b).bundle;b=addSlot(b).bundle;
 const [a,,c]=b.items.map(x=>x.id);
 const r=removeSlot(b,a);assert.equal(r.items.length,2);assert.equal(r.activeId,r.items[0].id);
 let one=normalizeBundle(null);const old=one.items[0].id;one=removeSlot(one,old);
 assert.equal(one.items.length,1);assert.notEqual(one.items[0].id,old);
 assert.equal(removeSlot(b,c).activeId,b.activeId);
});
test('保存后移除该槽；修改槽带 ✎ 前缀，普通槽显示类型标记',()=>{
 let b=normalizeBundle(null);const d=b.items[0];d.payload.body='第一行很长很长很长很长的正文\n第二行';
 b=upsertActive(b,d);assert.equal(tabLabel(b.items[0],0),'[~] 第一行很长很长很长…');
 const edit={...makeBlankDraft(),base:{revision:2,digest:'a'.repeat(64),date:'2026-11-20',createdAt:'2026-11-20T00:00:00.000Z'},payload:{...makeBlankDraft().payload,type:'task',body:'改'}};
 b=addSlot(b,edit).bundle;assert.equal(tabLabel(b.items[0],0),'✎ 改');
 const after=afterSave(b,edit.id);assert.equal(after.items.length,1);assert.equal(after.items[0].id,d.id);
});
test('恢复持久化草稿：丢弃非法 base、超额截断、activeId 失效回落',()=>{
 const items=Array.from({length:15},(_,i)=>({id:'d'+i,base:i===0?{revision:'x'}:null,payload:{body:'b'+i}}));
 const b=normalizeBundle({activeId:'missing',items});
 assert.equal(b.items.length,12);assert.equal(b.activeId,'d0');assert.equal(b.items[0].base,null);assert.equal(b.items[0].payload.type,'note');
});
test('filled 判定：正文/来源/想法/图片任一非空',()=>{
 const d=makeBlankDraft();assert.equal(filled(d),false);
 d.payload.thought='  ';assert.equal(filled(d),false);d.payload.attachments=[{}];assert.equal(filled(d),true);
});
test('常用标签按频次排序，点选最多 3 个可取消',()=>{
 const recs=[{payload:{tags:'#工作流 #移动端'}},{payload:{tags:'#工作流'}},{payload:{tags:''}}];
 assert.deepEqual(recentTags(recs),['工作流','移动端']);
 assert.equal(toggleTag('a b','c'),'a b c');assert.equal(toggleTag('a b c','d'),'a b c');assert.equal(toggleTag('#a b','a'),'b');
});
test('状态点映射与可用操作（协议 v1 §4.3）',()=>{
 assert.equal(describe({status:'local'}).dot,'⚪');assert.equal(describe({status:'sending'}).label,'待上传');
 assert.equal(describe({status:'queued'}).dot,'🟡');assert.equal(describe({status:'pulled'}).dot,'🟡');
 const landed=describe({status:'landed'});assert.equal(landed.dot,'🟢');assert.ok(landed.canEdit&&landed.canDelete&&!landed.canSaveAsNew);
 for(const s of ['conflict','failed','rejected','expired']){const v=describe({status:s});assert.equal(v.dot,'🟠');assert.ok(v.warn&&!v.canEdit&&!v.canDelete&&v.canSaveAsNew&&v.canForget);}
 const del=describe({status:'deleting'});assert.ok(!del.canEdit&&!del.canDelete);
 assert.equal(Object.keys(STATUS).length,10);
});
test('同步胶囊：未配对 / Token 无效 / 离线待传 / 已连',()=>{
 assert.equal(syncSummary({settings:{}}).text,'未配对');
 assert.equal(syncSummary({settings:{configured:true},authError:'x'}).text,'Token 无效');
 assert.equal(syncSummary({settings:{configured:true},online:false,pending:3}).text,'3 待传');
 assert.deepEqual(syncSummary({settings:{configured:true},online:true,pending:0}).text,'已连');
});
