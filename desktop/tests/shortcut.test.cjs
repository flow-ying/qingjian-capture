"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeShortcut,
  localConflict,
  createShortcut,
} = require("../src/shortcut.cjs");
test("Obsidian Mod and Electron Control aliases compare on Windows", () => {
  assert.equal(
    normalizeShortcut("Ctrl+Shift+Space"),
    normalizeShortcut("Shift+Control+Space"),
  );
  assert.equal(
    localConflict("Alt+C", {
      "color:open": [{ modifiers: ["Alt"], key: "C" }],
    }),
    "color:open",
  );
  assert.equal(
    localConflict("Control+Shift+Space", {
      test: [{ modifiers: ["Mod", "Shift"], key: "Space" }],
    }),
    "test",
  );
});
test("registration conflict keeps old shortcut and never unregisters foreign binding", () => {
  const registrations = new Map([["Control+Alt+Space", "foreign"]]);
  const released = [];
  const globalShortcut = {
    isRegistered: (k) => registrations.has(k),
    register: (k, fn) => {
      if (registrations.has(k)) return false;
      registrations.set(k, fn);
      return true;
    },
    unregister: (k) => {
      released.push(k);
      registrations.delete(k);
    },
  };
  const shortcut = createShortcut(globalShortcut, () => {}, {});
  assert.equal(shortcut.set("Control+Shift+Space").ok, true);
  assert.equal(shortcut.set("Control+Alt+Space").ok, false);
  assert.equal(shortcut.current(), "Control+Shift+Space");
  shortcut.dispose();
  shortcut.dispose();
  assert.deepEqual(released, ["Control+Shift+Space"]);
  assert.equal(registrations.get("Control+Alt+Space"), "foreign");
});
test("OS registration failure is a reported conflict", () => {
  const s = createShortcut(
    { isRegistered: () => false, register: () => false },
    () => {},
    {},
  );
  assert.equal(s.set("Control+Shift+Space").code, "OS_CONFLICT");
  assert.equal(s.current(), "");
});
