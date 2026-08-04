'use strict';

// core/torrent-name-patterns.js + core/episode-numbering.js, end to end over real release
// names observed on the trackers for Bleach: Thousand-Year Blood War (TMDB season 2).
//
// The corpus is the point: for ONE episode (S2E14, "The Separation" ep 1) the wild carries at
// least four numbering schemes — TVDB order (S17E14), sub-series relative under a season
// title ("- 014", "S01E14"), absolute ("[EP: 380]"), and cour-relative ("The Separation -
// 01"). The classifier must accept all of those and still refuse the traps: the same number
// under a DIFFERENT cour title, an unknown cour subtitle, other episodes of the same
// sub-series, and (for season-1 requests) anything titled with the sequel series' name.

const assert = require('assert');
const { parseName, classify, isMatch } = require('../core/torrent-name-patterns');
const { deriveProfile } = require('../core/episode-numbering');

// Same condensed Bleach fixture as episode-numbering.test.js (kept local: the two tests pin
// different modules and must fail independently).
function bleachDetail() {
  return {
    name: 'Bleach',
    original_name: 'BLEACH',
    original_language: 'ja',
    origin_country: ['JP'],
    genres: [{ id: 16 }],
    number_of_seasons: 2,
    seasons: [
      { season_number: 1, name: 'Bleach', episode_count: 366 },
      { season_number: 2, name: 'Thousand-Year Blood War', episode_count: 50 },
    ],
    alternative_titles: {
      results: [
        { iso_3166_1: 'JP', type: 'Romaji', title: 'Bleach Sennen Kessen-hen' },
        { iso_3166_1: 'JP', type: 'second series hepburn romazination', title: 'Burīchi: Sennen Kessen-hen' },
        { iso_3166_1: 'US', type: 'second series', title: 'Bleach: Thousand-Year Blood War' },
        { iso_3166_1: 'US', type: 'second series', title: 'Bleach: TYBW' },
        { iso_3166_1: 'US', type: 'second series part 2 title', title: 'Bleach: Thousand-Year Blood War - The Separation' },
        { iso_3166_1: 'US', type: 'second series part 3 title', title: 'Bleach: Thousand-Year Blood War - The Conflict' },
      ],
    },
  };
}

function seasonEpisodes(season, from, to) {
  const eps = [];
  for (let e = from, order = 0; e <= to; e++, order++) eps.push({ season_number: season, episode_number: e, order });
  return eps;
}

const GROUPS = [
  {
    id: 'tvdb', name: 'TVDB Order', type: 1,
    groups: [
      { name: 'Substitute Shinigami', order: 1, episodes: seasonEpisodes(1, 1, 20) },
      { name: 'Bleach: Thousand-Year Blood War', order: 17, episodes: seasonEpisodes(2, 1, 50) },
    ],
  },
  {
    id: 'split', name: 'Hulu Season Split (Thousand-Year Blood War)', type: 4,
    groups: [
      { name: 'The Blood Warfare', order: 1, episodes: seasonEpisodes(2, 1, 13) },
      { name: 'The Separation', order: 2, episodes: seasonEpisodes(2, 14, 26) },
      { name: 'The Conflict', order: 3, episodes: seasonEpisodes(2, 27, 40) },
      { name: 'The Calamity', order: 4, episodes: seasonEpisodes(2, 41, 50) },
    ],
  },
];

function expectedFor(season, episode) {
  const p = deriveProfile({ detail: bleachDetail(), groupPayloads: GROUPS, season, episode });
  return { season, episode, isAnime: p.isAnime, absoluteEpisode: p.absoluteEpisode, ...p };
}

function check(expected, name, want, why) {
  const got = isMatch(parseName(name), expected);
  assert.strictEqual(got, want, `${why}\n  name: ${name}\n  verdict: ${JSON.stringify(classify(parseName(name), expected))}`);
}

