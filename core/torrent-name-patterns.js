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

// Explicit part/cour tag: "Part 2", "Cour 2". Signals the episode number that follows is
// numbered within that part, not within the season.
const PART_TAG_RE = /\b(?:part|cour)[\s._-]*0*(\d{1,2})\b/i;

// Resolution / audio markers we should NEVER treat as episode numbers.
const RESOLUTION_RE = /\b(?:480|540|576|720|1080|1440|2160|4320)p\b/i;

// 4-digit year in the name (used for cross-show / wrong-show heuristic).
const YEAR_RE = /\b(19[5-9]\d|20\d{2})\b/;

// Canonical form for title-hint containment: macrons folded to double vowels (Yūsha→Yuusha,
// matching tracker romaji), lowercased, every punctuation run collapsed to one space. Must
// stay in sync with normalizeTitle in core/episode-numbering.js, which produces the hints.
function normalizeReleaseText(rawName) {
  return String(rawName || '')
    .replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu')
    .replace(/ē/g, 'ee').replace(/ō/g, 'ou')
    .replace(/Ā/g, 'Aa').replace(/Ī/g, 'Ii').replace(/Ū/g, 'Uu')
    .replace(/Ē/g, 'Ee').replace(/Ō/g, 'Ou')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

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

  let partTag = null;
  const partMatch = sanitized.match(PART_TAG_RE);
  if (partMatch) {
    partTag = parseInt(partMatch[1], 10);
    patternsHit.push('PART_TAG');
  }

  // Bare numeric tokens — used by the anime absolute-episode rule for cases
  // like `One Piece 1163` (no S/E marker, no `Show - NN` dash). We exclude
  // plausible years, the SE-pair episode we already captured, and tokens
  // that are inside a `start-end` range (manga/season compilations like
  // `1044-1163` would otherwise false-positive on every absolute episode in
  // the range). Resolution numbers were stripped above.
  // We also need a precondition that the candidate is preceded by a word-boundary (start,
  // space, or non-alphanumeric). A trailing `start-end` range is consumed but NOT captured.
  const bareTokens = [];
  const tokenRe = /(?:^|[^a-z0-9])(\d+)(?:[\-–]\d+)?(?=[^a-z0-9p]|$)/gi;
  let m;
  while ((m = tokenRe.exec(sanitized)) != null) {
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n)) continue;
    if (n < 10) continue; // too short to disambiguate from version markers
    if (n >= 1950 && n <= 2099) continue; // skip year-like tokens
    if (exactSE && n === exactSE.episode) continue;
    // Codec and bit-depth numbers are not episodes. `H.264`, `x265`, `HEVC 10 bit` all leave
    // a bare 2-3 digit token behind, and any of them landing on the absolute episode number
    // made an unrelated release look like an exact hit (`Bleach - 003 [H.265]` scored as
    // absolute episode 265). Judge by the neighbouring word, which is what distinguishes them.
    // The match starts one separator char before the digits (or at position 0 via `^`).
    const digitsAt = m.index + (m[0].startsWith(m[1]) ? 0 : 1);
    const before = sanitized.slice(Math.max(0, digitsAt - 12), digitsAt);
    const after = sanitized.slice(digitsAt + m[1].length, digitsAt + m[1].length + 6);
    if (/(?:^|[^a-z])(?:h|x|avc|hevc|av|mpeg|aac|ac|dd|dts|ddp|opus|flac)[\s._-]*$/i.test(before)) continue;
    if (/^[\s._-]*(?:bits?|kbps|fps|khz)\b/i.test(after)) continue;
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
    partTag,
    bareTokens,
    normalized: normalizeReleaseText(name),
    patternsHit,
  };
}

// When a release name carries a season-pinning title hint, a bare episode number is only
// trustworthy if it sits right after the hint with nothing unexplained in between —
// "Sennen Kessen-hen - 14" yes, "Sennen Kessen-hen ~Kashin-tan~ - 14" no (that unknown
// subtitle is a cour title, and its numbering restarts). Years and episode-marker tokens
// (e/ep/episode, v2) are allowed through; any other word or number means the number we
// found belongs to something else.
function relativeNumberNearHint(normalized, hint, episode) {
  if (!hint || episode == null) return false;
  const padded = ' ' + normalized + ' ';
  const needle = ' ' + hint + ' ';
  // Every occurrence, not just the first: a group tag that repeats the season title
  // ("[Sennen Kessen-hen Subs] Bleach - Sennen Kessen-hen - 14") would otherwise be judged
  // on the tag and never reach the real one.
  for (let from = 0; ; ) {
    const idx = padded.indexOf(needle, from);
    if (idx < 0) return false;
    from = idx + 1;
    if (readsAs(normalized.slice(idx + hint.length), episode)) return true;
  }
}

