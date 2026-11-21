package com.qingjian.mobile

import android.annotation.SuppressLint
import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class QjApp : Application() {
    lateinit var store: Store
    lateinit var engine: SyncEngine
    lateinit var web: WebHost
    val io = Executors.newSingleThreadExecutor()
    private val net = Executors.newSingleThreadExecutor()
    val main = Handler(Looper.getMainLooper())
    @Volatile var online = false
    @Volatile var authError: String? = null

    override fun onCreate() {
        super.onCreate()
        store = Store(File(filesDir, "qj"))
        engine = SyncEngine(store, UrlHttp(), ::config)
        web = WebHost(this)
        // Pre-warm the WebView once the process is idle so later openings are instant.
        Looper.myQueue().addIdleHandler { web.obtain(); false }
        getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { if (store.pendingCount() > 0 || store.hasActive()) requestSync() }
        })
    }

    fun config(): SyncConfig? {
        val token = TokenVault.load(this) ?: return null
        val url = store.prefString("serverUrl", DEFAULT_URL)
        return SyncConfig(url, token, deviceId())
    }

    fun deviceId(): String = store.prefString("deviceId").ifBlank {
        if (resources.configuration.smallestScreenWidthDp >= 600) "my-tablet" else "my-phone"
    }

    fun stateJson(): JSONObject {
        val projects = (store.pref("projects") as? JSONArray) ?: JSONArray()
        val settings = JSONObject()
            .put("configured", TokenVault.length(this) > 0)
            .put("tokenLength", TokenVault.length(this))
            .put("serverUrl", store.prefString("serverUrl", DEFAULT_URL))
            .put("deviceId", deviceId())
            .put("clipboardHint", store.prefBool("clipboardHint", true))
            .put("edgeBar", store.prefBool("edgeBar", false))
            .put("overlayGranted", Settings.canDrawOverlays(this))
            .put("version", BuildInfo.VERSION)
        return JSONObject()
            .put("records", store.recordViews())
            .put("online", online)
            .put("authError", authError ?: JSONObject.NULL)
            .put("pending", store.pendingCount())
            .put("palette", store.prefString("palette", "obsidian-indigo"))
            .put("pinned", store.prefBool("pinned", false))
            .put("projects", projects)
            .put("settings", settings)
            .put("drafts", store.drafts() ?: JSONObject.NULL)
    }

    fun pushState() { io.execute { val s = stateJson(); main.post { web.emit("state", s) } } }

    fun requestSync(forceProjects: Boolean = false) {
        net.execute {
            val r = try { engine.flush(forceProjects) } catch (e: Exception) { SyncResult(true, false, unsent = store.pendingCount(), active = store.hasActive()) }
            afterSync(r)
        }
    }

    fun afterSync(r: SyncResult) {
        online = r.online; authError = r.authError
        val wm = WorkManager.getInstance(this)
        val connected = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        if (r.configured && r.unsent > 0 && r.authError == null) {
            wm.enqueueUniqueWork("qj-push", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(connected)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build())
        }
        if (r.configured && r.active) {
            wm.enqueueUniquePeriodicWork("qj-poll", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(connected).build())
        } else {
            wm.cancelUniqueWork("qj-poll")
        }
        pushState()
    }

    fun syncEdgeBar() {
        val want = store.prefBool("edgeBar", false) && Settings.canDrawOverlays(this)
        val i = Intent(this, EdgeBarService::class.java)
        if (want) startForegroundService(i) else stopService(i)
    }

    companion object {
        const val DEFAULT_URL = "https://relay.example.com/mobile-capture/v1"
        val DEVICE_RE = Regex("^[a-z0-9][a-z0-9-]{0,39}$")
        fun of(ctx: Context) = ctx.applicationContext as QjApp
    }
}

/** WorkManager entry: retries while anything is still queued locally. */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        val app = QjApp.of(applicationContext)
        val r = app.engine.flush()
        app.online = r.online; app.authError = r.authError
        app.pushState()
        return if (r.configured && r.unsent > 0 && r.authError == null) Result.retry() else Result.success()
    }
}

/**
 * Owns the single long-lived WebView (MutableContextWrapper so it survives Activity instances) and the
 * origin-restricted message channel `QJNative` (WebMessageListener, allowed origin = the local asset host only).
 */
class WebHost(private val app: QjApp) {
    val context = MutableContextWrapper(app)
    private var view: WebView? = null
    private var proxy: JavaScriptReplyProxy? = null
    private var ready = false
    private val queued = mutableListOf<Pair<String, Any>>()
    var activity: QuickCaptureActivity? = null
    private val loader by lazy { WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(app)).build() }

    @SuppressLint("SetJavaScriptEnabled")
    fun obtain(): WebView {
        view?.let { return it }
        check(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "系统 WebView 版本过旧，请在应用商店更新 Android System WebView" }
        val w = WebView(context)
        w.setBackgroundColor(Color.TRANSPARENT)
        w.isVerticalScrollBarEnabled = false
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
            mediaPlaybackRequiresUserGesture = true
            setGeolocationEnabled(false)
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.host == ASSET_HOST) return false
                if (u.scheme == "https" || u.scheme == "http") try { activity?.startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) { }
                return true
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                // Renderer crashed or was killed: drop this WebView; the Activity recreates it on next show.
                this@WebHost.view = null; proxy = null; ready = false
                (view.parent as? android.view.ViewGroup)?.removeView(view)
                view.destroy(); activity?.finish(); return true
            }
        }
        WebViewCompat.addWebMessageListener(w, "QJNative", setOf("https://$ASSET_HOST")) { _, message: WebMessageCompat, _, isMainFrame, reply ->
            if (!isMainFrame) return@addWebMessageListener
            proxy = reply
            val data = message.data ?: return@addWebMessageListener
            Bridge.dispatch(app, data)
        }
        w.loadUrl(START_URL)
        view = w
        return w
    }

    fun reply(id: Int, ok: Boolean, value: Any?) = app.main.post {
        proxy?.postMessage(JSONObject().put("t", "r").put("id", id).put("ok", ok).put("v", value ?: JSONObject.NULL).toString())
    }

    /** Native → JS event; buffered until the page announced `ready`. */
    fun emit(name: String, value: Any = JSONObject.NULL) {
        if (Looper.myLooper() != Looper.getMainLooper()) { app.main.post { emit(name, value) }; return }
        val p = proxy
        if (!ready || p == null) { if (name != "state") queued += name to value; return }
        p.postMessage(JSONObject().put("t", "e").put("n", name).put("v", value).toString())
    }

    fun markReady() = app.main.post {
        ready = true
        val pending = queued.toList(); queued.clear()
        for ((n, v) in pending) emit(n, v)
    }

    companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$ASSET_HOST/assets/web/index.html"
    }
}