function testSeasonTwoEpisode14() {
  const exp = expectedFor(2, 14);

  // Every numbering scheme the trackers actually use for this one episode:
  check(exp, 'Bleach S17E14 Thousand-Year Blood War My Last Words 1080p DSNP WEB-DL AAC2 0 H 264', true,
    'TVDB-order tag (Disney+/Hulu rips) must match via the alias');
  check(exp, '[Anime Time] Bleach - Thousand-Year Blood War - 014 - The Last 9 Days [BD][1080p][HEVC]', true,
    'sub-series relative number right after the season title');
  check(exp, '[SubsPlease] Bleach - Sennen Kessen-hen - 14 (1080p) [ABCD1234].mkv', true,
    'romaji season title with continued numbering');
  check(exp, '[EMBER] Bleach: Sennen Kessen-hen S01E14 [EP: 380] [1080p] (Bleach: Thousand-Year Blood War - The Separation)', true,
    'own-show continuous S01E14 (and absolute 380) despite the part title also appearing');
  check(exp, '[New-raws] Bleach Thousand-Year Blood War - The Separation - 01 [1080p] [Hulu].mkv', true,
    'cour-relative numbering under a known part title with resolved boundaries');
  check(exp, 'Bleach: Thousand-Year Blood War S02E01 1080p WEB x264', true,
    'own-show part-split tag (Hulu lists cours as seasons)');

  // The traps:
  check(exp, '[New-raws] Bleach Thousand-Year Blood War - The Conflict - 14 END [1080p] [Hulu].mkv', false,
    'same number under a DIFFERENT cour title is a different episode (S2E40)');
  check(exp, '[shincaps] BLEACH Sennen Kessen-hen ~Kashin-tan~ - 14 (AT-X 1440x1080 MPEG2 AAC).ts', false,
    'unknown cour subtitle between season title and number — numbering unreadable, refuse');
  check(exp, 'Bleach S17E27 Thousand-Year Blood War A REPACK 1080p DSNP WEB-DL', false,
    'a different episode in TVDB order');
  check(exp, 'BLEACH Thousand-Year Blood War S01 JAPANESE 1080p DSNP WEBRip x264-NTb', false,
    'season pack with no episode number');
  check(exp, 'Bleach - 14 [480p]', false,
    'a bare dash number with no season pin is old Bleach ep 14, not TYBW');
  check(exp, 'Bleach S02E14 1080p', true,
    'plain TMDB numbering still matches (no hint, no ambiguity)');
}

function testPartBoundaryEpisodes() {
  // S2E27 = "The Conflict" episode 1.
  const exp27 = expectedFor(2, 27);
  check(exp27, '[New-raws] Bleach Thousand-Year Blood War - The Conflict - 01 [1080p] [Hulu].mkv', true,
    'cour-relative ep 1 under The Conflict is S2E27');
  check(exp27, '[New-raws] Bleach Thousand-Year Blood War - The Separation - 01 [1080p] [Hulu].mkv', false,
    'ep 1 under The Separation is S2E14, not S2E27');
  check(exp27, 'Bleach S17E27 Thousand-Year Blood War A 1080p DSNP WEB-DL', true,
    'TVDB alias S17E27');

  // Ambiguous own-show tag: for S2E1 a "Thousand-Year Blood War S02E01" release means the
  // second COUR's first episode (S2E14), not TMDB S02E01 — must refuse rather than guess.
  const exp1 = expectedFor(2, 1);
  check(exp1, 'Bleach: Thousand-Year Blood War S02E01 1080p WEB x264', false,
    'own-show reading of the tag wins when a season hint is present');
  check(exp1, 'Bleach S17E01 Thousand-Year Blood War The Blood Warfare 1080p DSNP', true,
    'TVDB alias S17E01');
  check(exp1, '[SubsPlease] Bleach - Sennen Kessen-hen - 01 (1080p)', true,
    'sub-series relative ep 1');
}

