'use strict';

// The bug this file locks down: a DLNA cast went out with NO subtitle at all.
//
// Every piece was in place — core/dlna-caster builds a <sec:CaptionInfoEx> when handed a
// subtitleUrl, and POST /api/dlna/play forwards one through lanReachable() — but the only
// caller, castToDlnaDevice(), never put `subtitleUrl` in the body. So the downloaded
// subtitle, and the timing the background auto-sync had corrected on it, reached the web
// player and VLC and never the TV.
//
// Two halves are tested here:
//   1. Which track the DLNA card resolves (app.js helpers, loaded via vm — the frontend is
//      classic scripts, so there is nothing to require()).
//   2. The .srt twin the TV actually fetches (StreamManager.convertVTTtoSRT), because a
//      smart TV parses the sidecar itself and mostly rejects WebVTT.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { StreamManager } = require('../uplayer.js');

// Pull the DLNA subtitle helpers out of app.js. Same approach as cast-tv-modal.test.js:
// slice the source, run it in a bare context. Keeping this to pure helpers is deliberate —
// they are the decision, the fetch around them is plumbing.
function loadDlnaSubtitleHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('function resolveDlnaSubtitleTrack');
  const end = source.indexOf('async function refreshDlnaSubtitleOptions', start);
  assert.notStrictEqual(start, -1, 'resolveDlnaSubtitleTrack not found in app.js');
  assert.notStrictEqual(end, -1, 'DLNA subtitle helper block not found in app.js');

  const context = { console };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

const H = loadDlnaSubtitleHelpers();

const EXTERNAL = {
  trackId: 2, name: 'External Subtitle', source: 'external', ready: true, complete: true,
  trackContentId: 'http://192.168.1.5:8000/s/subtitle_1.vtt',
  srtContentId: 'http://192.168.1.5:8000/s/subtitle_1.srt',
};
const EMBEDDED = {
  trackId: 1, name: 'English (eng)', source: 'embedded', ready: true, complete: true,
  trackContentId: 'http://192.168.1.5:8000/s/subtitle_0.vtt',
  srtContentId: 'http://192.168.1.5:8000/s/subtitle_0.srt',
};

// The whole point of the wizard's subtitle step is that the user already chose a file for
// this release. Nobody should have to choose it a second time to see it on the TV.
function testDownloadedSubtitleIsTheDefault() {
  const picked = H.resolveDlnaSubtitleTrack([EMBEDDED, EXTERNAL], null);
  assert.strictEqual(picked, EXTERNAL, 'the downloaded track is what a DLNA cast sends by default');
}

// An embedded track is already inside the container the TV is playing and appears in the
// TV's own subtitle menu — pushing it as a sidecar as well would show it twice.
function testEmbeddedOnlyStreamSendsNothing() {
  assert.strictEqual(H.resolveDlnaSubtitleTrack([EMBEDDED], null), null);
}

function testExplicitChoiceWins() {
  assert.strictEqual(H.resolveDlnaSubtitleTrack([EMBEDDED, EXTERNAL], '1'), EMBEDDED, 'user picked the embedded track');
  assert.strictEqual(H.resolveDlnaSubtitleTrack([EMBEDDED, EXTERNAL], ''), null, "'' is the user choosing no subtitles, not 'not chosen'");
  assert.strictEqual(H.resolveDlnaSubtitleTrack([EMBEDDED, EXTERNAL], '9'), null, 'a stale id sends nothing rather than the wrong track');
}

// SRT, not VTT: the TV fetches and parses this file itself.
function testSidecarUrlIsSrt() {
  assert.strictEqual(H.dlnaSubtitleUrlFor(EXTERNAL), EXTERNAL.srtContentId);
  assert.strictEqual(H.dlnaSubtitleUrlFor(null), '', 'no track -> no url, never undefined in the request body');
  assert.strictEqual(
    H.dlnaSubtitleUrlFor(Object.assign({}, EXTERNAL, { ready: false })), '',
    'a track with no content yet must not be advertised to the TV'
  );
}

// A renderer fetches the sidecar exactly once, so the signature is the only way to notice
// that the auto-sync has since rewritten that same track underneath it.
function testSignatureMovesWhenAutoSyncRenamesTheTrack() {
  const before = H.dlnaSubtitleSignature(EXTERNAL);
  const after = H.dlnaSubtitleSignature(Object.assign({}, EXTERNAL, { name: 'External Subtitle (auto-synced)' }));
  assert.notStrictEqual(before, after, 'auto-sync must be detectable from the manifest alone');

  // Still-extracting -> complete is the other transition worth re-sending for.
  const partial = H.dlnaSubtitleSignature(Object.assign({}, EXTERNAL, { complete: false }));
  assert.notStrictEqual(partial, before);

  assert.strictEqual(H.dlnaSubtitleSignature(null), '', 'no track selected -> empty signature, nothing to watch');
}

