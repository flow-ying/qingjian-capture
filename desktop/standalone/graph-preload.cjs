'use strict';
const {contextBridge,ipcRenderer}=require('electron');const channel='desktop-task-graph:v1',allowed=new Set(['snapshot','quota','view','pin','close','copy','cycle','switch-capture','palette','panel-down','panel-move','panel-up','panel-cancel']);
contextBridge.exposeInMainWorld('taskGraph',{call:(name,args)=>{if(!allowed.has(name))return Promise.reject(Error('未知操作'));return ipcRenderer.invoke(channel,name,args);},onRefresh:fn=>ipcRenderer.on(channel+':refresh',(_e,data)=>fn(data)),onTheme:fn=>ipcRenderer.on(channel+':theme',(_e,data)=>fn(data))});
