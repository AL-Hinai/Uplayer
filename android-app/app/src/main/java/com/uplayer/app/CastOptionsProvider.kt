package com.uplayer.app

import android.content.Context
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Required by the Cast SDK (referenced from AndroidManifest meta-data).
 * Uses the Default Media Receiver, which plays plain HTTP(S) media URLs — exactly
 * the LAN stream URL Uplayer's server produces.
 */
class CastOptionsProvider : OptionsProvider {

    override fun getCastOptions(context: Context): CastOptions {
        val mediaOptions = CastMediaOptions.Builder()
            .setMediaSessionEnabled(true)
            .build()

        return CastOptions.Builder()
            // Default Media Receiver app id; supports MP4/HLS/WebVTT subtitles.
            .setReceiverApplicationId("CC1AD845")
            .setCastMediaOptions(mediaOptions)
            .setStopReceiverApplicationWhenEndingSession(true)
            .build()
    }

    override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null
}
