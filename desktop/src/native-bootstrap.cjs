"use strict";
// This entire module executes in Electron MAIN, including synchronous close events.
const electron = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createDesktopEntry } = require("./desktop-entry.cjs");
function createHostedEntry({ ownerId, assets, settingsPath, hotkeys = {} }) {
  const owner = electron.BrowserWindow.fromId(ownerId);
  if (!owner || owner.isDestroyed()) throw new Error("Obsidian 主窗口已不可用");
  // BrowserWindow.webContents is a native getter and throws after 'closed'.
  const ownerContents = owner.webContents;
  const channel = "apex-desktop-entry:host:" + randomUUID();
  const pending = new Map();
  let disposed = false;
  function request(action, type) {
    if (disposed || owner.isDestroyed())
      return Promise.reject(new Error("宿主已关闭"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("采集模块未及时响应；请检查其启用状态"));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      ownerContents.send("apex-desktop-entry:request", {
        channel,
        id,
        action,
        type,
      });
    });
  }
  const reply = (event, result) => {
    if (
      disposed ||
      event.sender.id !== ownerContents.id ||
      event.senderFrame !== ownerContents.mainFrame ||
      !result ||
      typeof result.id !== "string"
    )
      return;
    const waiting = pending.get(result.id);
    if (!waiting) return;
    pending.delete(result.id);
    clearTimeout(waiting.timer);
    if (result.ok === true) waiting.resolve();
    else
      waiting.reject(
        new Error(
          typeof result.message === "string" ? result.message : "采集接口失败",
        ),
      );
  };
  electron.ipcMain.on(channel, reply);
  const store = {
    load() {
      try {
        return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return {};
        throw new Error("入口设置损坏，请恢复本模块设置备份");
      }
    },
    save(value) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const temp = settingsPath + ".tmp";
      fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
      fs.renameSync(temp, settingsPath);
    },
  };
  let entry;
  function dispose() {
    if (disposed) return;
    disposed = true;
    entry?.dispose();
    electron.ipcMain.removeListener(channel, reply);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("桌面入口已停用"));
    }
    pending.clear();
    owner.removeListener("closed", dispose);
    ownerContents.removeListener("render-process-gone", dispose);
    electron.app.removeListener("will-quit", dispose);
  }
  try {
    entry = createDesktopEntry({
      electron,
      assets,
      store,
      hotkeys: () => hotkeys,
      mainWindow: owner,
      capture: {
        open: ({ type }) => request("open", type),
        collapse: () => request("collapse"),
      },
    });
  } catch (e) {
    dispose();
    throw e;
  }
  owner.on("closed", dispose);
  ownerContents.on("render-process-gone", dispose);
  electron.app.on("will-quit", dispose);
  return {
    async start() {
      try {
        return await entry.start();
      } catch (e) {
        dispose();
        throw e;
      }
    },
    showOrb: () => entry.showOrb(),
    hideOrb: () => entry.hideOrb(),
    openMenu: () => entry.openMenu(true),
    openCapture: (type) => entry.openCapture(type),
    collapseCapture: () => entry.collapseCapture(),
    showMain: () => entry.showMain(),
    hideMain: () => entry.hideMain(),
    setShortcut: (value, bindings) => {
      if (bindings) hotkeys = bindings;
      return entry.setShortcut(value);
    },
    snapshot: () => entry.snapshot(),
    dispose,
  };
}
module.exports = { createHostedEntry };
