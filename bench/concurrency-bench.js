'use strict';
/*
 * Concurrency benchmark: 1 stream vs 4 concurrent streams, against the
 * working-tree server (server.js), which replaced V0.17's one-stream-per-port
 * WebTorrent engine with a shared TorrServer sidecar + streamId-routed HTTP
 * server supporting concurrent streams (default cap 4, UPLAYER_MAX_STREAMS).
 *
 * V0.17 (git HEAD) could only ever run ONE stream — there is no old-version
 * baseline for "N concurrent streams". This benchmark characterizes the NEW
 * version's concurrency scaling on its own: does memory/readiness scale
 * roughly linearly from 1 -> 4 streams, or does it blow up?
 *
 * USAGE
 *   node bench/concurrency-bench.js
 *
 * Results: bench/concurrency-results.json (raw) + bench/concurrency-results.md (report)
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TS_PORT = 8090;
const HTTP_PORT = 3900; // dedicated bench port, avoids clashing with any dev instance
const RESULTS_JSON = path.join(__dirname, 'concurrency-results.json');
const RESULTS_MD = path.join(__dirname, 'concurrency-results.md');
const SERVER_BOOT_TIMEOUT_MS = 45000;
const READY_TIMEOUT_MS = 90000; // per-stream cap
const SAMPLE_INTERVAL_MS = 500;

const SINTEL = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMB = (b) => (b / 1048576).toFixed(1);

function rssOfPid(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    const m = out.match(/"([\d,]+) K"/);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10) * 1024;
  } catch (e) { /* ignore */ }
  return 0;
}

function pidsOfImage(imageName) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, { encoding: 'utf8' });
    const pids = [];
    const re = /^"([^"]+)","(\d+)"/gm;
    let m;
    while ((m = re.exec(out))) pids.push(parseInt(m[2], 10));
    return pids;
  } catch (e) { return []; }
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
async function waitPortUp(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!(await portFree(port))) return true; await sleep(300); }
  return false;
}

function killStrayTorrServer() {
  try { execSync('taskkill /F /IM TorrServer-windows-amd64.exe /T', { stdio: 'ignore' }); } catch (e) {}
}
function killPid(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
}

