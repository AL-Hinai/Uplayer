#!/usr/bin/env bash
# Cross-compile ffmpeg + ffprobe (with libx264) for Android arm64 using the NDK.
#
# Produces standalone executables that Uplayer spawns on-device:
#   $OUT/ffmpeg   $OUT/ffprobe
# Uplayer's encoder detection falls through to libx264 on Android, so x264 is
# built and linked in. MediaCodec decoders are enabled to accelerate HEVC input.
#
# Requirements: make, gcc, curl, unzip. Build on Linux/WSL/macOS (not Windows).
# The Android NDK is AUTO-INSTALLED when $ANDROID_NDK is unset/missing (override the
# version with NDK_VERSION, default r26b). Examples:
#   bash scripts/build-ffmpeg-android.sh                                  # auto-install NDK + build
#   ANDROID_NDK=~/android-ndk-r26b bash scripts/build-ffmpeg-android.sh   # use an existing NDK
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-6.1.1}"
X264_BRANCH="${X264_BRANCH:-stable}"
API="${ANDROID_API:-26}"
ABI="arm64-v8a"
ARCH="aarch64"
TRIPLE="aarch64-linux-android"
NDK_VERSION="${NDK_VERSION:-r26b}"

WORK="${WORK:-$PWD/.ffmpeg-build}"
OUT="${OUT:-$PWD/android-app/app/src/main/jniLibs/$ABI}"
PREFIX="$WORK/prefix"            # where x264 (and ffmpeg) install
mkdir -p "$WORK" "$OUT" "$PREFIX"

# --- Android NDK: use $ANDROID_NDK, else auto-install android-ndk-$NDK_VERSION ----
NDK_DEFAULT_DIR="$HOME/android-ndk-$NDK_VERSION"
[ -n "${ANDROID_NDK:-}" ] || ANDROID_NDK="$NDK_DEFAULT_DIR"
if [ ! -d "$ANDROID_NDK" ]; then
  if [ "$ANDROID_NDK" != "$NDK_DEFAULT_DIR" ]; then
    echo "ANDROID_NDK=$ANDROID_NDK does not exist."; exit 1
  fi
  case "$(uname -s)" in
    Linux*)  NDK_OS=linux ;;
    Darwin*) NDK_OS=darwin ;;
    *) echo "NDK auto-install supports Linux/macOS only; set ANDROID_NDK manually."; exit 1 ;;
  esac
  command -v curl  >/dev/null 2>&1 || { echo "curl required to download the NDK"; exit 1; }
  command -v unzip >/dev/null 2>&1 || { echo "unzip required to extract the NDK (e.g. sudo apt-get install -y unzip)"; exit 1; }
  echo ">>> Android NDK not found — downloading android-ndk-$NDK_VERSION ($NDK_OS)"
  ndk_zip="$WORK/android-ndk-$NDK_VERSION-$NDK_OS.zip"
  curl -fSL -o "$ndk_zip" "https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-$NDK_OS.zip"
  unzip -q -o "$ndk_zip" -d "$(dirname "$NDK_DEFAULT_DIR")"
  rm -f "$ndk_zip"
  [ -d "$ANDROID_NDK" ] || { echo "NDK extraction did not produce $ANDROID_NDK"; exit 1; }
  echo ">>> NDK installed at $ANDROID_NDK"
fi
export ANDROID_NDK
echo ">>> Using NDK: $ANDROID_NDK"

# Locate the NDK clang toolchain.
HOST_TAG=""
for tag in linux-x86_64 darwin-x86_64 darwin-arm64; do
  [ -d "$ANDROID_NDK/toolchains/llvm/prebuilt/$tag" ] && { HOST_TAG="$tag"; break; }
done
[ -n "$HOST_TAG" ] || { echo "No NDK prebuilt toolchain under $ANDROID_NDK"; exit 1; }
TOOLCHAIN="$ANDROID_NDK/toolchains/llvm/prebuilt/$HOST_TAG"
export PATH="$TOOLCHAIN/bin:$PATH"

