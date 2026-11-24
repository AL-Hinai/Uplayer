'use strict';
/*
 * Anime episode lookup: NAME MATCHING (what the app does today) vs ID MATCHING
 * (AniDB ids straight into AnimeTosho, the approach zenshin uses).
 *
 * Path A — name. core/episode-numbering.js derives a profile from TMDB (romaji and
 *   season-scoped titles, S/E aliases from episode groups, the absolute number), and
 *   core/torrent-scraper.js fans that plan out across five indexers, then classifies
 *   every release name against the profile. This is the real code path, not a model
 *   of it: the same calls /api/torrents/search makes.
 * Path B — id. api.ani.zip maps the TMDB id to an AniDB show id and the episode to an
 *   AniDB episode id; feed.animetosho.xyz is then queried by those ids. No release
 *   name is ever parsed.
 *
 * The honest difficulty here is judging CORRECTNESS. Path B's eid-filtered rows are
 * correct by construction — an AniDB episode id is the episode — so they serve as the
 * reference set, and Path A is scored by how much of that set it recovers. The reverse
 * matters too and is reported separately: the eid filter silently drops every batch and
 * season pack, because those carry no episode id, so rows only Path A finds are not
 * automatically wrong.
 *
 * Both paths are therefore measured on recall against each other, not on a single
 * "accuracy" number that would hide which kind of file each one misses.
 *
 * Path A's timing is swarm- and indexer-bound and varies run to run (Nyaa throttles
 * same-IP bursts; the scraper has a 20s follow-up budget). Treat its latency as an
 * order of magnitude, not a measurement.
 *
 * USAGE:  node bench/anime-lookup-bench.js
 * Results -> bench/anime-lookup-results.json
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const { loadEnvFileOnce, getRuntimeConfig } = require('../core/config');
try { loadEnvFileOnce(); } catch (e) { /* key may come from system-config */ }
const TMDB_KEY = String(getRuntimeConfig().tmdbApiKey || '').trim();

const { createEpisodeNumberingService } = require('../core/episode-numbering');
const { createTorrentScraper } = require('../core/torrent-scraper');