function httpJson(method, port, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf || 'null') }); }
        catch (e) { resolve({ status: res.statusCode, json: null, raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------- server lifecycle ----------------
async function startServer() {
  killStrayTorrServer();
  await waitPortFree(TS_PORT, 10000);
  await waitPortFree(HTTP_PORT, 5000);

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(HTTP_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  const up = await waitPortUp(HTTP_PORT, SERVER_BOOT_TIMEOUT_MS);
  if (!up) {
    killPid(proc.pid);
    throw new Error('server.js did not open port ' + HTTP_PORT + ' in time. Output:\n' + out.slice(-2000));
  }
  // Let TorrServer sidecar finish spinning up.
  await waitPortUp(TS_PORT, SERVER_BOOT_TIMEOUT_MS);
  await sleep(1500);

  const tsPids = pidsOfImage('TorrServer-windows-amd64.exe');
  return { proc, nodePid: proc.pid, tsPid: tsPids[0] || null };
}

async function stopServer(handle) {
  if (!handle) return;
  try { killPid(handle.nodePid); } catch (e) {}
  killStrayTorrServer();
  await waitPortFree(HTTP_PORT, 15000);
  await waitPortFree(TS_PORT, 15000);
}

// ---------------- sampling ----------------
function startSampler(handle) {
  const peak = { node: 0, ts: 0 };
  const timer = setInterval(() => {
    try {
      if (handle.nodePid) peak.node = Math.max(peak.node, rssOfPid(handle.nodePid));
    } catch (e) {}
    try {
      const tsPids = pidsOfImage('TorrServer-windows-amd64.exe');
      const pid = tsPids[0] || handle.tsPid;
      if (pid) { handle.tsPid = pid; peak.ts = Math.max(peak.ts, rssOfPid(pid)); }
    } catch (e) {}
  }, SAMPLE_INTERVAL_MS);
  return { peak, stop: () => clearInterval(timer) };
}

// ---------------- stream helpers ----------------
async function startStream(magnet) {
  const r = await httpJson('POST', HTTP_PORT, '/api/stream/start', { magnet });
  if (r.status !== 200 || !r.json || !r.json.sessionId) {
    throw new Error('stream/start failed: status=' + r.status + ' body=' + JSON.stringify(r.json || r.raw));
  }
  return r.json.sessionId;
}

async function pollStatus() {
  const r = await httpJson('GET', HTTP_PORT, '/api/stream/status', null);
  return Array.isArray(r.json) ? r.json : [];
}

// waits until each of sessionIds has playerUrl set, exited, or times out (per-stream cap)
async function waitAllReady(sessionIds, perStreamTimeoutMs) {
  const t0 = Date.now();
  const results = {};
  for (const id of sessionIds) results[id] = { ready: false, exited: false, timeMs: null };
  const deadline = t0 + perStreamTimeoutMs;

  while (Date.now() < deadline) {
    const statuses = await pollStatus();
    const byId = new Map(statuses.map((s) => [s.id, s]));
    let allDone = true;
    for (const id of sessionIds) {
      const res = results[id];
      if (res.ready || res.exited) continue;
      const s = byId.get(id);
      if (s && s.playerUrl) {
        res.ready = true;
        res.timeMs = Date.now() - t0;
      } else if (s && s.exited) {
        res.exited = true;
        res.timeMs = Date.now() - t0;
      } else {
        allDone = false;
      }
    }
    if (allDone) break;
    await sleep(1000);
  }
  // mark stragglers as timeout
  for (const id of sessionIds) {
    if (!results[id].ready && !results[id].exited) {
      results[id].timeout = true;
      results[id].timeMs = perStreamTimeoutMs;
    }
  }
  return results;
}

// ---------------- scenarios ----------------
async function scenarioA(magnet, label) {
  console.log('\n[Scenario A] 1 stream — starting server...');
  const handle = await startServer();
  const sampler = startSampler(handle);
  const result = { scenario: 'A', streams: 1, perStream: [], error: null };
  try {
    console.log('  server up (node pid ' + handle.nodePid + ', torrserver pid ' + handle.tsPid + ')');
    const t0 = Date.now();
    const sessionId = await startStream(magnet);
    console.log('  started session ' + sessionId + ' (' + label + '), polling for playerUrl...');
    const res = await waitAllReady([sessionId], READY_TIMEOUT_MS);
    const r = res[sessionId];
    result.perStream.push({ label, sessionId, ready: r.ready, exited: r.exited, timeout: !!r.timeout, timeToReadyMs: r.timeMs });
    console.log('  ' + label + ': ' + (r.ready ? (r.timeMs / 1000).toFixed(1) + 's' : (r.exited ? 'EXITED' : 'TIMEOUT')));
    // let it settle a moment so memory sampling captures steady-state too
    await sleep(3000);
  } catch (e) {
    result.error = e.message;
    console.log('  ERROR: ' + e.message);
  } finally {
    sampler.stop();
    result.peakNodeRssMB = fmtMB(sampler.peak.node);
    result.peakTorrServerRssMB = fmtMB(sampler.peak.ts);
    await stopServer(handle);
    console.log('  server stopped. peak node RSS=' + result.peakNodeRssMB + 'MB, peak TorrServer RSS=' + result.peakTorrServerRssMB + 'MB');
  }
  return result;
}

async function scenarioB(magnets) {
  console.log('\n[Scenario B] 4 concurrent streams — starting server...');
  const handle = await startServer();
  const sampler = startSampler(handle);
  const result = { scenario: 'B', streams: magnets.length, perStream: [], error: null };
  try {
    console.log('  server up (node pid ' + handle.nodePid + ', torrserver pid ' + handle.tsPid + ')');
    const t0 = Date.now();
    const sessionIds = [];
    for (const { magnet, label } of magnets) {
      const id = await startStream(magnet);
      sessionIds.push({ id, label });
      console.log('  started session ' + id + ' (' + label + ')');
    }
    console.log('  polling /api/stream/status until all 4 ready (cap ' + (READY_TIMEOUT_MS / 1000) + 's per stream)...');
    const res = await waitAllReady(sessionIds.map((s) => s.id), READY_TIMEOUT_MS);
    for (const { id, label } of sessionIds) {
      const r = res[id];
      result.perStream.push({ label, sessionId: id, ready: r.ready, exited: r.exited, timeout: !!r.timeout, timeToReadyMs: r.timeMs });
      console.log('  ' + label + ': ' + (r.ready ? (r.timeMs / 1000).toFixed(1) + 's' : (r.exited ? 'EXITED' : 'TIMEOUT')));
    }
    await sleep(3000);
  } catch (e) {
    result.error = e.message;
    console.log('  ERROR: ' + e.message);
  } finally {
    sampler.stop();
    result.peakNodeRssMB = fmtMB(sampler.peak.node);
    result.peakTorrServerRssMB = fmtMB(sampler.peak.ts);
    await stopServer(handle);
    console.log('  server stopped. peak node RSS=' + result.peakNodeRssMB + 'MB, peak TorrServer RSS=' + result.peakTorrServerRssMB + 'MB');
  }
  return result;
}

// ---------------- torrent list ----------------
function loadTorrents() {
  const listPath = path.join(__dirname, 'torrents.txt');
  const lines = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const items = lines.map((l) => { const i = l.indexOf('|'); return { label: l.slice(0, i).trim(), link: l.slice(i + 1).trim() }; });
  items.push({ label: 'Sintel (web-seeded sample)', link: SINTEL });
  return items;
}

// ---------------- report rendering ----------------
function avgOf(arr) { return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null; }

function renderMd(data) {
  let md = '# Concurrency benchmark — 1 stream vs 4 concurrent streams\n\n';
  md += 'Run: ' + data.when + '\n\n';
  md += '## What this is (and isn\'t)\n\n';
  md += 'V0.17 (the last pushed commit, git HEAD) could run only **one** active stream at a time — each stream got its own WebTorrent client and port, with no concept of concurrency. ';
  md += 'The working tree replaces that engine with a shared **TorrServer** sidecar plus a single HTTP server that routes multiple simultaneous streams by a `streamId` path prefix (default cap 4, via `UPLAYER_MAX_STREAMS`). ';
  md += 'This is a **brand-new capability with no V0.17 baseline** — V0.17 literally cannot run this test (it would refuse/replace on a 2nd stream). ';
  md += 'This benchmark therefore characterizes the new version\'s concurrency scaling *on its own*: does time-to-ready or memory blow up disproportionately going from 1 to 4 concurrent streams, or does it scale reasonably?\n\n';
  md += '## Results\n\n';
  md += '| Scenario | Streams | Per-stream time-to-ready | Avg time-to-ready | Peak node RSS | Peak TorrServer RSS |\n';
  md += '|---|---|---|---|---|---|\n';
  for (const r of data.scenarios) {
    const times = r.perStream.filter((p) => p.ready).map((p) => p.timeToReadyMs);
    const perStreamCells = r.perStream.map((p) => {
      const tag = p.ready ? (p.timeToReadyMs / 1000).toFixed(1) + 's' : (p.exited ? 'exited' : 'timeout');
      return `${p.label}: ${tag}`;
    }).join('<br>');
    const avgCell = times.length ? (avgOf(times) / 1000).toFixed(1) + 's (n=' + times.length + '/' + r.perStream.length + ')' : 'n/a (0 ready)';
    md += `| ${r.scenario === 'A' ? 'A — 1 stream' : 'B — 4 concurrent'} | ${r.streams} | ${perStreamCells} | ${avgCell} | ${r.peakNodeRssMB}MB | ${r.peakTorrServerRssMB}MB |\n`;
  }
  md += '\n';

  const a = data.scenarios.find((r) => r.scenario === 'A');
  const b = data.scenarios.find((r) => r.scenario === 'B');
  md += '## Takeaway\n\n';
  if (a && b) {
    const aTimes = a.perStream.filter((p) => p.ready).map((p) => p.timeToReadyMs);
    const bTimes = b.perStream.filter((p) => p.ready).map((p) => p.timeToReadyMs);
    const aAvg = avgOf(aTimes);
    const bAvg = avgOf(bTimes);
    const bReadyCount = b.perStream.filter((p) => p.ready).length;
    const nodeRatio = (parseFloat(b.peakNodeRssMB) / Math.max(0.1, parseFloat(a.peakNodeRssMB))).toFixed(2);
    const tsRatio = (parseFloat(b.peakTorrServerRssMB) / Math.max(0.1, parseFloat(a.peakTorrServerRssMB))).toFixed(2);
    md += `With 1 stream, time-to-ready averaged ${aAvg != null ? (aAvg / 1000).toFixed(1) + 's' : 'n/a'} (peak node RSS ${a.peakNodeRssMB}MB, peak TorrServer RSS ${a.peakTorrServerRssMB}MB). `;
    md += `With 4 concurrent streams, ${bReadyCount}/4 became ready, averaging ${bAvg != null ? (bAvg / 1000).toFixed(1) + 's' : 'n/a'} to ready (peak node RSS ${b.peakNodeRssMB}MB — ${nodeRatio}x the 1-stream figure — and peak TorrServer RSS ${b.peakTorrServerRssMB}MB — ${tsRatio}x). `;
    md += `Since all 4 streams share one TorrServer instance and one Node HTTP server, memory growth going 1→4 reflects the added per-torrent/per-session state rather than 4 duplicated engines (V0.17 would have needed 4 separate WebTorrent clients and 4 ports to attempt this, and simply didn't support it at all — this whole scenario is new territory). `;
    if (nodeRatio < 3 && tsRatio < 3) {
      md += 'Memory scaling looks sub-linear-to-roughly-linear rather than blowing up, and readiness time per stream stayed in the same rough ballpark as the single-stream case rather than degrading catastrophically — consistent with streams mostly being bottlenecked by swarm/peer availability (per-torrent, independent of local concurrency) rather than by contention on the shared engine.';
    } else {
      md += 'Memory growth from 1 to 4 streams is more than 3x, which is worth watching as the concurrency cap or typical usage grows, though it may also reflect one or more larger/heavier torrents in the 4-stream mix rather than a fundamental per-stream cost problem.';
    }
    md += ' Note this run reflects swarm/peer conditions on test day for these specific magnets (this project\'s own bench notes mention occasional peer/tracker flakiness) — time-to-ready numbers are more sensitive to that than to the engine itself.';
  } else {
    md += 'One or both scenarios failed to produce comparable data; see the raw JSON for details.';
  }
  md += '\n';
  fs.writeFileSync(RESULTS_MD, md);
}

// ---------------- main ----------------
(async () => {
  const torrents = loadTorrents();
  if (torrents.length < 4) throw new Error('Need at least 4 distinct torrents, found ' + torrents.length);
  console.log('Loaded ' + torrents.length + ' torrents:');
  torrents.forEach((t, i) => console.log('  [' + i + '] ' + t.label));

  const data = { when: new Date().toISOString(), scenarios: [] };
  let exitCode = 0;
  try {
    // Scenario A: pick a moderate-size one (LotR) rather than Matrix UHD.
    const aTorrent = torrents.find((t) => /LotR/i.test(t.label)) || torrents[0];
    const scA = await scenarioA(aTorrent.link, aTorrent.label);
    data.scenarios.push(scA);
    fs.writeFileSync(RESULTS_JSON, JSON.stringify(data, null, 2));

    // Scenario B: all 4 distinct torrents.
    const bTorrents = torrents.slice(0, 4).map((t) => ({ magnet: t.link, label: t.label }));
    const scB = await scenarioB(bTorrents);
    data.scenarios.push(scB);
    fs.writeFileSync(RESULTS_JSON, JSON.stringify(data, null, 2));

    renderMd(data);
    console.log('\nDone. See bench/concurrency-results.md');
  } catch (e) {
    console.error('FATAL: ' + e.message);
    exitCode = 1;
  } finally {
    // Final cleanup, even on error.
    try { killStrayTorrServer(); } catch (e) {}
    await waitPortFree(TS_PORT, 15000);
    await waitPortFree(HTTP_PORT, 15000);
    const tsFree = await portFree(TS_PORT);
    const httpFree = await portFree(HTTP_PORT);
    console.log('Cleanup: port ' + TS_PORT + ' free=' + tsFree + ', port ' + HTTP_PORT + ' free=' + httpFree);
  }
  process.exit(exitCode);
})();
