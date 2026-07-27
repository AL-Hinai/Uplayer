'use strict';

// The concurrent-streams gate. The bug under test: renderStreamPage adopted THE
// first running session unconditionally, so clicking Watch on movie B while movie A
// streamed hijacked the wizard into A's step 4 — the backend's multi-session
// support (UPLAYER_MAX_STREAMS) was unreachable from the UI. adoptableSession()
// must attach only when the route is bare (reload/nav) or names the SAME title,
// and return null otherwise so a second session starts.

const assert = require('assert');
const { adoptableSession } = require('../public/js/session-adopt');

function session(id, media, extra = {}) {
  return { id, running: true, exited: false, media, ...extra };
}
const movieA = () => session('a', { type: 'movie', tmdbId: 100, title: 'Movie A' });
const movieB = () => session('b', { type: 'movie', tmdbId: 200, title: 'Movie B' });
const showS1E1 = () => session('tv1', { type: 'tv', tmdbId: 300, season: 1, episode: 1 });

function testBarePageAttachesToFirstRunning() {
  assert.strictEqual(adoptableSession([movieA(), movieB()], {}).id, 'a',
    'reload / nav click keeps the old behaviour — never spawn a duplicate');
  assert.strictEqual(adoptableSession([], {}), null);
  assert.strictEqual(adoptableSession(null, null), null);
}

function testDifferentTitleStartsASecondSession() {
  const picked = adoptableSession([movieA()], { type: 'movie', tmdbId: '200' });
  assert.strictEqual(picked, null,
    'Watch on movie B while A streams → null → the wizard starts session #2 — THE fix');
}

function testSameTitleIsAdoptedNotDuplicated() {
  assert.strictEqual(adoptableSession([movieA()], { type: 'movie', tmdbId: '100' }).id, 'a',
    'clicking Watch on the title already streaming re-attaches instead of duplicating');
  // tmdbId arrives as a route STRING but is stored as a number — must still match.
  assert.strictEqual(adoptableSession([movieA()], { tmdbId: 100 }).id, 'a');
}

function testEpisodesAreDistinctTitles() {
  assert.strictEqual(adoptableSession([showS1E1()], { tmdbId: '300', season: 1, episode: 2 }), null,
    'S1E2 while S1E1 streams is a NEW stream (binge normally stops first, but a manual click must not hijack)');
  assert.strictEqual(adoptableSession([showS1E1()], { tmdbId: '300', season: 1, episode: 1 }).id, 'tv1',
    'the exact same episode re-attaches');
  assert.strictEqual(adoptableSession([showS1E1()], { tmdbId: '300' }).id, 'tv1',
    'route without s/e cannot disagree with the session — attach');
}

function testUnknownMediaIsNeverAdoptedForExplicitRequests() {
  const anon = session('x', null);
  assert.strictEqual(adoptableSession([anon], { tmdbId: '100' }), null,
    'a wrong duplicate is recoverable; hijacking a different movie is the bug this replaces');
  assert.strictEqual(adoptableSession([anon], {}).id, 'x', 'bare page still attaches to it');
}

function testExplicitSessionIdIsExactMatchOrNothing() {
  const both = [movieA(), movieB()];
  assert.strictEqual(adoptableSession(both, { sessionId: 'b' }).id, 'b',
    '"Manage" on a row attaches to exactly that session');
  assert.strictEqual(adoptableSession(both, { sessionId: 'b', tmdbId: '100' }).id, 'b',
    'sessionId outranks a title in the same route');
  assert.strictEqual(adoptableSession(both, { sessionId: 'gone' }), null,
    'a stopped session is never silently substituted — that would be the hijack again');
}

function testExitedSessionsAreInvisible() {
  const dead = session('d', { tmdbId: 100 }, { running: false, exited: true });
  assert.strictEqual(adoptableSession([dead], {}), null);
  assert.strictEqual(adoptableSession([dead, movieB()], { tmdbId: '200' }).id, 'b',
    'match search skips corpses');
}

function main() {
  testBarePageAttachesToFirstRunning();
  testDifferentTitleStartsASecondSession();
  testSameTitleIsAdoptedNotDuplicated();
  testEpisodesAreDistinctTitles();
  testUnknownMediaIsNeverAdoptedForExplicitRequests();
  testExplicitSessionIdIsExactMatchOrNothing();
  testExitedSessionsAreInvisible();
  console.log('session-adopt.test.js passed');
}

main();
