'use strict';

// ONE bug shape, four places it can hide.
//
// The timing auto-fix swaps the corrected file in at the SAME subtitle index, so the
// identifier every target caches by — a URL, a track id, a file path — does not change.
// Any target that decides "have I already loaded this?" from that identifier alone will
// keep rendering the UNCORRECTED cues forever, while the "Original timing" copy the fix
// appends shows up as a brand-new entry. To the viewer that reads as: "it created a
// second track instead of fixing the first one."
//
// It was found in VLC and turned out to be present in the web player too. Each target
// needs something that MOVES when the fix lands — the label is what does.
//
//   web player  subTracks keyed by url  -> compare a label+complete signature
//   Chromecast  subtitleReloadKey       -> castSubtitleReloadKey folds in the label
//   VLC         cannot replace OR select -> apply the offset to the loaded track (subdelay)
//   DLNA        sidecar fetched once     -> cannot replace; re-send + seek, offered
//
// Pure: reads source text and calls one pure parser. No VLC, no TV, no network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The web player polls the manifest and reconciles tracks itself. Keyed on url alone it
// bailed out via `if (cur && cur.complete) return;` — and a DOWNLOADED subtitle is
// complete from the moment it lands, so that was every time.
function testWebPlayerReloadsWhenTheContentChangesUnderTheSameUrl() {
  const src = read('public/player/native-player.js');
  assert.ok(/function subSig\(s\)/.test(src), 'the player needs a version signature, not just a url');
  assert.ok(!/if \(cur && cur\.complete\) return;/.test(src),
    'the url+complete early-return is the bug — it can never see a same-index swap');

  // Run the real signature function and prove it moves for a relabel.
  const start = src.indexOf('function subSig(s)');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n', start) + 1), ctx);

  const before = ctx.subSig({ label: 'External Subtitle', complete: true });
  const after = ctx.subSig({ label: 'External Subtitle (auto-synced)', complete: true });
  assert.notStrictEqual(before, after, 'auto-sync must force a reload of that track');
  assert.strictEqual(ctx.subSig({ label: 'External Subtitle', complete: true }), before,
    'and must NOT reload while nothing changed — this polls every 8s');

  // Extraction progress must still trigger its one reload, the behaviour that already
  // existed and must not be lost.
  assert.notStrictEqual(
    ctx.subSig({ label: 'English (eng)', complete: false }),
    ctx.subSig({ label: 'English (eng)', complete: true }),
    'a track finishing extraction still reloads once'
  );
}

// There is no timing-fix button any more, and there must not be one: the fix is
// automatic, so a button meant "do the thing that is already happening" and implied the
// viewer had a step to perform. What replaces it is this: when the corrected file lands,
// the track the viewer is WATCHING becomes the corrected one, with no interaction.
//
// The subtle half is what must NOT happen — the fix also appends an "Original timing"
// copy, and if that stole the selection the viewer would silently be moved back onto the
// uncorrected subtitle, which is worse than doing nothing at all.
function testCorrectedTrackAutoSelectsAndOriginalDoesNotStealIt() {
  const src = read('public/player/native-player.js');
  assert.ok(!/toolButtons\.sync/.test(src), 'the timing-fix button must be gone');
  assert.ok(!/command.*addsubtitle/.test(src));
  assert.ok(/tools && tools\.whisper/.test(src), 'the whisper generate button is unrelated and stays');

  // Drive the real syncSub against a fake Video.js player.
  const start = src.indexOf('var subTracks = {}');
  const end = src.indexOf('function pollSubs()');
  const menu = [];
  const player = {
    textTracks: () => menu.map((m) => m.track),
    addRemoteTextTrack: (o) => {
      const el = { track: { kind: 'subtitles', mode: 'disabled', label: o.label, src: o.src } };
      menu.push(el);
      return el;
    },
    removeRemoteTextTrack: (el) => { const i = menu.indexOf(el); if (i >= 0) menu.splice(i, 1); },
  };
  const ctx = { player, console, Date };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);

  const downloaded = { index: 0, url: '/subtitle_0.vtt', label: 'External Subtitle', language: 'ar', ready: true, complete: true };
  ctx.syncSub(downloaded);
  assert.strictEqual(menu.length, 1);
  menu[0].track.mode = 'showing';               // the viewer is watching the downloaded one

  // The fix lands: same index, new label — plus the uncorrected copy appended.
  ctx.syncSub({ index: 0, url: '/subtitle_0.vtt', label: 'External Subtitle (auto-synced)', language: 'ar', ready: true, complete: true });
  ctx.syncSub({ index: 1, url: '/subtitle_1.vtt', label: 'Original timing', language: 'ar', ready: true, complete: true });

  const showing = menu.filter((m) => m.track.mode === 'showing');
  assert.strictEqual(showing.length, 1, 'exactly one track is on');
  assert.strictEqual(showing[0].track.label, 'External Subtitle (auto-synced)',
    'the CORRECTED track is the one being watched, with no click');
  assert.strictEqual(menu.length, 2, 'and the original is available beside it, not instead of it');

  // Polling again must not churn the selection or the menu.
  ctx.syncSub({ index: 0, url: '/subtitle_0.vtt', label: 'External Subtitle (auto-synced)', language: 'ar', ready: true, complete: true });
  assert.strictEqual(menu.length, 2);
  assert.strictEqual(menu.filter((m) => m.track.mode === 'showing').length, 1);
}

