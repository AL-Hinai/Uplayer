'use strict';
/*
 * Engine benchmark: WebTorrent (current) vs TorrServer (candidate).
 * For each torrent + engine, measures:
 *   - time-to-first-byte (TTFB) of the largest file  ~ time-to-first-frame
 *   - sustained DOWNLOAD speed (MB/s) = the engine's own reported network rate,
 *     averaged over a window. (NOT bytes-read-from-stream, which WebTorrent
 *     pollutes by pre-buffering hundreds of MB then draining at memory speed.)
 *   - peak process memory (RSS)
 *
 * USAGE
 *   node bench/engine-bench.js "magnet:?xt=..."     (single, or an http .torrent URL)
 *   node bench/engine-bench.js bench/torrents.txt   (list — "Label | link" per line)
 *   node bench/engine-bench.js                      (Sintel sample)
 *
 * Results append to bench/results.json and render to bench/results.md.
 * WebTorrent RSS includes the Node baseline (peak +growth shown); TorrServer RSS
 * is the external Go process. Engines run sequentially (no shared bandwidth).
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';

// --- tunables ---
const WINDOW_MS = 30000;             // download-speed sampling window (after first byte)
const FIRST_BYTE_MS = 60000;         // give up if no first byte within this
const META_TIMEOUT_MS = 60000;       // give up if metadata/files not resolved within this
const SAFETY_BYTES = 600 * 1024 * 1024; // discard-reader hard ceiling (keeps download active)
const TS_PORT = 8090;
const TS_EXE = path.join(__dirname, 'TorrServer-windows-amd64.exe');
const TS_DATA = path.join(__dirname, 'ts-data');
const WT_CACHE = path.join(__dirname, 'wt-cache');
const RESULTS_JSON = path.join(__dirname, 'results.json');
const RESULTS_MD = path.join(__dirname, 'results.md');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMB = (b) => (b / 1048576).toFixed(1);
const toMbps = (bps) => (bps / 1048576).toFixed(2);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function rssOfPid(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    const m = out.match(/"([\d,]+) K"/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) * 1024;
  } catch (e) { /* ignore */ }
  return 0;
}
function portFree(port) {
  return new Promise((res) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); res(false); });
    s.on('error', () => res(true));
    setTimeout(() => { try { s.destroy(); } catch (e) {} res(true); }, 400);
  });
}
async function waitPortFree(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await portFree(port)) return true; await sleep(300); }
  return false;
}
function killStrayTorrServer() { try { execSync('taskkill /F /IM TorrServer-windows-amd64.exe /T', { stdio: 'ignore' }); } catch (e) {} }

// ---------------- WebTorrent ----------------
async function benchWebTorrent(link) {
  const WebTorrent = require('webtorrent');
  const client = new WebTorrent();
  const baseRss = process.memoryUsage().rss;
  let peakRss = baseRss;
  const memTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 400);
  const t0 = Date.now();
  let stream = null;
  try {
    const torrent = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('metadata timeout')), META_TIMEOUT_MS);
      client.add(link, { path: WT_CACHE }, (t) => { clearTimeout(to); resolve(t); });
    });
    const file = torrent.files.reduce((a, b) => (b.length > a.length ? b : a));
    torrent.files.forEach((f) => { if (f !== file) f.deselect(); });
    file.select();

    let ttfb = null, readBytes = 0;
    stream = file.createReadStream({ start: 0 });
    stream.on('data', (c) => { if (ttfb === null) ttfb = Date.now() - t0; readBytes += c.length; if (readBytes >= SAFETY_BYTES) { try { stream.destroy(); } catch (e) {} } });
    stream.on('error', () => {});

    const fbEnd = Date.now() + FIRST_BYTE_MS;
    while (ttfb === null && Date.now() < fbEnd) await sleep(200);
    if (ttfb === null) return { error: 'no data (first-byte timeout)' };

    const speeds = [];
    const winEnd = Date.now() + WINDOW_MS;
    while (Date.now() < winEnd) { speeds.push(torrent.downloadSpeed || 0); await sleep(1000); }

    return { file: file.name, fileLen: file.length, ttfbMs: ttfb, mbps: toMbps(avg(speeds)),
      peers: torrent.numPeers, peakRssMB: fmtMB(peakRss), growthMB: fmtMB(peakRss - baseRss),
      note: 'avg dl-speed over ' + (WINDOW_MS / 1000) + 's' };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearInterval(memTimer);
    try { if (stream) stream.destroy(); } catch (e) {}
    await new Promise((res) => client.destroy(() => res()));
  }
}

