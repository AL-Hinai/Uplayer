#!/usr/bin/env node
'use strict';

// Cast diagnostic CLI.
//
// Hits Uplayer's /api/stream/status to find the active stream's cast URL, then
// validates the HLS manifest + first segment using ffprobe, and optionally
// invokes `catt` (https://github.com/skorokithakis/catt) to load it on a real
// Chromecast and report the receiver state.
//
// Usage:
//   node tools/cast-diagnose.js [--server <url>] [--device <name>] [--watch <secs>] [--manifest <url>] [--no-color]

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawnSync } = require('child_process');

const COLORS = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m',
};

let useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function color(c, s) { return useColor ? COLORS[c] + s + COLORS.reset : s; }

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error(`invalid URL: ${url}`)); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: options.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'uplayer-cast-diagnose/1' }, options.headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function findActiveSession(webServerUrl) {
  const res = await fetchUrl(`${webServerUrl.replace(/\/$/, '')}/api/stream/status`);
  if (res.status !== 200) throw new Error(`status API returned HTTP ${res.status}`);
  const sessions = JSON.parse(res.body.toString());
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  return sessions.find((s) => s.running && s.castUrl) || sessions.find((s) => s.castUrl) || sessions[0];
}

function findFfprobePath() {
  try { return require('ffprobe-static').path; } catch (e) { /* not bundled */ }
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffprobe'], { stdio: 'pipe', encoding: 'utf8' });
  if (r.status === 0 && r.stdout) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function probeUrl(ffprobePath, url) {
  const r = spawnSync(ffprobePath, [
    '-hide_banner', '-v', 'error',
    '-show_streams', '-show_format', '-of', 'json',
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return {
    code: typeof r.status === 'number' ? r.status : -1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    parsed: (r.status === 0 && r.stdout) ? safeJson(r.stdout) : null,
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function findCattPath() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['catt'], { stdio: 'pipe', encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function runCatt(cattBin, args, timeoutMs) {
  return spawnSync(cattBin, args, { stdio: 'pipe', encoding: 'utf8', timeout: timeoutMs || 60000 });
}

function parseArgs(argv) {
  const opts = { server: 'http://localhost:3000', device: null, watchSeconds: 0, manifest: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--server' || arg === '-s') opts.server = argv[++i];
    else if (arg === '--device' || arg === '-d') opts.device = argv[++i];
    else if (arg === '--watch' || arg === '-w') opts.watchSeconds = parseInt(argv[++i], 10) || 30;
    else if (arg === '--manifest' || arg === '-m') opts.manifest = argv[++i];
    else if (arg === '--no-color') useColor = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`Uplayer cast diagnostic

Usage:
  node tools/cast-diagnose.js [options]

Options:
  --server <url>       Uplayer web server URL (default http://localhost:3000)
  --device <name>      Chromecast friendly name; requires \`catt\` in PATH
  --watch <secs>       Poll receiver status for N seconds after LoadRequest
  --manifest <url>     Skip auto-discovery; diagnose this URL directly
  --no-color           Disable ANSI colors
  -h, --help           Show this help

Examples:
  node tools/cast-diagnose.js
  node tools/cast-diagnose.js --device "Living Room TV" --watch 20
  node tools/cast-diagnose.js --manifest http://192.168.1.50:8000/hls/index.m3u8
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return 0; }

  const report = [];
  const ok = (msg) => { report.push({ level: 'ok', msg }); console.log(color('green', '✓ ') + msg); };
  const warn = (msg) => { report.push({ level: 'warn', msg }); console.log(color('yellow', '⚠ ') + msg); };
  const fail = (msg) => { report.push({ level: 'fail', msg }); console.log(color('red', '✗ ') + msg); };
  const info = (msg) => console.log(color('dim', '  ' + msg));

  console.log(color('bold', '── Uplayer Cast Diagnostic ──'));

  // 1. Discover manifest URL.
  let manifestUrl = opts.manifest;
  let sessionMeta = null;
  if (!manifestUrl) {
    try {
      sessionMeta = await findActiveSession(opts.server);
      if (!sessionMeta) { fail(`No active stream at ${opts.server}. Start one and retry.`); return 1; }
      if (!sessionMeta.castUrl) { fail('Active session has no castUrl — stream is still booting.'); return 1; }
      manifestUrl = sessionMeta.castUrl;
      ok(`Found active session: ${sessionMeta.id}`);
      info(`castUrl: ${manifestUrl}`);
      if (sessionMeta.videoFormat) {
        const vf = sessionMeta.videoFormat;
        info(`Strategy: ${vf.playbackStrategy || 'unknown'} (vcodec=${vf.codec || '?'}, acodec=${vf.acodec || '?'}, container=${vf.container || '?'})`);
      }
    } catch (e) {
      fail(`Uplayer web server at ${opts.server} not reachable: ${e.message}`);
      return 1;
    }
  } else {
    ok(`Using manual manifest URL`);
    info(manifestUrl);
  }

  const isHls = /\.m3u8(\?|$)/i.test(manifestUrl);

  // 2. Manifest reachable from this host (proxy for "reachable from Chromecast").
  let manifestText = '';
  try {
    const res = await fetchUrl(manifestUrl, { timeout: 8000 });
    if (res.status !== 200) { fail(`Manifest HTTP ${res.status}`); return 1; }
    manifestText = res.body.toString();
    ok(`Manifest reachable (${res.body.length} bytes, HTTP 200)`);
    const ctype = String(res.headers['content-type'] || '').toLowerCase();
    info(`Content-Type: ${ctype || '(none)'}`);
    if (isHls && !/mpegurl/.test(ctype)) {
      warn(`HLS manifest should be served with Content-Type application/vnd.apple.mpegurl`);
    }
    if (/localhost|127\.0\.0\.1/.test(manifestUrl)) {
      warn(`URL contains "localhost" — your Chromecast TV cannot reach this. Use the LAN IP castUrl from /api/stream/status instead.`);
    }
  } catch (e) {
    fail(`Cannot fetch manifest: ${e.message}`);
    return 1;
  }

  // 3. Manifest structural check + first segment URL.
  let firstSegmentUrl = null;
  if (isHls) {
    const lines = manifestText.split(/\r?\n/);
    if (!lines[0] || !lines[0].startsWith('#EXTM3U')) {
      fail('Manifest missing #EXTM3U on line 1');
    } else {
      const segLines = lines.filter((l) => l && !l.startsWith('#'));
      const hasEndlist = lines.some((l) => l.trim() === '#EXT-X-ENDLIST');
      const hasVod = lines.some((l) => /#EXT-X-PLAYLIST-TYPE:VOD/.test(l));
      ok(`Manifest well-formed: ${segLines.length} segment(s)${hasVod ? ', VOD' : ''}${hasEndlist ? ', ENDLIST' : ''}`);
      if (segLines.length === 0) {
        warn('No segments listed yet — ffmpeg may still be initializing.');
      }
      const fmp4Hits = lines.filter((l) => l.includes('.m4s'));
      if (fmp4Hits.length > 0) {
        warn(`Manifest references .m4s (fMP4) segments. Default Chromecast receiver prefers MPEG-TS (.ts).`);
      }
      if (segLines[0]) {
        try { firstSegmentUrl = new URL(segLines[0], manifestUrl).toString(); } catch (e) { /* relative path issue */ }
        if (firstSegmentUrl) info(`First segment: ${firstSegmentUrl}`);
      }
    }
  }

  // 4. ffprobe codec check.
  const ffprobePath = findFfprobePath();
  if (!ffprobePath) {
    warn('ffprobe not found; skipping codec inspection');
  } else {
    info(`ffprobe: ${ffprobePath}`);
    const probe = probeUrl(ffprobePath, manifestUrl);
    if (probe.code !== 0) {
      fail(`ffprobe on manifest failed (exit ${probe.code}): ${probe.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
    } else if (probe.parsed && Array.isArray(probe.parsed.streams)) {
      const summary = probe.parsed.streams
        .map((s) => `${s.codec_type}:${s.codec_name}${s.channels ? `/${s.channels}ch` : ''}${s.width ? `/${s.width}x${s.height}` : ''}`)
        .join(', ');
      ok(`Manifest decodable. Streams: ${summary}`);
      const hasH264 = probe.parsed.streams.some((s) => /h264|avc/i.test(s.codec_name || ''));
      const hasAac = probe.parsed.streams.some((s) => /aac/i.test(s.codec_name || ''));
      if (!hasH264) warn('No H.264 video stream detected — default Chromecast receiver only plays H.264.');
      if (!hasAac) warn('No AAC audio stream detected — Chromecast expects AAC (or MP3).');
    } else {
      warn('ffprobe returned no JSON');
    }
    if (firstSegmentUrl) {
      const segProbe = probeUrl(ffprobePath, firstSegmentUrl);
      if (segProbe.code !== 0) {
        fail(`First segment ffprobe failed: ${segProbe.stderr.trim().split('\n').slice(0, 3).join(' | ')}`);
      } else {
        ok('First segment decodable by ffprobe');
      }
    }
  }

  // 5. catt cast (only when --device passed).
  const cattBin = findCattPath();
  if (!cattBin) {
    info('`catt` not installed — install with `pip install catt` to do a real LoadRequest test.');
  } else if (!opts.device) {
    info('`catt` available. Pass --device "<name>" to LoadRequest this URL. Run `catt scan` to list devices.');
  } else {
    info(`Casting to "${opts.device}" via catt…`);
    const castRes = runCatt(cattBin, ['-d', opts.device, 'cast', manifestUrl], 30000);
    if (castRes.status !== 0) {
      fail(`catt cast failed: ${(castRes.stderr || castRes.stdout || '(no output)').trim()}`);
    } else {
      ok(`catt LoadRequest sent to "${opts.device}"`);
      if (opts.watchSeconds > 0) {
        const ticks = Math.max(1, Math.ceil(opts.watchSeconds / 2));
        for (let i = 0; i < ticks; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const sr = runCatt(cattBin, ['-d', opts.device, 'status'], 6000);
          const firstLine = (sr.stdout || sr.stderr || '').trim().split(/\r?\n/)[0] || '(no status)';
          console.log(color('cyan', '  receiver: ') + firstLine);
        }
      }
    }
  }

  // 6. Summary.
  const okCount = report.filter((r) => r.level === 'ok').length;
  const warnCount = report.filter((r) => r.level === 'warn').length;
  const failCount = report.filter((r) => r.level === 'fail').length;
  console.log('');
  console.log(
    color('bold', 'Summary: ')
    + color('green', `${okCount} ok`) + ', '
    + color('yellow', `${warnCount} warn`) + ', '
    + color('red', `${failCount} fail`)
  );
  return failCount > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error(color('red', 'Unhandled error: ') + (e && e.stack || e));
    process.exit(2);
  });
}

module.exports = { parseArgs, fetchUrl };
