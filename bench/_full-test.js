'use strict';
const http = require('http');
const { execFile } = require('child_process');
let ffprobe = null; try { ffprobe = require('ffprobe-static').path; } catch (e) {}
const MB = 1048576;
function reqJson(port, method, path, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 8000 }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b || 'null')); } catch (e) { res(b); } }); });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function getText(port, path) { return new Promise((res) => { const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 8000 }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); }); r.end(); }); }
function pull(urlStr, fromByte, durationMs) {
  return new Promise((resolve) => {
    const u = new URL(urlStr); const t0 = Date.now(); let ttfb = null, bytes = 0, start = null, done = false;
    const fin = (extra) => { if (done) return; done = true; const el = start ? (Date.now() - start) / 1000 : 0; resolve(Object.assign({ ttfb, bytes, mbps: +(bytes / MB / Math.max(el, 0.001)).toFixed(2) }, extra)); };
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Range: 'bytes=' + fromByte + '-' } }, (res) => {
      res.on('data', (d) => { if (ttfb === null) { ttfb = Date.now() - t0; start = Date.now(); } bytes += d.length; if (start && Date.now() - start >= durationMs) { try { res.destroy(); } catch (e) {} fin({ status: res.statusCode }); } });
      res.on('close', () => fin({ status: res.statusCode }));
    });
    req.on('error', (e) => fin({ err: e.message }));
    setTimeout(() => { try { req.destroy(); } catch (e) {} fin({ note: 'no data' }); }, durationMs + 20000);
    req.end();
  });
}
function probe(url) { return new Promise((res) => { if (!ffprobe) return res(null); execFile(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', url], { timeout: 30000 }, (e, out) => { try { res(JSON.parse(out)); } catch (_) { res(null); } }); }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGNET = process.argv[2] || 'magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=OnePiece&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce';

(async () => {
  const t0 = Date.now();
  await reqJson(3000, 'POST', '/api/stream/start', { magnet: MAGNET });
  let s = null;
  for (let i = 0; i < 120; i++) { const st = await reqJson(3000, 'GET', '/api/stream/status'); s = Array.isArray(st) ? st[0] : null; if (s && s.playerUrl) break; if (s && s.exited) { console.log('stream exited early (server issue)'); process.exit(0); } await sleep(1000); }
  if (!s || !s.playerUrl) { console.log('never became ready'); process.exit(0); }
  console.log('=== STREAM READY ===');
  console.log('pre-buffer wait : ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('strategy        : ' + (s.videoFormat && s.videoFormat.playbackStrategy));
  const vlc = s.vlcUrl, cast = s.castUrl;
  const vlcLocal = vlc.replace(/\/\/[^/]+/, '//127.0.0.1:8090');

  const pr = await probe(vlcLocal);
  let w, h, dur, totalbr, vcodec, acodec;
  if (pr) { const v = (pr.streams || []).find((x) => x.codec_type === 'video'); const a = (pr.streams || []).find((x) => x.codec_type === 'audio'); w = v && v.width; h = v && v.height; vcodec = v && v.codec_name; acodec = a && a.codec_name; dur = pr.format && parseFloat(pr.format.duration); totalbr = pr.format && parseInt(pr.format.bit_rate); }
  const needMBs = totalbr ? totalbr / 8 / MB : 1.0;
  console.log('\n=== QUALITY ===');
  console.log('resolution      : ' + (w && h ? w + 'x' + h : '?') + '  video=' + (vcodec || '?') + '  audio=' + (acodec || '?'));
  console.log('bitrate         : ' + (totalbr ? (totalbr / 1e6).toFixed(1) + ' Mbps' : '?') + '  -> needs ~' + needMBs.toFixed(2) + ' MB/s sustained');
  console.log('duration        : ' + (dur ? Math.round(dur / 60) + ' min' : '?'));

  console.log('\n=== VLC (TorrServer direct, full quality) ===');
  const list = await reqJson(8090, 'POST', '/torrents', { action: 'list' }); const t = (Array.isArray(list) && list[0]) || {}; const hash = t.hash; const size = t.torrent_size || 0;
  const sp = []; let peers = 0;
  for (let i = 0; i < 8; i++) { const g = await reqJson(8090, 'POST', '/torrents', { action: 'get', hash }); sp.push(g.download_speed || 0); peers = g.active_peers || g.connected_seeders || peers; await sleep(1500); }
  const avg = sp.reduce((a, b) => a + b, 0) / sp.length, peak = Math.max.apply(null, sp);
  console.log('download speed  : avg ' + (avg / MB).toFixed(2) + ' MB/s | peak ' + (peak / MB).toFixed(2) + ' | peers ' + peers);
  const seq = await pull(vlcLocal, 0, 8000);
  console.log('forward play    : ' + seq.mbps + ' MB/s');
  const seek = await pull(vlcLocal, Math.floor(size / 2), 12000);
  console.log('after seek-mid  : ' + seek.mbps + ' MB/s sustained (TTFB ' + seek.ttfb + 'ms)');

  console.log('\n=== WEB (HLS transcode) — keeps up with realtime? ===');
  const idxPath = new URL(cast).pathname;
  const r1 = await getText(8000, idxPath); const segs1 = ((r1.body || '').match(/seg\d+\.ts/g) || []).length;
  console.log('watching 30s...');
  await sleep(30000);
  const r2 = await getText(8000, idxPath); const segs2 = ((r2.body || '').match(/seg\d+\.ts/g) || []).length; const endlist = /#EXT-X-ENDLIST/.test(r2.body || '');
  const rate = ((segs2 - segs1) * 6) / 30;
  console.log('produced ' + (segs2 - segs1) + ' segments (' + ((segs2 - segs1) * 6) + 's video) in 30s -> ' + rate.toFixed(2) + 'x realtime' + (endlist ? ' [finished]' : ''));

  console.log('\n=== VERDICT (never-lag) ===');
  console.log('VLC forward play: ' + (avg / MB >= needMBs ? 'SMOOTH (download >= bitrate)' : 'LAG RISK (download ' + (avg / MB).toFixed(2) + ' < need ' + needMBs.toFixed(2) + ')'));
  console.log('VLC far-seek    : ' + (seek.mbps >= needMBs ? 'SMOOTH' : 'BUFFERS first (seek to un-downloaded part — inherent)'));
  console.log('Web/HLS         : ' + (rate >= 1.0 || endlist ? 'SMOOTH (>= realtime)' : 'BEHIND realtime (' + rate.toFixed(2) + 'x) -> stalls'));
  process.exit(0);
})();
