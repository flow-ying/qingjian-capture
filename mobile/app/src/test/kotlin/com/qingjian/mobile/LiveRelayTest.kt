package com.qingjian.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Base64

/**
 * Opt-in live check of the REAL Kotlin client (Store + SyncEngine + UrlHttp) against the deployed relay.
 * Runs only via scripts/live-relay-check.sh, which injects tokens through the environment (never printed)
 * and purges deviceId `qingjian-mobile-e2e` afterwards. The test plays the desktop role itself
 * (pull + ack), so nothing is ever written to a real Daily note.
 */
class LiveRelayTest {
    private val url = System.getenv("QJ_LIVE_URL") ?: ""
    private val deviceToken = System.getenv("QJ_LIVE_DEVICE_TOKEN") ?: ""
    private val desktopToken = System.getenv("QJ_LIVE_DESKTOP_TOKEN") ?: ""
    private val fixture = System.getenv("QJ_LIVE_FIXTURE") ?: ""
    private val http = UrlHttp()
    private val device = "qingjian-mobile-e2e"
    private val log = mutableListOf<String>()

    private fun step(name: String, ok: Boolean, detail: String = "") { log += (if (ok) "PASS " else "FAIL ") + name + (if (detail.isNotEmpty()) " — $detail" else ""); println(log.last()); assertTrue(name + " " + detail, ok) }

    private fun desktopPullMine(): List<JSONObject> {
        val r = http.request("GET", "$url/desktop/pull?limit=50", desktopToken)
        assertEquals(200, r.code)
        val ops = r.json().getJSONArray("ops")
        return (0 until ops.length()).map { ops.getJSONObject(it) }.filter { it.optString("deviceId") == device }
    }

    private fun ack(vararg acks: JSONObject): JSONObject {
        val r = http.request("POST", "$url/desktop/ack", desktopToken, JSONObject().put("acks", JSONArray(acks.toList())).toString().toByteArray(), "application/json")
        assertEquals(200, r.code); return r.json()
    }

    private fun landed(op: JSONObject) = JSONObject().put("opId", op.getString("opId")).put("state", "landed")
        .put("revision", op.getInt("revision")).put("digest", op.getJSONObject("envelope").getString("digest"))
        .put("blockHash", "e2e".padEnd(64, '0').replace(Regex("[^0-9a-f]"), "0")).put("path", "00_Inbox/Daily/2026-11-20.md")

    private fun rawGet(u: String, token: String): Pair<Int, ByteArray> {
        val c = java.net.URL(u).openConnection() as java.net.HttpURLConnection
        c.setRequestProperty("Authorization", "Bearer $token")
        return try { val code = c.responseCode; code to ((if (code >= 400) c.errorStream else c.inputStream)?.use { it.readBytes() } ?: ByteArray(0)) } finally { c.disconnect() }
    }

    private fun statusOf(store: Store, id: String) = (0 until store.recordViews().length()).map { store.recordViews().getJSONObject(it) }.firstOrNull { it.getString("id") == id }