/** Dispatches `{id, method, arg}` messages from the Web UI. Heavy work runs on the single IO thread. */
object Bridge {
    fun dispatch(app: QjApp, raw: String) {
        val msg = try { JSONObject(raw) } catch (_: Exception) { return }
        val id = msg.optInt("id"); val method = msg.optString("method"); val arg = msg.opt("arg")
        val web = app.web
        fun ok(v: Any? = JSONObject().put("ok", true)) = web.reply(id, true, v)
        fun fail(e: Throwable) = web.reply(id, false, JSONObject().put("message", e.message ?: e.javaClass.simpleName))
        val ui = setOf("collapse", "pick-images", "copy-text", "settings-save")
        val task = Runnable {
            try {
                when (method) {
                    "ready" -> { web.markReady(); ok() }
                    "state" -> ok(app.stateJson())
                    "drafts" -> { app.store.saveDrafts(arg as JSONObject); ok() }
                    "save" -> {
                        val env = (arg as JSONObject).getJSONObject("envelope")
                        app.store.enqueueUpsert(env); ok(); app.pushState(); app.requestSync()
                    }
                    "delete-record" -> { val r = app.store.enqueueDelete(arg as String); ok(r); app.pushState(); app.requestSync() }
                    "forget-record" -> { app.store.forget(arg as String); ok(); app.pushState() }
                    "palette" -> { app.store.setPrefs(mapOf("palette" to (arg as String))); ok(); EdgeBarService.refresh(app) }
                    "pin" -> { app.store.setPrefs(mapOf("pinned" to (arg == true))); ok() }
                    "attachment-preview" -> ok(Images.thumbDataUrl(app.store, (arg as JSONObject).optString("hash")))
                    "retry" -> { ok(); app.requestSync(true) }
                    "test-connection" -> {
                        val a = arg as? JSONObject ?: JSONObject()
                        val token = a.optString("token").ifBlank { TokenVault.load(app) ?: "" }
                        val url = a.optString("serverUrl").ifBlank { app.store.prefString("serverUrl", QjApp.DEFAULT_URL) }
                        if (token.isBlank()) throw IllegalArgumentException("请先粘贴 device Token")
                        require(url.startsWith("https://")) { "服务器地址必须以 https:// 开头" }
                        ok(app.engine.test(SyncConfig(url, token, app.deviceId())))
                    }
                    "collapse" -> { app.activity()?.collapse(); ok() }
                    "copy-text" -> {
                        val cm = app.getSystemService(ClipboardManager::class.java)
                        cm.setPrimaryClip(ClipData.newPlainText("清笺", arg as String))
                        app.activity()?.ignoreClipboard()
                        ok()
                    }
                    "pick-images" -> {
                        val act = app.activity() ?: throw IllegalStateException("小窗未打开")
                        act.pickImages((arg as? JSONObject)?.optInt("max", 20) ?: 20) { list, err -> if (err != null) fail(err) else ok(list) }
                    }
                    "settings-save" -> {
                        val a = arg as JSONObject
                        val url = a.optString("serverUrl").trim().trimEnd('/')
                        require(url.startsWith("https://") && Uri.parse(url).host != null) { "服务器地址必须以 https:// 开头" }
                        val device = a.optString("deviceId").trim().lowercase()
                        require(QjApp.DEVICE_RE.matches(device)) { "设备标识只能用小写字母、数字和连字符（例如 my-phone）" }
                        val edge = a.optBoolean("edgeBar")
                        app.io.execute {
                            try {
                                a.optString("token").trim().takeIf { it.isNotEmpty() }?.let { TokenVault.save(app, it) }
                                app.store.setPrefs(mapOf("serverUrl" to url, "deviceId" to device, "clipboardHint" to a.optBoolean("clipboardHint", true), "edgeBar" to edge, "projectsAt" to 0))
                                ok(); app.pushState(); app.requestSync(true)
                                app.main.post {
                                    if (edge && !Settings.canDrawOverlays(app)) app.activity()?.requestOverlay() else app.syncEdgeBar()
                                }
                            } catch (e: Exception) { fail(e) }
                        }
                    }
                    else -> throw IllegalArgumentException("未知操作：$method")
                }
            } catch (e: Throwable) { fail(e) }
        }
        if (method in ui) app.main.post(task) else app.io.execute(task)
    }
}

fun QjApp.activity(): QuickCaptureActivity? = web.activity
