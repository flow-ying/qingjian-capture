"use strict";
// Main-to-renderer requests use an explicit reply; remote callbacks cannot return values.
function attachCapturePort(ipcRenderer, getPort) {
  const listener = async (_event, request) => {
    if (
      !request ||
      typeof request.channel !== "string" ||
      !request.channel.startsWith("apex-desktop-entry:host:") ||
      typeof request.id !== "string"
    )
      return;
    try {
      const port = getPort();
      if (
        !port ||
        typeof port.open !== "function" ||
        typeof port.collapse !== "function"
      )
        throw new Error("统一采集模块未接入或已停用");
      if (
        request.action === "open" &&
        ["task", "issue", "idea", "link", "note"].includes(request.type)
      )
        await port.open({ type: request.type });
      else if (request.action === "collapse") await port.collapse();
      else throw new Error("未知采集请求");
      ipcRenderer.send(request.channel, { id: request.id, ok: true });
    } catch (e) {
      ipcRenderer.send(request.channel, {
        id: request.id,
        ok: false,
        message: e.message,
      });
    }
  };
  ipcRenderer.on("apex-desktop-entry:request", listener);
  return () =>
    ipcRenderer.removeListener("apex-desktop-entry:request", listener);
}
module.exports = { attachCapturePort };
