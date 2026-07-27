'use strict';

// TorrServer supervision. The bug under test: the engine was spawned with
// stdio:'ignore' and nothing watched its exit, so when it died mid-movie the app
// kept running, every stats poll failed silently, and the user saw a download
// frozen at 38% with no clue why. The client must now (a) mark failed polls
// `unreachable` so StreamHealth can surface engine-down, (b) respawn an
// unexpectedly-dead process with capped backoff, and (c) never respawn after a
// deliberate stop() or for an external engine it doesn't own.
//
// No real TorrServer binary is spawned here: the watchdog entry points
// (_onProcExit / _scheduleRespawn / stop) are driven directly, with instance state
// set to what a live client would have. The one bit of real IO is stats() against
// a port nothing listens on.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { TorrServerClient } = require('../core/torrserver-client');
const { respawnDelayMs, RESPAWN_MAX_MS } = require('../core/torrserver-client')._internals;

// A port that was just proven free — connecting to it refuses immediately.
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function quietClient(opts = {}) {
  return new TorrServerClient(Object.assign({ log: () => {}, port: 1 }, opts));
}

// Cancel a scheduled respawn so a test never actually re-enters start().
function disarmTimer(client) {
  if (client._respawnTimer) { clearTimeout(client._respawnTimer); client._respawnTimer = null; }
}

async function testStatsMarksUnreachableWhenEngineIsGone() {
  const c = quietClient({ port: await closedPort() });
  const s = await c.stats('deadbeef');
  assert.strictEqual(s.unreachable, true, 'a failed poll must say WHY it is all zeros');
  assert.strictEqual(s.downloadSpeed, 0, 'the zero shape callers always got is preserved');
}

function testBackoffGrowsAndCaps() {
  assert.strictEqual(respawnDelayMs(0), 1000);
  assert.strictEqual(respawnDelayMs(1), 2000);
  assert.strictEqual(respawnDelayMs(2), 4000);
  assert.strictEqual(respawnDelayMs(20), RESPAWN_MAX_MS, 'capped — a crash loop must not go hot');
}

function testUnexpectedExitSchedulesRespawn() {
  const events = [];
  const c = quietClient({ onEvent: (ev) => events.push(ev) });
  c._watchdogArmed = true;
  c._spawnedAt = Date.now();

  c._onProcExit(2);
  assert.ok(c._respawnTimer, 'an armed watchdog reacts to an unexpected death');
  assert.strictEqual(c._respawnAttempt, 1);
  assert.strictEqual(events[0].type, 'engine_exit');
  assert.strictEqual(events[0].code, 2);
  disarmTimer(c);
}

function testExitBeforeSuccessfulStartIsIgnored() {
  // start()'s own boot loop owns pre-arm failures (port conflict, bad binary) — the
  // watchdog respawning there would race the very error path that reports them.
  const c = quietClient();
  c._onProcExit(1);
  assert.strictEqual(c._respawnTimer, null, 'unarmed watchdog stays out of it');
}

function testDeliberateStopIsNotACrash() {
  const c = quietClient();
  c._watchdogArmed = true;
  c._onProcExit(0); // something is pending…
  assert.ok(c._respawnTimer);

  return c.stop().then(() => {
    assert.strictEqual(c._respawnTimer, null, 'stop() cancels the pending respawn');
    c._onProcExit(0); // the kill's own exit event arrives after stop()
    assert.strictEqual(c._respawnTimer, null, 'and later exits do not resurrect it');
  });
}

function testExternalEngineIsNeverRespawned() {
  const c = quietClient({ external: true });
  c._watchdogArmed = true; // even if something armed it, external wins
  c._onProcExit(137);
  assert.strictEqual(c._respawnTimer, null, 'not ours to supervise');
}

function testStableUptimeResetsBackoff() {
  const c = quietClient();
  c._watchdogArmed = true;
  c._respawnAttempt = 5; // a bad patch of crashes an hour ago
  c._spawnedAt = Date.now() - 10 * 60 * 1000;

  c._onProcExit(1);
  assert.strictEqual(c._respawnAttempt, 1, 'a long-healthy process starts the curve over');
  disarmTimer(c);
}

function testCrashLoopKeepsBackingOff() {
  const c = quietClient();
  c._watchdogArmed = true;
  for (let i = 0; i < 4; i++) {
    c._spawnedAt = Date.now(); // each respawn dies instantly — uptime never resets
    c._onProcExit(1);
    disarmTimer(c);
  }
  assert.strictEqual(c._respawnAttempt, 4, 'instant deaths accumulate, not reset');
}

// Torrents are added with save_to_db:false, so a respawned engine comes back empty
// — without the re-add ledger, every active session would point at a 404 after a
// crash the watchdog "fixed". Same magnet → same infohash → stream URLs survive.
async function testRespawnReaddsLiveTorrents() {
  const adds = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      if (b.action === 'add') adds.push(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Hash derives from the magnet's infohash, exactly like the real engine.
      res.end(JSON.stringify({ hash: (b.link && b.link.match(/btih:(\w+)/) || [])[1] || 'h', stat: 3 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new TorrServerClient({ port: srv.address().port, log: () => {}, trackers: [] });
    const h1 = await c.add('magnet:?xt=urn:btih:aaa1', 'Movie A');
    const h2 = await c.add('magnet:?xt=urn:btih:bbb2', 'Movie B');
    await c.remove(h2); // stream B was stopped — it must NOT come back
    adds.length = 0;

    await c._readdTorrents(); // what the respawn path runs after start()
    assert.strictEqual(adds.length, 1, 'only the still-live torrent is restored');
    assert.strictEqual(adds[0].link, 'magnet:?xt=urn:btih:aaa1');
    assert.strictEqual(adds[0].title, 'Movie A');
    assert.strictEqual(adds[0].save_to_db, false);
    assert.strictEqual(h1, 'aaa1', 'hash identity is what keeps the stream URLs valid');
  } finally {
    srv.close();
  }
}

function testEngineLogIsWrittenToDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-watchdog-test-'));
  try {
    const c = quietClient({ dataDir });
    assert.strictEqual(c.logPath, path.join(dataDir, 'torrserver.log'));

    const fd = c._openLogFd();
    assert.notStrictEqual(fd, null);
    fs.writeSync(fd, 'panic: simulated\n');
    fs.closeSync(fd);
    assert.ok(fs.readFileSync(c.logPath, 'utf8').includes('panic: simulated'),
      'the next crash leaves evidence instead of stdio:ignore silence');

    // Rotation: an oversized log moves to .old and a fresh one is opened.
    fs.writeFileSync(c.logPath, Buffer.alloc(6 * 1024 * 1024));
    const fd2 = c._openLogFd();
    fs.closeSync(fd2);
    assert.ok(fs.existsSync(c.logPath + '.old'), 'oversized log rotated aside');
    assert.ok(fs.statSync(c.logPath).size < 1024, 'fresh log after rotation');
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function main() {
  await testStatsMarksUnreachableWhenEngineIsGone();
  testBackoffGrowsAndCaps();
  testUnexpectedExitSchedulesRespawn();
  testExitBeforeSuccessfulStartIsIgnored();
  await testDeliberateStopIsNotACrash();
  testExternalEngineIsNeverRespawned();
  testStableUptimeResetsBackoff();
  testCrashLoopKeepsBackingOff();
  await testRespawnReaddsLiveTorrents();
  testEngineLogIsWrittenToDataDir();
  console.log('torrserver-watchdog.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
