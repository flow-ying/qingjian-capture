// JS <-> Kotlin bridge over an origin-restricted WebMessageListener channel: native injects `QJNative`
// only for https://appassets.androidplatform.net (the bundled assets). Requests: postMessage({id,method,arg});
// replies arrive as {t:"r",id,ok,v}; native -> JS events as {t:"e",n,v}.
// Outside the APK (desktop browser preview) a small in-memory mock keeps the UI fully clickable.
const pending=new Map(),listeners=new Map();let seq=0;
function fire(name,value){for(const fn of listeners.get(name)||[])try{fn(value);}catch(e){console.error(e);}}
// window.__qj.emit stays available so the browser preview / tests can simulate native events.
window.__qj={emit(name,json){let v=null;try{v=json?JSON.parse(json):null;}catch{}fire(name,v);}};
const native=globalThis.QJNative;
export const isNative=Boolean(native);
if(native){
 document.documentElement.dataset.native='1';
 native.onmessage=ev=>{
  let m;try{m=JSON.parse(ev.data);}catch{return;}
  if(m.t==='r'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.resolve(m.v):p.reject(Error(m.v?.message||'操作失败'));}
  else if(m.t==='e')fire(m.n,m.v);
 };
}
export const capture={
 call(method,arg=null){
  if(!native)return mock(method,arg);
  const id=++seq;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});try{native.postMessage(JSON.stringify({id,method,arg}));}catch(e){pending.delete(id);reject(e);}});
 },
 on(name,fn){if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);}
};

// ---------------------------------------------------------------- browser preview mock
const mockState={records:[],online:true,pending:0,palette:'obsidian-indigo',pinned:false,projects:['工作台','灵感','阅读'],
 settings:{configured:true,tokenLength:48,serverUrl:'https://relay.example.com/mobile-capture/v1',deviceId:'my-phone',clipboardHint:true,edgeBar:false,overlayGranted:false,version:'preview'},drafts:null};
function emitState(){fire('state',structuredClone(mockState));}
function seedMock(){
 if(mockState.records.length)return;
 const now=new Date().toISOString(),d=now.slice(0,10),h='0'.repeat(64);
 const mk=(type,body,status,extra={})=>({id:crypto.randomUUID(),date:d,createdAt:now,revision:1,digest:h,status,error:'',updatedAt:now,payload:{type,body,source:'',thought:'',due:'',tags:'',attachments:[],...extra}});
 mockState.records=[mk('idea','Obsidian 手机端也许可以只做采集，整理统一回电脑','landed',{tags:'#工作流 #移动端'}),mk('link','这可能是最好的Rust入门教程','queued',{source:'https://b23.tv/AbC12xY'}),mk('task','周五前交实验报告','local',{due:d,project:'阅读'}),mk('note','LiveSync 冲突那段改过了','conflict')];
 mockState.records[3].error='原笔记中的记录已修改或移除，请打开原笔记处理';
}
async function mock(method,arg){
 seedMock();
 switch(method){
  case 'state':return structuredClone(mockState);
  case 'drafts':mockState.drafts=arg;return {ok:true};
  case 'save':{const e=arg.envelope;const r={id:e.id,date:e.date,createdAt:e.createdAt,revision:e.revision,digest:e.digest,payload:e.payload,status:'local',error:'',updatedAt:new Date().toISOString()};
   mockState.records=[r,...mockState.records.filter(x=>x.id!==e.id)];mockState.pending++;emitState();
   setTimeout(()=>{r.status='queued';mockState.pending=Math.max(0,mockState.pending-1);emitState();},900);
   setTimeout(()=>{r.status='landed';emitState();},2600);return {ok:true};}
  case 'delete-record':{const r=mockState.records.find(x=>x.id===arg);if(r){r.status='deleting';emitState();setTimeout(()=>{mockState.records=mockState.records.filter(x=>x.id!==arg);emitState();},1500);}return {ok:true};}
  case 'forget-record':mockState.records=mockState.records.filter(x=>x.id!==arg);emitState();return {ok:true};
  case 'palette':mockState.palette=arg;emitState();return {ok:true};
  case 'pin':mockState.pinned=Boolean(arg);emitState();return {ok:true};
  case 'settings-save':Object.assign(mockState.settings,arg,{configured:true});delete mockState.settings.token;emitState();return {ok:true};
  case 'test-connection':return {ok:true,protocol:1,role:'device',message:'预览模式：未真正联网'};
  case 'pick-images':return [];
  case 'attachment-preview':return null;
  case 'copy-text':await navigator.clipboard?.writeText(arg).catch(()=>{});return {ok:true};
  case 'collapse':document.body.classList.toggle('preview-collapsed');setTimeout(()=>document.body.classList.remove('preview-collapsed'),700);return {ok:true};
  case 'retry':return {ok:true};
  default:return {ok:true};
 }
}
