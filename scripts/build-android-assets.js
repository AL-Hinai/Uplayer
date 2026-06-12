#!/usr/bin/env node
'use strict';

/*
 * Bundles the Uplayer Node app into the Android project's assets so nodejs-mobile
 * can run it on-device.
 *
 *   node scripts/build-android-assets.js
 *
 * Copies the runtime JS + pruned node_modules into:
 *   android-app/app/src/main/assets/nodejs-project/
 *
 * Run from the repo root after `npm install` (or `npm ci`).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'android-app', 'app', 'src', 'main', 'assets', 'nodejs-project');

// App source files/dirs to ship (relative to repo root).
// `.env` is included so the on-device server gets the same API keys as desktop.
// (The assets bundle is gitignored, so keys aren't committed; note they ARE
// embedded in the APK and extractable — fine for a personal TMDB key.)
const INCLUDE = ['server.js', 'uplayer.js', 'sandbox.js', 'package.json', '.env', 'core', 'public'];

// node_modules we never need on Android (desktop binaries / WebRTC / build tools).
// ffmpeg-static & ffprobe-static ship ~400MB of x64 binaries we replace with the
// extracted aarch64 lib*.so; webtorrent-hybrid + wrtc are bypassed by the forced
// plain-webtorrent engine.
const PRUNE_MODULES = new Set([
  'ffmpeg-static',
  'ffprobe-static',
  'webtorrent-hybrid',
  'wrtc',
  'pkg',
  'node-pre-gyp',
  '@mapbox', // node-pre-gyp scope
]);

function rmrf(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (filter && !filter(from, entry)) continue;
    if (entry.isDirectory()) {
      copyDir(from, to, filter);
    } else if (entry.isSymbolicLink()) {
      // Resolve symlinks to real files (Android assets can't carry symlinks).
      try {
        const real = fs.realpathSync(from);
        if (fs.statSync(real).isDirectory()) copyDir(real, to, filter);
        else fs.copyFileSync(real, to);
      } catch (e) { /* dangling link — skip */ }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function copyNodeModules() {
  const srcModules = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(srcModules)) {
    console.error('node_modules not found — run `npm install` first.');
    process.exit(1);
  }
  const destModules = path.join(DEST, 'node_modules');
  fs.mkdirSync(destModules, { recursive: true });

  let copied = 0;
  let pruned = 0;
  for (const entry of fs.readdirSync(srcModules, { withFileTypes: true })) {
    const name = entry.name;
    if (name === '.bin' || name === '.cache' || name === '.package-lock.json') continue;
    if (PRUNE_MODULES.has(name)) { pruned++; continue; }
    const from = path.join(srcModules, name);
    const to = path.join(destModules, name);
    copyDir(from, to);
    copied++;
  }
  console.log(`  node_modules: copied ${copied} packages, pruned ${pruned}`);
}

function main() {
  console.log('Building Android assets ->', DEST);
  rmrf(DEST);
  fs.mkdirSync(DEST, { recursive: true });

  // 1. Android entry point.
  const mainJs = path.join(ROOT, 'android-app', 'nodejs-project', 'main.js');
  fs.copyFileSync(mainJs, path.join(DEST, 'main.js'));

  // 2. App source.
  for (const item of INCLUDE) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) { console.warn('  (skip missing)', item); continue; }
    const to = path.join(DEST, item);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
    console.log('  +', item);
  }

  // 3. Pruned dependencies.
  copyNodeModules();

  // 4. Version stamp so the app re-extracts when the bundle changes.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const stamp = `${pkg.version}-${Date.now()}`;
  fs.writeFileSync(path.join(DEST, '.bundle-version'), stamp);
  console.log('  bundle version:', stamp);

  console.log('Done. Now build the APK in android-app/ (see BUILD.md).');
}

main();
