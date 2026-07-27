'use strict';

// Which subtitle rides along when VLC launches. The bug under test: the launch
// used streamManager.subtitlePath, which the embedded-subtitle EXTRACTOR claims
// when no download exists — so an anime stream handed VLC a partial,
// progressively-rewritten VTT that showed up as a nameless "Track", outranked
// the MKV's own properly-named embedded tracks, and displayed nothing. VLC must
// receive a DOWNLOADED subtitle or nothing at all: embedded tracks live inside
// the container and VLC discovers those itself.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pickVlcSubtitle } = require('../server.js')._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-vlcsub-'));
const realFile = (name) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, '1\n00:00:01,000 --> 00:00:02,000\nx\n');
  return p;
};

function testAnimeWithOnlyEmbeddedTracksSendsNothing() {
  const extracted = realFile('extracted.vtt');
  const session = { streamManager: {
    subtitlePath: extracted, // the extractor claimed it — this is the trap
    subtitlePaths: [
      { path: extracted, source: 'embedded', label: 'English (eng)', trackIndex: 2 },
      { path: realFile('signs.vtt'), source: 'embedded', label: 'Signs / Songs (eng)', trackIndex: 3 },
    ],
  } };
  assert.strictEqual(pickVlcSubtitle(session), null,
    'embedded-only stream → VLC gets NO --sub-file; the MKV carries its own tracks');
}

function testDownloadedSubtitleIsTheOneSent() {
  const downloaded = realFile('downloaded.srt');
  const session = { streamManager: {
    subtitlePath: realFile('extracted.vtt'),
    subtitlePaths: [
      { path: realFile('embedded.vtt'), source: 'embedded', label: 'English (eng)' },
      { path: downloaded, source: 'external', label: 'External Subtitle' },
    ],
  } };
  assert.strictEqual(pickVlcSubtitle(session), downloaded);
}

function testAfterAutoSyncTheCorrectedFileWins() {
  const synced = realFile('downloaded.synced.srt');
  const original = realFile('downloaded.srt');
  const session = { streamManager: { subtitlePaths: [
    { path: synced, source: 'external', label: 'External Subtitle (auto-synced)' },
    { path: original, source: 'external', label: 'Original timing' },
  ] } };
  assert.strictEqual(pickVlcSubtitle(session), synced, 'first external entry = the corrected one');
}

function testMissingFilesAndSessionsAreNull() {
  assert.strictEqual(pickVlcSubtitle(null), null);
  assert.strictEqual(pickVlcSubtitle({}), null);
  assert.strictEqual(pickVlcSubtitle({ streamManager: { subtitlePaths: [
    { path: path.join(tmp, 'deleted.srt'), source: 'external', label: 'External Subtitle' },
  ] } }), null, 'a vanished temp file is not handed to VLC');
}

function main() {
  try {
    testAnimeWithOnlyEmbeddedTracksSendsNothing();
    testDownloadedSubtitleIsTheOneSent();
    testAfterAutoSyncTheCorrectedFileWins();
    testMissingFilesAndSessionsAreNull();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('vlc-subtitle-pick.test.js passed');
}

main();
