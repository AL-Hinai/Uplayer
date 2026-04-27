#!/usr/bin/env node
'use strict';

/**
 * Search-accuracy regression test — Deliverable 3.
 *
 * For each (show, season, episode) in the corpus, run the production
 * `searchAllSources` code path end-to-end and assert:
 *
 *   1. TopHit:        ≥1 of the top-5 results is a real match (per the
 *                     shared classifier in scripts/lib/name-patterns.js).
 *   2. NoWrongShow:   no top-10 result has a year-collision suggesting it's
 *                     from a different show with the same title.
 *   3. NoWrongSeason: no top-10 result has an explicit season tag that
 *                     contradicts the requested season (unless absolute
 *                     anime episode also matches).
 *   4. AnimeAbsolute: for anime shows, ≥1 top-10 result matches via the
 *                     absolute-episode rule (proves anime path works).
 *
 * Output:
 *   scripts/data/test-results.json
 *
 * Usage:
 *   node scripts/test-search-accuracy.js                   # default threshold 0.8
 *   node scripts/test-search-accuracy.js --threshold=0.7   # tune pass bar
 *   node scripts/test-search-accuracy.js --baseline        # write
 *                                                          # test-results.baseline.json
 *                                                          # instead of test-results.json
 *   node scripts/test-search-accuracy.js --shows=37854     # filter to one show
 */

const fs = require('fs');
const path = require('path');

const { loadEnvFileOnce } = require('../core/config');
const { TorrentScraper } = require('../uplayer.js');
const { parseName, classify } = require('../core/torrent-name-patterns');

loadEnvFileOnce();

const DATA_DIR = path.join(__dirname, 'data');
const CORPUS = path.join(DATA_DIR, 'torrent-naming-data.json');

const argv = parseArgs(process.argv.slice(2));
const OUTPUT = argv.baseline
  ? path.join(DATA_DIR, 'test-results.baseline.json')
  : path.join(DATA_DIR, 'test-results.json');

if (!fs.existsSync(CORPUS)) {
  console.error(`Missing ${CORPUS} — run scripts/torrent-naming-survey.js first.`);
  process.exit(1);
}

function parseArgs(args) {
  const out = { threshold: 0.8, baseline: false, shows: null };
  for (const a of args) {
    if (a === '--baseline') out.baseline = true;
    else if (a.startsWith('--threshold=')) out.threshold = Number(a.slice(12));
    else if (a.startsWith('--shows=')) {
      out.shows = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
    }
  }
  return out;
}

const corpus = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
const scraper = new TorrentScraper();

let testShows = corpus.shows || [];
if (argv.shows) testShows = testShows.filter((s) => argv.shows.includes(s.tmdbId));

