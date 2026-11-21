'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const channel='desktop-capture:v2';
contextBridge.exposeInMainWorld('capture',{call:(method,data)=>ipcRenderer.invoke(channel,method,data),onState:fn=>{ipcRenderer.on(channel+':state',(_e,value)=>fn(value));},onOrb:fn=>{ipcRenderer.on(channel+':orb',(_e,value)=>fn(value));},onFocus:fn=>{ipcRenderer.on(channel+':focus',()=>fn());}});
