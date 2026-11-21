# 移动采集三端共享协议 v1（mobile-capture-relay）

> 唯一权威契约：Android 清笺移动版（`[工作台#20]`）、桌面清笺主进程（`[工作台#19]`）与云端中转服务（本目录 `relay_server.py`）共同遵守。改协议须同轮改三端并升 `protocol` 版本号。核验：`2026-11-19`，服务 `1.0.0`，`test_relay_server.py` 22 项（含与 `core.cjs` 双向 digest 对拍）+ 线上 HTTPS 联调 23/23。

## 1. 角色与数据流

```text
手机/平板（本机离线秒存 ⚪）
  └─ PUT 附件 → POST 操作 ─▶ 云端中转（🟡 queued/pulled，仅暂存）
                                └─ 电脑清笺 GET pull → 下载附件 → desktop-capture-bridge 单点写 Daily → POST ack
                                     └─ 中转标 landed/deleted/conflict，立刻物理删除附件副本 ─▶ 手机查状态（🟢/🟠）
```

- **基址**：`https://relay.example.com/mobile-capture/v1`（Caddy 精确路由，单请求体 `<= 9 MiB`；后端 `127.0.0.1:8941`）。
- **鉴权**：所有接口都要 `Authorization: Bearer <token>`。两枚独立 Token：`device`（手机/平板共用）与 `desktop`（电脑清笺），只存服务器 `/etc/qingjian-relay.env`（`0600 root`），本机经 `复制移动采集Token到剪贴板.cmd [device|desktop]` 取用，**严禁写入 Vault、源码、日志或交接**。
- **投递语义**：至少一次（at-least-once）。电脑端必须幂等落盘（`core.transition` 已具备：同 `revision+digest` 返回 `already`）。
- **时间**：响应时间戳为 JST ISO-8601（`+09:00`）。

## 2. 记录信封（与 `desktop-capture-orb-20260930/standalone/core.cjs` 完全一致）

手机端**必须用与 `core.cjs` 相同的 `payload()` / `envelope()` 逻辑生成信封**（建议直接打包复用该 JS 模块），中转只校验不改写：

```json
{
  "id": "<UUID v4，记录 captureId，永久不变>",
  "revision": 1,
  "date": "2026-11-19",
  "createdAt": "2026-11-19T09:30:00.123Z",
  "previousDigest": null,
  "payload": {
    "type": "note|diary|task|issue|idea|link",
    "body": "", "source": "", "thought": "", "due": "", "tags": "",
    "attachments": [{"id": "<UUID>", "name": "photo.jpg", "ext": ".jpg", "hash": "<sha256 hex>", "size": 12345}],
    "project": "工作台"
  },
  "digest": "<sha256(JSON.stringify(除 digest 外的信封))>"
}
```

- **键顺序即签名的一部分**：`id, revision, date, createdAt, previousDigest, payload`；`payload` 内 `type, body, source, thought, due, tags, attachments, project?`（`project` 为空时整个键省略）；附件内 `id, name, ext, hash, size`。
- **规范化**：文本须已是 `core.cjs text()` 结果（`\r\n→\n` 且首尾 trim）；`project` 去掉 `#`/`#项目/` 前缀；`idea` 的 `tags` 为 1–3 个 `#标签` 空格分隔；`due` 仅 `task` 可填 `YYYY-MM-DD`。未规范化返回 `400 not-normalized`，digest 不符返回 `400 digest-mismatch`。
- **版本链**：新建 `revision=1, previousDigest=null`；编辑 `revision=上次已落盘版本+1, previousDigest=上次 digest`，`date/createdAt` 沿用首版。手机须以 **最近一次 `landed` 回执** 为编辑基线。
- `deviceId` **不在信封内**（不参与 digest），放在操作外层。未知扩展字段会被中转丢弃，不转发。
- 附件：单张 `<= 8 MiB`（手机端先轻量压缩），单条 `<= 20` 个；电脑落盘路径沿用 `00_Inbox/Attachments/DesktopCapture/<date>/<attachment.id><ext>`。

## 3. 接口一览

| 方法与路径 | 角色 | 用途 | 成功 |
| --- | --- | --- | --- |
| `GET /health` | 两者 | 在线检查；`desktop` 另返回 `stats` | `200` |
| `PUT /attachments/{sha256}` | device | 上传附件原始字节（`Content-Length` 必填） | `201` 新建 / `200 already` |
| `POST /ops` | device | 投递 `upsert` 或 `delete` 操作 | `201` / `200 replayed` |
| `GET /ops/status?ids=a,b` | 两者 | 批量查 1–100 个 `opId` 状态 | `200` |
| `GET /meta/projects` | 两者 | 读取活跃 `#项目` 清单 | `200` |
| `PUT /meta/projects` | desktop | 覆盖写活跃项目清单 | `200` |
| `GET /desktop/pull?limit=20` | desktop | 拉取待处理操作（1–50，按投递顺序） | `200` |
| `GET /desktop/attachments/{sha256}` | desktop | 下载**仍在队列中**的附件 | `200` 字节流 |
| `POST /desktop/ack` | desktop | 批量回报 1–100 条执行回执 | `200` |

错误统一为 `{"ok":false,"error":"<code>","message":"..."}`；角色不符 `403 forbidden-role`，缺/错 Token `401`。

## 4. 手机端流程

