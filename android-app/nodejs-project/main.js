'use strict';

/*
 * Android (nodejs-mobile) entry point for Uplayer.
 *
 * The native host (MainActivity / NodeService) launches this with:
 *   startNodeWithArguments(["node", "main.js", <nativeLibDir>, <filesDir>, <wifiIp>])
 *
 *   argv[2] nativeLibDir : dir where the APK extracted lib*.so (ffmpeg/ffprobe live here)
 *   argv[3] filesDir     : app-private writable dir (used for the streaming temp/sandbox)
 *   argv[4] wifiIp        : current Wi-Fi IPv4 (optional) — used as the cast/public host
 *
 * It wires Android-appropriate config via env vars (all read by the existing
 * desktop code paths) and then boots the normal Express server in-process.
 */

const path = require('path');
const fs = require('fs');

// --- Node 18 global shims ---------------------------------------------------
// nodejs-mobile ships Node 18, which lacks the global `File` (it became global
// in Node 20). undici's webidl layer references `File` at module-load time, so
// the server require chain throws "File is not defined" without this. Polyfill
// it before anything pulls undici in.
if (typeof globalThis.File === 'undefined') {
  try { globalThis.File = require('node:buffer').File; } catch (e) { /* older 18.x */ }
  if (typeof globalThis.File === 'undefined') {
    const { Blob } = require('node:buffer');
    globalThis.File = class File extends Blob {
      constructor(chunks, name, options = {}) {
        super(chunks || [], options);
        this.name = String(name);
        this.lastModified = options && options.lastModified != null ? options.lastModified : Date.now();
      }
      get [Symbol.toStringTag]() { return 'File'; }
    };
  }
}

const nativeLibDir = process.argv[2] || '';
const filesDir = process.argv[3] || __dirname;
const wifiIp = process.argv[4] || '';

function existing(p) {
  try { return p && fs.existsSync(p) ? p : null; } catch (e) { return null; }
}

// --- ffmpeg / ffprobe: shipped as extracted native libs ---------------------
// Android only extracts files named lib*.so from jniLibs into nativeLibraryDir,
// and that directory is the one place an app may exec from. We rename the
// aarch64 static binaries to libffmpeg.so / libffprobe.so at build time.
const ffmpegPath = existing(path.join(nativeLibDir, 'libffmpeg.so'));
const ffprobePath = existing(path.join(nativeLibDir, 'libffprobe.so'));
if (ffmpegPath) process.env.UPLAYER_FFMPEG_PATH = ffmpegPath;
if (ffprobePath) process.env.UPLAYER_FFPROBE_PATH = ffprobePath;

// --- torrent engine: TorrServer (shipped as an extracted native lib) --------
// Like ffmpeg/ffprobe above, the arm TorrServer binary is renamed to
// libtorrserver.so at build time so Android extracts it to nativeLibraryDir (the
// one directory an app may exec from). The StreamManager's TorrServerClient spawns
// it and talks to it over localhost HTTP.
const torrserverPath = existing(path.join(nativeLibDir, 'libtorrserver.so'));
if (torrserverPath) process.env.UPLAYER_TORRSERVER_PATH = torrserverPath;
const torrserverData = path.join(filesDir, 'torrserver');
try { fs.mkdirSync(torrserverData, { recursive: true }); } catch (e) { /* ignore */ }
process.env.UPLAYER_TORRSERVER_DATA = torrserverData;

// --- optional speech tools (alass auto-sync, whisper auto-generate) ----------
// No official Android prebuilts exist. If you build them and drop libalass.so /
// libwhisper.so into jniLibs (+ a ggml model alongside main.js or in filesDir), the
// app uses them. Absent = those features are simply not offered (graceful).
const alassPath = existing(path.join(nativeLibDir, 'libalass.so'));
if (alassPath) process.env.UPLAYER_ALASS_PATH = alassPath;
const whisperPath = existing(path.join(nativeLibDir, 'libwhisper.so'));
if (whisperPath) process.env.UPLAYER_WHISPER_PATH = whisperPath;
const whisperModel = existing(path.join(filesDir, 'ggml-tiny.en.bin')) || existing(path.join(__dirname, 'ggml-tiny.en.bin'));
if (whisperModel) process.env.UPLAYER_WHISPER_MODEL = whisperModel;

