'use strict';

// Derives every identity a TV episode has in the wild, so the torrent search can find and
// recognise releases that do not use TMDB's canonical numbering.
//
// Why this module exists: TMDB says "Bleach S02E14". The actual releases of that episode are
// named "Bleach S17E14 Thousand-Year Blood War ..." (TVDB order, used by Disney+/Hulu rips),
// "[Anime Time] Bleach - Thousand-Year Blood War - 014" (sequel-series numbering under a
// season-specific title), "[EMBER] Bleach: Sennen Kessen-hen S01E14 [EP: 380]" (own-show
// numbering plus absolute), and "...The Separation - 01" (cour/part numbering). No single
// (season, episode) pair can match all of those. What can is a *profile*: title hints that pin
// the season, alternate S/E aliases resolved from TMDB episode groups, part boundaries, and
// the absolute number. Everything is derived from TMDB data at request time — no show is
// special-cased.
//
// Deliberately excludes: release-name matching (core/torrent-name-patterns.js consumes the
// profile) and any HTTP of its own — the TMDB fetcher is injected, and every derivation over
// fetched payloads is a pure function exposed for tests.
//
// IO: none directly; the injected fetcher does it. Timers: one setTimeout, for retry backoff.
// `deriveProfile` and the helpers below it are pure — that is the half worth testing, and
// tests/episode-numbering.test.js drives the fetching half with a stub.
//
// Known limitation: a season hint is only attributed to a season when TMDB's alternative-title
// `type` names one ("second series", "s02", "...part 2 title"). A title typed only "Romaji"
// carries no season, so it becomes a search variant but not a matching hint, and such a show
// falls back to the pre-profile rules. Guessing the season for an untyped title was considered
// and rejected: attributing one to the wrong season manufactures false matches, which is a
// worse failure than the miss it would avoid.

// Anime trackers use double-vowel romaji (Yuusha); TMDB often stores the Hepburn macron form
// (Yūsha). ō→ou matches the おう the trackers spell out.
const deMacron = (s) => String(s || '')
  .replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu')
  .replace(/ē/g, 'ee').replace(/ō/g, 'ou')
  .replace(/Ā/g, 'Aa').replace(/Ī/g, 'Ii').replace(/Ū/g, 'Uu')
  .replace(/Ē/g, 'Ee').replace(/Ō/g, 'Ou');