function testSeasonOneRequestsRejectSequelReleases() {
  const exp = expectedFor(1, 20);
  check(exp, '[Anime Time] Bleach - Thousand-Year Blood War - 020 [BD][1080p]', false,
    'sequel-series title is a foreign hint for a season-1 request, and 20 is not absolute-distinct');
  check(exp, '[SubsPlease] Bleach - Sennen Kessen-hen - 20 (1080p)', false,
    'romaji sequel title likewise');
  check(exp, 'Bleach S01E20 1080p BluRay', true, 'plain season-1 tag still matches');
  check(exp, 'Bleach - 20 [DVD]', true, 'bare dash number is trustworthy for season 1 (anime survey rule)');
}

// Bugs found by adversarial review of the first cut of this feature. Each one was reproduced
// against the real modules before being fixed, and each is a case the hand-written corpus
// above missed — so they are pinned separately rather than folded in.
function testReviewRegressions() {
  const exp14 = expectedFor(2, 14); // The Separation, cour episode 1
  const exp1 = expectedFor(2, 1);

  // --- False negatives: part context used to veto everything -------------------
  // A cour title that AGREES with the requested episode was still treated as a reason to
  // distrust the name, so the canonical tag plus the right cour title was rejected.
  check(exp14, 'Bleach S02E14 Thousand-Year Blood War The Separation 1080p DSNP WEB-DL', true,
    'canonical S/E tag confirmed by the correct cour title must match');
  check(exp14, 'Bleach Thousand-Year Blood War - The Separation - S02E14 1080p', true,
    'same, with the cour title before the tag');

  // A bare "Part N" with no cour data to interpret it must be ignored, not turned into a
  // veto. "Attack on Titan The Final Season Part 2 S04E17" is how those actually ship, and
  // this dropped the entire result set for such a show.
  const noParts = { ...expectedFor(2, 14), partHints: [], partLengths: null, ownShowSeasonCount: null };
  check(noParts, 'Bleach Thousand-Year Blood War Part 2 S02E14 1080p WEB-DL', true,
    'an uninterpretable "Part N" must not suppress a correct exact tag');
  // A BARE number after an uninterpretable "Part N" stays refused, and should: without cour
  // boundaries "Part 2 - 14" is either the season's episode 14 or the part's, and those are
  // different episodes. Refusing costs a release; guessing costs the viewer the wrong one.
  check(noParts, 'Bleach Thousand-Year Blood War Part 2 - 14 [1080p]', false,
    'an unresolvable part number leaves a bare episode number genuinely ambiguous');
  // With boundaries known it is not ambiguous at all, and must resolve.
  check(exp14, '[New-raws] Bleach Thousand-Year Blood War - The Separation - 01 [1080p]', true,
    'a named cour with known boundaries resolves the same shape');

  // --- False positives: alias tags used to outrank a contradicting cour --------
  // "The Conflict" is cour 3 (S2E27-40). Its episode 14 is S2E40, not the requested S2E14 —
  // the alias check used to fire first and accept it.
  check(exp14, '[EMBER] Bleach: Sennen Kessen-hen - The Conflict S01E14 [EP: 406] [1080p]', false,
    'a cour title that excludes this episode must beat the own-show alias');
  check(exp14, 'Bleach Thousand-Year Blood War The Conflict S02E01 1080p', false,
    'likewise for the part-split alias');
  // And a "Part N" tag must not borrow a different cour's numbering.
  check(exp14, '[SubsPlease] Bleach - Sennen Kessen-hen - The Conflict Part 2 - 01 (1080p)', false,
    'the named cour wins over a disagreeing Part tag');

  // --- False positive: relative reading ignored the season in an S##E## tag ----
  check(exp14, 'Bleach Thousand-Year Blood War S05E14 1080p', false,
    'an explicit S/E tag is not a relative number — season 5 is not this show season');
  check(exp14, 'Bleach Thousand-Year Blood War S99E14 1080p', false, 'same for any season');

  // --- False negative: the hint was only looked for once ----------------------
  check(exp14, '[Sennen Kessen-hen Subs] Bleach - Sennen Kessen-hen - 14 [1080p]', true,
    'a group tag repeating the season title must not mask the real occurrence');

  // --- False positive: codec / bit-depth numbers read as absolute episodes -----
  // absoluteEpisode for S1E265 is 265, and "H.265" leaves a bare 265 behind.
  const exp265 = expectedFor(1, 265);
  check(exp265, '[Group] Bleach - 003 [1080p][H.265][AAC]', false,
    'H.265 is a codec, not absolute episode 265');
  const exp264 = expectedFor(1, 264);
  check(exp264, 'Bleach - 500 [1080p] H.264 AAC', false, 'H.264 likewise');
  const exp10 = expectedFor(1, 10);
  check(exp10, '[Judas] Bleach - 03 (1080p) [HEVC 10 bit][AAC]', false,
    '10 bit is a bit depth, not absolute episode 10');
  // The real absolute form must still work.
  check(exp265, '[Group] Bleach - 265 [1080p][H.265][AAC]', true, 'the genuine absolute number still matches');

  // --- False negative: own-show mismatch fired without known boundaries -------
  const noBoundaries = { ...expectedFor(2, 45), partLengths: null, ownShowSeasonCount: 4 };
  check(noBoundaries, 'Bleach Thousand-Year Blood War S02E45 1080p', true,
    'with no cour boundaries there is no plausible alternate reading to prefer');

  // The guard must still hold where boundaries ARE known: cour 2 has 13 episodes, so
  // "S02E01" under a season hint reads as cour 2 episode 1 = S2E14.
  check(exp1, 'Bleach: Thousand-Year Blood War S02E01 1080p WEB x264', false,
    'with boundaries known the own-show reading still wins');

  // --- Crash safety: malformed profile arrays -------------------------------
  const junk = { season: 2, episode: 14, isAnime: true, absoluteEpisode: 380,
    seasonHints: [null], foreignHints: [null], partHints: [null], seAliases: [null] };
  assert.doesNotThrow(() => isMatch(parseName('Bleach S02E14 1080p'), junk),
    'null entries in profile arrays must not crash the classifier');
  assert.strictEqual(isMatch(parseName('Bleach S02E14 1080p'), junk), true);
}

