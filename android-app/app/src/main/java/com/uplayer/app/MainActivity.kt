package com.uplayer.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.android.gms.cast.framework.CastContext
import com.uplayer.app.databinding.ActivityMainBinding
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.URL

class MainActivity : AppCompatActivity() {

    private val tag = "Uplayer/Main"
    /** One warning per launch, not one per onResume. */
    private var notificationWarningShown = false
    private lateinit var binding: ActivityMainBinding
    private lateinit var castBridge: CastBridge
    private val serverUrl = "http://localhost:3000"
    private val jsLog = StringBuilder()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applySystemBarInsets()

        requestNotificationPermissionIfNeeded()
        initCast()
        configureWebView()
        addLogButton()

        // Boot the embedded Node server (foreground service), passing our LAN IP so
        // cast URLs are reachable from the TV.
        val wifiIp = currentWifiIpv4().orEmpty()
        Log.i(tag, "Wi-Fi IP: $wifiIp")
        NodeService.start(this, wifiIp)

        waitForServerThenLoad()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Backing out past the first page means "quit", not "hide": removing the
                // task fires NodeService.onTaskRemoved, which stops the engine and clears
                // the notification. Plain finish() would leave both running with no way
                // out but Force Stop. Home/screen-off deliberately keeps us alive.
                if (binding.webview.canGoBack()) binding.webview.goBack() else finishAndRemoveTask()
            }
        })
    }

    /**
     * Keep all content (incl. the wizard's bottom Back/Stop/Skip buttons) clear of
     * the status bar and the bottom system navigation bar. Without this, on
     * edge-to-edge devices the bottom buttons render under the nav bar and can't
     * be tapped.
     */
    private fun applySystemBarInsets() {
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(window, false)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(binding.root) { v, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
    }

    private fun initCast() {
        castBridge = CastBridge(this)
        try {
            val ctx = CastContext.getSharedInstance(applicationContext)
            castBridge.attach(ctx)
        } catch (e: Exception) {
            // Google Play services unavailable — cast simply won't be offered.
            Log.w(tag, "Cast unavailable: ${e.message}")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        val webView: WebView = binding.webview
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            databaseEnabled = true
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        webView.addJavascriptInterface(castBridge, "AndroidCast")
        webView.addJavascriptInterface(PlayerBridge(this), "AndroidPlayer")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                if (url != null && url.startsWith(serverUrl)) {
                    binding.loadingOverlay.visibility = View.GONE
                    // Catch the "loaded but blank/white" case (empty response or JS crash).
                    view?.postDelayed({
                        view.evaluateJavascript(
                            "(function(){return (document.body?document.body.innerText.trim().length:0);})()"
                        ) { result ->
                            val len = result?.trim('"')?.toIntOrNull() ?: 0
                            if (len < 2) showDiagnostics("Page loaded but rendered blank (body text length=$len)")
                        }
                    }, 2500)
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                if (request?.isForMainFrame == true) {
                    showDiagnostics("WebView load error ${error?.errorCode}: ${error?.description}")
                }
            }

            override fun onReceivedHttpError(
                view: WebView?,
                request: android.webkit.WebResourceRequest?,
                errorResponse: android.webkit.WebResourceResponse?
            ) {
                if (request?.isForMainFrame == true) {
                    showDiagnostics("HTTP ${errorResponse?.statusCode} from server: ${errorResponse?.reasonPhrase}")
                }
            }
        }
        // Minimal chrome client to support HTML5 fullscreen <video>.
        webView.webChromeClient = object : WebChromeClient() {
            private var customView: View? = null

            override fun onConsoleMessage(msg: android.webkit.ConsoleMessage?): Boolean {
                if (msg != null) {
                    val line = "[JS ${msg.messageLevel()}] ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}"
                    jsLog.append(line).append('\n')
                    Log.d("Uplayer/JS", line)
                }
                return super.onConsoleMessage(msg)
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                customView = view
                (binding.root as FrameLayout).addView(
                    view,
                    FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                )
            }

            override fun onHideCustomView() {
                customView?.let { (binding.root as FrameLayout).removeView(it) }
                customView = null
            }
        }
    }

    /** Poll the embedded server until it answers, then load the UI. */
    private fun waitForServerThenLoad() {
        Thread {
            // First launch extracts ~13k files then boots Node — allow generous time.
            val deadline = System.currentTimeMillis() + 90_000
            var up = false
            while (System.currentTimeMillis() < deadline) {
                if (isServerUp()) { up = true; break }
                try { Thread.sleep(400) } catch (e: InterruptedException) { break }
            }
            runOnUiThread {
                if (up) {
                    binding.webview.loadUrl(serverUrl)
                } else {
                    Log.e(tag, "Server did not come up in time")
                    showDiagnostics("Uplayer server did not respond within 90s")
                }
            }
        }.start()
    }

    /**
     * Render the embedded Node boot log (+ captured JS console) on screen instead of
     * a blank page, so failures are self-reporting without adb/logcat.
     */
    /** Last `maxChars` of a file (the crash is at the end). */
    private fun tailFile(name: String, maxChars: Int): String {
        return try {
            val f = java.io.File(filesDir, name)
            if (!f.exists()) return ""
            val t = f.readText()
            if (t.length <= maxChars) t else "…(truncated)…\n" + t.substring(t.length - maxChars)
        } catch (e: Exception) { "error reading $name: ${e.message}" }
    }

    private fun buildDiagnosticsText(headline: String): String {
        val sb = StringBuilder()
        sb.append("== ").append(headline).append(" ==\n\n")
        // Previous session first — a mid-stream crash that killed the process lives here.
        val prev = tailFile("boot-prev.log", 16000)
        if (prev.isNotBlank()) {
            sb.append("--- PREVIOUS session (last crash) ---\n").append(prev).append("\n\n")
        }
        sb.append("--- CURRENT session ---\n")
        val cur = tailFile("boot.log", 16000)
        sb.append(if (cur.isNotBlank()) cur else "(no boot.log — Node may not have started)")
        if (jsLog.isNotEmpty()) {
            sb.append("\n--- WebView JS console ---\n").append(jsLog)
        }
        return sb.toString()
    }

    /** Replace the WebView with the log — used when the page itself failed to load. */
    private fun showDiagnostics(headline: String) {
        val esc = buildDiagnosticsText(headline)
            .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        val html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>" +
            "<body style='background:#000;color:#3f6;font-family:monospace;font-size:12px;padding:12px'>" +
            "<pre style='white-space:pre-wrap;word-break:break-word'>$esc</pre></body></html>"
        val b64 = android.util.Base64.encodeToString(html.toByteArray(), android.util.Base64.NO_PADDING)
        binding.webview.loadData(b64, "text/html", "base64")
        binding.loadingOverlay.visibility = View.GONE
    }

    /** Native scrollable overlay over the running app — used by the LOG button so
        the user can inspect logs (incl. a previous crash) without losing the UI. */
    private fun showLogOverlay() {
        val root = binding.root as FrameLayout
        val scroll = android.widget.ScrollView(this)
        scroll.setBackgroundColor(0xF2000000.toInt())
        val tv = android.widget.TextView(this).apply {
            text = buildDiagnosticsText("Manual log view (tap to close)")
            setTextColor(0xFF33FF66.toInt())
            typeface = android.graphics.Typeface.MONOSPACE
            textSize = 10f
            setPadding(28, 48, 28, 48)
            setTextIsSelectable(true)
        }
        scroll.addView(tv)
        scroll.setOnClickListener { root.removeView(scroll) }
        root.addView(scroll, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    }

    private fun addLogButton() {
        val btn = android.widget.TextView(this).apply {
            text = "LOG"
            setTextColor(0xFFFFFFFF.toInt())
            setBackgroundColor(0x66000000)
            setPadding(20, 8, 20, 8)
            textSize = 11f
            setOnClickListener { showLogOverlay() }
        }
        val lp = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT)
        lp.gravity = android.view.Gravity.TOP or android.view.Gravity.END
        lp.topMargin = 110
        lp.rightMargin = 10
        (binding.root as FrameLayout).addView(btn, lp)
    }

    private fun isServerUp(): Boolean = try {
        val conn = URL(serverUrl).openConnection() as HttpURLConnection
        conn.connectTimeout = 1000
        conn.readTimeout = 1000
        conn.requestMethod = "GET"
        val code = conn.responseCode
        conn.disconnect()
        code in 200..499
    } catch (e: Exception) {
        false
    }

    private fun currentWifiIpv4(): String? = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList().asSequence() }
            .filterIsInstance<Inet4Address>()
            .map { it.hostAddress }
            .firstOrNull { ip -> ip != null && isPrivate(ip) }
    } catch (e: Exception) {
        null
    }

    private fun isPrivate(ip: String): Boolean =
        ip.startsWith("192.168.") || ip.startsWith("10.") ||
            Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(ip)

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                ActivityCompat.requestPermissions(
                    this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS
                )
            }
        }
    }

    /**
     * Re-post the service notification once the user answers the permission prompt.
     *
     * requestPermissions() is ASYNCHRONOUS: it shows the dialog and returns immediately, so
     * onCreate goes straight on to NodeService.start() and startForeground() fires while the
     * permission is still undecided. On Android 13+ that means the notification is silently
     * SUPPRESSED — the service runs, but invisibly, and the user loses both the way back into
     * the app and the Stop action, which is the only thing standing between them and Force Stop.
     *
     * Re-starting the service here re-posts it under the same NOTIFICATION_ID (an update, not a
     * duplicate), and NodeRunner.start() is guarded by an AtomicBoolean, so Node is not started
     * twice. Without this the notification only ever appears on the SECOND launch of the app.
     */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_NOTIFICATIONS) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            Log.i(tag, "Notifications granted - re-posting the service notification")
            NodeService.start(this, currentWifiIpv4().orEmpty())
        } else {
            // Not fatal: streaming still works. But the only in-app way to stop the engine is
            // gone, so say so plainly in the log rather than leaving it a silent mystery.
            Log.w(tag, "Notifications denied - the running notification and its Stop action cannot be shown")
        }
    }

    /**
     * Re-assert the service notification every time Uplayer comes to the foreground.
     *
     * The contract is "if Uplayer is open, the notification is there" — streaming or not. Posting
     * it once from onCreate could not deliver that: if the notification was suppressed (permission
     * still undecided on first run), or the service was killed and restarted by the system, or the
     * user swiped the notification on an OEM build that allows it, nothing ever put it back.
     *
     * Safe to call repeatedly: startForeground() re-posts under the same NOTIFICATION_ID, which is
     * an update rather than a duplicate, and NodeRunner.start() is guarded by an AtomicBoolean so
     * the Node runtime is never started twice. Calling from onResume is also the only way this can
     * be legal on Android 12+, where starting a foreground service from the background throws.
     */
    override fun onResume() {
        super.onResume()
        NodeService.start(this, currentWifiIpv4().orEmpty())
        warnIfNotificationsBlocked()
    }

    /**
     * A blocked notification is otherwise completely silent: streaming still works, so nothing
     * looks wrong, but the way back into the app and the Stop action are both gone — which leaves
     * Force Stop as the only exit, the exact problem the notification exists to solve. Say it out
     * loud once per launch instead of letting the user discover it by its absence.
     */
    private fun warnIfNotificationsBlocked() {
        if (notificationWarningShown) return
        if (androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        notificationWarningShown = true
        Log.w(tag, "Notifications are disabled for Uplayer - status notification and Stop action cannot appear")
        android.widget.Toast.makeText(
            this,
            "Notifications are off for Uplayer, so the running/Stop notification can't be shown. " +
                "Enable them in Settings > Apps > Uplayer > Notifications.",
            android.widget.Toast.LENGTH_LONG
        ).show()
    }

    override fun onDestroy() {
        if (this::castBridge.isInitialized) castBridge.detach()
        super.onDestroy()
    }

    private companion object {
        /** requestPermissions code for POST_NOTIFICATIONS; matched in onRequestPermissionsResult. */
        const val REQ_NOTIFICATIONS = 42
    }
}
