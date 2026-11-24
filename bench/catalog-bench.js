'use strict';
/*
 * Catalog-provider benchmark: TMDB (current setup, API key required) vs the
 * KEYLESS stack (Cinemeta for movies/TV, AniList for anime, api.ani.zip for
 * anime numbering).
 *
 * Measures the METADATA PLANE ONLY. Torrent discovery, subtitles and the
 * streaming engine are already keyless in both setups and are out of scope.
 *
 * What it answers: for the same user-visible operation, how many HTTP round
 * trips does each provider need, how long does it take, how many bytes does it
 * move, and how complete is the data that comes back.
 *
 * Deliberately NOT measured: anything needing a logged-in account, and the
 * QUALITY of recommendations (a ranking judgement, not a benchmark). Capability
 * presence is measured; candidate quality is not.
 *
 * Sequential by design: parallel requests would measure this machine's
 * contention, not the providers. Medians over REPS runs. Caches are warm for
 * both sides after rep 1 — that favours neither.
 *
 * USAGE:  node bench/catalog-bench.js
 * Results -> bench/catalog-results.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const { loadEnvFileOnce, getRuntimeConfig } = require('../core/config');
try { loadEnvFileOnce(); } catch (e) { /* key may come from system-config */ }
const TMDB_KEY = String(getRuntimeConfig().tmdbApiKey || '').trim();

const RESULTS = path.join(__dirname, 'catalog-results.json');
const REPS = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';

const TMDB = 'https://api.themoviedb.org/3';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const ANILIST = 'https://graphql.anilist.co';
const ANIZIP = 'https://api.ani.zip';

// --- fixtures -----------------------------------------------------------------
// Covers all three content types and both extremes of season count.
const MOVIES = [
  { name: 'Inception', tmdb: 27205, imdb: 'tt1375666' },
  { name: 'The Matrix', tmdb: 603, imdb: 'tt0133093' },
  { name: 'Dune: Part Two', tmdb: 693134, imdb: 'tt15239678' },
];
const SHOWS = [
  { name: 'Breaking Bad', tmdb: 1396, imdb: 'tt0903747' },
  { name: 'Severance', tmdb: 95396, imdb: 'tt11280740' },
];
const ANIME = [
  { name: 'Frieren', tmdb: 209867, imdb: 'tt22248376', anilist: 154587 },
  { name: 'Bleach', tmdb: 30984, imdb: 'tt0434665', anilist: 269 },
  { name: 'One Piece', tmdb: 37854, imdb: 'tt0388629', anilist: 21 },
];
const QUERIES = ['inception', 'the matrix', 'breaking bad', 'severance', 'dune part two'];

// --- plumbing -----------------------------------------------------------------
function request(url, opts, redirects) {
  const o = opts || {};
  const hops = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const headers = Object.assign({ 'User-Agent': UA, 'Accept-Encoding': 'identity' }, o.headers || {});
    const req = https.request(new URL(url), { method: o.method || 'GET', headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return request(next, o, hops - 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* non-JSON */ }
        resolve({ ms: ms, bytes: buf.length, status: res.statusCode, headers: res.headers, json: json });
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('timeout')); });
    if (o.body) req.write(o.body);
    req.end();
  });
}

function tmdbGet(ep, params) {
  const q = new URLSearchParams(Object.assign({ api_key: TMDB_KEY }, params || {})).toString();
  return request(TMDB + ep + '?' + q);
}
function anilist(query, variables) {
  return request(ANILIST, {
    method: 'POST',
    body: JSON.stringify({ query: query, variables: variables || {} }),
    headers: { 'Content-Type': 'application/json' },
  });
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
function r1(n) { return Math.round(n * 10) / 10; }
function line(label, calls, ms, bytes) {
  console.log(
    '  ' + label.padEnd(42) +
    String(calls).padStart(3) + ' calls  ' +
    String(r1(ms)).padStart(9) + ' ms  ' +
    String(Math.round(bytes / 1024)).padStart(7) + ' KB'
  );
}

// An "operation" is one user-visible action. Every HTTP call it costs is recorded.
async function op(label, fn) {
  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const calls = [];
    const value = await fn((c) => calls.push(c));
    runs.push({
      ms: sum(calls.map((c) => c.ms)),
      bytes: sum(calls.map((c) => c.bytes)),
      calls: calls.length,
      value: value,
    });
  }
  const out = {
    label: label,
    calls: runs[0].calls,
    msMedian: r1(median(runs.map((r) => r.ms))),
    bytesMedian: Math.round(median(runs.map((r) => r.bytes))),
    value: runs[runs.length - 1].value,
  };
  line(label, out.calls, out.msMedian, out.bytesMedian);
  return out;
}

