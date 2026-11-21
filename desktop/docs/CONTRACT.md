# Desktop entry v1

本模块独占目录为 desktop-capture-orb-20260930。只实现原生悬浮球、类型菜单、全局快捷键及窗口生命周期；不复制采集表单，不写 Daily，不读取剪贴板，不扫描 Vault。

## 采集端口

与邻接 unified-capture-window-20260930/docs/CONTRACT.md 的当前接口对齐：

```ts
type CaptureType = 'task' | 'issue' | 'idea' | 'link' | 'note';
interface CapturePort {
  open(request: { type: CaptureType }): void | Promise<void>;
  collapse(): void | Promise<void>;
}
```

只有显式点击菜单或按全局快捷键才调用 open；type 必须在白名单中。采集窗可以因这次主动操作获得焦点，主窗口不得随之 show/focus。采集模块未提供端口时返回明确错误，不回退到主窗口模态框。此模块的 dispose 不调用采集模块的 dispose；二者可独立停用。

## 宿主依赖

createDesktopEntry 注入 electron（BrowserWindow、ipcMain、screen、globalShortcut、app）、assets、capture、mainWindow 和仅保存本模块设置的 store。所有 Electron 能力必须来自同一 Obsidian 实例。正式运行不得启动外部 Electron/Node 进程。模拟宿主仅供临时验收，使用同一入口实现。

实例公开 start()、showOrb()、hideOrb()、openMenu()、openCapture(type)、hideMain()、showMain()、collapseCapture()、setShortcut(accelerator)、snapshot()、dispose()。start/dispose 幂等。主窗口隐藏、采集窗收起、悬浮球隐藏和应用退出分别处理。全局注册失败不覆盖已占用快捷键，也不调用 unregisterAll。

## 坐标及焦点

坐标统一为 DIP（屏幕缩放后的逻辑像素），拖动通过原生光标坐标计算。悬浮球为不可激活窗口，初始与恢复显示使用 showInactive。贴边收起保留可点击窄条，隐藏则不占屏幕；恢复入口为 Obsidian 命令和成功注册的全局快捷键。显示器事件触发位置修正，无空闲轮询。

## 集成责任

整合窗口负责提供 Obsidian 原生桥、注册恢复命令、安装发布目录及真实工作流验收。本窗口只交付独立产物和可审查补丁，不修改运行中的 .obsidian、公共配置、全局记忆或恢复包。自启动和托盘不在默认功能内，代码不启用它们。

## 已实现的正式桥

独立插件自动按需解析 app.plugins.plugins['apex-dashboard'].unifiedCapture，不要求用户手工绑定，不修改 Apex。native.cjs 经 Obsidian 既有 @electron/remote 在主进程加载；所有窗口与 IPC 处理器都在主进程执行。采集操作发给所属 Vault 的渲染进程并通过带编号的显式回执确认，避免 remote 反向回调不能返回结果的问题。入口窗口与宿主回执分别校验发送者及主 frame，不接受其他页面调用。

生产状态只包含本模块几何、可见性与快捷键，保存在 LOCALAPPDATA/ApexDesktopEntry 下；错误消息和采集正文不持久化。桥不可用或采集模块停用时明确报错，不生成替代表单。重新启用入口或采集模块不需要改其他模块来配合。