const RESULTS = path.join(__dirname, 'anime-lookup-results.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36';
const TOSHO = 'https://feed.animetosho.xyz';
const ANIZIP = 'https://api.ani.zip';

// Hard cases first. Bleach S2E14 is the example core/episode-numbering.js's own header
// is written around: TMDB numbers it S02E14, releases call it S17E14, "Sennen Kessen-hen
// S01E14", "Thousand-Year Blood War - 014" and "[EP: 380]".
const CASES = [
  { show: 'Bleach (TYBW)', title: 'Bleach', tmdbId: 30984, season: 2, episode: 14, anime: true },
  { show: 'One Piece', title: 'One Piece', tmdbId: 37854, season: 13, episode: 1, anime: true },
  { show: 'Frieren', title: 'Frieren: Beyond Journey\'s End', tmdbId: 209867, season: 1, episode: 5, anime: true },
  // Non-anime control: no AniDB mapping can exist, so Path B must decline cleanly.
  { show: 'Severance (control)', title: 'Severance', tmdbId: 95396, season: 1, episode: 1, anime: false },
];

function request(url, redirects) {
  const hops = redirects === undefined ? 5 : redirects;
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(url), { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return request(new URL(res.headers.location, url).href, hops - 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, bytes: buf.length, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32ToHex(s) {
  let bits = '';
  for (const ch of s.toLowerCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}
// One comparable key per release, whatever shape the provider gave it.
function infohashOf(x) {
  const raw = x && (x.info_hash || x.infohash || x.link || x.magnet_uri || '');
  const m = /btih:([a-zA-Z0-9]{32,40})/.exec(String(raw)) || [null, String(raw)];
  const v = String(m[1] || '').trim();
  if (/^[a-fA-F0-9]{40}$/.test(v)) return v.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(v)) return base32ToHex(v);
  return null;
}
const res1080 = (name) => /1080p?|1920x1080/i.test(String(name || ''));
const seedOf = (x) => Number(x.seeders || 0) || 0;

// Path A logs its plan size to stdout; capture it rather than re-deriving the plan.
function captureQueryCount(fn) {
  const orig = console.log;
  let combos = null;
  console.log = (...a) => {
    const line = a.map(String).join(' ');
    const m = /Searching (\d+) query\/source combinations/.exec(line);
    if (m) combos = Number(m[1]);
  };
  return Promise.resolve()
    .then(fn)
    .then((v) => { console.log = orig; return { value: v, combos }; },
      (e) => { console.log = orig; throw e; });
}

async function pathA(c, numbering, scraper) {
  const t0 = Date.now();
  let profile = null;
  if (c.season != null && c.episode != null) {
    profile = await numbering.buildProfile(c.tmdbId, c.season, c.episode).catch(() => null);
  }
  const { value: results, combos } = await captureQueryCount(() =>
    scraper.searchAllSources(c.title, Object.assign({ season: c.season, episode: c.episode }, profile || {}))
  );
  return {
    ms: Date.now() - t0,
    queryCombos: combos,
    results: results || [],
    absoluteEpisode: profile ? profile.absoluteEpisode : null,
    isAnime: profile ? !!profile.isAnime : null,
    seasonTitles: profile ? (profile.seasonTitles || []).slice(0, 3) : [],
    seAliases: profile ? (profile.seAliases || []).length : 0,
  };
}

async function pathB(c, absoluteEpisode) {
  const t0 = Date.now();
  let requests = 0;
  const map = await request(`${ANIZIP}/mappings?themoviedb_id=${c.tmdbId}`);
  requests += 1;
  const anidbId = map.json && map.json.mappings && map.json.mappings.anidb_id;
  if (!anidbId) {
    return { ms: Date.now() - t0, requests, declined: 'no AniDB mapping', exact: [], broad: [] };
  }
  // ani.zip keys `episodes` by absolute number for long-running shows, which is exactly
  // what the profile already derived — so the two paths are driven from the same input.
  const epMap = (map.json.episodes) || {};
  const entry = absoluteEpisode != null ? epMap[String(absoluteEpisode)] : null;
  const eid = entry && entry.anidbEid;

  const exactRes = eid
    ? await request(`${TOSHO}/json?qx=1&aids=${anidbId}&eids=${eid}`)
    : { json: [] };
  if (eid) requests += 1;
  const broadRes = await request(`${TOSHO}/json?qx=1&aids=${anidbId}`);
  requests += 1;

  return {
    ms: Date.now() - t0,
    requests,
    anidbId,
    anidbEid: eid || null,
    exact: Array.isArray(exactRes.json) ? exactRes.json : [],
    broad: Array.isArray(broadRes.json) ? broadRes.json : [],
  };
}

(async () => {
  if (!TMDB_KEY) {
    console.error('No TMDB key configured — Path A cannot run. Aborting.');
    process.exit(1);
  }
  const tmdb = async (endpoint, params = {}) => {
    const q = new URLSearchParams(Object.assign({ api_key: TMDB_KEY }, params)).toString();
    const r = await request(`https://api.themoviedb.org/3${endpoint}?${q}`);
    return r.json;
  };
  const numbering = createEpisodeNumberingService({ tmdb });
  const scraper = createTorrentScraper();

  const rows = [];
  for (const c of CASES) {
    process.stderr.write(`\n[${c.show}] S${c.season}E${c.episode}\n`);

    const a = await pathA(c, numbering, scraper);
    const b = await pathB(c, a.absoluteEpisode);

    const aHashes = new Map();
    for (const r of a.results) { const h = infohashOf(r); if (h) aHashes.set(h, r); }
    const exactHashes = new Map();
    for (const r of b.exact) { const h = infohashOf(r); if (h) exactHashes.set(h, r); }
    const broadHashes = new Map();
    for (const r of b.broad) { const h = infohashOf(r); if (h) broadHashes.set(h, r); }

    const inBoth = [...exactHashes.keys()].filter((h) => aHashes.has(h));
    const onlyExact = [...exactHashes.keys()].filter((h) => !aHashes.has(h));
    const onlyA = [...aHashes.keys()].filter((h) => !exactHashes.has(h) && !broadHashes.has(h));

    const row = {
      show: c.show,
      requested: `S${c.season}E${c.episode}`,
      absoluteEpisode: a.absoluteEpisode,
      isAnime: a.isAnime,
      pathA: {
        ms: a.ms,
        queryCombos: a.queryCombos,
        results: a.results.length,
        withInfohash: aHashes.size,
        maxSeeders: Math.max(0, ...a.results.map(seedOf)),
        has1080p: a.results.some((r) => res1080(r.name)),
        top: a.results[0] ? String(a.results[0].name).slice(0, 68) : null,
        seasonTitles: a.seasonTitles,
        seAliases: a.seAliases,
      },
      pathB: {
        ms: b.ms,
        requests: b.requests,
        declined: b.declined || null,
        anidbId: b.anidbId || null,
        anidbEid: b.anidbEid || null,
        exactRows: b.exact.length,
        broadRows: b.broad.length,
        maxSeeders: Math.max(0, ...b.exact.map(seedOf)),
        has1080p: b.exact.some((r) => res1080(r.title || r.torrent_name)),
        top: b.exact[0] ? String(b.exact[0].title || b.exact[0].torrent_name).slice(0, 68) : null,
      },
      overlap: {
        bothFound: inBoth.length,
        onlyIdPath: onlyExact.length,
        onlyNamePath: onlyA.length,
        nameRecallOfIdSet: exactHashes.size
          ? Math.round((inBoth.length / exactHashes.size) * 100)
          : null,
      },
    };
    rows.push(row);

    console.log(`\n==== ${c.show}  (requested S${c.season}E${c.episode}, absolute ${a.absoluteEpisode}) ====`);
    console.log(`  NAME  ${String(a.ms).padStart(6)} ms  ${String(a.queryCombos).padStart(3)} query/source combos  ` +
      `${String(a.results.length).padStart(3)} results  maxSeed ${row.pathA.maxSeeders}  1080p ${row.pathA.has1080p}`);
    console.log(`        top: ${row.pathA.top}`);
    console.log(`  ID    ${String(b.ms).padStart(6)} ms  ${String(b.requests).padStart(3)} requests             ` +
      `${String(b.exact.length).padStart(3)} exact (+${b.broad.length} broad)  maxSeed ${row.pathB.maxSeeders}  1080p ${row.pathB.has1080p}` +
      (b.declined ? `  DECLINED: ${b.declined}` : ''));
    console.log(`        top: ${row.pathB.top}`);
    console.log(`  overlap: both ${inBoth.length} | only-id ${onlyExact.length} | only-name ${onlyA.length} | ` +
      `name recall of id set ${row.overlap.nameRecallOfIdSet}%`);
  }

  fs.writeFileSync(RESULTS, JSON.stringify({ runAt: new Date().toISOString(), rows }, null, 2));
  console.log('\nRaw data -> bench/anime-lookup-results.json');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
