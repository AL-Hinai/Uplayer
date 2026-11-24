'use strict';

// The sync loop, with no network. The properties that matter are the ones that only show up on
// a bad day: being offline must cost nothing and lose nothing, a device that has been away must
// never publish its stale view over everyone else's, and two devices uploading at the same
// moment must both survive.

const assert = require('assert');
const { createCloudSync } = require('../core/cloud-sync');

const T1 = 1_700_000_000_000;
const T2 = T1 + 60_000;

// --- doubles -----------------------------------------------------------------

function memoryStore(initial) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    read: () => JSON.parse(JSON.stringify(data)),
    write: (next) => { data = JSON.parse(JSON.stringify(next)); },
    peek: () => data,
  };
}

function memoryMeta(initial = { version: 0, lastPushedAt: 0 }) {
  let state = { ...initial };
  return { read: () => ({ ...state }), write: (next) => { state = { ...next }; }, peek: () => state };
}

/**
 * A stand-in for the one libraries row, honouring the version guard exactly as the
 * compare-and-swap in Postgres does.
 *
 * Note what it is NOT: a database. The client is an interface of four calls
 * (core/cloud-sync.js), so this double answers those four and nothing else. That is what
 * let the real backend move from Turso to Supabase without a line of this file changing
 * below the doubles.
 */
function fakeDb(initialRow = null) {
  const state = { row: initialRow, beforeUpdate: null, fail: null };
  const calls = [];
  const enter = (name) => {
    calls.push(name);
    if (state.fail) throw new Error(state.fail);
  };
  const client = {
    isConfigured: () => true,
    isSignedIn: () => true,
    async readVersion() {
      enter('readVersion');
      return state.row ? state.row.version : 0;
    },
    async readLibrary() {
      enter('readLibrary');
      return state.row ? { json: state.row.json, version: state.row.version } : null;
    },
    async insertLibrary(userId, json) {
      enter('insertLibrary');
      // A row already there means another device inserted first; the caller re-reads.
      if (state.row) return false;
      state.row = { json, version: 1 };
      return true;
    },
    async updateLibrary(userId, json, expectedVersion) {
      enter('updateLibrary');
      // The hook that lets a test commit a rival write in the gap between read and write.
      if (state.beforeUpdate) { const fn = state.beforeUpdate; state.beforeUpdate = null; fn(); }
      if (!state.row || state.row.version !== expectedVersion) return false;
      state.row = { json, version: expectedVersion + 1 };
      return true;
    },
    state,
    calls,
  };
  return client;
}

const EMPTY_HISTORY = { movies: {}, tvShows: {}, deleted: {} };
const EMPTY_RECS = { watchlist: { movie: {}, tv: {} }, interactions: [], profile: {}, deleted: {} };

function harness({ history, recommendations, remoteRow, meta } = {}) {
  const historyStore = memoryStore(history || EMPTY_HISTORY);
  const recommendationStore = memoryStore(recommendations || EMPTY_RECS);
  const client = fakeDb(remoteRow || null);
  const metaStore = meta || memoryMeta();
  const events = [];
  const sync = createCloudSync({
    client,
    historyStore,
    recommendationStore,
    meta: metaStore,
    userId: 'usr_sara',
    onEvent: (name, payload) => events.push([name, payload]),
  });
  return { sync, client, historyStore, recommendationStore, meta: metaStore, events };
}

function remoteLibrary(history, version = 4) {
  return {
    version,
    json: JSON.stringify({ history: { ...EMPTY_HISTORY, ...history }, recommendations: EMPTY_RECS }),
  };
}

// --- the cheap path ----------------------------------------------------------

async function testIdleSyncCostsOneQuery() {
  const h = harness({
    remoteRow: remoteLibrary({}, 4),
    meta: memoryMeta({ version: 4, lastPushedAt: Date.now() }),
  });
  const result = await h.sync.syncOnce();
  assert.deepStrictEqual(result, { unchanged: true, version: 4 });
  assert.strictEqual(h.client.calls.length, 1, 'nothing to send and nothing new: one version check, no download');
}

// --- offline -----------------------------------------------------------------

async function testOfflineLosesNothing() {
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} },
  });
  h.client.state.fail = 'getaddrinfo ENOTFOUND db.turso.io';

  const result = await h.sync.syncOnce();
  assert.ok(result.error, 'a network failure is reported, not thrown');
  assert.strictEqual(h.meta.peek().lastPushedAt, 0, 'a failed sync must NOT advance the watermark');
  assert.ok(h.historyStore.peek().movies['1'], 'the local library is untouched');
  assert.strictEqual(h.events[0][0], 'sync_failed');
}

