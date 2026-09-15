package io.local.anibrowser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.File

class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var root: FrameLayout
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private val main = Handler(Looper.getMainLooper())

    private companion object {
        const val PROJECT_DIR = "nodejs-project"
        const val PORT_FILE = "anibrowser-port.json"
        const val PREFS = "anibrowser_native"
        const val TAG = "AniBrowser"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val files = filesDir.absolutePath
        copyNodeProjectIfNeeded()

        webView = makeWebView()
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0b0e14"))
            addView(webView, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(root)

        // start node on its own thread; blocks there until the app dies
        Thread {
            try {
                NodeBridge().also { it.registerNodeDataDirPath(files) }.startNodeWithArguments(
                    arrayOf("node", "$files/$PROJECT_DIR/index.js"),
                    "$files/$PROJECT_DIR", true
                )
            } catch (t: Throwable) {
                Log.e(TAG, "node thread died", t)
            }
        }.start()

        // wait for the port marker, then load the UI from the node server origin
        Thread {
            val port = waitForPort(30_000)
            main.post {
                if (port == null) showError() else {
                    webView.visibility = View.VISIBLE
                    webView.loadUrl("http://127.0.0.1:$port/")
                }
            }
        }.start()
    }

    // ---- asset extraction (re-extract on app update) ----

    private fun copyNodeProjectIfNeeded() {
        val lastUpdate = packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val dest = File(filesDir, PROJECT_DIR)
        if (prefs.getLong("lastUpdate", 0) == lastUpdate && File(dest, "index.js").exists()) return
        val trash = File(filesDir, "$PROJECT_DIR-trash")
        if (dest.exists()) dest.renameTo(trash)
        copyAssetFolder(PROJECT_DIR, filesDir.absolutePath)
        trash.deleteRecursively()
        prefs.edit().putLong("lastUpdate", lastUpdate).apply()
    }

    private fun copyAssetFolder(from: String, toBase: String) {
        val list = assets.list(from) ?: return
        if (list.isEmpty()) {
            val out = File(toBase, from)
            out.parentFile?.mkdirs()
            assets.open(from).use { input -> out.outputStream().use { input.copyTo(it) } }
        } else {
            File(toBase, from).mkdirs()
            for (f in list) copyAssetFolder("$from/$f", toBase)
        }
    }

    // ---- WebView ----

    @SuppressLint("SetJavaScriptEnabled")
    private fun makeWebView(): WebView = WebView(this).apply {
        visibility = View.GONE
        setBackgroundColor(Color.parseColor("#0b0e14"))
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true            // app.js stores prefs/favorites/progress in localStorage
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.useWideViewPort = true              // desktop layout — style.css has no @media queries
        settings.loadWithOverviewMode = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                view.evaluateJavascript(JS_PATCHES, null)
            }

            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                // keep same-origin traffic inside the app, send everything else to the browser
                return !req.url.toString().startsWith("http://127.0.0.1")
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(view: View, cb: WebChromeClient.CustomViewCallback) {
                if (customView != null) { cb.onCustomViewHidden(); return }
                customView = view
                customViewCallback = cb
                webView.visibility = View.GONE
                addContentView(view, FrameLayout.LayoutParams(-1, -1))
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                        or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
            }

            override fun onHideCustomView() {
                val v = customView ?: return
                (v.parent as? ViewGroup)?.removeView(v)
                customView = null
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
                webView.visibility = View.VISIBLE
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private fun waitForPort(timeoutMs: Long): Int? {
        val marker = File(filesDir, PORT_FILE)
        marker.delete() // never read a previous run's port
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

    private fun showError() {
        val t = TextView(this)
        t.text = "Failed to start the AniBrowser backend.\nSee: adb logcat -s NODEJS AniBrowser"
        root.addView(t)
    }

    // ---- back button / lifecycle ----

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> webChromeClientFree()
            webView.canGoBack() -> webView.goBack()
            else -> moveTaskToBack(true) // keep node + playback alive
        }
    }

    private fun webChromeClientFree() {
        val v = customView ?: return
        (v.parent as? ViewGroup)?.removeView(v)
        customView = null
        customViewCallback?.onCustomViewHidden()
        customViewCallback = null
        webView.visibility = View.VISIBLE
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // deliberately NO webView.onPause(): audio/timers keep running while
    // backgrounded (until Android kills the process)

    // ---- Android-only JS patches (no shared-file edits; app.js is top-level) ----

    private val JS_PATCHES = """
        (function(){
          var w = document.getElementById('playerWrap');
          if (w) w.addEventListener('dblclick', function(){
            document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen();
          });
          // escape hatch if <video> DOM reparenting misbehaves on this WebView:
          // window.minimizeToMini = function(){ return false; };
        })();
    """.trimIndent()
}