// --- D1: search across movies + TV -------------------------------------------
async function d1Search() {
  console.log('\nD1  Search (one query, movies + TV)');
  const rows = [];
  for (const q of QUERIES) {
    const t = await op('TMDB     "' + q + '"', async (rec) => {
      const a = await tmdbGet('/search/movie', { query: q }); rec(a);
      const b = await tmdbGet('/search/tv', { query: q }); rec(b);
      const items = ((a.json || {}).results || []).concat(((b.json || {}).results || []));
      const top = items[0] || {};
      return { top: top.title || top.name || null, items: items };
    });
    const k = await op('keyless  "' + q + '"', async (rec) => {
      const enc = encodeURIComponent(q);
      const a = await request(CINEMETA + '/catalog/movie/top/search=' + enc + '.json'); rec(a);
      const b = await request(CINEMETA + '/catalog/series/top/search=' + enc + '.json'); rec(b);
      const items = (((a.json || {}).metas) || []).concat((((b.json || {}).metas) || []));
      return { top: (items[0] || {}).name || null, items: items };
    });
    rows.push({ query: q, tmdb: t, keyless: k });
  }
  return rows;
}

// --- D2: title details --------------------------------------------------------
async function d2Details() {
  console.log('\nD2  Title details (one title)');
  const rows = [];
  const all = MOVIES.map((m) => ({ m: m, type: 'movie' })).concat(SHOWS.map((m) => ({ m: m, type: 'tv' })));
  for (const e of all) {
    const t = await op('TMDB     ' + e.m.name, async (rec) => {
      const a = await tmdbGet('/' + e.type + '/' + e.m.tmdb); rec(a);
      return { ok: !!a.json };
    });
    const k = await op('keyless  ' + e.m.name, async (rec) => {
      const kind = e.type === 'tv' ? 'series' : 'movie';
      const a = await request(CINEMETA + '/meta/' + kind + '/' + e.m.imdb + '.json'); rec(a);
      return { ok: !!(a.json && a.json.meta) };
    });
    rows.push({ title: e.m.name, tmdb: t, keyless: k });
  }
  return rows;
}

// --- D3: every episode of a show (the headline) -------------------------------
async function d3FullEpisodeList() {
  console.log('\nD3  Full episode list (every season of one show)');
  const rows = [];
  for (const s of SHOWS.concat(ANIME)) {
    const t = await op('TMDB     ' + s.name, async (rec) => {
      const head = await tmdbGet('/tv/' + s.tmdb); rec(head);
      const seasons = ((head.json || {}).seasons || []).filter((x) => x.season_number > 0);
      let eps = 0;
      for (const sn of seasons) {
        const r = await tmdbGet('/tv/' + s.tmdb + '/season/' + sn.season_number); rec(r);
        eps += ((r.json || {}).episodes || []).length;
      }
      return { seasons: seasons.length, episodes: eps };
    });
    const k = await op('keyless  ' + s.name, async (rec) => {
      const a = await request(CINEMETA + '/meta/series/' + s.imdb + '.json'); rec(a);
      const v = (((a.json || {}).meta) || {}).videos || [];
      const seasons = {};
      v.forEach((x) => { if (x.season > 0) seasons[x.season] = 1; });
      return { seasons: Object.keys(seasons).length, episodes: v.length };
    });
    rows.push({ show: s.name, tmdb: t, keyless: k });
  }
  return rows;
}

// --- D4: IMDb id (the YIFY subtitle provider needs it) ------------------------
async function d4ImdbId() {
  console.log('\nD4  Resolve IMDb id for a movie (YIFY subtitles need it)');
  const rows = [];
  for (const m of MOVIES) {
    const t = await op('TMDB     ' + m.name, async (rec) => {
      const a = await tmdbGet('/movie/' + m.tmdb + '/external_ids'); rec(a);
      return { imdb: (a.json || {}).imdb_id || null };
    });
    // Keyless needs no call: the IMDb id IS the key every other call already uses.
    const k = { label: 'keyless  ' + m.name, calls: 0, msMedian: 0, bytesMedian: 0, value: { imdb: m.imdb } };
    line(k.label, 0, 0, 0);
    rows.push({ title: m.name, tmdb: t, keyless: k });
  }
  return rows;
}

// --- D5: home page first screen ----------------------------------------------
async function d5Home() {
  console.log('\nD5  Home page first screen (app.js:529 fetches 3 trending rows)');
  const t = await op('TMDB     home rows', async (rec) => {
    for (const w of ['all', 'movie', 'tv']) { const r = await tmdbGet('/trending/' + w + '/week'); rec(r); }
    return {};
  });
  const k = await op('keyless  home rows', async (rec) => {
    for (const c of ['movie', 'series']) { const r = await request(CINEMETA + '/catalog/' + c + '/top.json'); rec(r); }
    return {};
  });
  return { tmdb: t, keyless: k };
}