1. **附件先行**：`PUT /attachments/{sha256}`，body 为压缩后的原始字节；URL 中哈希须等于内容 SHA-256（否则 `400 hash-mismatch`）。存储满返回 `507 storage-quota-exceeded`（总量 `<= 256 MiB`），保持 ⚪ 稍后重试。
2. **投递操作**：`POST /ops`
   - 新建/编辑：`{"opId":"<UUID v4>","deviceId":"my-phone","kind":"upsert","envelope":{...}}`
   - 删除已落盘：`{"opId":"<UUID>","deviceId":"my-tablet","kind":"delete","captureId":"<记录id>","targetRevision":<最近landed revision>,"expectedDigest":"<该版 digest>"}`
   - `opId` 由手机生成并持久化；网络重试**必须复用同一 opId 与同一内容**（返回 `replayed:true`）；同 opId 换内容 `409 op-id-reused`。
   - `deviceId` 规则 `^[a-z0-9][a-z0-9-]{0,39}$`（建议 `my-phone` / `my-tablet`）。
3. **状态点映射**（查询 `GET /ops/status`，建议前台每 15–60 s、有 🟡 时轮询）：

| `state` | 含义 | 手机状态点 |
| --- | --- | --- |
| （未投递成功） | 仅本机 | ⚪ 待上传 |
| `queued` / `pulled` | 已上云 / 电脑已取走未回执 | 🟡 已上云 |
| `landed` | 已写入 Daily，`result` 含 `revision/digest/blockHash/path` | 🟢 已落盘 |
| `deleted` | 已从 Daily 删除（或未拉走前由中转直接取消，`result.resolvedBy="relay"`） | 🟢（从最近记录移除） |
| `conflict` | 电脑端拒绝覆盖（原块被手工改过/前版本不符），`error` 说明原因 | 🟠 冲突 |
| `failed` | 电脑端判定信封永久无效 | 🟠 |
| `cancelled` | 该 upsert 在被电脑拉走前被本机删除取消 | 移除 |
| `expired` | 30 天未被电脑落盘，中转已清理 | 🟠（提示重新投递） |

4. **本机删除未落盘条目**：若该记录的所有操作仍为 `queued`（含 `revision=1`），删除操作由中转直接完结为 `deleted`，原 upsert 标 `cancelled` 并**立即删除附件**；否则排队交电脑端安全删除。
5. **常见 409**：`attachment-missing`（先补传 `hash`）、`duplicate-revision`（同版已在队列，返回 `existingOpId`）、`revision-conflict`（同版不同内容）、`capture-deleted`（记录已删）、`delete-pending`。`429 queue-full`：待处理 `> 1000` 条。

## 5. 电脑端流程

1. 循环 `GET /desktop/pull?limit=20`（建议在线时 30–60 s 一次，`more=true` 立即续拉）。返回 `ops[]`：`{opId, seq, deviceId, kind, captureId, revision, state, createdAt, envelope | target}`。已拉未回执的操作会**重复下发**，直至 ack。
2. **同一 `captureId` 必须按 `seq` 顺序处理**；前一条失败/冲突时，后续同记录操作也应回报 `conflict`，不得越序。
3. `upsert`：按 `envelope.payload.attachments[].hash` 调 `GET /desktop/attachments/{hash}` 下载并**自行复核 SHA-256**，写入附件路径后交 `desktop-capture-bridge` `submit(envelope)`（`core.validate` + `transition` 防覆盖）。
4. `delete`：桥接核对 `receipts[captureId]` 的 `revision/digest` 等于 `target.targetRevision/expectedDigest`，且原块哈希等于回执 `blockHash`（未被手工改动）后整块连带删图；不符回 `conflict`。
5. `POST /desktop/ack`：`{"acks":[...]}`，每项：
   - 落盘：`{"opId","state":"landed","revision","digest","blockHash","path"}`（`revision/digest` 必须等于该操作信封，`path` 为 Vault 相对路径）
   - 删除：`{"opId","state":"deleted","path?"}`
   - 冲突/失败：`{"opId","state":"conflict"|"failed","error":"<=500字","revision?","digest?","blockHash?"}`（可附电脑端当前版本供手机提示）
   - 响应 `results[]` 逐项给 `ok/state/replayed` 或 `error`（如 `already-terminal`、`invalid-ack`）；同状态重复 ack 视为 `replayed`。
6. **活跃项目同步**：电脑端在项目清单变化时 `PUT /meta/projects {"projects":[{"slug":"工作台","title":"可选"}]}`（`<= 200` 项，slug 规则同 `core.cjs` project：无空格/`#`/`[]|<>`，`<= 60`）；手机 `GET` 获得 `projects/etag/updatedAt`，`updatedAt=null` 表示电脑尚未同步过。

## 6. 零图床与滚动清理（服务端保证）

- 操作进入终态（`landed/deleted/conflict/failed/cancelled/expired`）时，**该操作引用且不再被任何待处理操作引用的附件立即物理删除**；电脑端只能下载仍在队列中的附件。
- 未被任何操作引用的孤儿上传 24 h 后清理；待处理操作 30 天未落盘转 `expired` 并删附件；终态元数据保留 30 天且最多 500 条滚动清理；每 10 分钟后台 GC，残留临时文件 1 h 后清理。
- 附件目录总量硬上限 `256 MiB`，超限 `507`。

## 7. 兼容与变更

- 新增可选响应字段不升版本；改信封、状态机或接口语义须升 `protocol`（`/health` 返回）并同轮更新 #19/#20 实现。
- 已知边界：两台移动设备共用 `device` Token，`deviceId` 为自报字段（个人使用可接受）；中转不做内容审查，最终校验以桌面 `core.validate` 为准。
