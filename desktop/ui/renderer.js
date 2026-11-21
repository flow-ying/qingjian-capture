"use strict";
const orb = document.querySelector("#orb"),
  menu = document.querySelector("#menu");
let pointer = null,
  keyboard = false;
function render(s) {
  orb.hidden = s.menu;
  menu.hidden = !s.menu;
  document.body.classList.toggle("docked", Boolean(s.position.dock));
  document.body.classList.toggle("dock-right", s.position.dock === "right");
  const main = document.querySelector("#main");
  main.textContent = s.mainVisible ? "隐藏主窗口" : "显示 Obsidian 主窗口";
  main.dataset.action = s.mainVisible ? "hide-main" : "show-main";
  document.querySelector("#recovery").textContent = s.shortcut
    ? "恢复入口：" + s.shortcut + "，或 Obsidian 命令"
    : "恢复入口：Obsidian 命令「显示悬浮球」";
  const error = document.querySelector("#error");
  error.textContent = s.error;
  error.hidden = !s.error;
  for (const button of document.querySelectorAll("[data-type]"))
    button.disabled = s.opening;
  if (s.menu && s.keyboard && !keyboard)
    document.querySelector("[data-type]").focus();
  keyboard = s.menu && s.keyboard;
}
async function send(action, args) {
  try {
    const result = await window.entry.send(action, args);
    if (result.state) render(result.state);
  } catch (error) {
    document.querySelector("#error").textContent = error.message;
    document.querySelector("#error").hidden = false;
  }
}
window.entry.onState(render);
send("state");
orb.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  pointer = e.pointerId;
  orb.setPointerCapture(pointer);
  send("drag-start");
});
orb.addEventListener("pointermove", () => {
  if (pointer !== null) send("drag-move");
});
orb.addEventListener("pointerup", (e) => {
  if (pointer !== e.pointerId) return;
  pointer = null;
  send("drag-end");
});
orb.addEventListener("pointercancel", () => {
  if (pointer === null) return;
  pointer = null;
  send("drag-cancel");
});
document.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (button?.dataset.type) send("open", button.dataset.type);
  else if (button?.dataset.action) send(button.dataset.action);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    send("close-menu");
  }
});
