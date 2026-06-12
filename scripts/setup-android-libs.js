#!/usr/bin/env node
'use strict';

/*
 * Restore the Android native libs that are intentionally gitignored (too large /
 * not diff-able) so a fresh clone can build the APK.
 *
 *   node scripts/setup-android-libs.js [restore|save|check]
 *
 *   restore  (default) — copy the libs/headers from the local cache into the repo's
 *                        jniLibs + cpp headers if they're missing. No-op if present.
 *   save               — copy the repo's current (working) libs/headers INTO the cache
 *                        so future clean checkouts can restore them. Run this once on a
 *                        machine that has a known-good build.
 *   check              — report presence only; exit 1 if anything is missing.
 *
 * Files managed (arm64-v8a only — see android-app/BUILD.md):
 *   - libnode.so   (nodejs-mobile runtime)
 *   - libffmpeg.so / libffprobe.so  (aarch64 ffmpeg, built via scripts/build-ffmpeg-android.sh)
 *   - cpp/nodejs-mobile/include/node/  (nodejs-mobile headers, needed by CMake)
 *
 * Cache location: $UPLAYER_ANDROID_LIB_CACHE, else C:\android-build\jnilibs-cache on
 * Windows, else ~/.cache/uplayer-android-libs. The cache lives OUTSIDE the repo so it
 * survives clean checkouts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const JNI_DIR = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
const HEADERS_DIR = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'cpp', 'nodejs-mobile', 'include', 'node');
const LIBS = ['libnode.so', 'libffmpeg.so', 'libffprobe.so'];

function cacheDir() {
  if (process.env.UPLAYER_ANDROID_LIB_CACHE) return process.env.UPLAYER_ANDROID_LIB_CACHE;
  if (process.platform === 'win32') return path.join('C:\\', 'android-build', 'jnilibs-cache');
  return path.join(os.homedir(), '.cache', 'uplayer-android-libs');
}
const CACHE = cacheDir();
const CACHE_JNI = path.join(CACHE, 'jniLibs', 'arm64-v8a');
const CACHE_HEADERS = path.join(CACHE, 'include', 'node');

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function dirHasFiles(p) { try { return fs.existsSync(p) && fs.readdirSync(p).length > 0; } catch (e) { return false; } }
function missingLibs(dir) { return LIBS.filter((n) => !exists(path.join(dir, n))); }

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function repoStatus() {
  const miss = missingLibs(JNI_DIR);
  const headersOk = dirHasFiles(HEADERS_DIR);
  return { miss, headersOk, ok: miss.length === 0 && headersOk };
}

function printManualHelp() {
  console.error('');
  console.error('To obtain the missing native libs (then re-run `save` to cache them):');
  console.error('  - libnode.so + headers: download the Android build (Node 18.x, e.g. v18.20.4) from');
  console.error('      https://github.com/nodejs-mobile/nodejs-mobile/releases');
  console.error('      -> bin/arm64-v8a/libnode.so  and  include/node/  (see BUILD.md Step 1)');
  console.error('  - libffmpeg.so / libffprobe.so: build via scripts/build-ffmpeg-android.sh (WSL/Linux)');
  console.error('  - place them under android-app/app/src/main/jniLibs/arm64-v8a/ and');
  console.error('    android-app/app/src/main/cpp/nodejs-mobile/include/node/, then:');
  console.error('      npm run setup:android-libs:save');
  console.error('  See android-app/BUILD.md.');
}

function doCheck() {
  const { miss, headersOk, ok } = repoStatus();
  if (ok) { console.log('OK Android native libs present in repo.'); process.exit(0); }
  if (miss.length) console.log('MISSING jniLibs:', miss.join(', '));
  if (!headersOk) console.log('MISSING nodejs-mobile headers:', HEADERS_DIR);
  process.exit(1);
}

function doSave() {
  const { miss, headersOk } = repoStatus();
  const gaps = [...miss, headersOk ? null : 'headers'].filter(Boolean);
  if (gaps.length) {
    console.error('Cannot save — repo is missing:', gaps.join(', '));
    console.error('Build/restore a complete set first, then run `save`.');
    process.exit(1);
  }
  for (const n of LIBS) copyFile(path.join(JNI_DIR, n), path.join(CACHE_JNI, n));
  fs.rmSync(CACHE_HEADERS, { recursive: true, force: true });
  copyDir(HEADERS_DIR, CACHE_HEADERS);
  console.log('OK Saved native libs + headers to cache:');
  console.log('   ' + CACHE);
}

function doRestore() {
  const before = repoStatus();
  if (before.ok) { console.log('OK Android native libs already present - nothing to restore.'); return; }

  const restored = [];
  for (const n of before.miss) {
    const c = path.join(CACHE_JNI, n);
    if (exists(c)) { copyFile(c, path.join(JNI_DIR, n)); restored.push(n); }
  }
  if (!before.headersOk && dirHasFiles(CACHE_HEADERS)) {
    copyDir(CACHE_HEADERS, HEADERS_DIR);
    restored.push('headers');
  }
  if (restored.length) console.log('OK Restored from cache (' + CACHE + '):', restored.join(', '));

  const after = repoStatus();
  if (after.ok) { console.log('OK Android native libs ready.'); return; }

  console.error('');
  console.error('Native libs still missing after cache restore (cache empty/incomplete):');
  if (after.miss.length) console.error('  jniLibs:', after.miss.join(', '));
  if (!after.headersOk) console.error('  headers:', HEADERS_DIR);
  printManualHelp();
  process.exit(1);
}

const mode = (process.argv[2] || 'restore').toLowerCase();
if (mode === 'check') doCheck();
else if (mode === 'save' || mode === 'backup') doSave();
else if (mode === 'restore' || mode === 'setup') doRestore();
else { console.error('Usage: node scripts/setup-android-libs.js [restore|save|check]'); process.exit(2); }
