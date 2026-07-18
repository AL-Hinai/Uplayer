'use strict';

const assert = require('assert');
const { PlaybackTarget, MIN_POSITION_SEC } = require('../core/playback-target');

function collect(kind) {
  const events = [];
  const target = new PlaybackTarget(kind, (event, data) => events.push({ event, data }));
  return { target, events };
}

// The noise floor has one definition now; every caller defers to it.
function testNoiseFloor() {
  const { target, events } = collect('web');

  assert.strictEqual(target.report({ state: 'playing', positionSec: 2, durationSec: 100 }), null,
    'a playhead under the floor is startup noise, not a resume point');
  assert.strictEqual(events.length, 0);

  const out = target.report({ state: 'playing', positionSec: MIN_POSITION_SEC, durationSec: 100 });
  assert.strictEqual(out.positionSec, 5);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].event, 'playback');
}

// The headline fix: VLC zeroes <time>/<length> on stop, so "did it finish?" can only be
// answered from the retained playhead.
function testVlcStopUsesRetainedPosition() {
  const { target } = collect('vlc');

  target.report({ state: 'playing', positionSec: 950, durationSec: 1000 });
  const out = target.report({ state: 'stopped', positionSec: 0, durationSec: 0 });

  assert.strictEqual(out.ended, true, 'stopped at 95% is a finish');
  assert.strictEqual(out.positionSec, 950, 'the stop report must not clobber the playhead');
  assert.strictEqual(out.durationSec, 1000);
}

function testVlcEarlyStopIsNotEnded() {
  const { target } = collect('vlc');

  target.report({ state: 'playing', positionSec: 100, durationSec: 1000 });
  const out = target.report({ state: 'stopped', positionSec: 0, durationSec: 0 });

  assert.strictEqual(out.ended, false, 'quitting at 10% is not a finish');
}

function testDlnaStopNearDurationEnds() {
  const { target } = collect('dlna');

  target.report({ state: 'playing', positionSec: 2850, durationSec: 3000 });
  const out = target.report({ state: 'stopped' });

  assert.strictEqual(out.ended, true);
}

// A renderer can report STOPPED in the seconds after SetAVTransportURI, before playback
// settles. Nothing has been retained yet, so there is no ratio and no false finish.
function testDlnaStopBeforePlaybackSettles() {
  const { target, events } = collect('dlna');

  assert.strictEqual(target.report({ state: 'stopped' }), null,
    'a stop with no playhead behind it says nothing');
  assert.strictEqual(events.length, 0);
}

// Chromecast is the only target with a truly unambiguous finish signal.
function testCastFinishedIsBelievedOverRatio() {
  const { target } = collect('cast');

  target.report({ state: 'playing', positionSec: 300, durationSec: 1000 });
  const out = target.report({ state: 'idle', ended: true });

  assert.strictEqual(out.ended, true, 'an explicit FINISHED beats the near-duration heuristic');
}

function testCastCancelledEarlyIsNotEnded() {
  const { target } = collect('cast');

  target.report({ state: 'playing', positionSec: 200, durationSec: 1000 });
  const out = target.report({ state: 'idle' });

  assert.strictEqual(out.ended, false);
}

// Seeking back after the credits used to leave `ended` stuck true for the session.
function testEndedUnsticks() {
  const { target } = collect('web');

  target.report({ state: 'playing', positionSec: 990, durationSec: 1000 });
  assert.strictEqual(target.report({ state: 'stopped' }).ended, true);

  const out = target.report({ state: 'playing', positionSec: 100, durationSec: 1000 });
  assert.strictEqual(out.ended, false, 'seeking back well before the end clears `ended`');
}

function testEndedSurvivesNearbySeek() {
  const { target } = collect('web');

  target.report({ state: 'playing', positionSec: 990, durationSec: 1000 });
  target.report({ state: 'stopped' });
  const out = target.report({ state: 'playing', positionSec: 900, durationSec: 1000 });

  assert.strictEqual(out.ended, true, 'nudging back into the credits is not a re-watch');
}

// Renderers report NOT_IMPLEMENTED for RelTime; the caller hands us null.
function testUnparseablePositionEmitsNothing() {
  const { target, events } = collect('dlna');

  assert.strictEqual(target.report({ state: 'playing', positionSec: null, durationSec: null }), null);
  assert.strictEqual(target.report({ state: 'playing', positionSec: NaN }), null);
  assert.strictEqual(events.length, 0);
}

function testUnknownStateIsIgnored() {
  const { target, events } = collect('vlc');
  assert.strictEqual(target.report({ state: 'TRANSITIONING', positionSec: 50, durationSec: 100 }), null);
  assert.strictEqual(events.length, 0);
}

// Without a duration there is no ratio, so `ended` can never be inferred — better a
// missed overlay than a wrong one.
function testNoDurationNeverInfersEnded() {
  const { target } = collect('vlc');

  target.report({ state: 'playing', positionSec: 900, durationSec: 0 });
  const out = target.report({ state: 'stopped' });

  assert.strictEqual(out.ended, false);
  assert.strictEqual(target.completionRatio(), null);
}

function testGoneIsTerminal() {
  const { target, events } = collect('vlc');

  target.report({ state: 'playing', positionSec: 100, durationSec: 1000 });
  assert.strictEqual(target.gone('closed'), true);
  assert.strictEqual(target.gone('closed'), false, 'gone fires once');
  assert.strictEqual(target.report({ state: 'playing', positionSec: 200, durationSec: 1000 }), null,
    'a dead target cannot be resurrected by a racing poll');

  const err = events.find((e) => e.event === 'playback_error');
  assert.strictEqual(err.data.reason, 'closed');
  assert.strictEqual(err.data.fatal, true);
  assert.strictEqual(err.data.positionSec, 100, 'the error carries the last known playhead');
}

// VLC's flags going to an already-running instance is an expected shrug, not a failure.
function testUnavailableIsNotFatal() {
  const { target, events } = collect('vlc');
  target.gone('unavailable');
  assert.strictEqual(events[0].data.fatal, false);
}

function testError() {
  const { target, events } = collect('web');
  target.report({ state: 'playing', positionSec: 60, durationSec: 1000 });
  assert.strictEqual(target.error({ code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }), true);

  const err = events.find((e) => e.event === 'playback_error');
  assert.strictEqual(err.data.code, 4);
  assert.strictEqual(err.data.kind, 'web');
  assert.strictEqual(err.data.fatal, true);
}

function main() {
  testNoiseFloor();
  testVlcStopUsesRetainedPosition();
  testVlcEarlyStopIsNotEnded();
  testDlnaStopNearDurationEnds();
  testDlnaStopBeforePlaybackSettles();
  testCastFinishedIsBelievedOverRatio();
  testCastCancelledEarlyIsNotEnded();
  testEndedUnsticks();
  testEndedSurvivesNearbySeek();
  testUnparseablePositionEmitsNothing();
  testUnknownStateIsIgnored();
  testNoDurationNeverInfersEnded();
  testGoneIsTerminal();
  testUnavailableIsNotFatal();
  testError();
  console.log('playback-target.test.js passed');
}

main();
