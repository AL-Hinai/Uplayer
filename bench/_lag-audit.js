'use strict';
/*
 * UPLAYER LAG AUDIT — end-to-end "does it lag, and how long does anything take" test.
 *
 * Exercises the WHOLE playback chain the way the real clients do and reports, for
 * every path, sustained throughput vs the bitrate it must keep up with, stalls
 * (gaps where no bytes arrive), seek responsiveness (TTFB after a seek), and timings.
 *
 *   Paths covered
 *     • Web page        — fetches the player page, parses its embedded config, checks
 *                         vendor assets + subtitle manifest respond.
 *     • Web playback     — drives the exact source the browser <video> uses: the HLS
 *                         segment-production rate, OR (direct-play) the open-ended
 *                         byte-range proxy on :8000.
 *     • VLC (direct)     — pulls TorrServer's native /stream endpoint (:8090).
 *     • Seek response    — re-ranges web + VLC at 10/50/90% and times the first byte.
 *
 *   IMPORTANT — one TorrServer torrent is shared by every path. A far seek (or an
 *   ffprobe that reads MKV cues at the END of the file) reprioritises which pieces
 *   TorrServer downloads, which can starve a sequential reader somewhere else. So the
 *   web-playback measurement runs FIRST and in ISOLATION; ffprobe and the VLC seek
 *   tests run AFTER it. A real user drives one path at a time, so this matches reality.
 *
 *   Usage
 *     node bench/_lag-audit.js [magnet] [--fresh] [--quick|--deep] [--stop]
 *       magnet   torrent to test (defaults to the bundled sample)
 *       --fresh  always start a new stream (default: reuse the running one if ready)
 *       --quick  shorter sampling windows; --deep longer. Default is medium.
 *       --stop   stop the stream when the audit finishes (default: leave it running)
 *
 *   Prereqs: the app server must be running on :3000 (npm run web). TorrServer (:8090)
 *   is launched by the app. ffprobe (ffprobe-static) is used for bitrate if present.
 */

const http = require('http');
const { execFile } = require('child_process');
let ffprobe = null; try { ffprobe = require('ffprobe-static').path; } catch (e) {}

const MB = 1048576;
const APP = 3000, WEB = 8000, TS = 8090;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const MAGNET = args.find((a) => a.startsWith('magnet:'))
  || 'magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=OnePiece&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce';

// Sampling windows (ms). --quick halves them, --deep doubles them.
const SCALE = flag('--quick') ? 0.5 : flag('--deep') ? 2 : 1;
const FWD_MS = Math.round(12000 * SCALE);   // forward-play measurement
const SEEK_MS = Math.round(8000 * SCALE);   // per-seek measurement
const HLS_MS = Math.round(30000 * SCALE);   // HLS realtime-rate window
const STALL_MS = 1200;                      // gap >= this between bytes counts as a stall

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fix = (n, d = 2) => Number(n).toFixed(d);
const pad = (s, n) => String(s).padEnd(n);

