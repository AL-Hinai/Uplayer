#!/usr/bin/env bash
#
# Build the Uplayer Android APK end-to-end — on Windows, Linux, or macOS.
#
# Counterpart to ./setup.sh (which installs the PC/desktop app). A single, OS-aware
# entry point that auto-detects everything and:
#   1. ensures the gitignored native libs are present (restores from cache, or from zero:
#      downloads libnode + cross-compiles ffmpeg — installing the NDK if needed),
#   2. bundles the shared Node core into the APK assets,
#   3. runs the Gradle build (auto-detected JDK / Gradle / SDK),
#   4. copies the resulting APK to the repo root as uplayer-debug.apk.
#
# Run from anywhere (it resolves the repo root from its own location):
#   bash scripts/build-android.sh
#
# Nothing is hard-coded: tools are discovered from PATH / standard env vars / a project
# wrapper, falling back to a probe of UPLAYER_TOOLCHAIN_DIR. Override any of:
#   UPLAYER_TOOLCHAIN_DIR  dir to probe for JDK/Gradle/SDK when not on PATH
#                          (default: C:\android-build on Windows, $HOME/android-build else)
#   JAVA_HOME / GRADLE / ANDROID_SDK_ROOT (or ANDROID_HOME)   explicit tool locations
#   NODEJS_MOBILE_VERSION  nodejs-mobile release for libnode + headers (default v18.20.4)
#   NDK_VERSION            Android NDK to auto-install for the ffmpeg build (default r26b)
#   ANDROID_NDK            existing NDK root (Linux/macOS direct build)
#   WSL_ANDROID_NDK / WSL_DISTRO   (Windows) NDK path / distro used for the WSL ffmpeg build
#   ANDROID_GRADLE_DIR     override the dir Gradle runs in (Windows: a space-free 8.3 path)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ABI="arm64-v8a"
JNI_DIR="android-app/app/src/main/jniLibs/$ABI"
HDR_DIR="android-app/app/src/main/cpp/nodejs-mobile/include/node"
NODEJS_MOBILE_VERSION="${NODEJS_MOBILE_VERSION:-v18.20.4}"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
log()  { printf "\n${C}==> %s${N}\n" "$*"; }
ok()   { printf "${G}OK${N} %s\n" "$*"; }
warn() { printf "${Y}!${N} %s\n" "$*" >&2; }
die()  { printf "${R}ERROR:${N} %s\n" "$*" >&2; exit 1; }

# --- OS detection ------------------------------------------------------------
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  Darwin*)              OS=macos ;;
  *)                    OS=linux ;;
esac

# Optional dir to probe when tools aren't on PATH (overridable, never required).
if [ -n "${UPLAYER_TOOLCHAIN_DIR:-}" ]; then
  TOOLCHAIN_DIR="$UPLAYER_TOOLCHAIN_DIR"
elif [ "$OS" = windows ]; then
  TOOLCHAIN_DIR="C:/android-build"
else
  TOOLCHAIN_DIR="$HOME/android-build"
fi

have_libnode() { [ -f "$JNI_DIR/libnode.so" ] && [ -d "$HDR_DIR" ] && [ -n "$(ls -A "$HDR_DIR" 2>/dev/null || true)" ]; }
have_ffmpeg()  { [ -f "$JNI_DIR/libffmpeg.so" ] && [ -f "$JNI_DIR/libffprobe.so" ]; }

# echo the first path argument that exists (globs are expanded by the caller)
first_existing() { local p; for p in "$@"; do [ -e "$p" ] && { printf '%s\n' "$p"; return 0; }; done; return 1; }

# --- Toolchain discovery (PATH / env / wrapper / probe) ----------------------
resolve_gradle() {
  [ -n "${GRADLE:-}" ] && { printf '%s\n' "$GRADLE"; return 0; }
  if [ "$OS" = windows ] && [ -f android-app/gradlew.bat ]; then printf '%s\n' "$ROOT/android-app/gradlew.bat"; return 0; fi
  [ -f android-app/gradlew ] && { printf '%s\n' "$ROOT/android-app/gradlew"; return 0; }
  command -v gradle >/dev/null 2>&1 && { printf '%s\n' "gradle"; return 0; }
  local g
  if [ "$OS" = windows ]; then
    g="$(first_existing "$TOOLCHAIN_DIR"/tools/gradle-*/bin/gradle.bat "$TOOLCHAIN_DIR"/gradle-*/bin/gradle.bat 2>/dev/null || true)"
  else
    g="$(first_existing "$TOOLCHAIN_DIR"/tools/gradle-*/bin/gradle "$TOOLCHAIN_DIR"/gradle-*/bin/gradle 2>/dev/null || true)"
  fi
  [ -n "$g" ] && { printf '%s\n' "$g"; return 0; }
  return 1
}

