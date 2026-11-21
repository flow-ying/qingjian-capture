"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const channel = "apex-desktop-entry:v1";
const allowed = new Set([
  "state",
  "drag-start",
  "drag-move",
  "drag-end",
  "drag-cancel",
  "close-menu",
  "open",
  "hide-orb",
  "hide-main",
  "show-main",
  "collapse-capture",
  "quit",
]);
contextBridge.exposeInMainWorld("entry", {
  send: (action, args) => {
    if (!allowed.has(action)) return Promise.reject(new Error("未知动作"));
    return ipcRenderer.invoke(channel, action, args);
  },
  onState: (listener) => {
    const cb = (_event, state) => listener(state);
    ipcRenderer.on(channel + ":state", cb);
    return () => ipcRenderer.removeListener(channel + ":state", cb);
  },
});