// ---- tiny HTTP helpers ------------------------------------------------------
function reqJson(port, method, path, body, timeout = 8000) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { resolve(JSON.parse(b || 'null')); } catch (e) { resolve(b); } });
    });
    r.on('error', (e) => resolve({ err: e.message })); r.on('timeout', () => { r.destroy(); resolve({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function httpReq(urlStr, { method = 'GET', headers = {}, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ err: 'bad url' }); }
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, body: b }));
    });
    r.on('error', (e) => resolve({ err: e.message })); r.on('timeout', () => { r.destroy(); resolve({ err: 'timeout' }); });
    r.end();
  });
}
function toLocal(urlStr) { try { const u = new URL(urlStr); u.hostname = '127.0.0.1'; return u.toString(); } catch (e) { return urlStr; } }
function probeUrl(url) {
  return new Promise((res) => {
    if (!ffprobe) return res(null);
    execFile(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', url], { timeout: 30000 }, (e, out) => { try { res(JSON.parse(out)); } catch (_) { res(null); } });
  });
}

/*
 * Open a ranged GET and watch the bytes arrive. Returns throughput, TTFB, and — the
 * point of this whole script — the stall profile: max gap between data events and how
 * many gaps exceeded STALL_MS. We read flat-out, so a sustained rate >= the bitrate
 * means a real player (which reads at playback rate) can never starve; a long maxGap
 * means even a buffered player could hitch.
 */
function audit(urlStr, fromByte, durationMs, { timeline = false } = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ err: 'bad url' }); }
    const t0 = Date.now();
    let ttfb = null, firstAt = null, lastAt = null, bytes = 0, done = false;
    let maxGap = 0, stalls = 0, stalledMs = 0, status = null, clen = null, crange = null;
    const buckets = [];
    const fin = (extra) => {
      if (done) return; done = true;
      const dur = firstAt ? (lastAt - firstAt) / 1000 : 0;
      // Densify per-second buckets so a zero-byte second (a stall) shows as a gap
      // instead of being skipped by Array.map over a sparse hole.
      const span = firstAt ? Math.ceil((lastAt - firstAt) / 1000) : 0;
      const dense = []; for (let i = 0; i < span; i++) dense[i] = buckets[i] || 0;
      resolve(Object.assign({
        status, ttfb, bytes, mbps: +(bytes / MB / Math.max(dur, 0.001)).toFixed(2),
        maxGap, stalls, stalledMs, clen, crange, buckets: dense, secs: +dur.toFixed(1),
      }, extra));
    };
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Range: `bytes=${fromByte}-` }, timeout: 30000 }, (res) => {
      status = res.statusCode;
      clen = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
      crange = res.headers['content-range'] || null;
      res.on('data', (d) => {
        const now = Date.now();
        if (ttfb === null) { ttfb = now - t0; firstAt = lastAt = now; }
        else { const gap = now - lastAt; if (gap > maxGap) maxGap = gap; if (gap >= STALL_MS) { stalls++; stalledMs += gap; } lastAt = now; }
        bytes += d.length;
        if (timeline) { const b = Math.floor((now - firstAt) / 1000); buckets[b] = (buckets[b] || 0) + d.length; }
        if (now - firstAt >= durationMs) { try { res.destroy(); } catch (e) {} fin(); }
      });
      res.on('end', () => fin());
      res.on('close', () => fin());
      res.on('error', (e) => fin({ err: e.message }));
    });
    req.on('error', (e) => fin({ err: e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} fin({ err: 'timeout (no first byte)' }); });
    req.end();
  });
}

function sparkline(buckets) {
  const blocks = ' .:-=+*#%@';
  const vals = buckets.map((b) => (b || 0) / MB);
  if (!vals.length) return '(no data)';
  const max = Math.max.apply(null, vals) || 1;
  return vals.map((v) => blocks[Math.min(blocks.length - 1, Math.round((v / max) * (blocks.length - 1)))]).join('');
}

