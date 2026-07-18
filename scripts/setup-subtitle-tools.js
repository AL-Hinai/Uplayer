'use strict';
/*
 * Provisions subtitle tooling into vendor/ (like scripts/setup-torrserver.js):
 *   - alass        (auto-sync)       : Windows + Linux prebuilt
 *   - whisper.cpp  (auto-generate)   : Windows prebuilt + a ggml model
 *
 * Platforms without an official prebuilt (alass macOS/Android, whisper Linux/macOS/
 * Android) must build from source / provide the binary and point UPLAYER_ALASS_PATH /
 * UPLAYER_WHISPER_PATH at it. The app degrades gracefully when a binary is absent —
 * the auto-sync / generate features are simply not offered. On Android they ship as
 * jniLibs lib*.so (see android-app/BUILD.md).
 *
 *   node scripts/setup-subtitle-tools.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VENDOR = path.join(__dirname, '..', 'vendor');
const MODEL = process.env.UPLAYER_WHISPER_MODEL_NAME || 'ggml-tiny.en.bin';

async function ghLatest(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'uplayer-setup', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub API ' + r.status);
  return r.json();
}
async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'uplayer-setup' } });
  if (!r.ok) throw new Error('download ' + r.status);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}
function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-o', zip, '-d', dest], { stdio: 'ignore' });
  }
}

async function setupAlass() {
  const dir = path.join(VENDOR, 'alass');
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(dir, 'alass-windows64', 'bin', 'alass-cli.exe'))) return console.log('  alass: already installed');
    const a = (await ghLatest('kaegi/alass')).assets.find((x) => /windows64\.zip$/i.test(x.name));
    const zip = path.join(dir, a.name);
    console.log('  alass: downloading', a.name); await download(a.browser_download_url, zip);
    unzip(zip, dir); fs.unlinkSync(zip); console.log('  alass: installed');
  } else if (process.platform === 'linux') {
    const out = path.join(dir, 'alass-linux64');
    if (fs.existsSync(out)) return console.log('  alass: already installed');
    const a = (await ghLatest('kaegi/alass')).assets.find((x) => x.name === 'alass-linux64');
    if (!a) return console.warn('  alass: no linux asset in release');
    console.log('  alass: downloading', a.name); await download(a.browser_download_url, out); fs.chmodSync(out, 0o755); console.log('  alass: installed');
  } else {
    console.warn('  alass: no prebuilt for ' + process.platform + ' — `cargo install alass-cli` then set UPLAYER_ALASS_PATH');
  }
}

async function setupWhisper() {
  const dir = path.join(VENDOR, 'whisper');
  fs.mkdirSync(dir, { recursive: true });
  const model = path.join(dir, MODEL);
  if (!fs.existsSync(model)) {
    console.log('  whisper: downloading model', MODEL, '(this is the slow part)');
    try { execFileSync('curl', ['-L', '-s', '-o', model, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`], { stdio: 'ignore' }); }
    catch (e) { console.warn('  whisper: model download failed — fetch ' + MODEL + ' into vendor/whisper/ manually'); }
  }
  if (process.platform === 'win32') {
    if (fs.existsSync(path.join(dir, 'whisper-cli.exe'))) return console.log('  whisper: already installed');
    const a = (await ghLatest('ggerganov/whisper.cpp')).assets.find((x) => x.name === 'whisper-bin-x64.zip');
    if (!a) return console.warn('  whisper: no win64 asset in release');
    const zip = path.join(dir, a.name), ex = path.join(dir, '_x');
    console.log('  whisper: downloading', a.name); await download(a.browser_download_url, zip);
    unzip(zip, ex);
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } })(ex);
    for (const f of files) { if (/whisper-cli\.exe$/i.test(f) || /\.dll$/i.test(f)) fs.copyFileSync(f, path.join(dir, path.basename(f))); }
    fs.rmSync(ex, { recursive: true, force: true }); fs.unlinkSync(zip);
    console.log('  whisper: installed');
  } else {
    console.warn('  whisper: no prebuilt binary for ' + process.platform + ' — build whisper.cpp from source and set UPLAYER_WHISPER_PATH');
  }
}

(async () => {
  console.log('Provisioning subtitle tools into vendor/ ...');
  try { await setupAlass(); } catch (e) { console.warn('  alass failed:', e.message); }
  try { await setupWhisper(); } catch (e) { console.warn('  whisper failed:', e.message); }
  console.log('Done.');
})();
