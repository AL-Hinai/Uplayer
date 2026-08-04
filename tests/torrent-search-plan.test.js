'use strict';

// core/torrent-scraper.js searchAllSources: the QUERY PLAN and the pacing rules.
// No network — the five per-source search methods are stubbed on the instance, so this test
// observes exactly which queries would be issued, in what order, and with what concurrency.
//
// Three behaviours are pinned, each of which cost real results when it was wrong:
//
// 1. Nyaa's query list is capped and ordered. Nyaa throttles same-IP bursts, so the list must
//    be short and lead with the forms that actually find sequel-series anime. It used to be
//    ~14 unordered queries, and the productive ones were the ones that got dropped.
// 2. Queries within a source are SEQUENTIAL. Measured against Nyaa: concurrency 1 answered
//    6/6 in 3.1s, concurrency 2 took 9.9s, concurrency 3 answered only 5/6. Overlapping is
//    both slower and lossier.
// 3. Sequential execution is bounded by a time budget. Without it a sick network turns
//    per-request timeouts into a sum (measured: 105s for a single result), so follow-up
//    queries stop once the budget is spent — but every source always gets its first query.

const assert = require('assert');
const { TorrentScraper } = require('../core/torrent-scraper');

const SOURCE_METHODS = {
  '1337x': 'search1337x',
  YTS: 'searchYTS',
  PirateBay: 'searchPirateBay',
  Nyaa: 'searchNyaa',
  SubsPlease: 'searchSubsPlease',
};

// Replace every source with a recording stub. `delays` maps a source name to the ms each of
// its queries should take (fake timers would not exercise the real await chain).
function stubScraper(delays = {}) {
  const scraper = new TorrentScraper();
  const calls = []; // { source, query, startedAt, endedAt }
  for (const [source, method] of Object.entries(SOURCE_METHODS)) {
    scraper[method] = async (query) => {
      const entry = { source, query, startedAt: Date.now() };
      calls.push(entry);
      const wait = delays[source] || 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      entry.endedAt = Date.now();
      return [];
    };
  }
  return { scraper, calls };
}

const BLEACH_PROFILE = {
  isAnime: true,
  absoluteEpisode: 408,
  altTitles: ['Bleach Sennen Kessen Hen', 'Buriichi: Sennen Kessen-hen', 'BLEACH'],
  seasonTitles: ['Bleach thousand year blood war', 'Bleach sennen kessen hen', 'Bleach tybw'],
  seasonHints: ['thousand year blood war', 'sennen kessen hen', 'tybw'],
  foreignHints: [],
  partHints: [],
  seAliases: [
    { season: 17, episode: 42, needsHint: false },
    { season: 4, episode: 2, needsHint: true },
    { season: 1, episode: 42, needsHint: true },
  ],
  partLengths: [13, 13, 14, 10],
  ownShowSeasonCount: 4,
};

async function testNyaaPlanIsCappedAndOrdered() {
  const { scraper, calls } = stubScraper();
  await scraper.searchAllSources('Bleach', { season: 2, episode: 42, ...BLEACH_PROFILE });

  const nyaa = calls.filter((c) => c.source === 'Nyaa').map((c) => c.query);
  assert.ok(nyaa.length <= 6, `Nyaa must stay capped, got ${nyaa.length}: ${JSON.stringify(nyaa)}`);
  assert.strictEqual(new Set(nyaa).size, nyaa.length, 'no duplicate Nyaa queries');

  // Highest-yield first: the season title with the season-relative episode number is the form
  // sequel-series anime is actually published under.
  assert.strictEqual(nyaa[0], 'Bleach thousand year blood war 42',
    `season-title query must lead, got ${JSON.stringify(nyaa)}`);
  // The TVDB alias tag is what the Disney+/Hulu rips carry, so it must survive the cap.
  assert.ok(nyaa.includes('Bleach S17E42'),
    `unambiguous alias tag must be queried, got ${JSON.stringify(nyaa)}`);
  // A hint-gated alias must NOT become a query — "Bleach S01E42" is a real, different episode
  // of the original series, so asking a tracker for it invites the wrong show-season.
  assert.ok(!nyaa.includes('Bleach S01E42'), 'hint-gated alias must not be queried');
  assert.ok(!nyaa.includes('Bleach S04E02'), 'hint-gated alias must not be queried');

  // PirateBay carries the alias tag too (that is where the DSNP rips are indexed).
  const pirate = calls.filter((c) => c.source === 'PirateBay').map((c) => c.query);
  assert.ok(pirate.includes('Bleach S17E42'), `PirateBay should query the alias, got ${JSON.stringify(pirate)}`);
  assert.ok(pirate.includes('Bleach S02E42'), 'PirateBay keeps the canonical tag as well');
}

