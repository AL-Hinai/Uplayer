'use strict';

// Shared torrent-name parsing rules used by both the survey/analyzer and the
// proposed in-app filter rewrite. Centralizing them here means we tune one
// regex set and the production code, the corpus survey, and the test runner
// all use the same definitions.

// Recognises an explicit Season tag: `S02`, `Season 2`, `s_02`, etc.
// Word-boundary anchored so the literal `s` in words like "wars", "stars",
// or "seasons" doesn't get scooped up.
const SEASON_TAG_RE = /\b(?:s|season)[\s_]*(\d{1,3})\b(?!\d)/i;

// Recognises an explicit Episode tag co-located with Season:
//   S02E03, S2E3, S02 E03, S02_E3, S02EP03, s2ep3, S02xE03 (rare)
const SE_PAIR_RE = /\b(?:s|season)[\s_]*(\d{1,3})[\s_]*(?:e|ep|episode|x)[\s_]*(\d{1,5})\b/i;

// Episode-only tags (no season prefix): EP1163, E03, Episode 5
// Requires a non-letter boundary before so we don't match the `e` in `the`.
const EPISODE_ONLY_RE = /(?:^|[^a-z0-9])(?:ep|e|episode)[\s_]*(\d{1,5})\b/i;

// Anime " - NN" pattern (SubsPlease/Erai-raws/HorribleSubs/ASW),
// rejecting common false positives (resolution suffixes, audio kbps).
//   "[SubsPlease] One Piece - 1163 (1080p)" -> 1163
//   "Show - 1080p" -> no match
//   "Show - 02v2 [HEVC]" -> 02
const ANIME_DASH_RE = /\s-\s(\d{1,4})(?:v\d+)?(?![\dpk])(?=[\s\[\(\.\]]|$)/i;

// Long-form: "Season 2 Episode 3"
const LONGFORM_RE = /season[\s_]+(\d{1,3})[\s_]+episode[\s_]+(\d{1,5})/i;

// Anime "[Group] Show SN - EE" pattern where SN is a season tag inline,
// e.g. "Show S2 - 03". Captured separately because the season tag is unattached
// to the episode marker.
const ANIME_SEASON_DASH_RE = /\b(?:s|season)[\s_]*(\d{1,3})[\s_]*-[\s_]*(\d{1,4})\b/i;

// Resolution / audio markers we should NEVER treat as episode numbers.
const RESOLUTION_RE = /\b(?:480|540|576|720|1080|1440|2160|4320)p\b/i;

// 4-digit year in the name (used for cross-show / wrong-show heuristic).
const YEAR_RE = /\b(19[5-9]\d|20\d{2})\b/;

/**
 * Extract a structured verdict from a torrent name. Pure function — no I/O,
 * no scoring, just "what does this name claim about itself".
 *
 * @param {string} rawName
 * @returns {{
 *   exactSE: { season:number, episode:number } | null,
 *   seasonTag: number | null,
 *   episodeTag: number | null,
 *   animeDashEpisode: number | null,
 *   longformSE: { season:number, episode:number } | null,
 *   year: number | null,
 *   hasResolution: boolean,
 *   patternsHit: string[]
 * }}
 */
function parseName(rawName) {
  const name = String(rawName || '');
  const lower = name.toLowerCase();
  const patternsHit = [];

  // Strip resolution tokens before episode-only matching so that `1080` in
  // `1080p` never leaks into the episode capture. We replace with spaces to
  // preserve length-based positions.
  const sanitized = lower.replace(/\b(\d{3,4})p\b/g, '   p');

  let exactSE = null;
  const sePair = sanitized.match(SE_PAIR_RE);
  if (sePair) {
    exactSE = { season: parseInt(sePair[1], 10), episode: parseInt(sePair[2], 10) };
    patternsHit.push('SE_PAIR');
  }

  let longformSE = null;
  const lf = sanitized.match(LONGFORM_RE);
  if (lf) {
    longformSE = { season: parseInt(lf[1], 10), episode: parseInt(lf[2], 10) };
    patternsHit.push('LONGFORM');
  }

  // Standalone season tag (only count if not already part of an SE pair we
  // captured — but we still want to know if a wrong S## is sitting in the name).
  let seasonTag = null;
  const seasonMatch = sanitized.match(SEASON_TAG_RE);
  if (seasonMatch) {
    seasonTag = parseInt(seasonMatch[1], 10);
    if (!exactSE) patternsHit.push('SEASON_ONLY');
  }

  let episodeTag = null;
  const epOnly = sanitized.match(EPISODE_ONLY_RE);
  if (epOnly && !exactSE) {
    episodeTag = parseInt(epOnly[1], 10);
    patternsHit.push('EP_ONLY');
  }

  let animeDashEpisode = null;
  const animeDash = sanitized.match(ANIME_DASH_RE);
  if (animeDash) {
    animeDashEpisode = parseInt(animeDash[1], 10);
    patternsHit.push('ANIME_DASH');
  }

  const animeSeasonDash = sanitized.match(ANIME_SEASON_DASH_RE);
  if (animeSeasonDash && !exactSE) {
    // Only adopt if it looks plausible (avoid `S2 - 1080` style false hits;
    // resolution was already stripped above so anything left should be safe).
    const ep = parseInt(animeSeasonDash[2], 10);
    if (ep > 0 && ep < 9999) {
      exactSE = { season: parseInt(animeSeasonDash[1], 10), episode: ep };
      patternsHit.push('ANIME_SEASON_DASH');
    }
  }

  const yearMatch = sanitized.match(YEAR_RE);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  const hasResolution = RESOLUTION_RE.test(lower);

  // Bare numeric tokens — used by the anime absolute-episode rule for cases
  // like `One Piece 1163` (no S/E marker, no `Show - NN` dash). We exclude
  // plausible years, the SE-pair episode we already captured, and tokens
  // that are inside a `start-end` range (manga/season compilations like
  // `1044-1163` would otherwise false-positive on every absolute episode in
  // the range). Resolution numbers were stripped above.
  const bareTokens = [];
  const tokenRe = /(\d+)?(?:-)?(\d{2,5})(?=[^a-z0-9p]|$)/gi;
  // The split is intentional: capture a hyphen-prefixed number so we can skip
  // it. We also need a precondition that the candidate is preceded by a
  // word-boundary (start, space, or non-alphanumeric).
  const tokenRe2 = /(?:^|[^a-z0-9])(\d+)(?:[\-–]\d+)?(?=[^a-z0-9p]|$)/gi;
  let m;
  while ((m = tokenRe2.exec(sanitized)) != null) {
    // m[1] is the leading number. If a range follows, the trailing number is
    // consumed by the regex but NOT captured — we just skip it.
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (n < 10) continue; // too short to disambiguate from version markers
    if (n >= 1950 && n <= 2099) continue; // skip year-like tokens
    if (exactSE && n === exactSE.episode) continue;
    bareTokens.push(n);
  }

  return {
    exactSE,
    seasonTag,
    episodeTag,
    animeDashEpisode,
    longformSE,
    year,
    hasResolution,
    bareTokens,
    patternsHit,
  };
}

/**
 * Given a parsed name and the show's expected (season, episode, absoluteEpisode),
 * produce match flags. This is the *one* function the production filter, the
 * survey, and the test runner all consult.
 */
function classify(parsed, expected) {
  const { season, episode, absoluteEpisode, isAnime } = expected;

  const exactSEMatch =
    parsed.exactSE &&
    parsed.exactSE.season === season &&
    parsed.exactSE.episode === episode;

  const longformMatch =
    parsed.longformSE &&
    parsed.longformSE.season === season &&
    parsed.longformSE.episode === episode;

  // Episode-only match (S omitted): the releaser tagged the episode but not
  // the season. Trustworthy ONLY if there is no contradicting season tag, AND
  // the episode number lines up with either the requested episode or, for
  // anime, the absolute episode.
  const hasContradictingSeason =
    parsed.seasonTag != null && parsed.seasonTag !== season;

  const episodeOnlyMatch =
    !exactSEMatch &&
    !hasContradictingSeason &&
    parsed.episodeTag != null &&
    (parsed.episodeTag === episode ||
      (isAnime && absoluteEpisode != null && parsed.episodeTag === absoluteEpisode));

  const animeDashMatch =
    !exactSEMatch &&
    !hasContradictingSeason &&
    parsed.animeDashEpisode != null &&
    (parsed.animeDashEpisode === episode ||
      (isAnime && absoluteEpisode != null && parsed.animeDashEpisode === absoluteEpisode));

  // For long-running anime (One Piece, Detective Conan, Doraemon) releasers
  // routinely strip every marker and tag only the absolute episode number
  // (e.g. `One Piece 1163`). Accept that *only* when the show is anime, no
  // contradicting season tag is present, and the absolute number appears as
  // a standalone token in the name.
  const absoluteFromBare =
    isAnime &&
    absoluteEpisode != null &&
    !hasContradictingSeason &&
    Array.isArray(parsed.bareTokens) &&
    parsed.bareTokens.includes(absoluteEpisode);

  const absoluteMatch =
    isAnime &&
    absoluteEpisode != null &&
    !exactSEMatch &&
    !hasContradictingSeason &&
    (parsed.episodeTag === absoluteEpisode ||
      parsed.animeDashEpisode === absoluteEpisode ||
      absoluteFromBare);

  // Wrong-season is a *hard* signal of mis-match for live-action. For anime,
  // the absolute-episode path can override it.
  const wrongSeason =
    parsed.exactSE && parsed.exactSE.season !== season;

  return {
    exactSEMatch: !!exactSEMatch,
    longformMatch: !!longformMatch,
    episodeOnlyMatch: !!episodeOnlyMatch,
    animeDashMatch: !!animeDashMatch,
    absoluteMatch: !!absoluteMatch,
    wrongSeason: !!wrongSeason,
    hasContradictingSeason: !!hasContradictingSeason,
  };
}

/**
 * Top-level decision: should this torrent be considered a match for the
 * requested (show, season, episode)? Used by the production filter and by
 * the test runner's TopHit assertion.
 */
function isMatch(parsed, expected) {
  const c = classify(parsed, expected);
  if (c.exactSEMatch || c.longformMatch) return true;
  if (c.absoluteMatch) return true;
  if (c.wrongSeason) return false;
  if (c.episodeOnlyMatch) return true;
  if (c.animeDashMatch) return true;
  return false;
}

module.exports = {
  SEASON_TAG_RE,
  SE_PAIR_RE,
  EPISODE_ONLY_RE,
  ANIME_DASH_RE,
  LONGFORM_RE,
  ANIME_SEASON_DASH_RE,
  RESOLUTION_RE,
  YEAR_RE,
  parseName,
  classify,
  isMatch,
};