export CC="$TOOLCHAIN/bin/${TRIPLE}${API}-clang"
export CXX="$TOOLCHAIN/bin/${TRIPLE}${API}-clang++"
export AR="$TOOLCHAIN/bin/llvm-ar"
export NM="$TOOLCHAIN/bin/llvm-nm"
export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
export STRIP="$TOOLCHAIN/bin/llvm-strip"
JOBS="$(nproc 2>/dev/null || echo 4)"

# ---------------------------------------------------------------- libx264 ----
cd "$WORK"
if [ ! -d "x264-$X264_BRANCH" ]; then
  echo ">>> fetching x264 ($X264_BRANCH)"
  curl -fSL -o "x264-$X264_BRANCH.tar.bz2" \
    "https://code.videolan.org/videolan/x264/-/archive/$X264_BRANCH/x264-$X264_BRANCH.tar.bz2"
  tar xf "x264-$X264_BRANCH.tar.bz2"
fi
cd "x264-$X264_BRANCH"
make distclean >/dev/null 2>&1 || true
echo ">>> configuring x264"
./configure \
  --prefix="$PREFIX" \
  --host="$TRIPLE" \
  --cross-prefix="$TOOLCHAIN/bin/llvm-" \
  --sysroot="$TOOLCHAIN/sysroot" \
  --enable-static --enable-pic --disable-cli --disable-asm
# x264's configure uses CC from env; force the API clang.
make CC="$CC" -j"$JOBS"
make install

# ----------------------------------------------------------------- ffmpeg ----
cd "$WORK"
SRC="ffmpeg-$FFMPEG_VERSION"
if [ ! -d "$SRC" ]; then
  echo ">>> fetching $SRC"
  curl -fSL -o "$SRC.tar.bz2" "https://ffmpeg.org/releases/$SRC.tar.bz2"
  tar xf "$SRC.tar.bz2"
fi
cd "$SRC"
make distclean >/dev/null 2>&1 || true

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
echo ">>> configuring ffmpeg"
./configure \
  --prefix="$PREFIX" \
  --target-os=android \
  --arch="$ARCH" \
  --cpu=armv8-a \
  --enable-cross-compile \
  --sysroot="$TOOLCHAIN/sysroot" \
  --cc="$CC" --cxx="$CXX" --ar="$AR" --nm="$NM" --ranlib="$RANLIB" --strip="$STRIP" \
  --extra-cflags="-O2 -fPIE -fPIC -I$PREFIX/include" \
  --extra-ldflags="-pie -L$PREFIX/lib" \
  --pkg-config=pkg-config \
  --disable-shared --enable-static --enable-pic \
  --disable-doc --disable-debug --disable-ffplay \
  --enable-gpl --enable-libx264 \
  --enable-mediacodec --enable-jni \
  --enable-decoder=h264,hevc,hevc_mediacodec,aac,ac3,eac3,mp3,flac,vorbis,opus,subrip,ass,movtext,dvd_subtitle,hdmv_pgs_subtitle \
  --enable-encoder=libx264,aac,ac3,mp3,ass,subrip,webvtt,movtext \
  --enable-demuxer=mov,matroska,mp4,mpegts,avi,flv,hls,srt,ass,webvtt \
  --enable-muxer=mp4,mpegts,hls,webvtt,matroska,srt,ass \
  --enable-parser=h264,hevc,aac,ac3 \
  --enable-protocol=file,pipe,http,tcp \
  --enable-filter=scale,aresample,format,subtitles \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc \
  --enable-ffmpeg --enable-ffprobe

echo ">>> building ffmpeg"
make -j"$JOBS"

cp -f ffmpeg "$OUT/ffmpeg"
cp -f ffprobe "$OUT/ffprobe"
"$STRIP" "$OUT/ffmpeg" "$OUT/ffprobe" || true

echo
echo "Built:"
ls -lh "$OUT/ffmpeg" "$OUT/ffprobe"
file "$OUT/ffmpeg" 2>/dev/null || true