// The original rule set, before the numbering profile existed. Reproduced verbatim so the
// equivalence sweep below compares against a fixed reference rather than against whatever
// classify() currently happens to do.
function legacyIsMatch(c) {
  if (c.exactSEMatch || c.longformMatch) return true;
  if (c.absoluteMatch) return true;
  if (c.wrongSeason) return false;
  if (c.episodeOnlyMatch) return true;
  if (c.animeDashMatch) return true;
  return false;
}

// Every show that is NOT a sequel-series anime gets an empty profile (no season hints, no
// aliases), and TMDB being unreachable produces no profile at all. In both cases the verdict
// must be exactly what it was before this feature existed — the profile may only ADD
// understanding, never change the baseline. Swept over a corpus rather than spot-checked,
// because a single stray flag in classify() would otherwise surface as a mystery regression
// on some unrelated show months later.
function testProfileFreeEquivalenceSweep() {
  const NAMES = [
    'Show S02E03 720p HDTV', 'Show S01E03 720p HDTV', 'Show.S02E03.1080p.WEB-DL',
    'Show Season 2 Episode 3 HDTV', 'Show - 03 [1080p]', 'Show - 1109 (1080p)',
    'Show E03 480p', 'Show EP1109 1080p', 'Show 2160p UHD', 'Show S02 COMPLETE 1080p',
    'Show S02E03 Part 2 720p', 'Show Part 1 S02E03', 'Show Cour 2 - 03',
    'Show (2019) - 03v2 [HEVC]', 'Show 1109 1080p', 'Show S23E1109', 'Show S2 - 03',
    '[Group] Show - 03 (1080p) [ABCD1234]', '[Group] Show S02E03 [1080p]',
    'Show.2019.S02E03.INTERNAL.1080p', 'Show 03 END 1080p', 'Show - 1044-1109 batch',
    'Show The Movie 2021 1080p', 'Show S02E03E04 1080p', 'Show s02 e03 720p',
    'Another Show S17E42 Thousand-Year Blood War 1080p', 'Show - The Separation - 01',
    'Show 1080p S02E03', 'Show.S00E03.Special', 'Show S02E03 REPACK 2160p',
  ];
  const EXPECTATIONS = [
    { season: 2, episode: 3, isAnime: false, absoluteEpisode: null },
    { season: 1, episode: 3, isAnime: false, absoluteEpisode: null },
    { season: 2, episode: 3, isAnime: true, absoluteEpisode: 15 },
    { season: 23, episode: 3, isAnime: true, absoluteEpisode: 1109 },
    { season: 1, episode: 1109, isAnime: true, absoluteEpisode: 1109 },
    { season: null, episode: null, isAnime: false, absoluteEpisode: null },
    { season: 17, episode: 42, isAnime: true, absoluteEpisode: 408 },
  ];
  // The shapes a profile-free caller can produce: nothing at all, and an explicitly empty
  // profile (a non-anime show, where deriveProfile returns empty arrays and nulls).
  const EMPTY_PROFILE = {
    seasonHints: [], foreignHints: [], partHints: [], seAliases: [],
    partLengths: null, ownShowSeasonCount: null,
  };

  let compared = 0;
  for (const name of NAMES) {
    const parsed = parseName(name);
    for (const base of EXPECTATIONS) {
      for (const extra of [{}, EMPTY_PROFILE]) {
        const expected = { ...base, ...extra };
        const verdict = classify(parsed, expected);
        assert.strictEqual(
          isMatch(parsed, expected), legacyIsMatch(verdict),
          `profile-free verdict diverged from the original rule set\n  name: ${name}\n  expected: ${JSON.stringify(base)}\n  verdict: ${JSON.stringify(verdict)}`
        );
        // The profile-only flags must all be inert, not merely harmless in this ordering.
        for (const flag of ['aliasSEMatch', 'hintedRelativeMatch', 'partRelativeMatch',
          'ownShowMismatch', 'foreignSeason', 'seasonHintHit', 'wrongPart']) {
          assert.strictEqual(verdict[flag], false,
            `${flag} must stay false without a profile\n  name: ${name}\n  expected: ${JSON.stringify(expected)}`);
        }
        compared++;
      }
    }
  }
  assert.ok(compared >= 400, `sweep should be broad, compared ${compared}`);
}

