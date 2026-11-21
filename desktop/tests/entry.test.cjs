"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createDesktopEntry } = require("../src/desktop-entry.cjs");
function fixture(options = {}) {
  const windows = [];
  const handlers = new Map(),
    bindings = new Map();
  const events = [];
  let cursor = { x: 600, y: 300 };
  class Window extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.bounds = {
        x: opts.x,
        y: opts.y,
        width: opts.width,
        height: opts.height,
      };
      this.visible = false;
      this.focused = false;
      this.dead = false;
      this.webContents = new EventEmitter();
      this.webContents.id = windows.length + 1;
      this.webContents.mainFrame = {};
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() {
      return this.dead;
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    async loadFile() {}
    setMenu() {}
    showInactive() {
      this.visible = true;
      events.push("inactive");
    }
    show() {
      this.visible = true;
      events.push("show");
    }
    focus() {
      this.focused = true;
      events.push("focus");
    }
    hide() {
      this.visible = false;
    }
    setFocusable(v) {
      this.focusable = v;
    }
    setBounds(b) {
      this.bounds = b;
    }
    getBounds() {
      return this.bounds;
    }
    setShape(rects) {
      this.shape = rects;
    }
    setAlwaysOnTop(v) {
      this.top = v;
    }
    isAlwaysOnTop() {
      return this.top;
    }
    destroy() {
      this.dead = true;
      this.visible = false;
      this.emit("closed");
    }
  }
  const screen = new EventEmitter();
  screen.getAllDisplays = () => [
    {
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1,
    },
  ];
  screen.getCursorScreenPoint = () => cursor;
  screen.getDisplayNearestPoint = () => screen.getAllDisplays()[0];
  const app = new EventEmitter();
  app.quit = () => {
    app.emit("will-quit");
  };
  const ipcMain = {
    handle: (k, fn) => {
      if (handlers.has(k)) throw new Error("duplicate");
      handlers.set(k, fn);
    },
    removeHandler: (k) => handlers.delete(k),
  };
  const globalShortcut = {
    isRegistered: (k) => bindings.has(k),
    register: (k, fn) => {
      if (options.conflict) return false;
      bindings.set(k, fn);
      return true;
    },
    unregister: (k) => bindings.delete(k),
  };
  const mainWindow = new Window({ x: 0, y: 0, width: 800, height: 600 });
  mainWindow.visible = options.mainVisible !== false;
  const opened = [];
  let collapsed = 0;
  const saved = [];
  const capture = {
    open: async (r) => {
      if (options.reject) throw new Error("模拟采集端口不可用");
      opened.push(r);
    },
    collapse: () => collapsed++,
  };
  const electron = {
    BrowserWindow: Window,
    ipcMain,
    screen,
    globalShortcut,
    app,
  };
  const entry = createDesktopEntry({
    electron,
    assets: ".",
    capture,
    mainWindow,
    store: {
      load: () => ({
        visible: options.visible !== false,
        shortcut: "Control+Shift+Space",
      }),
      save: (s) => saved.push(s),
    },
    hotkeys: {},
  });
  return {
    entry,
    electron,
    mainWindow,
    windows,
    opened,
    events,
    handlers,
    bindings,
    screen,
    saved,
    app,
    setCursor: (p) => (cursor = p),
    collapsed: () => collapsed,
    dispatch: (action, args) => {
      const win = windows.at(-1);
      return [...handlers.values()][0](
        { sender: win.webContents, senderFrame: win.webContents.mainFrame },
        action,
        args,
      );
    },
  };
}
test("start is passive and duplicate start creates only one orb", async () => {
  const f = fixture();
  await f.entry.start();
  await f.entry.start();
  assert.equal(f.windows.length, 2);
  assert.deepEqual(f.events, ["inactive"]);
  assert.equal(f.windows[1].opts.focusable, false);
  assert.equal(f.windows[1].isAlwaysOnTop(), true);
  f.entry.dispose();
});
test("drag-end does not open menu; subsequent click opens menu", async () => {
  const f = fixture();
  await f.entry.start();
  await f.dispatch("drag-start");
  f.setCursor({ x: 720, y: 320 });
  await f.dispatch("drag-move");
  f.setCursor({ x: 601, y: 301 });
  await f.dispatch("drag-end");
  assert.equal(f.entry.snapshot().menu, false);
  await f.dispatch("drag-start");
  await f.dispatch("drag-end");
  assert.equal(f.entry.snapshot().menu, true);
  assert.equal(f.opened.length, 0);
  f.entry.dispose();
});
test("capture opens specified type without showing main; errors remain visible", async () => {
  const f = fixture({ mainVisible: false });
  await f.entry.start();
  await f.entry.openCapture("idea");
  assert.deepEqual(f.opened, [{ type: "idea" }]);
  assert.equal(f.mainWindow.isVisible(), false);
  await assert.rejects(f.entry.openCapture("password"));
  f.entry.dispose();
  const failed = fixture({ reject: true });
  await failed.entry.start();
  await assert.rejects(failed.entry.openCapture("task"));
  assert.match(failed.entry.snapshot().error, /不可用/);
  assert.equal(failed.entry.snapshot().menu, true);
  failed.entry.dispose();
});
test("hide main, collapse capture, and hide orb are independent", async () => {
  const f = fixture();
  await f.entry.start();
  f.entry.hideMain();
  await f.entry.collapseCapture();
  f.entry.hideOrb();
  assert.equal(f.mainWindow.visible, false);
  assert.equal(f.entry.snapshot().visible, false);
  assert.equal(f.collapsed(), 1);
  [...f.bindings.values()][0]();
  assert.equal(f.entry.snapshot().visible, true);
  assert.equal(f.mainWindow.visible, false);
  f.entry.dispose();
});
test("missing shortcut cannot strand both main and orb hidden", async () => {
  const f = fixture({ conflict: true, mainVisible: false, visible: false });
  await f.entry.start();
  assert.equal(f.entry.snapshot().visible, true);
  assert.throws(() => f.entry.hideOrb(), /恢复/);
  f.entry.dispose();
});
test("normal exit clears owned window, shortcut, and all event handlers", async () => {
  const f = fixture();
  await f.entry.start();
  f.app.quit();
  f.entry.dispose();
  assert.equal(f.handlers.size, 0);
  assert.equal(f.bindings.size, 0);
  assert.equal(f.windows[1].dead, true);
  assert.equal(f.screen.eventNames().length, 0);
  assert.equal(f.mainWindow.dead, false);
});
test("foreign renderer cannot invoke the entry", async () => {
  const f = fixture();
  await f.entry.start();
  await assert.rejects(
    [...f.handlers.values()][0]({ sender: { id: 999 } }, "open", "note"),
  );
  assert.equal(f.opened.length, 0);
  f.entry.dispose();
});
test("second owner fails without destroying first owner registration", async () => {
  const f = fixture();
  await f.entry.start();
  const second = createDesktopEntry({
    electron: f.electron,
    assets: ".",
    capture: { open() {}, collapse() {} },
    mainWindow: f.mainWindow,
    store: { load: () => ({}), save() {} },
    hotkeys: {},
  });
  await assert.rejects(second.start(), /入口/);
  assert.equal(f.handlers.size, 1);
  assert.equal(f.bindings.size, 1);
  f.entry.dispose();
});
test("native close is not prevented and recovery creates a single replacement", async () => {
  const f = fixture();
  await f.entry.start();
  let prevented = false;
  f.windows[1].emit("close", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  f.windows[1].destroy();
  assert.equal(f.entry.getWindow(), null);
  f.entry.showOrb();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.windows.length, 3);
  assert.equal(f.entry.snapshot().visible, true);
  assert.equal(f.bindings.size, 1);
  f.entry.dispose();
});
