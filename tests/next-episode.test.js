'use strict';

// Verifies the "Next Episode" target logic: advance within a season, roll over to the next
// season's E1 at the finale, return null at the very last available episode, and ignore movies.
//
// This used to slice nextEpisodeTarget() out of app.js as text and vm-eval it, terminating the
// slice at the first column-0 `}` — a hair away from silently testing a truncated function. The
// function now lives in public/js/next-episode.js and takes wizard as an argument, so this is a
// plain require against controlled state. No vm, no source markers.

const assert = require('assert');
const { nextEpisodeTarget } = require('../public/js/next-episode.js');

const SEASONS = [
  { season_number: 1, episode_count: 24 },
  { season_number: 2, episode_count: 12 },
  { season_number: 3, episode_count: 10 },
];

function eq(actual, exp, msg) {
  if (exp === null) return assert.strictEqual(actual, null, msg);
  assert.deepStrictEqual(actual, exp, msg);
}

function main() {
  // Mid-season → next episode, same season.
  eq(nextEpisodeTarget({ type: 'tv', selectedSeason: 2, selectedEpisode: 10, seasons: SEASONS }),
    { s: 2, e: 11 }, 'mid-season should advance the episode');

  // Season finale → roll over to the next season's episode 1.
  eq(nextEpisodeTarget({ type: 'tv', selectedSeason: 2, selectedEpisode: 12, seasons: SEASONS }),
    { s: 3, e: 1 }, 'season finale should roll to next season E1');

  // Last episode of the last season → nothing.
  eq(nextEpisodeTarget({ type: 'tv', selectedSeason: 3, selectedEpisode: 10, seasons: SEASONS }),
    null, 'last episode of last season has no next');

  // Unknown episode_count → still offer the next episode (don't block).
  eq(nextEpisodeTarget({ type: 'tv', selectedSeason: 2, selectedEpisode: 5, seasons: [{ season_number: 2 }] }),
    { s: 2, e: 6 }, 'unknown count should still advance');

  // Movies have no "next episode".
  eq(nextEpisodeTarget({ type: 'movie', selectedSeason: null, selectedEpisode: null }),
    null, 'movies have no next');

  // Out-of-order seasons array must still roll over correctly.
  eq(nextEpisodeTarget({ type: 'tv', selectedSeason: 1, selectedEpisode: 24, seasons: [SEASONS[2], SEASONS[0], SEASONS[1]] }),
    { s: 2, e: 1 }, 'rollover should not depend on season array order');

  // No wizard at all → null, not a throw.
  eq(nextEpisodeTarget(undefined), null, 'missing wizard should be null, not an error');

  console.log('next-episode.test.js passed');
}

main();
