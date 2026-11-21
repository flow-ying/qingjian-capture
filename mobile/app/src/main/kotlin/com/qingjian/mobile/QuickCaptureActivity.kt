package com.qingjian.mobile

import android.app.Activity
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import org.json.JSONArray
import org.json.JSONObject

/**
 * The floating quick-capture card. Fully transparent, own task (singleTask + taskAffinity,
 * excluded from recents), drawn above whatever app was in front. “Collapse” = moveTaskToBack, so the
 * Activity + WebView stay alive and the next open (tile / icon / share / edge bar) is instant.
 */
class QuickCaptureActivity : Activity() {
    private val app get() = QjApp.of(this)
    private lateinit var root: FrameLayout
    private var pickCallback: ((JSONArray?, Throwable?) -> Unit)? = null
    private var lastClipStamp = -1L
    private val poll = object : Runnable {
        override fun run() { if (app.store.hasActive() || app.store.pendingCount() > 0) app.requestSync(); app.main.postDelayed(this, 20_000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setDecorFitsSystemWindows(false)
        root = FrameLayout(this).apply { setBackgroundColor(SCRIM) }
        root.setOnApplyWindowInsetsListener { v, insets ->
            val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
            v.setPadding(i.left, i.top, i.right, i.bottom)
            WindowInsets.CONSUMED
        }
        // Taps on the dimmed system-bar strips (outside the WebView) also dismiss the card.
        root.setOnClickListener { app.web.emit("back") }
        setContentView(root)
        attachWeb()
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { app.web.emit("back") }
        handleIntent(intent)
    }

    private fun attachWeb() {
        val web = try { app.web.obtain() } catch (e: IllegalStateException) {
            android.widget.Toast.makeText(this, e.message, android.widget.Toast.LENGTH_LONG).show(); finish(); return
        }
        app.web.context.baseContext = this
        app.web.activity = this
        (web.parent as? ViewGroup)?.removeView(web)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (root.childCount == 0) attachWeb()
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (root.childCount == 0) attachWeb()
        app.web.activity = this
        app.web.emit("focus")
        app.pushState()
        app.requestSync()
        app.main.removeCallbacks(poll); app.main.postDelayed(poll, 20_000)
        root.getChildAt(0)?.let { w ->
            w.requestFocus()
            w.postDelayed({ getSystemService(InputMethodManager::class.java)?.showSoftInput(w, 0) }, 120)
        }
    }

    override fun onPause() {
        app.web.emit("flush")
        app.main.removeCallbacks(poll)
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) readClipboard()
    }

    @Deprecated("API < 33 back handling")
    override fun onBackPressed() { app.web.emit("back") }

    override fun onDestroy() {
        if (app.web.activity === this) {
            app.web.activity = null
            root.removeAllViews()
            app.web.context.baseContext = applicationContext
        }
        super.onDestroy()
    }

    fun collapse() {
        currentFocus?.let { getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0) }
        if (!moveTaskToBack(true)) finish()
    }

    // ------------------------------------------------------------------ clipboard hint
    /** Reads the clipboard only when a NEW clip appeared (timestamp), skipping clips marked sensitive. */
    private fun readClipboard() {
        if (!app.store.prefBool("clipboardHint", true)) return
        val cm = getSystemService(ClipboardManager::class.java) ?: return
        val desc = cm.primaryClipDescription ?: return
        val stamp = desc.timestamp
        val seen = (app.store.pref("clipStamp") as? Number)?.toLong() ?: -1L
        if (stamp == seen || stamp == lastClipStamp) return
        lastClipStamp = stamp
        if (Build.VERSION.SDK_INT >= 33 && desc.extras?.getBoolean(ClipDescription.EXTRA_IS_SENSITIVE) == true) return
        if (!desc.hasMimeType(ClipDescription.MIMETYPE_TEXT_PLAIN) && !desc.hasMimeType(ClipDescription.MIMETYPE_TEXT_HTML) && !desc.hasMimeType(ClipDescription.MIMETYPE_TEXT_URILIST)) return
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()?.trim() ?: return
        app.io.execute { app.store.setPrefs(mapOf("clipStamp" to stamp)) }
        if (text.isNotEmpty() && text.length <= 4000) app.web.emit("clipboard", JSONObject().put("text", text))
    }

    /** Our own “复制” actions must not bounce back as a clipboard hint. */
    fun ignoreClipboard() {
        val stamp = getSystemService(ClipboardManager::class.java)?.primaryClipDescription?.timestamp ?: return
        lastClipStamp = stamp
        app.io.execute { app.store.setPrefs(mapOf("clipStamp" to stamp)) }
    }

    // ------------------------------------------------------------------ share
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE) ?: ""
        val uris = mutableListOf<Uri>()
        if (action == Intent.ACTION_SEND) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris += it }
        intent.clipData?.let { c -> for (i in 0 until c.itemCount) c.getItemAt(i).uri?.let { if (it !in uris) uris += it } }
        // Consume the share so a later re-open (onResume with the same Intent) does not re-insert it.
        setIntent(Intent(this, QuickCaptureActivity::class.java))
        app.io.execute {
            val atts = JSONArray(); val errors = mutableListOf<String>()
            for (u in uris.take(20)) try { atts.put(Images.import(this, u, app.store)) } catch (e: Exception) { errors += (e.message ?: "图片读取失败") }
            val payload = JSONObject().put("text", text).put("subject", subject).put("attachments", atts)
            if (errors.isNotEmpty()) payload.put("errors", JSONArray(errors))
            app.web.emit("share", payload)
        }
    }

    // ------------------------------------------------------------------ image picker
    fun pickImages(max: Int, cb: (JSONArray?, Throwable?) -> Unit) {
        pickCallback?.invoke(JSONArray(), null)
        pickCallback = cb
        val limit = maxOf(1, minOf(max, if (Build.VERSION.SDK_INT >= 33) MediaStore.getPickImagesMaxLimit() else 20))
        val i = if (MediaStore.ACTION_PICK_IMAGES.isNotEmpty() && Build.VERSION.SDK_INT >= 33) {
            Intent(MediaStore.ACTION_PICK_IMAGES).apply { type = "image/*"; if (limit > 1) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, limit) }
        } else {
            Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        @Suppress("DEPRECATION")
        startActivityForResult(i, REQ_PICK)
    }

    @Deprecated("Activity result API on plain Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_OVERLAY) { app.syncEdgeBar(); app.pushState(); return }
        if (requestCode != REQ_PICK) return
        val cb = pickCallback ?: return
        pickCallback = null
        if (resultCode != RESULT_OK || data == null) { cb(JSONArray(), null); return }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { c -> for (i in 0 until c.itemCount) uris += c.getItemAt(i).uri }
        if (uris.isEmpty()) data.data?.let { uris += it }
        app.io.execute {
            val out = JSONArray()
            try { for (u in uris.take(20)) out.put(Images.import(this, u, app.store)); cb(out, null) } catch (e: Exception) { cb(null, e) }
        }
    }

    fun requestOverlay() {
        @Suppress("DEPRECATION")
        startActivityForResult(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")), REQ_OVERLAY)
    }

    companion object {
        private const val REQ_PICK = 41
        private const val REQ_OVERLAY = 42
        private const val SCRIM = 0x4D08090E
    }
}
