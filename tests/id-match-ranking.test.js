'use strict';

// How an id-matched row travels through torrent-scraper.js's ranking, and the two things
// that must be true of it.
//
// 1. It must SURVIVE. rankResults ends in `scored.filter(verdictIsMatch(...))`, which drops
//    anything the name classifier cannot tie to the requested episode. An AniDB episode id
//    is proof the file IS that episode, so a release whose name the classifier cannot read
//    would otherwise be thrown away while being provably correct. That filter bypass is the
//    whole reason the lane is worth having.
// 2. It must not make the lane AUTHORITATIVE. Name matching stays the floor: it is the only
//    path that handles cour splits the resolver refuses, old episodes AnimeTosho has not
//    tagged, batches, and every non-anime title. Measured in bench/ANIME-LOOKUP.md: the id
//    lane returned 0 rows on two of three anime cases. An empty lane must change nothing.
//
// Drives the real searchAllSources with every network source stubbed out, so what is being
// tested is the ranking, not the indexers.

const assert = require('assert');
const { TorrentScraper } = require('../core/torrent-scraper');

const MAGNET = (h) => `magnet:?xt=urn:btih:${h}&dn=x`;
const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H3 = 'cccccccccccccccccccccccccccccccccccccccc';

// A scraper with every HTML source silenced and a fake tosho client.
function scraperWith(toshoRows) {
  const s = new TorrentScraper({
    toshoClient: { search: async (q) => toshoRows(q) },
  });
  s.search1337x = async () => [];
  s.searchYTS = async () => [];
  s.searchPirateBay = async () => [];
  s.searchNyaa = async () => [];
  s.searchSubsPlease = async () => [];
  return s;
}

const BLEACH_OPTS = {
  season: 2,
  episode: 14,
  isAnime: true,
  absoluteEpisode: 380,
  seasonTitles: ['Bleach thousand year blood war'],
  seasonHints: ['thousand year blood war'],
  foreignHints: [],
  partHints: [{ part: 2, episode: 1, hint: 'the separation', resolved: true }],
  seAliases: [{ season: 17, episode: 14, needsHint: false }],
  partLengths: [13, 13, 14, 10],
};

// The point of the whole feature: a name the classifier cannot place still ranks top.
async function testIdMatchedRowSurvivesTheClassifierFilter() {
  const opaque = {
    name: 'ZZ_release_9f8a1c_final',   // nothing parseable: no S/E, no episode number
    seeders: 4,
    leechers: 0,
    size: '1.4 GB',
    link: MAGNET(H1),
    source: 'Tosho',
    idMatched: true,
  };
  const s = scraperWith((q) => (q.eids ? [opaque] : []));
  const out = await s.searchAllSources('Bleach', { ...BLEACH_OPTS, animeIds: { anidbId: 17765, anidbEid: 267537 } });

  assert.strictEqual(out.length, 1, 'an unparseable name must not be filtered out when id-matched');
  assert.strictEqual(out[0].name, opaque.name);
  assert.strictEqual(out[0].exactMatch, true);
  assert.deepStrictEqual(out[0].verdict, { idMatch: true }, 'it never went through classify()');
}

// At comparable health, exactness wins: ID_MATCH_BOOST (2500) sits above the 2000 an
// alias S/E tag earns, so an id-matched row outranks the best thing name parsing can claim.
async function testIdMatchOutranksNameMatchAtSimilarHealth() {
  const idRow = { name: 'Bleach TYBW thing [1080p]', seeders: 100, leechers: 0, size: '1 GB', link: MAGNET(H1), source: 'Tosho', idMatched: true };
  const nameRow = { name: 'Bleach S17E14 [1080p] WEB-DL', seeders: 100, leechers: 0, size: '1 GB', link: MAGNET(H2), source: 'Nyaa' };
  const s = scraperWith((q) => (q.eids ? [idRow] : []));
  s.searchNyaa = async () => [nameRow];

  const out = await s.searchAllSources('Bleach', { ...BLEACH_OPTS, animeIds: { anidbId: 17765, anidbEid: 267537 } });
  assert.ok(out.length >= 2, 'both rows should be kept');
  assert.strictEqual(out[0].idMatched, true, 'equal seeders => the proven episode ranks first');
  assert.ok(out.some((r) => r.source === 'Nyaa'), 'name matching is not suppressed');
}

