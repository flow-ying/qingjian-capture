package com.qingjian.mobile

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Offline-first local store (pure JVM, unit-tested). Everything the user saves lands here first,
 * atomically (tmp + fsync + rename), before any network attempt — a dead network, a killed process or
 * a swiped-away window never loses a capture.
 *
 *  - `state.json`  : operation queue (`ops`) + recent records (`records`)
 *  - `drafts.json` : the multi-draft bundle exactly as the Web UI sends it
 *  - `prefs.json`  : non-secret settings (server URL, deviceId, palette, toggles, project cache)
 *  - `att/<sha256>`, `thumbs/<sha256>.jpg` : compressed attachments + thumbnails (kept while referenced,
 *    so an edit of an already-landed record can re-upload the image the relay already purged)
 *
 * Op states: local (not yet accepted by the relay) → queued/pulled → landed|deleted|conflict|failed|
 * cancelled|expired, plus `rejected` when the relay itself refused the op (4xx).
 */
class Store(private val dir: File, private val clock: () -> Long = System::currentTimeMillis) {
    private val stateFile = File(dir, "state.json")
    private val draftsFile = File(dir, "drafts.json")
    private val prefsFile = File(dir, "prefs.json")
    val attDir = File(dir, "att")
    val thumbDir = File(dir, "thumbs")
    private var state: JSONObject
    private var prefs: JSONObject

    init {
        dir.mkdirs(); attDir.mkdirs(); thumbDir.mkdirs()
        state = readJson(stateFile) ?: JSONObject().put("v", 1).put("seq", 0).put("ops", JSONArray()).put("records", JSONArray())
        prefs = readJson(prefsFile) ?: JSONObject()
    }

    // ------------------------------------------------------------------ prefs
    @Synchronized fun pref(key: String): Any? = if (prefs.has(key) && !prefs.isNull(key)) prefs.get(key) else null
    @Synchronized fun prefString(key: String, def: String = "") = prefs.optString(key, def)
    @Synchronized fun prefBool(key: String, def: Boolean) = if (prefs.has(key)) prefs.optBoolean(key, def) else def
    @Synchronized fun setPrefs(values: Map<String, Any?>) {
        for ((k, v) in values) if (v == null) prefs.remove(k) else prefs.put(k, v)
        writeJson(prefsFile, prefs)
    }

    // ------------------------------------------------------------------ drafts
    @Synchronized fun drafts(): JSONObject? = readJson(draftsFile)
    @Synchronized fun saveDrafts(bundle: JSONObject) {
        val items = bundle.optJSONArray("items") ?: throw IllegalArgumentException("草稿格式无效")
        if (items.length() > 12) throw IllegalArgumentException("最多 12 个草稿槽")
        writeJson(draftsFile, bundle)
    }

    // ------------------------------------------------------------------ queue
    private fun ops(): JSONArray = state.getJSONArray("ops")
    private fun records(): JSONArray = state.getJSONArray("records")
    private fun opList() = (0 until ops().length()).map { ops().getJSONObject(it) }
    private fun recordOf(id: String): JSONObject? = (0 until records().length()).map { records().getJSONObject(it) }.firstOrNull { it.optString("id") == id }
    private fun opsOf(id: String) = opList().filter { it.optString("captureId") == id }
    private fun persist() = writeJson(stateFile, state)
    private fun nextSeq(): Int { val s = state.optInt("seq") + 1; state.put("seq", s); return s }