// Does the text immediately following a season title read as `episode`?
function readsAs(rest, episode) {
  for (const tok of rest.trim().split(' ')) {
    if (!tok) continue;
    const asNum = /^0*(\d{1,5})(?:v\d+)?$/.exec(tok);
    if (asNum) {
      const n = parseInt(asNum[1], 10);
      if (n === episode) return true;
      if (n >= 1950 && n <= 2099) continue; // a year in the title line, not a number
      return false; // some other number first — a different episode or part numbering
    }
    // An explicit S##E## tag is NOT a relative number: it names a season, and only the alias
    // machinery knows which alternate numberings are legitimate for this episode. Reading it
    // positionally accepted "Thousand-Year Blood War S05E14" for S2E14.
    if (/^s0*\d{1,3}e0*\d{1,5}$/.test(tok)) return false;
    const et = /^(?:e|ep)0*(\d{1,5})$/.exec(tok);
    if (et) return parseInt(et[1], 10) === episode;
    if (/^(?:e|ep|episode)$/.test(tok)) continue;
    return false; // an unexplained word between the season title and any number
  }
  return false;
}

/**
 * Given a parsed name and the show's expected (season, episode, absoluteEpisode),
 * produce match flags. This is the *one* function the production filter, the
 * survey, and the test runner all consult.
 */
