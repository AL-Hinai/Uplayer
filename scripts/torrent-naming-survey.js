#!/usr/bin/env node
'use strict';

/**
 * Corpus builder — Deliverable 1 of the torrent-search filter fix.
 *
 * Builds a representative sample of how popular shows are named on each
 * torrent source so we can design filter rules from real data instead of
 * guesses. Output:
 *
 *   scripts/data/torrent-naming-data.json   (raw corpus)
 *   scripts/data/cache/tmdb/*.json          (TMDB response cache)
 *
 * Usage:
 *   node scripts/torrent-naming-survey.js                # full run, both lists
 *   node scripts/torrent-naming-survey.js --quick        # 5 anime + 5 us tv
 *   node scripts/torrent-naming-survey.js --only=anime
 *   node scripts/torrent-naming-survey.js --only=ustv
 *   node scripts/torrent-naming-survey.js --shows=37854,1399  # explicit TMDB IDs
 *
 * Re-runs hit the TMDB cache; only the torrent scrapers actually go to the
 * network. Each torrent source call is wrapped in try/catch so a single
 * dead source can't abort the whole survey.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnvFileOnce } = require('../core/config');
const { createTmdbClient } = require('../core/tmdb-client');
const { TorrentScraper } = require('../uplayer.js');
const { parseName, classify } = require('../core/torrent-name-patterns');

loadEnvFileOnce();

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache', 'tmdb');
const OUTPUT_PATH = path.join(DATA_DIR, 'torrent-naming-data.json');

// Limits — keep modest so a survey run doesn't take forever or trigger
// rate-limiters. Override per-flag if you want a deeper sweep.
const DEFAULTS = {
  animeCount: 20,
  usTvCount: 20,
  perSourceJitterMs: 250,
};

const argv = parseArgs(process.argv.slice(2));

const tmdb = createTmdbClient();
if (!tmdb.hasApiKey()) {
  console.error('TMDB_API_KEY missing — set it in .env before running the survey.');
  process.exit(1);
}

const scraper = new TorrentScraper();

function parseArgs(args) {
  const out = { quick: false, only: null, shows: null, anime: null, ustv: null };
  for (const a of args) {
    if (a === '--quick') out.quick = true;
    else if (a.startsWith('--only=')) out.only = a.slice(7);
    else if (a.startsWith('--shows=')) out.shows = a.slice(8).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--anime=')) out.anime = parseInt(a.slice(8), 10);
    else if (a.startsWith('--ustv=')) out.ustv = parseInt(a.slice(7), 10);
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function tmdbCached(endpoint, params = {}) {
  const key = crypto
    .createHash('sha1')
    .update(JSON.stringify({ endpoint, params }))
    .digest('hex');
  const cachePath = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (_) {
      // fallthrough — rewrite
    }
  }
  const data = await tmdb.get(endpoint, params);
  ensureDir(CACHE_DIR);
  fs.writeFileSync(cachePath, JSON.stringify(data));
  return data;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function jitter(baseMs) {
  return baseMs + Math.floor(Math.random() * baseMs);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Show selection
// ---------------------------------------------------------------------------

async function fetchTopAnime(count) {
  // Discover TV with Animation genre + JP origin, sorted by popularity.
  // TMDB returns 20 per page; paginate until we have `count`.
  const accum = [];
  const seen = new Set();
  for (let page = 1; page <= 25 && accum.length < count; page++) {
    const data = await tmdbCached('/discover/tv', {
      with_genres: 16,
      with_origin_country: 'JP',
      sort_by: 'popularity.desc',
      page,
    });
    const rows = data.results || [];
    if (rows.length === 0) break;
    for (const s of rows) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      accum.push(s);
      if (accum.length >= count) break;
    }
  }
  return accum.slice(0, count);
}

async function fetchTopUsTv(count) {
  // Trending TV this week, filtered to shows with US in origin_country.
  // Trending only goes ~10 pages deep; if we run out, fall back to
  // /discover/tv sorted by popularity restricted to US.
  const accum = [];
  const seen = new Set();
  for (let page = 1; page <= 20 && accum.length < count; page++) {
    let data;
    try {
      data = await tmdbCached('/trending/tv/week', { page });
    } catch (_) {
      break;
    }
    const rows = data.results || [];
    if (rows.length === 0) break;
    for (const s of rows) {
      if (seen.has(s.id)) continue;
      const origins = s.origin_country || [];
      if (!origins.includes('US')) continue;
      seen.add(s.id);
      accum.push(s);
      if (accum.length >= count) break;
    }
  }
  // Backfill from /discover/tv if trending wasn't deep enough.
  for (let page = 1; page <= 25 && accum.length < count; page++) {
    const data = await tmdbCached('/discover/tv', {
      with_origin_country: 'US',
      sort_by: 'popularity.desc',
      page,
    });
    const rows = data.results || [];
    if (rows.length === 0) break;
    for (const s of rows) {
      if (seen.has(s.id)) continue;
      const origins = s.origin_country || [];
      if (!origins.includes('US')) continue;
      seen.add(s.id);
      accum.push(s);
      if (accum.length >= count) break;
    }
  }
  return accum.slice(0, count);
}

async function fetchExplicitShows(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const data = await tmdbCached(`/tv/${id}`);
      out.push({
        id: data.id,
        name: data.name,
        original_name: data.original_name,
        original_language: data.original_language,
        origin_country: data.origin_country,
        genre_ids: (data.genres || []).map((g) => g.id),
        first_air_date: data.first_air_date,
      });
    } catch (e) {
      console.warn(`  ! Could not fetch TV id=${id}: ${e.message}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Episode picking — choose a real, aired episode for each show
// ---------------------------------------------------------------------------

function isAnimeShow(detail) {
  const genres = (detail.genres || []).map((g) => g.id);
  const origins = detail.origin_country || [];
  const lang = detail.original_language;
  const animationGenre = genres.includes(16);
  const japanese = origins.includes('JP') || lang === 'ja';
  return animationGenre && japanese;
}

async function pickTargetEpisode(showStub) {
  // Fetch full /tv/{id} detail (with seasons array).
  const detail = await tmdbCached(`/tv/${showStub.id}`);
  const seasons = (detail.seasons || []).filter((s) => s.season_number > 0 && (s.episode_count || 0) > 0);
  if (seasons.length === 0) return null;

  // Walk seasons newest -> oldest looking for one whose episodes have aired.
  seasons.sort((a, b) => b.season_number - a.season_number);
  const today = new Date().toISOString().slice(0, 10);

  let chosenSeason = null;
  let chosenEpisode = null;
  for (const s of seasons) {
    const seasonData = await tmdbCached(`/tv/${detail.id}/season/${s.season_number}`);
    const aired = (seasonData.episodes || []).filter((ep) => ep.air_date && ep.air_date <= today);
    if (aired.length > 0) {
      chosenSeason = s.season_number;
      chosenEpisode = aired[aired.length - 1].episode_number;
      break;
    }
  }
  if (!chosenSeason) return null;

  // Compute absolute episode number. Two TMDB schemas exist for anime:
  //
  //  (a) Reset-per-season (Bleach, Naruto): episode_number resets to 1 each
  //      new TMDB season. Absolute = sum(prior season ep_counts) + episode.
  //  (b) Already-absolute (One Piece, Detective Conan): TMDB groups arcs as
  //      seasons but keeps episode_number as the global counter, so S23E1159
  //      means the 1159th episode (NOT S23's 1159th). Use episode_number
  //      as-is or we double-count.
  //
  // Heuristic: if episode_number is larger than the sum of all prior seasons'
  // episode counts, it must already be absolute.
  let priorSum = 0;
  for (const s of seasons) {
    if (s.season_number < chosenSeason) priorSum += s.episode_count || 0;
  }
  const absolute = chosenEpisode > priorSum ? chosenEpisode : priorSum + chosenEpisode;

  return {
    tmdbId: detail.id,
    title: detail.name,
    originalTitle: detail.original_name,
    isAnime: isAnimeShow(detail),
    season: chosenSeason,
    episode: chosenEpisode,
    absoluteEpisode: absolute,
    firstAirYear: detail.first_air_date ? Number(detail.first_air_date.slice(0, 4)) : null,
  };
}

// ---------------------------------------------------------------------------
// Survey loop
// ---------------------------------------------------------------------------

const SOURCES = [
  { key: '1337x', fn: (q) => scraper.search1337x(q) },
  { key: 'YTS', fn: (q) => scraper.searchYTS(q) },
  { key: 'PirateBay', fn: (q) => scraper.searchPirateBay(q) },
  { key: 'Nyaa', fn: (q) => scraper.searchNyaa(q) },
  { key: 'SubsPlease', fn: (q) => scraper.searchSubsPlease(q) },
];

function buildQueryVariants(show) {
  const baseTitle = show.title;
  const se = `S${pad2(show.season)}E${pad2(show.episode)}`;
  const variants = [
    { variant: 'A', query: baseTitle, label: 'bare-title' },
    { variant: 'B', query: `${baseTitle} ${se}`, label: 'formatted-SE' },
  ];
  if (show.isAnime && show.absoluteEpisode != null) {
    variants.push({
      variant: 'C',
      query: `${baseTitle} ${show.absoluteEpisode}`,
      label: 'anime-absolute',
    });
  }
  return variants;
}

async function searchOne(show, source, queryInfo) {
  const expected = {
    season: show.season,
    episode: show.episode,
    absoluteEpisode: show.absoluteEpisode,
    isAnime: show.isAnime,
  };
  let raw = [];
  let error = null;
  try {
    raw = await source.fn(queryInfo.query);
  } catch (e) {
    error = e.message || String(e);
  }
  const records = (raw || []).map((r) => {
    const parsed = parseName(r.name);
    const verdict = classify(parsed, expected);
    return {
      show: {
        tmdbId: show.tmdbId,
        title: show.title,
        isAnime: show.isAnime,
        season: show.season,
        episode: show.episode,
        absoluteEpisode: show.absoluteEpisode,
        firstAirYear: show.firstAirYear,
      },
      source: source.key,
      queryVariant: queryInfo.variant,
      query: queryInfo.query,
      name: r.name,
      seeders: r.seeders || 0,
      leechers: r.leechers || 0,
      size: r.size || null,
      parsed,
      verdict,
    };
  });
  return { records, error };
}

async function surveyShow(show, idx, total) {
  const header =
    `[${idx}/${total}] ${show.title} [tmdbId=${show.tmdbId}] ` +
    `${show.isAnime ? '(anime)' : '(live-action)'} ` +
    `→ S${pad2(show.season)}E${pad2(show.episode)}` +
    (show.isAnime ? ` / abs=${show.absoluteEpisode}` : '');
  console.log(`\n# ${header}`);

  const variants = buildQueryVariants(show);

  // Run sources in PARALLEL (each source independent), but within a single
  // source run the variants SEQUENTIALLY with a small jitter so we don't
  // hammer any one origin. This is the survey's fast path for 100+ shows.
  const perSourceTasks = SOURCES.map(async (source) => {
    const records = [];
    const failures = [];
    for (const queryInfo of variants) {
      const { records: r, error } = await searchOne(show, source, queryInfo);
      if (error) {
        failures.push({ source: source.key, query: queryInfo.query, error });
        process.stdout.write(`  ${source.key}/${queryInfo.variant}: ERROR ${error.slice(0, 60)}\n`);
      } else {
        process.stdout.write(`  ${source.key}/${queryInfo.variant} (${queryInfo.query}): ${r.length} hits\n`);
      }
      records.push(...r);
      await sleep(jitter(DEFAULTS.perSourceJitterMs));
    }
    return { records, failures };
  });

  const settled = await Promise.all(perSourceTasks);
  const allRecords = [];
  const failures = [];
  for (const { records, failures: f } of settled) {
    allRecords.push(...records);
    failures.push(...f);
  }
  return { records: allRecords, failures };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(CACHE_DIR);

  let stubs;
  if (argv.shows && argv.shows.length > 0) {
    console.log(`Using explicit show list: ${argv.shows.join(', ')}`);
    stubs = await fetchExplicitShows(argv.shows);
  } else {
    const animeCount = argv.anime != null
      ? argv.anime
      : argv.quick ? 5 : DEFAULTS.animeCount;
    const usTvCount = argv.ustv != null
      ? argv.ustv
      : argv.quick ? 5 : DEFAULTS.usTvCount;
    const wantAnime = argv.only !== 'ustv';
    const wantUsTv = argv.only !== 'anime';

    stubs = [];
    if (wantAnime) {
      const anime = await fetchTopAnime(animeCount);
      console.log(`Picked ${anime.length} anime from /discover/tv`);
      stubs.push(...anime);
    }
    if (wantUsTv) {
      const ustv = await fetchTopUsTv(usTvCount);
      console.log(`Picked ${ustv.length} US TV shows`);
      stubs.push(...ustv);
    }
  }

  const shows = [];
  for (const stub of stubs) {
    try {
      const target = await pickTargetEpisode(stub);
      if (target) shows.push(target);
      else console.warn(`  ! No aired episode found for ${stub.name || stub.id}; skipping`);
    } catch (e) {
      console.warn(`  ! pickTargetEpisode failed for ${stub.name || stub.id}: ${e.message}`);
    }
  }
  console.log(`\nResolved ${shows.length} shows with target episodes.\n`);

  const allRecords = [];
  const allFailures = [];
  for (let i = 0; i < shows.length; i++) {
    const { records, failures } = await surveyShow(shows[i], i + 1, shows.length);
    allRecords.push(...records);
    allFailures.push(...failures);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    args: argv,
    sources: SOURCES.map((s) => s.key),
    showCount: shows.length,
    recordCount: allRecords.length,
    failureCount: allFailures.length,
    shows,
    records: allRecords,
    failures: allFailures,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\n→ Wrote ${allRecords.length} records (${allFailures.length} source errors) to`);
  console.log(`  ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error('Survey failed:', e);
  process.exit(1);
});
