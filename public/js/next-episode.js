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

// Node require() for the test; harmless no-op in the browser (no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nextEpisodeTarget };
}
