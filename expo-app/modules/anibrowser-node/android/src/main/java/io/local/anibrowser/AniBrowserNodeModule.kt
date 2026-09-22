package io.local.anibrowser

import io.local.anibrowser.node.R // module namespace — R lives one level down
import android.Manifest
import android.app.DownloadManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.util.zip.ZipInputStream

private const val TAG = "AniBrowser"
private const val CHANNEL_FAVORITES = "favorites"
private const val NOTIF_ID_FAVORITES = 1001

/**
 * Boots the bundled Node.js server (server.js + scraper.js + ui/) inside the
 * app process and hands the bound port back to JS through the same
 * anibrowser-port.json marker file the original Kotlin shell used.
 */
class AniBrowserNodeModule : Module() {
    companion object {
        /** Set from the web UI (setVideoActive) — read by MainActivity.onUserLeaveHint for PiP. */
        @Volatile
        var videoActive: Boolean = false
    }

    override fun definition() = ModuleDefinition {
        Name("AniBrowserNode")

        AsyncFunction("startNode") { zipPath: String, dataDir: String, promise: Promise ->
            Thread {
                try {
                    val marker = File(dataDir, "anibrowser-port.json")
                    val projectDir = File(dataDir, "nodejs-project")
                    val zip = resolveZip(zipPath)

                    val running = existingPort(marker)
                    if (running != null) {
                        // already live — just refresh the served files (dev reloads)
                        if (needsExtract(zip, File(dataDir))) extractProject(zip, projectDir)
                        promise.resolve(running)
                        return@Thread
                    }

                    marker.delete() // never read a previous run's port
                    extractProject(zip, projectDir)

                    NodeBridge().also { it.registerNodeDataDirPath(dataDir) }
                    Thread {
                        try {
                            NodeBridge().startNodeWithArguments(
                                arrayOf("node", "${projectDir.absolutePath}/index.js"),
                                projectDir.absolutePath, true
                            )
                        } catch (t: Throwable) {
                            Log.e(TAG, "node thread died", t)
                        }
                    }.start()

                    val port = waitForPort(marker, 30_000)
                    if (port != null) promise.resolve(port)
                    else promise.reject("TIMEOUT", "node did not bind a port within 30s (see logcat -s NODEJS AniBrowser)", null)
                } catch (t: Throwable) {
                    Log.e(TAG, "startNode failed", t)
                    promise.reject("FAILED", t.message ?: "startNode failed", t)
                }
            }.start()
        }

        // background the app instead of finishing the activity (keeps node + playback alive)
        Function("moveTaskToBack") {
            val moved = appContext.currentActivity?.moveTaskToBack(true) ?: false
            moved
        }

        // web UI reports whether a <video> is currently playing (drives PiP on home)
        Function("setVideoActive") { active: Boolean ->
            videoActive = active
            active
        }

        // web UI asks to dock the current video into picture-in-picture
        // (sidebar tap while playing — mirrors MainActivity.onUserLeaveHint)
        Function("enterPip") {
            val activity = appContext.currentActivity ?: return@Function false
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@Function false
            return@Function try {
                activity.enterPictureInPictureMode(
                    android.app.PictureInPictureParams.Builder()
                        .setAspectRatio(android.util.Rational(16, 9))
                        .build()
                )
            } catch (e: IllegalStateException) {
                Log.w(TAG, "enterPip rejected", e)
                false
            }
        }

        // favorites update → system notification. First call on API 33+ triggers
        // the POST_NOTIFICATIONS runtime prompt; if it isn't granted yet the
        // notification is dropped for that round (the in-app bell still shows it)
        Function("notify") { title: String, body: String ->
            val activity = appContext.currentActivity
            val context = appContext.reactContext ?: return@Function false

            ensureFavoritesChannel(context)
            if (Build.VERSION.SDK_INT >= 33 &&
                ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED
            ) {
                if (activity != null) {
                    ActivityCompat.requestPermissions(
                        activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4201
                    )
                }
                return@Function false // prompt showing — don't post this one
            }

            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            val pi = PendingIntent.getActivity(
                context, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val notification = NotificationCompat.Builder(context, CHANNEL_FAVORITES)
                .setSmallIcon(R.drawable.ic_notif)
                .setContentTitle(title.ifBlank { "AniBrowser" })
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(context).notify(NOTIF_ID_FAVORITES, notification)
            true
        }

        // hand a downloaded APK to the system package installer via FileProvider.
        // Async on purpose: a sync Function that throws surfaces as an unhandled
        // JS exception in the WebView shell and kills the whole app — every
        // failure path below must reject the promise so App.tsx can toast it.
        AsyncFunction("installApk") { path: String, promise: Promise ->
            val activity = appContext.currentActivity
            val context = appContext.reactContext
            if (activity == null || context == null) {
                promise.reject("NO_ACTIVITY", "app is in the background — reopen it and tap install again", null)
                return@AsyncFunction
            }
            Thread {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                        !activity.packageManager.canRequestPackageInstalls()
                    ) {
                        // Android 8+ refuses installer intents until the user
                        // flips "install unknown apps" for this app
                        activity.startActivity(
                            Intent(
                                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:${activity.packageName}")
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        )
                        promise.reject(
                            "NEED_INSTALL_PERMISSION",
                            "Allow AniNinja to install apps, then tap Install update again",
                            null
                        )
                        return@Thread
                    }

                    var file = File(path)
                    if (!file.exists()) throw Exception("APK not found: $path")
                    val uri = try {
                        FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                    } catch (t: Throwable) {
                        // the APK sits outside the roots in file_paths.xml — copy it
                        // into the app cache, which file_paths.xml always covers
                        val shared = File(File(context.cacheDir, "updates"), file.name)
                        shared.parentFile?.mkdirs()
                        if (!shared.exists()) File(path).copyTo(shared, overwrite = true)
                        file = shared
                        FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                    }
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    )
                    promise.resolve(true)
                } catch (t: Throwable) {
                    Log.e(TAG, "installApk failed", t)
                    promise.reject("INSTALL_FAILED", t.message ?: "install failed", t)
                }
            }.start()
        }