// --- The .srt twin the TV downloads -------------------------------------------

function convert(vtt) {
  return StreamManager.prototype.convertVTTtoSRT.call({ _legacyVttToSrt: StreamManager.prototype._legacyVttToSrt }, vtt);
}

function testVttToSrt() {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n\n2\n00:01:00.250 --> 00:01:02.000\nWorld';
  const srt = convert(vtt);
  assert.ok(!/WEBVTT/.test(srt), 'the WEBVTT header would make a TV reject the file');
  assert.ok(srt.includes('00:00:01,000 --> 00:00:02,500'), 'SRT uses a comma for the millisecond separator');
  assert.ok(srt.includes('Hello') && srt.includes('World'));
  assert.ok(/^1\r?\n/.test(srt), 'SRT requires a cue index line');
}

function testAlreadySrtPassesThrough() {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n';
  assert.strictEqual(convert(srt), srt, 'a downloaded .srt is served as-is, not round-tripped');
  assert.strictEqual(convert(''), '');
}

// The fallback path matters more than it looks: subtitle files are written progressively
// while the torrent downloads, so the parser sees truncated input regularly.
function testLegacyFallbackStripsCueSettings() {
  const vtt = 'WEBVTT\n\nNOTE this is a comment\n\ncue-id-7\n00:00:01.000 --> 00:00:02.500 align:start position:10%\nStyled line\n\n00:00:03.000 --> 00:00:0';
  const srt = StreamManager.prototype._legacyVttToSrt(vtt);
  assert.ok(!/align:start/.test(srt), 'WebVTT cue settings must not survive — a TV reads them as part of the timestamp');
  assert.ok(!/NOTE/.test(srt), 'NOTE blocks are not cues');
  assert.ok(!/cue-id-7/.test(srt), 'a WebVTT cue identifier is not an SRT index');
  assert.ok(srt.includes('1\n00:00:01,000 --> 00:00:02,500\nStyled line'));
  assert.ok(!/00:00:0$/.test(srt), 'the truncated trailing cue has no text and is dropped');
}

// The question this answers: a subtitle exists but the auto-sync has NOT corrected its
// timing yet — what does the TV get? It gets the subtitle immediately, at its original
// timing. Waiting would be worse: the sync needs a warm cache and takes minutes, so
// "wait for perfect" means a TV showing no subtitles at all for the first act.
//
// The corrected file replaces the same track IN PLACE at the same index, so nothing about
// the URL changes — which is exactly why a TV, having fetched its sidecar once at load,
// keeps showing the stale one. The signature is the only evidence that happened.
function testUncorrectedSubtitleIsSentNowAndTheFixIsDetectedLater() {
  const beforeSync = Object.assign({}, EXTERNAL, { name: 'External Subtitle' });
  assert.strictEqual(
    H.dlnaSubtitleUrlFor(H.resolveDlnaSubtitleTrack([beforeSync], null)),
    beforeSync.srtContentId,
    'an unsynced subtitle still goes to the TV — no subtitles is the worse failure'
  );

  // The auto-sync lands: same trackId, same URL, new label.
  const afterSync = Object.assign({}, EXTERNAL, { name: 'External Subtitle (auto-synced)' });
  assert.strictEqual(
    H.dlnaSubtitleUrlFor(H.resolveDlnaSubtitleTrack([afterSync], null)),
    beforeSync.srtContentId,
    'the URL is unchanged by the fix — so the TV has no reason to re-fetch on its own'
  );
  assert.notStrictEqual(
    H.dlnaSubtitleSignature(beforeSync), H.dlnaSubtitleSignature(afterSync),
    'the signature is what tells us the TV is now holding a stale copy'
  );

  // And a cast started AFTER the sync finished needs no re-send at all: resolving from a
  // fresh manifest already yields the corrected file.
  assert.strictEqual(
    H.resolveDlnaSubtitleTrack([afterSync], null).name, 'External Subtitle (auto-synced)',
    'casting after the fix picks up the corrected track with no extra step'
  );
}

