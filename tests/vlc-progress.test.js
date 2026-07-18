'use strict';

// Drives the REAL VLC poller against a fake VLC web interface. The unit tests in
// playback-target.test.js cover what a report MEANS; this covers the scrape and the
// wiring around it — that VLC's XML is parsed, that a stop actually reaches the target,
// and that `ended` lands on session.playback where auto-next-episode looks for it.
// Short of launching VLC, this is the closest thing to the real path.
//
// startVlcProgress returns its poll function so a scrape can be driven on demand
// instead of waiting out the 15s production interval.

const assert = require('assert');
const http = require('http');
const { _internals } = require('../server');

const { streamSessions, createStreamSession, startVlcProgress, stopExternalProgress } = _internals;

// Stands in for VLC's --extraintf=http interface. Each poll gets the next scripted
// response, so a whole watch can be played out: playing, playing, then stopped — with
// the zeroed counters VLC really does report on stop.
function fakeVlc(script) {
  let call = 0;
  const server = http.createServer((req, res) => {
    assert.strictEqual(req.url, '/requests/status.xml', 'the poller must hit VLC status.xml');
    assert.ok(String(req.headers.authorization || '').startsWith('Basic '), 'the poller must authenticate');
    const step = script[Math.min(call++, script.length - 1)];
    if (step === 'down') { res.socket.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<root><state>${step.state}</state><time>${step.time}</time><length>${step.length}</length></root>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, calls: () => call }));
  });
}

async function withSession(fn) {
  const session = createStreamSession();
  streamSessions.set(session.id, session);
  try {
    return await fn(session);
  } finally {
    stopExternalProgress(session);
    streamSessions.delete(session.id);
  }
}

// One scrape, awaited. The poll fn is callback-driven, so give the socket a beat.
function scrape(poll) {
  poll();
  return new Promise((resolve) => setTimeout(resolve, 120));
}

// THE headline fix: a film watched to the end in VLC must set `ended`, which is what
// maybeAutoAdvance gates on. Before the bridge, the poller dropped every non-'playing'
// state, so `ended` was never set and auto-next silently never fired outside the
// browser. VLC zeroes <time>/<length> on stop, so this only works if the target
// consults the playhead it retained while the film was running.
async function testFinishedFilmSetsEnded() {
  await withSession(async (session) => {
    const vlc = await fakeVlc([
      { state: 'playing', time: 950, length: 1000 },
      { state: 'stopped', time: 0, length: 0 },
    ]);
    const sse = [];
    session.lifecycle.onEvent = (event, data) => sse.push({ event, data });

    const poll = startVlcProgress(session, { port: vlc.port, password: 'secret' });
    await scrape(poll); // playing at 95%
    assert.strictEqual(session.playback.ended, false, 'still playing — not ended yet');
    assert.strictEqual(session.playback.positionSec, 950);

    await scrape(poll); // stopped
    assert.strictEqual(session.playback.ended, true,
      'a stop at 95% is a finish — this is what auto-next-episode gates on');
    assert.strictEqual(session.playback.positionSec, 950,
      "the stop's zeroed counters must not clobber the retained playhead");
    assert.ok(sse.some((e) => e.event === 'playback' && e.data.ended === true),
      'the finish must reach the UI over SSE, not just history');

    vlc.server.close();
  });
}

// The other half: stopping early is a real stop, not a finish.
async function testAbandonedFilmDoesNotSetEnded() {
  await withSession(async (session) => {
    const vlc = await fakeVlc([
      { state: 'playing', time: 100, length: 1000 },
      { state: 'stopped', time: 0, length: 0 },
    ]);
    const poll = startVlcProgress(session, { port: vlc.port, password: 'secret' });
    await scrape(poll);
    await scrape(poll);

    assert.strictEqual(session.playback.ended, false,
      'quitting 10% in must not trigger auto-next');
    assert.strictEqual(session.playback.positionSec, 100, 'but the resume point is still kept');
    vlc.server.close();
  });
}

// Paused used to be dropped on the floor along with stopped. It should still record a
// resume point, and must never read as a finish.
async function testPausedRecordsPositionWithoutEnding() {
  await withSession(async (session) => {
    const vlc = await fakeVlc([{ state: 'paused', time: 980, length: 1000 }]);
    const poll = startVlcProgress(session, { port: vlc.port, password: 'secret' });
    await scrape(poll);

    assert.strictEqual(session.playback.positionSec, 980);
    assert.strictEqual(session.playback.ended, false, 'pausing in the credits is not finishing');
    vlc.server.close();
  });
}

// VLC closed: the process is spawned detached with stdio ignored, so its interface
// going dark is the only signal we get. It should surface, not vanish silently.
async function testClosedVlcSurfacesAsFatal() {
  await withSession(async (session) => {
    const vlc = await fakeVlc([{ state: 'playing', time: 300, length: 1000 }, 'down']);
    const errors = [];
    session.lifecycle.onEvent = (event, data) => { if (event === 'playback_error') errors.push(data); };

    const poll = startVlcProgress(session, { port: vlc.port, password: 'secret' });
    await scrape(poll); // one good poll, so we know VLC was really there
    for (let i = 0; i < 4; i += 1) await scrape(poll); // then it dies

    assert.strictEqual(errors.length, 1, 'the user should be told once, not every poll');
    assert.strictEqual(errors[0].reason, 'closed');
    assert.strictEqual(errors[0].fatal, true);
    assert.strictEqual(errors[0].positionSec, 300, 'the error carries the last known playhead');
    vlc.server.close();
  });
}

// VLC that never had a web interface (flags went to an already-running instance) is an
// expected shrug — playback is fine, we just can't track it. Must not be fatal.
async function testUnreachableVlcIsNotFatal() {
  await withSession(async (session) => {
    const dead = await fakeVlc(['down']);
    const port = dead.port;
    dead.server.close();
    const errors = [];
    session.lifecycle.onEvent = (event, data) => { if (event === 'playback_error') errors.push(data); };

    const poll = startVlcProgress(session, { port, password: 'secret' });
    for (let i = 0; i < 4; i += 1) await scrape(poll);

    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].reason, 'unavailable',
      'never having reached VLC is different from VLC being closed');
    assert.strictEqual(errors[0].fatal, false, 'VLC is playing fine — do not alarm the user');
  });
}

// The bug behind the old single timer slot: two sessions tracked at once.
async function testConcurrentSessionsTrackIndependently() {
  await withSession(async (a) => {
    await withSession(async (b) => {
      const vlcA = await fakeVlc([{ state: 'playing', time: 111, length: 1000 }]);
      const vlcB = await fakeVlc([{ state: 'playing', time: 222, length: 1000 }]);

      const pollA = startVlcProgress(a, { port: vlcA.port, password: 'x' });
      const pollB = startVlcProgress(b, { port: vlcB.port, password: 'x' });
      await scrape(pollA);
      await scrape(pollB);

      assert.strictEqual(a.playback.positionSec, 111);
      assert.strictEqual(b.playback.positionSec, 222, 'one session must not stop the other');
      vlcA.server.close();
      vlcB.server.close();
    });
  });
}

async function main() {
  await testFinishedFilmSetsEnded();
  await testAbandonedFilmDoesNotSetEnded();
  await testPausedRecordsPositionWithoutEnding();
  await testClosedVlcSurfacesAsFatal();
  await testUnreachableVlcIsNotFatal();
  await testConcurrentSessionsTrackIndependently();
  console.log('vlc-progress.test.js passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
