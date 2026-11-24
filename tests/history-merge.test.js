'use strict';

// Two devices editing one account's library apart from each other. The bug this file exists
// to prevent: a phone that last synced at S2E3 has a NEWER timestamp than a PC sitting on
// S5E10, so last-write-wins would hand the phone the win and silently un-watch thirty
// episodes — no error, no log line, just progress quietly gone. Every rule below is a case
// where blanket LWW gives the wrong answer.

const assert = require('assert');
const {
  mergeHistoryEntry,
  mergeWatchlistEntry,
  mergeInteractions,
  collectLocalChanges,
  applyRemoteChanges,
  pruneTombstones,
  TOMBSTONE_TTL_MS,
  _internals,
} = require('../core/history-merge');

const T1 = 1_700_000_000_000;
const T2 = T1 + 60_000;
const T3 = T2 + 60_000;

function snapshot(overrides = {}) {
  return {
    history: { movies: {}, tvShows: {}, deleted: {}, ...(overrides.history || {}) },
    recommendations: {
      watchlist: { movie: {}, tv: {} },
      interactions: [],
      profile: { updatedAt: null, totalSignalWeight: 0 },
      deleted: {},
      ...(overrides.recommendations || {}),
    },
  };
}

// --- the headline rule -------------------------------------------------------

function testFurthestEpisodeNeverRegresses() {
  const pc = { tmdbId: 1399, lastSeason: 5, lastEpisode: 10, updatedAt: T1 };
  const phone = { tmdbId: 1399, lastSeason: 2, lastEpisode: 3, updatedAt: T3 };

  const merged = mergeHistoryEntry(pc, phone);
  assert.strictEqual(merged.lastSeason, 5, 'a newer device must not drag the season marker back');
  assert.strictEqual(merged.lastEpisode, 10);

  // ...and the same result whichever side reports first.
  const reversed = mergeHistoryEntry(phone, pc);
  assert.strictEqual(reversed.lastSeason, 5);
  assert.strictEqual(reversed.lastEpisode, 10);
}

function testFurthestEpisodeStillAdvances() {
  const pc = { tmdbId: 1399, lastSeason: 5, lastEpisode: 10, updatedAt: T1 };
  const phone = { tmdbId: 1399, lastSeason: 6, lastEpisode: 1, updatedAt: T3 };
  const merged = mergeHistoryEntry(pc, phone);
  assert.strictEqual(merged.lastSeason, 6, 'genuine forward progress must still win');
  assert.strictEqual(merged.lastEpisode, 1);
}

function testResetProgressIsNotUndoneByTheMaxRule() {
  // "Reset progress" is the one edit that legitimately moves the marker backwards. Without
  // its own timestamp, the max rule would restore S5E10 from the other device and silently
  // undo the button the user just pressed.
  const pc = { tmdbId: 1399, lastSeason: 5, lastEpisode: 10, updatedAt: T1 };
  const phoneAfterReset = { tmdbId: 1399, updatedAt: T3, progressResetAt: T3 };

  const merged = mergeHistoryEntry(pc, phoneAfterReset);
  assert.strictEqual(merged.lastSeason, undefined, 'a reset must survive the sync');
  assert.strictEqual(merged.lastEpisode, undefined);
  assert.strictEqual(merged.progressResetAt, T3, 'and must propagate to other devices');
}

function testWatchingAfterAResetStillCounts() {
  const reset = { tmdbId: 1399, updatedAt: T1, progressResetAt: T1 };
  const watchedSince = { tmdbId: 1399, lastSeason: 1, lastEpisode: 2, updatedAt: T3 };
  const merged = mergeHistoryEntry(reset, watchedSince);
  assert.strictEqual(merged.lastEpisode, 2, 'progress made after the reset must be kept');
}

// --- playhead ----------------------------------------------------------------

function testNewestProgressWins() {
  const a = { updatedAt: T1, progress: { positionSec: 100, updatedAt: new Date(T1).toISOString() } };
  const b = { updatedAt: T3, progress: { positionSec: 900, updatedAt: new Date(T3).toISOString() } };
  assert.strictEqual(mergeHistoryEntry(a, b).progress.positionSec, 900);
}

function testCompletionBeatsStalePosition() {
  // Crossing 90% CLEARS progress (history-store.js:133). That absence is an assertion, not a
  // gap: LWW on the object would resurrect the old playhead on a finished episode.
  const watching = { updatedAt: T1, progress: { positionSec: 300, updatedAt: new Date(T1).toISOString() } };
  const finished = { updatedAt: T3, lastSeason: 1, lastEpisode: 4 };
  const merged = mergeHistoryEntry(watching, finished);
  assert.strictEqual(merged.progress, undefined, 'a completed episode must not keep a resume point');
  assert.strictEqual(merged.lastEpisode, 4);
}

