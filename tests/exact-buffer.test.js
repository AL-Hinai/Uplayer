'use strict';

// Old buffer ESTIMATE vs new /cache-based EXACT buffer, on the failure cases that
// motivated the switch. The estimate (StreamHealth#buffer) divides a total-cached
// counter by average bitrate and assumes sequential download; the exact answer
// (exactBufferAheadBytes) walks the real piece map from POST /cache. Each test
// builds a scenario with a known ground truth and asserts the estimate gets it
// wrong in exactly the way it does in production, while the piece walk gets it
// right — that is the evidence the new API solves the issue, not just moves it.

const assert = require('assert');
const http = require('http');
const { StreamHealth, exactBufferAheadBytes } = require('../core/stream-health');
const { TorrServerClient } = require('../core/torrserver-client');

// A torrent with 10-byte pieces; `completed` lists the piece ids that are in cache.
// Keys are strings, as they arrive from JSON.
function cacheWith(completed, { pieceLength = 10, piecesCount = 100 } = {}) {
  const pieces = {};
  for (const id of completed) pieces[String(id)] = { Id: id, Completed: true };
  return { pieceLength, piecesCount, pieces, capacity: 0, filled: completed.length * pieceLength, readers: [] };
}

function range(from, to) { // inclusive
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

// The seek-then-stall case: plenty cached in TOTAL, but a hole right after the
// playhead. This is the state the frozen-download session was in — and the estimate
// is structurally unable to see it.
function testHoleAfterPlayheadEstimateLiesExactDoesNot() {
  // 1000-byte file, 100s → 10 B/s. Pieces 0..11 and 13..48 cached (49 pieces, 490 B
  // total) — piece 12 is the hole. Playhead at 10s = byte 100.
  const h = new StreamHealth().attachSource({ sizeBytes: 1000, durationSec: 100 });
  h.report({ preloadedBytes: 490 });
  h.observePlayhead(10, 'web');

  const estimate = h.status().buffer;
  assert.strictEqual(estimate.aheadSec, 39, 'estimate: 490 cached − 100 played = "39s of buffer"');

  const exact = exactBufferAheadBytes(cacheWith([...range(0, 11), ...range(13, 48)]), 100);
  assert.strictEqual(exact, 20, 'exact: pieces 10,11 then the hole — 20 bytes = 2s');
  assert.ok(estimate.aheadBytes > 10 * exact,
    'the estimate overstates the real window by more than 10x here — THIS is the bug being fixed');
}

// When the download really is sequential (the common healthy case), the two answers
// must agree — the exact walk is a strict improvement, not a different trade-off.
function testSequentialHealthyCaseBothAgree() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000, durationSec: 100 });
  h.report({ preloadedBytes: 500 }); // pieces 0..49, no holes
  h.observePlayhead(10, 'web');

  const estimate = h.status().buffer;
  const exact = exactBufferAheadBytes(cacheWith(range(0, 49)), 100);
  assert.strictEqual(estimate.aheadBytes, 400);
  assert.strictEqual(exact, 400, 'identical when the sequential assumption actually holds');
}

// Multi-file torrents: preloaded_bytes is torrent-wide, so another file's bytes
// inflate the estimate. A piece walk indexed by absolute offset cannot be inflated
// by bytes that live elsewhere in the torrent.
function testMultiFileTorrentEstimateInflatedExactIsNot() {
  // Torrent: 200-byte extra file (bytes 0..199), then our 800-byte video (bytes
  // 200..999), 80s → 10 B/s. Pieces 0..69 cached = 700 B total, of which only 500
  // belong to our file. Playhead 10s = file byte 100 = absolute byte 300.
  const h = new StreamHealth().attachSource({ sizeBytes: 800, durationSec: 80 });
  h.report({ preloadedBytes: 700 });
  h.observePlayhead(10, 'web');

  const estimate = h.status().buffer;
  assert.strictEqual(estimate.aheadSec, 60, 'estimate counts the OTHER file\'s 200 bytes as our buffer');

  const exact = exactBufferAheadBytes(cacheWith(range(0, 69)), 300);
  assert.strictEqual(exact, 400, 'exact: absolute 300 → cached through piece 69 (byte 699) = 400 B = 40s');
  assert.ok(estimate.aheadBytes > exact, 'ground truth is 40s; only the estimate overshoots it');
}

function testExactEdgeCases() {
  assert.strictEqual(exactBufferAheadBytes(null, 0), null, 'no cache state → no guess, like the estimate');
  assert.strictEqual(exactBufferAheadBytes({ pieceLength: 0, piecesCount: 9, pieces: {} }, 0), null);
  assert.strictEqual(exactBufferAheadBytes(cacheWith([1, 2]), 0), 0, 'piece under the playhead missing → 0, not null');
  assert.strictEqual(exactBufferAheadBytes(cacheWith(range(0, 99)), 995), 5, 'tail of the last piece');
  assert.strictEqual(exactBufferAheadBytes(cacheWith(range(0, 99)), 2000), 0, 'position past the torrent');
  assert.strictEqual(exactBufferAheadBytes(cacheWith(range(0, 5)), -1), null, 'nonsense position → null');
  // Mid-piece position only counts the REMAINDER of that piece.
  assert.strictEqual(exactBufferAheadBytes(cacheWith([10, 11]), 105), 15, 'half of piece 10 + piece 11');
}

// cacheState() normalization: the client owns TorrServer's capitalized names so no
// caller ever touches them, and any failure is null — never a throw, never zeros
// masquerading as an empty cache.
async function testCacheStateNormalizesEngineShape() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      assert.strictEqual(req.url, '/cache');
      assert.deepStrictEqual(JSON.parse(body), { action: 'get', hash: 'cafe' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Capacity: 1073741824, Filled: 539052266, PiecesCount: 1025, PiecesLength: 2811904,
        Pieces: { 0: { Id: 0, Length: 2811904, Size: 2811904, Completed: true, Priority: 0 } },
        Readers: [{ Start: 0, End: 5, Reader: 3 }],
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new TorrServerClient({ port: srv.address().port, log: () => {} });
    const s = await c.cacheState('cafe');
    assert.strictEqual(s.pieceLength, 2811904);
    assert.strictEqual(s.piecesCount, 1025);
    assert.strictEqual(s.filled, 539052266);
    assert.strictEqual(s.readers.length, 1);
    assert.ok(s.pieces['0'].Completed, 'piece map preserved for exactBufferAheadBytes');

    // And the two new pieces compose: exact window from the head of this real shape.
    assert.strictEqual(exactBufferAheadBytes(s, 0), 2811904, 'one cached piece → one piece of window');
  } finally {
    srv.close();
  }

  const dead = new TorrServerClient({ port: 1, log: () => {} });
  assert.strictEqual(await dead.cacheState('cafe'), null, 'engine down → null, not a throw');
}

async function main() {
  testHoleAfterPlayheadEstimateLiesExactDoesNot();
  testSequentialHealthyCaseBothAgree();
  testMultiFileTorrentEstimateInflatedExactIsNot();
  testExactEdgeCases();
  await testCacheStateNormalizesEngineShape();
  console.log('exact-buffer.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
