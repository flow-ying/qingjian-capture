"use strict";
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "dist", "apex-desktop-entry");
fs.mkdirSync(out, { recursive: true });
for (const [entry, filename] of [
  ["src/obsidian-plugin.cjs", "main.js"],
  ["src/native-bootstrap.cjs", "native.cjs"],
])
  esbuild.buildSync({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(out, filename),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["obsidian", "electron", "@electron/remote"],
    logLevel: "warning",
  });
fs.cpSync(path.join(root, "ui"), path.join(out, "ui"), { recursive: true });
fs.copyFileSync(
  path.join(root, "manifest.json"),
  path.join(out, "manifest.json"),
);
const files = [
  "main.js",
  "native.cjs",
  "manifest.json",
  "ui/index.html",
  "ui/preload.cjs",
  "ui/renderer.js",
  "ui/style.css",
];
const hashes = Object.fromEntries(
  files.map((f) => [
    f,
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(out, f)))
      .digest("hex"),
  ]),
);
fs.writeFileSync(
  path.join(out, "SHA256SUMS.json"),
  JSON.stringify(hashes, null, 2),
);
console.log(JSON.stringify({ output: out, files: files.length }));