function testEqualProgressTimestampsTakeFurtherPosition() {
  const iso = new Date(T2).toISOString();
  const a = { updatedAt: T2, progress: { positionSec: 120, updatedAt: iso } };
  const b = { updatedAt: T2, progress: { positionSec: 480, updatedAt: iso } };
  assert.strictEqual(mergeHistoryEntry(a, b).progress.positionSec, 480);
  assert.strictEqual(mergeHistoryEntry(b, a).progress.positionSec, 480, 'tie-break must not depend on argument order');
}

function testRewatchProgressBeforeTheMarkerSurvives() {
  // Finished S5E10, now rewatching S2E3. progress BEFORE the furthest marker is legitimate
  // and must not be treated as stale.
  const entry = {
    updatedAt: T3,
    lastSeason: 5,
    lastEpisode: 10,
    progress: { season: 2, episode: 3, positionSec: 200, updatedAt: new Date(T3).toISOString() },
  };
  const other = { updatedAt: T1, lastSeason: 5, lastEpisode: 10 };
  const merged = mergeHistoryEntry(other, entry);
  assert.strictEqual(merged.progress.episode, 3);
  assert.strictEqual(merged.lastEpisode, 10);
}

// --- fields the newer side may simply not carry ------------------------------

function testOmittedFieldsAreLiftedAcross() {
  // markWatched replaces an entry wholesale and lifts lastPlayback across for exactly this
  // reason (history-store.js:43) — a write that omits a field is not asserting its absence.
  const rich = {
    updatedAt: T1,
    tracking: false,
    lastPlayback: { source: 'magnet:?xt=x', savedAt: new Date(T1).toISOString() },
    poster_path: '/poster.jpg',
  };
  const bare = { updatedAt: T3, tmdbId: 1399 };
  const merged = mergeHistoryEntry(rich, bare);
  assert.strictEqual(merged.tracking, false, 'tracking must survive a write that omits it');
  assert.ok(merged.lastPlayback, 'resume source must survive');
  assert.strictEqual(merged.poster_path, '/poster.jpg', 'artwork must never be lost');
}

function testLegacyEntriesWithoutUpdatedAtStillOrder() {
  // Entries written before this module existed carry only watchedAt.
  const old = { watchedAt: new Date(T1).toISOString(), lastSeason: 1, lastEpisode: 1 };
  const recent = { watchedAt: new Date(T3).toISOString(), lastSeason: 1, lastEpisode: 6 };
  assert.strictEqual(_internals.entryUpdatedAt(old), T1);
  assert.strictEqual(mergeHistoryEntry(old, recent).lastEpisode, 6);
}

// --- watchlist + interactions ------------------------------------------------

function testWatchlistIsLastWriteWins() {
  const a = { tmdbId: 5, title: 'A', updatedAt: T1 };
  const b = { tmdbId: 5, title: 'A (renamed)', updatedAt: T3 };
  assert.strictEqual(mergeWatchlistEntry(a, b).title, 'A (renamed)');
}

function testInteractionsUnionRatherThanReplace() {
  const local = [
    { createdAt: new Date(T1).toISOString(), eventType: 'detail_click', type: 'movie', tmdbId: 1 },
    { createdAt: new Date(T2).toISOString(), eventType: 'stream_start', type: 'movie', tmdbId: 2 },
  ];
  const remote = [
    { createdAt: new Date(T2).toISOString(), eventType: 'stream_start', type: 'movie', tmdbId: 2 }, // dupe
    { createdAt: new Date(T3).toISOString(), eventType: 'watchlist_add', type: 'tv', tmdbId: 3 },
  ];
  const merged = mergeInteractions(local, remote);
  assert.strictEqual(merged.length, 3, 'an append-only log has gaps, not conflicts');
  assert.deepStrictEqual(merged.map((i) => i.tmdbId), [1, 2, 3], 'sorted by createdAt');
}

function testInteractionsRespectTheCap() {
  const many = Array.from({ length: 30 }, (_, i) => ({
    createdAt: new Date(T1 + i * 1000).toISOString(),
    eventType: 'detail_click',
    type: 'movie',
    tmdbId: i,
  }));
  const merged = mergeInteractions(many, [], 10);
  assert.strictEqual(merged.length, 10);
  assert.strictEqual(merged[9].tmdbId, 29, 'the cap must keep the NEWEST events');
}

// --- changesets --------------------------------------------------------------