// A viewer watching an EMBEDDED track must not be yanked onto the downloaded one just
// because it got corrected. The fix is silent unless it concerns what they are watching.
function testAnUnrelatedSelectionIsLeftAlone() {
  const src = read('public/player/native-player.js');
  const start = src.indexOf('var subTracks = {}');
  const end = src.indexOf('function pollSubs()');
  const menu = [];
  const player = {
    textTracks: () => menu.map((m) => m.track),
    addRemoteTextTrack: (o) => { const el = { track: { kind: 'subtitles', mode: 'disabled', label: o.label, src: o.src } }; menu.push(el); return el; },
    removeRemoteTextTrack: (el) => { const i = menu.indexOf(el); if (i >= 0) menu.splice(i, 1); },
  };
  const ctx = { player, console, Date };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);

  ctx.syncSub({ index: 0, url: '/subtitle_0.vtt', label: 'English (eng)', language: 'en', ready: true, complete: true });
  ctx.syncSub({ index: 1, url: '/subtitle_1.vtt', label: 'External Subtitle', language: 'ar', ready: true, complete: true });
  menu[0].track.mode = 'showing';   // watching the EMBEDDED track
  menu[1].track.mode = 'disabled';

  ctx.syncSub({ index: 1, url: '/subtitle_1.vtt', label: 'External Subtitle (auto-synced)', language: 'ar', ready: true, complete: true });

  const showing = menu.filter((m) => m.track.mode === 'showing');
  assert.strictEqual(showing.length, 1);
  assert.strictEqual(showing[0].track.label, 'English (eng)', 'the embedded track the viewer chose stays on');
}

