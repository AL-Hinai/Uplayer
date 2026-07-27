'use strict';

// Stream health: the byte supply. Field names and the shape of the numbers here were
// taken from a LIVE TorrServer (`action:'get'`), not from documentation.

const assert = require('assert');
const { StreamHealth, legacyProgressPayload } = require('../core/stream-health');

// A real poll, as observed on a running swarm.
function liveStats(overrides = {}) {
  return {
    downloadSpeed: 574206.5467017647,
    uploadSpeed: 3343.9067143967877,
    seeds: 84,          // connected_seeders
    peers: 86,          // active_peers
    swarmPeers: 205,    // total_peers
    pendingPeers: 137,
    preloadedBytes: 1089967455,
    loadedBytes: 1089967455,
    torrentSize: 1499960671,
    chunksRead: 124347,
    chunksWasted: 3000,
    stat: 3,
    statText: 'Torrent working',
    ...overrides,
  };
}

// The headline of this phase: three different numbers that used to be one.
function testSeedsPeersAndSwarmAreDistinct() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1499960671 });
  const s = h.report(liveStats());

  assert.strictEqual(s.seeds, 84);
  assert.strictEqual(s.peers, 86);
  assert.strictEqual(s.swarmPeers, 205);
  assert.strictEqual(s.pendingPeers, 137);
  assert.notStrictEqual(s.seeds, s.peers, 'seeds and peers are not the same question');
}

function testRawNumbersNotStrings() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1499960671 });
  const s = h.report(liveStats());

  assert.strictEqual(typeof s.downloadSpeedBps, 'number');
  assert.strictEqual(s.downloadSpeedBps, 574206.5467017647, 'full precision survives');
  assert.strictEqual(typeof s.uploadSpeedBps, 'number', 'upload was never emitted at all before');
  assert.strictEqual(typeof s.downloadedBytes, 'number');
}

function testWasteRatio() {
  const h = new StreamHealth();
  assert.strictEqual(h.report(liveStats()).wasteRatio, 0.0241, '3000 of 124347 chunks wasted');
  assert.strictEqual(h.report(liveStats({ chunksRead: 0, chunksWasted: 0 })).wasteRatio, null,
    'nothing read yet is unknown, not 0% waste');
}

// TorrServer can report a smaller cache after eviction; the bar must not jump backwards.
function testDownloadedIsMonotonic() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });
  h.report(liveStats({ preloadedBytes: 500 }));
  const s = h.report(liveStats({ preloadedBytes: 400 }));
  assert.strictEqual(s.downloadedBytes, 500, 'downloaded must never go backwards');
}

function testPercentClampsForMultiFileTorrents() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });
  // preloaded_bytes is torrent-wide while sizeBytes is one file, so the ratio can exceed 1.
  const s = h.report(liveStats({ preloadedBytes: 5000 }));
  assert.strictEqual(s.percent, 1, 'clamped, as it always was');
}

// --- buffer ahead: an estimate, and it must say so -------------------------------

function testBufferNeedsBothPlanes() {
  const h = new StreamHealth();
  h.report(liveStats());
  assert.strictEqual(h.status().buffer, null, 'no source facts => no guess');

  h.attachSource({ sizeBytes: 1499960671 }); // size but no duration (probe failed)
  assert.strictEqual(h.status().buffer, null, 'no duration => no bitrate => no guess');

  h.attachSource({ sizeBytes: 1499960671, durationSec: 1440 });
  assert.strictEqual(h.status().buffer, null, 'no playhead yet => no guess');

  h.observePlayhead(0, 'web');
  assert.ok(h.status().buffer, 'source + target together => an answer neither had alone');
}

function testBufferMath() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000, durationSec: 100 });
  h.report(liveStats({ preloadedBytes: 500 }));  // half the file cached
  h.observePlayhead(10, 'vlc');                   // playhead at 10s = 100 bytes in

  const b = h.status().buffer;
  assert.strictEqual(b.aheadBytes, 400);
  assert.strictEqual(b.aheadSec, 40, '400 bytes at 10 bytes/sec of video = 40s');
  assert.strictEqual(b.estimated, true, 'it must always admit it is an estimate');
  assert.strictEqual(b.basis, 'sequential');
  assert.strictEqual(b.playheadFrom, 'vlc');
}

// Seeking past the cache is the case people actually hit.
function testSeekingPastTheBufferGoesToZeroNotNegative() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000, durationSec: 100 });
  h.report(liveStats({ preloadedBytes: 300 }));
  h.observePlayhead(90, 'web'); // way past what's cached

  assert.strictEqual(h.status().buffer.aheadSec, 0, 'clamped at zero, never negative');
}

