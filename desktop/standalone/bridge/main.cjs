'use strict';
const {Plugin,Notice,MarkdownView}=require('obsidian');
const net=require('node:net'),fs=require('node:fs'),path=require('node:path');
const {inspectRecords}=require('./history.cjs');
const {UUID,validate,transition,removeBlock,attachmentPath,sha,pipeName}=require('../core.cjs');
module.exports=class DesktopCaptureBridge extends Plugin{
 async onload(){
  if(process.platform!=='win32')return;
  this.closed=false;this.tail=Promise.resolve();this.clients=new Set();this.subscribers=new Set();this.receipts=(await this.loadData())?.receipts??{};
  const vault=this.app.vault.adapter.getBasePath();this.localRoot=path.join(process.env.LOCALAPPDATA,'ObsidianDesktopCapture',sha(vault.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()).slice(0,24));
  this.server=net.createServer(socket=>{this.clients.add(socket);let input='';socket.setEncoding('utf8');socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>{this.clients.delete(socket);this.subscribers.delete(socket);});socket.on('data',chunk=>{input+=chunk;if(Buffer.byteLength(input)>250000){socket.destroy();return;}const end=input.indexOf('\n');if(end<0)return;const raw=input.slice(0,end);input='';this.tail=this.tail.catch(()=>{}).then(async()=>{try{const request=JSON.parse(raw);if(request.method==='subscribe'){socket.setTimeout(0);this.subscribers.add(socket);socket.write(JSON.stringify({event:'theme',theme:this.theme()})+'\n');return;}let result;if(request.method==='status')result={version:this.manifest.version,theme:this.theme(),vaultName:this.app.vault.getName(),capabilities:['submit','delete']};else if(request.method==='records')result=await inspectRecords(this.app,this.receipts,request.ids);else if(request.method==='submit')result=await this.submit(request.envelope);else if(request.method==='delete')result=await this.remove(request);else if(request.method==='open')result=await this.openRecord(request.id);else throw Error('未知操作');socket.end(JSON.stringify({ok:true,result})+'\n');}catch(e){socket.end(JSON.stringify({ok:false,error:e.message})+'\n');}});});});
  this.server.on('error',e=>new Notice('桌面采集连接未启动：'+e.message));this.server.listen(pipeName(vault));
  this.addCommand({id:'status',name:'查看桌面采集连接',callback:()=>new Notice(this.server?.listening?'桌面采集连接已就绪':'桌面采集连接未启动')});
  const changed=()=>{clearTimeout(this.recordsTimer);this.recordsTimer=setTimeout(()=>{for(const socket of this.subscribers)socket.write(JSON.stringify({event:'records-changed'})+'\n');},250);};
  for(const name of ['modify','delete','create'])this.registerEvent(this.app.vault.on(name,file=>{if(Object.values(this.receipts).some(r=>r.path===file.path))changed();}));
  this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{this.tail=this.tail.catch(()=>{}).then(async()=>{const next={...this.receipts};let moved=false;for(const[id,r]of Object.entries(next)){if(r.path===oldPath||r.path.startsWith(oldPath+'/')){next[id]={...r,path:file.path+r.path.slice(oldPath.length)};moved=true;}}if(moved){await this.saveData({receipts:next});this.receipts=next;changed();}});}));
  this.themeObserver=new MutationObserver(()=>this.publishTheme());this.watchTheme();this.registerEvent(this.app.workspace.on('layout-change',()=>this.watchTheme()));this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.watchTheme()));
 }
 watchTheme(){this.themeObserver.disconnect();this.themeObserver.observe(document.body,{attributes:true,attributeFilter:['class','style']});for(const pane of document.querySelectorAll('.pw-frame')){for(let el=pane;el&&el!==document.body;el=el.parentElement)this.themeObserver.observe(el,{attributes:true,attributeFilter:['style','class','data-theme','data-palette']});}this.publishTheme();}
 publishTheme(){clearTimeout(this.themeTimer);this.themeTimer=setTimeout(()=>{const theme=this.theme(),value=JSON.stringify(theme);if(value===this.lastTheme)return;this.lastTheme=value;for(const socket of this.subscribers)socket.write(JSON.stringify({event:'theme',theme})+'\n');},100);}
 theme(){const panes=[...document.querySelectorAll('.pw-frame')];const pane=panes.find(p=>p.getBoundingClientRect().width>0)??panes[0];if(!pane)return null;const c=getComputedStyle(pane),mapping={surface:'surface',container:'surface-container',text:'text',muted:'muted',outline:'outline',primary:'primary',onPrimary:'on-primary',tint:'primary-container'},theme={};for(const [key,token]of Object.entries(mapping)){const raw=c.getPropertyValue('--pw-'+token).trim();if(!raw)return null;const probe=document.createElement('span');probe.style.color='var(--pw-'+token+')';pane.appendChild(probe);theme[key]=getComputedStyle(probe).color;probe.remove();}theme.dark=(theme.surface.match(/[\d.]+/g)||[]).slice(0,3).reduce((n,v)=>n+Number(v),0)<380;return theme;}
 async folders(folder){let current='';for(const part of folder.split('/')){current=current?current+'/'+part:part;if(!this.app.vault.getAbstractFileByPath(current)&&!(await this.app.vault.adapter.exists(current)))try{await this.app.vault.createFolder(current);}catch(e){if(!(await this.app.vault.adapter.exists(current)))throw e;}}}
 async submit(e){if(this.closed)throw Error('连接已关闭');validate(e);const prior=this.receipts[e.id],target=prior?.path??`00_Inbox/Daily/${e.date}.md`;
  if(prior?.revision===e.revision&&prior.digest===e.digest)return {...prior,id:e.id};
  if(prior&&prior.revision>=e.revision)throw Error('记录版本已改变');
  if(e.revision>1&&(!prior||prior.digest!==e.previousDigest||prior.revision!==e.revision-1))throw Error('前一版本尚未确认，请先同步前一版本');
  const vault=this.app.vault;let file=vault.getAbstractFileByPath(target);
  const assertEditors=current=>this.assertClean(target,current);
  if(file)assertEditors(await vault.read(file));
  for(const a of e.payload.attachments){const local=path.join(this.localRoot,'attachments',a.id+a.ext);const stats=fs.lstatSync(local);if(!stats.isFile()||stats.isSymbolicLink()||stats.size!==a.size)throw Error('附件不可用');const bytes=fs.readFileSync(local);if(sha(bytes)!==a.hash)throw Error('附件校验失败');const dest=attachmentPath(e,a);await this.folders(path.posix.dirname(dest));if(await vault.adapter.exists(dest)){if(sha(Buffer.from(await vault.adapter.readBinary(dest)))!==a.hash)throw Error('目标附件已改变，未覆盖');}else await vault.createBinary(dest,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
  let result;await this.folders('00_Inbox/Daily');
  if(!file){const initial=`---\ndate: ${e.date}\n---\n`;result=transition(initial,e,prior);try{file=await vault.create(target,result.content);}catch(error){file=vault.getAbstractFileByPath(target);if(!file)throw error;await vault.process(file,current=>{assertEditors(current);result=transition(current,e,prior);return result.content;});}}
  else await vault.process(file,current=>{assertEditors(current);result=transition(current,e,prior);return result.content;});
  const receipt={revision:e.revision,digest:e.digest,blockHash:result.blockHash,path:target,type:e.payload.type};const next={...this.receipts,[e.id]:receipt};await this.saveData({receipts:next});this.receipts=next;return {...receipt,id:e.id};
 }
 assertClean(target,current){for(const leaf of this.app.workspace.getLeavesOfType('markdown'))if(leaf.view instanceof MarkdownView&&leaf.view.file?.path===target&&leaf.view.editor?.getValue().replace(/\r\n/g,'\n')!==current.replace(/\r\n/g,'\n'))throw Error('Daily 有正在保存的编辑，保留本机记录并稍后重试');}
 // An attachment may only go to .trash when no other note still links to it (unknown link graph => keep it).
 attachmentStillLinked(attachment,sourcePath,sourceContent){if(sourceContent.includes(attachment))return true;const links=this.app.metadataCache?.resolvedLinks;if(!links)return true;for(const[src,targets]of Object.entries(links))if(src!==sourcePath&&targets&&targets[attachment]>0)return true;return false;}
 async remove(request){
  if(this.closed)throw Error('连接已关闭');
  const id=request?.id;
  if(typeof id!=='string'||!UUID.test(id)||!Number.isInteger(request.revision)||typeof request.digest!=='string')throw Error('删除请求无效');
  const prior=this.receipts[id];
  if(!prior)throw Error('记录尚未写入 Obsidian，无法安全删除');
  if(prior.deleted)return {deleted:true,already:true,path:prior.path,trashed:[],id};
  if(prior.revision!==request.revision||prior.digest!==request.digest)throw Error('记录版本已改变，请先同步最新版本');
  const vault=this.app.vault,file=vault.getAbstractFileByPath(prior.path);let result={missing:true,attachments:[]};
  if(file){
   this.assertClean(prior.path,await vault.read(file));
   await vault.process(file,current=>{this.assertClean(prior.path,current);result=removeBlock(current,id,prior);return result.content;});
  }
  const trashed=[];
  if(file&&!result.missing){const now=await vault.read(file);for(const attachment of result.attachments){const target=vault.getAbstractFileByPath(attachment);if(target&&!this.attachmentStillLinked(attachment,file.path,now)){await vault.trash(target,false);trashed.push(attachment);}}}
  const next={...this.receipts,[id]:{...prior,deleted:true,deletedAt:new Date().toISOString()}};await this.saveData({receipts:next});this.receipts=next;
  return {deleted:true,already:Boolean(result.missing),path:prior.path,trashed,id};
 }
 async openRecord(id){const receipt=this.receipts[id];if(!receipt)throw Error('记录尚未写入');if((await inspectRecords(this.app,this.receipts,[id]))[0].state==='missing')throw Error('原记录已删除');await this.app.workspace.openLinkText(receipt.path,'',true);try{const win=require('electron').remote?.getCurrentWindow?.();if(win){if(win.isMinimized())win.restore();win.show();win.focus();}}catch{}return {opened:true};}
 onunload(){this.closed=true;clearTimeout(this.themeTimer);clearTimeout(this.recordsTimer);this.themeObserver?.disconnect();for(const socket of this.clients??[])socket.destroy();this.server?.close();}
};
