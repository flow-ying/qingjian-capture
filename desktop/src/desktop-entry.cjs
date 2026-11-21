"use strict";
const path = require("node:path");
const {
  restorePosition,
  dockPosition,
  dragResult,
  visibleBounds,
  windowShape,
} = require("./geometry.cjs");
const { createShortcut } = require("./shortcut.cjs");
const CHANNEL = "apex-desktop-entry:v1";
const TYPES = ["task", "issue", "idea", "link", "note"];
function createDesktopEntry({
  electron,
  assets,
  capture,
  mainWindow,
  store,
  hotkeys = {},
  onStatus = () => {},
}) {
  const { BrowserWindow, ipcMain, screen, globalShortcut, app } =
    electron || {};
  if (
    !BrowserWindow ||
    !ipcMain?.handle ||
    !screen?.getAllDisplays ||
    !globalShortcut?.register
  )
    throw new Error("Obsidian 原生窗口桥不可用");
  if (
    !capture ||
    typeof capture.open !== "function" ||
    typeof capture.collapse !== "function"
  )
    throw new Error("统一采集接口尚未接入");
  let settings = store.load() || {},
    position = restorePosition(settings.position, screen.getAllDisplays());
  let win = null,
    started = false,
    disposed = false,
    ownsHandler = false,
    visible = settings.visible !== false,
    menu = false,
    keyboard = false,
    error = "",
    drag = null,
    ready = null,
    opening = false,
    appliedShape = null;
  const isMainVisible = () =>
    Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const shortcut = createShortcut(
    globalShortcut,
    () => {
      try {
        openMenu(true);
      } catch (e) {
        report(e);
      }
    },
    hotkeys,
  );
  function snapshot() {
    return {
      version: 1,
      visible,
      menu,
      keyboard,
      position: { ...position },
      shortcut: shortcut.current(),
      error,
      disposed,
      mainVisible: isMainVisible(),
      opening,
    };
  }
  function publish() {
    if (win && !win.isDestroyed())
      win.webContents.send(CHANNEL + ":state", snapshot());
    onStatus(snapshot());
  }
  function report(e) {
    error = e instanceof Error ? e.message : String(e);
    publish();
  }
  function persist() {
    settings = {
      version: 1,
      position: { ...position },
      visible,
      shortcut: settings.shortcut ?? "Control+Shift+Space",
    };
    try {
      store.save(settings);
    } catch (e) {
      report(new Error("入口设置保存失败：" + e.message));
    }
  }
  function render({ show = false, focus = false } = {}) {
    if (!win || win.isDestroyed()) {
      if (show && !disposed)
        ready = createWindow()
          .then(() => {
            if (!disposed) render({ show: true, focus });
          })
          .catch(report);
      return;
    }
    win.setFocusable(menu && keyboard);
    win.setBounds(visibleBounds(position, menu));
    const shapeKey = menu ? "full" : position.dock || "full";
    if (appliedShape !== shapeKey) {
      win.setShape(windowShape(position, menu));
      appliedShape = shapeKey;
    }
    if (!visible) win.hide();
    else if (show) {
      if (focus) {
        win.show();
        win.focus();
      } else win.showInactive();
    }
    publish();
  }
  function ensureLive() {
    if (!started || disposed) throw new Error("桌面入口未启动或已停用");
  }
  function showOrb() {
    ensureLive();
    menu = false;
    keyboard = false;
    visible = true;
    render({ show: true });
    persist();
  }
  function hideOrb() {
    ensureLive();
    if (!isMainVisible() && !shortcut.current())
      throw new Error(
        "主窗口已隐藏且全局快捷键不可用；请先显示主窗口，保留恢复入口",
      );
    visible = false;
    menu = false;
    keyboard = false;
    drag = null;
    render();
    persist();
  }
  function openMenu(focus = false) {
    ensureLive();
    visible = true;
    menu = true;
    keyboard = Boolean(focus);
    drag = null;
    render({ show: true, focus: keyboard });
    persist();
  }
  function closeMenu() {
    menu = false;
    keyboard = false;
    render();
  }
  async function openCapture(type) {
    ensureLive();
    if (!TYPES.includes(type)) throw new Error("未知采集类型");
    if (opening) return;
    opening = true;
    error = "";
    closeMenu();
    try {
      await capture.open({ type });
    } catch (e) {
      report(e);
      openMenu(false);
      throw e;
    } finally {
      opening = false;
      publish();
    }
  }
  async function collapseCapture() {
    ensureLive();
    await capture.collapse();
    closeMenu();
  }
  function hideMain() {
    ensureLive();
    if (!visible && !shortcut.current())
      throw new Error("请先恢复悬浮球或设置快捷键，保留恢复入口");
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    closeMenu();
  }
  function showMain() {
    ensureLive();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    closeMenu();
  }
  function setShortcut(value) {
    ensureLive();
    if (!value && !visible && !isMainVisible())
      return {
        ok: false,
        code: "RECOVERY_REQUIRED",
        message: "先恢复入口再停用快捷键",
      };
    const result = shortcut.set(value);
    if (result.ok) {
      settings.shortcut = result.accelerator;
      error = "";
      persist();
    } else report(new Error(result.message));
    publish();
    return result;
  }
  function displayForPoint(point) {
    return screen.getDisplayNearestPoint(point);
  }
  function beginDrag() {
    const point = screen.getCursorScreenPoint();
    drag = { point, position: { ...position }, max: 0 };
  }
  function moveDrag() {
    if (!drag) return;
    const point = screen.getCursorScreenPoint();
    drag.max = Math.max(
      drag.max,
      Math.hypot(point.x - drag.point.x, point.y - drag.point.y),
    );
    if (drag.max < 7) return;
    const display = displayForPoint(point);
    position = restorePosition(
      {
        x: drag.position.x + point.x - drag.point.x,
        y: drag.position.y + point.y - drag.point.y,
        displayId: display.id,
      },
      [display],
    );
    menu = false;
    keyboard = false;
    render();
  }
  function endDrag(cancel = false) {
    if (!drag) return;
    moveDrag();
    const click =
      !cancel &&
      dragResult(drag.point, screen.getCursorScreenPoint(), drag.max).click;
    drag = null;
    if (click) {
      openMenu(false);
      return;
    }
    position = dockPosition(
      position,
      displayForPoint({ x: position.x + 28, y: position.y + 28 }),
    );
    render();
    persist();
  }
  function reflow() {
    if (disposed) return;
    drag = null;
    position = restorePosition(position, screen.getAllDisplays());
    render();
    persist();
  }
  function createWindow() {
    appliedShape = null;
    win = new BrowserWindow({
      ...visibleBounds(position),
      minWidth: 1,
      minHeight: 1,
      show: false,
      title: "Apex 桌面采集入口",
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(assets, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
      },
    });
    win.setMenu(null);
    win.setAlwaysOnTop(true, "floating");
    if (!win.isAlwaysOnTop()) throw new Error("系统未确认悬浮球置顶");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    // Do not cancel BrowserWindow.close: that also runs during app.quit.
    // A destroyed orb is recreated by the owned shortcut or recovery command.
    win.on("closed", () => {
      win = null;
      ready = null;
      if (!disposed) {
        visible = false;
        menu = false;
        keyboard = false;
        drag = null;
        persist();
      }
    });
    win.on("blur", () => {
      if (menu && keyboard) closeMenu();
    });
    return win.loadFile(path.join(assets, "index.html"));
  }
  async function dispatch(event, action, args) {
    if (
      !win ||
      win.isDestroyed() ||
      event.sender.id !== win.webContents.id ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("拒绝非入口窗口请求");
    try {
      ensureLive();
      switch (action) {
        case "state":
          break;
        case "drag-start":
          beginDrag();
          break;
        case "drag-move":
          moveDrag();
          break;
        case "drag-end":
          endDrag();
          break;
        case "drag-cancel":
          endDrag(true);
          break;
        case "close-menu":
          closeMenu();
          break;
        case "open":
          await openCapture(args);
          break;
        case "hide-orb":
          hideOrb();
          break;
        case "hide-main":
          hideMain();
          break;
        case "show-main":
          showMain();
          break;
        case "collapse-capture":
          await collapseCapture();
          break;
        case "quit":
          app.quit();
          break;
        default:
          throw new Error("未知入口动作");
      }
      return { ok: true, state: snapshot() };
    } catch (e) {
      report(e);
      return { ok: false, message: e.message, state: snapshot() };
    }
  }
  async function start() {
    if (disposed) throw new Error("桌面入口已停用");
    if (started) return ready;
    try {
      ipcMain.handle(CHANNEL, dispatch);
      ownsHandler = true;
    } catch {
      throw new Error("已有桌面入口实例；拒绝重复创建");
    }
    started = true;
    try {
      const result = shortcut.set(settings.shortcut ?? "Control+Shift+Space");
      if (!result.ok) error = result.message;
      if (!visible && !isMainVisible() && !shortcut.current()) visible = true;
      for (const event of [
        "display-added",
        "display-removed",
        "display-metrics-changed",
      ])
        screen.on(event, reflow);
      app.on("will-quit", dispose);
      if (mainWindow) mainWindow.on("closed", dispose);
      ready = createWindow().then(() => {
        if (!disposed) render({ show: visible });
      });
      await ready;
      return snapshot();
    } catch (e) {
      dispose();
      throw e;
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    drag = null;
    shortcut.dispose();
    if (ownsHandler) {
      ipcMain.removeHandler(CHANNEL);
      ownsHandler = false;
    }
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ])
      screen.removeListener(event, reflow);
    app.removeListener("will-quit", dispose);
    if (mainWindow) mainWindow.removeListener("closed", dispose);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }
  return {
    start,
    showOrb,
    hideOrb,
    openMenu,
    openCapture,
    collapseCapture,
    hideMain,
    showMain,
    setShortcut,
    snapshot,
    dispose,
    getWindow: () => win,
  };
}
module.exports = { createDesktopEntry, CHANNEL, TYPES };
