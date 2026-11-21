package com.qingjian.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Minimal HTTP abstraction so the protocol logic is unit-testable without Android. */
interface Http {
    class Resp(val code: Int, val body: String) {
        fun json(): JSONObject = try { JSONObject(body) } catch (_: Exception) { JSONObject() }
    }
    /** Throws IOException on network failure. */
    fun request(method: String, url: String, token: String, body: ByteArray? = null, contentType: String? = null): Resp
}

data class SyncConfig(val baseUrl: String, val token: String, val deviceId: String)

data class SyncResult(
    val configured: Boolean,
    val online: Boolean,
    val authError: String? = null,
    val sent: Int = 0,
    val polled: Int = 0,
    val unsent: Int = 0,
    val active: Boolean = false,
    val projectsUpdated: Boolean = false,
)

/**
 * Protocol v1 client (mobile-capture-relay docs/protocol.md §4):
 * strictly in-order, at-least-once delivery — attachments first (PUT /attachments/{sha256}), then
 * POST /ops reusing the persisted opId; status polling via GET /ops/status; project list via
 * GET /meta/projects. Network/5xx/429 errors stop the pass and keep everything queued (⚪);
 * 4xx refusals become a visible 🟠 `rejected` state instead of retrying forever.
 */
class SyncEngine(private val store: Store, private val http: Http, private val config: () -> SyncConfig?, private val clock: () -> Long = System::currentTimeMillis) {
    private val lock = Any()

    fun flush(forceProjects: Boolean = false): SyncResult = synchronized(lock) {
        val cfg = config() ?: return SyncResult(configured = false, online = false, unsent = store.pendingCount(), active = store.hasActive())
        val base = cfg.baseUrl.trimEnd('/')
        var online = false; var sent = 0; var polled = 0; var authError: String? = null; var projectsUpdated = false
        try {
            // 1) push queued ops in order
            val blocked = mutableSetOf<String>()
            loop@ for (op in store.unsentOps()) {
                val opId = op.getString("opId")
                val captureId = op.getString("captureId")
                // Strict per-record order: never send revision N+1 / delete after revision N was refused.
                if (captureId in blocked) { store.reject(opId, "前一版本被拒收，本操作已停止"); continue@loop }
                if (op.optString("kind") == "upsert") {
                    val uploaded = op.getJSONArray("uploaded").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
                    val hashes = op.getJSONArray("hashes").let { a -> (0 until a.length()).map { a.getString(it) } }
                    for (h in hashes.distinct()) {
                        if (h in uploaded) continue
                        val f = File(store.attDir, h)
                        if (!f.isFile) { store.reject(opId, "本机图片文件缺失，无法上传"); blocked += captureId; continue@loop }
                        val r = http.request("PUT", "$base/attachments/$h", cfg.token, f.readBytes(), "application/octet-stream")
                        online = true
                        when {
                            r.code == 200 || r.code == 201 -> store.markUploaded(opId, h)
                            r.code == 401 || r.code == 403 -> { authError = authMessage(r); break@loop }
                            r.code == 507 -> { store.setLocalError(opId, "云端暂存空间已满，电脑落盘后自动重试"); break@loop }
                            r.code == 429 || r.code >= 500 -> { store.setLocalError(opId, "云端暂时繁忙（${r.code}），稍后重试"); break@loop }
                            else -> { store.reject(opId, "图片被云端拒收：" + errorText(r)); blocked += captureId; continue@loop }
                        }
                    }
                }
                val body = JSONObject().put("opId", opId).put("deviceId", cfg.deviceId).put("kind", op.getString("kind"))
                if (op.optString("kind") == "upsert") body.put("envelope", op.getJSONObject("envelope"))
                else body.put("captureId", op.getString("captureId")).put("targetRevision", op.getInt("revision")).put("expectedDigest", op.getString("digest"))
                store.markAttempted(opId)
                val r = http.request("POST", "$base/ops", cfg.token, body.toString().toByteArray(Charsets.UTF_8), "application/json")
                online = true
                val j = r.json()
                when {
                    r.code == 200 || r.code == 201 -> { store.applyServerOp(opId, j.optJSONObject("op") ?: JSONObject().put("state", "queued")); store.setLocalError(opId, null); sent++ }
                    r.code == 401 || r.code == 403 -> { authError = authMessage(r); break@loop }
                    r.code == 409 && j.optString("error") == "attachment-missing" -> { store.clearUploaded(opId); store.setLocalError(opId, "图片需重新上传"); break@loop }
                    r.code == 409 && j.optString("error") == "duplicate-revision" && j.has("existingOpId") -> {
                        // Same content already queued under an earlier opId (e.g. a lost response): track that one.
                        store.applyServerOp(opId, JSONObject().put("state", "queued"), j.getString("existingOpId")); sent++
                    }
                    r.code == 429 || r.code >= 500 -> { store.setLocalError(opId, "云端暂时繁忙（${r.code}），稍后重试"); break@loop }
                    else -> { store.reject(opId, rejectText(r)); blocked += captureId }
                }
            }
            // 2) poll statuses of 🟡 ops
            if (authError == null) {
                val active = store.activeOps()
                for (chunk in active.chunked(100)) {
                    val ids = chunk.map { it.optString("serverOpId").ifEmpty { it.getString("opId") } }
                    val r = http.request("GET", "$base/ops/status?ids=" + ids.joinToString(","), cfg.token)
                    online = true
                    if (r.code == 401 || r.code == 403) { authError = authMessage(r); break }
                    if (r.code != 200) break
                    val arr = r.json().optJSONArray("ops") ?: JSONArray()
                    for (i in 0 until arr.length()) {
                        val v = arr.getJSONObject(i)
                        val local = chunk.firstOrNull { it.getString("opId") == v.optString("opId") || it.optString("serverOpId") == v.optString("opId") } ?: continue
                        if (v.optString("state") != local.optString("state") || v.has("result") != local.has("result")) polled++
                        store.applyServerOp(local.getString("opId"), v)
                    }
                }
            }
            // 3) active #项目 list (cheap; refreshed at most every 10 minutes unless forced)
            if (authError == null) {
                val last = (store.pref("projectsAt") as? Number)?.toLong() ?: 0L
                if (forceProjects || clock() - last > 600_000) {
                    val r = http.request("GET", "$base/meta/projects", cfg.token)
                    online = true
                    if (r.code == 200) {
                        val arr = r.json().optJSONArray("projects") ?: JSONArray()
                        val slugs = JSONArray()
                        for (i in 0 until arr.length()) arr.optJSONObject(i)?.optString("slug")?.takeIf { it.isNotBlank() }?.let { slugs.put(it) }
                        val etag = r.json().optString("etag", "")
                        if (etag != store.prefString("projectsEtag")) projectsUpdated = true
                        // updatedAt=null means the desktop never synced yet: keep the last cached list.
                        if (r.json().has("updatedAt") && !r.json().isNull("updatedAt")) store.setPrefs(mapOf("projects" to slugs, "projectsEtag" to etag))
                        store.setPrefs(mapOf("projectsAt" to clock()))
                    }
                }
            }
        } catch (_: IOException) {
            // offline or TLS failure: everything stays queued locally
        }
        store.prune()
        return SyncResult(true, online && authError == null, authError, sent, polled, store.pendingCount(), store.hasActive(), projectsUpdated)
    }