// ---------------- TorrServer ----------------
function tsRequest(method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: TS_PORT, path: p, method, headers }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { if (raw) return resolve(buf); try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve(buf); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const tsSpeed = (info) => info.download_speed || info.DownloadSpeed || info.downloadSpeed || 0;

async function benchTorrServer(link) {
  killStrayTorrServer();
  await waitPortFree(TS_PORT, 10000);
  fs.mkdirSync(TS_DATA, { recursive: true });
  const proc = spawn(TS_EXE, ['--port', String(TS_PORT), '--path', TS_DATA, '--logpath', path.join(__dirname, 'ts.log')], { stdio: 'ignore' });
  let peakRss = 0;
  const memTimer = setInterval(() => { peakRss = Math.max(peakRss, rssOfPid(proc.pid)); }, 400);
  let hash = '', streamReq = null;
  try {
    let up = false;
    for (let i = 0; i < 100; i++) { try { const e = await tsRequest('GET', '/echo', null, true); if (e && /Torr|MatriX/i.test(e)) { up = true; break; } } catch (_) {} await sleep(500); }
    if (!up) return { error: 'TorrServer did not start on :' + TS_PORT };

    const t0 = Date.now();
    const add = await tsRequest('POST', '/torrents', { action: 'add', link, title: 'bench', save_to_db: false });
    hash = add.hash || add.Hash || '';
    if (!hash) return { error: 'no hash from add' };

    let file = null;
    const dl = Date.now() + META_TIMEOUT_MS;
    while (Date.now() < dl) {
      const info = await tsRequest('POST', '/torrents', { action: 'get', hash });
      const st = info.file_stats || info.FileStats || [];
      if (st.length) { file = st.reduce((a, b) => ((b.length || b.Length) > (a.length || a.Length) ? b : a)); break; }
      await sleep(500);
    }
    if (!file) return { error: 'no files resolved (metadata timeout)' };
    const fileId = file.id != null ? file.id : file.Id;
    const fileName = path.basename(file.path || file.Path || 'video');

    let ttfb = null, readBytes = 0;
    const p = `/stream/${encodeURIComponent(fileName)}?link=${hash}&index=${fileId}&play`;
    streamReq = http.request({ host: '127.0.0.1', port: TS_PORT, path: p, method: 'GET', headers: { Range: 'bytes=0-' } }, (r) => {
      r.on('data', (c) => { if (ttfb === null) ttfb = Date.now() - t0; readBytes += c.length; if (readBytes >= SAFETY_BYTES) { try { r.destroy(); } catch (e) {} } });
      r.on('error', () => {});
    });
    streamReq.on('error', () => {});
    streamReq.end();

    const fbEnd = Date.now() + FIRST_BYTE_MS;
    while (ttfb === null && Date.now() < fbEnd) await sleep(200);
    if (ttfb === null) return { error: 'no data (first-byte timeout)' };

    const speeds = [];
    const winEnd = Date.now() + WINDOW_MS;
    let peers = 0;
    while (Date.now() < winEnd) {
      try { const info = await tsRequest('POST', '/torrents', { action: 'get', hash }); speeds.push(tsSpeed(info)); peers = info.active_peers || info.connected_seeders || peers; } catch (e) { speeds.push(0); }
      await sleep(1000);
    }
    return { file: fileName, fileLen: file.length || file.Length, ttfbMs: ttfb, mbps: toMbps(avg(speeds)),
      peers, peakRssMB: fmtMB(peakRss), note: 'avg dl-speed over ' + (WINDOW_MS / 1000) + 's' };
  } catch (e) {
    return { error: e.message };
  } finally {
    clearInterval(memTimer);
    try { if (streamReq) streamReq.destroy(); } catch (e) {}
    try { if (hash) await tsRequest('POST', '/torrents', { action: 'rem', hash }); } catch (e) {}
    try { execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    killStrayTorrServer();
    await waitPortFree(TS_PORT, 8000);
  }
}

// ---------------- results persistence ----------------
function loadResults() { try { return JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')); } catch (e) { return []; } }
function engCell(r) {
  if (!r || r.error) return `error: ${r ? r.error : 'n/a'}`;
  const ttfb = r.ttfbMs != null ? (r.ttfbMs / 1000).toFixed(1) + 's' : 'n/a';
  const peers = r.peers != null ? ` · ${r.peers}p` : '';
  return `${ttfb} · ${r.mbps} MB/s${peers} · ${r.peakRssMB}MB${r.growthMB ? ' (+' + r.growthMB + ')' : ''}`;
}
function renderMd(all) {
  let md = '# Engine benchmark results — WebTorrent vs TorrServer\n\n';
  md += 'Per engine: **TTFB · avg download speed · peers · peak RSS**. WebTorrent RSS = peak (+growth over Node baseline); TorrServer = Go process. ';
  md += 'Throughput = engine-reported download rate averaged over ' + (WINDOW_MS / 1000) + 's (immune to read-buffer artifacts).\n\n';
  md += '| when | torrent | WebTorrent | TorrServer |\n|---|---|---|---|\n';
  for (const e of all) md += `| ${e.when} | ${e.label} | ${engCell(e.webtorrent)} | ${engCell(e.torrserver)} |\n`;
  fs.writeFileSync(RESULTS_MD, md);
}
function saveResult(entry) { const all = loadResults(); all.push(entry); fs.writeFileSync(RESULTS_JSON, JSON.stringify(all, null, 2)); renderMd(all); }

// ---------------- list parsing ----------------
function parseList(arg) {
  if (arg && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    return fs.readFileSync(arg, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => { const i = l.indexOf('|'); return i > -1 ? { label: l.slice(0, i).trim(), link: l.slice(i + 1).trim() } : { label: l.slice(0, 40), link: l }; });
  }
  const link = arg || SINTEL;
  return [{ label: arg ? link.slice(0, 40) : 'Sintel (web-seeded sample)', link }];
}

(async () => {
  const items = parseList(process.argv[2]);
  console.log(`Benchmarking ${items.length} torrent(s). Window ${WINDOW_MS / 1000}s.\n`);
  for (let n = 0; n < items.length; n++) {
    const { label, link } = items[n];
    console.log(`[${n + 1}/${items.length}] ${label}`);
    process.stdout.write('  WebTorrent ... ');
    const wt = await benchWebTorrent(link);
    console.log(wt.error ? 'ERROR ' + wt.error : `${(wt.ttfbMs / 1000).toFixed(1)}s, ${wt.mbps} MB/s, ${wt.peakRssMB}MB`);
    process.stdout.write('  TorrServer ... ');
    const ts = await benchTorrServer(link);
    console.log(ts.error ? 'ERROR ' + ts.error : `${(ts.ttfbMs / 1000).toFixed(1)}s, ${ts.mbps} MB/s, ${ts.peakRssMB}MB`);
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    saveResult({ when, label, link: link.slice(0, 80), webtorrent: wt, torrserver: ts });
    console.log('  saved -> bench/results.md\n');
  }
  console.log('Done. See bench/results.md');
  process.exit(0);
})();
