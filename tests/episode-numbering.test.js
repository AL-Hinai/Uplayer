'use strict';

// core/episode-numbering.js: the numbering profile derived for a sequel-series anime.
//
// The bug this pins: "Bleach: Thousand-Year Blood War" is TMDB's Bleach season 2, but no
// release is named S02Exx — Disney+ rips carry S17Exx (TVDB order), anime groups number the
// sub-series from 1 under its own title, cour batches restart at each part. The old search
// derived only romaji alt-titles and an absolute number, so every TYBW episode search
// returned nothing (queries missed the names, and the classifier hard-dropped the few hits
// as wrong-season). The profile must expose season-pinning hints, part boundaries, and the
// alternate S/E aliases — all from TMDB data, with no show special-cased.

const assert = require('assert');
const {
  deriveProfile, selectGroupIds, createEpisodeNumberingService, _internals,
} = require('../core/episode-numbering');
const { parseAltTitleType, extractHint, computeAbsoluteEpisode } = _internals;
const { parseName, isMatch } = require('../core/torrent-name-patterns');

// ---- Fixture: a condensed Bleach. Season 1 = 366 eps, season 2 = TYBW, 50 eps in 4 cours.
function bleachDetail() {
  return {
    name: 'Bleach',
    original_name: 'BLEACH',
    original_language: 'ja',
    origin_country: ['JP'],
    genres: [{ id: 10759 }, { id: 16 }],
    number_of_seasons: 2,
    seasons: [
      { season_number: 0, name: 'Specials', episode_count: 4 },
      { season_number: 1, name: 'Bleach', episode_count: 366 },
      { season_number: 2, name: 'Thousand-Year Blood War', episode_count: 50 },
    ],
    alternative_titles: {
      results: [
        { iso_3166_1: 'JP', type: '', title: 'Bleach Sennen Kessen Hen' },
        { iso_3166_1: 'JP', type: 'second series hepburn romazination', title: 'Burīchi: Sennen Kessen-hen' },
        { iso_3166_1: 'JP', type: 'Romaji', title: 'Bleach Sennen Kessen-hen' },
        { iso_3166_1: 'JP', type: 'second series', title: 'BLEACH 千年血戦篇' },
        { iso_3166_1: 'US', type: 'second series', title: 'Bleach: Thousand-Year Blood War' },
        { iso_3166_1: 'US', type: 'second series part 2 title', title: 'Bleach: Thousand-Year Blood War - The Separation' },
        { iso_3166_1: 'US', type: 'second series part 3 title', title: 'Bleach: Thousand-Year Blood War - The Conflict' },
        { iso_3166_1: 'US', type: 'second series', title: 'Bleach: TYBW' },
      ],
    },
  };
}

function seasonEpisodes(season, from, to) {
  const eps = [];
  for (let e = from, order = 0; e <= to; e++, order++) {
    eps.push({ season_number: season, episode_number: e, order });
  }
  return eps;
}

// TVDB order: arcs of season 1 become TVDB seasons 1..16, TYBW becomes TVDB season 17.
// Condensed to two representative groups — derivation only needs to find the episode.
function tvdbGroupPayload() {
  return {
    id: 'tvdb', name: 'TVDB Order', type: 1,
    groups: [
      { name: 'Substitute Shinigami', order: 1, episodes: seasonEpisodes(1, 1, 20) },
      { name: 'Bleach: Thousand-Year Blood War', order: 17, episodes: seasonEpisodes(2, 1, 50) },
    ],
  };
}

// Hulu/Disney+ split: TYBW as its own show, one season per cour.
function splitGroupPayload() {
  return {
    id: 'split', name: 'Hulu Season Split (Thousand-Year Blood War)', type: 4,
    groups: [
      { name: 'The Blood Warfare', order: 1, episodes: seasonEpisodes(2, 1, 13) },
      { name: 'The Separation', order: 2, episodes: seasonEpisodes(2, 14, 26) },
      { name: 'The Conflict', order: 3, episodes: seasonEpisodes(2, 27, 40) },
      { name: 'The Calamity', order: 4, episodes: seasonEpisodes(2, 41, 50) },
    ],
  };
}

function profileFor(season, episode) {
  return deriveProfile({
    detail: bleachDetail(),
    groupPayloads: [tvdbGroupPayload(), splitGroupPayload()],
    season, episode,
  });
}

