'use strict';
const {app,BrowserWindow,ipcMain,screen,globalShortcut,Tray,Menu,nativeImage,dialog,shell,clipboard,safeStorage,net:electronNet}=require('electron');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {Store,read,write}=require('./store.cjs');
const {createTaskGraphWindow}=require('./task-graph-window.cjs');
const {createMobileSync}=require('./mobile-sync.cjs');
const {createQuotaClient}=require('./quota-client.cjs');
const {localProjectTags}=require('./task-graph-client.cjs');
const {sha,pipeName,constrain,garden,PALETTES,PALETTE_LIST,resolvePalette,inspectBlockContent}=require('./core.cjs');
const {restorePosition,dockPosition,windowShape,dragResult}=require('../src/geometry.cjs');
const ORB_LEVEL='screen-saver',CAPTURE_DEFAULTS={width:476,height:392,minWidth:360,minHeight:310};
const arg=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const vault=arg('vault'),qa=arg('qa-root');
if(!vault){app.whenReady().then(()=>{dialog.showErrorBox('桌面采集','请使用安装程序创建的桌面快捷方式启动。');app.quit();});}
else{
 const key=sha(vault.replace(/\\/g,'/').replace(/\/$/,'').toLowerCase()).slice(0,24),root=qa?path.resolve(qa):path.join(process.env.LOCALAPPDATA,'ObsidianDesktopCapture',key);
 app.setName('Obsidian 桌面采集');app.setPath('userData',path.join(root,'runtime'));
 if(!app.requestSingleInstanceLock()){app.quit();}else{
 let inMobileCycle=false,store,mobile,quotaClient,lastDigestPending=false,quotaInitTimer=null,quotaBgTimer=null,settings,orb,window,tray,position,taskGraph,drag=null,panelDrag=null,online=false,quitting=false,modal=false,subscription=null,reconnect=null,syncing=false,uiError='',theme;
 const channel='desktop-capture:v2',pending=()=>store.operations.filter(o=>o.status!=='saved'&&!store.isInactive(o.envelope.id));
 function persistSettings(){write(path.join(root,'settings.json'),settings);}
 function activePalette(){return settings.palette&&(PALETTES[settings.palette]||settings.palette==='workbench')?settings.palette:'obsidian-indigo';}
 function refreshTheme(){theme=resolvePalette(activePalette(),settings.bridgeTheme||settings.theme||{...garden.dark,dark:true});}
 function setPalette(id){if(!PALETTES[id]&&id!=='workbench')throw Error('不支持的配色方案');settings.palette=id;refreshTheme();persistSettings();if(window&&!window.isDestroyed()&&theme.surface?.startsWith('#'))window.setBackgroundColor(theme.surface);orbRender();broadcast();}
 function snapshot(){return {online,theme,palette:activePalette(),palettes:PALETTE_LIST,projects:localProjectTags(vault),lastActiveView:settings.lastActiveView||'capture',pinned:settings.pinned===true,shortcut:settings.shortcut??'Control+Shift+Space',shortcutError:uiError,pending:pending().length,records:store.list(),removedIds:Object.keys(store.sourceStates()).filter(id=>store.isInactive(id)),vaultName:path.basename(vault),version:'0.4.3',digestPending:Boolean(quotaClient?.peek()?.status?.digest?.pendingReview),mobileSync:mobile?mobile.status():null};}
 function broadcast(){for(const w of [window,orb])if(w&&!w.isDestroyed())w.webContents.send(channel+':state',snapshot());taskGraph?.updateTheme();}
 function applyBridgeTheme(value){if(!value)return;const keys=['surface','container','text','muted','outline','primary','onPrimary','tint'];if(keys.some(k=>typeof value[k]!=='string'||!/^(#[a-f0-9]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value[k])))return;if(JSON.stringify(settings.bridgeTheme)!==JSON.stringify(value)){settings.bridgeTheme=value;refreshTheme();persistSettings();broadcast();}}
 function request(message){return new Promise((resolve,reject)=>{const socket=net.createConnection(pipeName(vault)),timer=setTimeout(()=>{socket.destroy();reject(Error('Obsidian 响应超时，记录仍保存在本机'));},15000);let data='',settled=false;const fail=e=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}};socket.setEncoding('utf8');socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));socket.on('data',chunk=>{data+=chunk;if(data.length>300000){socket.destroy();fail(Error('响应过大'));return;}if(!data.includes('\n'))return;try{const response=JSON.parse(data.slice(0,data.indexOf('\n')));settled=true;clearTimeout(timer);socket.destroy();response.ok?resolve(response.result):reject(Error(response.error||'写入失败'));}catch(e){fail(e);socket.destroy();}});socket.on('error',fail);socket.on('end',()=>{if(!settled)fail(Error('Obsidian 连接已关闭，稍后会重试'));});});}
 function reconcileLocal(){
  if(online||typeof vault!=='string'||!fs.existsSync(path.join(vault,'.obsidian')))return;
  const ids=[...new Set(store.operations.filter(o=>o.status==='saved').map(o=>o.envelope.id))];
  if(!ids.length)return;
  const fileCache=new Map(),results=[];
  for(const id of ids){
   const op=store.latest(id);if(!op)continue;
   const rel=op.receipt?.path||store.sourceStates()[id]?.path||`00_Inbox/Daily/${op.envelope.date}.md`;
   if(!rel||rel.includes('..')||path.isAbsolute(rel))continue;
   if(!fileCache.has(rel)){
    const abs=path.join(vault,rel);
    try{fileCache.set(rel,fs.existsSync(abs)?fs.readFileSync(abs,'utf8').replace(/\r\n/g,'\n'):null);}catch{fileCache.set(rel,undefined);}
   }
   const content=fileCache.get(rel);
   if(content===undefined)continue;
   const state=content===null?'missing':inspectBlockContent(content,id,op.envelope.payload?.type);
   if(state!=='unknown')results.push({id,state,path:rel,revision:op.envelope.revision});
  }
  if(results.length){store.reconcile(results);broadcast();}
 }
 async function reconcile(){const ids=[...new Set(store.operations.map(o=>o.envelope.id))];for(let i=0;i<ids.length;i+=100){const result=await request({method:'records',ids:ids.slice(i,i+100)});if(Array.isArray(result))store.reconcile(result);}broadcast();}
 async function sync(){if(syncing||quitting)return;if(!online){reconcileLocal();return;}syncing=true;try{await reconcile();const blocked=new Set();for(const op of pending()){if(blocked.has(op.envelope.id))continue;try{const receipt=await request({method:'submit',envelope:op.envelope});store.mark(op,'saved',receipt);}catch(e){store.mark(op,'pending',null,e.message);blocked.add(op.envelope.id);if(!online)break;}broadcast();}}catch(e){uiError=e.message;broadcast();}finally{syncing=false;if(!inMobileCycle&&mobile?.hasWork())mobile.trigger();}}
 function subscribe(){if(quitting)return;subscription=net.createConnection(pipeName(vault));let data='',connected=false;subscription.setEncoding('utf8');subscription.on('connect',()=>subscription.write(JSON.stringify({method:'subscribe'})+'\n'));subscription.on('data',chunk=>{data+=chunk;if(data.length>100000){subscription.destroy();return;}while(data.includes('\n')){const n=data.indexOf('\n'),line=data.slice(0,n);data=data.slice(n+1);try{const event=JSON.parse(line);if(event.event==='records-changed'){void sync();}if(event.event==='theme'){connected=true;online=true;applyBridgeTheme(event.theme);broadcast();void sync();void taskGraph?.syncBackground();mobile?.trigger();}}catch{}}});subscription.on('error',()=>{});subscription.on('close',()=>{online=false;broadcast();if(!quitting){clearTimeout(reconnect);reconnect=setTimeout(subscribe,connected?2000:10000);}});}
 function secure(w){w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());w.webContents.session.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));w.webContents.on('did-finish-load',()=>broadcast());}
 function reassertOrb(){if(orb&&!orb.isDestroyed()&&settings?.visible!==false)orb.setAlwaysOnTop(true,ORB_LEVEL,1);}
 function orbRender(){if(!orb||orb.isDestroyed())return;orb.setBounds({x:position.x,y:position.y,width:56,height:56});orb.setShape(windowShape(position));if(settings.visible!==false)orb.setAlwaysOnTop(true,ORB_LEVEL,1);orb.webContents.send(channel+':orb',{dock:position.dock,theme,palette:activePalette(),digestPending:Boolean(quotaClient?.peek()?.status?.digest?.pendingReview)});}
 function showOrb(){settings.visible=true;orbRender();orb.showInactive();orb.setAlwaysOnTop(true,ORB_LEVEL,1);persistSettings();}
 // Use the event's DIP coordinates: IPC may arrive after a fast physical drag has ended.
 function eventPoint(data){return data&&Number.isFinite(data.x)&&Number.isFinite(data.y)?{x:Math.round(data.x),y:Math.round(data.y)}:screen.getCursorScreenPoint();}
 function movePanel(point){if(!panelDrag)return;window.setBounds(constrain({...panelDrag.bounds,x:panelDrag.bounds.x+point.x-panelDrag.point.x,y:panelDrag.bounds.y+point.y-panelDrag.point.y},screen.getDisplayNearestPoint(point).workArea,CAPTURE_DEFAULTS));}
 function moveOrb(point){if(!drag)return;drag.max=Math.max(drag.max,Math.hypot(point.x-drag.point.x,point.y-drag.point.y));if(drag.max>=7){const display=screen.getDisplayNearestPoint(point);position=restorePosition({x:drag.position.x+point.x-drag.point.x,y:drag.position.y+point.y-drag.point.y,displayId:display.id},[display]);orbRender();}}
 async function flushDraft(){if(window&&!window.isDestroyed())await window.webContents.executeJavaScript('window.captureFlush ? window.captureFlush() : Promise.resolve()');}
 async function collapse(markLast=true){try{await flushDraft();if(markLast){settings.lastActiveView='capture';persistSettings();}window.hide();reassertOrb();}catch(e){dialog.showErrorBox('草稿尚未保存',e.message);}}
 async function open(){
  if(taskGraph?.getWindow()?.isVisible())await taskGraph.hide(false).catch(()=>{});
  settings.lastActiveView='capture';persistSettings();
  const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds=constrain(settings.captureBounds||{},settings.captureBounds?screen.getDisplayMatching(settings.captureBounds).workArea:area,CAPTURE_DEFAULTS);
  if(theme?.surface?.startsWith('#'))window.setBackgroundColor(theme.surface);
  window.setBounds(bounds);window.show();window.setAlwaysOnTop(true,'pop-up-menu');window.focus();reassertOrb();window.webContents.send(channel+':focus');void sync();
 }
 async function openGraph(){
  if(window&&!window.isDestroyed()&&window.isVisible())await collapse(false);
  settings.lastActiveView='graph';persistSettings();
  await taskGraph.open().catch(e=>dialog.showErrorBox('任务图未打开',e.message));
 }
 async function toggleLastActive(){
  if(window&&!window.isDestroyed()&&window.isVisible()){await collapse(true);return;}
  if(taskGraph?.getWindow()&&!taskGraph.getWindow().isDestroyed()&&taskGraph.getWindow().isVisible()){await taskGraph.hide(true);return;}
  if(settings.lastActiveView==='graph')await openGraph();else await open();
 }
 async function openRecordNote(id){
  if(online){try{return await request({method:'open',id});}catch(e){if(!/超时|关闭|ENOENT|ECONNREFUSED/i.test(e.message))throw e;}}
  const op=store.latest(id);
  if(!op)throw Error('未找到该记录');
  if(store.isMissing(id))throw Error('原记录已删除');
  const rel=String(op.receipt?.path||store.sourceStates()[id]?.path||`00_Inbox/Daily/${op.envelope.date}.md`).replace(/\\/g,'/');
  if(!rel||rel.includes('..')||/密码|密钥|凭据|令牌|私密|隐私|\.hc$/i.test(rel))throw Error('记录路径不可安全打开');
  const uri='obsidian://open?vault='+encodeURIComponent(path.basename(vault))+'&file='+encodeURIComponent(rel.replace(/\.md$/i,''));
  if(qa){globalThis.lastOpenedExternalUri=uri;return {opened:true,launchedExternal:true,uri};}
  await shell.openExternal(uri);
  return {opened:true,launchedExternal:true};
 }
 // Cloud token lives only in Windows DPAPI storage (Electron safeStorage, current-user scope); never in settings.json, logs or the Vault.
 const tokenFile=path.join(root,'mobile-sync.token');let tokenCache;
 const mobileSecret={
  get(){if(tokenCache!==undefined)return tokenCache;try{tokenCache=fs.existsSync(tokenFile)&&safeStorage.isEncryptionAvailable()?safeStorage.decryptString(fs.readFileSync(tokenFile)):null;}catch{tokenCache=null;}return tokenCache;},
  set(value){if(!safeStorage.isEncryptionAvailable())throw Error('本机 DPAPI 加密不可用，未保存令牌');fs.mkdirSync(root,{recursive:true});const tmp=tokenFile+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(value));fs.renameSync(tmp,tokenFile);tokenCache=value;},
  clear(){fs.rmSync(tokenFile,{force:true});tokenCache=null;}
 };
 const notifyInfo=(title,message)=>{if(qa)return;void dialog.showMessageBox({type:'info',title,message,buttons:['好']});};
 function mobileLabel(){
  const st=mobile?.status();if(!st)return '移动同步：未启动';
  if(!st.configured)return '移动同步：未配置（右键 → 移动同步 → 输入云端令牌）';
  if(st.paused)return '移动同步：已暂停';
  if(st.authFailed)return '移动同步：令牌无效，请重新导入';
  const when=st.lastOkAt?new Date(st.lastOkAt).toLocaleTimeString('zh-CN',{hour12:false}):'尚未成功';
  return '移动同步：'+(st.lastError?'异常 · '+st.lastError.slice(0,40):'已连接 · '+when)+' · 待落盘 '+st.tracked+' · 待回报 '+st.outbox+' · 项目 '+st.projects;
 }
 async function importMobileToken(){
  const raw=clipboard.readText();
  try{const info=await mobile.setToken(raw);if(clipboard.readText()===raw)clipboard.clear();notifyInfo('移动同步','已验证云端令牌（'+info.role+' 角色）并用 Windows DPAPI 加密保存；剪贴板已清空。正在首次同步。');}
  catch(e){dialog.showErrorBox('云端令牌未保存',e.message);}
}

 let tokenWin=null;
 function promptMobileToken(){
  if(tokenWin&&!tokenWin.isDestroyed()){tokenWin.show();tokenWin.focus();return;}
  tokenWin=new BrowserWindow({width:470,height:250,resizable:false,minimizable:false,maximizable:false,title:'导入云端令牌',autoHideMenuBar:true,backgroundColor:'#121318',webPreferences:{preload:path.join(__dirname,'token-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  tokenWin.setMenu(null);tokenWin.webContents.setWindowOpenHandler(()=>({action:'deny'}));tokenWin.webContents.on('will-navigate',e=>e.preventDefault());tokenWin.webContents.session.setPermissionRequestHandler((_wc,_p,cb)=>cb(false));
  tokenWin.on('closed',()=>{tokenWin=null;});tokenWin.setAlwaysOnTop(true,'pop-up-menu');
  void tokenWin.loadFile(path.join(__dirname,'ui/token.html'));
 }
 function importMobileUrl(){try{const url=mobile.setBaseUrl(clipboard.readText());notifyInfo('移动同步','服务器地址已设为：'+url);}catch(e){dialog.showErrorBox('服务器地址未保存',e.message);}}
 function mobileMenu(){const st=mobile?.status()||{};return [{label:mobileLabel(),enabled:false},{label:'输入云端令牌（desktop）…',click:promptMobileToken},{label:'从剪贴板导入云端令牌（desktop）',click:()=>void importMobileToken()},{label:'立即同步移动队列',enabled:Boolean(st.configured),click:()=>mobile.trigger(true)},{label:'暂停移动同步',type:'checkbox',checked:Boolean(st.paused),enabled:Boolean(st.configured),click:item=>mobile.setPaused(item.checked)},{label:'从剪贴板设置服务器地址',click:importMobileUrl},{label:'清除云端令牌',enabled:Boolean(st.configured),click:()=>{mobile.clearToken();notifyInfo('移动同步','云端令牌已清除，移动同步已静默关闭。');}}];}
 function contextMenu(){
  const cur=activePalette();
  const paletteItems=[...PALETTE_LIST.map(p=>({label:p.label,type:'radio',checked:cur===p.id,click:()=>setPalette(p.id)})),{type:'separator'},{label:'跟随工作台配色',type:'radio',checked:cur==='workbench',click:()=>setPalette('workbench')}];
  return Menu.buildFromTemplate([{label:'打开速记窗',click:()=>void open()},{label:'打开任务图',click:()=>void openGraph()},{label:'配色主题',submenu:paletteItems},{type:'separator'},{label:settings.visible?'隐藏悬浮球':'显示悬浮球',click:()=>{if(settings.visible){settings.visible=false;orb.hide();persistSettings();}else showOrb();}},{type:'separator'},{label:'立即重试写入 Obsidian',click:()=>void sync()},{label:'移动同步',submenu:mobileMenu()},{label:'打开本机采集数据目录',click:()=>void shell.openPath(root)},{label:'退出桌面采集',click:()=>void quit()}]);
 }
 async function quit(){if(quitting)return;try{await flushDraft();await taskGraph?.flush();quitting=true;app.quit();}catch(e){dialog.showErrorBox('本机状态尚未保存',e.message);}}
 // Local PNG tray icon; no external resources or image loading.
 function trayImage(){const w=32,h=32,bytes=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*(w*4+1)+1+x*4,inside=(x-15.5)**2+(y-15.5)**2<210,mark=(Math.abs(x-15.5)<1.8&&y>8&&y<23)||(Math.abs(y-15.5)<1.8&&x>8&&x<23);bytes[i]=mark?243:28;bytes[i+1]=mark?244:30;bytes[i+2]=mark?255:44;bytes[i+3]=inside?255:0;}const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};const chunk=(type,data)=>{const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum]);};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;return nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]));}
 app.whenReady().then(async()=>{
  store=new Store(root);mobile=createMobileSync({root,store,fetch:(url,init)=>electronNet.fetch(url,init),bridge:{request},syncLocal:async()=>{inMobileCycle=true;try{await sync();}finally{inMobileCycle=false;}},isOnline:()=>online,projects:()=>localProjectTags(vault),secret:mobileSecret,onChange:()=>{broadcast();}});quotaClient=createQuotaClient({vault});settings=read(path.join(root,'settings.json'),{});if(!settings.palette)settings.palette='obsidian-indigo';refreshTheme();position=restorePosition(settings.orb,screen.getAllDisplays());
  const syncDigestBadge=()=>{const next=Boolean(quotaClient?.peek()?.status?.digest?.pendingReview);if(next!==lastDigestPending){lastDigestPending=next;orbRender();broadcast();}};
  taskGraph=createTaskGraphWindow({vault,root,settings,persistSettings,getTheme:()=>theme,getPalette:activePalette,setPalette,quotaClient,onQuota:syncDigestBadge,onSwitchCapture:()=>void open(),onClosed:mode=>{settings.lastActiveView=mode;persistSettings();},reassertOrb,isQuitting:()=>quitting});
  const prefs={preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true};
  window=new BrowserWindow({...constrain(settings.captureBounds||{},screen.getPrimaryDisplay().workArea,CAPTURE_DEFAULTS),show:false,frame:false,alwaysOnTop:true,skipTaskbar:false,title:'Obsidian 桌面采集',backgroundColor:theme.surface.startsWith('#')?theme.surface:'#121318',minWidth:CAPTURE_DEFAULTS.minWidth,minHeight:CAPTURE_DEFAULTS.minHeight,webPreferences:prefs});
  orb=new BrowserWindow({x:position.x,y:position.y,width:56,height:56,minWidth:1,minHeight:1,show:false,frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,minimizable:false,fullscreenable:false,alwaysOnTop:true,skipTaskbar:true,focusable:false,hasShadow:false,title:'采集悬浮球',webPreferences:prefs});orb.setMenu(null);orb.setAlwaysOnTop(true,ORB_LEVEL,1);
  secure(window);secure(orb);
  window.webContents.on('context-menu',(_event,params)=>{
   if(!params.isEditable&&!params.selectionText)return;
   const flags=params.editFlags,items=[];
   if(params.isEditable)items.push({label:'撤销',role:'undo',enabled:flags.canUndo},{label:'重做',role:'redo',enabled:flags.canRedo},{type:'separator'},{label:'剪切',role:'cut',enabled:flags.canCut});
   items.push({label:'复制',role:'copy',enabled:flags.canCopy});
   if(params.isEditable)items.push({label:'粘贴',role:'paste',enabled:flags.canPaste});
   items.push({type:'separator'},{label:'全选',role:'selectAll',enabled:flags.canSelectAll});
   Menu.buildFromTemplate(items).popup({window});
  });
  window.on('close',e=>{if(!quitting){e.preventDefault();void collapse(true);}});// Capture is an independent window; switching apps never collapses it.
  window.on('blur',reassertOrb);
  let moveTimer;const moved=()=>{clearTimeout(moveTimer);moveTimer=setTimeout(()=>{if(window.isDestroyed())return;settings.captureBounds=window.getBounds();persistSettings();},250);};window.on('move',moved);window.on('resize',moved);
  const repair=()=>{position=restorePosition(position,screen.getAllDisplays());settings.orb=position;orbRender();if(window.isVisible())window.setBounds(constrain(window.getBounds(),screen.getDisplayMatching(window.getBounds()).workArea,CAPTURE_DEFAULTS));persistSettings();};for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,repair);
  ipcMain.handle('desktop-capture:token',async(event,value)=>{
   if(!tokenWin||tokenWin.isDestroyed()||event.sender.id!==tokenWin.webContents.id||event.senderFrame!==event.sender.mainFrame)throw Error('无效窗口来源');
   try{const info=await mobile.setToken(value);setTimeout(()=>{if(tokenWin&&!tokenWin.isDestroyed())tokenWin.close();notifyInfo('移动同步','已验证云端令牌（'+info.role+' 角色）并用 Windows DPAPI 加密保存，正在首次同步。');},600);return {ok:true};}
   catch(e){return {ok:false,error:e.message};}
  });
  ipcMain.handle(channel,async(event,method,data)=>{
   if(![window.webContents.id,orb.webContents.id].includes(event.sender.id)||event.senderFrame!==event.sender.mainFrame)throw Error('无效窗口来源');
   const fromOrb=event.sender.id===orb.webContents.id;
   if(fromOrb&&!['state','orb-down','orb-move','orb-up','orb-cancel','menu','open','toggle'].includes(method))throw Error('入口不能直接写入');
   if(method==='state'){const drafts=fromOrb?null:store.drafts();return {...snapshot(),drafts,draft:drafts?(drafts.items.find(d=>d.id===drafts.activeId)||drafts.items[0]):null};}
   if(method==='open'){await open();return true;}
   if(method==='toggle'){await toggleLastActive();return true;}
   if(method==='switch-graph'){await openGraph();return true;}
   if(method==='palette'){setPalette(data);return snapshot();}
   if(method==='collapse'){await collapse(true);return true;}
   if(method==='pin'){settings.pinned=Boolean(data);persistSettings();broadcast();return true;}
   if(method==='panel-down'){panelDrag={point:eventPoint(data),bounds:window.getBounds()};return true;}
   if(method==='panel-move'){movePanel(eventPoint(data));return true;}
   if(method==='panel-up'){movePanel(eventPoint(data));panelDrag=null;settings.captureBounds=window.getBounds();persistSettings();return true;}
   if(method==='panel-cancel'){if(panelDrag)window.setBounds(panelDrag.bounds);panelDrag=null;return true;}
   if(method==='drafts'){return store.drafts(data);}
   if(method==='draft'){store.draft(data);return true;}
   if(method==='copy-text'){if(typeof data!=='string'||data.length>200000)throw Error('复制内容无效');clipboard.writeText(data);return true;}
   if(method==='save'){if(online&&data?.expectedRevision>0){const results=await request({method:'records',ids:[data.id]});if(Array.isArray(results))store.reconcile(results);}const op=store.save(data);store.draft(null);broadcast();void sync();return {id:op.envelope.id,revision:op.envelope.revision,status:op.status,drafts:store.drafts()};}
   if(method==='open-record')return openRecordNote(data);
   if(method==='retry'){void sync();return true;}
   if(method==='attachment-bytes')return store.importBytes(data.name,data.bytes);
   if(method==='pick-files'){modal=true;try{const result=await dialog.showOpenDialog(window,{title:'添加资料附件',properties:['openFile','multiSelections'],filters:[{name:'资料文件',extensions:['png','jpg','jpeg','gif','webp','bmp','pdf','txt','md','csv','docx','pptx','xlsx']}]});if(result.canceled)return [];return result.filePaths.map(file=>{if(/密码|密钥|凭据|令牌|私密|隐私|(?:^|[\\/_ .-])(private|secret|credentials?|passwords?|tokens?|cookies?|oauth|api[_ -]?keys?)(?:$|[\\/_ .-])/i.test(file))throw Error('路径可能包含敏感内容，未读取');const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>25*1024*1024)throw Error('附件无效或大于 25 MB');return store.importBytes(path.basename(file),fs.readFileSync(file));});}finally{modal=false;}}
   if(method==='attachment-preview'){if(!data||!/^\.[a-z0-9]{1,8}$/.test(data.ext)||! /^[a-f0-9-]{36}$/.test(data.id)||!['.png','.jpg','.jpeg','.gif','.webp','.bmp'].includes(data.ext))return null;const local=path.join(root,'attachments',data.id+data.ext);if(fs.statSync(local).size>25*1024*1024)return null;return 'data:image/'+(data.ext==='.jpg'?'jpeg':data.ext.slice(1))+';base64,'+fs.readFileSync(local).toString('base64');}
   if(method==='menu'){modal=true;contextMenu().popup({window:fromOrb?orb:window,callback:()=>{modal=false;reassertOrb();}});return true;}
   if(method==='orb-down'){drag={point:eventPoint(data),position:{...position},max:0};return true;}
   if(method==='orb-move'){moveOrb(eventPoint(data));return true;}
   if(method==='orb-up'&&drag){const point=eventPoint(data);moveOrb(point);const click=dragResult(drag.point,point,drag.max).click;drag=null;if(click)await toggleLastActive();else{position=dockPosition(position,screen.getDisplayNearestPoint({x:position.x+28,y:position.y+28}));settings.orb=position;orbRender();persistSettings();}return true;}
   if(method==='orb-cancel'){if(drag)position=drag.position;drag=null;orbRender();return true;}
   throw Error('未知操作');
  });
  await Promise.all([window.loadFile(path.join(__dirname,'ui/capture.html')),orb.loadFile(path.join(__dirname,'ui/orb.html'))]);
  const accelerator=settings.shortcut??'Control+Shift+Space';if(accelerator&&!globalShortcut.register(accelerator,()=>void open()))uiError='Ctrl+Shift+Space 已被占用；请点击悬浮球或托盘使用';
  tray=new Tray(trayImage());tray.setToolTip('Obsidian 桌面采集 · 清笺');tray.on('click',()=>void toggleLastActive());tray.on('right-click',()=>tray.popUpContextMenu(contextMenu()));
  reconcileLocal();
  if(settings.visible!==false)showOrb();subscribe();mobile.start();void taskGraph?.syncBackground();const retry=setInterval(()=>{reassertOrb();void sync();if(online)void taskGraph?.syncBackground();},30000);retry.unref();
  const refreshQuotaBg=()=>quotaClient.get(true).then(()=>syncDigestBadge()).catch(()=>{});
  if(!qa||process.env.QUOTA_TRACKER_FIXTURE){quotaInitTimer=setTimeout(refreshQuotaBg,qa?200:4000);quotaInitTimer.unref();quotaBgTimer=setInterval(refreshQuotaBg,600000);quotaBgTimer.unref();}
  app.on('second-instance',(_event,argv)=>argv.includes('--quit-existing')?void quit():argv.includes('--open-task-graph')?void openGraph():void toggleLastActive());app.on('activate',()=>void toggleLastActive());broadcast();
  if(process.argv.includes('--open-task-graph'))void openGraph();
  if(qa){globalThis.captureQA={store,mobile,quotaClient,promptMobileToken,root,getWindow:()=>window,getOrb:()=>orb,open,openGraph,toggleLastActive,setPalette,sync,quit,snapshot,position:()=>position,taskGraph};}
 }).catch(e=>{dialog.showErrorBox('桌面采集未启动',e.message);quitting=true;app.quit();});
 app.on('window-all-closed',()=>{});app.on('before-quit',e=>{if(!quitting){e.preventDefault();void quit();return;}clearTimeout(reconnect);clearTimeout(quotaInitTimer);clearInterval(quotaBgTimer);mobile?.stop();subscription?.destroy();taskGraph?.dispose();globalShortcut.unregister(settings?.shortcut??'Control+Shift+Space');tray?.destroy();});
 }
}
