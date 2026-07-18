package com.uplayer.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File

/**
 * Foreground service that hosts the embedded Node runtime, so torrent streaming
 * and an active cast session keep running when the app is backgrounded.
 */
class NodeService : Service() {

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // The notification's Stop button routes here. Must be handled before
        // startForeground, or we'd re-post the notification we're about to remove.
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }

        startForeground(NOTIFICATION_ID, buildNotification())

        val wifiIp = intent?.getStringExtra(EXTRA_WIFI_IP).orEmpty()
        NodeRunner.start(applicationContext, wifiIp)
        // NOT_STICKY: once stopped (e.g. on task removal) Android must not resurrect us.
        return START_NOT_STICKY
    }

    /**
     * The user swiped the app away from recents, or backed out of the app entirely
     * (MainActivity calls finishAndRemoveTask, which lands here). Either way it means
     * "quit" — backgrounding via Home keeps us alive, that's a different lifecycle event.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        shutdown()
    }

    /**
     * The embedded Node runtime runs on a thread in this process with no clean shutdown
     * hook (node::Start blocks for its lifetime), so we delete the downloaded files
     * ourselves, then terminate the process. Reached from both quit paths: task removal
     * and the notification's Stop action.
     */
    private fun shutdown() {
        wipeDownloadDirs()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        // Kill the process so nodejs-mobile (WebTorrent, ffmpeg children) actually stops.
        android.os.Process.killProcess(android.os.Process.myPid())
    }

    private fun buildNotification(): Notification {
        val piFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        // MainActivity is singleTask, so a bare launch intent re-surfaces the existing
        // task (WebView state intact) rather than starting a second copy.
        val contentPi = PendingIntent.getActivity(
            this, REQ_CONTENT, Intent(this, MainActivity::class.java), piFlags
        )
        val stopPi = PendingIntent.getService(
            this,
            REQ_STOP,
            Intent(this, NodeService::class.java).setAction(ACTION_STOP),
            piFlags
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.node_notification_title))
            .setContentText(getString(R.string.node_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            // Android 12+ DEFERS a foreground-service notification by up to 10 seconds unless
            // it is explicitly marked immediate. Uplayer's whole point here is "the engine is
            // up, here is the way back in and the way out", which is useless ten seconds late
            // — and if the user backgrounds the app inside that window it may not appear at all.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(contentPi)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.node_notification_stop),
                stopPi
            )
            .build()
    }

    /** Remove the streaming sandbox + temp dirs (set by main.js as UPLAYER_SANDBOX_DIR / TMPDIR). */
    private fun wipeDownloadDirs() {
        for (name in arrayOf("sandbox", "uplayer-tmp")) {
            try {
                val dir = File(filesDir, name)
                if (dir.exists()) dir.deleteRecursively()
            } catch (e: Exception) {
                Log.w(TAG, "Could not wipe $name", e)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.node_channel_name),
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    companion object {
        private const val TAG = "Uplayer/Node"
        private const val CHANNEL_ID = "uplayer_node"
        private const val NOTIFICATION_ID = 1001
        private const val REQ_CONTENT = 1
        private const val REQ_STOP = 2
        const val EXTRA_WIFI_IP = "wifi_ip"
        const val ACTION_STOP = "com.uplayer.app.STOP"

        fun start(context: Context, wifiIp: String) {
            val intent = Intent(context, NodeService::class.java).apply {
                putExtra(EXTRA_WIFI_IP, wifiIp)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
