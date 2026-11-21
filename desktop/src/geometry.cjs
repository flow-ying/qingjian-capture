"use strict";
const SIZE = 56,
  STRIP = 20,
  THRESHOLD = 7;
const clamp = (n, min, max) =>
  Math.round(Math.max(min, Math.min(n, Math.max(min, max))));
const finite = (n, fallback) =>
  typeof n === "number" && Number.isFinite(n) ? n : fallback;
function restorePosition(saved = {}, displays) {
  if (!displays.length) throw new Error("没有可用显示器");
  const display = displays.find((d) => d.id === saved.displayId) || displays[0],
    a = display.workArea;
  let x = finite(saved.x, a.x + a.width - SIZE - 24),
    y = finite(saved.y, a.y + 120);
  const old = saved.workArea;
  if (
    old &&
    display.id === saved.displayId &&
    old.width > SIZE &&
    old.height > SIZE
  ) {
    x = a.x + ((x - old.x) / (old.width - SIZE)) * (a.width - SIZE);
    y = a.y + ((y - old.y) / (old.height - SIZE)) * (a.height - SIZE);
  }
  const dock = ["left", "right"].includes(saved.dock) ? saved.dock : null;
  if (dock) x = dock === "left" ? a.x : a.x + a.width - SIZE;
  return {
    x: clamp(x, a.x, a.x + a.width - SIZE),
    y: clamp(y, a.y, a.y + a.height - SIZE),
    dock,
    displayId: display.id,
    workArea: { ...a },
  };
}
function dockPosition(p, display) {
  const a = display.workArea;
  let dock = null;
  if (p.x - a.x <= 24) dock = "left";
  else if (a.x + a.width - (p.x + SIZE) <= 24) dock = "right";
  return restorePosition({ ...p, dock, displayId: display.id }, [display]);
}
function dragResult(start, end, maxDistance = 0) {
  const distance = Math.max(
    maxDistance,
    Math.hypot(end.x - start.x, end.y - start.y),
  );
  return { click: distance < THRESHOLD, distance };
}
function visibleBounds(position, menu = false) {
  const a = position.workArea;
  if (menu)
    return {
      x: clamp(position.x, a.x, a.x + a.width - 224),
      y: clamp(position.y, a.y, a.y + a.height - 410),
      width: 224,
      height: 410,
    };
  // Windows may enforce a larger native minimum width; shape the hit region instead.
  return { x: position.x, y: position.y, width: SIZE, height: SIZE };
}
function windowShape(position, menu = false) {
  return !menu && position.dock
    ? [
        {
          x: position.dock === "right" ? SIZE - STRIP : 0,
          y: 0,
          width: STRIP,
          height: SIZE,
        },
      ]
    : [];
}
module.exports = {
  SIZE,
  STRIP,
  THRESHOLD,
  restorePosition,
  dockPosition,
  dragResult,
  visibleBounds,
  windowShape,
};