// --- the headline rule -------------------------------------------------------

async function testStaleDeviceUploadsTheMergedLibraryNotItsOwn() {
  // This device sat offline at S2E3 while another reached S5E10. What it uploads must be the
  // merged S5E10 — uploading its own view would publish a regression every other device then
  // reads as fact.
  const h = harness({
    history: {
      movies: {},
      tvShows: { 1399: { tmdbId: 1399, lastSeason: 2, lastEpisode: 3, updatedAt: T2 } },
      deleted: {},
    },
    remoteRow: remoteLibrary({
      tvShows: { 1399: { tmdbId: 1399, lastSeason: 5, lastEpisode: 10, updatedAt: T1 } },
    }),
  });

  await h.sync.syncOnce();
  const uploaded = JSON.parse(h.client.state.row.json);
  assert.strictEqual(uploaded.history.tvShows['1399'].lastSeason, 5, 'the uploaded library must carry the furthest marker');
  assert.strictEqual(uploaded.history.tvShows['1399'].lastEpisode, 10);
  assert.strictEqual(h.historyStore.peek().tvShows['1399'].lastSeason, 5, 'and the local copy is corrected too');
}

async function testRemoteChangesArriveLocally() {
  const h = harness({
    remoteRow: remoteLibrary({ movies: { 603: { tmdbId: 603, title: 'The Matrix', updatedAt: T2 } } }),
  });
  await h.sync.syncOnce();
  assert.strictEqual(h.historyStore.peek().movies['603'].title, 'The Matrix');
  assert.strictEqual(h.meta.peek().version, 5, 'the local version tracks the row it wrote');
}

// --- concurrency -------------------------------------------------------------

async function testAnotherDeviceWinningTheRaceCausesAReMerge() {
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} },
    remoteRow: remoteLibrary({}, 4),
  });

  // Simulate a different device committing in the gap between our read and our write: the
  // version moves on, so our UPDATE matches nothing.
  h.client.state.beforeUpdate = () => {
    h.client.state.row = remoteLibrary({ movies: { 999: { tmdbId: 999, updatedAt: T2 } } }, 5);
  };

  const result = await h.sync.syncOnce();
  assert.ok(result.uploaded, 'the retry must succeed rather than give up');
  const uploaded = JSON.parse(h.client.state.row.json);
  assert.ok(uploaded.history.movies['1'], 'our change survives');
  assert.ok(uploaded.history.movies['999'], "and so does the other device's — nothing is overwritten");
  assert.ok(h.events.some(([name]) => name === 'sync_retry'));
}

async function testRelentlessLosingGivesUpWithoutClobbering() {
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} },
    remoteRow: remoteLibrary({ movies: { 999: { tmdbId: 999, updatedAt: T2 } } }, 4),
  });
  // Every attempt loses: the version keeps moving underneath us.
  const bump = () => {
    h.client.state.row = { ...h.client.state.row, version: h.client.state.row.version + 1 };
    h.client.state.beforeUpdate = bump;
  };
  h.client.state.beforeUpdate = bump;

  const result = await h.sync.syncOnce();
  assert.ok(result.error, 'giving up is reported');
  const stillThere = JSON.parse(h.client.state.row.json);
  assert.ok(stillThere.history.movies['999'], "the other device's library is intact — we never overwrote it");
  assert.strictEqual(h.meta.peek().lastPushedAt, 0, 'and our edits stay pending');
}

// --- robustness --------------------------------------------------------------

async function testFirstUploadCreatesTheRow() {
  const h = harness({ history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} } });
  const result = await h.sync.syncOnce();
  assert.ok(result.uploaded);
  assert.strictEqual(h.client.state.row.version, 1);
  assert.ok(h.client.calls.some((c) => c === 'insertLibrary'));
}

async function testCorruptRemoteDoesNotWedgeTheAccount() {
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} },
    remoteRow: { version: 3, json: '{not json' },
  });
  const result = await h.sync.syncOnce();
  assert.ok(result.uploaded, 'an unreadable remote must not stop the account working');
  assert.ok(h.events.some(([name]) => name === 'sync_warning'));
  assert.ok(JSON.parse(h.client.state.row.json).history.movies['1'], 'the local library replaces it');
}

