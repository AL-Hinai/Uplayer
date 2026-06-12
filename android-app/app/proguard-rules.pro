# Keep the JNI entry point used by the nodejs-mobile native bridge.
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep class com.uplayer.app.NodeRunner { *; }

# Keep JavaScript interface methods exposed to the WebView bridge.
-keepclassmembers class com.uplayer.app.CastBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class com.uplayer.app.PlayerBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Cast OptionsProvider is instantiated reflectively by Google Cast SDK.
-keep class com.uplayer.app.CastOptionsProvider { *; }