        // "open the folder where updates download" — Android keeps the APK in the
        // app's private files dir, which no file manager can reach, so copy it
        // into public Downloads (MediaStore, one copy per version) and open the
        // system Downloads list where the user can see and re-share it
        AsyncFunction("openUpdatesDir") { path: String, promise: Promise ->
            val activity = appContext.currentActivity
            val context = appContext.reactContext
            if (activity == null || context == null) {
                promise.reject("NO_ACTIVITY", "app is in the background", null)
                return@AsyncFunction
            }
            Thread {
                try {
                    val src = File(path)
                    if (!src.exists()) throw Exception("APK not found: $path")
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) copyToDownloads(context, src)
                    activity.startActivity(
                        Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                    promise.resolve(true)
                } catch (t: Throwable) {
                    Log.e(TAG, "openUpdatesDir failed", t)
                    promise.reject("OPEN_DIR_FAILED", t.message ?: "could not open the updates folder", t)
                }
            }.start()
        }
    }

    private fun ensureFavoritesChannel(context: android.content.Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_FAVORITES, "Favorite updates", NotificationManager.IMPORTANCE_DEFAULT
        ).apply { description = "New episodes of anime in your favorites list" }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    /** Copy an APK into public Downloads (MediaStore), skipping a re-copy when
     *  the same file name is already there. Best-effort: false on any failure. */
    private fun copyToDownloads(context: android.content.Context, src: File): Boolean = try {
        val cr = context.contentResolver
        val name = src.name
        val dup = cr.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.DISPLAY_NAME}=? AND ${MediaStore.MediaColumns.RELATIVE_PATH}=?",
            arrayOf(name, Environment.DIRECTORY_DOWNLOADS + "/"),
            null
        )!!.use { c -> c.moveToFirst() }
        if (!dup) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "application/vnd.android.package-archive")
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: throw Exception("MediaStore refused the download entry")
            cr.openOutputStream(uri)!!.use { out -> src.inputStream().use { it.copyTo(out) } }
        }
        true
    } catch (t: Throwable) {
        Log.w(TAG, "copyToDownloads failed", t)
        false
    }

    private fun existingPort(marker: File): Int? {
        try {
            val o = JSONObject(marker.readText())
            val pid = o.optInt("pid", 0)
            val port = o.getInt("port")
            if (pidAlive(pid)) return port
        } catch (_: Exception) { }
        return null
    }

    private fun pidAlive(pid: Int) = pid > 0 && File("/proc/$pid").exists()

    /**
     * Release builds pass "asset:<name>" — the zip ships as a raw Android asset.
     * expo-asset's on-device cache never revalidates across app updates (after
     * the v1.1.2 upgrade it kept serving the previous release's zip, so the app
     * ran the old server forever), so copy the asset ourselves. The copy is
     * stamped with its CRC so a changed APK swaps it in; an unchanged asset
     * reuses the cached copy (CRC scan only, no rewrite).
     */
    private fun resolveZip(zipPath: String): File {
        if (!zipPath.startsWith("asset:")) return File(zipPath)
        val name = zipPath.removePrefix("asset:")
        val ctx = appContext.reactContext ?: throw IllegalStateException("no react context")
        val cache = File(ctx.cacheDir, name)
        val stamp = File(ctx.cacheDir, "$name.stamp")
        val tmp = File(ctx.cacheDir, "$name.tmp")
        val crc = java.util.zip.CRC32()
        ctx.assets.open(name).use { input ->
            tmp.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    crc.update(buf, 0, n)
                    out.write(buf, 0, n)
                }
            }
        }
        val sig = "${crc.value}:${tmp.length()}"
        val reusable = try { stamp.readText() == sig && cache.exists() } catch (_: Exception) { false }
        if (reusable) {
            tmp.delete()
            return cache
        }
        if (cache.exists() && !cache.delete()) throw IllegalStateException("cannot replace $cache")
        if (!tmp.renameTo(cache)) throw IllegalStateException("rename failed for $cache")
        stamp.writeText(sig)
        return cache
    }

    private fun zipSig(zip: File): String {
        val crc = java.util.zip.CRC32()
        zip.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                crc.update(buf, 0, n)
            }
        }
        return "${crc.value}:${zip.length()}"
    }

    private fun needsExtract(zip: File, dataDir: File): Boolean {
        val stamp = File(dataDir, "nodejs-project.zip.stamp")
        return try { stamp.readText() != zipSig(zip) } catch (_: Exception) { true }
    }

    private fun stampExtracted(zip: File, dataDir: File) {
        File(dataDir, "nodejs-project.zip.stamp").writeText(zipSig(zip))
    }

    /** Unzip into a temp dir (stripping the top-level folder), then atomically swap into place. */
    private fun extractProject(zip: File, projectDir: File) {
        val base = projectDir.parentFile ?: throw IllegalStateException("no parent for $projectDir")
        val tmp = File(base, "nodejs-project.tmp")
        tmp.deleteRecursively()
        val zin = java.util.zip.ZipFile(zip)
        zin.use { z ->
            val entries = z.entries()
            while (entries.hasMoreElements()) {
                val e = entries.nextElement()
                if (e.isDirectory) continue
                // zip entries live under "nodejs-project/" — strip it so the
                // temp dir can be renamed directly onto projectDir
                val out = File(tmp, e.name.removePrefix("nodejs-project/"))
                out.parentFile?.mkdirs()
                z.getInputStream(e).use { input -> out.outputStream().use { input.copyTo(it) } }
            }
        }
        val trash = File(base, "nodejs-project.trash")
        if (projectDir.exists()) projectDir.renameTo(trash)
        if (!tmp.renameTo(projectDir)) throw IllegalStateException("rename failed for $projectDir")
        trash.deleteRecursively()
        stampExtracted(zip, projectDir.parentFile!!)
    }

    private fun waitForPort(marker: File, timeoutMs: Long): Int? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                val p = JSONObject(marker.readText()).getInt("port")
                if (p in 1..65535) return p
            } catch (_: Exception) { /* not written yet */ }
            Thread.sleep(100)
        }
        return null
    }
}