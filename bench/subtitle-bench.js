'use strict';
/*
 * Subtitle-track DETECTION benchmark: old truncated-sample probe (V0.17) vs new
 * direct-live-stream probe (current working tree).
 *
 * OLD (V0.17): download the first N MB of the stream to a local temp file via a
 *   Range request, then ffprobe THAT truncated file for subtitle streams. Per the
 *   comment at uplayer.js ~2018-2022, this "frequently failed to parse" because
 *   subtitle track headers can sit past the truncation point in an MKV.
 * NEW (working tree): ffprobe the LIVE TorrServer stream URL directly — reads
 *   just the header via HTTP range internally, no local download.
 *
 * Both run the same ffprobe subtitle-select command; only the target differs.
 *
 * USAGE:  node bench/subtitle-bench.js [bench/torrents.txt]
 * Results -> bench/subtitle-results.json and bench/subtitle-results.md
 */
const { spawn, execSync } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

const ffprobePath = require('ffprobe-static').path;

const TS_PORT = 8090;
const TS_EXE = path.join(__dirname, 'TorrServer-windows-amd64.exe');
const TS_DATA = path.join(__dirname, 'ts-data');
const RESULTS_JSON = path.join(__dirname, 'subtitle-results.json');
const RESULTS_MD = path.join(__dirname, 'subtitle-results.md');
const TMP_DIR = path.join(__dirname, 'sub-tmp');

const META_TIMEOUT_MS = 60000;
const OLD_SIZES_MB = [10, 50];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function startTorrServer() {
  killStrayTorrServer();
  await waitPortFree(TS_PORT, 10000);
  fs.mkdirSync(TS_DATA, { recursive: true });
  const proc = spawn(TS_EXE, ['--port', String(TS_PORT), '--path', TS_DATA, '--logpath', path.join(__dirname, 'sub-ts.log')], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 100; i++) { try { const e = await tsRequest('GET', '/echo', null, true); if (e && /Torr|MatriX/i.test(e)) { up = true; break; } } catch (_) {} await sleep(500); }
  if (!up) throw new Error('TorrServer did not start on :' + TS_PORT);
  return proc;
}

async function stopTorrServer(proc) {
  try { if (proc && proc.pid) execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
  killStrayTorrServer();
  await waitPortFree(TS_PORT, 8000);
}

async function addTorrent(link) {
  const add = await tsRequest('POST', '/torrents', { action: 'add', link, title: 'sub-bench', save_to_db: false });
  const hash = add.hash || add.Hash || '';
  if (!hash) throw new Error('no hash from add');
  const dl = Date.now() + META_TIMEOUT_MS;
  while (Date.now() < dl) {
    const info = await tsRequest('POST', '/torrents', { action: 'get', hash });
    const st = info.file_stats || info.FileStats || [];
    if (st.length) {
      const file = st.reduce((a, b) => ((b.length || b.Length) > (a.length || a.Length) ? b : a));
      const fileId = file.id != null ? file.id : file.Id;
      const fileName = path.basename(file.path || file.Path || 'video');
      return { hash, fileId, fileName, fileLen: file.length || file.Length };
    }
    await sleep(500);
  }
  throw new Error('metadata timeout');
}

async function removeTorrent(hash) { try { await tsRequest('POST', '/torrents', { action: 'rem', hash }); } catch (e) {} }

function streamUrl(hash, fileId, name) {
  return `http://127.0.0.1:${TS_PORT}/stream/${encodeURIComponent(name)}?link=${hash}&index=${fileId}&play`;
}

function runFfprobeSubtitles(target) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(ffprobePath, [
      '-v', 'error', '-select_streams', 's',
      '-show_entries', 'stream=index:stream_tags=language,title',
      '-of', 'json', target,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    // Generous cap: probing a live stream on a cold swarm waits for the header bytes to
    // download first (the app itself has no cap here). 30s proved too tight for 20GB+ files.
    const to = setTimeout(() => { try { p.kill(); } catch (e) {} resolve({ ok: false, error: 'ffprobe timeout', ms: Date.now() - t0, subs: 0 }); }, 180000);
    p.on('close', () => {
      clearTimeout(to);
      const ms = Date.now() - t0;
      try { const j = JSON.parse(out); resolve({ ok: true, ms, subs: (j.streams || []).length, streams: j.streams || [] }); }
      catch (e) { resolve({ ok: false, error: 'parse failed', ms, subs: 0 }); }
    });
    p.on('error', (e) => { clearTimeout(to); resolve({ ok: false, error: e.message, ms: Date.now() - t0, subs: 0 }); });
  });
}

function downloadRange(url, bytes, destPath) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: { Range: `bytes=0-${bytes - 1}` },
    }, (res) => {
      const ws = fs.createWriteStream(destPath);
      let received = 0;
      res.on('data', (c) => { received += c.length; if (received >= bytes) { try { res.destroy(); } catch (e) {} } });
      res.pipe(ws);
      res.on('close', () => { ws.end(); resolve(Date.now() - t0); });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function parseList(arg) {
  const p = arg || path.join(__dirname, 'torrents.txt');
  return fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('|'); return i > -1 ? { label: l.slice(0, i).trim(), link: l.slice(i + 1).trim() } : { label: l.slice(0, 40), link: l }; });
}

