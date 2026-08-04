'use strict';

// Auto-fixing subtitle TIMING — and for whom. The rule under test: only a
// DOWNLOADED (external) subtitle ever needs syncing — it was cut for whatever
// encode its uploader had. Embedded/extracted tracks were muxed with this exact
// video; their clock IS the video's clock, and running alass on them would burn
// minutes of audio extraction to fix nothing.
//
// On success the external entry must be swapped IN PLACE, because three
// different consumers read those fields — the subtitle manifest (web + cast
// players), VLC's --sub-file launch flag, and the cast burn-in path — and the
// point of AUTO-sync is that none of them has to select anything.

const assert = require('assert');
const { EventEmitter } = require('events');
const { StreamManager } = require('../uplayer.js');

// Same construction as stream-manager.test.js: prototype only, no real
// constructor (which would spawn a sandbox and reach for TorrServer).
function createFakeManager() {
  const manager = new EventEmitter();
  Object.setPrototypeOf(manager, StreamManager.prototype);
  manager.subtitlePaths = [];
  manager.subtitlePath = null;
  manager._burnSubtitlePath = null;
  manager._subtitleJob = null;
  manager._destroyed = false;
  manager._log = () => {};
  manager._isAlassAvailable = () => true;
  manager._waitForSyncWindow = async () => true; // cache-wait is exercised separately
  // Default: alass moved the cues. The "it didn't" case is its own test below, and
  // the real comparison (_syncChangedTiming over actual files) is tested there.
  manager._syncChangedTiming = () => true;
  return manager;
}

function waitForJob(manager) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (manager._subtitleJob && !manager._subtitleJob.running) return resolve(manager._subtitleJob);
      if (Date.now() - started > 2000) return reject(new Error('job never finished'));
      setImmediate(tick);
    };
    tick();
  });
}

async function testDownloadedSubtitleIsSyncedAndSwappedEverywhere() {
  const m = createFakeManager();
  m.subtitlePaths = [
    { path: '/tmp/embedded0.srt', source: 'embedded', language: 'en', label: 'English (embedded)', complete: true },
    { path: '/tmp/downloaded.srt', source: 'external', language: 'ar', label: 'External Subtitle', codec: 'srt', complete: true },
  ];
  m.subtitlePath = '/tmp/downloaded.srt';
  m._burnSubtitlePath = '/tmp/downloaded.srt';

  const syncedWith = [];
  m.syncSubtitle = async (p) => { syncedWith.push(p); return { ok: true, output: '/tmp/downloaded.synced.srt' }; };
  const updates = [];
  m.on('subtitle_updated', (d) => updates.push(d));

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.strictEqual(job.error, null);
  assert.deepStrictEqual(syncedWith, ['/tmp/downloaded.srt'], 'the DOWNLOADED file was synced, nothing else');

  const external = m.subtitlePaths[1];
  assert.strictEqual(external.path, '/tmp/downloaded.synced.srt', 'manifest track swapped in place');
  assert.strictEqual(external.label, 'External Subtitle (auto-synced)');
  assert.strictEqual(m.subtitlePath, '/tmp/downloaded.synced.srt', 'what VLC --sub-file will get');
  assert.strictEqual(m._burnSubtitlePath, '/tmp/downloaded.synced.srt', 'what cast burn-in will get');

  const original = m.subtitlePaths[m.subtitlePaths.length - 1];
  assert.strictEqual(original.path, '/tmp/downloaded.srt', 'uncorrected file kept as its own track');
  assert.strictEqual(original.label, 'Original timing');

  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/embedded0.srt', 'embedded track untouched');

  // Already-running players are told: the web player refreshes via its manifest poll,
  // and the owning server relays this into a live VLC. `shiftMs` rides along because VLC
  // cannot swap a loaded subtitle — a pure offset is applied to the track it already has
  // instead of adding a second one. Here the files don't exist, so it is null (unknown),
  // which is the safe direction: send the file rather than guess a delay.
  assert.deepStrictEqual(
    updates,
    [{ path: '/tmp/downloaded.synced.srt', label: 'External Subtitle (auto-synced)', shiftMs: null }],
    'subtitle_updated emitted for the swapped track, carrying the VLC offset'
  );
}

async function testEmbeddedOnlyStreamsNeverSync() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/embedded0.srt', source: 'embedded', language: 'en', label: 'English' }];
  m.syncSubtitle = async () => { throw new Error('must not be called'); };

  m._autoSyncExternalSubtitle();
  assert.strictEqual(m._subtitleJob, null, 'no downloaded subtitle → no job, no audio extraction');
}