async function testQueriesAreSequentialWithinASourceButParallelAcross() {
  const DELAY = 60;
  const { scraper, calls } = stubScraper({ Nyaa: DELAY, PirateBay: DELAY, SubsPlease: DELAY, '1337x': DELAY });
  await scraper.searchAllSources('Bleach', { season: 2, episode: 42, ...BLEACH_PROFILE });

  for (const source of Object.keys(SOURCE_METHODS)) {
    const own = calls.filter((c) => c.source === source).sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 1; i < own.length; i++) {
      assert.ok(own[i].startedAt >= own[i - 1].endedAt,
        `${source} query ${i} started before query ${i - 1} finished — queries must not overlap`);
    }
  }

  // Sources must still overlap each other, or a five-source search would take five times as long.
  const nyaaFirst = calls.find((c) => c.source === 'Nyaa');
  const pirateFirst = calls.find((c) => c.source === 'PirateBay');
  assert.ok(nyaaFirst && pirateFirst, 'both sources ran');
  assert.ok(Math.abs(nyaaFirst.startedAt - pirateFirst.startedAt) < DELAY,
    'different sources must start concurrently');
}

async function testTimeBudgetTrimsTheTailButNeverTheFirstQuery() {
  // Every query takes longer than the whole budget, so only the first per source can fit.
  const SLOW = 21000;
  const { scraper, calls } = stubScraper({
    Nyaa: SLOW, PirateBay: SLOW, SubsPlease: SLOW, '1337x': SLOW, YTS: SLOW,
  });

  const started = Date.now();
  await scraper.searchAllSources('Bleach', { season: 2, episode: 42, ...BLEACH_PROFILE });
  const elapsed = Date.now() - started;

  for (const source of ['Nyaa', 'PirateBay', 'SubsPlease', '1337x']) {
    const own = calls.filter((c) => c.source === source);
    assert.strictEqual(own.length, 1,
      `${source} must run its first query and then stop on the budget, ran ${own.length}`);
  }

  // One in-flight request per source is unavoidable; what must not happen is a SUM of them.
  assert.ok(elapsed < SLOW * 2,
    `budget must stop the tail: took ${elapsed}ms for queries of ${SLOW}ms each`);
}

async function testProfileFreeSearchIsUnchanged() {
  const { scraper, calls } = stubScraper();
  await scraper.searchAllSources('Breaking Bad', { season: 3, episode: 7 });

  const bySource = {};
  for (const c of calls) (bySource[c.source] = bySource[c.source] || []).push(c.query);

  assert.deepStrictEqual(bySource['1337x'], ['Breaking Bad S03E07']);
  assert.deepStrictEqual(bySource.PirateBay, ['Breaking Bad S03E07', 'Breaking Bad']);
  assert.deepStrictEqual(bySource.Nyaa, ['Breaking Bad S03E07']);
  assert.strictEqual(bySource.YTS, undefined, 'YTS is skipped for episode searches');
  assert.strictEqual(bySource.SubsPlease, undefined, 'SubsPlease is skipped for non-anime');

  // And the legacy positional signature still plans the same way.
  const legacy = stubScraper();
  await legacy.scraper.searchAllSources('Breaking Bad S03E07', null, 3, 7);
  assert.ok(legacy.calls.some((c) => c.source === 'PirateBay' && c.query === 'Breaking Bad S03E07'),
    'legacy positional call still builds the S##E## query');
}

async function main() {
  await testNyaaPlanIsCappedAndOrdered();
  await testQueriesAreSequentialWithinASourceButParallelAcross();
  await testTimeBudgetTrimsTheTailButNeverTheFirstQuery();
  await testProfileFreeSearchIsUnchanged();
  console.log('torrent-search-plan.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