// Deliberate, and worth pinning so nobody "fixes" it: score is `seeders + evidence boost`,
// so a MUCH healthier row that the classifier also judged to be this exact episode can
// outrank a barely-seeded id match. Both are the right episode; preferring the one that
// will actually play is correct. The id boost decides ties in evidence, not in health.
async function testHealthStillBeatsExactnessWhenBothAreCorrect() {
  const idRow = { name: 'Bleach TYBW thing [1080p]', seeders: 2, leechers: 0, size: '1 GB', link: MAGNET(H1), source: 'Tosho', idMatched: true };
  const healthy = { name: 'Bleach S17E14 [1080p] WEB-DL', seeders: 900, leechers: 0, size: '1 GB', link: MAGNET(H2), source: 'Nyaa' };
  const s = scraperWith((q) => (q.eids ? [idRow] : []));
  s.searchNyaa = async () => [healthy];

  const out = await s.searchAllSources('Bleach', { ...BLEACH_OPTS, animeIds: { anidbId: 17765, anidbEid: 267537 } });
  assert.strictEqual(out[0].source, 'Nyaa', '900 seeders beats 2 when both rows are this episode');
  assert.ok(out.some((r) => r.idMatched), 'the id-matched row is still present, just lower');
}

// The common case, and the one that must be harmless.
async function testEmptyLaneChangesNothing() {
  const nameRow = { name: 'Bleach S17E14 [1080p] WEB-DL', seeders: 900, leechers: 0, size: '1 GB', link: MAGNET(H2), source: 'Nyaa' };
  const s = scraperWith(() => []);
  s.searchNyaa = async () => [nameRow];

  const withIds = await s.searchAllSources('Bleach', { ...BLEACH_OPTS, animeIds: { anidbId: 17765, anidbEid: 267537 } });
  const withoutIds = await s.searchAllSources('Bleach', { ...BLEACH_OPTS });
  assert.deepStrictEqual(
    withIds.map((r) => r.name),
    withoutIds.map((r) => r.name),
    'an id lane that returns nothing must leave the ranking identical'
  );
  assert.strictEqual(withoutIds.length, 1);
}

// No ids => the source must not be queried at all.
async function testLaneIsSkippedWithoutIds() {
  let called = 0;
  const s = scraperWith(() => { called++; return []; });
  await s.searchAllSources('Severance', { season: 1, episode: 1 });
  assert.strictEqual(called, 0, 'no animeIds => no tosho request');
}

// Tosho re-indexes nyaa, so the same release arrives from both. dedupeTorrentResults keys
// on the infohash in `link` — which is why `link` has to be the magnet.
async function testSameReleaseFromBothSourcesMergesOnInfohash() {
  const idRow = { name: 'Bleach S17E14 [1080p]', seeders: 5, leechers: 0, size: '1 GB', link: MAGNET(H3), source: 'Tosho', idMatched: true };
  const nyaaRow = { name: 'Bleach S17E14 [1080p]', seeders: 400, leechers: 0, size: '1 GB', link: MAGNET(H3), source: 'Nyaa' };
  const s = scraperWith((q) => (q.eids ? [idRow] : []));
  s.searchNyaa = async () => [nyaaRow];

  const out = await s.searchAllSources('Bleach', { ...BLEACH_OPTS, animeIds: { anidbId: 17765, anidbEid: 267537 } });
  const sameHash = out.filter((r) => String(r.link).includes(H3));
  assert.strictEqual(sameHash.length, 1, 'one release, one row');
  assert.strictEqual(sameHash[0].seeders, 400, 'the merge keeps the higher seeder count');
}

async function main() {
  await testIdMatchedRowSurvivesTheClassifierFilter();
  await testIdMatchOutranksNameMatchAtSimilarHealth();
  await testHealthStillBeatsExactnessWhenBothAreCorrect();
  await testEmptyLaneChangesNothing();
  await testLaneIsSkippedWithoutIds();
  await testSameReleaseFromBothSourcesMergesOnInfohash();
  console.log('id-match-ranking.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