    @Test fun liveRoundTrip() {
        assumeTrue("live check not requested", url.isNotEmpty() && deviceToken.isNotEmpty() && desktopToken.isNotEmpty() && File(fixture).isFile)
        val fx = JSONObject(File(fixture).readText())
        val dir = Files.createTempDirectory("qj-live").toFile()
        val store = Store(dir)
        val engine = SyncEngine(store, http, { SyncConfig(url, deviceToken, device) })
        val hash = fx.getString("hash")
        File(store.attDir, hash).writeBytes(Base64.getDecoder().decode(fx.getString("image")))
        val a1 = fx.getJSONObject("a1"); val a2 = fx.getJSONObject("a2"); val a3 = fx.getJSONObject("a3")
        val b1 = fx.getJSONObject("b1"); val c1 = fx.getJSONObject("c1")
        val aId = a1.getString("id")

        // 0) pairing test
        val t = engine.test(SyncConfig(url, deviceToken, device))
        step("配对测试 /health（device 角色、协议 v1）", t.optBoolean("ok") && t.optInt("protocol") == 1, t.toString())
        val wrongRole = engine.test(SyncConfig(url, desktopToken, device))
        step("desktop Token 填进手机被识别为角色不符", !wrongRole.optBoolean("ok"), wrongRole.optString("message"))

        // 1) new capture with image → queued
        store.enqueueUpsert(a1)
        var r = engine.flush(forceProjects = true)
        step("图片先传 + 投递 upsert → 🟡 queued", r.online && r.sent == 1 && statusOf(store, aId)?.getString("status") == "queued", r.toString())
        val (dlCode, dlBytes) = rawGet("$url/desktop/attachments/$hash", desktopToken)
        step("电脑端可下载到同一附件（SHA-256 一致）", dlCode == 200 && FakeRelay.sha(dlBytes) == hash, "HTTP $dlCode, ${dlBytes.size} B")

        // 2) desktop lands it → 🟢, relay purges the image
        val p1 = desktopPullMine()
        step("电脑拉取到本条且信封原样转发", p1.size == 1 && p1[0].getJSONObject("envelope").getString("digest") == a1.getString("digest"))
        ack(landed(p1[0]))
        r = engine.flush()
        step("状态轮询 → 🟢 landed", statusOf(store, aId)?.getString("status") == "landed", r.toString())
        step("落盘后云端附件立即清除", http.request("GET", "$url/desktop/attachments/$hash", desktopToken).code == 404)

        // 3) edit landed record → re-upload purged image → land rev2
        store.enqueueUpsert(a2)
        r = engine.flush()
        step("回改 rev2：自动补传已被清理的图片并投递", r.sent == 1 && statusOf(store, aId)?.getString("status") == "queued", r.toString())
        val p2 = desktopPullMine()
        step("电脑收到 rev2 且 previousDigest 链接 rev1", p2.size == 1 && p2[0].getInt("revision") == 2 && p2[0].getJSONObject("envelope").getString("previousDigest") == a1.getString("digest"))
        ack(landed(p2[0])); engine.flush()
        step("rev2 → 🟢 landed（第 2 版）", statusOf(store, aId)?.let { it.getString("status") == "landed" && it.getInt("revision") == 2 } == true)

        // 4) desktop refuses rev3 (hand-edited in Obsidian) → 🟠 conflict with reason
        store.enqueueUpsert(a3); engine.flush()
        val p3 = desktopPullMine()
        ack(JSONObject().put("opId", p3.single().getString("opId")).put("state", "conflict").put("error", "原笔记中的记录已修改或移除，请打开原笔记处理"))
        engine.flush()
        val va = statusOf(store, aId)!!
        step("电脑拒绝覆盖 → 🟠 conflict 并带中文原因", va.getString("status") == "conflict" && va.getString("error").contains("原笔记"), va.optString("error"))

        // 5) delete before the desktop pulled → relay cancels immediately
        store.enqueueUpsert(b1); engine.flush()
        store.enqueueDelete(b1.getString("id")); r = engine.flush()
        step("未落盘即删除：中转直接取消并从最近记录移除", statusOf(store, b1.getString("id")) == null, r.toString())

        // 6) delete a landed record → queued for desktop → deleted
        store.enqueueUpsert(c1); engine.flush()
        ack(landed(desktopPullMine().single())); engine.flush()
        store.enqueueDelete(c1.getString("id")); engine.flush()
        step("已落盘删除：排队等电脑确认（🟡 删除待确认）", statusOf(store, c1.getString("id"))?.getString("status") == "deleting")
        val pd = desktopPullMine().single()
        step("电脑收到 delete（targetRevision/expectedDigest 正确）", pd.getString("kind") == "delete" && pd.getJSONObject("target").getString("expectedDigest") == c1.getString("digest"), pd.toString())
        ack(JSONObject().put("opId", pd.getString("opId")).put("state", "deleted").put("path", "00_Inbox/Daily/2026-11-20.md"))
        engine.flush()
        step("电脑确认删除 → 从最近记录移除", statusOf(store, c1.getString("id")) == null)

        // 7) project list fetch (device is read-only; desktop never synced → cache untouched)
        val proj = http.request("GET", "$url/meta/projects", deviceToken)
        step("活跃项目清单 GET 可读", proj.code == 200, "updatedAt=" + proj.json().opt("updatedAt"))
        step("电脑未同步过项目时本机不写入空缓存", proj.json().isNull("updatedAt") == (store.pref("projects") == null))

        step("队列清空：本机无待传、无 🟡", store.pendingCount() == 0 && !store.hasActive())
        File(System.getenv("QJ_LIVE_REPORT") ?: File(dir, "report.txt").path).writeText(log.joinToString("\n"))
    }
}
