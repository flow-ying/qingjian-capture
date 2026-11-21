package com.qingjian.mobile

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import kotlin.math.abs

private fun captureIntent(ctx: Context) = Intent(ctx, QuickCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/** 下拉控制中心「清笺」磁贴：收起通知栏并原地弹出小窗。 */
class CaptureTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply { state = Tile.STATE_INACTIVE; label = "清笺速记"; updateTile() }
    }

    override fun onClick() {
        val launch = {
            if (Build.VERSION.SDK_INT >= 34) {
                startActivityAndCollapse(PendingIntent.getActivity(this, 7, captureIntent(this), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            } else {
                @Suppress("DEPRECATION") startActivityAndCollapse(captureIntent(this))
            }
        }
        if (isLocked) unlockAndRun { launch() } else launch()
    }
}

/**
 * Optional edge “bookmark” handle (SYSTEM_ALERT_WINDOW). A 6 dp coloured strip inside a 20×72 dp touch
 * area: tap opens the card; vertical drag repositions it; dragging past mid-screen flips it to the other
 * edge. Runs as a low-importance foreground service (type specialUse) so ColorOS/ZUXOS keep it alive.
 */
class EdgeBarService : Service() {
    private var wm: WindowManager? = null
    private var handle: FrameLayout? = null
    private var params: WindowManager.LayoutParams? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startInForeground()
        if (!Settings.canDrawOverlays(this) || !QjApp.of(this).store.prefBool("edgeBar", false)) { stopSelf(); return START_NOT_STICKY }
        if (handle == null) show() else restyle()
        return START_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "边缘书签条", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        val open = PendingIntent.getActivity(this, 8, captureIntent(this), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_tile).setContentTitle("清笺边缘书签条已开启")
            .setContentText("点按屏幕边缘的细条即可速记；在清笺设置里可关闭").setContentIntent(open).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(ID, n)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun color(): Int = SWATCH[QjApp.of(this).store.prefString("palette", "obsidian-indigo")] ?: SWATCH.getValue("obsidian-indigo")
    private fun onRight() = QjApp.of(this).store.prefBool("edgeRight", true)

    @SuppressLint("ClickableViewAccessibility")
    private fun show() {
        val wm = getSystemService(WindowManager::class.java); this.wm = wm
        val strip = View(this)
        val box = FrameLayout(this).apply { contentDescription = "清笺速记" }
        box.addView(strip, FrameLayout.LayoutParams(dp(6), dp(64), Gravity.CENTER_VERTICAL or (if (onRight()) Gravity.END else Gravity.START)))
        val p = WindowManager.LayoutParams(dp(20), dp(72), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, PixelFormat.TRANSLUCENT)
        p.gravity = Gravity.TOP or (if (onRight()) Gravity.END else Gravity.START)
        p.y = (QjApp.of(this).store.pref("edgeY") as? Number)?.toInt() ?: (resources.displayMetrics.heightPixels * 0.42).toInt()
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var downX = 0f; var downY = 0f; var startY = 0; var dragging = false; var downAt = 0L
        box.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; startY = p.y; dragging = false; downAt = e.eventTime; strip.alpha = 1f }
                MotionEvent.ACTION_MOVE -> {
                    if (!dragging && (abs(e.rawY - downY) > slop || abs(e.rawX - downX) > slop * 2)) dragging = true
                    if (dragging) {
                        p.y = (startY + (e.rawY - downY)).toInt().coerceIn(0, resources.displayMetrics.heightPixels - dp(72))
                        wm.updateViewLayout(box, p)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    strip.alpha = 0.78f
                    if (!dragging && e.eventTime - downAt < 450) startActivity(captureIntent(this))
                    else if (dragging) {
                        val w = resources.displayMetrics.widthPixels
                        val right = if (abs(e.rawX - downX) > w / 2) e.rawX > w / 2 else onRight()
                        QjApp.of(this).store.setPrefs(mapOf("edgeY" to p.y, "edgeRight" to right))
                        if (right != (p.gravity and Gravity.END == Gravity.END)) { remove(); show(); return@setOnTouchListener true }
                    }
                }
                MotionEvent.ACTION_CANCEL -> strip.alpha = 0.78f
            }
            true
        }
        handle = box; params = p
        restyle()
        wm.addView(box, p)
    }

    private fun restyle() {
        val strip = handle?.getChildAt(0) ?: return
        strip.background = GradientDrawable().apply { cornerRadius = dp(3).toFloat(); setColor(color()) }
        strip.alpha = 0.78f
    }

    private fun remove() { handle?.let { try { wm?.removeView(it) } catch (_: Exception) { } }; handle = null }

    override fun onDestroy() { remove(); super.onDestroy() }

    companion object {
        private const val CHANNEL = "edge-bar"
        private const val ID = 17
        private val SWATCH = mapOf("obsidian-indigo" to 0xFF7C6FF6.toInt(), "warm-paper" to 0xFFC86D2D.toInt(), "aurora-teal" to 0xFF2DD4BF.toInt(),
            "rose-quartz" to 0xFFB84A76.toInt(), "graphite-gold" to 0xFFD49B38.toInt())
        fun refresh(app: QjApp) { if (app.store.prefBool("edgeBar", false) && Settings.canDrawOverlays(app)) app.main.post { app.syncEdgeBar() } }
    }
}

/** Restores the edge bar after reboot (WorkManager restores its own jobs). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = QjApp.of(context)
        if (app.store.prefBool("edgeBar", false) && Settings.canDrawOverlays(context)) app.syncEdgeBar()
    }
}