    /** Queues a new capture (revision 1) or the next revision of an existing record. */
    @Synchronized fun enqueueUpsert(envelope: JSONObject): JSONObject {
        val id = envelope.optString("id")
        val revision = envelope.optInt("revision", -1)
        val digest = envelope.optString("digest")
        require(UUID_RE.matches(id) && revision >= 1 && HEX64.matches(digest)) { "记录信封无效" }
        val rec = recordOf(id)
        val view = rec?.let { viewOf(it) }
        if (rec == null) {
            require(revision == 1) { "该记录已不在本机最近列表中，请另存为新记录" }
        } else {
            require(view?.optString("status") != "deleting" && !rec.optBoolean("deleted")) { "该记录正在删除或已删除" }
            val cur = rec.getJSONObject("envelope")
            require(revision == cur.optInt("revision") + 1 && envelope.optString("previousDigest") == cur.optString("digest")) {
                "该记录已有更新版本，请从「最近」重新点修改"
            }
        }
        val hashes = JSONArray()
        val atts = envelope.getJSONObject("payload").optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until atts.length()) {
            val h = atts.getJSONObject(i).optString("hash")
            require(File(attDir, h).isFile) { "本机找不到图片文件，请重新添加图片" }
            hashes.put(h)
        }
        val now = clock()
        val op = JSONObject().put("opId", UUID.randomUUID().toString()).put("seq", nextSeq()).put("kind", "upsert")
            .put("captureId", id).put("revision", revision).put("digest", digest).put("envelope", envelope)
            .put("hashes", hashes).put("uploaded", JSONArray()).put("state", "local").put("attempted", false)
            .put("createdAt", now).put("updatedAt", now)
        ops().put(op)
        if (rec == null) records().put(JSONObject().put("id", id).put("envelope", envelope).put("updatedAt", now))
        else rec.put("envelope", envelope).put("updatedAt", now)
        persist()
        return op
    }

    /** Deletes a record: purely local if nothing ever left the phone, otherwise queues a safe delete. */
    @Synchronized fun enqueueDelete(id: String): JSONObject {
        val rec = recordOf(id) ?: throw IllegalArgumentException("记录不存在")
        val mine = opsOf(id)
        if (mine.isNotEmpty() && mine.all { it.optString("state") == "local" && !it.optBoolean("attempted") }) {
            removeOps { it.optString("captureId") == id }
            removeRecord(id)
            gcAttachments(); persist()
            return JSONObject().put("local", true)
        }
        require(viewOf(rec).optString("status") != "deleting") { "删除已在排队" }
        val env = rec.getJSONObject("envelope")
        val now = clock()
        val op = JSONObject().put("opId", UUID.randomUUID().toString()).put("seq", nextSeq()).put("kind", "delete")
            .put("captureId", id).put("revision", env.optInt("revision")).put("digest", env.optString("digest"))
            .put("hashes", JSONArray()).put("uploaded", JSONArray()).put("state", "local").put("attempted", false)
            .put("createdAt", now).put("updatedAt", now)
        ops().put(op)
        rec.put("updatedAt", now)
        persist()
        return JSONObject().put("local", false).put("opId", op.getString("opId"))
    }

    /** Forget a record that ended in a warning state (conflict/failed/rejected/expired). */
    @Synchronized fun forget(id: String) {
        val rec = recordOf(id) ?: return
        require(viewOf(rec).optBoolean("warn")) { "只有需核对的记录可以从本机移除" }
        removeOps { it.optString("captureId") == id && it.optString("state") != "local" }
        removeRecord(id); gcAttachments(); persist()
    }

    @Synchronized fun unsentOps(): List<JSONObject> = opList().filter { it.optString("state") == "local" }.sortedBy { it.optInt("seq") }
    @Synchronized fun activeOps(): List<JSONObject> = opList().filter { it.optString("state") in ACTIVE }
    @Synchronized fun markAttempted(opId: String) { opById(opId)?.put("attempted", true)?.put("updatedAt", clock()); persist() }
    @Synchronized fun markUploaded(opId: String, hash: String) { opById(opId)?.getJSONArray("uploaded")?.put(hash); persist() }
    @Synchronized fun clearUploaded(opId: String) { opById(opId)?.put("uploaded", JSONArray()); persist() }
    @Synchronized fun setLocalError(opId: String, error: String?) { opById(opId)?.let { if (error == null) it.remove("lastError") else it.put("lastError", error) }; persist() }
    private fun opById(opId: String) = opList().firstOrNull { it.optString("opId") == opId || it.optString("serverOpId") == opId }

    /** Applies the relay's view of an op (POST /ops response or GET /ops/status entry). */
    @Synchronized fun applyServerOp(localOpId: String, view: JSONObject, serverOpId: String? = null) {
        val op = opById(localOpId) ?: return
        if (serverOpId != null && serverOpId != op.optString("opId")) op.put("serverOpId", serverOpId)
        op.put("state", view.optString("state", op.optString("state")))
        if (view.has("error")) op.put("error", view.optString("error")) else op.remove("error")
        if (view.has("result")) op.put("result", view.get("result"))
        op.put("updatedAt", clock())
        if (op.optString("kind") == "delete" && op.optString("state") == "deleted") {
            recordOf(op.optString("captureId"))?.put("deleted", true)
        }
        persist()
    }

    @Synchronized fun reject(opId: String, error: String) {
        val op = opById(opId) ?: return
        op.put("state", "rejected").put("error", error).put("updatedAt", clock()); persist()
    }

    // ------------------------------------------------------------------ views
    /** Status of one record for the UI: derived from its newest non-cancelled op. */
    @Synchronized fun viewOf(rec: JSONObject): JSONObject {
        val env = rec.getJSONObject("envelope")
        val mine = opsOf(rec.optString("id")).filter { it.optString("state") != "cancelled" }.sortedBy { it.optInt("seq") }
        val last = mine.lastOrNull()
        var status = "local"; var error = ""
        if (last != null) {
            val s = last.optString("state")
            val del = last.optString("kind") == "delete"
            status = when {
                del && (s == "local" || s in ACTIVE) -> "deleting"
                del && s == "deleted" -> "deleted"
                s == "local" -> if (last.optBoolean("attempted")) "sending" else "local"
                else -> s
            }
            error = last.optString("error", "").let { if (del && it.isNotEmpty()) "删除未完成：$it" else it }
            if (status == "local" || status == "sending") error = last.optString("lastError", "")
        }
        val warn = status in WARN
        return JSONObject().put("id", rec.optString("id")).put("date", env.optString("date")).put("createdAt", env.optString("createdAt"))
            .put("revision", env.optInt("revision")).put("digest", env.optString("digest")).put("payload", env.getJSONObject("payload"))
            .put("status", status).put("error", error).put("warn", warn).put("updatedAt", rec.optLong("updatedAt"))
    }

    @Synchronized fun recordViews(): JSONArray {
        val out = JSONArray()
        (0 until records().length()).map { records().getJSONObject(it) }
            .filter { !it.optBoolean("deleted") }
            .sortedByDescending { it.optLong("updatedAt") }
            .map { viewOf(it) }.filter { it.optString("status") != "deleted" }
            .forEach { out.put(it) }
        return out
    }

    @Synchronized fun pendingCount(): Int = opList().count { it.optString("state") == "local" }
    @Synchronized fun hasActive(): Boolean = opList().any { it.optString("state") in ACTIVE }

    // ------------------------------------------------------------------ housekeeping
    /** Drops records older than [maxAgeMs] (or beyond [maxRecords]) whose ops are all terminal, then GC. */
    @Synchronized fun prune(maxAgeMs: Long = 30L * 86_400_000, maxRecords: Int = 200) {
        val now = clock()
        val recs = (0 until records().length()).map { records().getJSONObject(it) }.sortedByDescending { it.optLong("updatedAt") }
        val keep = mutableSetOf<String>()
        recs.forEachIndexed { i, r ->
            val id = r.optString("id")
            val busy = opsOf(id).any { it.optString("state") == "local" || it.optString("state") in ACTIVE }
            val fresh = !r.optBoolean("deleted") && now - r.optLong("updatedAt") < maxAgeMs && i < maxRecords
            if (busy || fresh) keep += id
        }
        val before = records().length()
        state.put("records", JSONArray(recs.filter { it.optString("id") in keep }.sortedBy { it.optLong("updatedAt") }))
        removeOps { it.optString("captureId") !in keep }
        if (records().length() != before) { gcAttachments(); persist() }
    }

    /** Deletes attachment files no longer referenced by any kept record envelope or op (orphans >1h old). */
    @Synchronized fun gcAttachments(orphanGraceMs: Long = 3_600_000) {
        val referenced = mutableSetOf<String>()
        for (r in (0 until records().length()).map { records().getJSONObject(it) }) collectHashes(r.getJSONObject("envelope"), referenced)
        for (o in opList()) o.optJSONArray("hashes")?.let { a -> for (i in 0 until a.length()) referenced += a.getString(i) }
        draftHashes(referenced)
        val now = clock()
        for (f in attDir.listFiles().orEmpty()) if (f.name !in referenced && now - f.lastModified() > orphanGraceMs) f.delete()
        for (f in thumbDir.listFiles().orEmpty()) if (f.name.removeSuffix(".jpg") !in referenced && now - f.lastModified() > orphanGraceMs) f.delete()
    }

    private fun draftHashes(out: MutableSet<String>) {
        val items = drafts()?.optJSONArray("items") ?: return
        for (i in 0 until items.length()) items.optJSONObject(i)?.optJSONObject("payload")?.let { collectHashes(JSONObject().put("payload", it), out) }
    }

    private fun collectHashes(env: JSONObject, out: MutableSet<String>) {
        val atts = env.optJSONObject("payload")?.optJSONArray("attachments") ?: return
        for (i in 0 until atts.length()) atts.optJSONObject(i)?.optString("hash")?.let { if (it.isNotEmpty()) out += it }
    }

    private fun removeOps(pred: (JSONObject) -> Boolean) { state.put("ops", JSONArray(opList().filterNot(pred))) }
    private fun removeRecord(id: String) {
        state.put("records", JSONArray((0 until records().length()).map { records().getJSONObject(it) }.filter { it.optString("id") != id }))
    }

    companion object {
        val ACTIVE = setOf("queued", "pulled")
        val WARN = setOf("conflict", "failed", "rejected", "expired")
        val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
        val HEX64 = Regex("^[a-f0-9]{64}$")

        fun readJson(f: File): JSONObject? = try {
            if (f.isFile) JSONObject(f.readText(Charsets.UTF_8)) else null
        } catch (_: Exception) {
            // Keep the unreadable file for manual recovery instead of silently overwriting it.
            f.renameTo(File(f.parentFile, f.name + ".corrupt-" + System.currentTimeMillis())); null
        }

        fun writeJson(f: File, value: JSONObject) = writeAtomic(f, value.toString().toByteArray(Charsets.UTF_8))

        fun writeAtomic(f: File, bytes: ByteArray) {
            val tmp = File(f.parentFile, f.name + ".tmp")
            FileOutputStream(tmp).use { it.write(bytes); it.fd.sync() }
            if (!tmp.renameTo(f)) { f.delete(); check(tmp.renameTo(f)) { "无法写入 ${f.name}" } }
        }
    }
}