function classify(parsed, expected) {
  const { season, episode, absoluteEpisode, isAnime } = expected;
  // Optional numbering profile from core/episode-numbering.js. Without it every new flag
  // stays false and the function behaves exactly as before.
  const seasonHints = expected.seasonHints || [];
  const foreignHints = expected.foreignHints || [];
  const partHints = expected.partHints || [];
  const seAliases = expected.seAliases || [];
  const partLengths = expected.partLengths || null;
  const ownShowSeasonCount = expected.ownShowSeasonCount != null ? expected.ownShowSeasonCount : null;

  const padded = ' ' + (parsed.normalized || '') + ' ';
  const containsHint = (h) => !!h && padded.includes(' ' + h + ' ');
  const seasonHintHits = seasonHints.filter(containsHint);
  const seasonHintHit = seasonHintHits.length > 0;
  const foreignHintHit = foreignHints.some(containsHint);

  // ---- Cour / part reasoning ---------------------------------------------------
  // A part title in the name is only allowed to OVERRIDE the normal rules when the profile
  // can actually adjudicate it — i.e. a split episode group told us which episodes that cour
  // holds (`resolved`). An unresolved part hint, or a bare "Part 2" we cannot map to a cour,
  // is not evidence of anything and must fall through, or perfectly-tagged releases get
  // dropped ("Attack on Titan The Final Season Part 2 S04E17" is exactly how those ship).
  const partHits = partHints.filter((p) => p && containsHint(p.hint));
  const namedRightPart = partHits.some((p) => p.episode != null);
  // Named a cour that provably does NOT contain the requested episode → wrong release.
  const namedWrongPart = !namedRightPart
    && partHits.some((p) => p.resolved && p.episode == null);

  // A bare "Part N" is only readable when no cour was named outright and the profile knows
  // the boundaries; otherwise it is ignored entirely.
  const bareTagPart = (!partHits.length && parsed.partTag != null && seasonHintHit)
    ? partHints.find((p) => p && p.part === parsed.partTag && p.resolved) || null
    : null;
  const wrongPart = namedWrongPart || !!(bareTagPart && bareTagPart.episode == null);

  // Explicit S/E under an alternate numbering of the same episode (TVDB order, own-show
  // continuous, own-show part split). Aliases that collide with plausible TMDB numbering
  // only count when a season-pinning hint confirms the alternate context.
  const aliasHit = (se) => !!se && seAliases.some((a) =>
    a && a.season === se.season && a.episode === se.episode && (!a.needsHint || seasonHintHit));
  const aliasSEMatch = aliasHit(parsed.exactSE) || aliasHit(parsed.longformSE);

  // A name that pins the season by title AND tags an S/E inside the own-show season range is
  // using the sequel-series' own numbering (Hulu/Plex style). If that reading is valid (the
  // part is long enough to contain the episode) and it is not an alias of the requested
  // episode, it is some other episode — even when the tag happens to equal the requested
  // TMDB pair.
  // Requires KNOWN boundaries: without them there is nothing to check the alternate reading
  // against, and firing anyway rejected plainly-correct releases ("Thousand-Year Blood War
  // S02E45" for S2E45 — no cour is 45 episodes long, so the own-show reading was never
  // plausible in the first place).
  let ownShowMismatch = false;
  if (seasonHintHit && parsed.exactSE && !aliasSEMatch
      && ownShowSeasonCount != null && Array.isArray(partLengths)
      && parsed.exactSE.season >= 2 && parsed.exactSE.season <= ownShowSeasonCount
      && parsed.exactSE.season <= partLengths.length) {
    ownShowMismatch = parsed.exactSE.episode <= partLengths[parsed.exactSE.season - 1];
  }

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

  // A bare per-season episode number ("- 02", "Episode 2") is only trustworthy
  // for the requested season when that season is actually pinned down: either
  // it's season 1 / unknown, or the name carries a season tag equal to it.
  // Anime trackers (SubsPlease/Erai) leave season-1 releases untagged and tag
  // only later seasons, so an untagged "- 02" on a season>=2 request is really
  // S01E02 (or an absolute number) — never the requested S02E02. In that case
  // only the absolute-episode branch may match.
  const perSeasonEpisodeTrusted =
    season == null || season <= 1 || parsed.seasonTag === season;

  const episodeOnlyMatch =
    !exactSEMatch &&
    !hasContradictingSeason &&
    parsed.episodeTag != null &&
    ((perSeasonEpisodeTrusted && parsed.episodeTag === episode) ||
      (isAnime && absoluteEpisode != null && parsed.episodeTag === absoluteEpisode));

  const animeDashMatch =
    !exactSEMatch &&
    !hasContradictingSeason &&
    parsed.animeDashEpisode != null &&
    ((perSeasonEpisodeTrusted && parsed.animeDashEpisode === episode) ||
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

  // A season-pinning title hint makes the release's own numbering readable: the number that
  // follows the hint is the episode within that (sub-)series, whatever season tag the name
  // carries ("Bleach - Thousand-Year Blood War - 014", "Sennen Kessen-hen S01E14"). Part
  // context disables this — a part title means the numbering restarted at the part boundary.
  const hintedRelativeMatch = !aliasSEMatch && !ownShowMismatch && !wrongPart && !namedRightPart
    && seasonHintHits.some((h) => relativeNumberNearHint(parsed.normalized || '', h, episode));

  // When the name identifies the cour that holds the requested episode, a bare number in it
  // is that episode's position WITHIN the cour. Only cours actually named in this release
  // count — consulting every known part let a "Part 2" tag borrow another cour's numbering.
  const wantedLocal = new Set();
  for (const p of partHits) if (p.episode != null) wantedLocal.add(p.episode);
  if (!partHits.length && bareTagPart && bareTagPart.episode != null) wantedLocal.add(bareTagPart.episode);
  const partRelativeMatch = wantedLocal.size > 0 && [
    parsed.animeDashEpisode,
    parsed.episodeTag,
    parsed.exactSE ? parsed.exactSE.episode : null,
  ].some((n) => n != null && wantedLocal.has(n));

  // A hint for a DIFFERENT season, with nothing pinning the requested one, is the strongest
  // wrong-release signal there is — the name literally says which sub-series it belongs to.
  // Absolute numbering can still redeem such a name (batches list absolute ranges), but only
  // when the absolute number differs from the plain episode number — otherwise the "absolute"
  // hit is indistinguishable from the foreign sub-series' own restarted numbering (requesting
  // S1E20 must not accept "Thousand-Year Blood War - 20").
  const foreignSeason = foreignHintHit && !seasonHintHit;
  const absoluteDistinct = absoluteMatch && !(foreignSeason && absoluteEpisode === episode);

  return {
    exactSEMatch: !!exactSEMatch,
    longformMatch: !!longformMatch,
    episodeOnlyMatch: !!episodeOnlyMatch,
    animeDashMatch: !!animeDashMatch,
    absoluteMatch: !!absoluteDistinct,
    wrongSeason: !!wrongSeason,
    hasContradictingSeason: !!hasContradictingSeason,
    aliasSEMatch: !!aliasSEMatch,
    hintedRelativeMatch: !!hintedRelativeMatch,
    partRelativeMatch: !!partRelativeMatch,
    ownShowMismatch: !!ownShowMismatch,
    foreignSeason: !!foreignSeason,
    seasonHintHit: !!seasonHintHit,
    wrongPart: !!wrongPart,
  };
}

/**
 * Top-level decision: should this torrent be considered a match for the
 * requested (show, season, episode)? Used by the production filter and by
 * the test runner's TopHit assertion.
 */
// The keep/drop decision over a classify() verdict. Split out so the production filter in
// torrent-scraper (which already holds the verdict for scoring) and isMatch stay one rule set.
//
// Unifying them changed one thing on the production side, deliberately: the old inline filter
// also dropped anything with `hasContradictingSeason && !absoluteMatch`, which `isMatch` never
// had. That rule fired on names carrying a matching S##E## AND a separate standalone season
// tag ("Attack on Titan S01 S02 S03 S04E17"), i.e. multi-season packs that name the episode —
// which are legitimate sources for it. An exact S/E match is the strongest signal available;
// a stray season token elsewhere in the name does not outrank it.
function verdictIsMatch(c) {
  // Naming a cour that provably excludes this episode outranks everything: the release says
  // in words which part of the season it is, and it is not this one. It beats even an alias
  // tag, because "The Conflict S01E14" is that cour's episode 14, not the season's.
  if (c.wrongPart) return !!c.absoluteMatch;
  if (c.aliasSEMatch) return true;
  if (c.ownShowMismatch) return false;
  if (c.foreignSeason) return !!c.absoluteMatch;
  if (c.exactSEMatch || c.longformMatch) return true;
  if (c.absoluteMatch) return true;
  if (c.partRelativeMatch) return true;
  if (c.hintedRelativeMatch) return true;
  if (c.wrongSeason) return false;
  if (c.episodeOnlyMatch) return true;
  if (c.animeDashMatch) return true;
  return false;
}

function isMatch(parsed, expected) {
  return verdictIsMatch(classify(parsed, expected));
}

// Quality tier from the release name: 2160p/4K → 4, 1080p → 3, 720p → 2,
// SD tokens (480/540/576p) → 1, unknown → 0. Drives the picker's quality badge
// and the preferred-quality filter, which falls back to the unfiltered set when
// no release matches — so an untagged release (tier 0) is never silently lost.
const QUALITY_LABELS = { 4: '2160p', 3: '1080p', 2: '720p', 1: 'SD' };
function qualityTier(rawName) {
  const name = String(rawName || '').toLowerCase();
  if (/\b(?:2160p|4320p)\b/.test(name) || /\b(?:4k|uhd)\b/.test(name)) return 4;
  if (/\b1080p?\b/.test(name)) return 3;
  if (/\b720p?\b/.test(name)) return 2;
  if (/\b(?:480|540|576)p\b/.test(name)) return 1;
  return 0;
}
const qualityLabel = (tier) => QUALITY_LABELS[tier] || null;

// BitTorrent infohash out of a magnet link (hex or base32 form), lowercased hex
// where possible so the same torrent from two indexers dedupes to one key.
// Non-magnet links (page/.torrent URLs) return null — no infohash to compare.
function extractInfohash(link) {
  const m = String(link || '').match(/xt=urn:btih:([a-z0-9]{32,40})/i);
  if (!m) return null;
  const hash = m[1].toLowerCase();
  if (/^[0-9a-f]{40}$/.test(hash)) return hash;
  return hash; // base32 form — still a stable dedupe key, just not hex-normalized
}

module.exports = {
  SEASON_TAG_RE,
  SE_PAIR_RE,
  EPISODE_ONLY_RE,
  ANIME_DASH_RE,
  LONGFORM_RE,
  ANIME_SEASON_DASH_RE,
  PART_TAG_RE,
  RESOLUTION_RE,
  YEAR_RE,
  parseName,
  classify,
  isMatch,
  verdictIsMatch,
  normalizeReleaseText,
  qualityTier,
  qualityLabel,
  extractInfohash,
};
