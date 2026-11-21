"use strict";
const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  Platform,
} = require("obsidian");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { attachCapturePort } = require("./renderer-port.cjs");
function localHotkeys(app) {
  const manager = app.hotkeyManager || {},
    commands = app.commands?.commands || {},
    result = {};
  for (const [id, command] of Object.entries(commands)) {
    const list =
      manager.customKeys?.[id] ??
      manager.defaultKeys?.[id] ??
      command.hotkeys ??
      [];
    if (Array.isArray(list))
      result[id] = list
        .filter(
          (b) => b && typeof b.key === "string" && Array.isArray(b.modifiers),
        )
        .map((b) => ({ key: b.key, modifiers: [...b.modifiers] }));
  }
  return result;
}
module.exports = class DesktopEntryPlugin extends Plugin {
  async onload() {
    this.config = { enabled: true, ...(await this.loadData()) };
    this.capturePort = null;
    this.host = null;
    this.lastError = "";
    const actions = [
      ["show-orb", "显示悬浮球", () => this.host?.showOrb()],
      ["hide-orb", "隐藏悬浮球", () => this.host?.hideOrb()],
      ["open-menu", "打开桌面采集菜单", () => this.host?.openMenu()],
      ["show-main", "显示 Obsidian 主窗口", () => this.host?.showMain()],
      ["hide-main", "隐藏 Obsidian 主窗口", () => this.host?.hideMain()],
      ["collapse-capture", "收起采集窗", () => this.host?.collapseCapture()],
      ["enable-entry", "启用桌面入口", () => this.enable()],
      ["disable-entry", "停用桌面入口", () => this.disable()],
    ];
    for (const [id, name, fn] of actions)
      this.addCommand({
        id,
        name,
        callback: async () => {
          try {
            await fn();
          } catch (e) {
            new Notice(e.message);
          }
        },
      });
    this.addSettingTab(new EntrySettings(this.app, this));
    if (Platform.isDesktopApp && this.config.enabled) {
      try {
        await this.startHost();
      } catch (e) {
        this.lastError = e.message;
        console.error("[desktop-entry] " + e.message);
      }
    }
  }
  bindCapturePort(port) {
    if (
      !port ||
      typeof port.open !== "function" ||
      typeof port.collapse !== "function"
    )
      throw new Error("采集端口须提供 open / collapse");
    this.capturePort = port;
    return () => {
      if (this.capturePort === port) this.capturePort = null;
    };
  }
  getCapturePort() {
    return (
      this.capturePort ||
      this.app.plugins?.plugins?.["apex-dashboard"]?.unifiedCapture
    );
  }
  async startHost() {
    if (this.host) return;
    const electron = require("electron");
    const remote = electron.remote || require("@electron/remote");
    if (!remote?.require || !remote.getCurrentWindow)
      throw new Error("当前 Obsidian 没有可用的原生桥；桌面入口未启动");
    const base = this.app.vault.adapter.getBasePath?.();
    if (!base) throw new Error("仅支持本机桌面 Vault");
    const dir = path.resolve(
      base,
      this.manifest.dir ||
        path.join(this.app.vault.configDir, "plugins", this.manifest.id),
    );
    const localRoot = process.env.LOCALAPPDATA;
    if (!localRoot) throw new Error("Windows 本机状态目录不可用");
    const vaultId = createHash("sha256")
      .update(base)
      .digest("hex")
      .slice(0, 16);
    this.detachPort = attachCapturePort(electron.ipcRenderer, () =>
      this.getCapturePort(),
    );
    try {
      const factory = remote.require(path.join(dir, "native.cjs"));
      this.host = factory.createHostedEntry({
        ownerId: remote.getCurrentWindow().id,
        assets: path.join(dir, "ui"),
        settingsPath: path.join(
          localRoot,
          "ApexDesktopEntry",
          vaultId,
          "settings.json",
        ),
        hotkeys: localHotkeys(this.app),
      });
      await this.host.start();
      this.lastError = "";
    } catch (e) {
      this.stopHost();
      throw e;
    }
  }
  stopHost() {
    try {
      this.host?.dispose();
    } finally {
      this.host = null;
      this.detachPort?.();
      this.detachPort = null;
    }
  }
  async enable() {
    await this.startHost();
    this.config.enabled = true;
    await this.saveData(this.config);
  }
  async disable() {
    this.stopHost();
    this.config.enabled = false;
    await this.saveData(this.config);
  }
  onunload() {
    this.stopHost();
    this.capturePort = null;
  }
};
class EntrySettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const p = this.plugin;
    containerEl.createEl("h2", { text: "桌面采集入口" });
    containerEl.createEl("p", {
      text: "悬浮球随 Obsidian 运行，完全退出后停止。本模块不启用系统自启动或托盘常驻。",
    });
    new Setting(containerEl)
      .setName("启用桌面入口")
      .setDesc("停用只清理悬浮球和本模块快捷键。")
      .addToggle((t) =>
        t.setValue(Boolean(p.host)).onChange(async (enabled) => {
          try {
            if (enabled) await p.enable();
            else await p.disable();
          } catch (e) {
            p.lastError = e.message;
          }
          this.display();
        }),
      );
    new Setting(containerEl).setName("恢复悬浮球").addButton((b) =>
      b
        .setButtonText("显示")
        .setDisabled(!p.host)
        .onClick(() => p.host.showOrb()),
    );
    let candidate = p.host?.snapshot().shortcut || "";
    new Setting(containerEl)
      .setName("全局快捷键")
      .setDesc(
        "默认 Control+Shift+Space。清空后应用可停用。先检查本机与 Obsidian 冲突。",
      )
      .addText((t) => t.setValue(candidate).onChange((v) => (candidate = v)))
      .addButton((b) =>
        b
          .setButtonText("应用")
          .setDisabled(!p.host)
          .onClick(() => {
            const result = p.host.setShortcut(candidate, localHotkeys(p.app));
            if (!result.ok) new Notice(result.message);
            this.display();
          }),
      );
    const state = p.host?.snapshot();
    const issue = p.lastError || state?.error;
    if (issue) containerEl.createEl("p", { text: issue });
    if (!p.getCapturePort())
      containerEl.createEl("p", {
        text: "统一采集端口尚未接入：菜单可显示，选择类型会明确报告不可用。",
      });
  }
}