async function testDisabledByEnvAndMissingAlass() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle' }];
  m.syncSubtitle = async () => { throw new Error('must not be called'); };

  m._isAlassAvailable = () => false;
  m._autoSyncExternalSubtitle();
  assert.strictEqual(m._subtitleJob, null, 'no alass binary → quietly skipped');

  m._isAlassAvailable = () => true;
  process.env.UPLAYER_AUTO_SYNC_SUBS = '0';
  try {
    m._autoSyncExternalSubtitle();
    assert.strictEqual(m._subtitleJob, null, 'env kill-switch respected');
  } finally {
    delete process.env.UPLAYER_AUTO_SYNC_SUBS;
  }
}

async function testFailedSyncLeavesEverythingUntouched() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle' }];
  m.subtitlePath = '/tmp/d.srt';
  m.syncSubtitle = async () => ({ ok: false, reason: 'audio extraction failed' });

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.strictEqual(job.error, 'audio extraction failed', 'failure is recorded for the player spinner');
  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/d.srt', 'original stays the active track');
  assert.strictEqual(m.subtitlePaths.length, 1, 'no bogus extra track');
  assert.strictEqual(m.subtitlePath, '/tmp/d.srt');
}

// The cold-cache regression: at stream start the cache is nearly empty, and
// TorrServer's /stream EOFs early at uncached pieces, so audio extraction can
// return a FRAGMENT — alass then "corrected" a right subtitle by ~4 minutes.
// Incomplete audio must mean retry-after-buffering, never a result.
async function testIncompleteAudioRetriesInsteadOfTrustingAFragment() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle' }];
  m.subtitlePath = '/tmp/d.srt';
  let waits = 0;
  m._waitForSyncWindow = async () => { waits++; return waits > 2; };
  let calls = 0;
  m.syncSubtitle = async () => {
    calls++;
    if (calls < 3) return { ok: false, reason: 'audio incomplete (31s of 1200s cached) — retry once more is buffered' };
    return { ok: true, output: '/tmp/d.synced.srt' };
  };

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.strictEqual(job.error, null, 'third attempt succeeded');
  assert.strictEqual(calls, 3, 'fragment results were retried, not applied');
  assert.strictEqual(waits, 3, 'each attempt waits for the cache window first');
  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/d.synced.srt', 'only the COMPLETE sync was applied');
}

async function testTeardownStopsTheRetryLoop() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle' }];
  m.subtitlePath = '/tmp/d.srt';
  m._waitForSyncWindow = async () => { m._destroyed = true; return false; }; // stream stopped while waiting
  m.syncSubtitle = async () => { throw new Error('must not run after teardown'); };

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.ok(/stream ended/.test(job.error), 'loop exits quietly instead of syncing a dead stream');
  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/d.srt', 'nothing was touched');
}

// Discovered on a live run: subtitle sites carry TRAILER files with six-figure
// download counts (37 cues covering 2m27s of a 169-minute film). Aligning one
// against the movie's audio produces a confident, meaningless shift — the sync
// must refuse, not disguise the junk.
async function testTrailerSubtitleIsNeverSynced() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/trailer.srt', source: 'external', label: 'External Subtitle' }];
  m.streamHealth = { durationSec: 10140 }; // 169-minute film
  m._subtitleSpanSeconds = () => 147;      // the file ends at 2m27s
  m.syncSubtitle = async () => { throw new Error('must not be called'); };

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.ok(/trailer/.test(job.error), 'refused with an explanation');
  assert.strictEqual(m.subtitlePaths[0].label, 'External Subtitle', 'no misleading (auto-synced) label');
}

// A subtitle that was ALREADY correctly timed is the common case for a well-matched
// release, and alass returns it effectively unchanged. Acting on that is not harmless:
// it relabels the track "(auto-synced)", leaves a duplicate "Original timing" entry, and
// on a DLNA TV offers to restart the film to apply a difference of zero. Nothing changed,
// so nothing may change.
async function testAlreadyCorrectTimingIsLeftCompletelyAlone() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle', codec: 'srt', complete: true }];
  m.subtitlePath = '/tmp/d.srt';
  m._burnSubtitlePath = '/tmp/d.srt';
  m.syncSubtitle = async () => ({ ok: true, output: '/tmp/d.synced.srt' });
  m._syncChangedTiming = () => false; // alass moved nothing
  const updates = [];
  m.on('subtitle_updated', (d) => updates.push(d));

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);

  assert.strictEqual(job.error, null, 'this is a success, not a failure');
  assert.strictEqual(job.unchanged, true, 'and it is recorded as a no-op');
  assert.strictEqual(m.subtitlePaths.length, 1, 'no duplicate "Original timing" track');
  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/d.srt', 'the original file stays THE track');
  assert.strictEqual(m.subtitlePaths[0].label, 'External Subtitle', 'no misleading "(auto-synced)" label');
  assert.strictEqual(m.subtitlePath, '/tmp/d.srt');
  assert.strictEqual(m._burnSubtitlePath, '/tmp/d.srt');
  assert.deepStrictEqual(updates, [], 'no subtitle_updated — nothing downstream should restart for a no-op');
}

