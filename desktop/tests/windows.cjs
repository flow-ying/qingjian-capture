"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { _electron: electron } = require("playwright");
const exec = promisify(execFile),
  root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {
  started: new Date().toISOString(),
  platform: process.platform,
  tests: [],
  scope: "Windows Electron mock host; no Obsidian deployment",
  artifactHashes: JSON.parse(
    fs.readFileSync(
      path.join(root, "dist/apex-desktop-entry/SHA256SUMS.json"),
      "utf8",
    ),
  ),
};
let app, child, fixture, original;
const readyPath = path.join(
  artifacts,
  "foreign-window-" + Date.now() + ".json",
);
async function native(action, args = {}) {
  const params = [
    "-NoProfile",
    "-File",
    path.join(__dirname, "win32.ps1"),
    "-Action",
    action,
  ];
  for (const [k, v] of Object.entries(args)) params.push("-" + k, String(v));
  const { stdout } = await exec("powershell.exe", params, {
    windowsHide: true,
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}
async function check(name, fn) {
  const result = await fn();
  report.tests.push({ name, pass: true, detail: result ?? null });
  console.log("PASS " + name);
}
async function poll(fn) {
  for (let i = 0; i < 40; i++) {
    const value = await fn();
    if (value) return value;
    await delay(75);
  }
  throw new Error("State did not settle");
}
async function state() {
  return app.evaluate(() => globalThis.orbTest.entry.snapshot());
}
async function orbInfo() {
  return app.evaluate(() => {
    const w = globalThis.orbTest.entry.getWindow();
    return {
      id: w.id,
      handle: Number(w.getNativeWindowHandle().readBigUInt64LE()),
      bounds: w.getBounds(),
    };
  });
}
async function point(x, y) {
  return app.evaluate(({ screen }, p) => screen.dipToScreenPoint(p), {
    x: Math.round(x),
    y: Math.round(y),
  });
}
async function clickSelector(selector) {
  const info = await orbInfo();
  const page = await poll(async () =>
    (await app.windows()).find((p) => p.url().endsWith("/ui/index.html")),
  );
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, selector + " visible");
  const pos = await point(
    info.bounds.x + box.x + box.width / 2,
    info.bounds.y + box.y + box.height / 2,
  );
  await native("click", { Handle: info.handle, X: pos.x, Y: pos.y });
  await delay(100);
}
async function focusFixture(data) {
  const result = await native("foreground", { Handle: data.handle });
  assert.equal(
    result.foreground,
    data.handle,
    "foreign test process receives focus",
  );
}
async function assertExternalForeground(expected) {
  const foreground = (await native("inspect")).foreground;
  const owned = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) =>
      Number(w.getNativeWindowHandle().readBigUInt64LE()),
    ),
  );
  assert.equal(
    owned.includes(foreground),
    false,
    "no owned window acquired foreground",
  );
  return { foreground, expected, externalSwitch: foreground !== expected };
}
async function runChecks(foreign) {
  await check("idle produces no recurring entry state events", async () => {
    const before = await app.evaluate(
      () => globalThis.orbTest.metrics.stateEvents,
    );
    await delay(1200);
    const after = await app.evaluate(
      () => globalThis.orbTest.metrics.stateEvents,
    );
    assert.equal(after, before);
    return { durationMs: 1200, events: after - before };
  });
  await check(
    "passive show keeps foreground external and main hidden",
    async () => {
      await focusFixture(foreign);
      await app.evaluate(() => globalThis.orbTest.entry.showOrb());
      const info = await orbInfo();
      const win = await native("inspect", { Handle: info.handle });
      report.focusDiagnostic = { foreign, info, win };
      const focus = await assertExternalForeground(foreign.handle);
      assert.equal(win.noActivate, true);
      assert.equal((await state()).mainVisible, false);
      return { win, focus };
    },
  );
  await check(
    "topmost confirmed by Windows style and hit testing",
    async () => {
      const info = await orbInfo();
      const p = await point(info.bounds.x + 28, info.bounds.y + 28);
      assert.equal(
        (await native("inspect", { Handle: info.handle })).topmost,
        true,
      );
      assert.equal((await native("hit", { X: p.x, Y: p.y })).hit, info.handle);
    },
  );
  await check(
    "real native drag moves window without click or focus theft",
    async () => {
      const before = await orbInfo();
      const start = await point(before.bounds.x + 28, before.bounds.y + 28),
        end = await point(before.bounds.x + 168, before.bounds.y + 108);
      await native("drag", {
        Handle: before.handle,
        X: start.x,
        Y: start.y,
        EndX: end.x,
        EndY: end.y,
      });
      const after = await orbInfo();
      assert.ok(Math.abs(after.bounds.x - before.bounds.x - 140) <= 2);
      assert.ok(Math.abs(after.bounds.y - before.bounds.y - 80) <= 2);
      assert.equal((await state()).menu, false);
      const focus = await assertExternalForeground(foreign.handle);
      return { before: before.bounds, after: after.bounds, focus };
    },
  );
  await check(
    "native click opens type menu while keeping focus external",
    async () => {
      await clickSelector("#orb");
      await poll(async () => (await state()).menu);
      const focus = await assertExternalForeground(foreign.handle);
      const page = (await app.windows()).find((p) =>
        p.url().endsWith("/ui/index.html"),
      );
      await page.screenshot({ path: path.join(artifacts, "menu-windows.png") });
      return focus;
    },
  );
  await check(
    "all five types reach mock capture; main stays hidden",
    async () => {
      for (const type of ["task", "issue", "idea", "link", "note"]) {
        await app.evaluate(() => globalThis.orbTest.entry.openMenu());
        await clickSelector('[data-type="' + type + '"]');
        await poll(() =>
          app.evaluate(
            (_e, t) => globalThis.orbTest.calls.at(-1)?.type === t,
            type,
          ),
        );
        assert.equal((await state()).mainVisible, false);
      }
      return await app.evaluate(() =>
        globalThis.orbTest.calls.map((c) => c.type),
      );
    },
  );
  await check("capture collapse and orb hiding remain separate", async () => {
    await app.evaluate(() => globalThis.orbTest.entry.collapseCapture());
    assert.equal(
      await app.evaluate(() => globalThis.orbTest.getCapture().isVisible()),
      false,
    );
    await app.evaluate(() => globalThis.orbTest.entry.hideOrb());
    assert.equal((await state()).visible, false);
  });
  await check(
    "global shortcut from foreign process restores hidden orb/menu",
    async () => {
      assert.equal((await state()).shortcut, "Control+Shift+Space");
      await focusFixture(foreign);
      await native("shortcut", { Handle: foreign.handle });
      await poll(async () => (await state()).menu);
      const info = await orbInfo();
      assert.equal((await native("inspect")).foreground, info.handle);
      assert.equal((await state()).mainVisible, false);
      await native("escape", { Handle: info.handle });
      await poll(async () => !(await state()).menu);
    },
  );
  await check(
    "local and external-process hotkey conflicts preserve old binding",
    async () => {
      const local = await app.evaluate(() =>
        globalThis.orbTest.entry.setShortcut("Alt+C"),
      );
      assert.equal(local.code, "LOCAL_CONFLICT");
      assert.equal(foreign.heldShortcut, true);
      const foreignConflict = await app.evaluate(() =>
        globalThis.orbTest.entry.setShortcut("Control+Alt+F11"),
      );
      assert.equal(foreignConflict.code, "OS_CONFLICT");
      assert.equal((await state()).shortcut, "Control+Shift+Space");
      return { local: local.code, external: foreignConflict.code };
    },
  );
  await check(
    "edge dock is 18 DIP hit region, remainder clicks through",
    async () => {
      await app.evaluate(() => globalThis.orbTest.entry.showOrb());
      const info = await orbInfo(),
        before = info.bounds;
      const display = report.environment.displays[0].workArea;
      const from = await point(before.x + 28, before.y + 28),
        to = await point(display.x + 12, before.y + 28);
      await native("drag", {
        Handle: info.handle,
        X: from.x,
        Y: from.y,
        EndX: to.x,
        EndY: to.y,
      });
      await poll(async () => (await state()).position.dock === "left");
      const bounds = (await orbInfo()).bounds;
      const strip = await point(bounds.x + 9, bounds.y + 28),
        outside = await point(bounds.x + 40, bounds.y + 28);
      assert.equal(
        (await native("hit", { X: strip.x, Y: strip.y })).hit,
        info.handle,
      );
      assert.notEqual(
        (await native("hit", { X: outside.x, Y: outside.y })).hit,
        info.handle,
      );
      const page = (await app.windows()).find((p) =>
        p.url().endsWith("/ui/index.html"),
      );
      await page.screenshot({
        path: path.join(artifacts, "docked-windows.png"),
      });
      await clickSelector("#orb");
      await poll(async () => (await state()).menu);
    },
  );
  await check("explicit show/hide main is distinct from capture", async () => {
    await app.evaluate(() => globalThis.orbTest.entry.showMain());
    assert.equal((await state()).mainVisible, true);
    await app.evaluate(() => globalThis.orbTest.entry.hideMain());
    assert.equal((await state()).mainVisible, false);
  });
  await check(
    "dispose clears owned windows, shortcut and display listeners",
    async () => {
      return await app.evaluate(({ globalShortcut, screen }) => {
        const e = globalThis.orbTest.entry;
        e.dispose();
        if (
          e.getWindow() !== null ||
          globalShortcut.isRegistered("Control+Shift+Space")
        )
          throw new Error("not cleaned");
        return {
          window: e.getWindow(),
          shortcut: globalShortcut.isRegistered("Control+Shift+Space"),
          displayListeners: screen.listenerCount("display-metrics-changed"),
        };
      });
    },
  );
  await check(
    "built main-process bridge supports renderer port replies and errors",
    async () => {
      const owner = (await app.windows()).find((p) =>
        p.url().endsWith("/demo/owner.html"),
      );
      await owner.evaluate(async (root) => {
        const path = require("node:path"),
          remote = require("@electron/remote"),
          { ipcRenderer } = require("electron");
        const { attachCapturePort } = require(
          path.join(root, "src", "renderer-port.cjs"),
        );
        window.bridgeCalls = [];
        window.bridgeDetach = attachCapturePort(ipcRenderer, () => ({
          open: async ({ type }) => {
            if (type === "issue") throw new Error("bridge rejection verified");
            window.bridgeCalls.push(type);
          },
          collapse: () => window.bridgeCalls.push("collapse"),
        }));
        window.bridge = remote
          .require(path.join(root, "dist", "apex-desktop-entry", "native.cjs"))
          .createHostedEntry({
            ownerId: remote.getCurrentWindow().id,
            assets: path.join(root, "dist", "apex-desktop-entry", "ui"),
            settingsPath: path.join(root, "artifacts", "bridge-settings.json"),
            hotkeys: {},
          });
        await window.bridge.start();
        await window.bridge.openCapture("idea");
        await window.bridge.collapseCapture();
      }, root);
      assert.deepEqual(await owner.evaluate(() => window.bridgeCalls), [
        "idea",
        "collapse",
      ]);
      const error = await owner.evaluate(async () => {
        try {
          await window.bridge.openCapture("issue");
          return "";
        } catch (e) {
          return e.message;
        }
      });
      assert.equal(error, "bridge rejection verified");
      await owner.evaluate(() => {
        window.bridge.dispose();
        window.bridgeDetach();
      });
    },
  );
  await check("active entry can restart before normal app exit", async () => {
    const owner = (await app.windows()).find((p) =>
      p.url().endsWith("/demo/owner.html"),
    );
    await owner.evaluate(async (root) => {
      const path = require("node:path"),
        remote = require("@electron/remote");
      window.quitBridge = remote
        .require(path.join(root, "dist", "apex-desktop-entry", "native.cjs"))
        .createHostedEntry({
          ownerId: remote.getCurrentWindow().id,
          assets: path.join(root, "dist", "apex-desktop-entry", "ui"),
          settingsPath: path.join(root, "artifacts", "quit-settings.json"),
          hotkeys: {},
        });
      await window.quitBridge.start();
    }, root);
    assert.equal(
      await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered("Control+Shift+Space"),
      ),
      true,
    );
  });
}
(async () => {
  try {
    assert.equal(process.platform, "win32");
    const executablePath = require("electron");
    original = await native("inspect");
    fixture = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        path.join(__dirname, "foreign-window.ps1"),
        "-ReadyPath",
        readyPath,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const foreign = await poll(
      () =>
        fs.existsSync(readyPath) &&
        JSON.parse(fs.readFileSync(readyPath, "utf8").trim()),
    );
    app = await electron.launch({
      executablePath,
      args: [path.join(root, "demo", "main.cjs")],
      env: { ...process.env, ORB_TEST: "1" },
      timeout: 30000,
    });
    child = app.process();
    await poll(() =>
      app.evaluate(() => Boolean(globalThis.orbTest?.entry?.getWindow())),
    );
    await delay(500);
    report.environment = await app.evaluate(({ screen }) => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      displays: screen.getAllDisplays().map((d) => ({
        id: d.id,
        scaleFactor: d.scaleFactor,
        workArea: d.workArea,
      })),
    }));
    await runChecks(foreign);
    report.complete = true;
  } catch (error) {
    report.complete = false;
    report.error = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) {
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("normal exit exceeded 5 seconds")),
              5000,
            );
          }),
        ]);
        report.cleanup = { normalExit: true, exitCode: child.exitCode };
      } catch (error) {
        report.complete = false;
        report.cleanup = { normalExit: false, error: error.message };
        child.kill();
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    }
    if (fixture) fixture.kill();
    if (original)
      try {
        await native("restore", {
          Handle: original.foreground,
          X: original.x,
          Y: original.y,
        });
      } catch {}
    report.finished = new Date().toISOString();
    fs.writeFileSync(
      path.join(artifacts, "windows-results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        report: path.join(artifacts, "windows-results.json"),
        complete: report.complete,
        passed: report.tests.length,
      }),
    );
  }
})();
