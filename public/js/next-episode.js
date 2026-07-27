'use strict';

// Which episode comes after the one being watched — or null when there isn't one.
//
// The rules, in order: advance within the current season; at a season finale roll over to the
// next season's episode 1; return null at the last available episode; movies never have a next.
// Unknown episode_count does NOT block — better to offer a next episode that might not exist
// than to hide one that does, since the stream attempt will surface a dead release anyway.
//
// PURE, and fed by the caller: it takes the wizard state as an argument rather than reading a
// global. That is the whole reason it lives in its own file — tests/next-episode.test.js can
// require() it and pass controlled state, instead of slicing the function's source text out of
// app.js and vm-evaling it (which is what it did before, terminating the slice on the first
// column-0 `}` — one stray brace from silently testing a truncated function).
//
// Loaded as a classic script BEFORE app.js (see index.html), so `nextEpisodeTarget` is a
// window global there exactly as it was when it lived inline.

function nextEpisodeTarget(wizard) {
  if (!wizard || wizard.type !== 'tv') return null;
  const curS = Number(wizard.selectedSeason);
  const curE = Number(wizard.selectedEpisode);
  if (!curS || !curE) return null;
  const seasons = (wizard.seasons || []).slice().sort((a, b) => a.season_number - b.season_number);
  const cur = seasons.find((s) => s.season_number === curS);
  const epCount = cur && cur.episode_count ? Number(cur.episode_count) : null;
  if (!epCount || curE < epCount) return { s: curS, e: curE + 1 };
  const idx = seasons.findIndex((s) => s.season_number === curS);
  if (idx >= 0 && idx + 1 < seasons.length) return { s: seasons[idx + 1].season_number, e: 1 };
  return null; // already at the last available episode
}

// Where a returning viewer should be dropped: the episode they have NOT seen,
// not the one they last watched. The season/episode picker used to open on
// season 1 every time, so anyone twenty seasons deep had to scroll the season
// strip back to where they were on every single visit.
//
// It is deliberately the same walk as nextEpisodeTarget — "resume" and "next
// episode" are the same question asked from different places, and if they ever
// disagreed the picker would open on a season the Next Episode button refuses
// to go to. Two extra rules that only matter here:
//   - No history at all → the first season's E1. A show nobody has started
//     opens where it starts.
//   - Finished the whole show → stay on the last watched episode rather than
//     returning null. The picker must always land somewhere.
//
// PURE. Returns { s, e }, or null only when there are no seasons to pick from.
function resumeTarget(seasons, lastSeason, lastEpisode) {
  const list = (seasons || []).slice().sort((a, b) => a.season_number - b.season_number);
  if (!list.length) return null;

  const lastS = Number(lastSeason) || 0;
  const lastE = Number(lastEpisode) || 0;
  if (!lastS || !lastE) return { s: list[0].season_number, e: 1 };

  // History can name a season that is no longer in the list (a TMDB re-split,
  // or a specials-only entry we filter out). Fall back to the start.
  if (!list.some((s) => s.season_number === lastS)) return { s: list[0].season_number, e: 1 };

  const next = nextEpisodeTarget({
    type: 'tv', selectedSeason: lastS, selectedEpisode: lastE, seasons: list,
  });
  return next || { s: lastS, e: lastE };
}

// Node require() for the test; harmless no-op in the browser (no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextEpisodeTarget, resumeTarget };
}
