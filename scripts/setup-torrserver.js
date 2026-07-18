'use strict';
/*
 * Downloads the prebuilt TorrServer binary into vendor/torrserver/ so the app's
 * engine (core/torrserver-client.js) can find it. Mirrors how ffmpeg-static ships
 * a prebuilt binary — no Go toolchain required.
 *
 *   node scripts/setup-torrserver.js            # desktop binary for THIS platform
 *   node scripts/setup-torrserver.js android    # arm64 + arm7 (for the Android jniLibs)
 *
 * The binaries are git-ignored (large, regenerable).
 */
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', 'vendor', 'torrserver');
const RELEASES = 'https://api.github.com/repos/YouROK/TorrServer/releases/latest';

function desktopAsset() {
  const a = process.arch;
  switch (process.platform) {
    case 'win32': return 'TorrServer-windows-amd64.exe';
    case 'darwin': return a === 'arm64' ? 'TorrServer-darwin-arm64' : 'TorrServer-darwin-amd64';
    case 'linux':
      if (a === 'arm64') return 'TorrServer-linux-arm64';
      if (a === 'arm') return 'TorrServer-linux-arm7';
      return 'TorrServer-linux-amd64';
    default: return 'TorrServer-linux-amd64';
  }
}

async function fetchRelease() {
  const res = await fetch(RELEASES, { headers: { 'User-Agent': 'uplayer-setup', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error('GitHub API ' + res.status);
  return res.json();
}

async function download(asset, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    console.log('  exists, skipping:', path.basename(dest));
    return;
  }
  console.log('  downloading', asset.name, (asset.size / 1048576).toFixed(1) + 'MB ...');
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'uplayer-setup' } });
  if (!res.ok) throw new Error('download ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  try { fs.chmodSync(dest, 0o755); } catch (e) {}
  console.log('  saved ->', path.relative(path.join(__dirname, '..'), dest));
}

(async () => {
  const mode = (process.argv[2] || 'desktop').toLowerCase();
  fs.mkdirSync(VENDOR, { recursive: true });
  const rel = await fetchRelease();
  console.log('TorrServer release:', rel.tag_name);
  const want = mode === 'android'
    ? ['TorrServer-android-arm64', 'TorrServer-android-arm7']
    : [desktopAsset()];
  for (const name of want) {
    const asset = rel.assets.find((a) => a.name === name);
    if (!asset) { console.warn('  asset not found in release:', name); continue; }
    await download(asset, path.join(VENDOR, name));
  }

  if (mode === 'android') {
    // Place the arm binaries into jniLibs as libtorrserver.so. Android only extracts
    // files named lib*.so and nativeLibraryDir is the one place an app may exec from.
    const jni = path.join(__dirname, '..', 'android-app', 'app', 'src', 'main', 'jniLibs');
    const map = { 'TorrServer-android-arm64': 'arm64-v8a', 'TorrServer-android-arm7': 'armeabi-v7a' };
    for (const [name, abi] of Object.entries(map)) {
      const src = path.join(VENDOR, name);
      if (!fs.existsSync(src)) continue;
      const dir = path.join(jni, abi);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, path.join(dir, 'libtorrserver.so'));
      console.log('  placed', abi + '/libtorrserver.so');
    }
  }
  console.log('Done.');
})().catch((e) => { console.error('setup-torrserver failed:', e.message); process.exit(1); });