// --- writable temp / sandbox dir on app-private storage ---------------------
const tmpDir = path.join(filesDir, 'uplayer-tmp');
try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* ignore */ }
process.env.TMPDIR = tmpDir;
process.env.TMP = tmpDir;
process.env.TEMP = tmpDir;

// The history/recommendation stores default to os.homedir() (= /data on Android,
// which is NOT writable -> EACCES). Point HOME at the app's writable files dir so
// os.homedir() resolves to a path we can write (.uplayer-history.json etc.).
process.env.HOME = filesDir;

// The stream sandbox tries tmpfs (/tmp, /dev/shm) on Linux — Android reports
// platform 'linux' but those aren't writable. Give it an explicit writable base.
const sandboxDir = path.join(filesDir, 'sandbox');
try { fs.mkdirSync(sandboxDir, { recursive: true }); } catch (e) { /* ignore */ }
process.env.UPLAYER_SANDBOX_DIR = sandboxDir;

// --- networking: listen on all interfaces; advertise the Wi-Fi IP for cast --
process.env.UPLAYER_BIND_HOST = '0.0.0.0';
if (wifiIp) process.env.UPLAYER_PUBLIC_HOST = wifiIp;
process.env.PORT = process.env.PORT || '3000';

// --- tee console output to a log file the Android UI can display on failure ---
const bootLogPath = path.join(filesDir, 'boot.log');
const prevLogPath = path.join(filesDir, 'boot-prev.log');
try {
  // Preserve the previous session's log — a mid-stream crash that kills the
  // process lives here and is viewable after relaunch via the in-app LOG button.
  if (fs.existsSync(bootLogPath)) fs.copyFileSync(bootLogPath, prevLogPath);
  fs.writeFileSync(bootLogPath, '');
} catch (e) { /* ignore */ }
function fmt(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a && a.stack) return a.stack;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
}
function tee(tag, args) {
  try { fs.appendFileSync(bootLogPath, `${tag} ${fmt(args)}\n`); } catch (e) { /* ignore */ }
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
const _warn = console.warn.bind(console);
console.log = (...a) => { tee('LOG', a); _log(...a); };
console.error = (...a) => { tee('ERR', a); _err(...a); };
console.warn = (...a) => { tee('WRN', a); _warn(...a); };

// Global sink the StreamManager (uplayer.js _log) writes to, so streaming
// progress — "Downloading…", "Probing codec…", "Starting server on 8000…",
// "Transcoding…" — lands in boot.log. The last line before a crash pinpoints it.
global.__uplayerTee = (text) => {
  try { fs.appendFileSync(bootLogPath, 'STR ' + String(text).replace(/\s+$/, '') + '\n'); } catch (e) { /* ignore */ }
};

// Surface uncaught errors to the Android log (adb logcat) instead of dying silent.
process.on('uncaughtException', (err) => {
  console.error('[uplayer] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[uplayer] unhandledRejection:', reason);
});

console.log('[uplayer] starting on Android');
console.log('[uplayer]   ffmpeg :', process.env.UPLAYER_FFMPEG_PATH || '(missing)');
console.log('[uplayer]   ffprobe:', process.env.UPLAYER_FFPROBE_PATH || '(missing)');
console.log('[uplayer]   torrsrv:', process.env.UPLAYER_TORRSERVER_PATH || '(missing)');
console.log('[uplayer]   tmp    :', tmpDir);
console.log('[uplayer]   host   :', process.env.UPLAYER_PUBLIC_HOST || '(auto)');

const port = Number(process.env.PORT) || 3000;
try {
  const { startServer } = require('./server.js');
  startServer(port);
  console.log(`[uplayer] web UI listening on :${port}`);
} catch (err) {
  console.error('[uplayer] FATAL during server start:', err && err.stack ? err.stack : err);
}