function testCollectOnlySendsWhatChanged() {
  const snap = snapshot();
  snap.history.movies['1'] = { tmdbId: 1, updatedAt: T1 };
  snap.history.movies['2'] = { tmdbId: 2, updatedAt: T3 };
  snap.history.deleted = { movie: { 9: T3 } };

  const changes = collectLocalChanges(snap, T2);
  const ids = changes.map((c) => `${c.kind}:${c.itemId}:${c.deleted}`).sort();
  assert.deepStrictEqual(ids, ['movie:2:false', 'movie:9:true'], 'only rows past the watermark, tombstones included');
}

function testDeleteOnlyWinsAgainstAnOlderCopy() {
  const snap = snapshot();
  snap.history.movies['7'] = { tmdbId: 7, updatedAt: T3 }; // re-added AFTER the remote delete

  const kept = applyRemoteChanges(snap, [{ kind: 'movie', itemId: '7', deleted: true, updatedAt: T1 }]);
  assert.ok(kept.history.movies['7'], 'a stale delete must not remove a newer re-add');

  const removed = applyRemoteChanges(snap, [{ kind: 'movie', itemId: '7', deleted: true, updatedAt: T3 + 1 }]);
  assert.strictEqual(removed.history.movies['7'], undefined);
  assert.strictEqual(removed.history.deleted.movie['7'], T3 + 1, 'the delete leaves a tombstone');
}

function testLocalTombstoneIsNotResurrected() {
  const snap = snapshot();
  snap.history.deleted = { movie: { 7: T3 } };
  const next = applyRemoteChanges(snap, [
    { kind: 'movie', itemId: '7', json: { tmdbId: 7 }, updatedAt: T1, deleted: false },
  ]);
  assert.strictEqual(next.history.movies['7'], undefined, 'a delete must not be undone by an older copy');
}

function testTombstoneYieldsToANewerReAdd() {
  const snap = snapshot();
  snap.history.deleted = { movie: { 7: T1 } };
  const next = applyRemoteChanges(snap, [
    { kind: 'movie', itemId: '7', json: { tmdbId: 7 }, updatedAt: T3, deleted: false },
  ]);
  assert.ok(next.history.movies['7'], 'a newer re-add must win');
  assert.strictEqual(next.history.deleted.movie['7'], undefined, 'and must clear the tombstone');
}

function testApplyIsIdempotentAndDoesNotMutateInput() {
  const snap = snapshot();
  snap.history.tvShows['1399'] = { tmdbId: 1399, lastSeason: 5, lastEpisode: 10, updatedAt: T1 };
  const changes = [
    { kind: 'tv', itemId: '1399', json: { tmdbId: 1399, lastSeason: 2, lastEpisode: 3 }, updatedAt: T3, deleted: false },
    { kind: 'watchlistTv', itemId: '99', json: { tmdbId: 99 }, updatedAt: T2, deleted: false },
  ];

  const once = applyRemoteChanges(snap, changes);
  const twice = applyRemoteChanges(once, changes);
  assert.deepStrictEqual(twice.history.tvShows, once.history.tvShows, 'replaying a batch must change nothing');
  assert.strictEqual(once.history.tvShows['1399'].lastEpisode, 10, 'merge rules apply to remote rows too');
  assert.ok(once.recommendations.watchlist.tv['99']);

  assert.strictEqual(snap.history.tvShows['1399'].lastSeason, 5, 'the input snapshot must be left alone');
  assert.deepStrictEqual(snap.recommendations.watchlist.tv, {});
}

function testTombstonesArePruned() {
  const deleted = { movie: { 1: T3, 2: T3 - TOMBSTONE_TTL_MS - 1 } };
  const pruned = pruneTombstones(deleted, T3);
  assert.deepStrictEqual(pruned, { movie: { 1: T3 } });
}

function main() {
  testFurthestEpisodeNeverRegresses();
  testFurthestEpisodeStillAdvances();
  testResetProgressIsNotUndoneByTheMaxRule();
  testWatchingAfterAResetStillCounts();
  testNewestProgressWins();
  testCompletionBeatsStalePosition();
  testEqualProgressTimestampsTakeFurtherPosition();
  testRewatchProgressBeforeTheMarkerSurvives();
  testOmittedFieldsAreLiftedAcross();
  testLegacyEntriesWithoutUpdatedAtStillOrder();
  testWatchlistIsLastWriteWins();
  testInteractionsUnionRatherThanReplace();
  testInteractionsRespectTheCap();
  testCollectOnlySendsWhatChanged();
  testDeleteOnlyWinsAgainstAnOlderCopy();
  testLocalTombstoneIsNotResurrected();
  testTombstoneYieldsToANewerReAdd();
  testApplyIsIdempotentAndDoesNotMutateInput();
  testTombstonesArePruned();
  console.log('history-merge.test.js passed');
}

main();