// The comparison itself, over real files. Its fallback direction matters: when the two
// cannot be compared it must answer "changed", because dropping a REAL correction is the
// worse error of the two.
function testSyncChangedTimingComparison() {
  const os = require('os');
  const fsx = require('fs');
  const pathx = require('path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'uplayer-sync-cmp-'));
  const write = (name, body) => { const p = pathx.join(dir, name); fsx.writeFileSync(p, body, 'utf8'); return p; };
  const cmp = (a, b) => StreamManager.prototype._syncChangedTiming.call(
    { _subtitleCueStarts: StreamManager.prototype._subtitleCueStarts }, a, b
  );

  const base = write('a.srt', '1\n00:00:10,000 --> 00:00:12,000\nHi\n\n2\n00:01:00,000 --> 00:01:02,000\nBye\n');
  const same = write('b.srt', '1\n00:00:10,000 --> 00:00:12,000\nHi\n\n2\n00:01:00,000 --> 00:01:02,000\nBye\n');
  const jitter = write('c.srt', '1\n00:00:10,030 --> 00:00:12,000\nHi\n\n2\n00:01:00,020 --> 00:01:02,000\nBye\n');
  const shifted = write('d.srt', '1\n00:00:14,000 --> 00:00:16,000\nHi\n\n2\n00:01:04,000 --> 00:01:06,000\nBye\n');
  const fewer = write('e.srt', '1\n00:00:10,000 --> 00:00:12,000\nHi\n');

  assert.strictEqual(cmp(base, same), false, 'identical timings -> no change');
  assert.strictEqual(cmp(base, jitter), false, 'sub-frame jitter is not a correction anyone can see');
  assert.strictEqual(cmp(base, shifted), true, 'a 4-second shift is a real correction');
  assert.strictEqual(cmp(base, fewer), true, 'different cue counts -> not comparable -> assume changed');
  assert.strictEqual(cmp(base, pathx.join(dir, 'missing.srt')), true, 'unreadable -> assume changed');

  fsx.rmSync(dir, { recursive: true, force: true });
}

// The last line of defence, over real files. alass exits 0 on a confidently wrong
// alignment exactly as it does on a good one, so this check is the only thing between a
// destroyed subtitle and every playback target. It is a floor under catastrophe, not a
// quality score: a merely mediocre sync must get through, because the viewer can still
// pick "Original timing", and dropping a real correction is the worse error.
function testImplausibleSyncGuard() {
  const os = require('os');
  const fsx = require('fs');
  const pathx = require('path');
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'uplayer-sync-guard-'));
  const stamp = (ms) => {
    const p = (n, w) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
  };
  // 200 cues every 30s — a film-length track, so a wrong alignment has room to look wrong.
  const write = (name, map) => {
    const body = [];
    for (let i = 0; i < 200; i += 1) {
      const t = Math.max(0, Math.round(map(30000 + i * 30000)));
      body.push(`${i + 1}\n${stamp(t)} --> ${stamp(t + 2000)}\nline ${i + 1}`);
    }
    const p = pathx.join(dir, name);
    fsx.writeFileSync(p, body.join('\n\n') + '\n', 'utf8');
    return p;
  };
  const guard = (a, b) => StreamManager.prototype._implausibleSync.call(
    { _subtitleCueStarts: StreamManager.prototype._subtitleCueStarts }, a, b
  );

  const base = write('base.srt', (t) => t);
  assert.strictEqual(guard(base, write('same.srt', (t) => t)), null, 'no change is not a catastrophe');
  assert.strictEqual(guard(base, write('small.srt', (t) => t + 7000)), null, 'a 7s fix is exactly what this is for');
  assert.strictEqual(guard(base, write('fps.srt', (t) => t * (25 / 23.976))), null, 'a framerate correction is a real fix');

  assert.ok(/pushed off the start/.test(guard(base, write('front.srt', (t) => t - 1200000))),
    'a track walked off the front of the film');
  assert.ok(/moves the subtitle by/.test(guard(base, write('late.srt', (t) => t + 30 * 60000))),
    'half an hour is a misalignment, not a mis-timing');
  // Squeezed about its own midpoint, so the median cue barely moves and only the SPAN
  // gives it away — which is the third signal's whole reason for existing.
  const mid = 30000 + (199 * 30000) / 2;
  assert.ok(/compresses/.test(guard(base, write('squash.srt', (t) => mid + (t - mid) * 0.85))),
    'a track squashed to fit something it is not');

  // Unreadable or empty is no evidence either way, and _syncChangedTiming already treats
  // that case as "keep the correction" — disagreeing here would silently undo it.
  assert.strictEqual(guard(base, pathx.join(dir, 'missing.srt')), null, 'unreadable -> no verdict');

  fsx.rmSync(dir, { recursive: true, force: true });
}