function loadResults() { try { return JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')); } catch (e) { return []; } }
function saveResults(all) { fs.writeFileSync(RESULTS_JSON, JSON.stringify(all, null, 2)); renderMd(all); }

function fmtNew(r) {
  if (!r || !r.ok) return `error: ${r ? r.error : 'n/a'}`;
  return `${(r.ms / 1000).toFixed(2)}s · ${r.subs} track(s)`;
}
function fmtOld(r) {
  if (!r || !r.ok) return `error: ${r ? r.error : 'n/a'}`;
  return `${(r.downloadMs / 1000).toFixed(2)}s dl + ${(r.probeMs / 1000).toFixed(2)}s probe = ${((r.downloadMs + r.probeMs) / 1000).toFixed(2)}s · ${r.subs} track(s)`;
}

function renderMd(all) {
  let md = '# Subtitle detection benchmark — old truncated-sample probe vs new live-stream probe\n\n';
  md += 'OLD (V0.17): download first N MB of the stream to a temp file, then ffprobe the truncated local file.\n';
  md += 'NEW (this version): ffprobe the live TorrServer stream URL directly, no download.\n\n';
  md += 'Both run the identical `ffprobe -select_streams s ...` command; only the target (live URL vs truncated local file) differs.\n\n';
  md += '| torrent | NEW (live probe) | OLD 10MB sample | OLD 50MB sample |\n|---|---|---|---|\n';
  for (const e of all) {
    md += `| ${e.label} | ${fmtNew(e.new)} | ${fmtOld(e.old10)} | ${fmtOld(e.old50)} |\n`;
  }
  md += '\n## Reliability\n\n';
  for (const e of all) {
    const newSubs = e.new && e.new.ok ? e.new.subs : null;
    const old10Subs = e.old10 && e.old10.ok ? e.old10.subs : null;
    const old50Subs = e.old50 && e.old50.ok ? e.old50.subs : null;
    if (newSubs == null) { md += `- **${e.label}**: NEW probe failed/errored — no baseline to compare.\n`; continue; }
    const missed10 = old10Subs != null && old10Subs < newSubs;
    const missed50 = old50Subs != null && old50Subs < newSubs;
    if (newSubs === 0) {
      md += `- **${e.label}**: no embedded subtitle tracks in this file (NEW found 0; OLD-10MB found ${old10Subs}, OLD-50MB found ${old50Subs}).\n`;
    } else if (missed10 || missed50) {
      md += `- **${e.label}**: NEW found ${newSubs} track(s); OLD-10MB found ${old10Subs}, OLD-50MB found ${old50Subs} — ${missed10 ? 'OLD-10MB MISSED tracks' : 'OLD-10MB matched'}${missed50 ? ', OLD-50MB also MISSED tracks' : ', OLD-50MB matched'}. Confirms the reliability gap described in the code comments.\n`;
    } else {
      md += `- **${e.label}**: all three approaches found the same ${newSubs} track(s) — this file's subtitle headers happened to sit within the truncation window.\n`;
    }
  }
  fs.writeFileSync(RESULTS_MD, md);
}

(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const items = parseList(process.argv[2]);
  console.log(`Subtitle-detection benchmark: ${items.length} torrent(s).\n`);
  const proc = await startTorrServer();
  console.log('TorrServer up.\n');

  const results = [];
  for (let n = 0; n < items.length; n++) {
    const { label, link } = items[n];
    console.log(`[${n + 1}/${items.length}] ${label}`);
    let hash = null;
    const entry = { label, link: link.slice(0, 80) };
    try {
      const t = await addTorrent(link);
      hash = t.hash;
      const url = streamUrl(t.hash, t.fileId, t.fileName);
      console.log(`  resolved: ${t.fileName} (${(t.fileLen / 1048576).toFixed(0)} MB)`);

      process.stdout.write('  NEW (live probe) ... ');
      entry.new = await runFfprobeSubtitles(url);
      console.log(entry.new.ok ? `${(entry.new.ms / 1000).toFixed(2)}s, ${entry.new.subs} track(s)` : 'ERROR ' + entry.new.error);

      for (const mb of OLD_SIZES_MB) {
        const key = 'old' + mb;
        process.stdout.write(`  OLD ${mb}MB sample ... `);
        const tmpFile = path.join(TMP_DIR, `sample_${mb}mb_${Date.now()}.tmp`);
        try {
          const downloadMs = await downloadRange(url, mb * 1024 * 1024, tmpFile);
          const probeResult = await runFfprobeSubtitles(tmpFile);
          entry[key] = { ok: probeResult.ok, downloadMs, probeMs: probeResult.ms, subs: probeResult.subs, error: probeResult.error };
          console.log(entry[key].ok ? `${(downloadMs / 1000).toFixed(2)}s dl + ${(probeResult.ms / 1000).toFixed(2)}s probe, ${probeResult.subs} track(s)` : 'ERROR ' + entry[key].error);
        } catch (e) {
          entry[key] = { ok: false, error: e.message };
          console.log('ERROR ' + e.message);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (e) {}
        }
      }
    } catch (e) {
      console.log('  ERROR ' + e.message);
      entry.error = e.message;
    } finally {
      if (hash) await removeTorrent(hash);
    }
    results.push(entry);
    saveResults(results);
    console.log('  saved -> bench/subtitle-results.md\n');
  }

  await stopTorrServer(proc);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('Done. See bench/subtitle-results.md');
  process.exit(0);
})().catch(async (e) => {
  console.error('FATAL', e);
  killStrayTorrServer();
  process.exit(1);
});
