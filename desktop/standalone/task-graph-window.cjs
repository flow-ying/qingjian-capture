'use strict';
const {BrowserWindow,ipcMain,screen,clipboard}=require('electron');const fs=require('node:fs'),path=require('node:path');
const {GraphClient}=require('./task-graph-client.cjs');const {constrain,PALETTE_LIST}=require('./core.cjs');
const CHANNEL='desktop-task-graph:v1';
function createTaskGraphWindow({vault,root,settings,persistSettings,getTheme,getPalette,setPalette,quotaClient,onQuota,onSwitchCapture,onClosed,reassertOrb,isQuitting}){
 const client=new GraphClient(vault,root);let window=null,queue=Promise.resolve(),boundsTimer,watchTimer,watchers=[];
 function bounds(){const b=settings.taskGraphBounds||{width:840,height:590};return constrain(b,settings.taskGraphBounds?screen.getDisplayMatching(b).workArea:screen.getPrimaryDisplay().workArea,{width:840,height:590,minWidth:360,minHeight:340});}
 async function flush(){if(window&&!window.isDestroyed())await window.webContents.executeJavaScript('window.flushGraphView ? window.flushGraphView() : Promise.resolve()');client.flushSync();}
 async function hide(markLast=true){await flush();if(markLast)onClosed?.('graph');window?.hide();reassertOrb?.();}
 const prefs=()=>({theme:getTheme(),palette:getPalette?.()||'obsidian-indigo',palettes:PALETTE_LIST,pinned:settings.taskGraphPinned!==false});
 ipcMain.handle(CHANNEL,async(event,method,data)=>{
  if(!window||event.sender.id!==window.webContents.id||event.senderFrame!==event.sender.mainFrame)throw Error('无效任务图窗口');
  if(method==='snapshot'){const next=queue.catch(()=>{}).then(()=>client.snapshot(data?.id,data?.force===true));queue=next;return {...await next,...prefs()};}
  if(method==='quota'){const res=quotaClient?await quotaClient.get(data?.force===true):{available:false,status:null,fetchedAt:null,error:''};onQuota?.(res);return res;}
  if(method==='cycle'){const next=queue.catch(()=>{}).then(()=>client.cycle(data));queue=next;return await next;}
  if(method==='view'){client.setView(data?.id,data?.view);return true;}
  if(method==='pin'){if(typeof data!=='boolean')throw Error('置顶值无效');settings.taskGraphPinned=data;window.setAlwaysOnTop(data,'pop-up-menu');persistSettings();reassertOrb?.();return data;}
  if(method==='palette'){setPalette?.(data);return prefs();}
  if(method==='switch-capture'){await hide(false);onSwitchCapture?.();return true;}
  if(method==='close'){await hide(true);return true;}
  if(method==='copy'){const text=typeof data==='string'?data:data?.text,title=typeof data==='object'&&data?data.title:undefined;if(typeof text!=='string'||text.length>1000000||(title!==undefined&&(typeof title!=='string'||title.length>2000)))throw Error('提示词过长');if(title&&title!==text){clipboard.writeText(title);await new Promise(r=>setTimeout(r,180));}clipboard.writeText(text);return true;}
  throw Error('任务图窗口不支持此操作');
 });
 function startLocalWatch(){
  if(watchers.length||typeof vault!=='string')return;
  const tgRoot=path.join(vault,'.obsidian/plugins/personal-workbench/state/task-graphs');
  for(const sub of ['graphs','devices']){
   const target=path.join(tgRoot,sub);
   if(!fs.existsSync(target))continue;
   try{
    const w=fs.watch(target,{recursive:sub==='devices'},()=>{
     clearTimeout(watchTimer);
     watchTimer=setTimeout(()=>{if(!isQuitting()&&window&&!window.isDestroyed()&&window.isVisible())void syncBackground();},180);
    });
    w.on('error',()=>{});
    watchers.push(w);
   }catch{}
  }
 }
 async function open(){
  startLocalWatch();
  if(!window){window=new BrowserWindow({...bounds(),minWidth:360,minHeight:340,show:false,frame:false,title:'清笺 · 任务图',backgroundColor:getTheme().surface,alwaysOnTop:settings.taskGraphPinned!==false,webPreferences:{preload:path.join(__dirname,'graph-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
   window.setMenu(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',e=>e.preventDefault());window.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
   window.on('close',e=>{if(!isQuitting()){e.preventDefault();hide(true).catch(()=>{});}});
   window.on('blur',()=>reassertOrb?.());
   const moved=()=>{clearTimeout(boundsTimer);boundsTimer=setTimeout(()=>{if(!window.isDestroyed()){settings.taskGraphBounds=window.getBounds();persistSettings();}},200);};window.on('move',moved);window.on('resize',moved);
   await window.loadFile(path.join(__dirname,'ui/graph.html'));
  }
  const t=getTheme();if(t?.surface?.startsWith('#'))window.setBackgroundColor(t.surface);
  window.setBounds(bounds());window.show();window.setAlwaysOnTop(settings.taskGraphPinned!==false,'pop-up-menu');window.focus();reassertOrb?.();window.webContents.send(CHANNEL+':refresh',prefs());
 }
 const repair=()=>{if(window&&!window.isDestroyed())window.setBounds(constrain(window.getBounds(),screen.getDisplayMatching(window.getBounds()).workArea,{width:840,height:590,minWidth:360,minHeight:340}));};
 for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,repair);
 const syncBackground=()=>{const next=queue.catch(()=>{}).then(()=>client.snapshot('',true)).catch(()=>{});queue=next;if(window&&!window.isDestroyed()&&window.isVisible())window.webContents.send(CHANNEL+':refresh',prefs());return next;};
 return {open,hide,flush,syncBackground,getWindow:()=>window,client,updateTheme(){if(window&&!window.isDestroyed()){const t=getTheme();if(t?.surface?.startsWith('#'))window.setBackgroundColor(t.surface);window.webContents.send(CHANNEL+':theme',prefs());}},dispose(){clearTimeout(boundsTimer);clearTimeout(watchTimer);for(const w of watchers){try{w.close();}catch{}}watchers=[];ipcMain.removeHandler(CHANNEL);for(const event of ['display-added','display-removed','display-metrics-changed'])screen.off(event,repair);}};
}
module.exports={createTaskGraphWindow};
