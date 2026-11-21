# qingjian-capture (清笺三端采集套件)

[English](#english) | [中文](#中文)

---

<a id="english"></a>
## English

A **3-end instant capture suite for Obsidian** (`Desktop Floating Orb + Android Quick Capture Shell + Lightweight Relay`), engineered so you can jot down thoughts, links, and compressed photos offline in under a second without opening Obsidian — and land them safely into your Daily note with **zero silent overwrites**.

### Pain Points Solved

1. **Cold-start friction on mobile & desktop**: Opening a heavy Obsidian vault just to capture a fleeting thought or share link kills capture habit.
2. **Sync conflicts & orphaned attachments**: Traditional file-syncing mobile captures often overwrite desktop manual edits or leave orphan images behind.

### 3-End Architecture & State Machine

```text
  [ Mobile (Kotlin + WebView, AndroidKeyStore) ]
     │  1. Save locally first (⚪ Local)
     │  2. PUT compressed blobs + POST canonical envelope (🟡 Queued)
     ▼
  [ Relay (Python stdlib HTTP + SQLite WAL) ]  ──(256 MiB rolling cap, purge blobs on ack)
     │  3. GET /desktop/pull (at-least-once) + SHA-256 verification
     ▼
  [ Desktop Orb (Electron + DPAPI safeStorage) ] ──▶ [ Obsidian Bridge Plugin ] ──▶ Daily.md
     │  4. Verify blockHash before edit/delete (🟠 Conflict if hand-edited on desktop!)
     └──▶ POST /desktop/ack (🟢 Landed / Deleted) ──▶ Relay purges temporary attachments
```

### Key Engineering Highlights

- **Cross-Language Canonical Digest Parity**: Identical JSON key ordering and SHA-256 envelope hashing shared across Electron (`desktop/standalone/core.cjs`), Mobile (`mobile/app/src/main/assets/web/core.js`), and Python (`relay/relay_server.py`), guarded by cross-runtime parity tests.
- **Anti-Overwrite Protection (`blockHash` + Tombstones)**: Desktop bridge verifies the target block hash in `Daily.md` before applying mobile edits or deletions; hand-edited desktop blocks immediately reject overwriting with `🟠 conflict`, and deleted items leave tombstones to prevent stale replays.
- **Zero-Image-Host Relay**: Cloud relay acts purely as an encrypted-token transient queue (`<= 256 MiB`); once desktop acknowledges `landed`/`deleted`, temporary blobs are physically deleted.
- **Desktop Floating Edge Bookmark & Multi-Draft Slots**: Always-on-top edge strip, 5 curated palettes, up to 12 concurrent draft slots, and optional Task Graph float window.

### 3-Step Quick Start

1. **Run the Relay & Unit Tests** (Python 3.11+ stdlib only):
   ```bash
   cd relay
   python -m unittest test_relay_server.py
   # Deploy with relay/.env.example, relay/Caddyfile.example, and relay/qingjian-relay.service.example
   ```
2. **Run Desktop & Cross-End Parity Tests** (Node.js 20+):
   ```bash
   cd desktop
   node --test tests/standalone.test.cjs tests/standalone-bridge.test.cjs tests/mobile-sync.test.cjs tests/task-graph.test.cjs tests/graph-bounded.test.cjs tests/graph-status.test.cjs tests/geometry.test.cjs tests/port.test.cjs tests/shortcut.test.cjs tests/entry.test.cjs
   cd ../mobile
   node --test tests/*.test.mjs
   ```
3. **Build Desktop & Android Clients**:
   - Desktop: `cd desktop && npm install && npm run build:desktop` (set `QINGJIAN_RELAY_URL` or configure in tray menu).
   - Android: Configure `JAVA_HOME` / `ANDROID_HOME` (and optional `QJ_SIGNING_PROPS` for release signing), then `cd mobile && ./gradlew testDebugUnitTest assembleDebug`.

### License

[MIT](LICENSE)

---

<a id="中文"></a>
## 中文

**Obsidian 三端秒记与安全落盘套件**（`桌面清笺悬浮球 + Android 极薄原生壳 + 轻量云端中转`）：免开 Obsidian 即可在电脑与手机上 1 秒弹出速记小窗，离线队列永不丢失，由电脑端单点安全压图落盘至 `Daily.md`，并从协议层杜绝“手机覆盖电脑手工编辑”。

### 核心痛点

1. **启动太重**：临时记一句话或分享一个链接，等 Obsidian 加载完整库与插件往往错失灵感。
2. **多端冲突与附件残留**：普通同步方案难以处理手机端回改、撤回删图与电脑端手工精修之间的覆盖冲突。

### 三端数据流与状态机

```text
  [ 移动端（Kotlin 极薄壳 + Web UI，AndroidKeyStore 加密）]
     │  1. 本地原子落盘秒存（⚪ 待上传）
     │  2. PUT 压缩附件 + POST 规范信封（🟡 已上云）
     ▼
  [ 云端中转（纯 Python 标准库 HTTP + SQLite WAL）]  ──(<= 256 MiB 滚动清理，落盘即删临时附件)
     │  3. GET /desktop/pull（至少一次投递）+ SHA-256 校验
     ▼
  [ 桌面清笺（Electron + DPAPI safeStorage）] ──▶ [ Obsidian 采集桥 ] ──▶ Daily.md
     │  4. 写前核验 blockHash（若电脑已被手工改过，直接拒写报 🟠 需核对）
     └──▶ POST /desktop/ack（🟢 已落盘 / 已安全删块）──▶ 中转物理清除临时图片
```

### 工程亮点

- **跨语言三端 SHA-256 对拍**：桌面 Node（`desktop/standalone/core.cjs`）、移动 WebView（`mobile/app/src/main/assets/web/core.js`）与服务端 Python（`relay/relay_server.py`）严格保持相同的字段序列与哈希签名规则，并配套跨端自动化对拍测试。
- **防覆盖保护与墓碑防复活**：手机修改或删除已落盘条目时，桌面桥接校验 `revision/digest` 与原块 `blockHash`，任何手工编辑都会触发 `🟠 冲突保护`；安全删除还会同步清理无其他笔记引用的孤儿图片并留下墓碑防止旧请求复活。
- **零图床中转设计**：服务端不做长期图片存储，桌面端确认落盘后立即物理删图。
- **桌面贴边书签条与多草稿槽**：支持 5 套精选配色、最多 12 个并发草稿槽、一键识别链接标签以及独立任务图浮窗协议。

### 3 步快速上手

1. **运行云端中转测试**（零第三方依赖，仅 Python 3.11+ 标准库）：
   ```bash
   cd relay
   python -m unittest test_relay_server.py
   # 生产部署参考 relay/.env.example、relay/Caddyfile.example 与 relay/qingjian-relay.service.example
   ```
2. **运行桌面逻辑与三端对拍测试**（Node.js 20+）：
   ```bash
   cd desktop
   node --test tests/standalone.test.cjs tests/standalone-bridge.test.cjs tests/mobile-sync.test.cjs tests/task-graph.test.cjs tests/graph-bounded.test.cjs tests/graph-status.test.cjs tests/geometry.test.cjs tests/port.test.cjs tests/shortcut.test.cjs tests/entry.test.cjs
   cd ../mobile
   node --test tests/*.test.mjs
   ```
3. **构建桌面端与安卓端**：
   - 桌面端：`cd desktop && npm install && npm run build:desktop`（通过环境变量 `QINGJIAN_RELAY_URL` 或托盘菜单填入你的中转地址）。
   - 安卓端：配置好 `JAVA_HOME` / `ANDROID_HOME`（发布签名通过 `QJ_SIGNING_PROPS` 指定）后运行 `cd mobile && ./gradlew testDebugUnitTest assembleDebug`。

### 开源协议

[MIT](LICENSE)
