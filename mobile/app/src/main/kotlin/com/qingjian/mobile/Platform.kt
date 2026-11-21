package com.qingjian.mobile

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.OpenableColumns
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** HttpURLConnection transport (system proxy/TLS, no third-party client). Never logs headers or bodies. */
class UrlHttp : Http {
    override fun request(method: String, url: String, token: String, body: ByteArray?, contentType: String?): Http.Resp {
        require(url.startsWith("https://")) { "服务器地址必须使用 https" }
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 10_000; c.readTimeout = 30_000
            c.instanceFollowRedirects = false
            c.setRequestProperty("Authorization", "Bearer $token")
            c.setRequestProperty("User-Agent", "qingjian-mobile/${BuildInfo.VERSION}")
            c.setRequestProperty("Accept", "application/json")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", contentType ?: "application/octet-stream")
                c.setFixedLengthStreamingMode(body.size)
                c.outputStream.use { it.write(body) }
            }
            val code = c.responseCode
            val stream = if (code >= 400) c.errorStream else c.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return Http.Resp(code, text)
        } finally {
            c.disconnect()
        }
    }
}

/** Device Token encrypted with a non-exportable AndroidKeyStore AES-256-GCM key; never returned to JS. */
object TokenVault {
    private const val ALIAS = "qingjian-relay-token"
    private const val PREFS = "qj-vault"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).build())
        return gen.generateKey()
    }

    fun save(ctx: Context, token: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ct = cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        val blob = Base64.encodeToString(cipher.iv + ct, Base64.NO_WRAP)
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("t", blob).putInt("n", token.length).commit()
    }

    fun load(ctx: Context): String? = try {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("t", null)?.let { blob ->
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12)) }
            String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
        }
    } catch (_: Exception) { null }

    fun length(ctx: Context): Int = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("n", 0)
}

/**
 * Light, “invisible” image compression: long edge ≤ 2048 px, JPEG q85 (WebP q85 when the source has
 * transparency), EXIF orientation applied; small already-fine images keep their original bytes.
 * Output ≤ 8 MiB (relay limit). Returns the attachment descriptor used in the envelope.
 */
object Images {
    private const val MAX_EDGE = 2048
    private const val KEEP_ORIGINAL_BYTES = 600 * 1024
    private const val MAX_BYTES = 8 * 1024 * 1024

    fun import(ctx: Context, uri: Uri, store: Store): JSONObject {
        val cr = ctx.contentResolver
        val mime = cr.getType(uri) ?: ""
        val name = displayName(ctx, uri) ?: "图片"
        val original = cr.openInputStream(uri)?.use { it.readBytes() } ?: throw IOException("无法读取图片")
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(original, 0, original.size, bounds)
        if (bounds.outWidth <= 0) throw IOException("不是可识别的图片：$name")
        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        val srcExt = when { mime.contains("png") -> ".png"; mime.contains("gif") -> ".gif"; mime.contains("webp") -> ".webp"; else -> ".jpg" }
        val (bytes, ext) = when {
            srcExt == ".gif" && original.size <= MAX_BYTES -> original to ".gif"
            original.size <= KEEP_ORIGINAL_BYTES && longEdge <= MAX_EDGE -> original to srcExt
            else -> compress(original, bounds)
        }
        val hash = sha256(bytes)
        val target = File(store.attDir, hash)
        if (!target.isFile) Store.writeAtomic(target, bytes)
        writeThumb(bytes, File(store.thumbDir, "$hash.jpg"))
        val base = name.substringBeforeLast('.', name).take(200).ifBlank { "图片" }
        return JSONObject().put("id", UUID.randomUUID().toString()).put("name", base + ext).put("ext", ext).put("hash", hash).put("size", bytes.size)
    }

    private fun compress(original: ByteArray, bounds: BitmapFactory.Options): Pair<ByteArray, String> {
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2
        var bmp = BitmapFactory.decodeByteArray(original, 0, original.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IOException("图片解码失败")
        val scale = MAX_EDGE.toFloat() / maxOf(bmp.width, bmp.height)
        val m = Matrix()
        if (scale < 1f) m.postScale(scale, scale)
        val rotation = try { ExifInterface(original.inputStream()).rotationDegrees } catch (_: Exception) { 0 }
        if (rotation != 0) m.postRotate(rotation.toFloat())
        if (!m.isIdentity) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        val alpha = bmp.hasAlpha()
        @Suppress("DEPRECATION")
        val format = if (alpha) (if (android.os.Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP) else Bitmap.CompressFormat.JPEG
        var quality = 85
        var out: ByteArray
        do {
            out = ByteArrayOutputStream().also { bmp.compress(format, quality, it) }.toByteArray()
            quality -= 10
        } while (out.size > MAX_BYTES && quality >= 45)
        if (out.size > MAX_BYTES) throw IOException("图片压缩后仍超过 8 MB")
        return out to (if (alpha) ".webp" else ".jpg")
    }

    private fun writeThumb(bytes: ByteArray, target: File) {
        if (target.isFile) return
        try {
            val b = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, b)
            var s = 1; while (maxOf(b.outWidth, b.outHeight) / (s * 2) >= 256) s *= 2
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = s }) ?: return
            Store.writeAtomic(target, ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 70, it) }.toByteArray())
        } catch (_: Exception) { }
    }

    fun thumbDataUrl(store: Store, hash: String): String? {
        if (!Store.HEX64.matches(hash)) return null
        val f = File(store.thumbDir, "$hash.jpg")
        return if (f.isFile) "data:image/jpeg;base64," + Base64.encodeToString(f.readBytes(), Base64.NO_WRAP) else null
    }

    private fun displayName(ctx: Context, uri: Uri): String? = try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
    } catch (_: Exception) { null }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}

object BuildInfo { const val VERSION = "0.1.0" }
