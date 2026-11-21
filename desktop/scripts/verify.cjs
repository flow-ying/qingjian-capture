"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  artifacts = path.join(root, "artifacts");
const files = fs
  .readdirSync(path.join(root, "tests"))
  .filter((f) => f.endsWith(".test.cjs"))
  .map((f) => "tests/" + f);
const unit = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", ...files],
  { cwd: root, encoding: "utf8" },
);
fs.writeFileSync(
  path.join(artifacts, "unit-results.tap"),
  unit.stdout + unit.stderr,
);
if (unit.status !== 0)
  throw new Error("Unit tests failed; see unit-results.tap");
const windows = JSON.parse(
  fs.readFileSync(path.join(artifacts, "windows-results.json"), "utf8"),
);
if (
  !windows.complete ||
  !windows.cleanup?.normalExit ||
  windows.cleanup.exitCode !== 0
)
  throw new Error("Windows verification or normal exit did not pass");
const hashes = JSON.parse(
  fs.readFileSync(
    path.join(root, "dist/apex-desktop-entry/SHA256SUMS.json"),
    "utf8",
  ),
);
for (const [file, expected] of Object.entries(hashes)) {
  if (windows.artifactHashes?.[file] !== expected)
    throw new Error(
      "Windows evidence belongs to a different artifact: " + file,
    );
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, "dist/apex-desktop-entry", file)))
    .digest("hex");
  if (actual !== expected) throw new Error("Artifact changed: " + file);
}
for (const name of fs.readdirSync(path.join(root, "src"))) {
  const content = fs.readFileSync(path.join(root, "src", name), "utf8");
  if (
    /setInterval|setLoginItemSettings|unregisterAll|getMarkdownFiles/.test(
      content,
    )
  )
    throw new Error("Unexpected broad operation: " + name);
}
const result = {
  verifiedAt: new Date().toISOString(),
  unitTests: Number(unit.stdout.match(/# pass ([0-9]+)/)?.[1] || 0),
  windowsChecks: windows.tests.length,
  windowsNormalExit: windows.cleanup,
  artifactHashes: hashes,
  deployed: false,
  unverified: [
    "Real Obsidian loading and capture provider integration",
    "Physical multi-monitor unplug/replug and OS scaling changes",
    "Continuous browser/PDF/IDE workflow and IME",
    "Exclusive fullscreen, secure desktop and elevated apps",
  ],
};
fs.writeFileSync(
  path.join(artifacts, "verification.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
