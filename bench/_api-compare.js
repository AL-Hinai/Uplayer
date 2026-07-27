'use strict';

// Live A/B: current TorrServer integration vs the richer-API proposal, against the
// engine and torrent that are ACTUALLY loaded right now. Companion to the pure
// comparison in tests/exact-buffer.test.js — that file proves the math on crafted
// scenarios; this one shows the difference on a real cache.
//
//   1. Buffer question — current: estimate from /torrents preloaded_bytes (assumes
//      sequential, torrent-wide counter). New: exact piece walk from POST /cache.
//      Reported side-by-side at several playhead positions, plus the hole count the
//      estimate cannot see.
//   2. Probe question — current: download a 4MB sample of the stream, then run a
//      local ffprobe over it. New: GET /ffp/<hash>/<id>, the engine's own ffprobe.
//      Timed side-by-side (sample DOWNLOAD only — the local ffprobe exec would add
//      more on top of the current path).
//   3. The settings levers the current configure() does not touch.
//
// Read-only against the engine: nothing is added, removed, or reconfigured.

const http = require('http');
const { StreamHealth, exactBufferAheadBytes } = require('../core/stream-health');
const { TorrServerClient } = require('../core/torrserver-client');

function reqRaw(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout: 60000 }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve(buf));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function downloadBytes(port, urlPath, nBytes) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Range: `bytes=0-${nBytes - 1}` }, timeout: 120000 }, (res) => {
      let got = 0;
      res.on('data', (d) => { got += d.length; if (got >= nBytes) { res.destroy(); resolve(got); } });
      res.on('end', () => resolve(got));
      res.on('error', reject);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

const MB = 1024 * 1024;
const fmt = (n, d = 1) => (n == null ? '—' : (n / MB).toFixed(d) + ' MB');

(async () => {
  const c = new TorrServerClient({ log: () => {} });
  if (!(await c.isUp())) { console.log('TorrServer is not running on :' + c.port + ' — start a stream first.'); return; }
  const list = await c.list();
  if (!list.length) { console.log('No torrent loaded in TorrServer — start a stream first.'); return; }
  const hash = list[0].hash;
  console.log(`Torrent: ${list[0].title || list[0].name || hash}`);

  // Largest video file + its absolute offset in the torrent (files are laid out in order).
  const files = await c.files(hash);
  let offset = 0, pick = null, pickOffset = 0;
  for (const f of files) {
    const len = f.length || f.Length || 0;
    if (!pick || len > (pick.length || pick.Length)) { pick = f; pickOffset = offset; }
    offset += len;
  }
  const fileId = pick.id != null ? pick.id : pick.Id;
  const fileLen = pick.length || pick.Length;
  console.log(`File: id=${fileId}, ${fmt(fileLen, 0)}, absolute offset ${fmt(pickOffset, 0)}\n`);

  // --- 2. probe latency ------------------------------------------------------------
  console.log('== Probe: current (4MB sample download) vs new (GET /ffp) ==');
  let durationSec = null;
  let t = Date.now();
  try {
    const ffp = JSON.parse(await reqRaw(c.port, 'GET', `/ffp/${hash}/${fileId}`));
    const tFfp = Date.now() - t;
    durationSec = ffp && ffp.format && Number(ffp.format.duration) || null;
    const v = (ffp.streams || []).find((s) => s.codec_type === 'video') || {};
    console.log(`  new    /ffp:        ${String(tFfp).padStart(5)} ms  → codec=${v.codec_name}, duration=${durationSec ? Math.round(durationSec) + 's' : '?'}`);
  } catch (e) { console.log('  new    /ffp:        FAILED (' + e.message + ')'); }
  t = Date.now();
  try {
    const got = await downloadBytes(c.port, c.streamPath(hash, fileId, pick.path || pick.Path || 'video'), 4 * MB);
    console.log(`  current 4MB sample: ${String(Date.now() - t).padStart(5)} ms  → ${fmt(got)} downloaded (+ local ffprobe exec on top)`);
  } catch (e) { console.log('  current 4MB sample: FAILED (' + e.message + ')'); }

  // --- 1. buffer accuracy ----------------------------------------------------------
  console.log('\n== Buffer ahead: current estimate vs exact piece walk ==');
  const stats = await c.stats(hash);
  const cache = await c.cacheState(hash);
  if (!cache) { console.log('  /cache unavailable — cannot compare.'); return; }

  // Holes inside the cached span — invisible to the estimate by construction.
  const ids = Object.keys(cache.pieces).map(Number).sort((a, b) => a - b);
  let holes = 0;
  for (let k = 1; k < ids.length; k++) if (ids[k] - ids[k - 1] > 1) holes++;
  console.log(`  cache: ${fmt(cache.filled, 0)} of ${fmt(cache.capacity, 0)} filled, ${ids.length}/${cache.piecesCount} pieces, ${holes} hole(s) in the cached span`);
  if (cache.readers.length) console.log(`  engine readers: ${JSON.stringify(cache.readers)}`);

  if (!durationSec) { console.log('  no duration (ffp failed) — estimate needs it; skipping the table.'); return; }
  const bytesPerSec = fileLen / durationSec;
  console.log('  playhead   estimate(current)   exact(/cache)      difference');
  for (const frac of [0, 0.1, 0.25, 0.5, 0.75]) {
    const fileByte = Math.floor(fileLen * frac);
    const playheadSec = fileByte / bytesPerSec;
    const h = new StreamHealth().attachSource({ sizeBytes: fileLen, durationSec });
    h.report(stats);
    h.observePlayhead(playheadSec, 'bench');
    const est = h.status().buffer;
    const exactB = exactBufferAheadBytes(cache, pickOffset + fileByte);
    const exactSec = exactB == null ? null : exactB / bytesPerSec;
    const estStr = est ? `${fmt(est.aheadBytes)} (${Math.round(est.aheadSec)}s)` : '—';
    const exStr = exactB == null ? '—' : `${fmt(exactB)} (${Math.round(exactSec)}s)`;
    const diff = est && exactB != null ? fmt(Math.abs(est.aheadBytes - exactB)) : '—';
    console.log(`  ${(frac * 100).toFixed(0).padStart(3)}%       ${estStr.padEnd(19)}${exStr.padEnd(19)}${diff}`);
  }
  console.log('  (estimate > exact ⇒ it promises buffer that is not contiguously there)');

  // --- 3. settings levers ----------------------------------------------------------
  console.log('\n== Settings levers configure() does not touch ==');
  try {
    const s = JSON.parse(await reqRaw(c.port, 'POST', '/settings', { action: 'get' }));
    console.log(`  TorrentDisconnectTimeout: ${s.TorrentDisconnectTimeout}s (torrent dropped this long after last reader)`);
    console.log(`  ResponsiveMode:           ${s.ResponsiveMode} (true favours latency over throughput)`);
    console.log(`  PreloadCache:             ${s.PreloadCache}% of ${fmt(s.CacheSize, 0)} cache`);
  } catch (e) { console.log('  settings read failed: ' + e.message); }
})().catch((err) => { console.error(err); process.exit(1); });