function testHelpers() {
  assert.deepStrictEqual(parseAltTitleType('second series part 2 title'), { season: 2, part: 2 });
  assert.deepStrictEqual(parseAltTitleType('s02'), { season: 2, part: null });
  assert.deepStrictEqual(parseAltTitleType('Romaji'), { season: null, part: null });
  assert.deepStrictEqual(parseAltTitleType('second series hepburn romazination'), { season: 2, part: null });

  assert.strictEqual(extractHint('Bleach: Thousand-Year Blood War', ['bleach']), 'thousand year blood war');
  assert.strictEqual(extractHint('Burīchi: Sennen Kessen-hen', ['bleach']), 'sennen kessen hen');
  assert.strictEqual(extractHint('BLEACH 千年血戦篇', ['bleach']), null, 'CJK-only subtitle yields no hint');

  const d = bleachDetail();
  assert.strictEqual(computeAbsoluteEpisode(d, 2, 14), 380, 'reset-per-season schema');
  assert.strictEqual(computeAbsoluteEpisode(d, 2, 400), 400, 'already-absolute schema passes through');
}

function testSeasonTwoProfile() {
  const p = profileFor(2, 14); // TYBW "The Separation" episode 1

  assert.strictEqual(p.isAnime, true);
  assert.strictEqual(p.absoluteEpisode, 380);

  for (const hint of ['thousand year blood war', 'sennen kessen hen', 'tybw']) {
    assert.ok(p.seasonHints.includes(hint), `seasonHints should include "${hint}": ${JSON.stringify(p.seasonHints)}`);
  }
  assert.deepStrictEqual(p.foreignHints, [], 'season 1 has no distinctive title to be foreign');

  const alias = (s, e) => p.seAliases.find((a) => a.season === s && a.episode === e);
  assert.ok(alias(17, 14) && alias(17, 14).needsHint === false, 'TVDB-order alias S17E14, unambiguous');
  assert.ok(alias(2, 1) && alias(2, 1).needsHint === true, 'own-show part-split alias S02E01, hint-gated');
  assert.ok(alias(1, 14) && alias(1, 14).needsHint === true, 'own-show continuous alias S01E14, hint-gated');

  const part = (hint) => p.partHints.find((h) => h.hint === hint);
  assert.ok(part('the separation') && part('the separation').episode === 1 && part('the separation').part === 2,
    'requested episode is The Separation ep 1');
  assert.ok(part('the conflict') && part('the conflict').episode === null,
    'requested episode is not in The Conflict — numbering under that title must stay unreadable');

  assert.deepStrictEqual(p.partLengths, [13, 13, 14, 10]);
  assert.strictEqual(p.ownShowSeasonCount, 4);

  assert.ok(p.seasonTitles.some((t) => /thousand year blood war/i.test(t)), 'query variant for the English season title');
  assert.ok(p.seasonTitles.some((t) => /sennen kessen hen/i.test(t)), 'query variant for the romaji season title');

  // Show-level romaji variants (the pre-existing behaviour) survive the refactor.
  assert.ok(p.altTitles.some((t) => /sennen kessen/i.test(t)), 'romaji alt title kept');
}

function testSeasonOneProfile() {
  const p = profileFor(1, 20);

  assert.strictEqual(p.absoluteEpisode, 20);
  assert.deepStrictEqual(p.seasonHints, [], 'season 1 name equals the show name — no hint');
  for (const hint of ['thousand year blood war', 'sennen kessen hen', 'tybw']) {
    assert.ok(p.foreignHints.includes(hint), `foreignHints should include "${hint}"`);
  }
  assert.ok(!p.seAliases.some((a) => a.season === 1 && a.episode === 20),
    'TVDB alias identical to the canonical pair is not an alias');
}

function testNonAnimeIsInert() {
  const p = deriveProfile({
    detail: {
      name: 'Some Drama', original_language: 'en', origin_country: ['US'],
      genres: [{ id: 18 }], seasons: [{ season_number: 1, name: 'Season 1', episode_count: 10 }],
    },
    groupPayloads: [], season: 1, episode: 3,
  });
  assert.strictEqual(p.isAnime, false);
  assert.deepStrictEqual(p.seasonHints, []);
  assert.deepStrictEqual(p.seAliases, []);
  assert.strictEqual(p.absoluteEpisode, null);
}

function testSelectGroupIds() {
  const listing = {
    results: [
      { id: 'a', name: 'Absolute Order', type: 2, episode_count: 416, group_count: 2 },
      { id: 'b', name: 'TVDB Order', type: 1, episode_count: 420, group_count: 18 },
      { id: 'c', name: 'Hulu Season Split (TYBW)', type: 4, episode_count: 50, group_count: 4 },
      { id: 'd', name: 'Netflix', type: 4, episode_count: 131, group_count: 6 },
    ],
  };
  assert.deepStrictEqual(selectGroupIds(listing, 50), ['b', 'c'], 'TVDB order + the split matching the season');
  assert.deepStrictEqual(selectGroupIds(listing, 366), ['b'], 'no split matches season 1');
  assert.deepStrictEqual(selectGroupIds({ results: [] }, 50), []);

  // A story-arc group (type 5) partitions a season exactly like a streaming split, and picking
  // one up is catastrophic: nobody names releases after narrative arcs, so the arc titles
  // become part hints that no correct release can satisfy. This is real TMDB data — Frieren's
  // "Story Arcs" has 38 episodes, exactly its season 1 count.
  const frieren = {
    results: [
      { id: 'abs', name: 'Absolute Order', type: 2, episode_count: 63, group_count: 3 },
      { id: 'arcs', name: 'Story Arcs', type: 5, episode_count: 38, group_count: 7 },
      { id: 'seasons', name: 'Seasons', type: 6, episode_count: 64, group_count: 3 },
      { id: 'cours', name: 'Cours', type: 7, episode_count: 38, group_count: 3 },
    ],
  };
  assert.deepStrictEqual(selectGroupIds(frieren, 38), [],
    'only a type-4 streaming split may be read as a season split');
}

