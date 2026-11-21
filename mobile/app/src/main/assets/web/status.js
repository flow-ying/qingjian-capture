// Record status → status dot mapping (protocol v1 §4.3). Native reports the state of the newest
// upsert operation of each record (`local|sending|queued|pulled|landed|conflict|failed|rejected|expired`)
// plus `deleting` while a delete operation awaits the desktop.
export const STATUS={
 local:{dot:'⚪',label:'待上传',tone:'idle'},
 sending:{dot:'⚪',label:'待上传',tone:'idle'},
 queued:{dot:'🟡',label:'已上云',tone:'cloud'},
 pulled:{dot:'🟡',label:'电脑已取走',tone:'cloud'},
 landed:{dot:'🟢',label:'已落盘',tone:'done'},
 deleting:{dot:'🟡',label:'删除待电脑确认',tone:'cloud'},
 conflict:{dot:'🟠',label:'冲突需核对',tone:'warn'},
 failed:{dot:'🟠',label:'电脑拒收',tone:'warn'},
 rejected:{dot:'🟠',label:'云端拒收',tone:'warn'},
 expired:{dot:'🟠',label:'超时未落盘',tone:'warn'}
};
const WARN=new Set(['conflict','failed','rejected','expired']);
export function describe(record){
 const s=STATUS[record?.status]||STATUS.local;
 const warn=WARN.has(record?.status);
 return {
  ...s,
  warn,
  // A record in a terminal-warning state cannot be chained (desktop would reject the next revision too):
  // offer “另存为新记录” instead of editing in place.
  canEdit:!warn&&record?.status!=='deleting',
  canDelete:!warn&&record?.status!=='deleting',
  canSaveAsNew:warn,
  canForget:warn
 };
}
export function syncSummary(state){
 if(!state?.settings?.configured)return {online:false,text:'未配对',title:'点 ⋯ 打开设置，填入服务器地址与设备 Token'};
 if(state.authError)return {online:false,text:'Token 无效',title:state.authError};
 const pending=state.pending||0;
 if(!state.online)return {online:false,text:pending?pending+' 待传':'离线',title:'已保存到本机，联网后自动上传'};
 return {online:true,text:pending?pending+' 待传':'已连',title:'已连接云端中转；点击立即同步'};
}