function testLastPlayheadWins() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000, durationSec: 100 });
  h.report(liveStats({ preloadedBytes: 900 }));
  h.observePlayhead(10, 'web');
  h.observePlayhead(50, 'dlna:tv-1');
  assert.strictEqual(h.status().buffer.playheadFrom, 'dlna:tv-1',
    'two players at once has no single answer — say whose it is');
}

// --- the frozen event ------------------------------------------------------------

// `progress` drives the existing download bar. Its shape is frozen; this is the exact
// payload the UI has always received, strings and all.
function testLegacyProgressPayloadIsByteIdentical() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1499960671 });
  const s = h.report(liveStats());

  assert.deepStrictEqual(legacyProgressPayload(s), {
    percent: 72.7,
    speed: '0.55 MB/s',
    downloaded: '1039.47 MB',
    peers: 86,
  });
}

// The client no longer collapses seeds/peers, so the emit site must — or a swarm with 0
// active peers but 84 connected seeders would suddenly display "0 peers".
function testLegacyPeersFallbackPreservesOldCollapse() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });

  const noneActive = h.report(liveStats({ peers: 0, seeds: 84, swarmPeers: 205 }));
  assert.strictEqual(legacyProgressPayload(noneActive).peers, 84, 'falls back to seeds');

  const h2 = new StreamHealth().attachSource({ sizeBytes: 1000 });
  const swarmOnly = h2.report(liveStats({ peers: 0, seeds: 0, swarmPeers: 205 }));
  assert.strictEqual(legacyProgressPayload(swarmOnly).peers, 205, 'then to the swarm');
}

// --- engine down -----------------------------------------------------------------

// The real failure this covers: TorrServer died mid-movie, every poll failed, and the
// UI showed a percent frozen at 38% with 0 speed forever. The client now marks failed
// polls `unreachable`; a streak of them must become an explicit engineDown flag.
function testEngineDownNeedsAStreakNotOneBlip() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });
  const dead = { downloadSpeed: 0, peers: 0, seeds: 0, preloadedBytes: 0, unreachable: true };

  assert.strictEqual(h.report(dead).engineDown, false, 'one failed poll is a blip');
  assert.strictEqual(h.report(dead).engineDown, false, 'two is still a blip');
  const s = h.report(dead);
  assert.strictEqual(s.engineDown, true, 'three in a row is a dead engine');
  assert.ok(Number.isFinite(s.engineDownSince), 'stamped when it crossed the threshold');
}

function testEngineDownClearsOnFirstGoodPoll() {
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });
  const dead = { unreachable: true };
  h.report(dead); h.report(dead); h.report(dead);
  assert.strictEqual(h.status().engineDown, true);

  const s = h.report(liveStats());
  assert.strictEqual(s.engineDown, false, 'the engine answered — it is back');
  assert.strictEqual(s.engineDownSince, null);

  // And the streak restarts from zero: a fresh blip is a blip again.
  assert.strictEqual(h.report(dead).engineDown, false);
}

function testEngineDownKeepsDownloadedMonotonic() {
  // The dead poll carries zeros; the progress bar must not jump back because of it.
  const h = new StreamHealth().attachSource({ sizeBytes: 1000 });
  h.report(liveStats({ preloadedBytes: 380 }));
  const s = h.report({ preloadedBytes: 0, unreachable: true });
  assert.strictEqual(s.downloadedBytes, 380, 'frozen at last real value, not zeroed');
}

function testEmptyStatsDoNotThrow() {
  const h = new StreamHealth();
  const s = h.report(null);
  assert.strictEqual(s.downloadSpeedBps, 0);
  assert.strictEqual(s.percent, 0, 'no size known yet');
  assert.strictEqual(legacyProgressPayload(s).speed, '0.00 MB/s');
}

function main() {
  testSeedsPeersAndSwarmAreDistinct();
  testRawNumbersNotStrings();
  testWasteRatio();
  testDownloadedIsMonotonic();
  testPercentClampsForMultiFileTorrents();
  testBufferNeedsBothPlanes();
  testBufferMath();
  testSeekingPastTheBufferGoesToZeroNotNegative();
  testLastPlayheadWins();
  testLegacyProgressPayloadIsByteIdentical();
  testLegacyPeersFallbackPreservesOldCollapse();
  testEngineDownNeedsAStreakNotOneBlip();
  testEngineDownClearsOnFirstGoodPoll();
  testEngineDownKeepsDownloadedMonotonic();
  testEmptyStatsDoNotThrow();
  console.log('stream-health.test.js passed');
}

main();
