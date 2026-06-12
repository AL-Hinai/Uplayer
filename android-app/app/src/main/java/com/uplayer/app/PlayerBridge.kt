package com.uplayer.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONObject

/**
 * Exposed to the web app as `window.AndroidPlayer`. Hands the active stream URL to
 * an external Android video player (VLC, MX Player, or any video handler)
 * via an ACTION_VIEW intent - the mobile equivalent of "open in VLC" on desktop.
 */
class PlayerBridge(private val activity: Activity) {

    private val tag = "Uplayer/Player"

    @JavascriptInterface
    fun open(payloadJson: String) {
        activity.runOnUiThread {
            try {
                val json = JSONObject(payloadJson)
                val url = json.getString("url")
                val contentType = json.optString("contentType", "video/*")
                val title = json.optString("title", "Uplayer")

                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(Uri.parse(url), contentType)
                    putExtra("title", title)
                    putExtra("secure_uri", true)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val chooser = Intent.createChooser(intent, "Open with")
                if (intent.resolveActivity(activity.packageManager) != null) {
                    activity.startActivity(chooser)
                } else {
                    Toast.makeText(activity, "No video player installed", Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Log.e(tag, "open() failed", e)
                Toast.makeText(activity, "Could not open player", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