async function testLocalWriteDuringDownloadIsNotLost() {
  // Playback writes progress continuously. An update landing while the download is in flight
  // must survive — merging against a snapshot taken before the download would erase it.
  const h = harness({ remoteRow: remoteLibrary({ movies: { 603: { tmdbId: 603, updatedAt: T1 } } }) });

  const realRead = h.historyStore.read;
  let injected = false;
  h.historyStore.read = () => {
    const data = realRead();
    if (!injected) {
      injected = true;
      const live = realRead();
      live.movies['777'] = { tmdbId: 777, updatedAt: Date.now() };
      h.historyStore.write(live);
    }
    return data;
  };

  await h.sync.syncOnce();
  assert.ok(h.historyStore.peek().movies['777'], 'the write that landed mid-sync must still be there');
  assert.ok(JSON.parse(h.client.state.row.json).history.movies['777'], 'and must reach the cloud');
}

async function testAFutureTimestampCannotSuppressLaterEdits() {
  // A device whose clock runs fast stamps entries in the future, and those entries reach
  // every other device through the merge. If the watermark were allowed to follow them past
  // real time, every genuine local edit after that would look "already sent" and never
  // upload — which is exactly how a delete went missing in end-to-end testing.
  const future = Date.now() + 5 * 60_000;
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: future } }, tvShows: {}, deleted: {} },
  });

  await h.sync.syncOnce();
  assert.ok(h.meta.peek().lastPushedAt <= Date.now(), 'the watermark must never run ahead of the clock');

  // A perfectly ordinary edit made right now must still be seen as pending.
  const db = h.historyStore.peek();
  db.movies['2'] = { tmdbId: 2, updatedAt: Date.now() };
  h.historyStore.write(db);
  const result = await h.sync.syncOnce();
  assert.ok(result.uploaded, 'the later edit must still sync');
  assert.ok(JSON.parse(h.client.state.row.json).history.movies['2'], 'and must reach the cloud');
}

async function testConcurrentCallsCoalesceRatherThanSkip() {
  // Signing in starts the background loop immediately, so the "Sync now" button lands on top
  // of a sync already running. Refusing that caller made the button look broken AND let it
  // return before the data it was waiting for had arrived.
  const h = harness({
    history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} },
    remoteRow: remoteLibrary({ movies: { 603: { tmdbId: 603, updatedAt: T1 } } }),
  });

  const [first, second] = await Promise.all([h.sync.syncOnce(), h.sync.syncOnce()]);
  assert.deepStrictEqual(second, first, 'the second caller must receive the first sync\'s result');
  assert.ok(first.uploaded);
  assert.ok(h.historyStore.peek().movies['603'], 'and the data really is there when it returns');
}

async function testUnconfiguredSyncIsASilentNoOp() {
  const h = harness();
  h.sync.userId = null;
  const result = await h.sync.syncOnce();
  assert.deepStrictEqual(result, { skipped: 'not-configured' });
  assert.strictEqual(h.client.calls.length, 0, 'no profile selected means no requests at all');
}

async function testPendingIsCachedNotRecomputedPerCall() {
  // A status route polls this; reading both library files off disk every second is not free.
  const h = harness({ history: { movies: { 1: { tmdbId: 1, updatedAt: T2 } }, tvShows: {}, deleted: {} } });
  let reads = 0;
  const realRead = h.historyStore.read;
  h.historyStore.read = () => { reads += 1; return realRead(); };

  await h.sync.syncOnce();
  const before = reads;
  h.sync.status(); h.sync.status(); h.sync.status();
  assert.strictEqual(reads, before, 'status() must not touch the stores');
}

async function main() {
  await testIdleSyncCostsOneQuery();
  await testOfflineLosesNothing();
  await testStaleDeviceUploadsTheMergedLibraryNotItsOwn();
  await testRemoteChangesArriveLocally();
  await testAnotherDeviceWinningTheRaceCausesAReMerge();
  await testRelentlessLosingGivesUpWithoutClobbering();
  await testFirstUploadCreatesTheRow();
  await testCorruptRemoteDoesNotWedgeTheAccount();
  await testLocalWriteDuringDownloadIsNotLost();
  await testAFutureTimestampCannotSuppressLaterEdits();
  await testConcurrentCallsCoalesceRatherThanSkip();
  await testUnconfiguredSyncIsASilentNoOp();
  await testPendingIsCachedNotRecomputedPerCall();
  console.log('cloud-sync.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