// --- D6: field completeness ---------------------------------------------------
function completeness(items, kind) {
  let poster = 0, year = 0, rating = 0, tmdbId = 0, imdbId = 0;
  for (const i of items) {
    if (kind === 'tmdb') {
      if (i.poster_path) poster++;
      if (i.release_date || i.first_air_date) year++;
      if (typeof i.vote_average === 'number' && i.vote_average > 0) rating++;
      if (i.id) tmdbId++;
      // TMDB search rows carry no IMDb id at all — hence D4.
    } else {
      if (i.poster) poster++;
      if (i.year || i.releaseInfo) year++;
      if (i.imdbRating !== '' && i.imdbRating != null) rating++;
      if (i.moviedb_id) tmdbId++;
      if (i.imdb_id) imdbId++;
    }
  }
  const n = items.length || 1;
  const pct = (x) => Math.round((x / n) * 100);
  return {
    items: items.length, posterPct: pct(poster), yearPct: pct(year),
    ratingPct: pct(rating), tmdbIdPct: pct(tmdbId), imdbIdPct: pct(imdbId),
  };
}

// --- D7: capability matrix ----------------------------------------------------
async function d7Capabilities() {
  console.log('\nD7  Capabilities');
  const out = {};

  const simT = await tmdbGet('/movie/' + MOVIES[0].tmdb + '/recommendations', { page: 1 });
  out.similarMovie = { tmdb: ((simT.json || {}).results || []).length, keyless: 0 };
  console.log('  similar (movie)        TMDB ' + out.similarMovie.tmdb + ' candidates | keyless 0 — no keyless graph exists');

  const simA = await anilist(
    'query($id:Int){Media(id:$id,type:ANIME){recommendations(perPage:25,sort:RATING_DESC){nodes{rating mediaRecommendation{id}}}}}',
    { id: ANIME[0].anilist }
  );
  const media = ((simA.json || {}).data || {}).Media || {};
  const anilistRecs = ((media.recommendations || {}).nodes) || [];
  const simAT = await tmdbGet('/tv/' + ANIME[0].tmdb + '/recommendations', { page: 1 });
  out.similarAnime = { tmdb: ((simAT.json || {}).results || []).length, keyless: anilistRecs.length };
  console.log('  similar (anime)        TMDB ' + out.similarAnime.tmdb + ' candidates | keyless ' + out.similarAnime.keyless + ' candidates (AniList)');

  const numbering = [];
  for (const a of ANIME) {
    const eg = await tmdbGet('/tv/' + a.tmdb + '/episode_groups');
    const groups = ((eg.json || {}).results || []).length;
    const az = await request(ANIZIP + '/mappings?themoviedb_id=' + a.tmdb);
    // ani.zip keys `episodes` by episode number for real episodes and by "S<n>" for
    // SPECIALS. Specials carry no absoluteEpisodeNumber and never should — counting them
    // in the denominator understates absolute coverage badly (it read 47% for Frieren,
    // whose 28 real episodes are all numbered, because 31 of its 59 keys are specials).
    // Measure real episodes only, and split out unaired placeholders, which ani.zip
    // creates ahead of broadcast with no numbering yet.
    const epMap = ((az.json || {}).episodes) || {};
    const realKeys = Object.keys(epMap).filter((k) => /^\d+$/.test(k));
    const specialKeys = Object.keys(epMap).filter((k) => !/^\d+$/.test(k));
    const aired = realKeys.filter((k) => epMap[k] && (epMap[k].airDate || epMap[k].airdate));
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
    const absAll = realKeys.filter((k) => epMap[k] && epMap[k].absoluteEpisodeNumber != null).length;
    const absAired = aired.filter((k) => epMap[k].absoluteEpisodeNumber != null).length;
    const eidReal = realKeys.filter((k) => epMap[k] && epMap[k].anidbEid).length;
    const row = {
      show: a.name,
      tmdbEpisodeGroups: groups,
      tmdbCallsToReadGroups: groups ? 1 + groups : 1,
      anizipCalls: 1,
      anizipBytes: az.bytes,
      anizipRealEpisodes: realKeys.length,
      anizipSpecialKeys: specialKeys.length,
      anizipAiredEpisodes: aired.length,
      anizipEidPct: pct(eidReal, realKeys.length),
      anizipAbsPct: pct(absAll, realKeys.length),
      anizipAbsPctAired: pct(absAired, aired.length),
      anizipAbsMissing: realKeys.filter((k) => epMap[k].absoluteEpisodeNumber == null),
    };
    numbering.push(row);
    console.log(
      '  numbering ' + a.name.padEnd(12) +
      'TMDB ' + String(groups).padStart(2) + ' groups (' + row.tmdbCallsToReadGroups + ' calls) | ' +
      'ani.zip 1 call, ' + row.anizipRealEpisodes + ' eps (+' + row.anizipSpecialKeys + ' specials), ' +
      'eid ' + row.anizipEidPct + '%, abs ' + row.anizipAbsPct + '% (aired only ' + row.anizipAbsPctAired + '%)'
    );
  }
  out.numbering = numbering;
  return out;
}

