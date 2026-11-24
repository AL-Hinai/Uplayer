'use strict';

// The AniDB id lane, and specifically the failure it was built to fix.
//
// The bug under test: a naive `ani.zip?themoviedb_id=` lookup returns ONE AniDB series, but
// the mapping is many-to-one. TMDB calls Bleach's second season one 50-episode season;
// AniDB splits it into four series of 13/13/14/10 that all report themoviedb_id 30984, and
// the reverse index answers with the ORIGINAL Bleach (366 episodes). The requested absolute
// number (380) falls outside that entry, so the indexer query returned zero rows for a
// perfectly findable episode — measured, 0 rows, in bench/ANIME-LOOKUP.md.
//
// The fix reads TMDB's own cour split, which core/episode-numbering.js already parses into
// partLengths [13,13,14,10] plus a resolved partHint {part: 2, episode: 1}, and matches that
// ordered signature against the franchise's AniList entries in release order.
//
// Equally important is what the resolver REFUSES. A wrong id returns confidently wrong
// torrents, which is worse than none, so an airing cour (AniList reports episodes: null)
// and an ambiguous signature both resolve to null. Callers read null as "no id lane".
//
// Pure: every HTTP call is an injected stub. No network.

const assert = require('assert');
const { createAnimeIdResolver } = require('../core/anime-ids');

// --- fixtures, trimmed from live payloads captured 2026-11-24 -----------------
const BLEACH_ORIGINAL = {
  mappings: { anidb_id: 2369, anilist_id: 269, themoviedb_id: '30984', type: 'TV' },
  // 366 real episodes; absolute 380 does not exist here. That is the whole bug.
  episodes: { 1: { anidbEid: 22206, absoluteEpisodeNumber: 1 }, 366: { anidbEid: 99999, absoluteEpisodeNumber: 366 } },
};
const BLEACH_KETSUBETSU = {
  mappings: { anidb_id: 17765, anilist_id: 159322, themoviedb_id: '30984', type: 'TV' },
  episodes: { 1: { anidbEid: 267537, absoluteEpisodeNumber: null } },
};
const FRIEREN = {
  mappings: { anidb_id: 17617, anilist_id: 154587, themoviedb_id: '209867', type: 'TV' },
  episodes: { 5: { anidbEid: 271708, absoluteEpisodeNumber: 5 } },
};

const TYBW_SIBLINGS = [
  { id: 116674, episodes: 13, startDate: { year: 2022 }, title: { romaji: 'BLEACH: Sennen Kessen-hen' } },
  { id: 159322, episodes: 13, startDate: { year: 2023 }, title: { romaji: '...Ketsubetsu-tan' } },
  { id: 169755, episodes: 14, startDate: { year: 2024 }, title: { romaji: '...Soukoku-tan' } },
  { id: 185874, episodes: 10, startDate: { year: 2026 }, title: { romaji: '...Kashin-tan' } },
];

const BLEACH_PROFILE = {
  tmdbId: 30984,
  absoluteEpisode: 380,
  partLengths: [13, 13, 14, 10],
  partHints: [
    { part: 3, episode: null, hint: 'the conflict', resolved: true },
    { part: 2, episode: 1, hint: 'the separation', resolved: true },
    { part: null, episode: null, hint: 'kakahjuu tan', resolved: false },
  ],
  seasonTitles: ['Bleach thousand year blood war', 'Bleach sennen kessen hen'],
};

function build({ siblings = TYBW_SIBLINGS, withAnilist = true } = {}) {
  const calls = { urls: [], searches: [] };
  const fetchJson = async (url) => {
    calls.urls.push(url);
    if (/themoviedb_id=30984/.test(url)) return BLEACH_ORIGINAL;
    if (/themoviedb_id=209867/.test(url)) return FRIEREN;
    if (/anilist_id=159322/.test(url)) return BLEACH_KETSUBETSU;
    if (/anilist_id=/.test(url)) return { mappings: {}, episodes: {} };
    throw new Error('unexpected url ' + url);
  };
  const anilistQuery = async (_q, vars) => {
    calls.searches.push(vars.search);
    return { data: { Page: { media: siblings } } };
  };
  const r = createAnimeIdResolver(withAnilist ? { fetchJson, anilistQuery } : { fetchJson });
  return { r, calls };
}

// The headline: the case that returned nothing now resolves, via the right AniDB series.
async function testCourBridgeReachesTheRightSeries() {
  const { r, calls } = build();
  const ids = await r.resolve(BLEACH_PROFILE);
  assert.ok(ids, 'Bleach S2E14 must resolve');
  assert.strictEqual(ids.strategy, 'cour-bridge');
  assert.strictEqual(ids.anidbId, 17765, 'must be Ketsubetsu-tan (part 2), not the original Bleach');
  assert.strictEqual(ids.anidbEid, 267537, 'episode 1 WITHIN the cour, not absolute 380');
  assert.ok(!calls.urls.some((u) => /themoviedb_id=30984/.test(u)),
    'the bridge answers without ever needing the many-to-one reverse lookup');
}

