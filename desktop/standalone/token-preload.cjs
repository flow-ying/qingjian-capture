'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('tokenPrompt',{submit:value=>ipcRenderer.invoke('desktop-capture:token',value)});