// Auto-sync corrects ONE thing (the downloaded subtitle) and every playback target has to
// end up with it. Chromecast nearly didn't: its reload poller is gated on a stage counter
// derived from `complete`, and a downloaded subtitle is complete the moment it lands — so
// it started at the FINAL stage and the poller never fired again. The corrected timing
// reached the web player, VLC and the TV, and Chromecast alone kept the old file.
//
// The fix folds the track's label into the reload key, because that is what moves when
// the sync lands. This tests the key, which is the whole of the decision.
function testCastReloadKeyNoticesAnAutoSync() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf('function castSubtitleReloadKey');
  assert.notStrictEqual(start, -1, 'castSubtitleReloadKey not found');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, src.indexOf('\n}', start) + 2), ctx);

  const before = ctx.castSubtitleReloadKey('2', { name: 'External Subtitle' });
  const after = ctx.castSubtitleReloadKey('2', { name: 'External Subtitle (auto-synced)' });
  assert.notStrictEqual(before, after, 'a relabelled track must reset the poller, or Chromecast keeps the stale file');
  assert.strictEqual(ctx.castSubtitleReloadKey('2', { name: 'External Subtitle' }), before, 'stable while nothing changes — no reload loop');

  // Both reload pollers (web sender + native bridge) must compare against the key, not
  // the bare track id. A bare `=== sel` is the bug this replaced.
  const compares = src.match(/castTvState\.subtitleReloadKey === /g) || [];
  assert.strictEqual(compares.length, 2, 'both cast reload pollers should do this comparison');
  assert.ok(!/castTvState\.subtitleReloadKey === sel\b/.test(src), 'comparing against the bare track id is the regression');
}

// Why DLNA has a picker at all, when Chromecast does not need one.
//
// MEASURED, not assumed: a DIDL carrying three subtitle <res> elements (plus a
// sec:CaptionInfoEx each) was sent to an LG webOS QNED816RA. It accepted the payload and
// played, and the access log of the file server shows it fetched ONLY the first subtitle
// URL — the other two were never requested. AVTransport has no track list to switch
// between either. So DLNA gets exactly one sidecar, chosen up front.
//
// Chromecast is the opposite: it takes a real track array, so every ready track is sent
// and the selection only decides which starts active. Withholding tracks there would
// leave the TV's own subtitle menu empty for no reason.
function testDlnaSendsOneChromecastSendsAll() {
  const caster = fs.readFileSync(path.join(__dirname, '..', 'core', 'dlna-caster.js'), 'utf8');
  assert.ok(/function buildDidl\(mediaUrl, title, subtitleUrl\)/.test(caster),
    'buildDidl takes a single subtitleUrl — a list would imply a capability the TV does not have');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // The Chromecast track list must NOT be gated on a track being selected: that gate is
  // what used to send zero tracks when the viewer chose "off".
  assert.ok(!/if \(wantSubs && readyOnly\.length > 0\)/.test(app),
    'Chromecast must build its track list from every ready track, not only when one is picked');
  assert.ok(/const wantSubs = /.test(app) && /if \(wantSubs\b/.test(app),
    'wantSubs should still gate activeTrackIds — "off at start" must mean off, just not withheld');
}

// The route itself lives inside a closure in startStreamingServer, which cannot be reached
// without TorrServer and a real torrent — so this one check is STATIC, in the spirit of
// inline-handlers.test.js. It proves the two ends agree: the manifest advertises an .srt
// twin, and the route that serves subtitles accepts that extension. A mismatch here is a
// 404 on the TV and a silent no-subtitle cast, which is exactly the failure being fixed.
function testSrtRouteAndManifestAgree() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'uplayer.js'), 'utf8');
  assert.ok(
    /req\.url\.match\(\/\^\\\/subtitle_\(\\d\+\)\\\.\(vtt\|srt\)/.test(src),
    'the subtitle route must serve both .vtt and .srt'
  );
  assert.ok(/srtUrl: `\$\{this\.streamBasePath \|\| ''\}\/subtitle_\$\{index\}\.srt`/.test(src),
    '/api/subtitles must advertise the .srt twin the DLNA card reads');
}

function main() {
  testDownloadedSubtitleIsTheDefault();
  testEmbeddedOnlyStreamSendsNothing();
  testExplicitChoiceWins();
  testSidecarUrlIsSrt();
  testSignatureMovesWhenAutoSyncRenamesTheTrack();
  testUncorrectedSubtitleIsSentNowAndTheFixIsDetectedLater();
  testCastReloadKeyNoticesAnAutoSync();
  testDlnaSendsOneChromecastSendsAll();
  testSrtRouteAndManifestAgree();
  testVttToSrt();
  testAlreadySrtPassesThrough();
  testLegacyFallbackStripsCueSettings();
  console.log('dlna-subtitle.test.js passed');
}

main();