    /** GET /health with explicit (possibly unsaved) settings. */
    fun test(cfg: SyncConfig): JSONObject = try {
        val r = http.request("GET", cfg.baseUrl.trimEnd('/') + "/health", cfg.token)
        val j = r.json()
        when {
            r.code == 200 && j.optString("role") == "device" -> JSONObject().put("ok", true).put("protocol", j.optInt("protocol")).put("role", "device")
                .put("message", if (j.optInt("protocol") != PROTOCOL) "协议版本不一致（服务端 v${j.optInt("protocol")}，本机 v$PROTOCOL）" else "")
            r.code == 200 -> JSONObject().put("ok", false).put("message", "这是 ${j.optString("role")} Token，移动端请使用 device Token")
            r.code == 401 || r.code == 403 -> JSONObject().put("ok", false).put("message", "Token 无效或角色不符")
            else -> JSONObject().put("ok", false).put("message", "服务器返回 ${r.code}：" + errorText(r))
        }
    } catch (e: IOException) {
        JSONObject().put("ok", false).put("message", "无法连接：" + (e.message ?: e.javaClass.simpleName))
    }

    private fun authMessage(r: Http.Resp) = if (r.code == 401) "Token 无效，请在设置里重新粘贴 device Token" else "Token 角色不符（需要 device Token）"
    private fun errorText(r: Http.Resp): String = r.json().let { j -> j.optString("message").ifEmpty { j.optString("error") }.ifEmpty { "HTTP ${r.code}" } }
    private fun rejectText(r: Http.Resp): String = when (r.json().optString("error")) {
        "revision-conflict" -> "云端已有该版本的不同内容（可能在另一台设备改过），请另存为新记录"
        "capture-deleted" -> "该记录已在云端删除"
        "delete-pending" -> "该记录的删除已在排队"
        "op-id-reused" -> "操作编号冲突，请另存为新记录"
        "digest-mismatch", "not-normalized", "invalid-envelope" -> "记录未通过云端校验：" + errorText(r)
        else -> "云端拒收（${r.code}）：" + errorText(r)
    }

    companion object { const val PROTOCOL = 1 }
}
