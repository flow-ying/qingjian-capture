"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachCapturePort } = require("../src/renderer-port.cjs");
test("renderer bridge reports async success, failure and unavailable provider", async () => {
  const ipc = new EventEmitter(),
    results = [];
  ipc.send = (channel, result) => results.push({ channel, result });
  let port = {
    open: async () => {
      throw new Error("unavailable");
    },
    collapse: async () => {},
  };
  const dispose = attachCapturePort(ipc, () => port);
  const listener = ipc.listeners("apex-desktop-entry:request")[0];
  const message = {
    channel: "apex-desktop-entry:host:test",
    id: "1",
    action: "open",
    type: "idea",
  };
  await listener({}, message);
  assert.equal(results[0].result.message, "unavailable");
  await listener({}, { ...message, id: "2", action: "collapse" });
  assert.equal(results[1].result.ok, true);
  port = null;
  await listener({}, { ...message, id: "3" });
  assert.equal(results[2].result.ok, false);
  dispose();
  assert.equal(ipc.listenerCount("apex-desktop-entry:request"), 0);
});
test("plugin resolves fresh unified capture after provider restarts", () => {
  const fs = require("node:fs"),
    path = require("node:path"),
    vm = require("node:vm");
  const module = { exports: {} };
  const localRequire = require("node:module").createRequire(
    path.join(__dirname, "../src/obsidian-plugin.cjs"),
  );
  const sandbox = {
    module,
    require: (name) =>
      name === "obsidian"
        ? { Plugin: class {}, PluginSettingTab: class {} }
        : localRequire(name),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../src/obsidian-plugin.cjs"), "utf8"),
    sandbox,
  );
  const plugin = new module.exports();
  plugin.app = { plugins: { plugins: { "apex-dashboard": {} } } };
  assert.equal(plugin.getCapturePort(), undefined);
  const first = { open() {}, collapse() {} };
  plugin.app.plugins.plugins["apex-dashboard"].unifiedCapture = first;
  assert.equal(plugin.getCapturePort(), first);
  const second = { open() {}, collapse() {} };
  plugin.app.plugins.plugins["apex-dashboard"].unifiedCapture = second;
  assert.equal(plugin.getCapturePort(), second);
  const detach = plugin.bindCapturePort(first);
  assert.equal(plugin.getCapturePort(), first);
  detach();
  assert.equal(plugin.getCapturePort(), second);
});
