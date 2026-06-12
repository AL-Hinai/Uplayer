package com.uplayer.app

import android.app.Activity
import android.util.Log
import android.webkit.JavascriptInterface
import androidx.mediarouter.app.MediaRouteChooserDialog
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaLoadRequestData
import com.google.android.gms.cast.MediaMetadata
import com.google.android.gms.cast.MediaTrack
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastState
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.SessionManagerListener
import org.json.JSONObject

/**
 * Exposed to the web app as `window.AndroidCast`. Replaces the browser-only
 * Google Cast *sender SDK* (which cannot run in a WebView) with the native Cast
 * SDK. The web app builds a flat payload (url/contentType/title/subtitle) and we
 * load it onto the selected Chromecast.
 */
class CastBridge(private val activity: Activity) {

    private val tag = "Uplayer/Cast"
    private var castContext: CastContext? = null
    private var pendingLoad: MediaLoadRequestData? = null

    private val sessionListener = object : SessionManagerListener<CastSession> {
        override fun onSessionStarted(session: CastSession, sessionId: String) = loadPending(session)
        override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = loadPending(session)
        override fun onSessionStarting(session: CastSession) {}
        override fun onSessionStartFailed(session: CastSession, error: Int) {}
        override fun onSessionEnding(session: CastSession) {}
        override fun onSessionEnded(session: CastSession, error: Int) {}
        override fun onSessionResuming(session: CastSession, sessionId: String) {}
        override fun onSessionResumeFailed(session: CastSession, error: Int) {}
        override fun onSessionSuspended(session: CastSession, reason: Int) {}
    }

    /** Call from Activity.onCreate (UI thread) once Cast is initialized. */
    fun attach(context: CastContext) {
        castContext = context
        context.sessionManager.addSessionManagerListener(sessionListener, CastSession::class.java)
    }

    fun detach() {
        castContext?.sessionManager?.removeSessionManagerListener(sessionListener, CastSession::class.java)
    }

    @JavascriptInterface
    fun isAvailable(): Boolean {
        // True unless we know for certain there are no cast devices on the network.
        return castContext?.castState != CastState.NO_DEVICES_AVAILABLE
    }

    @JavascriptInterface
    fun cast(payloadJson: String) {
        activity.runOnUiThread {
            try {
                val request = buildLoadRequest(JSONObject(payloadJson))
                val session = castContext?.sessionManager?.currentCastSession
                if (session != null && session.isConnected) {
                    session.remoteMediaClient?.load(request)
                } else {
                    // No device selected yet — remember the media and open the picker.
                    pendingLoad = request
                    showDevicePicker()
                }
            } catch (e: Exception) {
                Log.e(tag, "cast() failed", e)
            }
        }
    }

    /**
     * Swap the subtitle track on the *active* session as embedded subs finish
     * extracting. A Chromecast receiver only fetches a text track once (and caches
     * it), so we must re-load the media with the new cache-busted subtitle URL.
     * We read the live playback position and resume there, so the only visible
     * effect is the subtitle appearing/updating — not a restart.
     */
    @JavascriptInterface
    fun updateSubtitle(payloadJson: String) {
        activity.runOnUiThread {
            try {
                val session = castContext?.sessionManager?.currentCastSession
                val client = session?.remoteMediaClient
                if (session == null || !session.isConnected || client == null) {
                    return@runOnUiThread
                }
                val json = JSONObject(payloadJson)
                val positionMs = client.approximateStreamPosition
                if (positionMs > 0) {
                    json.put("currentTimeSec", positionMs / 1000.0)
                }
                client.load(buildLoadRequest(json))
            } catch (e: Exception) {
                Log.e(tag, "updateSubtitle() failed", e)
            }
        }
    }

    @JavascriptInterface
    fun stop() {
        activity.runOnUiThread {
            castContext?.sessionManager?.endCurrentSession(true)
        }
    }

    private fun loadPending(session: CastSession) {
        val request = pendingLoad ?: return
        pendingLoad = null
        session.remoteMediaClient?.load(request)
    }

    private fun showDevicePicker() {
        val ctx = castContext ?: return
        val dialog = MediaRouteChooserDialog(activity)
        dialog.routeSelector = ctx.mergedSelector ?: return
        dialog.show()
    }

    private fun buildLoadRequest(json: JSONObject): MediaLoadRequestData {
        val url = json.getString("url")
        val contentType = json.optString("contentType", "video/mp4")
        val title = json.optString("title", "Uplayer")
        val subtitleUrl = json.optString("subtitleUrl", "")
        val subtitleLang = json.optString("subtitleLang", "en")
        val currentTimeSec = json.optDouble("currentTimeSec", 0.0)

        val metadata = MediaMetadata(MediaMetadata.MEDIA_TYPE_MOVIE)
        metadata.putString(MediaMetadata.KEY_TITLE, title)

        val builder = MediaInfo.Builder(url)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType(contentType)
            .setMetadata(metadata)

        var activeTracks: LongArray? = null
        if (subtitleUrl.isNotEmpty()) {
            val track = MediaTrack.Builder(1L, MediaTrack.TYPE_TEXT)
                .setSubtype(MediaTrack.SUBTYPE_SUBTITLES)
                .setContentId(subtitleUrl)
                .setContentType("text/vtt")
                .setLanguage(if (subtitleLang.isNotEmpty()) subtitleLang else "en")
                .setName("Subtitles")
                .build()
            builder.setMediaTracks(listOf(track))
            activeTracks = longArrayOf(1L)
        }

        val loadBuilder = MediaLoadRequestData.Builder()
            .setMediaInfo(builder.build())
            .setAutoplay(true)
        if (activeTracks != null) {
            loadBuilder.setActiveTrackIds(activeTracks)
        }
        if (currentTimeSec > 0.0) {
            loadBuilder.setCurrentTime((currentTimeSec * 1000).toLong())
        }
        return loadBuilder.build()
    }
}