function testProfileAbsentKeepsLegacyBehaviour() {
  // No profile fields at all — the pre-profile rule set must be untouched.
  const exp = { season: 23, episode: 5, isAnime: true, absoluteEpisode: 1109 };
  assert.strictEqual(isMatch(parseName('One Piece S23E05 1080p'), exp), true);
  assert.strictEqual(isMatch(parseName('[SubsPlease] One Piece - 1109 (1080p)'), exp), true);
  assert.strictEqual(isMatch(parseName('[SubsPlease] One Piece - 05 (1080p)'), exp), false,
    'untagged per-season number on a season>=2 request stays untrusted');
  assert.strictEqual(isMatch(parseName('One Piece S02E05 1080p'), exp), false);

  const live = { season: 2, episode: 3, isAnime: false, absoluteEpisode: null };
  assert.strictEqual(isMatch(parseName('Show S02E03 720p HDTV'), live), true);
  assert.strictEqual(isMatch(parseName('Show S01E03 720p HDTV'), live), false);
  assert.strictEqual(isMatch(parseName('Show S02E03 Part 2 720p'), live), true,
    'a bare "Part 2" in a live-action name must not create part context');
}

function main() {
  testSeasonTwoEpisode14();
  testPartBoundaryEpisodes();
  testSeasonOneRequestsRejectSequelReleases();
  testProfileAbsentKeepsLegacyBehaviour();
  testProfileFreeEquivalenceSweep();
  testReviewRegressions();
  console.log('anime-episode-matching.test.js passed');
}

main();
