'use strict';
// Measure VLC stream quality: download speed/peers + seek-to-middle latency on
// TorrServer's native stream endpoint (what VLC now uses).
const http = require('http');
const { execFile } = require('child_process');
function reqJson(port, method, path, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 8000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b || 'null')); } catch (e) { res(b); } });
    });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function pull(urlStr, fromByte, durationMs) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const t0 = Date.now(); let ttfb = null, bytes = 0, start = null, done = false;
    const fin = (extra) => { if (done) return; done = true; const el = start ? (Date.now() - start) / 1000 : 0; resolve(Object.assign({ ttfb, bytes, mbps: (bytes / 1048576 / Math.max(el, 0.001)).toFixed(2) }, extra)); };
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Range: 'bytes=' + fromByte + '-' } }, (res) => {
      res.on('data', (d) => { if (ttfb === null) { ttfb = Date.now() - t0; start = Date.now(); } bytes += d.length; if (start && Date.now() - start >= durationMs) { try { res.destroy(); } catch (e) {} fin({ status: res.statusCode }); } });
      res.on('close', () => fin({ status: res.statusCode }));
    });
    req.on('error', (e) => fin({ err: e.message }));
    setTimeout(() => { try { req.destroy(); } catch (e) {} fin({ status: 0, note: 'no data within timeout' }); }, durationMs + 20000);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1048576;
const MAGNET = process.argv[2] || 'magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=OnePiece&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce';

(async () => {
  console.log('starting stream...');
  await reqJson(3000, 'POST', '/api/stream/start', { magnet: MAGNET });
  let vlc = null, fmt = null;
  for (let i = 0; i < 40; i++) { const st = await reqJson(3000, 'GET', '/api/stream/status'); const s = Array.isArray(st) ? st[0] : null; if (s && s.vlcUrl) { vlc = s.vlcUrl; fmt = s.videoFormat; break; } await sleep(1500); }
  if (!vlc) { console.log('no vlcUrl'); process.exit(0); }
  console.log('vlcUrl    :', vlc);
  console.log('format    :', JSON.stringify(fmt));

  const list = await reqJson(8090, 'POST', '/torrents', { action: 'list' });
  const t = (Array.isArray(list) && list[0]) || {};
  const size = t.torrent_size || 0;
  const hash = t.hash || t.Hash;
  console.log('file size :', (size / MB / 1024).toFixed(2), 'GB');

  console.log('\n--- download speed (sampling ~12s) ---');
  const sp = []; let peers = 0, buf = 0;
  for (let i = 0; i < 8; i++) { const g = await reqJson(8090, 'POST', '/torrents', { action: 'get', hash }); sp.push(g.download_speed || 0); peers = g.active_peers || g.connected_seeders || g.total_peers || peers; buf = g.preloaded_bytes || buf; process.stdout.write('.'); await sleep(1500); }
  const avg = sp.reduce((a, b) => a + b, 0) / sp.length, peak = Math.max.apply(null, sp);
  console.log('\navg ' + (avg / MB).toFixed(2) + ' MB/s | peak ' + (peak / MB).toFixed(2) + ' MB/s | peers ' + peers + ' | buffered ' + (buf / MB).toFixed(0) + ' MB');

  console.log('\n--- sequential throughput (from start, 6s) ---');
  const seq = await pull(vlc, 0, 6000);
  console.log('TTFB ' + seq.ttfb + ' ms | ' + seq.mbps + ' MB/s | ' + (seq.bytes / MB).toFixed(1) + ' MB' + (seq.note ? ' | ' + seq.note : ''));

  console.log('\n--- SEEK to MIDDLE (the laggy case) ---');
  const mid = Math.floor(size / 2);
  const seek = await pull(vlc, mid, 6000);
  console.log('seek TTFB ' + seek.ttfb + ' ms | then ' + seek.mbps + ' MB/s' + (seek.note ? ' | ' + seek.note : ''));
  const needMBs = 1.0; // ~1080p anime ≈ 8 Mbps ≈ 1 MB/s
  console.log('\nVERDICT:');
  console.log('  steady playback needs ~' + needMBs + ' MB/s; you have avg ' + (avg / MB).toFixed(2) + ' MB/s → ' + (avg / MB >= needMBs ? 'enough' : 'TOO SLOW (swarm-limited)'));
  console.log('  seek-to-middle wait: ' + (seek.ttfb != null ? (seek.ttfb / 1000).toFixed(1) + 's' : 'never arrived') + (seek.ttfb != null && seek.ttfb < 4000 ? ' (acceptable)' : ' (this is the lag — TorrServer fetching un-downloaded pieces)'));
  process.exit(0);
})();
