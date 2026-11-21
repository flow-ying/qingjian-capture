'use strict';
const crypto=require('node:crypto');
const TYPES={note:'~',diary:null,task:'!',issue:'?',idea:'I',link:'L'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const stable=value=>JSON.stringify(value);
function dateAt(time=new Date()){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(time);}
function validDate(value){return /^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
function text(value,max){if(typeof value!=='string'||value.length>max||value.includes('\0'))throw Error('内容长度或格式无效');return value.replace(/\r\n?/g,'\n').trim();}
function payload(input){
 if(!input||!Object.hasOwn(TYPES,input.type))throw Error('请选择有效的记录类型');
 const rawProj=text(input.project??'',60).replace(/^#(?:项目\/)?/,'').trim();
 if(rawProj&&/[\s#\[\]|<>]/.test(rawProj))throw Error('项目简称不能包含空格或特殊括号');
 const p={type:input.type,body:text(input.body??'',50000),source:text(input.source??'',4000),thought:text(input.thought??'',20000),due:text(input.due??'',10),tags:text(input.tags??'',200),attachments:[],...(rawProj?{project:rawProj}:{})};
 if(p.due&&(p.type!=='task'||!validDate(p.due)))throw Error('任务日期无效');
 if(p.type==='idea'){const tags=p.tags.split(/[\s,，]+/).filter(Boolean).map(t=>t.replace(/^#/,''));if(tags.length<1||tags.length>3||tags.some(t=>!t||/[#\[\]<>]/.test(t)))throw Error('想法请填写 1–3 个检索标签；暂不分类可选随手记');p.tags=tags.map(t=>'#'+t).join(' ');}
 if(!Array.isArray(input.attachments??[])||(input.attachments??[]).length>20)throw Error('每条记录最多 20 个附件');
 p.attachments=(input.attachments??[]).map(a=>{if(!UUID.test(a.id)||!/^\.[a-z0-9]{1,8}$/.test(a.ext)||! /^[a-f0-9]{64}$/.test(a.hash)||!Number.isInteger(a.size)||a.size<1||a.size>25*1024*1024)throw Error('附件信息无效');return {id:a.id,name:text(a.name,240),ext:a.ext,hash:a.hash,size:a.size};});
 if(!p.body&&!p.source&&!p.thought&&!p.attachments.length)throw Error('请输入内容或添加资料');
 return p;
}
function validate(e){
 if(!e||!UUID.test(e.id)||!Number.isInteger(e.revision)||e.revision<1||e.revision>10000||!validDate(e.date)||!Number.isFinite(Date.parse(e.createdAt)))throw Error('记录编号、版本或日期无效');
 if((e.revision===1&&e.previousDigest!==null)||(e.revision>1&&!/^[a-f0-9]{64}$/.test(e.previousDigest)))throw Error('前一版本标记无效');
 const clean={id:e.id,revision:e.revision,date:e.date,createdAt:e.createdAt,previousDigest:e.previousDigest,payload:payload(e.payload)};
 if(e.digest!==sha(stable(clean)))throw Error('记录校验失败，已停止写入');return clean;
}
function envelope(id,p,previous){if(!UUID.test(id))throw Error('记录编号无效');const e={id,revision:previous?previous.revision+1:1,date:previous?.date??dateAt(),createdAt:previous?.createdAt??new Date().toISOString(),previousDigest:previous?.digest??null,payload:payload(p)};return {...e,digest:sha(stable(e))};}
const attachmentPath=(e,a)=>`00_Inbox/Attachments/DesktopCapture/${e.date}/${a.id}${a.ext}`;
function block(e){validate(e);const p=e.payload,body=p.body.split('\n');let first=body.shift()||p.source||p.thought.split('\n')[0]||p.attachments[0]?.name||'资料';
 // Reserved marker syntax is always literal user text, never an application boundary.
 const safe=t=>t.replace(/<!--\s*desktop-capture/gi,'&lt;!--desktop-capture');
 first=safe(first);
 if(p.type==='diary')first=first.replace(/^(\[[^\]]*\])(?=\s|$)/,'\\$1');
 // Diary is an ordinary Daily entry, not an active task or an inbox capture.
 const projTag=p.project&&!first.includes('#项目/'+p.project)&&!(p.tags||'').includes('#项目/'+p.project)?` #项目/${p.project}`:'';
 let line=(p.type==='diary'?'- ':`- [${TYPES[p.type]}] `)+first+(p.type==='idea'?' '+p.tags:'')+projTag+(p.due?' 📅 '+p.due:'');
 if(['issue','idea','link'].includes(p.type))line+=` <!--apex-${p.type}-created:${e.createdAt}-->`;
 const lines=[`<!-- desktop-capture:${e.id}:${e.revision}:${e.digest} -->`,line];
 const quote=s=>s.split('\n').map(t=>'  > '+safe(t));
 if(body.length)lines.push(...quote(body.join('\n')));
 if(p.source)lines.push('  ',...quote('来源：'+p.source));
 if(p.thought)lines.push('  ',...quote('我的想法：'+p.thought));
 for(const a of p.attachments){const path=attachmentPath(e,a);lines.push('  '+(/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.ext)?'!':'')+`[[${path}|${a.name.replace(/[\[\]|\r\n]/g,' ')}]]`);}
 lines.push(`<!-- /desktop-capture:${e.id} -->`);return lines.join('\n');
}
function transition(content,e,receipt){validate(e);const desired=block(e),prefix=`<!-- desktop-capture:${e.id}:`,end=`<!-- /desktop-capture:${e.id} -->`,start=content.indexOf(prefix),endAt=start>=0?content.indexOf(end,start):-1;
 if(start>=0&&(endAt<0||content.indexOf(prefix,start+prefix.length)>=0||content.indexOf(end,endAt+end.length)>=0))throw Error('原记录边界重复或损坏，已停止写入');
 const existing=start>=0?content.slice(start,endAt+end.length):null;
 if(existing?.replace(/\r\n/g,'\n')===desired)return {content,blockHash:sha(desired),already:true};
 if(receipt&&receipt.revision===e.revision&&receipt.digest===e.digest)return {content,blockHash:receipt.blockHash,already:true};
 if(e.revision===1){if(existing||receipt)throw Error('记录编号已存在，内容不一致');return {content:content.replace(/\s*$/,'')+'\n\n'+desired+'\n',blockHash:sha(desired)};}
 if(!receipt||receipt.revision!==e.revision-1||receipt.digest!==e.previousDigest)throw Error('前一版本尚未写入，或版本已改变');
 if(!existing||sha(existing.replace(/\r\n/g,'\n'))!==receipt.blockHash)throw Error('原笔记中的记录已修改或移除，请打开原笔记处理');
 const output=content.slice(0,start)+desired+content.slice(endAt+end.length);return {content:output,blockHash:sha(desired)};
}
const ATTACHMENT_REF=/00_Inbox\/Attachments\/DesktopCapture\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}/gi;
// Remove one captured block only while it is still byte-identical to the block the bridge wrote.
// A hand-edited block is never deleted silently; a block that is already gone is reported as `missing`.
function removeBlock(content,id,receipt){
 if(!UUID.test(id))throw Error('记录编号无效');
 const prefix=`<!-- desktop-capture:${id}:`,end=`<!-- /desktop-capture:${id} -->`,start=content.indexOf(prefix),endAt=start>=0?content.indexOf(end,start):-1;
 if(start<0)return {content,missing:true,attachments:[]};
 if(endAt<0||content.indexOf(prefix,start+prefix.length)>=0||content.indexOf(end,endAt+end.length)>=0)throw Error('原记录边界重复或损坏，已停止删除');
 const existing=content.slice(start,endAt+end.length);
 if(!receipt||!receipt.blockHash||sha(existing.replace(/\r\n/g,'\n'))!==receipt.blockHash)throw Error('原笔记中的记录已修改或移除，请打开原笔记处理');
 const attachments=[...new Set(existing.match(ATTACHMENT_REF)||[])];
 const left=content.slice(0,start).replace(/(?:[ \t]*\r?\n)+[ \t]*$/,''),right=content.slice(endAt+end.length).replace(/^(?:[ \t]*\r?\n)+/,'');
 const output=right?(left?left+'\n\n'+right:right):(left?left+'\n':'');
 return {content:output,attachments};
}
function inspectBlockContent(content,id,originType){
 const start=content.indexOf(`<!-- desktop-capture:${id}:`);
 if(start<0)return 'missing';
 const end=content.indexOf(`<!-- /desktop-capture:${id} -->`,start);
 if(end<0)return 'unknown';
 const inner=content.slice(content.indexOf('-->',start)+3,end);
 if(!/^\s*[-*+]\s+(?:\[[^\]]*\]\s*)?\S/m.test(inner))return 'missing';
 if(/^\s*[-*+]\s+\[[Xx]\]\s+/m.test(inner))return 'archived';
 if(/<!--apex-(?:idea|link)-status:(?:validated|rejected|archived|done|dropped)-->/.test(inner))return 'archived';
 if(/^\s*(?:[-*+]\s*)?→\s*已入图\b/m.test(inner))return 'archived';
 const hasMarker=/^\s*[-*+]\s+\[[~!?IL]\]\s+/m.test(inner);
 if(!hasMarker&&((originType&&originType!=='diary')||/<!--apex-(?:issue|idea|link)-created:/.test(inner)))return 'archived';
 return 'present';
}
function pipeName(vault){return '\\\\.\\pipe\\obsidian-desktop-capture-'+sha(vault.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()).slice(0,24);}
function constrain(rect,area,defaults){const defW=defaults?.width||440,defH=defaults?.height||590,minW=defaults?.minWidth||320,minH=defaults?.minHeight||300;const width=Math.min(Math.max(minW,rect.width||defW),area.width),height=Math.min(Math.max(minH,rect.height||defH),area.height);return {x:Math.round(Math.max(area.x,Math.min(Number.isFinite(rect.x)?rect.x:area.x+area.width-width-100,area.x+area.width-width))),y:Math.round(Math.max(area.y,Math.min(Number.isFinite(rect.y)?rect.y:area.y+100,area.y+area.height-height))),width:Math.round(width),height:Math.round(height)};}
const garden={light:{surface:'#eeeae0',container:'#e1e6d9',text:'#303d36',muted:'#536157',outline:'#bdc8b6',primary:'#375f50',onPrimary:'#ffffff',tint:'#cdddc5'},dark:{surface:'#12231f',container:'#1b3029',text:'#f2f4e9',muted:'#c6d3c3',outline:'#3b4c42',primary:'#c1d1a2',onPrimary:'#20382b',tint:'#344e3c'}};
const PALETTES={
 'obsidian-indigo':{label:'曜石靛紫',swatch:'#7c6ff6',surface:'#121318',container:'#181a22',text:'#f3f4f6',muted:'#8b92a5',outline:'#272b38',primary:'#7c6ff6',onPrimary:'#ffffff',tint:'#232538',dark:true},
 'warm-paper':{label:'暖宣轻笺',swatch:'#c86d2d',surface:'#faf8f5',container:'#f1eee8',text:'#1c1b18',muted:'#6e6a61',outline:'#e2ddd3',primary:'#c86d2d',onPrimary:'#ffffff',tint:'#efe5dc',dark:false},
 'aurora-teal':{label:'极光雾蓝',swatch:'#2dd4bf',surface:'#0e1724',container:'#152235',text:'#f0f9ff',muted:'#8ea4be',outline:'#233650',primary:'#2dd4bf',onPrimary:'#062026',tint:'#16353d',dark:true},
 'rose-quartz':{label:'晨雾樱灰',swatch:'#b84a76',surface:'#fbf9fa',container:'#f3eef1',text:'#261e22',muted:'#73656c',outline:'#e3d9df',primary:'#b84a76',onPrimary:'#ffffff',tint:'#f0e1e7',dark:false},
 'graphite-gold':{label:'玄墨暗金',swatch:'#d49b38',surface:'#111112',container:'#1a1a1d',text:'#f5f5f4',muted:'#9ca3af',outline:'#2b2b30',primary:'#d49b38',onPrimary:'#171207',tint:'#2d2618',dark:true}
};
const PALETTE_LIST=Object.entries(PALETTES).map(([id,p])=>({id,label:p.label,swatch:p.swatch,dark:p.dark}));
function resolvePalette(id,bridgeTheme){
 if(id==='workbench'&&bridgeTheme)return {...bridgeTheme};
 const base=PALETTES[id]||PALETTES['obsidian-indigo'];
 const {label:_l,swatch:_s,...theme}=base;
 return theme;
}
module.exports={UUID,sha,payload,validate,envelope,block,transition,removeBlock,attachmentPath,inspectBlockContent,pipeName,dateAt,constrain,garden,PALETTES,PALETTE_LIST,resolvePalette};
