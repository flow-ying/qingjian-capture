"use strict";
const { _electron } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, ".."),
  log = path.join(root, "artifacts", "quit-events.jsonl");
(async () => {
  const app = await _electron.launch({
    executablePath: require("electron"),
    args: [path.join(root, "demo/main.cjs")],
    env: { ...process.env, ORB_TEST: "1" },
  });
  const child = app.process();
  let timer;
  try {
    for (
      let i = 0;
      i < 100 &&
      !(await app.evaluate(() =>
        Boolean(globalThis.orbTest?.entry?.getWindow()),
      ));
      i++
    )
      await new Promise((r) => setTimeout(r, 30));
    await app.evaluate(({ app, BrowserWindow }, log) => {
      const fs = process.getBuiltinModule("node:fs");
      const write = (event, detail) =>
        fs.appendFileSync(
          log,
          JSON.stringify({ event, detail, time: Date.now() }) + "\n",
        );
      process.on("uncaughtException", (e) =>
        write("exception", { message: e.message, stack: e.stack }),
      );
      for (const name of [
        "before-quit",
        "will-quit",
        "quit",
        "window-all-closed",
      ])
        app.on(name, () => write(name));
      for (const w of BrowserWindow.getAllWindows()) {
        w.on("close", () => write("close", w.id));
        w.on("closed", () => write("closed"));
        w.webContents.on("will-prevent-unload", () =>
          write("will-prevent-unload", w.id),
        );
      }
      write("begin", process.pid);
    }, log);
    if (process.argv.includes("--bridge")) {
      const owner = await app.firstWindow();
      await owner.waitForLoadState();
      await owner.evaluate(async (root) => {
        const path = require("node:path"),
          remote = require("@electron/remote");
        remote.getGlobal("orbTest").entry.dispose();
        window.quitBridge = remote
          .require(path.join(root, "dist/apex-desktop-entry/native.cjs"))
          .createHostedEntry({
            ownerId: remote.getCurrentWindow().id,
            assets: path.join(root, "dist/apex-desktop-entry/ui"),
            settingsPath: path.join(
              root,
              "artifacts",
              "quit-repro-settings.json",
            ),
            hotkeys: {},
          });
        await window.quitBridge.start();
      }, root);
    }
    await Promise.race([
      app.close(),
      new Promise(
        (_, reject) =>
          (timer = setTimeout(() => reject(new Error("quit timeout")), 4000)),
      ),
    ]);
    console.log("normal exit", child.exitCode);
  } catch (e) {
    console.log(e.message);
    if (fs.existsSync(log)) console.log(fs.readFileSync(log, "utf8"));
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
})();
