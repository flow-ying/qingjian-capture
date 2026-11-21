// Byte-level parity between mobile core.js (WebCrypto, async) and desktop core.cjs (the bridge's validator).
// The desktop source is read-only here; set QJ_DESKTOP_CORE to override its location on another machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as m from '../app/src/main/assets/web/core.js';

const corePath=process.env.QJ_DESKTOP_CORE||fileURLToPath(new URL('../../desktop/standalone/core.cjs',import.meta.url));
const have=existsSync(corePath);
const d=have?createRequire(import.meta.url)(corePath):null;
const opt={skip:have?false:'desktop core.cjs not found: '+corePath};

const att=(i,ext='.jpg')=>({id:`0f0e0d0c-0b0a-4908-8706-0504030201${String(i).padStart(2,'0')}`,name:`照片 ${i}${ext}`,ext,hash:String(i%10).repeat(64),size:1000+i});
const inputs=[
 {type:'note',body:'  第一行\r\n第二行 😀\r\n  ',source:'',thought:'',due:'',tags:'',attachments:[]},
 {type:'diary',body:'[x] 今天的日记以方括号开头',source:'',thought:'',attachments:[]},
 {type:'task',body:'交实验报告',due:'2026-11-21',project:'#项目/demo',attachments:[]},
 {type:'issue',body:'LiveSync 墓碑为什么会遮蔽？',source:'https://example.com/a?b=1&c="q"',thought:'下次排查顺序',project:'工作台',attachments:[]},
 {type:'idea',body:'只在手机上采集',tags:'工作流，#移动端 , 采集',attachments:[att(1),att(2,'.png')]},
 {type:'link',body:'',source:'https://b23.tv/AbC',thought:'',attachments:[]},
 {type:'note',body:'',source:'',thought:'',attachments:[att(3,'.webp')]},
 {type:'note',body:'含 <!-- desktop-capture:伪造 --> 注释与 \\ 反斜杠 \u2028 行分隔符 \t tab',attachments:[]},
 {type:'note',body:'x'.repeat(5000)+'中文'.repeat(2000),attachments:[]}
];
const bad=[
 {type:'nope',body:'x'},
 {type:'note',body:''},
 {type:'idea',body:'x',tags:''},
 {type:'idea',body:'x',tags:'a b c d'},
 {type:'task',body:'x',due:'2026-02-30'},
 {type:'note',body:'x',due:'2026-11-20'},
 {type:'note',body:'x',project:'有 空格'},
 {type:'note',body:'x',attachments:[{...att(1),hash:'XYZ'}]},
 {type:'note',body:'a\0b'}
];

test('payload() 规范化结果与 core.cjs 完全一致',opt,()=>{
 for(const i of inputs)assert.deepEqual(m.payload(i),d.payload(i));
});
test('非法输入两端以同一中文错误拒绝',opt,()=>{
 for(const i of bad){
  let a,b;try{m.payload(i);}catch(e){a=e.message;}try{d.payload(i);}catch(e){b=e.message;}
  assert.ok(a&&b,`应拒绝 ${JSON.stringify(i)}`);assert.equal(a,b);
 }
});
test('移动端信封可被桌面 validate() 接受，digest / block 字节级一致',opt,async()=>{
 const now=new Date('2026-11-19T15:30:00.123Z'); // JST date 2026-11-20
 for(const i of inputs){
  const e=await m.envelope(globalThis.crypto.randomUUID(),i,null,now);
  assert.equal(e.date,'2026-11-20');
  assert.deepEqual(d.validate(e),Object.fromEntries(Object.entries(e).filter(([k])=>k!=='digest')));
  assert.equal(await m.block(e),d.block(e));
  // edit chain: revision 2 links to revision 1
  const e2=await m.envelope(e.id,{...i,body:(i.body||'')+' 改'},{revision:e.revision,digest:e.digest,date:e.date,createdAt:e.createdAt},new Date());
  assert.equal(e2.revision,2);assert.equal(e2.previousDigest,e.digest);assert.equal(e2.date,e.date);assert.equal(e2.createdAt,e.createdAt);
  d.validate(e2);
  const t=d.transition(d.transition('# Daily\n',e).content,e2,{revision:1,digest:e.digest,blockHash:d.sha(d.block(e))});
  assert.ok(t.content.includes(`<!-- desktop-capture:${e.id}:2:${e2.digest} -->`));
 }
});
test('桌面生成的信封移动端 validate() 同样接受',opt,async()=>{
 for(const i of inputs){const e=d.envelope(globalThis.crypto.randomUUID(),i);await m.validate(e);assert.equal(await m.sha(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k])=>k!=='digest')))),e.digest);}
});
test('篡改任一字段后 digest 校验失败',async()=>{
 const e=await m.envelope(globalThis.crypto.randomUUID(),inputs[3],null);
 await assert.rejects(m.validate({...e,payload:{...e.payload,body:e.payload.body+'!'}}),/记录校验失败/);
 await assert.rejects(m.validate({...e,revision:2}),/前一版本标记无效/);
});
test('复制 Markdown 兜底不含桥接所有权标记',async()=>{
 const e=await m.envelope(globalThis.crypto.randomUUID(),inputs[4],null);
 const md=m.plainMarkdown(e);
 assert.ok(!md.includes('desktop-capture'));assert.ok(md.startsWith('- [I] 只在手机上采集 #工作流 #移动端 #采集'));
 assert.ok(md.includes('![[00_Inbox/Attachments/DesktopCapture/'));
});
test('5 套配色与桌面 PALETTES 完全一致',opt,()=>{
 assert.deepEqual(m.PALETTES,d.PALETTES);assert.deepEqual(m.PALETTE_LIST,d.PALETTE_LIST);
 assert.deepEqual(m.resolvePalette('warm-paper'),d.resolvePalette('warm-paper'));
});
