'use strict';

// THE CONTRACT between the two kinds of subtitle. It is currently upheld by agreement
// across six files (uplayer.js, server.js, app.js, native-player.js and two endpoints)
// and stated in none of them, which is exactly the kind of rule that erodes. So:
//
//   1. EMBEDDED (extracted from the container) and DOWNLOADED (fetched from a provider)
//      coexist. Neither suppresses the other; both are offered on every playback target
//      and the viewer picks whichever they want.
//   2. AUTO-FIX APPLIES ONLY TO THE DOWNLOADED ONE. An embedded track was muxed with
//      this exact video, so its clock IS the video's clock — "correcting" it could only
//      make it wrong, after burning minutes of audio extraction to do so.
//   3. A track's INDEX never moves. Every player addresses subtitles as
//      /subtitle_<index>.vtt, so a shifted index doesn't error — it silently serves the
//      wrong subtitle. This is the quiet one, and the reason it is tested here.
//
// Pure: array and prototype-level assertions. No IO, no network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { StreamManager } = require('../uplayer.js');

function createFakeManager() {
  const m = new EventEmitter();
  Object.setPrototypeOf(m, StreamManager.prototype);
  m.subtitlePaths = [];
  m.subtitlePath = null;
  m._burnSubtitlePath = null;
  m._subtitleJob = null;
  m._destroyed = false;
  m._log = () => {};
  m._isAlassAvailable = () => true;
  m._waitForSyncWindow = async () => true;
  m._syncChangedTiming = () => true;
  return m;
}

function waitForJob(m) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (m._subtitleJob && !m._subtitleJob.running) return resolve(m._subtitleJob);
      if (Date.now() - t0 > 2000) return reject(new Error('job never finished'));
      setImmediate(tick);
    };
    tick();
  });
}

// A realistic mixed stream: an MKV with two muxed tracks, plus the file the user chose
// in the wizard. This is the ordinary case, not an edge case.
function mixedTracks() {
  return [
    { path: '/tmp/emb_eng.vtt', source: 'embedded', language: 'eng', label: 'English (eng)', codec: 'webvtt', trackIndex: 2, complete: true },
    { path: '/tmp/emb_ara.vtt', source: 'embedded', language: 'ara', label: 'Arabic (ara)', codec: 'webvtt', trackIndex: 3, complete: true },
    { path: '/tmp/downloaded.srt', source: 'external', language: 'ar', label: 'External Subtitle', codec: 'srt', complete: true },
  ];
}

async function testOnlyTheDownloadedTrackIsEverSynced() {
  const m = createFakeManager();
  m.subtitlePaths = mixedTracks();
  m.subtitlePath = '/tmp/downloaded.srt';
  const before = JSON.parse(JSON.stringify(m.subtitlePaths.slice(0, 2)));

  const synced = [];
  m.syncSubtitle = async (p) => { synced.push(p); return { ok: true, output: '/tmp/downloaded.synced.srt' }; };

  m._autoSyncExternalSubtitle();
  await waitForJob(m);

  assert.deepStrictEqual(synced, ['/tmp/downloaded.srt'],
    'alass saw the downloaded file and nothing else — embedded tracks are never candidates');
  assert.deepStrictEqual(m.subtitlePaths.slice(0, 2), before,
    'both embedded tracks are byte-for-byte the same objects afterwards: path, label, language, all of it');
}

