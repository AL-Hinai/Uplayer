'use strict';

// Turning the id Uplayer already has (TMDB) into the id an anime indexer actually indexes
// by (AniDB). It exists because AnimeTosho can be queried by AniDB show + episode id, and
// an id match needs no release-name parsing at all — where `torrent-name-patterns.js` has
// to recognise "Bleach S17E14", "Sennen Kessen-hen S01E14", "- 014" and "[EP: 380]" as the
// same episode, an AniDB episode id simply IS the episode.
//
// The hard part is not the lookup, it is that the TMDB -> AniDB mapping is MANY-TO-ONE and
// ani.zip's reverse index returns only one of them. TMDB models Bleach as two seasons;
// AniDB splits the second into four series (13 + 13 + 14 + 10 = TMDB's 50), and all four
// report themoviedb_id 30984. A naive `?themoviedb_id=` lookup therefore lands on the
// ORIGINAL Bleach (366 episodes), the requested absolute number falls outside it, and the
// indexer query returns nothing. Measured: 0 rows for Bleach S2E14 (bench/ANIME-LOOKUP.md).
//
// So this module has two strategies:
//
//   'direct'      — one ani.zip lookup, episode addressed by absolute number. Correct for
//                   single-entry shows (Frieren: 30 exact rows where name matching found
//                   11, and recovered only 30% of them).
//   'cour-bridge' — for cour-split seasons. TMDB itself publishes the split, and
//                   episode-numbering.js already parses it into `partLengths` plus a
//                   resolved `partHint`, so NO new TMDB request is needed: Bleach S2E14
//                   arrives here as "part 2, episode 1 of [13,13,14,10]". Listing the
//                   franchise's AniList entries in release order and matching that
//                   ordered episode-count signature picks the right AniDB series. Measured:
//                   0 rows becomes 33, best-seeded 1080p included.
//
// Deliberately excluded: titles, images, episode lists and anything to do with ranking.
// This module answers one question — which AniDB ids name this episode — and returns null
// rather than a guess. A null is the NORMAL answer (every non-anime title, every ambiguous
// split) and callers must treat it as "no id lane", never as "no such episode".
//
// Two cases are refused on purpose rather than guessed at, because a wrong id returns
// confidently wrong torrents, which is worse than returning none:
//   - An AIRING cour. AniList reports `episodes: null` until a season finishes, so an
//     in-flight cour has no count to match and the signature cannot be trusted.
//   - An AMBIGUOUS signature. [13,13,14,10] matches exactly one window; [12,12] can match
//     several. More than one candidate window means no answer.
//
// IO: HTTP through the injected fetchers only. No timers. Caches per instance.

const ANIZIP_BASE = 'https://api.ani.zip';
const ANILIST_URL = 'https://graphql.anilist.co';

// Release order, with counts, for every entry whose title matches. START_DATE keeps the
// cours in broadcast order, which is the order TMDB's parts are in.
const SIBLINGS_QUERY = `query($search:String){
  Page(perPage:25){
    media(search:$search,type:ANIME,sort:START_DATE){
      id episodes format startDate{year month day} title{romaji english}
    }
  }
}`;

class AnimeIdResolver {
  /**
   * @param {object} deps
   * @param {(url: string) => Promise<object>} deps.fetchJson     GET returning parsed JSON.
   * @param {(query: string, variables: object) => Promise<object>} [deps.anilistQuery]
   *        POST to AniList. Omit to disable the cour bridge (direct lookups still work).
   */
  constructor({ fetchJson, anilistQuery } = {}) {
    if (typeof fetchJson !== 'function') throw new Error('anime-ids: fetchJson is required');
    this.fetchJson = fetchJson;
    this.anilistQuery = typeof anilistQuery === 'function' ? anilistQuery : null;
    this._mapCache = new Map();   // cache key -> ani.zip payload (trimmed)
  }

  // ani.zip payloads run to 1.8 MB for One Piece (every episode, every language title,
  // images). Only two things are ever read, so only those are kept.
  async _mappings(key, url) {
    if (this._mapCache.has(key)) return this._mapCache.get(key);
    let trimmed = null;
    try {
      const data = await this.fetchJson(url);
      if (data && data.mappings) {
        const episodes = {};
        for (const [k, v] of Object.entries(data.episodes || {})) {
          if (!v) continue;
          episodes[k] = { anidbEid: v.anidbEid || null, absoluteEpisodeNumber: v.absoluteEpisodeNumber ?? null };
        }
        trimmed = { anidbId: data.mappings.anidb_id || null, type: data.mappings.type || null, episodes };
      }
    } catch (e) {
      trimmed = null;
    }
    this._mapCache.set(key, trimmed);
    return trimmed;
  }

