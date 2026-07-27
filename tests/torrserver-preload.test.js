'use strict';

// TorrServer preload. The bug under test: the engine is demand-driven — it downloads
// only while a reader is attached, and drops the torrent 30s after the last reader
// leaves (TorrentDisconnectTimeout). Uplayer added torrents but attached no lasting
// reader, so a stream that wasn't being actively played froze at a fixed percent;
// opening the SAME torrent in TorrServer's own player made it download, because that
// player fires /stream?...&preload first. Uplayer now makes that same preload call
// for every movie. Verified against a live MatriX.141.5: the route answers 200 with
// stats JSON once the preload target is reached.

const assert = require('assert');
const http = require('http');
const { TorrServerClient } = require('../core/torrserver-client');

function fakeEngine(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function testPreloadHitsTheStreamRouteWithPreloadFlag() {
  let seenUrl = null;
  const { srv, port } = await fakeEngine((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"stat":3}');
  });
  try {
    const c = new TorrServerClient({ port, log: () => {} });
    const ok = await c.preload('deadbeef', 1, 'Some Movie (2026).mp4');
    assert.strictEqual(ok, true);

    const u = new URL('http://x' + seenUrl);
    assert.strictEqual(u.pathname, '/stream/Some%20Movie%20(2026).mp4');
    assert.strictEqual(u.searchParams.get('link'), 'deadbeef');
    assert.strictEqual(u.searchParams.get('index'), '1');
    assert.ok(u.searchParams.has('preload'), 'the flag that makes the engine download without a player');
    assert.ok(u.searchParams.has('stat'), 'stat makes the blocking call answer with JSON, not media bytes');
    assert.ok(!u.searchParams.has('play'), 'preload must NOT request the media itself');
  } finally {
    srv.close();
  }
}

async function testPreloadNeverThrows() {
  // Fire-and-forget contract: an engine that is down (or resets the socket) must
  // resolve false, not reject — nothing on the streaming path awaits or catches it.
  const { srv, port } = await fakeEngine((req, res) => res.socket.destroy());
  try {
    const c = new TorrServerClient({ port, log: () => {} });
    assert.strictEqual(await c.preload('deadbeef', 1), false, 'socket reset');
  } finally {
    srv.close();
  }
  const c2 = new TorrServerClient({ port, log: () => {} }); // srv closed — connection refused
  assert.strictEqual(await c2.preload('deadbeef', 1), false, 'engine down');
}

async function main() {
  await testPreloadHitsTheStreamRouteWithPreloadFlag();
  await testPreloadNeverThrows();
  console.log('torrserver-preload.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
