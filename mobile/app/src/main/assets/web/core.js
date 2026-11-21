// Qingjian mobile core — line-for-line ES port of desktop
// `desktop-capture-orb-20260930/standalone/core.cjs` (Qingjian 0.4.x).
// The envelope / digest rules are the signed contract of protocol v1
// (`docs/protocol.md` §2):
// any change here must keep `tests/core-parity.test.mjs` byte-identical with core.cjs.
export const TYPES={note:'~',diary:null,task:'!',issue:'?',idea:'I',link:'L'};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const enc=new TextEncoder();
export async function sha(value){const buf=await globalThis.crypto.subtle.digest('SHA-256',typeof value==='string'?enc.encode(value):value);return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');}
const stable=value=>JSON.stringify(value);
export function dateAt(time=new Date()){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);}
export function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
export function text(value,max){if(typeof value!=='string'||value.length>max||value.includes('\0'))throw Error('内容长度或格式无效');return value.replace(/\r\n?/g,'\n').trim();}
export function payload(input){
 if(!input||!Object.hasOwn(TYPES,input.type))throw Error('请选择有效的记录类型');
 const rawProj=text(input.project??'',60).replace(/^#(?:项目\/)?/,'').trim();
 if(rawProj&&/[\s#\[\]|<>]/.test(rawProj))throw Error('项目简称不能包含空格或特殊括号');
 const p={type:input.type,body:text(input.body??'',50000),source:text(input.source??'',4000),thought:text(input.thought??'',20000),due:text(input.due??'',10),tags:text(input.tags??'',200),attachments:[],...(rawProj?{project:rawProj}:{})};
 if(p.due&&(p.type!=='task'||!validDate(p.due)))throw Error('任务日期无效');
 if(p.type==='idea'){const tags=p.tags.split(/[\s,，]+/).filter(Boolean).map(t=>t.replace(/^#/,''));if(tags.length<1||tags.length>3||tags.some(t=>!t||/[#\[\]<>]/.test(t)))throw Error('想法请填写 1–3 个检索标签；暂不分类可选随手记');p.tags=tags.map(t=>'#'+t).join(' ');}
 if(!Array.isArray(input.attachments??[])||(input.attachments??[]).length>20)throw Error('每条记录最多 20 个附件');
 p.attachments=(input.attachments??[]).map(a=>{if(!UUID.test(a.id)||!/^\.[a-z0-9]{1,8}$/.test(a.ext)||!/^[a-f0-9]{64}$/.test(a.hash)||!Number.isInteger(a.size)||a.size<1||a.size>25*1024*1024)throw Error('附件信息无效');return {id:a.id,name:text(a.name,240),ext:a.ext,hash:a.hash,size:a.size};});
 if(!p.body&&!p.source&&!p.thought&&!p.attachments.length)throw Error('请输入内容或添加资料');
 return p;
}
export async function validate(e){
 if(!e||!UUID.test(e.id)||!Number.isInteger(e.revision)||e.revision<1||e.revision>10000||!validDate(e.date)||!Number.isFinite(Date.parse(e.createdAt)))throw Error('记录编号、版本或日期无效');
 if((e.revision===1&&e.previousDigest!==null)||(e.revision>1&&!/^[a-f0-9]{64}$/.test(e.previousDigest)))throw Error('前一版本标记无效');
 const clean={id:e.id,revision:e.revision,date:e.date,createdAt:e.createdAt,previousDigest:e.previousDigest,payload:payload(e.payload)};
 if(e.digest!==await sha(stable(clean)))throw Error('记录校验失败，已停止写入');return clean;
}
// `previous` is the last submitted version {revision,digest,date,createdAt}; `now` is injectable for tests.
export async function envelope(id,p,previous,now=new Date()){if(!UUID.test(id))throw Error('记录编号无效');const e={id,revision:previous?previous.revision+1:1,date:previous?.date??dateAt(now),createdAt:previous?.createdAt??now.toISOString(),previousDigest:previous?.digest??null,payload:payload(p)};return {...e,digest:await sha(stable(e))};}
export const attachmentPath=(e,a)=>`00_Inbox/Attachments/DesktopCapture/${e.date}/${a.id}${a.ext}`;
// Same Markdown block the desktop bridge writes (without re-validating the digest; callers pass trusted envelopes).
export function blockLines(e){const p=e.payload,body=p.body.split('\n');let first=body.shift()||p.source||p.thought.split('\n')[0]||p.attachments[0]?.name||'资料';
 const safe=t=>t.replace(/<!--\s*desktop-capture/gi,'&lt;!--desktop-capture');
 first=safe(first);
 if(p.type==='diary')first=first.replace(/^(\[[^\]]*\])(?=\s|$)/,'\\$1');
 const projTag=p.project&&!first.includes('#项目/'+p.project)&&!(p.tags||'').includes('#项目/'+p.project)?` #项目/${p.project}`:'';
 let line=(p.type==='diary'?'- ':`- [${TYPES[p.type]}] `)+first+(p.type==='idea'?' '+p.tags:'')+projTag+(p.due?' 📅 '+p.due:'');
 if(['issue','idea','link'].includes(p.type))line+=` <!--apex-${p.type}-created:${e.createdAt}-->`;
 const lines=[`<!-- desktop-capture:${e.id}:${e.revision}:${e.digest} -->`,line];
 const quote=s=>s.split('\n').map(t=>'  > '+safe(t));
 if(body.length)lines.push(...quote(body.join('\n')));
 if(p.source)lines.push('  ',...quote('来源：'+p.source));
 if(p.thought)lines.push('  ',...quote('我的想法：'+p.thought));
 for(const a of p.attachments){const path=attachmentPath(e,a);lines.push('  '+(/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.ext)?'!':'')+`[[${path}|${a.name.replace(/[\[\]|\r\n]/g,' ')}]]`);}
 lines.push(`<!-- /desktop-capture:${e.id} -->`);return lines;
}
export async function block(e){await validate(e);return blockLines(e).join('\n');}
// Offline fallback for “复制 Markdown”: the visible Daily lines without the bridge's ownership markers,
// so a hand-pasted copy can never be mistaken for (or collide with) a bridge-managed block.
export function plainMarkdown(e){return blockLines(e).slice(1,-1).join('\n');}
export const PALETTES={
 'obsidian-indigo':{label:'曜石靛紫',swatch:'#7c6ff6',surface:'#121318',container:'#181a22',text:'#f3f4f6',muted:'#8b92a5',outline:'#272b38',primary:'#7c6ff6',onPrimary:'#ffffff',tint:'#232538',dark:true},
 'warm-paper':{label:'暖宣轻笺',swatch:'#c86d2d',surface:'#faf8f5',container:'#f1eee8',text:'#1c1b18',muted:'#6e6a61',outline:'#e2ddd3',primary:'#c86d2d',onPrimary:'#ffffff',tint:'#efe5dc',dark:false},
 'aurora-teal':{label:'极光雾蓝',swatch:'#2dd4bf',surface:'#0e1724',container:'#152235',text:'#f0f9ff',muted:'#8ea4be',outline:'#233650',primary:'#2dd4bf',onPrimary:'#062026',tint:'#16353d',dark:true},
 'rose-quartz':{label:'晨雾樱灰',swatch:'#b84a76',surface:'#fbf9fa',container:'#f3eef1',text:'#261e22',muted:'#73656c',outline:'#e3d9df',primary:'#b84a76',onPrimary:'#ffffff',tint:'#f0e1e7',dark:false},
 'graphite-gold':{label:'玄墨暗金',swatch:'#d49b38',surface:'#111112',container:'#1a1a1d',text:'#f5f5f4',muted:'#9ca3af',outline:'#2b2b30',primary:'#d49b38',onPrimary:'#171207',tint:'#2d2618',dark:true}
};
export const PALETTE_LIST=Object.entries(PALETTES).map(([id,p])=>({id,label:p.label,swatch:p.swatch,dark:p.dark}));
export function resolvePalette(id){const base=PALETTES[id]||PALETTES['obsidian-indigo'];const {label:_l,swatch:_s,...theme}=base;return theme;}