// The other half of the Frieren failure: even from a legitimate group, a part named after a
// fragment of the show's OWN title identifies nothing — every release carries the full title,
// so the "hint" matches all of them. As a part hint it rejected the entire season.
function testShowTitleFragmentIsNeverAHint() {
  const detail = {
    name: "Frieren: Beyond Journey's End",
    original_name: 'Sousou no Frieren',
    original_language: 'ja', origin_country: ['JP'], genres: [{ id: 16 }],
    number_of_seasons: 1,
    seasons: [{ season_number: 1, name: 'Season 1', episode_count: 38 }],
    alternative_titles: { results: [] },
  };
  const split = {
    groups: [
      { name: "Beyond Journey's End", order: 1, episodes: seasonEpisodes(1, 1, 6) },
      { name: 'Aura the Guillotine', order: 2, episodes: seasonEpisodes(1, 7, 11) },
      { name: 'Frieren', order: 3, episodes: seasonEpisodes(1, 12, 38) },
    ],
  };
  const p = deriveProfile({ detail, groupPayloads: [split], season: 1, episode: 12 });
  const hints = p.partHints.map((h) => h.hint);
  assert.ok(!hints.includes('beyond journey s end'),
    `a fragment of the show title must not become a part hint: ${JSON.stringify(hints)}`);
  assert.ok(!hints.includes('frieren'), 'nor the bare show name');
  assert.ok(hints.includes('aura the guillotine'), 'a genuinely distinctive part title still counts');

  // And the practical consequence: a plainly-tagged release must survive.
  const expected = { season: 1, episode: 12, ...p };
  const name = "[Arg0] Frieren: Beyond Journey's End (2023) - S01E12 (WEB 1080p HEVC x265)";
  assert.strictEqual(isMatch(parseName(name), expected), true,
    'a correct S01E12 release must not be rejected by a hint drawn from the show title');
}

async function testServiceFetchPlanAndCache() {
  const calls = [];
  const tmdbStub = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/tv/30984') return bleachDetail();
    if (endpoint === '/tv/30984/episode_groups') {
      return { results: [
        { id: 'tvdb', name: 'TVDB Order', type: 1, episode_count: 420, group_count: 18 },
        { id: 'split', name: 'Hulu Season Split (TYBW)', type: 4, episode_count: 50, group_count: 4 },
      ] };
    }
    if (endpoint === '/tv/episode_group/tvdb') return tvdbGroupPayload();
    if (endpoint === '/tv/episode_group/split') return splitGroupPayload();
    throw new Error('unexpected endpoint ' + endpoint);
  };

  const svc = createEpisodeNumberingService({ tmdb: tmdbStub });
  const p1 = await svc.buildProfile(30984, 2, 14);
  assert.strictEqual(p1.absoluteEpisode, 380);
  assert.ok(p1.seAliases.some((a) => a.season === 17 && a.episode === 14));

  const callsAfterFirst = calls.length;
  const p2 = await svc.buildProfile(30984, 2, 15);
  assert.strictEqual(calls.length, callsAfterFirst, 'second episode of the same show costs zero TMDB calls');
  assert.ok(p2.seAliases.some((a) => a.season === 17 && a.episode === 15));
  const sep = p2.partHints.find((h) => h.hint === 'the separation');
  assert.strictEqual(sep.episode, 2, 'S2E15 is The Separation ep 2');
}

