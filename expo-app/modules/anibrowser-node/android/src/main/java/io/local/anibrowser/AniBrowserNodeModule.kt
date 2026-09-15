package io.local.anibrowser

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
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
                    val zip = File(zipPath)

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

        // hand a downloaded APK to the system package installer via FileProvider
        Function("installApk") { path: String ->
            val activity = appContext.currentActivity
                ?: throw Exception("no foreground activity")
            val file = File(path)
            if (!file.exists()) throw Exception("APK not found: $path")
            val uri: Uri = FileProvider.getUriForFile(
                activity, "${activity.packageName}.fileprovider", file
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            true
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

    private fun needsExtract(zip: File, dataDir: File): Boolean {
        val stamp = File(dataDir, "nodejs-project.zip.stamp")
        val sig = "${zip.length()}"
        return try { stamp.readText() != sig } catch (_: Exception) { true }
    }

    private fun stampExtracted(zip: File, dataDir: File) {
        File(dataDir, "nodejs-project.zip.stamp").writeText("${zip.length()}")
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