  /**
   * @param {object} args
   * @param {number|string} args.tmdbId
   * @param {number|null} [args.absoluteEpisode]  From the numbering profile.
   * @param {number[]|null} [args.partLengths]    From the numbering profile.
   * @param {Array<{part:number|null, episode:number|null, resolved:boolean}>} [args.partHints]
   * @param {string[]} [args.seasonTitles]        From the numbering profile; drives the
   *                                              sibling lookup. Without it, no bridge.
   * @returns {Promise<{anidbId:number, anidbEid:number, strategy:string}|null>}
   */
  async resolve({ tmdbId, absoluteEpisode = null, partLengths = null, partHints = null, seasonTitles = [] } = {}) {
    if (!tmdbId) return null;

    const bridged = await this._viaCourBridge({ partLengths, partHints, seasonTitles });
    if (bridged) return bridged;

    return this._direct({ tmdbId, absoluteEpisode });
  }

  async _direct({ tmdbId, absoluteEpisode }) {
    if (absoluteEpisode == null) return null;
    const m = await this._mappings(`tmdb:${tmdbId}`, `${ANIZIP_BASE}/mappings?themoviedb_id=${encodeURIComponent(tmdbId)}`);
    if (!m || !m.anidbId) return null;
    const entry = m.episodes[String(absoluteEpisode)];
    if (!entry || !entry.anidbEid) return null;
    return { anidbId: m.anidbId, anidbEid: entry.anidbEid, strategy: 'direct' };
  }

  async _viaCourBridge({ partLengths, partHints, seasonTitles }) {
    if (!this.anilistQuery) return null;
    const lengths = Array.isArray(partLengths) ? partLengths.filter((n) => Number.isFinite(n) && n > 0) : [];
    if (lengths.length < 2) return null; // not a split season; the direct path is correct

    const hint = (partHints || []).find((h) => h && h.resolved && h.part != null && h.episode != null);
    if (!hint || hint.part < 1 || hint.part > lengths.length) return null;

    const picked = await this._pickSibling(lengths, hint.part, seasonTitles);
    if (!picked) return null;

    const m = await this._mappings(`anilist:${picked.id}`, `${ANIZIP_BASE}/mappings?anilist_id=${picked.id}`);
    if (!m || !m.anidbId) return null;
    const entry = m.episodes[String(hint.episode)];
    if (!entry || !entry.anidbEid) return null;
    return { anidbId: m.anidbId, anidbEid: entry.anidbEid, strategy: 'cour-bridge' };
  }

  // Find the run of sibling entries whose episode counts equal `lengths`, in order, and
  // return the one at `part`. Refuses on no match, on more than one match, and on any
  // candidate still airing.
  async _pickSibling(lengths, part, seasonTitles) {
    for (const title of (seasonTitles || []).slice(0, 2)) {
      if (!title) continue;
      let media = [];
      try {
        const r = await this.anilistQuery(SIBLINGS_QUERY, { search: title });
        media = (((r || {}).data || {}).Page || {}).media || [];
      } catch (e) {
        continue;
      }
      // An airing entry reports `episodes: null`. Its presence shifts every window, so the
      // signature is untrustworthy for this franchise — refuse rather than drop it and
      // silently match the wrong run.
      if (media.some((m) => m && m.episodes == null)) continue;

      const windows = [];
      for (let start = 0; start + lengths.length <= media.length; start++) {
        const w = media.slice(start, start + lengths.length);
        if (w.every((m, i) => m.episodes === lengths[i])) windows.push(w);
      }
      if (windows.length === 1) return windows[0][part - 1] || null;
      // 0 windows: wrong franchise or TMDB and AniList disagree on the split.
      // 2+ windows: a repeated signature like [12,12]; a guess here returns confidently
      // wrong torrents, so there is no answer.
    }
    return null;
  }
}

function createAnimeIdResolver(deps) {
  return new AnimeIdResolver(deps);
}

module.exports = {
  AnimeIdResolver,
  createAnimeIdResolver,
  // exposed for unit tests
  _internals: { SIBLINGS_QUERY, ANIZIP_BASE, ANILIST_URL },
};
