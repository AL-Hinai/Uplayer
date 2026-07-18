'use strict';

// Verifies HistoryStore.updateProgress(): free-moving playhead progress for movies
// and TV, auto-creation of missing entries, completion at >=90% (clears progress and,
// for TV, folds the episode into the monotonic furthest-watched marker), and that
// resetProgress also clears the playhead marker.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../core/history-store');

function freshStore() {
  const file = path.join(os.tmpdir(), `uplayer-history-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return { store: new HistoryStore(file), file };
}

function main() {
  // Movie: partial progress is stored and moves freely (backwards too).
  {
    const { store, file } = freshStore();
    store.markWatched('movie', { tmdbId: 603, title: 'The Matrix' });
    store.updateProgress('movie', 603, { positionSec: 1200, durationSec: 8160 });
    let m = store.read().movies['603'];
    assert.strictEqual(m.progress.positionSec, 1200, 'movie position stored');
    assert.strictEqual(m.progress.durationSec, 8160, 'movie duration stored');

    store.updateProgress('movie', 603, { positionSec: 600, durationSec: 8160 });
    m = store.read().movies['603'];
    assert.strictEqual(m.progress.positionSec, 600, 'position moves backwards freely (not monotonic)');
    fs.unlinkSync(file);
  }

  // Movie: >=90% clears the progress marker (counts as completed).
  {
    const { store, file } = freshStore();
    store.updateProgress('movie', 604, { positionSec: 500, durationSec: 1000, item: { title: 'Reloaded' } });
    assert.ok(store.read().movies['604'].progress, 'progress exists at 50%');
    assert.strictEqual(store.read().movies['604'].title, 'Reloaded', 'missing entry auto-created from item');
    store.updateProgress('movie', 604, { positionSec: 950, durationSec: 1000 });
    assert.strictEqual(store.read().movies['604'].progress, undefined, '>=90% clears progress');
    fs.unlinkSync(file);
  }

  // TV: progress carries season/episode; completion advances the furthest-watched
  // marker monotonically (re-watching an older episode must NOT regress it).
  {
    const { store, file } = freshStore();
    store.markWatched('tv', { tmdbId: 1399, title: 'GoT', lastSeason: 3, lastEpisode: 5 });
    store.updateProgress('tv', 1399, { season: 3, episode: 6, positionSec: 300, durationSec: 3600 });
    let s = store.read().tvShows['1399'];
    assert.strictEqual(s.progress.season, 3, 'progress season stored');
    assert.strictEqual(s.progress.episode, 6, 'progress episode stored');
    assert.strictEqual(s.lastSeason, 3, 'furthest-watched untouched by partial progress');
    assert.strictEqual(s.lastEpisode, 5, 'furthest-watched untouched by partial progress');

    // Finish S3E6 → marker advances, progress clears.
    store.updateProgress('tv', 1399, { season: 3, episode: 6, positionSec: 3400, durationSec: 3600 });
    s = store.read().tvShows['1399'];
    assert.strictEqual(s.progress, undefined, 'completion clears TV progress');
    assert.strictEqual(s.lastEpisode, 6, 'completion advances furthest-watched');

    // Re-finish an OLDER episode → marker must stay at S3E6.
    store.updateProgress('tv', 1399, { season: 2, episode: 1, positionSec: 3400, durationSec: 3600 });
    s = store.read().tvShows['1399'];
    assert.strictEqual(s.lastSeason, 3, 'older completion does not regress season');
    assert.strictEqual(s.lastEpisode, 6, 'older completion does not regress episode');

    // resetProgress clears the playhead marker too.
    store.updateProgress('tv', 1399, { season: 3, episode: 7, positionSec: 100, durationSec: 3600 });
    store.resetProgress(1399);
    s = store.read().tvShows['1399'];
    assert.strictEqual(s.progress, undefined, 'resetProgress clears playhead progress');
    assert.strictEqual(s.lastSeason, undefined, 'resetProgress clears furthest-watched');
    fs.unlinkSync(file);
  }

  // Validation: bad inputs throw, unknown duration is tolerated.
  {
    const { store, file } = freshStore();
    assert.throws(() => store.updateProgress('movie', 1, { positionSec: -5 }), /non-negative/);
    assert.throws(() => store.updateProgress('album', 1, { positionSec: 5 }), /movie or tv/);
    store.updateProgress('movie', 605, { positionSec: 700 }); // no duration → stored, never "completed"
    assert.strictEqual(store.read().movies['605'].progress.positionSec, 700, 'progress without duration stored');
    assert.strictEqual(store.read().movies['605'].progress.durationSec, null, 'unknown duration stored as null');
    fs.unlinkSync(file);
  }

  console.log('history-progress: all assertions passed');
}

main();