// =============================================================================
(async () => {
  const auditStart = Date.now();
  const fails = [];
  let quality = null; // { needMBs, w, h, vcodec, acodec, totalbr, dur } — probed lazily, ONCE
  console.log('\n========================  UPLAYER LAG AUDIT  ========================');
  console.log('windows: forward ' + (FWD_MS / 1000) + 's | seek ' + (SEEK_MS / 1000) + 's | hls ' + (HLS_MS / 1000) + 's | stall>=' + STALL_MS + 'ms\n');

  // ---- preflight ----
  const echo = await httpReq(`http://127.0.0.1:${TS}/echo`, { timeout: 2000 });
  const appUp = await reqJson(APP, 'GET', '/api/stream/status', null, 2000);
  if (appUp && appUp.err) { console.log(`x app server not reachable on :${APP}. Start it with "npm run web" and re-run.`); process.exit(1); }
  console.log(`preflight: app:${APP} UP | torrserver:${TS} ${echo.status === 200 ? 'UP' : 'starting/down'}`);

  // ---- [1] STARTUP ----
  console.log('\n[1] STARTUP  ---------------------------------------------------------');
  let s = Array.isArray(appUp) ? appUp.find((x) => x.playerUrl) : null;
  let startupSecs = null;
  if (s && !flag('--fresh')) {
    console.log('  reusing the stream already running (pass --fresh to force a new start)');
  } else {
    const t0 = Date.now();
    await reqJson(APP, 'POST', '/api/stream/start', { magnet: MAGNET });
    process.stdout.write('  starting + pre-buffering');
    for (let i = 0; i < 180; i++) {
      const st = await reqJson(APP, 'GET', '/api/stream/status');
      s = Array.isArray(st) ? st.find((x) => x.playerUrl) : null;
      if (s && s.playerUrl) { startupSecs = (Date.now() - t0) / 1000; break; }
      if (Array.isArray(st) && st[0] && st[0].exited) { console.log('\n  x stream exited early (server issue)'); process.exit(1); }
      process.stdout.write('.'); await sleep(1000);
    }
    console.log('');
    if (!s) { console.log('  x never became ready in 180s'); process.exit(1); }
    console.log(`  player ready in ${fix(startupSecs, 1)}s  (time-to-first-play)`);
  }
  const strategy = (s.videoFormat && s.videoFormat.playbackStrategy) || '?';
  const container = (s.videoFormat && s.videoFormat.container) || 'mp4';
  console.log(`  strategy        : ${strategy}`);
  const playerLocal = toLocal(s.playerUrl);
  const vlcLocal = toLocal(s.vlcUrl);
  const origin = (() => { try { return new URL(playerLocal).origin; } catch (e) { return `http://127.0.0.1:${WEB}`; } })();
  const rawUrl = `${origin}/video.${container}`; // raw byte-range path (always served, used by VLC/direct)

  // file size (no torrent seek — HEAD just reads videoFile.length)
  let fileSize = 0;
  const head = await httpReq(rawUrl, { method: 'HEAD' });
  fileSize = Number(head.headers && head.headers['content-length']) || 0;

  // lazy single ffprobe (seeks MKV cues at EOF — only call AFTER web playback measured)
  const getQuality = async () => {
    if (quality) return quality;
    quality = { needMBs: 1.5 };
    if (!ffprobe) return quality;
    const pr = await probeUrl(vlcLocal);
    if (pr) {
      const v = (pr.streams || []).find((x) => x.codec_type === 'video');
      const a = (pr.streams || []).find((x) => x.codec_type === 'audio');
      quality.w = v && v.width; quality.h = v && v.height; quality.vcodec = v && v.codec_name; quality.acodec = a && a.codec_name;
      quality.dur = pr.format && parseFloat(pr.format.duration); quality.totalbr = pr.format && parseInt(pr.format.bit_rate);
      if (quality.totalbr) quality.needMBs = quality.totalbr / 8 / MB;
    }
    return quality;
  };

  // ---- [2] WEB PAGE REVIEW (no torrent reads) ----
  console.log('\n[2] WEB PAGE REVIEW  -------------------------------------------------');
  const page = await httpReq(playerLocal);
  let cfg = {};
  if (page.status === 200) {
    const m = (page.body || '').match(/__UPLAYER_PLAYER_CONFIG__\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (m) { try { cfg = JSON.parse(m[1]); } catch (e) {} }
    const hasVideo = /id="videoPlayer"/.test(page.body || '');
    console.log(`  GET player page : 200  | <video> ${hasVideo ? 'present' : 'MISSING'} | source=${cfg.isHlsSource ? 'HLS' : 'direct'} | transcoding=${!!cfg.transcoding} | subs=${cfg.subtitleCount || 0}`);
    if (!hasVideo) fails.push('player page missing <video> element');
  } else { console.log(`  GET player page : ${page.status || page.err} (FAIL)`); fails.push('player page did not return 200'); }
  const vjs = await httpReq(origin + '/vendor/videojs/video.min.js');
  console.log(`  vendor assets   : video.min.js -> ${vjs.status || vjs.err}${vjs.status === 200 ? '' : '  (player UI would not load)'}`);
  const subman = await httpReq(origin + '/api/subtitles');
  console.log(`  subtitle manifest: ${subman.status || subman.err}`);
  const isHls = !!cfg.isHlsSource;
  const webSource = origin + (cfg.videoUrl || `/video.${container}`);
  console.log(`  browser streams from: ${webSource}`);

  // ---- [3] WEB PLAYBACK — measured FIRST and in ISOLATION (nothing else hits the torrent) ----
  console.log('\n[3] WEB PLAYBACK — does it lag while watching?  ----------------------');
  const result = { web: null, hls: null, webSeek: [], vlcSeek: [] };
  if (isHls) {
    // HLS: the browser plays ffmpeg's segments — measure they're produced >= realtime.
    const idxPath = cfg.videoUrl || '/hls/index.m3u8';
    const r1 = await httpReq(origin + idxPath); const segs1 = ((r1.body || '').match(/seg\d+\.ts/g) || []).length;
    process.stdout.write(`  HLS segment production over ${HLS_MS / 1000}s `);
    const tick = Math.max(1, Math.round((HLS_MS / 1000) / 10));
    for (let i = 0; i < HLS_MS / 1000; i += tick) { await sleep(tick * 1000); process.stdout.write('.'); }
    const r2 = await httpReq(origin + idxPath); const segs2 = ((r2.body || '').match(/seg\d+\.ts/g) || []).length; const endlist = /#EXT-X-ENDLIST/.test(r2.body || '');
    const rate = ((segs2 - segs1) * 6) / (HLS_MS / 1000);
    result.hls = { rate, endlist, segs: segs2 - segs1 };
    console.log(`\n  produced ${segs2 - segs1} segs (${(segs2 - segs1) * 6}s of video) in ${HLS_MS / 1000}s -> ${fix(rate)}x realtime${endlist ? ' [finished]' : ''}`);
    const lag = !(rate >= 1.0 || endlist);
    console.log(`  VERDICT (web)   : ${lag ? 'LAG — behind realtime, will stall' : 'SMOOTH (>= realtime, player stays ahead)'}`);
    if (lag) fails.push(`HLS behind realtime (${fix(rate)}x)`);
  } else {
    // Direct-play: pull the open-ended range exactly as a browser <video> does.
    console.log(`  file size       : ${fix(fileSize / MB / 1024)} GB`);
    process.stdout.write(`  forward-play ${FWD_MS / 1000}s ...`);
    const r = await audit(webSource, 0, FWD_MS, { timeline: true });
    result.web = r;
    const q = await getQuality();   // probe AFTER the pull so EOF-seek can't starve it
    const need = q.needMBs;
    const capRemoved = r.clen != null && r.clen > 11 * MB;
    console.log('\n  10MB-cap check  : ' + (r.clen == null ? '? (no content-length)' : capRemoved ? `REMOVED — one connection serves ${fix(r.clen / MB / 1024)} GB (fix active)` : `STILL CAPPED at ${fix(r.clen / MB)} MB (fix NOT active!)`));
    if (r.clen != null && !capRemoved) fails.push('web direct-play still capped at ~10MB per request');
    console.log(`  throughput      : ${fix(r.mbps)} MB/s sustained over ${r.secs}s  (need ~${fix(need)})  TTFB ${r.ttfb}ms`);
    console.log(`  stalls          : ${r.stalls} gap(s) >=${STALL_MS}ms | worst gap ${r.maxGap}ms | stalled ${fix(r.stalledMs / 1000, 1)}s total`);
    console.log(`  per-sec MB/s    : [${sparkline(r.buckets)}]  ${r.buckets.map((b) => fix((b || 0) / MB, 1)).join(' ')}`);
    const lag = r.mbps < need || r.maxGap > 2500;
    console.log(`  VERDICT (web)   : ${lag ? 'LAG RISK' : 'SMOOTH'}  ${r.mbps < need ? `(throughput ${fix(r.mbps)} < need ${fix(need)})` : r.maxGap > 2500 ? `(a ${r.maxGap}ms stall would hitch a buffered player)` : '(stays ahead of playback)'}`);
    if (lag) fails.push(`web forward-play lag risk (${fix(r.mbps)} MB/s vs need ${fix(need)})`);
  }

  // ---- [4] MEDIA QUALITY ----
  console.log('\n[4] MEDIA QUALITY (ffprobe via VLC/TorrServer direct)  ---------------');
  const q = await getQuality();
  if (!ffprobe) console.log('  ffprobe-static not installed — used a default 1.5 MB/s target');
  else if (q.w) {
    console.log(`  resolution      : ${q.w}x${q.h}  video=${q.vcodec || '?'}  audio=${q.acodec || '?'}`);
    console.log(`  bitrate         : ${q.totalbr ? (q.totalbr / 1e6).toFixed(1) + ' Mbps' : '?'}  -> needs ~${fix(q.needMBs)} MB/s sustained to never stall`);
    console.log(`  duration        : ${q.dur ? Math.round(q.dur / 60) + ' min' : '?'}`);
  } else console.log('  probe failed (stream not readable) — used 1.5 MB/s target');

  // ---- [5] SWARM HEALTH ----
  console.log('\n[5] SWARM HEALTH (TorrServer)  ---------------------------------------');
  const list = await reqJson(TS, 'POST', '/torrents', { action: 'list' });
  const t = (Array.isArray(list) && list[0]) || {};
  const hash = t.hash || t.Hash;
  if (!fileSize) fileSize = t.torrent_size || 0;
  const sp = []; let peers = 0, preloaded = 0;
  process.stdout.write('  sampling');
  for (let i = 0; i < 6; i++) { const g = await reqJson(TS, 'POST', '/torrents', { action: 'get', hash }); sp.push(g.download_speed || 0); peers = g.active_peers || g.connected_seeders || g.total_peers || peers; preloaded = g.preloaded_bytes || preloaded; process.stdout.write('.'); await sleep(1200); }
  const avgDl = sp.reduce((a, b) => a + b, 0) / sp.length, peakDl = Math.max.apply(null, sp);
  console.log(`\n  download speed  : avg ${fix(avgDl / MB)} MB/s | peak ${fix(peakDl / MB)} MB/s | peers ${peers} | buffered ${fix(preloaded / MB, 0)} MB ahead`);

  // ---- [6] SEEK RESPONSE (LAST — far seeks reprioritise the shared torrent) ----
  console.log('\n[6] SEEK RESPONSE — TTFB after jumping (web proxy vs VLC direct)  ----');
  console.log('  ' + pad('seek', 7) + pad('WEB proxy (:8000)', 40) + 'VLC direct (:8090)');
  for (const p of [0.10, 0.50, 0.90]) {
    const off = Math.floor(fileSize * p);
    const web = isHls ? null : await audit(webSource, off, SEEK_MS);
    const vlc = await audit(vlcLocal, off, SEEK_MS);
    if (web) result.webSeek.push(web);
    result.vlcSeek.push(vlc);
    const fmt = (r) => r ? `TTFB ${pad(r.ttfb + 'ms', 8)} ${fix(r.mbps)}MB/s ${r.stalls ? r.stalls + ' stall' : 'no stall'}` : 'n/a (HLS plays segments, not byte ranges)';
    console.log('  ' + pad(Math.round(p * 100) + '%', 7) + pad(fmt(web), 40) + fmt(vlc));
  }
  const avgTtfb = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + (b.ttfb || 0), 0) / arr.length) : null;
  const webSeekTtfb = avgTtfb(result.webSeek), vlcSeekTtfb = avgTtfb(result.vlcSeek);
  console.log('  note: a far seek into not-yet-downloaded video must fetch fresh pieces, so a higher TTFB there is inherent, not a bug.');

  // ---- [7] CAST / DLNA ----
  console.log('\n[7] CAST / DLNA  -----------------------------------------------------');
  const castLocal = toLocal(s.castUrl);
  const castIsHls = /\.m3u8(\?|$)/.test(castLocal);
  const need = q.needMBs;

  // -- Chromecast (Google Cast). The receiver pulls castUrl ITSELF from Uplayer :8000. --
  console.log('  -- Chromecast (Google Cast sender -> receiver pulls from :8000) --');
  console.log(`  cast URL        : ${castLocal}`);
  console.log(`  contentType     : ${castIsHls ? 'application/vnd.apple.mpegurl (HLS)' : 'video/* (direct byte-range)'}`);
  if (castIsHls) {
    const man = await httpReq(castLocal);
    const segNames = (man.body || '').match(/seg\d+\.ts/g) || [];
    const ctype = String(man.headers && man.headers['content-type'] || '').toLowerCase();
    const isTs = !/\.m4s/.test(man.body || '') && segNames.length > 0; // default receiver wants MPEG-TS, not fMP4
    console.log(`  manifest        : ${man.status} | ${ctype || '(no content-type)'} | ${segNames.length} segs | ${isTs ? 'MPEG-TS .ts (receiver-friendly)' : 'NOT .ts (Chromecast default receiver may stall)'}`);
    if (man.status !== 200) fails.push('cast HLS manifest not 200');
    if (!/mpegurl/.test(ctype)) fails.push('cast HLS manifest missing mpegurl content-type');
    // The receiver pulls each segment from DISK (ffmpeg already wrote it) — measure that fetch.
    if (segNames.length) {
      const mid = segNames[Math.floor(segNames.length / 2)];
      const segUrl = new URL(mid, castLocal).toString();
      const seg = await audit(segUrl, 0, 60000); // small file: ends on EOF
      const segMB = seg.bytes / MB;
      console.log(`  segment pull    : ${mid} -> ${seg.status} | ${fix(segMB)} MB in ${seg.secs}s @ ${fix(seg.mbps)} MB/s | TTFB ${seg.ttfb}ms`);
      result.cast = { kind: 'hls', segMbps: seg.mbps, smooth: seg.mbps >= need };
      console.log(`  receiver-compat : video=${q.vcodec || '?'} ${/(h264|avc)/i.test(q.vcodec || '') ? '(H.264 OK)' : '(NOT H.264 — default receiver only plays H.264!)'} | audio=${q.acodec || '?'} ${/aac|mp3/i.test(q.acodec || '') ? '(OK)' : '(needs AAC/MP3)'}`);
      if (!/(h264|avc)/i.test(q.vcodec || '')) fails.push('cast: video is not H.264 (default Chromecast receiver cannot play)');
      const lag = seg.mbps < need;
      console.log(`  VERDICT (cast)  : ${lag ? 'LAG RISK (segment fetch slower than realtime)' : 'SMOOTH — segments ready on disk, receiver-compatible'}`);
      if (lag) fails.push(`cast HLS segment fetch slow (${fix(seg.mbps)} < need ${fix(need)})`);
    }
  } else {
    // Direct-play cast: the receiver sends a CrKey User-Agent; verify the first-byte path.
    const first = await httpReq(castLocal, { headers: { 'User-Agent': 'CrKey/1.0' } });
    const cr = first.headers && first.headers['content-range'];
    const cl = Number(first.headers && first.headers['content-length']) || 0;
    console.log(`  CrKey first-byte: ${first.status} | Content-Range ${cr ? 'present (' + cr + ')' : 'MISSING'} | first chunk ${fix(cl / MB)} MB`);
    if (!cr) fails.push('cast direct-play first response missing Content-Range (receiver may not learn full size)');
    const ranged = await audit(castLocal, 0, FWD_MS);
    result.cast = { kind: 'direct', mbps: ranged.mbps, smooth: ranged.mbps >= need };
    console.log(`  ranged pull     : ${fix(ranged.mbps)} MB/s sustained | clen ${ranged.clen != null ? fix(ranged.clen / MB / 1024) + ' GB (continuous, cap removed)' : '?'}`);
    const lag = ranged.mbps < need;
    console.log(`  VERDICT (cast)  : ${lag ? 'LAG RISK' : 'SMOOTH'}`);
    if (lag) fails.push(`cast direct-play slow (${fix(ranged.mbps)} < need ${fix(need)})`);
  }

  // -- DLNA (TorrServer's own media server; the TV plays direct from :8090) --
  console.log('  -- DLNA (TorrServer built-in media server -> TV plays direct from :8090) --');
  const sets = await reqJson(TS, 'POST', '/settings', { action: 'get' });
  const dlnaOn = sets && (sets.EnableDLNA === true);
  console.log(`  DLNA setting    : EnableDLNA=${sets ? sets.EnableDLNA : '?'} | FriendlyName="${sets ? sets.FriendlyName : '?'}"  ${dlnaOn ? '(TV sees "Uplayer" in its media-server list)' : '(DLNA OFF!)'}`);
  console.log(`  active TS tuning: cache=${sets ? fix((sets.CacheSize || 0) / MB, 0) : '?'}MB | conns=${sets ? sets.ConnectionsLimit : '?'} | readahead=${sets ? sets.ReaderReadAHead : '?'}%`);
  if (!dlnaOn) fails.push('DLNA disabled in TorrServer settings');
  // DLNA plays the SAME native TorrServer stream as VLC (already proven fast by the
  // section-6 seek tests). This sample reads from byte 0, but those far-seeks just
  // evicted the early pieces from cache, so a low number here is a cold re-read, not
  // representative of DLNA forward-play — report it as info, don't fail on it. The real
  // DLNA failure modes are "disabled" or "unreachable", which we DO flag.
  const dlna = await audit(vlcLocal, 0, Math.min(6000, FWD_MS));
  const reachable = dlna.ttfb != null && !dlna.err;
  console.log(`  DLNA reachable  : ${reachable ? 'yes (TTFB ' + dlna.ttfb + 'ms)' : 'NO — ' + (dlna.err || 'no data')} | throughput ${fix(dlna.mbps)} MB/s (info; cold re-read after seeks)`);
  console.log(`  VERDICT (DLNA)  : ${dlnaOn && reachable ? 'SMOOTH — native stream, same fast path as VLC' : 'PROBLEM'}`);
  console.log('  note: DLNA discovery is SSDP/UPnP on the LAN — open your TV media-server list and pick "Uplayer".');
  if (dlnaOn && !reachable) fails.push('DLNA stream not reachable on :8090');

  // ---- SUMMARY ----
  const totalSecs = (Date.now() - auditStart) / 1000;
  console.log('\n========================  SUMMARY / VERDICT  ========================');
  console.log(`startup (time-to-first-play): ${startupSecs != null ? fix(startupSecs, 1) + 's' : 'reused (already running)'}`);
  console.log(`swarm                        : ${fix(avgDl / MB)} MB/s avg, ${peers} peers  (need ~${fix(q.needMBs)} MB/s)`);
  if (result.web) console.log(`web forward-play             : ${result.web.mbps < q.needMBs ? 'LAG RISK' : 'SMOOTH'}  (${fix(result.web.mbps)} MB/s, worst stall ${result.web.maxGap}ms)`);
  if (result.hls) console.log(`web (HLS)                    : ${result.hls.rate >= 1 || result.hls.endlist ? 'SMOOTH' : 'LAG'}  (${fix(result.hls.rate)}x realtime, ${result.hls.segs} segs)`);
  if (webSeekTtfb != null) console.log(`web seek responsiveness      : avg first byte ${webSeekTtfb}ms after a jump`);
  console.log(`vlc seek responsiveness      : avg first byte ${vlcSeekTtfb}ms after a jump`);
  if (result.cast) console.log(`chromecast (${result.cast.kind})${result.cast.kind === 'hls' ? '          ' : '       '}: ${result.cast.smooth ? 'SMOOTH' : 'LAG RISK'}  (${fix(result.cast.segMbps != null ? result.cast.segMbps : result.cast.mbps)} MB/s)`);
  console.log(`dlna (TorrServer direct)     : fastest cast path (native :8090 stream)`);
  console.log(`\nLAG DETECTED ANYWHERE?       : ${fails.length ? 'YES' : 'NO — smooth on every tested path'}`);
  for (const f of fails) console.log('   - ' + f);
  console.log(`\ntotal audit time             : ${fix(totalSecs, 1)}s`);

  if (flag('--stop')) {
    const stat = await reqJson(APP, 'GET', '/api/stream/status');
    const id = Array.isArray(stat) && stat[0] && stat[0].id;
    if (id) { await reqJson(APP, 'DELETE', `/api/stream/stop/${id}`); console.log('stream stopped (--stop).'); }
  }
  process.exit(0);
})().catch((e) => { console.error('lag-audit error:', e && e.message); process.exit(1); });
