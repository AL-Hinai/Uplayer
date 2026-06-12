package com.uplayer.app

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the embedded nodejs-mobile runtime: extracts the bundled Node project out
 * of the APK assets and starts it on a dedicated native thread.
 *
 * The native methods are implemented in src/main/cpp/native-lib.cpp, which links
 * against the prebuilt libnode.so from the nodejs-mobile release (see BUILD.md).
 */
object NodeRunner {

    private const val TAG = "Uplayer/Node"
    private const val PROJECT_DIR = "nodejs-project"
    private const val VERSION_ASSET = "nodejs-project/.bundle-version"
    private val started = AtomicBoolean(false)

    init {
        // Order matters: libnode first, then our JNI shim that calls into it.
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
    }

    /** Implemented in native-lib.cpp; blocks for the life of the Node process. */
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    /**
     * Extract assets (idempotent, re-copies when the bundled version changes) and
     * launch Node on a background thread. Safe to call more than once.
     */
    fun start(context: Context, wifiIp: String) {
        if (!started.compareAndSet(false, true)) {
            Log.i(TAG, "Node already started")
            return
        }
        val appContext = context.applicationContext
        Thread({
            try {
                val projectDir = ensureProjectExtracted(appContext)
                val mainJs = File(projectDir, "main.js").absolutePath
                val nativeLibDir = appContext.applicationInfo.nativeLibraryDir
                val filesDir = appContext.filesDir.absolutePath
                Log.i(TAG, "Launching node $mainJs")
                val code = startNodeWithArguments(
                    arrayOf("node", mainJs, nativeLibDir, filesDir, wifiIp)
                )
                Log.w(TAG, "Node exited with code $code")
            } catch (t: Throwable) {
                Log.e(TAG, "Node thread crashed", t)
            } finally {
                started.set(false)
            }
        }, "nodejs-mobile").start()
    }

    /**
     * Copy assets/nodejs-project -> filesDir/nodejs-project. Skips the (slow) copy
     * when the already-extracted bundle version matches the one in assets.
     */
    private fun ensureProjectExtracted(context: Context): File {
        val target = File(context.filesDir, PROJECT_DIR)
        val bundledVersion = readAssetText(context, VERSION_ASSET) ?: "dev"
        val stamp = File(target, ".bundle-version")
        val current = if (stamp.exists()) stamp.readText().trim() else ""

        if (target.exists() && current == bundledVersion.trim()) {
            Log.i(TAG, "nodejs-project up to date ($current)")
            return target
        }

        Log.i(TAG, "Extracting nodejs-project ($current -> ${bundledVersion.trim()})")
        if (target.exists()) target.deleteRecursively()
        target.mkdirs()
        copyAssetDir(context, PROJECT_DIR, target)
        return target
    }

    private fun copyAssetDir(context: Context, assetPath: String, dest: File) {
        val assets = context.assets
        val children = assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            // It's a file (or an empty dir we can't tell apart) — try copying as a file.
            copyAssetFile(context, assetPath, dest)
            return
        }
        dest.mkdirs()
        for (child in children) {
            val childAssetPath = "$assetPath/$child"
            val childDest = File(dest, child)
            val grandChildren = assets.list(childAssetPath) ?: emptyArray()
            if (grandChildren.isEmpty()) {
                copyAssetFile(context, childAssetPath, childDest)
            } else {
                copyAssetDir(context, childAssetPath, childDest)
            }
        }
    }

    private fun copyAssetFile(context: Context, assetPath: String, dest: File) {
        try {
            context.assets.open(assetPath).use { input ->
                dest.parentFile?.mkdirs()
                FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
            }
        } catch (e: Exception) {
            // Directories with no children land here harmlessly; real failures are logged.
            Log.w(TAG, "Skip asset $assetPath: ${e.message}")
        }
    }

    private fun readAssetText(context: Context, assetPath: String): String? = try {
        context.assets.open(assetPath).use { it.readTextSafely() }
    } catch (e: Exception) {
        null
    }

    private fun InputStream.readTextSafely(): String = bufferedReader().use { it.readText() }
}
