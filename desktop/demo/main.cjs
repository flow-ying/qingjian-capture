"use strict";
const path = require("node:path");
const fs = require("node:fs");
const electron = require("electron");
const { app, BrowserWindow } = electron;
const remoteMain = require("@electron/remote/main");
const { createDesktopEntry } = require("../src/desktop-entry.cjs");
const root = path.resolve(__dirname, "..");
app.setPath("userData", path.join(root, "artifacts", "demo-profile"));
remoteMain.initialize();
let main, capture, entry;
const calls = [];
app.whenReady().then(async () => {
  main = new BrowserWindow({
    width: 600,
    height: 440,
    show: !process.env.ORB_TEST,
    title: "Desktop entry test host",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  remoteMain.enable(main.webContents);
  await main.loadFile(path.join(__dirname, "owner.html"));
  const mock = {
    open({ type }) {
      calls.push({ type, time: Date.now() });
      if (!capture || capture.isDestroyed()) {
        capture = new BrowserWindow({
          width: 400,
          height: 260,
          show: false,
          title: "模拟采集窗口（不写入）",
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
      }
      capture.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(
            '<!doctype html><html lang=zh><meta charset=utf-8><body style="font:16px system-ui;padding:28px;background:#f5f3f8;color:#30283c"><h2>模拟采集：' +
              type +
              "</h2><p>仅验证入口调用；没有表单，也不会写入。</p></body></html>",
          ),
      );
      capture.show();
      capture.focus();
    },
    collapse() {
      capture?.hide();
    },
  };
  let settings = { position: { x: 660, y: 300 }, visible: true };
  const metrics = { stateEvents: 0 };
  entry = createDesktopEntry({
    electron,
    assets: path.join(root, "ui"),
    capture: mock,
    mainWindow: main,
    store: {
      load: () => settings,
      save: (s) => {
        settings = s;
      },
    },
    hotkeys: { "existing-color": [{ modifiers: ["Alt"], key: "C" }] },
    onStatus: () => metrics.stateEvents++,
  });
  globalThis.orbTest = {
    entry,
    main,
    calls,
    getCapture: () => capture,
    root,
    electron,
    metrics,
  };
  await entry.start();
});
app.on("window-all-closed", () => app.quit());
// A temporary demo is bounded; no background executable is installed.
const watchdog = setTimeout(
  () => app.quit(),
  process.env.ORB_TEST ? 120000 : 900000,
);
watchdog.unref();