const hasCjk = (s) => /[　-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/.test(String(s || ''));

// Canonical form used for hint containment checks against release names. Must stay in sync
// with normalizeReleaseText in core/torrent-name-patterns.js (same alphabet, same collapsing).
function normalizeTitle(s) {
  return deMacron(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Parse a TMDB alternative-title `type` string into { season, part }. The field is free text
// ("second series", "s02", "second series part 2 title", "Romaji") so both numeric and
// ordinal-word forms are recognised. Returns nulls when the type pins nothing.
const ORDINALS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
function parseAltTitleType(type) {
  const t = String(type || '').toLowerCase();
  let season = null;
  let part = null;

  const partM = /\bpart[\s_]*0*(\d{1,2})\b/.exec(t);
  if (partM) part = parseInt(partM[1], 10);

  const numM = /(?:^|[^a-z])s(?:eason)?[\s_]*0*(\d{1,2})(?![0-9])/.exec(t);
  if (numM) season = parseInt(numM[1], 10);
  if (season == null) {
    const ordM = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[\s-]+(?:series|season)\b/.exec(t);
    if (ordM) season = ORDINALS[ordM[1]];
  }

  return { season, part };
}

// A hint must be distinctive enough that finding it inside a release name pins the season.
// Generic labels ("Season 2") never qualify, and neither does any fragment of the show's own
// title: every release carries the full title, so such a "hint" is found in all of them and
// identifies nothing. TMDB really does produce these — "Frieren: Beyond Journey's End" has an
// episode group whose first part is named "Beyond Journey's End", which as a part hint
// matched every Frieren release and rejected the whole season.
function isUsableHint(hint, baseNames) {
  if (!hint || hint.length < 3) return false;
  if (/^season \d+$/.test(hint)) return false;
  const needle = ' ' + hint + ' ';
  for (const base of baseNames) {
    if (base === hint) return false;
    if ((' ' + base + ' ').includes(needle)) return false;
  }
  return true;
}

// Reduce a full alternative title to the season-identifying remainder: strip the show name
// prefix, or take the post-colon subtitle ("Bleach: Thousand-Year Blood War" → "thousand year
// blood war"; "Burīchi: Sennen Kessen-hen" → "sennen kessen hen").
function extractHint(rawTitle, baseNames) {
  const norm = normalizeTitle(rawTitle);
  const candidates = [];
  for (const base of baseNames) {
    if (norm === base) candidates.push('');
    else if (norm.startsWith(base + ' ')) candidates.push(norm.slice(base.length + 1));
  }
  const colonIdx = String(rawTitle).search(/[:：]/);
  if (colonIdx >= 0) candidates.push(normalizeTitle(String(rawTitle).slice(colonIdx + 1)));
  candidates.push(norm);
  return candidates.find((c) => isUsableHint(c, baseNames)) || null;
}

// 1-based position of a (season, episode) within an episode group, or null if absent.
// TMDB carries an explicit 0-based `order` on each entry and does not promise the array is
// sorted by it, so `order` wins and the array index is only the fallback.
function positionInGroup(group, season, episode) {
  const eps = (group && group.episodes) || [];
  const idx = eps.findIndex((e) => e && e.season_number === season && e.episode_number === episode);
  if (idx < 0) return null;
  const order = eps[idx].order;
  return Number.isFinite(order) && order >= 0 ? order + 1 : idx + 1;
}

// TMDB stores two anime numbering schemas: (a) reset-per-season (Bleach: S2E40 → abs =
// 366 + 40); (b) already-absolute (One Piece: S23E1159 → abs = 1159). If the episode number
// exceeds all prior seasons combined it must already be the global counter.
function computeAbsoluteEpisode(detail, season, episode) {
  let priorSum = 0;
  for (const s of detail.seasons || []) {
    if (s && s.season_number > 0 && s.season_number < season) priorSum += s.episode_count || 0;
  }
  return episode > priorSum ? episode : priorSum + episode;
}

/**
 * Pure derivation of the search/matching profile for one episode.
 *
 * @param {object} args
 * @param {object} args.detail        TMDB /tv/{id} payload with alternative_titles appended.
 * @param {object[]} args.groupPayloads  Zero or more fetched /tv/episode_group/{id} payloads.
 * @param {number} args.season        Requested TMDB season number.
 * @param {number} args.episode       Requested TMDB episode number (within the season).
 * @returns {{
 *   isAnime: boolean,
 *   absoluteEpisode: number|null,
 *   altTitles: string[],        // show-level query variants (romaji etc.)
 *   seasonTitles: string[],     // season-scoped query variants ("Bleach thousand year blood war")
 *   seasonHints: string[],      // normalized strings that pin the requested season
 *   foreignHints: string[],     // normalized strings that pin a DIFFERENT season
 *   partHints: Array<{part:number|null, episode:number|null, hint:string}>,
 *   seAliases: Array<{season:number, episode:number, needsHint:boolean}>,
 *   partLengths: number[]|null, // episode count per part, when a season-split group exists
 *   ownShowSeasonCount: number|null,
 * }}
 */
function deriveProfile({ detail, groupPayloads = [], season, episode }) {
  const genres = (detail.genres || []).map((g) => g.id);
  const origins = detail.origin_country || [];
  const isAnime = genres.includes(16) && (origins.includes('JP') || detail.original_language === 'ja');

  const profile = {
    isAnime,
    absoluteEpisode: null,
    altTitles: [],
    seasonTitles: [],
    seasonHints: [],
    foreignHints: [],
    partHints: [],
    seAliases: [],
    partLengths: null,
    ownShowSeasonCount: null,
  };
  if (!isAnime || season == null || episode == null) return profile;

  profile.absoluteEpisode = computeAbsoluteEpisode(detail, season, episode);

  const baseNames = [...new Set(
    [detail.name, detail.original_name].filter((n) => n && !hasCjk(n)).map(normalizeTitle).filter(Boolean)
  )].sort((a, b) => b.length - a.length);

  const altResults = (detail.alternative_titles && detail.alternative_titles.results) || [];

  // ---- Show-level query variants (romaji) --------------------------------------
  // Anime trackers list by romaji title, not the English TMDB title. Seed from JP alt titles
  // that are romaji-typed OR simply non-CJK (many romaji entries carry no type), plus a
  // romanized original_name. Trackers also file shows under the pre-colon short title.
  const stripSubtitle = (s) => String(s).split(/[:：]/)[0].trim();
  const romajiSeeds = altResults
    .filter((a) => a && a.iso_3166_1 === 'JP' && (/romaji|hepburn/i.test(a.type || '') || !hasCjk(a.title)))
    .map((a) => a.title);
  if (detail.original_name && !hasCjk(detail.original_name)) romajiSeeds.push(detail.original_name);
  const altSeen = new Set();
  for (const seed of romajiSeeds) {
    const n = deMacron(seed);
    for (const v of [n, stripSubtitle(n)]) {
      const trimmed = String(v).trim();
      const key = normalizeTitle(trimmed);
      if (trimmed && key && !altSeen.has(key)) {
        altSeen.add(key);
        profile.altTitles.push(trimmed);
      }
    }
  }

  // ---- Season hints from season names and typed alternative titles -------------
  const hintsBySeason = new Map(); // season number -> Set of normalized hints
  const addSeasonHint = (n, hint) => {
    if (n == null || !isUsableHint(hint, baseNames)) return;
    if (!hintsBySeason.has(n)) hintsBySeason.set(n, new Set());
    hintsBySeason.get(n).add(hint);
  };

  for (const s of detail.seasons || []) {
    if (!s || !(s.season_number > 0)) continue;
    addSeasonHint(s.season_number, normalizeTitle(s.name));
  }

  const typedPartTitles = []; // { season, part, hint }
  for (const a of altResults) {
    if (!a || !a.title) continue;
    const { season: ts, part: tp } = parseAltTitleType(a.type);
    if (ts == null) continue;
    const hint = extractHint(a.title, baseNames);
    if (!hint) continue;
    if (tp != null) typedPartTitles.push({ season: ts, part: tp, hint });
    else addSeasonHint(ts, hint);
  }

  const requestedHints = [...(hintsBySeason.get(season) || [])];

  // A part title usually embeds the season title ("thousand year blood war the separation");
  // reduce it to the part-identifying suffix so it can be found standalone in release names.
  const stripKnownPrefix = (hint) => {
    for (const sh of requestedHints) {
      if (hint !== sh && hint.startsWith(sh + ' ')) return hint.slice(sh.length + 1);
    }
    return hint;
  };

  // A season hint that merely extends another season hint ("sennen kessen hen kakahjuu tan")
  // is really a part title with an unknown part number. Its suffix must gate matching like a
  // part hint — a release named with it numbers episodes within that part, not the season.
  //
  // Two things disqualify a candidate, and both were found dropping correct releases:
  //  - it IS the season title (a cour named exactly like its season, which TMDB does). Treating
  //    that as a part would put every release that merely names the season into part context.
  //  - it is too short or generic to identify anything. `stripKnownPrefix` runs AFTER
  //    `extractHint` validated the full string, so numeric cour names ("...Blood War 2") leave
  //    a bare "2" behind, which then matches any release containing that token.
  const partHintUsable = (hint) => isUsableHint(hint, baseNames) && !requestedHints.includes(hint);

  // `resolved` records whether the part's membership is KNOWN (a split group told us exactly
  // which episodes it holds). Without it, `episode: null` only means "we could not work it
  // out" — which must never be read as "this cour does not contain the episode".
  const partHintByName = new Map(); // hint -> { part, episode, hint, resolved }
  const addPartHint = (part, hint) => {
    if (!partHintUsable(hint)) return;
    const existing = partHintByName.get(hint);
    if (existing && existing.part != null) return; // keep the numbered entry
    partHintByName.set(hint, { part: part != null ? part : null, episode: null, hint, resolved: false });
  };
  for (const { season: ts, part: tp, hint } of typedPartTitles) {
    if (ts === season) addPartHint(tp, stripKnownPrefix(hint));
  }
  for (const h of requestedHints) {
    const suffix = stripKnownPrefix(h);
    if (suffix !== h) addPartHint(null, suffix);
  }

  // ---- Episode groups: alternate explicit numberings ---------------------------
  const requestedSeasonMeta = (detail.seasons || []).find((s) => s && s.season_number === season);
  const seasonEpisodeCount = requestedSeasonMeta ? requestedSeasonMeta.episode_count || 0 : 0;
  const tmdbSeasonCount = detail.number_of_seasons
    || Math.max(0, ...(detail.seasons || []).map((s) => (s && s.season_number) || 0));
  const aliasSeen = new Set();
  const addAlias = (aSeason, aEpisode, needsHint) => {
    if (aSeason == null || aEpisode == null) return;
    if (aSeason === season && aEpisode === episode) return; // canonical pair, not an alias
    const key = `${aSeason}:${aEpisode}`;
    if (aliasSeen.has(key)) return;
    aliasSeen.add(key);
    profile.seAliases.push({ season: aSeason, episode: aEpisode, needsHint: !!needsHint });
  };

  for (const payload of groupPayloads) {
    const groups = (payload && payload.groups) || [];
    if (!groups.length) continue;

    // A season-split group partitions exactly the requested season (Hulu/Disney+ list the
    // sequel series as its own show, with the cours as its seasons).
    const allEps = groups.flatMap((g) => g.episodes || []);
    const isSeasonSplit = allEps.length > 0
      && allEps.every((e) => e && e.season_number === season)
      && (seasonEpisodeCount === 0 || allEps.length === seasonEpisodeCount);

    if (isSeasonSplit) {
      const ordered = groups.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      profile.ownShowSeasonCount = ordered.length;
      profile.partLengths = ordered.map((g) => (g.episodes || []).length);
      ordered.forEach((grp, i) => {
        const partIndex = i + 1;
        const localEp = positionInGroup(grp, season, episode);
        const hint = extractHint(grp.name || '', baseNames);
        const cleaned = hint ? stripKnownPrefix(hint) : null;
        if (cleaned && partHintUsable(cleaned)) {
          // resolved: this group listed its episodes, so a null localEp means the requested
          // episode is genuinely NOT in this cour — a usable negative signal.
          partHintByName.set(cleaned, { part: partIndex, episode: localEp, hint: cleaned, resolved: true });
        }
        // A generic group name ("Season 2") yields no hint but still an alias numbering.
        if (localEp != null) addAlias(partIndex, localEp, true);
      });
      continue;
    }

    // Any other alternate ordering (TVDB order, network order): find the requested episode
    // and read off its (group order, position) as an explicit S/E alias. Unambiguous only
    // when the alias season cannot collide with TMDB's own numbering.
    for (const grp of groups) {
      const position = positionInGroup(grp, season, episode);
      if (position == null) continue;
      const aliasSeason = grp.order;
      if (aliasSeason == null || aliasSeason <= 0) continue;
      addAlias(aliasSeason, position, aliasSeason <= tmdbSeasonCount);
    }
  }

  // Fill part-hint local episode numbers from part boundaries when the alt-title gave the
  // part number but the split group named it differently (or vice versa).
  if (profile.partLengths) {
    const starts = [];
    let acc = 1;
    for (const len of profile.partLengths) { starts.push(acc); acc += len; }
    for (const entry of partHintByName.values()) {
      if (entry.part != null && entry.episode == null && entry.part >= 1 && entry.part <= starts.length) {
        const local = episode - starts[entry.part - 1] + 1;
        if (local >= 1 && local <= profile.partLengths[entry.part - 1]) entry.episode = local;
        // Boundaries are known either way, so the answer — hit or miss — is now trustworthy.
        entry.resolved = true;
      }
    }
  }
  if (profile.ownShowSeasonCount == null && typedPartTitles.length) {
    const maxPart = Math.max(...typedPartTitles.filter((p) => p.season === season).map((p) => p.part), 0);
    if (maxPart > 0) profile.ownShowSeasonCount = maxPart;
  }

  // Own-show continuous numbering ("[EMBER] ... S01E14" for a season-2 request): sequel
  // series are routinely released as their own show with a single running season.
  if (season >= 2 && requestedHints.length) addAlias(1, episode, true);

  profile.partHints = [...partHintByName.values()];
  profile.seasonHints = requestedHints;
  for (const [n, set] of hintsBySeason) {
    if (n === season) continue;
    for (const h of set) {
      if (!requestedHints.some((rh) => rh === h || rh.startsWith(h + ' ') || h.startsWith(rh + ' '))) {
        profile.foreignHints.push(h);
      }
    }
  }
  profile.foreignHints = [...new Set(profile.foreignHints)];

  // ---- Season-scoped query variants --------------------------------------------
  // "Show + season hint" is what trackers actually index for sequel-series anime
  // ("Bleach Thousand-Year Blood War", "Bleach Sennen Kessen-hen").
  const showName = detail.name && !hasCjk(detail.name) ? detail.name : (profile.altTitles[0] || '');
  const stSeen = new Set();
  for (const h of requestedHints) {
    // An extension hint ("sennen kessen hen kakahjuu tan") is really a part title — as a
    // query it would only find that one cour, so spend the query slots on the plain forms.
    if (h !== stripKnownPrefix(h)) continue;
    const q = `${showName} ${h}`.trim();
    const key = normalizeTitle(q);
    if (key && !stSeen.has(key)) {
      stSeen.add(key);
      profile.seasonTitles.push(q);
    }
  }
  profile.seasonTitles = profile.seasonTitles.slice(0, 4);

  return profile;
}

// TMDB episode-group types. Only two are useful here, and the distinction matters a lot:
//   1 = original air date  → TVDB order, the numbering Disney+/Hulu rips carry.
//   4 = digital            → a streaming service's own split, which is what release groups
//                            copy when they name a cour ("The Separation").
// Type 5 (story arc) is emphatically NOT usable even though it partitions a season the same
// way: nobody names releases after narrative arcs, and picking one up made every episode of
// Frieren unmatchable. Types 2/3/6/7 (absolute, DVD, production, tv) are equally unrelated to
// how releases are named.
const GROUP_TYPE_AIR_ORDER = 1;
const GROUP_TYPE_DIGITAL = 4;

// Pick which episode groups are worth fetching, from the /tv/{id}/episode_groups listing:
// one alternate air-order group, and one streaming split of exactly the requested season.
function selectGroupIds(groupList, seasonEpisodeCount) {
  const results = (groupList && groupList.results) || [];
  const ids = [];
  const airOrder = results.find((g) => g && g.type === GROUP_TYPE_AIR_ORDER && /tvdb/i.test(g.name || ''))
    || results.find((g) => g && g.type === GROUP_TYPE_AIR_ORDER);
  if (airOrder) ids.push(airOrder.id);
  if (seasonEpisodeCount > 0) {
    const split = results.find((g) => g && g.type === GROUP_TYPE_DIGITAL
      && g.episode_count === seasonEpisodeCount
      && g.group_count > 0 && g.group_count <= 12 && g.id !== (airOrder && airOrder.id));
    if (split) ids.push(split.id);
  }
  return ids;
}

/**
 * Fetching orchestrator. The tmdb function is injected (same signature as server.js's helper:
 * (endpoint, params) => parsed payload) so this module never owns an HTTP client or an API key.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class EpisodeNumberingService {
  // retries default to 2, not more: the caller is a user waiting on a search, and TMDB's own
  // client allows 15s per attempt (core/tmdb-client.js), so each extra attempt is worth up to
  // 15s of dead air before the search even starts. Two covers a dropped connection; a link
  // that fails twice is not going to answer the third time either.
  constructor({ tmdb, retries = 2, retryDelayMs = 400, negativeTtlMs = 10000 } = {}) {
    this.tmdb = typeof tmdb === 'function' ? tmdb : () => { throw new Error('tmdb fetcher required'); };
    this.retries = Math.max(1, Number(retries) || 1);
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    // A failed group fetch is not cached (so it recovers) but IS remembered for a few seconds,
    // or a show whose group endpoint is down re-pays the whole retry budget on every search.
    // Short on purpose: the window only has to outlast a burst of searches, and anything
    // longer would leave the show degraded while the network is already healthy again.
    this.negativeTtlMs = Math.max(0, Number(negativeTtlMs) || 0);
    // Show metadata and group payloads are immutable per show for practical purposes; cache
    // them so browsing a season costs the extra lookups once, not once per episode.
    // ONLY SUCCESSFUL fetches are cached — see _getShow.
    this.cache = new Map(); // tmdbId -> { at, detail, groupList, groupPayloadById: Map }
    this.cacheTtlMs = 6 * 60 * 60 * 1000;
    this.cacheMax = 20;
  }

  // TMDB over a home connection drops requests intermittently (measured: three consecutive
  // ECONNRESETs on an otherwise working link). A profile is worth three attempts — losing it
  // costs the search every alias and title variant, which for a sequel-series anime is the
  // difference between a full result list and nothing.
  async _fetch(endpoint, params = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        return await this.tmdb(endpoint, params);
      } catch (err) {
        lastError = err;
        if (attempt < this.retries && this.retryDelayMs) await sleep(this.retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  async _getShow(tmdbId) {
    const key = String(tmdbId);
    let entry = this.cache.get(key);
    if (entry && Date.now() - entry.at >= this.cacheTtlMs) {
      this.cache.delete(key);
      entry = null;
    }

    if (!entry) {
      const detail = await this._fetch(`/tv/${tmdbId}`, { append_to_response: 'alternative_titles' });
      entry = { at: Date.now(), detail, groupList: null, groupFailedAt: 0, groupPayloadById: new Map() };
      this.cache.set(key, entry);
      if (this.cache.size > this.cacheMax) {
        // Map preserves insertion order and entries are only ever inserted on a miss, so the
        // first key is the least recently fetched.
        this.cache.delete(this.cache.keys().next().value);
      }
    }

    // Episode groups are an enhancer, but a failed fetch must NOT be remembered: caching the
    // null would strand this show without its aliases for the whole 6h TTL after a single
    // network blip. Absent group data is simply retried on the next search.
    const genres = (entry.detail.genres || []).map((g) => g.id);
    const origins = entry.detail.origin_country || [];
    const isAnime = genres.includes(16) && (origins.includes('JP') || entry.detail.original_language === 'ja');
    if (isAnime && !entry.groupList && Date.now() - entry.groupFailedAt >= this.negativeTtlMs) {
      entry.groupList = await this._fetch(`/tv/${tmdbId}/episode_groups`, {}).catch(() => null);
      if (!entry.groupList) entry.groupFailedAt = Date.now();
    }

    return entry;
  }

  /** Build the full profile for one episode. Throws on TMDB detail failure — callers treat
   *  the profile as an enhancer and fall back to a plain title search. */
  async buildProfile(tmdbId, season, episode) {
    const seasonNum = Number(season);
    const episodeNum = Number(episode);
    const show = await this._getShow(tmdbId);

    // Which groups matter depends on the requested season (the split-group selector needs
    // its episode count), so selection happens per call while payloads cache per group id.
    const seasonMeta = (show.detail.seasons || []).find((s) => s && s.season_number === seasonNum);
    const seasonEpisodeCount = seasonMeta ? seasonMeta.episode_count || 0 : 0;
    const ids = show.groupList ? selectGroupIds(show.groupList, seasonEpisodeCount) : [];
    const groupPayloads = (await Promise.all(ids.map(async (id) => {
      const cached = show.groupPayloadById.get(id);
      if (cached && cached.payload) return cached.payload;
      // Same rule as the group list: only a success is cached for the full TTL, a failure just
      // long enough that a dead endpoint is not re-attempted on every keystroke.
      if (cached && Date.now() - cached.failedAt < this.negativeTtlMs) return null;
      const payload = await this._fetch(`/tv/episode_group/${id}`, {}).catch(() => null);
      show.groupPayloadById.set(id, payload ? { payload } : { failedAt: Date.now() });
      return payload;
    }))).filter(Boolean);

    return deriveProfile({ detail: show.detail, groupPayloads, season: seasonNum, episode: episodeNum });
  }
}

function createEpisodeNumberingService(deps) {
  return new EpisodeNumberingService(deps);
}

module.exports = {
  EpisodeNumberingService,
  createEpisodeNumberingService,
  // The pure half of the module: everything the service does once the payloads are in hand.
  // Public because it is the piece worth driving directly — from tests, and from any future
  // caller that already has the TMDB payloads.
  deriveProfile,
  selectGroupIds,
};

// exposed for unit tests
module.exports._internals = {
  parseAltTitleType, extractHint, isUsableHint, normalizeTitle,
  computeAbsoluteEpisode, positionInGroup,
};