// A transient TMDB failure must not cost the show its aliases for the whole 6h TTL.
// Measured on a working link: three consecutive ECONNRESETs to api.themoviedb.org. Caching
// the resulting `null` group data stranded the show — every later search for it silently lost
// the TVDB aliases and part boundaries, which is exactly the "only one result found" symptom.
async function testTransientFailureIsNotCached() {
  const groupPayloads = { tvdb: tvdbGroupPayload(), split: splitGroupPayload() };
  const groupList = { results: [
    { id: 'tvdb', name: 'TVDB Order', type: 1, episode_count: 420, group_count: 18 },
    { id: 'split', name: 'Hulu Season Split (TYBW)', type: 4, episode_count: 50, group_count: 4 },
  ] };

  // Fail the group-list call the first time only, as a dropped connection would.
  let groupListCalls = 0;
  const tmdb = async (endpoint) => {
    if (endpoint === '/tv/30984') return bleachDetail();
    if (endpoint === '/tv/30984/episode_groups') {
      groupListCalls++;
      if (groupListCalls === 1) throw new Error('read ECONNRESET');
      return groupList;
    }
    const m = /^\/tv\/episode_group\/(.+)$/.exec(endpoint);
    if (m && groupPayloads[m[1]]) return groupPayloads[m[1]];
    throw new Error('unexpected endpoint ' + endpoint);
  };

  // retries:1 so the first call really fails; the point is recovery on the NEXT search.
  // negativeTtlMs:0 isolates that question from the anti-hammering window tested below.
  const svc = createEpisodeNumberingService({ tmdb, retries: 1, negativeTtlMs: 0 });
  const degraded = await svc.buildProfile(30984, 2, 14);
  assert.ok(!degraded.seAliases.some((a) => a.season === 17),
    'precondition: without group data there is no TVDB alias');

  const recovered = await svc.buildProfile(30984, 2, 14);
  assert.ok(recovered.seAliases.some((a) => a.season === 17 && a.episode === 14),
    'the next search must retry the group list, not serve a cached failure');
  assert.ok(recovered.partHints.some((h) => h.hint === 'the separation' && h.episode === 1),
    'part boundaries recover too');
  assert.strictEqual(groupListCalls, 2, 'exactly one retry — a success is still cached');

  const third = await svc.buildProfile(30984, 2, 15);
  assert.strictEqual(groupListCalls, 2, 'once it succeeds it is cached, not re-fetched');
  assert.ok(third.seAliases.some((a) => a.season === 17 && a.episode === 15));
}

// The other half of that trade: recovery must not turn into hammering. A group endpoint that
// stays down would otherwise re-pay the full retry budget (up to 15s per attempt) on every
// single search, which the user experiences as the search hanging before it even starts.
async function testFailuresAreNotRetriedOnEverySearch() {
  let groupListCalls = 0;
  const tmdb = async (endpoint) => {
    if (endpoint === '/tv/30984') return bleachDetail();
    if (endpoint === '/tv/30984/episode_groups') { groupListCalls++; throw new Error('ENETUNREACH'); }
    throw new Error('unexpected endpoint ' + endpoint);
  };

  const svc = createEpisodeNumberingService({ tmdb, retries: 1, retryDelayMs: 0, negativeTtlMs: 60000 });
  for (let i = 0; i < 5; i++) {
    const p = await svc.buildProfile(30984, 2, 14 + i);
    // Degraded but still useful: the show-level derivation never depended on episode groups.
    assert.strictEqual(p.absoluteEpisode, 380 + i, 'profile still derives without group data');
    assert.ok(p.seasonHints.includes('thousand year blood war'));
  }
  assert.strictEqual(groupListCalls, 1,
    `a dead endpoint must be attempted once per window, not once per search (was ${groupListCalls})`);
}

// The retry itself: a call that fails twice and then succeeds must still yield a full profile.
async function testRetriesRideOutABlip() {
  let detailCalls = 0;
  const tmdb = async (endpoint) => {
    if (endpoint === '/tv/30984') {
      detailCalls++;
      if (detailCalls <= 2) throw new Error('read ECONNRESET');
      return bleachDetail();
    }
    if (endpoint === '/tv/30984/episode_groups') return { results: [] };
    throw new Error('unexpected endpoint ' + endpoint);
  };

  const svc = createEpisodeNumberingService({ tmdb, retries: 3, retryDelayMs: 0 });
  const p = await svc.buildProfile(30984, 2, 14);
  assert.strictEqual(detailCalls, 3, 'retried until it succeeded');
  assert.strictEqual(p.absoluteEpisode, 380, 'profile is complete after the retries');

  // Exhausting the retries still throws, so the caller can fall back to a plain title search.
  const alwaysFails = createEpisodeNumberingService({
    tmdb: async () => { throw new Error('read ECONNRESET'); }, retries: 2, retryDelayMs: 0,
  });
  await assert.rejects(() => alwaysFails.buildProfile(30984, 2, 14), /ECONNRESET/,
    'a persistent failure propagates rather than returning a silently empty profile');
}

async function main() {
  testHelpers();
  testSeasonTwoProfile();
  testSeasonOneProfile();
  testNonAnimeIsInert();
  testSelectGroupIds();
  testShowTitleFragmentIsNeverAHint();
  await testServiceFetchPlanAndCache();
  await testTransientFailureIsNotCached();
  await testFailuresAreNotRetriedOnEverySearch();
  await testRetriesRideOutABlip();
  console.log('episode-numbering.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
