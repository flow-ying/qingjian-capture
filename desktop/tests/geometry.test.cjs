"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  restorePosition,
  dockPosition,
  dragResult,
} = require("../src/geometry.cjs");
const primary = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
};
const left = {
  id: 2,
  workArea: { x: -1280, y: 0, width: 1280, height: 984 },
  scaleFactor: 1.25,
};
test("lost monitor restores entire orb inside primary work area", () => {
  const p = restorePosition({ x: -1200, y: 900, displayId: 2 }, [primary]);
  assert.ok(p.x >= 0 && p.x + 56 <= 1920 && p.y >= 0 && p.y + 56 <= 1040);
});
test("negative monitor origins are retained", () => {
  const p = restorePosition({ x: -900, y: 500, displayId: 2 }, [primary, left]);
  assert.equal(p.x, -900);
  assert.equal(p.y, 500);
  assert.equal(p.displayId, 2);
});
test("scaling/work area changes preserve proportional location", () => {
  const p = restorePosition(
    { x: 932, y: 492, displayId: 1, workArea: primary.workArea },
    [
      {
        ...primary,
        workArea: { x: 0, y: 0, width: 1280, height: 680 },
        scaleFactor: 1.5,
      },
    ],
  );
  assert.equal(p.x, 612);
  assert.equal(p.y, 312);
});
test("corrupt saved coordinates cannot escape screen", () => {
  const p = restorePosition({ x: Infinity, y: "bad" }, [primary]);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});
test("dock keeps a visible strip on the chosen monitor", () => {
  const p = dockPosition({ x: -1275, y: 400 }, left);
  assert.equal(p.dock, "left");
  assert.equal(p.x, -1280);
  assert.equal(dockPosition({ x: -60, y: 400 }, left).dock, "right");
});
test("drag out and back suppresses click based on maximum travel", () => {
  assert.equal(
    dragResult({ x: 100, y: 100 }, { x: 101, y: 101 }, 90).click,
    false,
  );
  assert.equal(
    dragResult({ x: 100, y: 100 }, { x: 101, y: 101 }, 0).click,
    true,
  );
});