// The reason people ended up pressing the player's CC⇄ button: the automatic pass gave
// up. It fires at stream START, the coldest the cache ever is, and "audio incomplete"
// just means the bytes for the sync window have not arrived — on a 2.8-hour film that is
// guaranteed for a while. A 3-attempt budget burned entirely inside the opening minutes
// and then never tried again, so the manual button became the only way to get the thing
// that was supposed to happen on its own.
async function testColdCacheDoesNotExhaustTheAutomaticFix() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle', complete: true }];
  m.subtitlePath = '/tmp/d.srt';

  // Eight passes of "not buffered yet" — well past the old ceiling — then the viewer has
  // watched far enough in that the window is cached.
  let calls = 0;
  m._waitForSyncWindow = async () => true;
  m.syncSubtitle = async () => {
    calls += 1;
    if (calls < 9) return { ok: false, reason: 'audio incomplete (31s of 1200s cached) — retry once more is buffered' };
    return { ok: true, output: '/tmp/d.synced.srt' };
  };

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);

  assert.strictEqual(job.error, null, 'it kept trying and eventually landed, with no click involved');
  assert.strictEqual(calls, 9, 'a cold start must not exhaust the budget in the first minutes');
  assert.strictEqual(m.subtitlePaths[0].path, '/tmp/d.synced.srt', 'and the track really was corrected');
}

// The retry budget is for "not yet", not for "no". A real failure must stop at once —
// retrying a missing binary twelve times would just stall the job slot.
async function testARealFailureStillStopsImmediately() {
  const m = createFakeManager();
  m.subtitlePaths = [{ path: '/tmp/d.srt', source: 'external', label: 'External Subtitle' }];
  let calls = 0;
  m.syncSubtitle = async () => { calls += 1; return { ok: false, reason: 'alass not installed' }; };

  m._autoSyncExternalSubtitle();
  const job = await waitForJob(m);
  assert.strictEqual(calls, 1, 'a non-buffering failure is not retried');
  assert.strictEqual(job.error, 'alass not installed');
}

// _waitForSyncWindow used to return false the moment streamHealth was absent — which is
// exactly the state at stream start, so the first attempt skipped its wait and extracted
// from the coldest cache, manufacturing the fragment it was meant to avoid.
async function testWaitingSurvivesHealthDataNotBeingReadyYet() {
  const m = createFakeManager();
  let polls = 0;
  Object.defineProperty(m, 'streamHealth', {
    get() {
      polls += 1;
      // Health only appears on the third look, as the ticker spins up.
      return polls < 3 ? null : { sizeBytes: 1000, durationSec: 100, downloadedBytes: 1000 };
    },
  });
  const covered = await StreamManager.prototype._waitForSyncWindow.call(m, 10, 60000);
  assert.strictEqual(covered, true, 'it waited for health data instead of giving up on it');
  assert.ok(polls >= 3, 'and actually polled more than once');
}

async function main() {
  await testTrailerSubtitleIsNeverSynced();
  await testColdCacheDoesNotExhaustTheAutomaticFix();
  await testARealFailureStillStopsImmediately();
  await testWaitingSurvivesHealthDataNotBeingReadyYet();
  await testAlreadyCorrectTimingIsLeftCompletelyAlone();
  testSyncChangedTimingComparison();
  testImplausibleSyncGuard();
  await testDownloadedSubtitleIsSyncedAndSwappedEverywhere();
  await testEmbeddedOnlyStreamsNeverSync();
  await testDisabledByEnvAndMissingAlass();
  await testFailedSyncLeavesEverythingUntouched();
  await testIncompleteAudioRetriesInsteadOfTrustingAFragment();
  await testTeardownStopsTheRetryLoop();
  console.log('auto-sync-subtitle.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