resolve_java_home() {
  if [ -n "${JAVA_HOME:-}" ] && { [ -e "$JAVA_HOME/bin/java" ] || [ -e "$JAVA_HOME/bin/java.exe" ]; }; then
    printf '%s\n' "$JAVA_HOME"; return 0
  fi
  local h
  h="$(first_existing "$TOOLCHAIN_DIR"/tools/jdk-* "$TOOLCHAIN_DIR"/jdk-* 2>/dev/null || true)"
  [ -n "$h" ] && { printf '%s\n' "$h"; return 0; }
  return 1   # fall back to a `java` already on PATH (handled by caller)
}

resolve_sdk() {
  [ -n "${ANDROID_SDK_ROOT:-}" ] && { printf '%s\n' "$ANDROID_SDK_ROOT"; return 0; }
  [ -n "${ANDROID_HOME:-}" ]     && { printf '%s\n' "$ANDROID_HOME"; return 0; }
  if [ -f android-app/local.properties ] && grep -q '^sdk.dir=' android-app/local.properties 2>/dev/null; then
    printf '%s\n' "__localprops__"; return 0
  fi
  local s
  case "$OS" in
    windows) s="$(first_existing "$TOOLCHAIN_DIR"/sdk "${LOCALAPPDATA:-}/Android/Sdk" 2>/dev/null || true)" ;;
    macos)   s="$(first_existing "$HOME/Library/Android/sdk" "$TOOLCHAIN_DIR"/sdk 2>/dev/null || true)" ;;
    *)       s="$(first_existing "$HOME/Android/Sdk" "$HOME/android-sdk" "$TOOLCHAIN_DIR"/sdk 2>/dev/null || true)" ;;
  esac
  [ -n "$s" ] && { printf '%s\n' "$s"; return 0; }
  return 1
}

# --- 1. Node dependencies ----------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js is required (not found on PATH)."
if [ ! -d node_modules ]; then
  log "Installing Node dependencies (npm install)"
  npm install
fi

# --- 2. Native libs ----------------------------------------------------------
# 2a. Try the local cache first (fast, offline).
log "Ensuring native libs (restore from cache if available)"
node scripts/setup-android-libs.js restore || true

# 2b. libnode + headers — download the prebuilt nodejs-mobile runtime if still missing.
if ! have_libnode; then
  log "Fetching nodejs-mobile $NODEJS_MOBILE_VERSION (libnode.so + headers)"
  command -v curl  >/dev/null 2>&1 || die "curl is required to download libnode"
  command -v unzip >/dev/null 2>&1 || die "unzip is required to extract libnode"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${NODEJS_MOBILE_VERSION}/nodejs-mobile-${NODEJS_MOBILE_VERSION}-android.zip"
  curl -fSL -o "$tmp/nm.zip" "$url" || die "download failed: $url"
  unzip -q -o "$tmp/nm.zip" -d "$tmp/x"
  src_lib="$(find "$tmp/x" -type f -name libnode.so -path "*${ABI}*" | head -1)"
  [ -n "$src_lib" ] || src_lib="$(find "$tmp/x" -type f -name libnode.so | head -1)"
  src_hdr="$(find "$tmp/x" -type d -path "*include/node" | head -1)"
  [ -n "$src_lib" ] || die "libnode.so ($ABI) not found in the nodejs-mobile archive"
  [ -n "$src_hdr" ] || die "node headers (include/node) not found in the nodejs-mobile archive"
  mkdir -p "$JNI_DIR" "$HDR_DIR"
  cp -f "$src_lib" "$JNI_DIR/libnode.so"
  cp -rf "$src_hdr/." "$HDR_DIR/"
  rm -rf "$tmp"; trap - EXIT
  ok "libnode.so + headers installed"
fi

# 2c. ffmpeg/ffprobe — cross-compile from source if still missing. This needs a Linux
# toolchain + NDK; build-ffmpeg-android.sh auto-installs the NDK when absent. On Windows
# we drive WSL so it's still one command end-to-end.
if ! have_ffmpeg; then
  if [ "$OS" != windows ]; then
    log "Building ffmpeg/ffprobe from source (NDK auto-installs if missing)"
    bash scripts/build-ffmpeg-android.sh
  elif command -v wsl.exe >/dev/null 2>&1; then
    log "Building ffmpeg/ffprobe via WSL (Linux NDK cross-compile) — slow the first time"
    wsl_args=(); [ -n "${WSL_DISTRO:-}" ] && wsl_args=(-d "$WSL_DISTRO")
    win_root="$(cygpath -w "$ROOT")"
    wsl_repo="$(wsl.exe "${wsl_args[@]}" wslpath -a "$win_root" 2>/dev/null | tr -d '\r' || true)"
    [ -n "$wsl_repo" ] || die "could not map '$win_root' into WSL (is WSL installed/initialised?)"
    # Feed the build commands over STDIN (heredoc), not a cmdline arg — avoids git-bash
    # mangling the quoting/paths. $wsl_repo + optional NDK override expand here; the rest
    # ($HOME, NDK_VERSION default) expand inside WSL via build-ffmpeg-android.sh.
    if ! wsl.exe "${wsl_args[@]}" bash -l <<WSLEOF