// Single-entry anime needs no bridge; the absolute number addresses it directly.
async function testDirectLookupForSingleCourShow() {
  const { r } = build();
  const ids = await r.resolve({
    tmdbId: 209867, absoluteEpisode: 5, partLengths: null, partHints: null, seasonTitles: ['Frieren'],
  });
  assert.ok(ids, 'Frieren S1E5 must resolve');
  assert.strictEqual(ids.strategy, 'direct');
  assert.strictEqual(ids.anidbId, 17617);
  assert.strictEqual(ids.anidbEid, 271708);
}

// An airing cour has no episode count, so every window shifts. Refuse, do not guess.
async function testAiringCourRefusesRatherThanGuessing() {
  const airing = TYBW_SIBLINGS.map((m, i) => (i === 3 ? { ...m, episodes: null } : m));
  const { r } = build({ siblings: airing });
  const ids = await r.resolve(BLEACH_PROFILE);
  // Falls through to the direct path, which cannot find absolute 380 in the original
  // series — so the honest answer is null, not a wrong series.
  assert.strictEqual(ids, null, 'an airing sibling must not produce a bridged id');
}

// A repeated signature like [12,12] can match several windows. More than one => no answer.
async function testAmbiguousSignatureRefuses() {
  const twelves = [
    { id: 1, episodes: 12, startDate: { year: 2020 }, title: { romaji: 'a' } },
    { id: 2, episodes: 12, startDate: { year: 2021 }, title: { romaji: 'b' } },
    { id: 3, episodes: 12, startDate: { year: 2022 }, title: { romaji: 'c' } },
  ];
  const { r } = build({ siblings: twelves });
  const ids = await r.resolve({
    tmdbId: 30984, absoluteEpisode: 999,
    partLengths: [12, 12],
    partHints: [{ part: 1, episode: 3, resolved: true }],
    seasonTitles: ['something'],
  });
  assert.strictEqual(ids, null, 'two matching windows is not an answer');
}

// Without an AniList fetcher the bridge is simply unavailable; direct lookups still work.
async function testBridgeIsOptional() {
  const { r } = build({ withAnilist: false });
  const direct = await r.resolve({ tmdbId: 209867, absoluteEpisode: 5 });
  assert.ok(direct && direct.strategy === 'direct', 'direct path must not need AniList');
  const bridged = await r.resolve(BLEACH_PROFILE);
  assert.strictEqual(bridged, null, 'no AniList fetcher => no bridge, and no guess');
}

// Null is the normal answer, and it must be cheap and quiet.
async function testUnresolvableInputsReturnNull() {
  const { r } = build();
  assert.strictEqual(await r.resolve({}), null, 'no tmdbId');
  assert.strictEqual(await r.resolve({ tmdbId: 30984 }), null, 'no absolute episode, no parts');
  const bad = createAnimeIdResolver({ fetchJson: async () => { throw new Error('offline'); } });
  assert.strictEqual(await bad.resolve({ tmdbId: 209867, absoluteEpisode: 5 }), null,
    'a dead ani.zip returns null, it does not throw into the caller');
}

// The payload is up to 1.8 MB; the resolver must not hold it, and must not refetch it.
async function testMappingsAreCachedAndTrimmed() {
  const { r, calls } = build();
  await r.resolve({ tmdbId: 209867, absoluteEpisode: 5 });
  await r.resolve({ tmdbId: 209867, absoluteEpisode: 5 });
  const anizipCalls = calls.urls.filter((u) => /themoviedb_id=209867/.test(u)).length;
  assert.strictEqual(anizipCalls, 1, 'second resolve must come from cache');
  const cached = r._mapCache.get('tmdb:209867');
  assert.deepStrictEqual(Object.keys(cached).sort(), ['anidbId', 'episodes', 'type'],
    'only the fields actually read are kept');
  assert.deepStrictEqual(Object.keys(cached.episodes['5']).sort(), ['absoluteEpisodeNumber', 'anidbEid']);
}

async function main() {
  await testCourBridgeReachesTheRightSeries();
  await testDirectLookupForSingleCourShow();
  await testAiringCourRefusesRatherThanGuessing();
  await testAmbiguousSignatureRefuses();
  await testBridgeIsOptional();
  await testUnresolvableInputsReturnNull();
  await testMappingsAreCachedAndTrimmed();
  console.log('anime-ids.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
