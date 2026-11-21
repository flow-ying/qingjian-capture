package com.qingjian.mobile

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** In-memory stand-in for mobile-capture-relay (protocol v1 subset the phone uses). */
class FakeRelay : Http {
    var offline = false
    var token = "dev-token"
    val blobs = mutableMapOf<String, ByteArray>()
    val ops = linkedMapOf<String, JSONObject>()   // opId -> {kind, captureId, revision, digest, state, body}
    val calls = mutableListOf<String>()
    var projects: JSONObject = JSONObject().put("ok", true).put("projects", JSONArray()).put("etag", JSONObject.NULL).put("updatedAt", JSONObject.NULL)
    var nextPostCode: Int? = null

    override fun request(method: String, url: String, token: String, body: ByteArray?, contentType: String?): Http.Resp {
        if (offline) throw IOException("offline")
        val path = url.substringAfter("/v1")
        calls += "$method ${path.substringBefore('?')}"
        if (token != this.token) return Http.Resp(401, """{"ok":false,"error":"unauthorized"}""")
        return when {
            method == "PUT" && path.startsWith("/attachments/") -> {
                val h = path.removePrefix("/attachments/")
                if (sha(body!!) != h) Http.Resp(400, """{"ok":false,"error":"hash-mismatch"}""")
                else { val had = blobs.containsKey(h); blobs[h] = body; Http.Resp(if (had) 200 else 201, """{"ok":true}""") }
            }
            method == "POST" && path == "/ops" -> {
                nextPostCode?.let { nextPostCode = null; return Http.Resp(it, """{"ok":false,"error":"busy"}""") }
                val j = JSONObject(String(body!!, Charsets.UTF_8))
                val opId = j.getString("opId")
                ops[opId]?.let { return Http.Resp(200, JSONObject().put("ok", true).put("replayed", true).put("op", view(opId)).toString()) }
                if (j.getString("kind") == "upsert") {
                    val e = j.getJSONObject("envelope")
                    val atts = e.getJSONObject("payload").getJSONArray("attachments")
                    for (i in 0 until atts.length()) { val h = atts.getJSONObject(i).getString("hash"); if (h !in blobs) return Http.Resp(409, JSONObject().put("ok", false).put("error", "attachment-missing").put("hash", h).toString()) }
                    val dup = ops.entries.firstOrNull { it.value.getString("captureId") == e.getString("id") && it.value.getInt("revision") == e.getInt("revision") && it.value.getString("kind") == "upsert" }
                    if (dup != null) {
                        val code = if (dup.value.getString("digest") == e.getString("digest")) "duplicate-revision" else "revision-conflict"
                        return Http.Resp(409, JSONObject().put("ok", false).put("error", code).put("existingOpId", dup.key).toString())
                    }
                    ops[opId] = JSONObject().put("kind", "upsert").put("captureId", e.getString("id")).put("revision", e.getInt("revision")).put("digest", e.getString("digest")).put("state", "queued")
                } else {
                    val cid = j.getString("captureId")
                    val rows = ops.values.filter { it.getString("captureId") == cid }
                    val cancellable = rows.isNotEmpty() && rows.all { it.getString("state") == "queued" } && rows.any { it.getInt("revision") == 1 }
                    if (cancellable) rows.forEach { it.put("state", "cancelled") }
                    ops[opId] = JSONObject().put("kind", "delete").put("captureId", cid).put("revision", j.getInt("targetRevision")).put("digest", j.getString("expectedDigest"))
                        .put("state", if (cancellable) "deleted" else "queued")
                }
                Http.Resp(201, JSONObject().put("ok", true).put("replayed", false).put("op", view(opId)).toString())
            }
            method == "GET" && path.startsWith("/ops/status") -> {
                val ids = url.substringAfter("ids=").split(",")
                Http.Resp(200, JSONObject().put("ok", true).put("ops", JSONArray(ids.filter { it in ops }.map { view(it) })).toString())
            }
            method == "GET" && path == "/meta/projects" -> Http.Resp(200, projects.toString())
            method == "GET" && path == "/health" -> Http.Resp(200, """{"ok":true,"protocol":1,"role":"device"}""")
            else -> Http.Resp(404, """{"ok":false,"error":"not-found"}""")
        }
    }