// The quiet one. Subtitle URLs are /subtitle_<index>.vtt, built from the ARRAY POSITION.
// If the sync ever inserted or reordered instead of swapping in place, a player asking
// for "the English track" would be handed something else, with no error anywhere.
async function testIndicesNeverMoveWhenTheFixLands() {
  const m = createFakeManager();
  m.subtitlePaths = mixedTracks();
  m.subtitlePath = '/tmp/downloaded.srt';
  m.syncSubtitle = async () => ({ ok: true, output: '/tmp/downloaded.synced.srt' });

  m._autoSyncExternalSubtitle();
  await waitForJob(m);

  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/emb_eng.vtt', 'index 0 is still the English embedded track');
  assert.strictEqual(m.subtitlePaths[1].path, '/tmp/emb_ara.vtt', 'index 1 is still the Arabic embedded track');
  assert.strictEqual(m.subtitlePaths[2].path, '/tmp/downloaded.synced.srt',
    'index 2 is still THE downloaded track — corrected in place, so every player follows it for free');
  assert.strictEqual(m.subtitlePaths[3].label, 'Original timing',
    'the uncorrected copy is APPENDED, never inserted');
  assert.strictEqual(m.subtitlePaths.length, 4);
}

// Nothing about downloading a subtitle turns embedded extraction off, and nothing about
// having embedded tracks skips the download. Both paths run; the viewer chooses.
async function testAnEmbeddedOnlyStreamCostsNothing() {
  const m = createFakeManager();
  m.subtitlePaths = mixedTracks().slice(0, 2); // no download this time
  m.syncSubtitle = async () => { throw new Error('must not be called'); };

  m._autoSyncExternalSubtitle();
  assert.strictEqual(m._subtitleJob, null,
    'no downloaded subtitle means no job at all — not a failed one, not a skipped one');
  assert.strictEqual(m.subtitlePaths.length, 2, 'and the embedded tracks are still there, untouched');
}

// The timing fix must never reach an embedded track, whoever asks. The player no longer
// has a button at all — the fix is automatic — so the only remaining way in is the
// endpoint, and it refuses. That refusal is now the sole guard and matters more than it
// did when the button filtered candidates first.
function testTheFixCannotReachAnEmbeddedTrack() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'uplayer.js'), 'utf8');
  assert.ok(
    /if \(src\.source === 'embedded'\)[\s\S]{0,400}?timing fix is for downloaded subtitles/.test(server),
    'POST /api/subtitles/sync must reject an embedded index with an explanation'
  );

  const player = fs.readFileSync(path.join(__dirname, '..', 'public', 'player', 'native-player.js'), 'utf8');
  assert.ok(!/toolButtons\.sync/.test(player),
    'there is no manual timing-fix button — the fix runs on its own');
  assert.ok(!/postTool\("sync"/.test(player),
    'and the player never posts a sync job, so it cannot aim one at an embedded track');
}

// Coexistence has to survive all the way to the picker: the DLNA card DEFAULTS to the
// downloaded track (it is the one that was chosen for this release, and the only one the
// fix ever touches) but must still send an embedded track when the viewer asks for it.
function testViewerCanStillChooseAnEmbeddedTrack() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf('function resolveDlnaSubtitleTrack');
  const end = src.indexOf('async function refreshDlnaSubtitleOptions', start);
  assert.notStrictEqual(start, -1);
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);

  const opts = [
    { trackId: 1, name: 'English (eng)', source: 'embedded', ready: true, complete: true, srtContentId: 'e0.srt' },
    { trackId: 2, name: 'External Subtitle', source: 'external', ready: true, complete: true, srtContentId: 'x.srt' },
  ];
  assert.strictEqual(ctx.resolveDlnaSubtitleTrack(opts, null).source, 'external', 'default: the downloaded one');
  assert.strictEqual(ctx.resolveDlnaSubtitleTrack(opts, '1').source, 'embedded', 'but an explicit pick is honoured');
  assert.strictEqual(ctx.dlnaSubtitleUrlFor(ctx.resolveDlnaSubtitleTrack(opts, '1')), 'e0.srt',
    'and it is actually sent — choosing embedded is not quietly ignored');
}

async function main() {
  await testOnlyTheDownloadedTrackIsEverSynced();
  await testIndicesNeverMoveWhenTheFixLands();
  await testAnEmbeddedOnlyStreamCostsNothing();
  testTheFixCannotReachAnEmbeddedTrack();
  testViewerCanStillChooseAnEmbeddedTrack();
  console.log('subtitle-coexistence.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
