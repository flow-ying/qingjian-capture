"use strict";
function normalizeShortcut(value) {
  const aliases = {
    ctrl: "control",
    mod: "control",
    commandorcontrol: "control",
    cmdorctrl: "control",
    spacebar: "space",
    " ": "space",
  };
  return String(value)
    .split("+")
    .map((s) => {
      const key = s.trim().toLowerCase();
      return aliases[key] || key;
    })
    .sort()
    .join("+");
}
function localConflict(accelerator, hotkeys = {}) {
  const wanted = normalizeShortcut(accelerator);
  for (const [id, bindings] of Object.entries(hotkeys))
    for (const b of bindings || [])
      if (
        normalizeShortcut([...(b.modifiers || []), b.key].join("+")) === wanted
      )
        return id;
  return null;
}
function createShortcut(api, callback, hotkeys) {
  let owned = "";
  return {
    current: () => owned,
    set(value) {
      const accelerator = String(value || "").trim();
      if (
        accelerator &&
        normalizeShortcut(accelerator) === normalizeShortcut(owned)
      )
        return { ok: true, accelerator: owned };
      if (!accelerator) {
        if (owned) api.unregister(owned);
        owned = "";
        return { ok: true, accelerator: "" };
      }
      if (!/(Control|Ctrl|Alt|Shift|Super|Meta|Command)/i.test(accelerator))
        return {
          ok: false,
          code: "INVALID",
          message: "全局快捷键必须包含修饰键",
        };
      const conflict = localConflict(
        accelerator,
        typeof hotkeys === "function" ? hotkeys() : hotkeys,
      );
      if (conflict)
        return {
          ok: false,
          code: "LOCAL_CONFLICT",
          message: "Obsidian 快捷键冲突：" + conflict,
        };
      try {
        if (
          api.isRegistered(accelerator) ||
          !api.register(accelerator, callback)
        )
          return {
            ok: false,
            code: "OS_CONFLICT",
            message: "快捷键已被占用或系统不允许注册：" + accelerator,
          };
      } catch {
        return {
          ok: false,
          code: "INVALID",
          message: "系统不接受该快捷键：" + accelerator,
        };
      }
      const previous = owned;
      owned = accelerator;
      if (previous) api.unregister(previous);
      return { ok: true, accelerator };
    },
    dispose() {
      if (owned) api.unregister(owned);
      owned = "";
    },
  };
}
module.exports = { normalizeShortcut, localConflict, createShortcut };