// --- D8: rate limits as advertised -------------------------------------------
function pickRateHeaders(h) {
  const keep = {};
  Object.keys(h).forEach((k) => { if (/rate|limit|retry/i.test(k)) keep[k] = h[k]; });
  return keep;
}
async function d8RateLimits() {
  console.log('\nD8  Rate-limit headers as advertised');
  const out = {};
  out.tmdb = pickRateHeaders((await tmdbGet('/movie/27205')).headers);
  out.cinemeta = pickRateHeaders((await request(CINEMETA + '/meta/movie/tt1375666.json')).headers);
  out.anilist = pickRateHeaders((await anilist('query{__typename}')).headers);
  Object.keys(out).forEach((k) => console.log('  ' + k.padEnd(10) + ' ' + JSON.stringify(out[k])));
  return out;
}

// --- main ---------------------------------------------------------------------
(async () => {
  if (!TMDB_KEY) {
    console.error('No TMDB key configured — the comparison would be one-sided. Aborting.');
    process.exit(1);
  }
  console.log('Catalog-provider benchmark — ' + REPS + ' reps, medians, sequential.');
  console.log('TMDB key: present (never printed). Keyless: Cinemeta + AniList + ani.zip.');

  const results = { runAt: new Date().toISOString(), reps: REPS };
  results.d1Search = await d1Search();
  results.d2Details = await d2Details();
  results.d3FullEpisodeList = await d3FullEpisodeList();
  results.d4ImdbId = await d4ImdbId();
  results.d5Home = await d5Home();

  console.log('\nD6  Field completeness on search results (% of rows carrying each field)');
  const tItems = [];
  const kItems = [];
  results.d1Search.forEach((r) => {
    r.tmdb.value.items.forEach((i) => tItems.push(i));
    r.keyless.value.items.forEach((i) => kItems.push(i));
  });
  results.d6Completeness = { tmdb: completeness(tItems, 'tmdb'), keyless: completeness(kItems, 'keyless') };
  Object.keys(results.d6Completeness).forEach((k) =>
    console.log('  ' + k.padEnd(9) + ' ' + JSON.stringify(results.d6Completeness[k])));

  console.log('\nD6b Rank-1 correctness (was the first result the obvious match?)');
  results.d6Rank1 = results.d1Search.map((r) => ({
    query: r.query, tmdbTop: r.tmdb.value.top, keylessTop: r.keyless.value.top,
  }));
  results.d6Rank1.forEach((r) =>
    console.log('  "' + r.query.padEnd(15) + '" TMDB: ' + String(r.tmdbTop).padEnd(24) + ' keyless: ' + r.keylessTop));

  results.d7Capabilities = await d7Capabilities();
  results.d8RateLimits = await d8RateLimits();

  const totalsFor = (side) => {
    const dims = [results.d1Search, results.d2Details, results.d3FullEpisodeList, results.d4ImdbId];
    let calls = 0, ms = 0, bytes = 0;
    dims.forEach((d) => d.forEach((row) => {
      calls += row[side].calls; ms += row[side].msMedian; bytes += row[side].bytesMedian;
    }));
    calls += results.d5Home[side].calls;
    ms += results.d5Home[side].msMedian;
    bytes += results.d5Home[side].bytesMedian;
    return { calls: calls, ms: r1(ms), bytes: bytes };
  };
  results.totals = { tmdb: totalsFor('tmdb'), keyless: totalsFor('keyless') };
  console.log('\nTOTALS across D1-D5 (identical operations, both providers)');
  Object.keys(results.totals).forEach((k) => {
    const v = results.totals[k];
    console.log('  ' + k.padEnd(9) + ' ' + String(v.calls).padStart(4) + ' calls  ' +
      String(v.ms).padStart(9) + ' ms  ' + String(Math.round(v.bytes / 1024)).padStart(7) + ' KB');
  });

  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  console.log('\nDone. Raw data -> bench/catalog-results.json');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