set -e
cd "$wsl_repo"
${WSL_ANDROID_NDK:+export ANDROID_NDK="$WSL_ANDROID_NDK"}
${NDK_VERSION:+export NDK_VERSION="$NDK_VERSION"}
export WORK="\$HOME/.uplayer-ffmpeg-build"
bash scripts/build-ffmpeg-android.sh
WSLEOF
    then
      die "WSL ffmpeg build failed. Check WSL_ANDROID_NDK / WSL_DISTRO / NDK_VERSION. See android-app/BUILD.md."
    fi
  else
    die "$(cat <<EOF
libffmpeg.so / libffprobe.so are missing and can't be built on this host.
They cross-compile on Linux/WSL/macOS (the NDK auto-installs). Either:
  - install WSL (then this script builds them for you automatically), or
  - on Linux/WSL run:  bash scripts/build-ffmpeg-android.sh
That writes them into $JNI_DIR. Then re-run this script. (See android-app/BUILD.md.)
EOF
)"
  fi
fi

have_libnode || die "libnode/headers still missing after setup"
have_ffmpeg  || die "ffmpeg libs still missing after setup"
ok "Native libs present"

# 2d. Cache the complete set so future clean checkouts restore instantly.
node scripts/setup-android-libs.js save || true

# --- 3. Bundle the shared Node core into the APK assets ----------------------
# (Gradle also does this via :app:bundleNodeAssets, but doing it here keeps the
#  script a complete standalone build.)
log "Bundling Node app into APK assets"
node scripts/build-android-assets.js

# --- 4. Gradle build ---------------------------------------------------------
log "Building APK (gradle :app:assembleDebug)"
GRADLE="$(resolve_gradle)" || die "Gradle not found. Install Gradle (on PATH), add a gradle wrapper, set \$GRADLE, or put it under $TOOLCHAIN_DIR."
ok "gradle: $GRADLE"

if jh="$(resolve_java_home)"; then
  export JAVA_HOME="$jh"; ok "JAVA_HOME: $JAVA_HOME"
elif command -v java >/dev/null 2>&1; then
  warn "JAVA_HOME not set; using 'java' from PATH ($(command -v java))"
else
  die "No JDK found. Set \$JAVA_HOME, put 'java' on PATH, or install a JDK under $TOOLCHAIN_DIR."
fi

if sdk="$(resolve_sdk)"; then
  if [ "$sdk" != "__localprops__" ]; then export ANDROID_SDK_ROOT="$sdk"; export ANDROID_HOME="$sdk"; ok "SDK: $sdk"; else ok "SDK: from android-app/local.properties"; fi
else
  warn "Android SDK not auto-detected. Gradle will fail unless ANDROID_SDK_ROOT or android-app/local.properties is set."
fi

# Determine the dir Gradle runs in. On Windows, CMake chokes on spaces in the path, so
# prefer a DOS 8.3 short path (only matters when the repo path actually contains a space).
proj="$ROOT/android-app"
if [ "$OS" = windows ]; then
  if [ -n "${ANDROID_GRADLE_DIR:-}" ]; then
    proj="$ANDROID_GRADLE_DIR"
  else
    win_dir="$(cd android-app && pwd -W 2>/dev/null || pwd)"
    proj=""
    command -v cygpath >/dev/null 2>&1 && proj="$(cygpath -d "$win_dir" 2>/dev/null || true)"
    [ -n "$proj" ] || proj="$win_dir"
    case "$proj" in *" "*) warn "Project path contains a space ($proj); CMake may fail — set ANDROID_GRADLE_DIR to an 8.3 short path." ;; esac
  fi
fi

# This script already bundled assets + ensured libs, so skip the equivalent Gradle
# preBuild tasks to avoid doing the work twice.
( cd "$proj" && "$GRADLE" :app:assembleDebug --console=plain --no-daemon -PskipNodeBundle -PskipNodeLibs )

# --- 5. Publish the APK ------------------------------------------------------
apk="android-app/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$apk" ] || die "build finished but APK not found at $apk"
cp -f "$apk" uplayer-debug.apk
log "Done"
ok "uplayer-debug.apk ($(du -h uplayer-debug.apk 2>/dev/null | cut -f1)) at repo root"