if (testShows.length === 0) {
  console.error('No shows to test (corpus empty or --shows filter matched nothing).');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Production search wrapper. Calls the real `searchAllSources` so we test the
// in-app behaviour. Once Deliverable 4 lands, the same test stays valid — only
// the score should improve.
// ---------------------------------------------------------------------------

async function runProductionSearch(show) {
  // Pass the full options object so the production filter knows whether to
  // treat the show as anime and which absolute episode to look for. The
  // scraper still accepts the old positional signature for backward-compat.
  const results = await scraper.searchAllSources(show.title, {
    season: show.season,
    episode: show.episode,
    isAnime: show.isAnime,
    absoluteEpisode: show.absoluteEpisode,
  });
  return Array.isArray(results) ? results : [];
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function annotate(result, expected) {
  const parsed = parseName(result.name || '');
  const verdict = classify(parsed, expected);
  return { ...result, parsed, verdict };
}

function assertTopHit(annotated, expected) {
  const top5 = annotated.slice(0, 5);
  const hit = top5.find(
    (r) =>
      r.verdict.exactSEMatch ||
      r.verdict.longformMatch ||
      r.verdict.episodeOnlyMatch ||
      r.verdict.animeDashMatch ||
      r.verdict.absoluteMatch
  );
  return {
    pass: !!hit,
    detail: hit ? hit.name : '(no match in top 5)',
  };
}

function assertNoWrongShow(annotated, expected, show) {
  const top10 = annotated.slice(0, 10);
  if (show.firstAirYear == null) return { pass: true, detail: 'no firstAirYear baseline' };
  const offenders = top10.filter((r) => {
    const y = r.parsed.year;
    if (y == null) return false;
    return Math.abs(y - show.firstAirYear) >= 2;
  });
  return {
    pass: offenders.length === 0,
    detail: offenders.length ? offenders.map((o) => o.name).join(' | ') : 'clean',
    offenderCount: offenders.length,
  };
}

function assertNoWrongSeason(annotated, expected) {
  const top10 = annotated.slice(0, 10);
  // A wrong-season offender is one with an *explicit* season tag that doesn't
  // match, AND that didn't redeem itself via the absolute-episode rule.
  const offenders = top10.filter(
    (r) => r.verdict.wrongSeason && !r.verdict.absoluteMatch
  );
  return {
    pass: offenders.length === 0,
    detail: offenders.length ? offenders.map((o) => o.name).join(' | ') : 'clean',
    offenderCount: offenders.length,
  };
}

function assertAnimeAbsolute(annotated, expected) {
  if (!expected.isAnime) return { pass: true, detail: 'n/a (not anime)', skipped: true };
  const top10 = annotated.slice(0, 10);
  const hit = top10.find((r) => r.verdict.absoluteMatch || r.verdict.animeDashMatch);
  return {
    pass: !!hit,
    detail: hit ? hit.name : '(no absolute/anime-dash match in top 10)',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Testing ${testShows.length} shows…\n`);
  const cases = [];
  for (const show of testShows) {
    const expected = {
      season: show.season,
      episode: show.episode,
      absoluteEpisode: show.absoluteEpisode,
      isAnime: show.isAnime,
    };

    let annotated = [];
    let runError = null;
    try {
      const raw = await runProductionSearch(show);
      annotated = raw.map((r) => annotate(r, expected));
    } catch (e) {
      runError = e.message || String(e);
    }

    const assertions = {
      topHit: assertTopHit(annotated, expected),
      noWrongShow: assertNoWrongShow(annotated, expected, show),
      noWrongSeason: assertNoWrongSeason(annotated, expected),
      animeAbsolute: assertAnimeAbsolute(annotated, expected),
    };

    const passes = Object.values(assertions).filter((a) => a.pass && !a.skipped).length;
    const total = Object.values(assertions).filter((a) => !a.skipped).length;

    const summary = `[${passes}/${total}] ${show.title} S${show.season}E${show.episode}` +
      (show.isAnime ? ` (anime, abs=${show.absoluteEpisode})` : '');
    console.log(summary);
    if (runError) console.log(`  ERROR: ${runError}`);
    for (const [k, v] of Object.entries(assertions)) {
      const icon = v.skipped ? '·' : v.pass ? '✓' : '✗';
      console.log(`  ${icon} ${k}: ${v.detail}`);
    }
    console.log('');

    cases.push({
      show,
      runError,
      resultCount: annotated.length,
      top10: annotated.slice(0, 10).map((r) => ({
        name: r.name,
        source: r.source,
        seeders: r.seeders,
        verdict: r.verdict,
      })),
      assertions,
      passes,
      total,
    });
  }

  const totalAssertions = cases.reduce((s, c) => s + c.total, 0);
  const totalPasses = cases.reduce((s, c) => s + c.passes, 0);
  const score = totalAssertions > 0 ? totalPasses / totalAssertions : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    threshold: argv.threshold,
    baseline: !!argv.baseline,
    shows: testShows.length,
    totalAssertions,
    totalPasses,
    score,
    pass: score >= argv.threshold,
    cases,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));

  console.log('-----------------------------------------------------------');
  console.log(
    `Score: ${(score * 100).toFixed(1)}% (${totalPasses}/${totalAssertions})  ` +
      `threshold ${(argv.threshold * 100).toFixed(0)}% — ${report.pass ? 'PASS' : 'FAIL'}`
  );
  console.log(`Wrote ${OUTPUT}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('Test run failed:', e);
  process.exit(2);
});