    fun view(opId: String): JSONObject { val o = ops.getValue(opId); return JSONObject(o.toString()).put("opId", opId).apply { remove("body") } }
    /** Desktop side: land / conflict everything queued (in order). */
    fun desktopAck(state: String = "landed", error: String? = null) {
        for ((_, o) in ops) if (o.getString("state") == "queued" || o.getString("state") == "pulled") {
            o.put("state", if (o.getString("kind") == "delete" && state == "landed") "deleted" else state)
            if (error != null) o.put("error", error)
            if (state == "landed" && o.getString("kind") == "upsert") o.put("result", JSONObject().put("revision", o.getInt("revision")).put("digest", o.getString("digest")).put("blockHash", "b".repeat(64)))
        }
    }
    companion object { fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) } }
}

class SyncEngineTest {
    private lateinit var dir: File
    private lateinit var store: Store
    private lateinit var relay: FakeRelay
    private lateinit var engine: SyncEngine
    private var now = 1_800_000_000_000L
    private var configured = true

    @Before fun setUp() {
        dir = Files.createTempDirectory("qj-test").toFile()
        store = Store(dir) { now }
        relay = FakeRelay()
        engine = SyncEngine(store, relay, { if (configured) SyncConfig("https://relay.test/mobile-capture/v1", "dev-token", "my-phone") else null }) { now }
    }

    private fun env(id: String = UUID.randomUUID().toString(), rev: Int = 1, prev: String? = null, body: String = "正文", atts: JSONArray = JSONArray()): JSONObject {
        val digest = MessageDigest.getInstance("SHA-256").digest("$id:$rev:$body:$prev".toByteArray()).joinToString("") { "%02x".format(it) }
        return JSONObject().put("id", id).put("revision", rev).put("date", "2026-11-20").put("createdAt", "2026-11-20T01:00:00.000Z")
            .put("previousDigest", prev ?: JSONObject.NULL).put("payload", JSONObject().put("type", "note").put("body", body).put("source", "").put("thought", "").put("due", "").put("tags", "").put("attachments", atts))
            .put("digest", digest)
    }

    private fun attach(bytes: ByteArray): JSONObject {
        val h = FakeRelay.sha(bytes); File(store.attDir, h).writeBytes(bytes)
        return JSONObject().put("id", UUID.randomUUID().toString()).put("name", "a.jpg").put("ext", ".jpg").put("hash", h).put("size", bytes.size)
    }

    private fun status(id: String) = (0 until store.recordViews().length()).map { store.recordViews().getJSONObject(it) }.first { it.getString("id") == id }.getString("status")

    @Test fun offlineSaveIsPersistedAndSurvivesRestart() {
        relay.offline = true
        val e = env()
        store.enqueueUpsert(e)
        val r = engine.flush()
        assertFalse(r.online); assertEquals(1, r.unsent)
        val reopened = Store(dir) { now }
        assertEquals(1, reopened.pendingCount())
        assertEquals("sending", reopened.viewOf(JSONObject().put("id", e.getString("id")).put("envelope", e)).getString("status"))
    }

    @Test fun uploadsAttachmentsBeforeOpAndTracksStatusToLanded() {
        val a = attach("png-bytes".toByteArray())
        val e = env(atts = JSONArray().put(a))
        store.enqueueUpsert(e)
        val r = engine.flush()
        assertTrue(r.online); assertEquals(1, r.sent); assertTrue(r.active)
        assertEquals(listOf("PUT /attachments/${a.getString("hash")}", "POST /ops"), relay.calls.take(2))
        assertEquals("queued", status(e.getString("id")))
        relay.desktopAck()
        engine.flush()
        assertEquals("landed", status(e.getString("id")))
        assertFalse(store.hasActive())
    }

