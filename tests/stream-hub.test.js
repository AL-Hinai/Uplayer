'use strict';

// Verifies the shared stream hub: many concurrent streams are served from ONE
// HTTP server and told apart by a UUID-style id in the URL path, not by port.
// Routing strips the /<streamId> prefix so each per-stream handler still sees
// root-relative paths; an unknown id 404s; the shared server stays up while any
// stream remains and only closes once the last one unregisters.

const assert = require('assert');
const http = require('http');
const { _streamHub: hub } = require('../uplayer');

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Each handler echoes back the (already-prefix-stripped) url it received, so we
// can assert the hub routed to the right stream and rewrote the path correctly.
function echoHandler(tag) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${tag}:${req.url}`);
  };
}

async function main() {
  const idA = 'aaaa1111aaaa1111';
  const idB = 'bbbb2222bbbb2222';

  // preferredPort 0 → OS-assigned, so this test never collides with a live app on 8000.
  const { port } = await hub.register(idA, echoHandler('A'), 0, '127.0.0.1');
  const r2 = await hub.register(idB, echoHandler('B'), 0, '127.0.0.1');
  assert.strictEqual(r2.port, port, 'second stream must reuse the SAME shared port');
  assert.strictEqual(hub.size(), 2, 'both streams registered');

  // Root of a stream → handler sees '/'
  assert.strictEqual((await get(port, `/${idA}/`)).body, 'A:/', 'stream A root');
  // Trailing-slash-less root also maps to '/'
  assert.strictEqual((await get(port, `/${idA}`)).body, 'A:/', 'stream A root (no slash)');
  // Nested path is stripped of the id prefix only
  assert.strictEqual((await get(port, `/${idA}/video.mkv`)).body, 'A:/video.mkv', 'stream A video');
  // Query string is preserved across the rewrite, and routing is per-id
  assert.strictEqual(
    (await get(port, `/${idB}/hls/index.m3u8?x=1`)).body,
    'B:/hls/index.m3u8?x=1',
    'stream B hls + query'
  );

  // Unknown id → 404 (not routed to any stream)
  const unknown = await get(port, '/nope/video.mkv');
  assert.strictEqual(unknown.status, 404, 'unknown stream id is 404');

  // Removing one stream must NOT kill the other.
  hub.unregister(idA);
  assert.strictEqual(hub.size(), 1, 'one stream remains after unregister');
  assert.strictEqual((await get(port, `/${idB}/`)).body, 'B:/', 'survivor still served on same port');
  assert.strictEqual((await get(port, `/${idA}/`)).status, 404, 'removed stream now 404s');

  // Removing the last stream closes the shared server.
  hub.unregister(idB);
  assert.strictEqual(hub.size(), 0, 'no streams left');
  assert.strictEqual(hub.port, null, 'shared server closed once empty');

  console.log('stream-hub.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
