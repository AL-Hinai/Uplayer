package com.uplayer.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
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
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.node_notification_title))
            .setContentText(getString(R.string.node_notification_text))
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        startForeground(NOTIFICATION_ID, notification)

        val wifiIp = intent?.getStringExtra(EXTRA_WIFI_IP).orEmpty()
        NodeRunner.start(applicationContext, wifiIp)
        // NOT_STICKY: once stopped (e.g. on task removal) Android must not resurrect us.
        return START_NOT_STICKY
    }

    /**
     * The user swiped the app away from recents. Streaming/casting should fully stop
     * here (backgrounding via Home keeps us alive — that's a different lifecycle event).
     * The embedded Node runtime runs on a thread in this process with no clean shutdown
     * hook, so we delete the downloaded files ourselves, then terminate the process.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        wipeDownloadDirs()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        // Kill the process so nodejs-mobile (WebTorrent, ffmpeg children) actually stops.
        android.os.Process.killProcess(android.os.Process.myPid())
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
        const val EXTRA_WIFI_IP = "wifi_ip"

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