    @Test fun retryAfterNetworkLossReusesSameOpId() {
        val e = env(); store.enqueueUpsert(e)
        relay.nextPostCode = 503
        engine.flush()
        assertEquals(1, store.pendingCount())
        val opId = store.unsentOps().single().getString("opId")
        engine.flush()
        assertEquals(setOf(opId), relay.ops.keys)
        assertEquals(0, store.pendingCount())
    }

    @Test fun editChainsOnLatestRevisionAndRejectsStaleBase() {
        val e1 = env(); store.enqueueUpsert(e1); engine.flush(); relay.desktopAck(); engine.flush()
        val e2 = env(e1.getString("id"), 2, e1.getString("digest"), "改过")
        store.enqueueUpsert(e2)
        val stale = env(e1.getString("id"), 2, e1.getString("digest"), "另一台设备的改动")
        val err = runCatching { store.enqueueUpsert(stale) }.exceptionOrNull()
        assertNotNull(err); assertTrue(err!!.message!!.contains("更新版本"))
        engine.flush()
        assertEquals("queued", status(e1.getString("id")))
        assertEquals(2, relay.ops.values.last().getInt("revision"))
    }

    @Test fun deleteNeverUploadedIsPurelyLocal() {
        relay.offline = true
        val e = env(); store.enqueueUpsert(e)
        val res = store.enqueueDelete(e.getString("id"))
        assertTrue(res.getBoolean("local"))
        assertEquals(0, store.recordViews().length()); assertEquals(0, store.pendingCount())
    }

    @Test fun deleteQueuedRecordIsCancelledByRelayAndDisappears() {
        val e = env(); store.enqueueUpsert(e); engine.flush()
        store.enqueueDelete(e.getString("id"))
        assertEquals("deleting", status(e.getString("id")))
        engine.flush()
        assertEquals(0, store.recordViews().length())
    }

    @Test fun deleteLandedRecordWaitsForDesktopThenDisappears() {
        val e = env(); store.enqueueUpsert(e); engine.flush(); relay.desktopAck(); engine.flush()
        store.enqueueDelete(e.getString("id")); engine.flush()
        assertEquals("deleting", status(e.getString("id")))
        relay.desktopAck(); engine.flush()
        assertEquals(0, store.recordViews().length())
    }

    @Test fun desktopConflictBecomesOrangeAndBlocksEditing() {
        val e = env(); store.enqueueUpsert(e); engine.flush()
        relay.desktopAck("conflict", "原笔记中的记录已修改或移除，请打开原笔记处理"); engine.flush()
        val v = store.recordViews().getJSONObject(0)
        assertEquals("conflict", v.getString("status")); assertTrue(v.getBoolean("warn"))
        assertTrue(v.getString("error").contains("原笔记"))
        store.forget(e.getString("id"))
        assertEquals(0, store.recordViews().length())
    }

    @Test fun relayRefusalIsVisibleAndStopsLaterRevisionsOfSameRecord() {
        val id = UUID.randomUUID().toString()
        // Another device already queued different content as revision 1 of this capture id.
        relay.ops["11111111-1111-4111-8111-111111111111"] = JSONObject().put("kind", "upsert").put("captureId", id).put("revision", 1).put("digest", "c".repeat(64)).put("state", "queued")
        val e1 = env(id); store.enqueueUpsert(e1)
        store.enqueueUpsert(env(id, 2, e1.getString("digest"), "第二版"))
        engine.flush()
        val v = store.recordViews().getJSONObject(0)
        assertEquals("rejected", v.getString("status"))
        assertEquals(0, store.pendingCount())
        assertEquals(1, relay.ops.size)
    }

