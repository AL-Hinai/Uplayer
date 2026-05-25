'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'tools', 'cast-diagnose.js');

// Minimal HLS manifest pointing at one TS segment served by the same mock server.
function buildManifest() {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:6.0,',
    'seg00000.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

// Spin up a fake Uplayer web server backed entirely by canned responses.
// Behaviour switches by `mode`:
//   'happy'           — returns a session with castUrl and serves a real manifest
//   'no-sessions'     — /api/stream/status returns []
//   'missing-casturl' — session exists but has no castUrl
//   'bad-manifest'    — manifest is reachable but missing #EXTM3U
//   'fmp4-manifest'   — manifest references .m4s segments (fMP4 warning path)
function startMockServer(mode) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`);
      if (pathname === '/api/stream/status') {
        let body;
        if (mode === 'no-sessions') body = [];
        else if (mode === 'missing-casturl') {
          body = [{ id: 'sess-1', running: true, playerUrl: `http://${req.headers.host}/`, castUrl: null }];
        } else {
          body = [{
            id: 'sess-1',
            running: true,
            playerUrl: `http://${req.headers.host}/`,
            castUrl: `http://${req.headers.host}/hls/index.m3u8`,
            videoFormat: { container: 'mkv', codec: 'h264', acodec: 'aac', playbackStrategy: 'remux' },
          }];
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (pathname === '/hls/index.m3u8') {
        let payload;
        if (mode === 'bad-manifest') payload = 'this is not an m3u8 file\nrandom garbage\n';
        else if (mode === 'fmp4-manifest') {
          payload = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-PLAYLIST-TYPE:VOD',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:6.0,',
            'seg00000.m4s',
            '#EXT-X-ENDLIST',
            '',
          ].join('\n');
        } else payload = buildManifest();
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
      if (pathname === '/hls/seg00000.ts' || pathname === '/hls/seg00000.m4s') {
        // Tiny payload — the diagnostic only cares that the URL is reachable;
        // ffprobe will fail on garbage and that's reported as a structured warning, not a crash.
        res.writeHead(200, { 'Content-Type': 'video/mp2t' });
        res.end(Buffer.from([0x47, 0x40, 0x00, 0x10])); // 4-byte stub
        return;
      }
      res.writeHead(404);
      res.end('');
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// async variant — spawnSync would block this test's event loop, starving the
// in-process mock HTTP server so the spawned CLI never gets a response.
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--no-color', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 30000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

function runCliSync(args, env = {}) {
  // Only safe when no in-process server is involved (e.g. --help, unreachable URL).
  return spawnSync(process.execPath, [CLI, '--no-color', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ...env, NO_COLOR: '1' },
  });
}

async function withServer(mode, fn) {
  const { server, url } = await startMockServer(mode);
  try { return await fn(url); }
  finally { await new Promise((r) => server.close(r)); }
}

async function testHelpFlagPrintsUsage() {
  const r = runCliSync(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /Uplayer cast diagnostic/);
  assert.match(r.stdout, /--device/);
  assert.match(r.stdout, /--manifest/);
}

async function testHappyPathReportsOkOnReachableManifest() {
  await withServer('happy', async (url) => {
    const r = await runCli(['--server', url]);
    assert.ok(/Found active session: sess-1/.test(r.stdout), `expected session line in:\n${r.stdout}`);
    assert.ok(/Manifest reachable/.test(r.stdout), `expected reachable check in:\n${r.stdout}`);
    assert.ok(/Manifest well-formed: 1 segment/.test(r.stdout), `expected manifest parse in:\n${r.stdout}`);
    assert.ok(/Strategy: remux/.test(r.stdout), `expected strategy line in:\n${r.stdout}`);
    assert.ok(/Summary:/.test(r.stdout));
  });
}

async function testNoActiveSessionFailsCleanly() {
  await withServer('no-sessions', async (url) => {
    const r = await runCli(['--server', url]);
    assert.strictEqual(r.status, 1);
    assert.ok(/No active stream/.test(r.stdout), `expected no-stream message in:\n${r.stdout}`);
  });
}

async function testMissingCastUrlFailsWithExplicitMessage() {
  await withServer('missing-casturl', async (url) => {
    const r = await runCli(['--server', url]);
    assert.strictEqual(r.status, 1);
    assert.ok(/no castUrl/.test(r.stdout), `expected missing-castUrl message in:\n${r.stdout}`);
  });
}

async function testBadManifestIsReported() {
  await withServer('bad-manifest', async (url) => {
    const r = await runCli(['--server', url]);
    assert.ok(/Manifest missing #EXTM3U/.test(r.stdout), `expected manifest-format fail in:\n${r.stdout}`);
  });
}

async function testFmp4ManifestEmitsCompatibilityWarning() {
  await withServer('fmp4-manifest', async (url) => {
    const r = await runCli(['--server', url]);
    assert.ok(/\.m4s.*Default Chromecast/.test(r.stdout), `expected fMP4 warning in:\n${r.stdout}`);
  });
}

async function testUnreachableServerExitsOne() {
  // No in-process server, so sync is fine.
  const r = runCliSync(['--server', 'http://127.0.0.1:1']);
  assert.strictEqual(r.status, 1);
  assert.ok(/not reachable/.test(r.stdout), `expected unreachable message in:\n${r.stdout}`);
}

async function testManualManifestSkipsServerLookup() {
  await withServer('happy', async (url) => {
    // Point --server somewhere broken; --manifest should bypass it entirely.
    const r = await runCli(['--server', 'http://127.0.0.1:1', '--manifest', `${url}/hls/index.m3u8`]);
    assert.ok(/Using manual manifest URL/.test(r.stdout), `expected manual-manifest acknowledgement in:\n${r.stdout}`);
    assert.ok(/Manifest reachable/.test(r.stdout), `expected reachable check in:\n${r.stdout}`);
  });
}

async function testParseArgsHandlesFlags() {
  const { parseArgs } = require('../tools/cast-diagnose');
  const opts = parseArgs(['--server', 'http://x', '--device', 'TV', '--watch', '15', '--manifest', 'http://y']);
  assert.strictEqual(opts.server, 'http://x');
  assert.strictEqual(opts.device, 'TV');
  assert.strictEqual(opts.watchSeconds, 15);
  assert.strictEqual(opts.manifest, 'http://y');
}

async function main() {
  await testHelpFlagPrintsUsage();
  await testParseArgsHandlesFlags();
  await testHappyPathReportsOkOnReachableManifest();
  await testNoActiveSessionFailsCleanly();
  await testMissingCastUrlFailsWithExplicitMessage();
  await testBadManifestIsReported();
  await testFmp4ManifestEmitsCompatibilityWarning();
  await testUnreachableServerExitsOne();
  await testManualManifestSkipsServerLookup();
  console.log('cast-diagnose.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