// VLC cannot replace a loaded subtitle, and `addsubtitle` does not select what it loads —
// measured on 3.0.23, where the original stayed the current track and the corrected file
// sat there inert. So pushing a file leaves a second track; the question is only whether
// we can then select it.
//
// We can. This assertion used to say the opposite ("selecting a track is not possible on
// real VLC"), on the strength of a claim that status.xml lists no subtitle entry. It does
// list one, on that same version — see vlcSubtitleTrackIds. Left as a note because a
// confident wrong comment cost this feature more than the missing code did.
//
// The best path is still to send no file at all: when the whole correction is a constant
// offset, `subdelay` fixes the track VLC ALREADY has — same track, same name, right
// timing. That is what _subtitleUniformShiftMs decides, and it is the interesting part.
function testVlcFixesTheExistingTrackWhenTheShiftIsUniform() {
  const src = read('server.js');
  assert.ok(/command=subdelay&val=/.test(src), 'a pure offset must be applied to the existing track');
  assert.ok(/command=addsubtitle/.test(src), 'a non-uniform correction still needs the file');
  assert.ok(/command=subtitle_track&val=/.test(src),
    'a pushed file must also be SELECTED — an unselected track is not a fix');

  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-shift-'));
  const write = (n, b) => { const p = path.join(dir, n); fs.writeFileSync(p, b, 'utf8'); return p; };
  const { StreamManager } = require('../uplayer.js');
  const shift = (a, b) => StreamManager.prototype._subtitleUniformShiftMs.call(
    { _subtitleCueStarts: StreamManager.prototype._subtitleCueStarts }, a, b
  );

  const original = write('o.srt', '1\n00:00:51,640 --> 00:01:01,640\nA\n\n2\n00:01:07,000 --> 00:01:09,000\nB\n');
  // Every cue pulled 7s earlier — the shape of a subtitle cut for another release.
  const uniform = write('u.srt', '1\n00:00:44,640 --> 00:00:54,640\nA\n\n2\n00:01:00,000 --> 00:01:02,000\nB\n');
  assert.strictEqual(shift(original, uniform), -7000,
    'negative: the subtitle ran late, so VLC delays it by -7s to line up');

  // Sub-frame noise is not a retiming; it must not be pushed onto the two-track path.
  // The answer is the MEDIAN offset, not the mean — one wild cue must not drag it.
  const jitter = write('j.srt', '1\n00:00:51,670 --> 00:01:01,640\nA\n\n2\n00:01:07,020 --> 00:01:09,000\nB\n');
  assert.strictEqual(shift(original, jitter), 30, 'still a single offset, just a tiny one');

  // The realistic shape: aligning against AUDIO leaves per-cue jitter around one offset.
  // Rejecting these was what pushed real corrections onto the second-track path.
  const starts = [];
  for (let i = 0; i < 100; i += 1) starts.push(60000 + i * 15000);
  const fmt = (ms) => [
    String(Math.floor(ms / 3600000)).padStart(2, '0'),
    String(Math.floor(ms / 60000) % 60).padStart(2, '0'),
    String(Math.floor(ms / 1000) % 60).padStart(2, '0'),
  ].join(':') + ',' + String(ms % 1000).padStart(3, '0');
  const srt = (list) => list.map((s, i) => `${i + 1}\n${fmt(s)} --> ${fmt(s + 2000)}\nX\n`).join('\n');

  const many = write('m.srt', srt(starts));
  const jittered = write('mj.srt', srt(starts.map((s, i) => s - 7000 + ((i * 37) % 241) - 120)));
  const got = shift(many, jittered);
  // The exact median depends on where the jitter happens to fall, so assert the property
  // that matters: a single offset was found, and it is the right one to within a frame.
  assert.ok(got != null && Math.abs(got - -7000) <= 150,
    'audio-aligned jitter is still one offset, got ' + got);

  // alass sometimes drops or merges a cue — a length mismatch used to return null and
  // send the file, for a correction that was a plain shift.
  const dropped = write('md.srt', srt(starts.slice(1).map((s) => s - 7000)));
  assert.strictEqual(shift(many, dropped), -7000, 'a missing cue does not disqualify a pure shift');

  // Real drift: the offset grows across the file. No single delay can express that.
  const drifting = write('mdr.srt', srt(starts.map((s, i) => s - 7000 - i * 60)));
  assert.strictEqual(shift(many, drifting), null, 'accumulating drift still needs the file');

  // Frame-rate drift: the gap grows across the file. One delay cannot express that, so
  // it has to fall back to sending the corrected file.
  const drift = write('d.srt', '1\n00:00:51,640 --> 00:01:01,640\nA\n\n2\n00:01:12,000 --> 00:01:14,000\nB\n');
  assert.strictEqual(shift(original, drift), null, 'non-uniform -> null -> send the file instead');

  // A differing cue count is no longer disqualifying — cues are paired by nearest match,
  // so a dropped or merged line still yields the offset (asserted at scale above).
  assert.strictEqual(shift(original, write('f.srt', '1\n00:00:51,640 --> 00:01:01,640\nA\n')), 0,
    'one surviving cue at the same time means no shift, not "unknown"');

  // Unreadable really is unknown, and unknown must stay null: a bogus delay would
  // desync a subtitle that was fine.
  assert.strictEqual(shift(original, path.join(dir, 'missing.srt')), null);
  assert.strictEqual(shift(original, write('empty.srt', '')), null);

  fs.rmSync(dir, { recursive: true, force: true });
}

// Chromecast caches by track id + stage; the stage is derived from `complete`, which is
// already true for a download. The label is folded into the key for the same reason.
function testChromecastKeyMovesOnRelabel() {
  const src = read('public/js/app.js');
  assert.ok(!/castTvState\.subtitleReloadKey === sel\b/.test(src),
    'comparing the bare track id cannot see a same-index swap');

  const start = src.indexOf('function castSubtitleReloadKey');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n}', start) + 2), ctx);
  assert.notStrictEqual(
    ctx.castSubtitleReloadKey('2', { name: 'External Subtitle' }),
    ctx.castSubtitleReloadKey('2', { name: 'External Subtitle (auto-synced)' })
  );
}

// DLNA cannot be corrected in place at all (a renderer fetches its sidecar once), so its
// answer is a signature watch plus an explicit re-send — never a silent no-op.
function testDlnaWatchesAndOffers() {
  const src = read('public/js/app.js');
  assert.ok(/function dlnaSubtitleSignature\(track\)/.test(src), 'DLNA needs the same signature idea');
  assert.ok(/dlnaSubtitlePending/.test(src), 'and a persistent offer, since a toast can be missed');
  assert.ok(/watchDlnaSubtitleForCorrection/.test(src));
}

function main() {
  testWebPlayerReloadsWhenTheContentChangesUnderTheSameUrl();
  testCorrectedTrackAutoSelectsAndOriginalDoesNotStealIt();
  testAnUnrelatedSelectionIsLeftAlone();
  testVlcFixesTheExistingTrackWhenTheShiftIsUniform();
  testChromecastKeyMovesOnRelabel();
  testDlnaWatchesAndOffers();
  console.log('subtitle-refresh-targets.test.js passed');
}

main();