    @Test fun duplicateRevisionAdoptsExistingServerOp() {
        val e = env(); store.enqueueUpsert(e); engine.flush()
        // Simulate a lost response: same content queued again locally under a new opId.
        val dupDir = Files.createTempDirectory("qj-dup").toFile()
        val other = Store(dupDir) { now }
        other.enqueueUpsert(e)
        SyncEngine(other, relay, { SyncConfig("https://relay.test/mobile-capture/v1", "dev-token", "my-tablet") }) { now }.flush()
        assertEquals("queued", other.recordViews().getJSONObject(0).getString("status"))
        relay.desktopAck()
        SyncEngine(other, relay, { SyncConfig("https://relay.test/mobile-capture/v1", "dev-token", "my-tablet") }) { now }.flush()
        assertEquals("landed", other.recordViews().getJSONObject(0).getString("status"))
    }

    @Test fun missingAttachmentOnRelayTriggersReupload() {
        val a = attach("img".toByteArray())
        val e1 = env(atts = JSONArray().put(a)); store.enqueueUpsert(e1); engine.flush(); relay.desktopAck(); engine.flush()
        relay.blobs.clear() // relay purged the image after landing
        val e2 = env(e1.getString("id"), 2, e1.getString("digest"), "改正文保留图", JSONArray().put(a))
        store.enqueueUpsert(e2)
        // Upload flag from the first op does not carry over: the new op uploads again before POST.
        engine.flush()
        assertTrue(relay.blobs.containsKey(a.getString("hash")))
        assertEquals("queued", status(e1.getString("id")))
    }

    @Test fun badTokenReportsAuthErrorAndKeepsQueue() {
        relay.token = "rotated"
        store.enqueueUpsert(env())
        val r = engine.flush()
        assertNotNull(r.authError); assertFalse(r.online); assertEquals(1, r.unsent)
    }

    @Test fun notConfiguredMakesNoNetworkCalls() {
        configured = false
        store.enqueueUpsert(env())
        val r = engine.flush()
        assertFalse(r.configured); assertTrue(relay.calls.isEmpty())
    }

    @Test fun projectsCachedOnlyAfterDesktopSyncedAndThrottled() {
        engine.flush()
        assertNull(store.pref("projects"))
        relay.projects = JSONObject().put("ok", true).put("projects", JSONArray().put(JSONObject().put("slug", "工作台")).put(JSONObject().put("slug", "Sid"))).put("etag", "e1").put("updatedAt", "2026-11-20T10:00:00+09:00")
        engine.flush()
        assertNull("throttled within 10 minutes", store.pref("projects"))
        engine.flush(forceProjects = true)
        assertEquals("[\"工作台\",\"Sid\"]", store.pref("projects").toString())
        relay.offline = true
        engine.flush(forceProjects = true)
        assertEquals("cached list survives offline", 2, (store.pref("projects") as JSONArray).length())
    }

    @Test fun pruneDropsOldTerminalRecordsAndUnreferencedAttachments() {
        val a = attach("old".toByteArray())
        val e = env(atts = JSONArray().put(a)); store.enqueueUpsert(e); engine.flush(); relay.desktopAck(); engine.flush()
        now += 31L * 86_400_000
        File(store.attDir, a.getString("hash")).setLastModified(now - 7_200_000)
        store.prune()
        assertEquals(0, store.recordViews().length())
        assertFalse(File(store.attDir, a.getString("hash")).exists())
    }

    @Test fun draftsAreAtomicAndBounded() {
        val bundle = JSONObject().put("activeId", "a").put("items", JSONArray().put(JSONObject().put("id", "a")))
        store.saveDrafts(bundle)
        assertEquals("a", Store(dir) { now }.drafts()!!.getString("activeId"))
        val tooMany = JSONArray(); repeat(13) { tooMany.put(JSONObject().put("id", "x$it")) }
        assertTrue(runCatching { store.saveDrafts(JSONObject().put("items", tooMany)) }.isFailure)
        assertFalse(File(dir, "drafts.json.tmp").exists())
    }
}
