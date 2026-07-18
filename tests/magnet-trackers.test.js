'use strict';

// Verifies magnet enrichment: curated trackers are appended (so the engine finds peers
// faster), already-present trackers aren't duplicated, and non-magnet inputs pass through.

const assert = require('assert');
const { enrichMagnet, DEFAULT_TRACKERS } = require('../core/torrserver-client');

const TR = ['udp://a.example:1337/announce', 'udp://b.example:6969/announce'];

function trackersIn(magnet) {
  const out = [];
  let m; const re = /[?&]tr=([^&]+)/gi;
  while ((m = re.exec(magnet))) out.push(decodeURIComponent(m[1]));
  return out;
}

function testAppendsToBareMagnet() {
  const bare = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Demo';
  const out = enrichMagnet(bare, TR);
  const trs = trackersIn(out);
  assert.deepStrictEqual(trs, TR, 'both trackers appended to a tracker-less magnet');
  assert.ok(out.includes('xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), 'infohash preserved');
}

function testDedupesExisting() {
  const withOne = 'magnet:?xt=urn:btih:abc123&dn=X&tr=' + encodeURIComponent(TR[0]);
  const out = enrichMagnet(withOne, TR);
  const trs = trackersIn(out);
  // TR[0] already present (case-insensitive) → only TR[1] added; no duplicate.
  assert.strictEqual(trs.filter((t) => t.toLowerCase() === TR[0].toLowerCase()).length, 1, 'no duplicate of existing tracker');
  assert.ok(trs.includes(TR[1]), 'the new tracker is added');
  assert.strictEqual(trs.length, 2);
}

function testLeavesNonMagnetsAlone() {
  assert.strictEqual(enrichMagnet('https://site/file.torrent', TR), 'https://site/file.torrent');
  assert.strictEqual(enrichMagnet('not a magnet', TR), 'not a magnet');
  // Empty tracker list (injection disabled) → unchanged.
  const bare = 'magnet:?xt=urn:btih:abc';
  assert.strictEqual(enrichMagnet(bare, []), bare);
}

function testDefaultListIsSane() {
  assert.ok(Array.isArray(DEFAULT_TRACKERS) && DEFAULT_TRACKERS.length >= 10, 'a real curated list ships by default');
  assert.ok(DEFAULT_TRACKERS.every((t) => /^(udp|https?):\/\//.test(t)), 'all entries are valid tracker URLs');
  assert.strictEqual(new Set(DEFAULT_TRACKERS).size, DEFAULT_TRACKERS.length, 'no duplicate trackers in the default list');
}

function main() {
  testAppendsToBareMagnet();
  testDedupesExisting();
  testLeavesNonMagnetsAlone();
  testDefaultListIsSane();
  console.log('magnet-trackers.test.js passed');
}

main();
