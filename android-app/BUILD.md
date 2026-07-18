# Uplayer for Android — Build Guide

A **standalone APK** that runs the full Uplayer stack on the phone:

- The Node server (`server.js`) runs **on-device** via [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile).
- Torrenting uses **plain WebTorrent** (TCP/uTP/DHT — no native WebRTC needed).
- Transcoding/remuxing uses **aarch64 ffmpeg/ffprobe** shipped inside the APK.
- A **WebView** shows the normal Uplayer UI at `http://localhost:3000`.
- **Cast to TV** uses the **native Google Cast SDK** (the web Cast SDK can't run in a WebView).
- **Open in player** fires an Android `ACTION_VIEW` intent (VLC / MX Player / etc.).

```
┌──────────────────────── APK ────────────────────────┐
│  MainActivity (WebView)  ──JS bridge──┐              │
│      │  loads localhost:3000          │ AndroidCast  │→ Google Cast SDK → TV
│      │                                │ AndroidPlayer│→ ACTION_VIEW → VLC
│  NodeService (foreground)             │              │
│      └─ libnode.so → main.js → server.js ─ :3000 UI  │
│                                  └──── :8000 stream ──┼─→ LAN / Chromecast
│  jniLibs: libnode.so, libffmpeg.so, libffprobe.so    │
└──────────────────────────────────────────────────────┘
```

> **Status: BUILT.** A debug APK has been compiled on this machine and is at the
> repo root: **`uplayer-debug.apk`** (~71 MB, arm64-v8a). It bundles the embedded
> Node runtime, the full app, and the on-device `ffmpeg`/`ffprobe` (with libx264).
> The steps below document how it was produced / how to rebuild. Final verification
> (install + run) happens on a physical arm64 device.
>
> Build provenance (what was installed/used here):
> - JDK 17 (Temurin) + Android SDK 34, build-tools 34.0.0, **NDK 26.1.10909125**, CMake 3.22.1
> - nodejs-mobile **v18.20.4** (libnode.so + headers)
> - ffmpeg **6.1.1** + x264 (stable) cross-compiled for aarch64 via the NDK (see `scripts/build-ffmpeg-android.sh`)
> - Gradle 8.9, AGP 8.5.2

---

## Prerequisites

- **Android Studio** (Koala/2024.1+), with:
  - Android SDK Platform **34**
  - **NDK** (r26+) and **CMake** 3.22+ (install via SDK Manager → SDK Tools)
  - **JDK 17** (bundled with Android Studio)
- A phone with **arm64-v8a** (virtually all phones since ~2017) and **Google Play services** (for Cast).
- Node.js + npm on your dev machine (to bundle the app).

---

## Step 0 — Native libs on a fresh clone (`jniLibs/` is gitignored)

The large native libs (`libnode.so`, `libffmpeg.so`, `libffprobe.so`) and the
nodejs-mobile headers are **gitignored** (~113 MB, don't diff well), so a fresh clone
doesn't have them. They're managed by `scripts/setup-android-libs.js` via a cache that
lives **outside** the repo (`%UPLAYER_ANDROID_LIB_CACHE%`, default
`C:\android-build\jnilibs-cache`):

```bash
npm run setup:android-libs        # restore libs/headers from the cache into the repo
npm run setup:android-libs:check  # report what's present / missing
npm run setup:android-libs:save   # cache the repo's current libs (run after a good build)
```

The Gradle build runs the **restore** automatically (the `:app:ensureNodeLibs` task,
wired into `preBuild`), so on a machine whose cache is seeded you can just build the APK
and the libs appear. Skip with `-PskipNodeLibs`.

- **Cache already seeded** (same machine, or you copied the cache dir over): nothing to
  do — build the APK.
- **Cache empty** (brand-new machine): obtain the libs once via **Steps 1–2 below**, drop
  them in place, then `npm run setup:android-libs:save` to seed the cache for next time.

---

## Step 1 — nodejs-mobile runtime (libnode + headers)

The APK needs the prebuilt Node shared library and its headers.

1. Download the latest **Android** release from
   <https://github.com/nodejs-mobile/nodejs-mobile/releases>
   (e.g. `nodejs-mobile-vX.Y.Z-android.zip`). Pick a **Node 18.x** build — it matches
   the desktop code (`pkg` targets are node18) and the bundled native modules.
2. From the archive:
   - Copy the **arm64-v8a** `libnode.so` →
     `app/src/main/jniLibs/arm64-v8a/libnode.so`
   - Copy the headers (`include/node/…`) →
     `app/src/main/cpp/nodejs-mobile/include/node/`
     (must contain `node.h` and friends — `CMakeLists.txt` includes this path).

> If `node::Start` fails to link, your `native-lib.cpp`/headers don't match the
> libnode build. Use the `native-lib.cpp` shipped in that release's sample, or keep
> ours but match the header version.

---

## Step 2 — ffmpeg + ffprobe (aarch64, Android/bionic)

Uplayer transcodes HEVC→H.264, remuxes for Chromecast, and extracts subtitles.
You need **aarch64 ffmpeg and ffprobe executables built for Android (bionic libc)**,
as **PIE** binaries. A generic glibc static build will *not* run on Android.

Recommended sources (any one):

- **Build with the NDK** — clone ffmpeg and configure with
  `--enable-cross-compile --target-os=android --arch=aarch64 --cc=$NDK/.../aarch64-linux-android24-clang`
  and `--enable-static --disable-shared --enable-pic` plus `--enable-libx264` for the
  H.264 encoder Uplayer prefers.
- **Reuse a known Android build** — e.g. the binaries from a Termux `ffmpeg` package
  (aarch64) or an "ffmpeg-android static" release. Verify they run on-device (below).

Then:

1. Rename and place them (Android only extracts + allows exec of files named `lib*.so`):
   - `ffmpeg`  → `app/src/main/jniLibs/arm64-v8a/libffmpeg.so`
   - `ffprobe` → `app/src/main/jniLibs/arm64-v8a/libffprobe.so`
2. **Verify on the device** before relying on them:
   ```bash
   adb push libffmpeg.so /data/local/tmp/ff
   adb shell chmod 755 /data/local/tmp/ff && adb shell /data/local/tmp/ff -version
   ```
   You should see the version banner, not "not executable" / "syntax error".

`main.js` points the app at these via `UPLAYER_FFMPEG_PATH` / `UPLAYER_FFPROBE_PATH`
(the extracted native-lib paths). No code change needed.

---

## Step 2b — TorrServer engine (aarch64, the torrent engine)

Uplayer's torrent engine is the **TorrServer** binary (it replaced WebTorrent). It
ships exactly like ffmpeg — a `lib*.so` in `jniLibs` the app execs from
`nativeLibraryDir`.

**This is automatic** — it's an official prebuilt, so both `scripts/build-android.sh`
and the Gradle build (via `:app:ensureNodeLibs` → `setup-android-libs.js restore`)
download it for you when it's missing. You only need this step to fetch it by hand,
e.g. to refresh to a newer TorrServer release. From the **repo root**:

```bash
npm run setup:torrserver:android
```

This downloads the official `arm64` + `arm7` TorrServer binaries and writes:
- `app/src/main/jniLibs/arm64-v8a/libtorrserver.so`
- `app/src/main/jniLibs/armeabi-v7a/libtorrserver.so`

`main.js` points the app at it via `UPLAYER_TORRSERVER_PATH` (the extracted
native-lib path); the in-process `TorrServerClient` spawns it and talks to it over
`localhost:8090`. No WebRTC / `wrtc` needed — that whole class of ARM build problems
is gone. Verify on-device if in doubt:

```bash
adb push libtorrserver.so /data/local/tmp/ts
adb shell chmod 755 /data/local/tmp/ts && adb shell /data/local/tmp/ts --help
```

---

## Step 2c — Optional: subtitle auto-sync (alass) + generation (whisper)

These are **optional** quality features. Unlike ffmpeg/TorrServer there are **no
official Android prebuilts**, so they must be built from source for `aarch64` — or
skipped entirely (the app hides the features when the binaries are absent):
- Build/obtain `alass-cli` → `jniLibs/arm64-v8a/libalass.so`
- Build/obtain `whisper-cli` → `jniLibs/arm64-v8a/libwhisper.so`, plus a ggml model
  (e.g. `ggml-tiny.en.bin`) in the app's files dir.

`main.js` wires `UPLAYER_ALASS_PATH` / `UPLAYER_WHISPER_PATH` / `UPLAYER_WHISPER_MODEL`
from those when present. On desktop, `npm run setup:subtitle-tools` fetches the
Windows/Linux prebuilts automatically.

---

## Step 3 — Bundle the Node app into assets

From the **repo root**:

```bash
npm install                 # full deps (the bundler prunes the desktop-only ones)
npm run build:android-assets
```

This writes `android-app/app/src/main/assets/nodejs-project/` containing
`main.js`, `server.js`, `uplayer.js`, `core/`, `public/`, and a pruned
`node_modules` (drops ffmpeg-static/ffprobe-static/webtorrent-hybrid/wrtc — ~400MB).

The `.bundle-version` stamp makes the app re-extract assets on next launch.

> **Automatic on build.** The desktop and APK share one source tree at the repo root,
> and the Gradle build **re-runs this bundler automatically** before packaging — the
> `:app:bundleNodeAssets` task (in `app/build.gradle`) is wired into `preBuild`. So after
> updating any shared core file (`server.js`, `uplayer.js`, `sandbox.js`, `core/`,
> `public/`, `.env`) you can **just rebuild the APK** and it picks up the change; no need
> to run `build:android-assets` by hand. (It requires `node` on PATH during the Gradle
> build. Disable with `-PskipNodeBundle` if Node is unavailable and the bundle is current.
> Run `npm install` first whenever you add/upgrade npm dependencies.)
>
> **Adding a new top-level core module?** The bundler copies a fixed allow-list
> (`INCLUDE` in `scripts/build-android-assets.js`). A brand-new top-level file/folder that
> the core starts requiring must be added to that list — existing files and new
> `node_modules` deps are already covered.

---

## Step 4 — Build & run

> **One-command build (recommended).** `scripts/build-android.sh` is the APK counterpart
> to the desktop `setup.sh`. From the repo root:
> ```bash
> bash scripts/build-android.sh
> ```
> It ensures the native libs (restores from cache, or **from zero**: downloads libnode +
> cross-compiles ffmpeg), bundles the shared core, runs the Gradle build (handling the
> Windows JDK and 8.3 short-path), and copies the APK to the repo root as `uplayer-debug.apk`.
>
> ffmpeg must be cross-compiled on Linux — and the script handles that for you: on
> **Windows it automatically drives WSL** (default distro, `~/android-ndk-r26b`) to build
> ffmpeg, writing into the shared `jniLibs/`; on Linux/macOS it builds directly when
> `ANDROID_NDK` is set. So `bash scripts/build-android.sh` is genuinely one command, even
> from zero. Configurable via `WSL_ANDROID_NDK` / `WSL_DISTRO` / `JAVA_HOME` / `GRADLE` /
> `ANDROID_GRADLE_DIR`. (The first ffmpeg build is slow — tens of minutes — then it's
> cached.)

Manual / Android Studio:

1. Open the **`android-app/`** folder in Android Studio. Let Gradle sync.
2. Confirm `jniLibs/arm64-v8a/` has **four** files: `libnode.so`, `libffmpeg.so`,
   `libffprobe.so`, `libtorrserver.so`. And `cpp/nodejs-mobile/include/node/node.h` exists.
3. Run on a device (▶). First launch extracts the Node project (a few seconds), the
   spinner shows, then the Uplayer UI loads.

CLI build:
```bash
cd android-app
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
# or installDebug to push+run on a connected device
```

---

## Using it

- **Phone playback:** the native JS player plays in the WebView. Or tap **Open in
  player** to launch VLC/MX via intent.
- **Serve a URL:** the server listens on `0.0.0.0:3000`; other devices on the same
  Wi-Fi can open `http://<phone-ip>:3000`. The stream itself is on `:8000`.
- **Cast to TV:** tap **Cast**. The native Cast picker appears; choose your
  Chromecast. The phone serves the (transcoded) stream over the LAN and the TV
  pulls it from `http://<phone-ip>:8000/...`.

---

## Troubleshooting

```bash
adb logcat -s Uplayer Uplayer/Node Uplayer/Main Uplayer/Cast Uplayer/JNI chromium
```

| Symptom | Likely cause / fix |
|---|---|
| Spinner never goes away ("failed to start") | Node crashed — check `Uplayer/Node`. Usually a missing/incompatible `libnode.so`. |
| Subtitles/HEVC don't work; logs say ffmpeg/ffprobe not found | `libffmpeg.so`/`libffprobe.so` missing, wrong ABI, or not exec (re-do Step 2 verify). |
| `UnsatisfiedLinkError: node::Start` | header/libnode version mismatch (Step 1 note). |
| Cast button does nothing / no devices | Device lacks Play services, or phone+TV not on same network. Check `Uplayer/Cast`. |
| TV can't load the stream | `castUrl` must be the LAN IP, not localhost. Ensure Wi-Fi is connected (we pass the IP to `UPLAYER_PUBLIC_HOST`). Check the TV can reach `:8000` (AP isolation off). |
| Torrents find no peers / slow | Check `libtorrserver.so` is present + exec; TorrServer logs land in `boot.log` (look for "TorrServer configured"). Thin swarms are just slow. |

## Limitations / notes

- **ABI:** ships **arm64-v8a** only. To support 32-bit/x86, add ABIs in
  `app/build.gradle` and provide matching `libnode.so` + ffmpeg binaries.
- **App size:** the bundled `node_modules` + libnode + ffmpeg make a large APK
  (~80–150MB). Consider an `android:isSplitRequired` / per-ABI split if needed.
- **Storage:** streamed media goes to app-private storage (`filesDir/uplayer-tmp`),
  cleaned by the existing sandbox lifecycle.
- **Background:** `NodeService` is a `mediaPlayback` foreground service so streaming
  survives screen-off; Android may still throttle aggressively on some OEMs.
- **Quitting:** three paths fully shut down — backing out of the app, swiping it from
  Recents, and the notification's **Stop** button. All three converge on
  `NodeService.shutdown()`, which wipes `sandbox` + `uplayer-tmp` and kills the process
  (the only way to stop the embedded Node runtime — `node::Start` blocks for its whole
  life with no shutdown hook). Home / screen-off deliberately does *not* stop anything,
  so casting and background playback keep working; tapping the notification returns to
  the running session. Force Stop should never be necessary.
