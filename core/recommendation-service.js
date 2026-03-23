'use strict';

const {
  EVENT_WEIGHTS,
  normalizeRecommendationItem,
  buildProfile,
  hasMeaningfulSignals,
  isFullyPersonalized,
  scoreCandidate,
  scoreCandidateBasic,
  pickReason,
  classifyRecommendation,
  buildRecommendationSections,
  flattenSections,
} = require('./recommendation-engine');

const MAX_INTERACTIONS = 1000;
const MAX_CANDIDATES = 36;

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stripUndefinedFields(obj) {
  return Object.fromEntries(
    Object.entries(obj || {}).filter(([, value]) => value !== undefined)
  );
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function sortByNewest(items = [], field = 'createdAt') {
  return items.slice().sort((a, b) => new Date(b[field] || 0) - new Date(a[field] || 0));
}

function normalizeType(type, fallback = 'movie') {
  return type === 'tv' ? 'tv' : fallback;
}

function getPrimaryReleaseYear(item = {}) {
  const value = item.release_date || item.first_air_date || '';
  const year = parseInt(String(value).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function toIsoDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function eventSourceKind(eventType) {
  if (eventType === 'watchlist_add' || eventType === 'watchlist_remove') return 'watchlist';
  if (eventType === 'detail_click') return 'click';
  if (eventType === 'stream_start') return 'history';
  if (eventType === 'watch_complete' || eventType === 'tv_progress') return 'history';
  return 'interaction';
}

class RecommendationService {
  constructor({ tmdbClient, historyStore, recommendationStore }) {
    this.tmdbClient = tmdbClient;
    this.historyStore = historyStore;
    this.recommendationStore = recommendationStore;
  }

  readState() {
    return this.recommendationStore.read();
  }

  readHistory() {
    return this.historyStore.read();
  }

  summarizeProfile(profile) {
    return {
      updatedAt: profile.updatedAt || null,
      meaningful: hasMeaningfulSignals(profile),
      fullyPersonalized: isFullyPersonalized(profile),
      totalSignalWeight: asNumber(profile.totalSignalWeight, 0),
      positiveSignalWeight: asNumber(profile.positiveSignalWeight, 0),
      qualityFloor: asNumber(profile.qualityFloor, 0),
      topGenres: (profile.genres || []).slice(0, 4),
      topMediaTypes: (profile.mediaTypes || []).slice(0, 2),
      topLanguages: (profile.languages || []).slice(0, 2),
      topFranchises: (profile.franchises || []).slice(0, 3),
    };
  }

  buildAndPersistProfile() {
    const history = this.readHistory();
    return this.recommendationStore.update((state) => {
      state.profile = buildProfile({
        interactions: state.interactions,
        watchlist: state.watchlist,
        history,
      });
      return {
        profile: state.profile,
        state,
      };
    });
  }

  async fetchDetail(type, tmdbId) {
    return this.tmdbClient.get(`/${type}/${tmdbId}`, {
      append_to_response: 'credits',
    });
  }

  metadataNeedsDetail(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return true;
    if (!(metadata.tmdbId || metadata.id)) return true;
    if (!metadata.title && !metadata.name && !metadata.original_title && !metadata.original_name) return true;
    if (!Array.isArray(metadata.genres) && !Array.isArray(metadata.genre_ids)) return true;
    if (!metadata.credits) return true;
    return false;
  }

  normalizeStoredItem(type, source = {}) {
    const normalized = normalizeRecommendationItem(type, source);
    return stripUndefinedFields({
      ...source,
      tmdbId: normalized.tmdbId,
      id: normalized.tmdbId,
      type: normalized.type,
      media_type: normalized.type,
      title: normalized.title,
      name: source.name || normalized.title,
      poster_path: source.poster_path || normalized.poster_path || null,
      backdrop_path: source.backdrop_path || normalized.backdrop_path || null,
      release_date: source.release_date,
      first_air_date: source.first_air_date,
      original_language: source.original_language || normalized.originalLanguage || null,
      runtime: source.runtime || normalized.runtime || undefined,
      episode_run_time: source.episode_run_time,
      vote_average: source.vote_average || normalized.voteAverage || undefined,
      popularity: source.popularity || normalized.popularity || undefined,
      belongs_to_collection: source.belongs_to_collection,
      genres: Array.isArray(source.genres) && source.genres.length > 0
        ? source.genres
        : normalized.genres.map((genre) => ({
          id: asNumber(genre.id, 0),
          name: genre.name || null,
        })),
      genre_ids: Array.isArray(source.genre_ids) && source.genre_ids.length > 0
        ? source.genre_ids
        : normalized.genreIds,
      credits: source.credits || undefined,
      created_by: source.created_by || undefined,
      addedAt: source.addedAt,
      watchedAt: source.watchedAt,
      lastSeason: source.lastSeason,
      lastEpisode: source.lastEpisode,
      totalSeasons: source.totalSeasons,
      totalEpisodes: source.totalEpisodes,
    });
  }

  async resolveItem(type, tmdbId, metadata = {}) {
    const normalizedType = normalizeType(type, metadata.first_air_date ? 'tv' : 'movie');
    const numericId = asNumber(tmdbId || metadata.tmdbId || metadata.id, 0);
    if (!numericId) {
      throw new Error('tmdbId is required');
    }

    const base = {
      ...metadata,
      tmdbId: numericId,
      id: numericId,
      media_type: metadata.media_type || normalizedType,
      type: metadata.type || normalizedType,
    };

    if (!this.metadataNeedsDetail(base)) {
      return this.normalizeStoredItem(normalizedType, base);
    }

    const detail = await this.fetchDetail(normalizedType, numericId);
    return this.normalizeStoredItem(normalizedType, {
      ...detail,
      ...base,
      tmdbId: numericId,
      id: numericId,
    });
  }

  async recordEvent({ eventType, type, tmdbId, metadata = {}, createdAt } = {}) {
    if (!EVENT_WEIGHTS[eventType]) {
      throw new Error(`Unsupported recommendation event: ${eventType}`);
    }

    const item = await this.resolveItem(type, tmdbId, metadata);
    const normalizedType = normalizeType(type, item.type || item.media_type || 'movie');
    const interaction = {
      eventType,
      type: normalizedType,
      tmdbId: item.tmdbId,
      createdAt: toIsoDate(createdAt),
      sourceKind: eventSourceKind(eventType),
      item,
      metadata: item,
    };

    const history = this.readHistory();
    return this.recommendationStore.update((state) => {
      state.interactions.push(interaction);
      if (state.interactions.length > MAX_INTERACTIONS) {
        state.interactions = state.interactions.slice(-MAX_INTERACTIONS);
      }
      state.profile = buildProfile({
        interactions: state.interactions,
        watchlist: state.watchlist,
        history,
      });
      return {
        interaction,
        profile: state.profile,
      };
    });
  }

  getWatchlist() {
    const state = this.readState();
    const items = Object.values(state.watchlist.movie || {})
      .concat(Object.values(state.watchlist.tv || {}))
      .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
    return {
      watchlist: state.watchlist,
      items,
      total: items.length,
    };
  }

  async addWatchlist({ type, tmdbId, item, metadata = {} } = {}) {
    const savedItem = await this.resolveItem(type, tmdbId, item || metadata);
    const normalizedType = normalizeType(type, savedItem.type || 'movie');
    const addedAt = new Date().toISOString();
    const history = this.readHistory();

    return this.recommendationStore.update((state) => {
      state.watchlist[normalizedType][String(savedItem.tmdbId)] = {
        ...savedItem,
        addedAt,
      };
      state.interactions.push({
        eventType: 'watchlist_add',
        type: normalizedType,
        tmdbId: savedItem.tmdbId,
        createdAt: addedAt,
        sourceKind: 'watchlist',
        item: {
          ...savedItem,
          addedAt,
        },
        metadata: {
          ...savedItem,
          addedAt,
        },
      });
      if (state.interactions.length > MAX_INTERACTIONS) {
        state.interactions = state.interactions.slice(-MAX_INTERACTIONS);
      }
      state.profile = buildProfile({
        interactions: state.interactions,
        watchlist: state.watchlist,
        history,
      });
      return {
        item: state.watchlist[normalizedType][String(savedItem.tmdbId)],
        profile: state.profile,
      };
    });
  }

  removeWatchlist(type, tmdbId) {
    const normalizedType = normalizeType(type);
    const key = String(tmdbId);
    const history = this.readHistory();
    return this.recommendationStore.update((state) => {
      const existing = state.watchlist[normalizedType][key];
      if (!existing) {
        return {
          removed: false,
          profile: state.profile,
        };
      }

      delete state.watchlist[normalizedType][key];
      state.interactions.push({
        eventType: 'watchlist_remove',
        type: normalizedType,
        tmdbId: asNumber(tmdbId, 0),
        createdAt: new Date().toISOString(),
        sourceKind: 'watchlist',
        item: existing,
        metadata: existing,
      });
      if (state.interactions.length > MAX_INTERACTIONS) {
        state.interactions = state.interactions.slice(-MAX_INTERACTIONS);
      }
      state.profile = buildProfile({
        interactions: state.interactions,
        watchlist: state.watchlist,
        history,
      });
      return {
        removed: true,
        item: existing,
        profile: state.profile,
      };
    });
  }

  collectSeedMap({ state, history }) {
    const seeds = new Map();

    const addSeed = (sourceKind, type, item, score, createdAt) => {
      if (!item) return;
      const tmdbId = asNumber(item.tmdbId || item.id, 0);
      if (!tmdbId || !type || !score) return;
      const key = `${type}:${tmdbId}`;
      if (!seeds.has(key)) {
        seeds.set(key, {
          key,
          type,
          tmdbId,
          title: item.title || item.name || item.original_title || item.original_name || 'Unknown',
          score: 0,
          sourceKinds: {},
          lastSeenAt: createdAt || null,
          metadata: item,
        });
      }
      const seed = seeds.get(key);
      seed.score += score;
      seed.sourceKinds[sourceKind] = (seed.sourceKinds[sourceKind] || 0) + score;
      if (!seed.lastSeenAt || new Date(createdAt || 0) > new Date(seed.lastSeenAt || 0)) {
        seed.lastSeenAt = createdAt || seed.lastSeenAt;
      }
    };

    for (const movie of Object.values(history.movies || {})) {
      addSeed('history', 'movie', movie, 10, movie.watchedAt);
    }
    for (const show of Object.values(history.tvShows || {})) {
      const score = show.lastEpisode || show.lastSeason ? 12 : 10;
      addSeed('history', 'tv', show, score, show.watchedAt);
    }

    for (const item of Object.values((state.watchlist && state.watchlist.movie) || {})) {
      addSeed('watchlist', 'movie', item, 6, item.addedAt);
    }
    for (const item of Object.values((state.watchlist && state.watchlist.tv) || {})) {
      addSeed('watchlist', 'tv', item, 6, item.addedAt);
    }

    for (const interaction of sortByNewest(state.interactions)) {
      const eventWeight = EVENT_WEIGHTS[interaction.eventType];
      if (!eventWeight || interaction.eventType === 'watchlist_remove') continue;
      addSeed(
        eventSourceKind(interaction.eventType),
        normalizeType(interaction.type, interaction.item && interaction.item.type),
        interaction.item || interaction.metadata,
        eventWeight,
        interaction.createdAt
      );
    }

    return Array.from(seeds.values())
      .map((seed) => ({
        ...seed,
        primarySourceKind: Object.entries(seed.sourceKinds).sort((a, b) => b[1] - a[1])[0]?.[0] || 'history',
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
      });
  }

  buildDiscoverParams(type, filters, profile, mode = 'profile') {
    const topGenreIds = (profile.genres || []).slice(0, 3).map((genre) => genre.key);
    const topLanguage = (profile.languages || [])[0]?.key || null;
    const topYearBucket = (profile.years || [])[0]?.key || null;
    let yearFloor = null;
    let yearCeiling = null;

    if (topYearBucket && /^\d{4}s$/.test(topYearBucket)) {
      const start = parseInt(topYearBucket.slice(0, 4), 10);
      if (Number.isFinite(start)) {
        yearFloor = start - 2;
        yearCeiling = start + 7;
      }
    }

    const params = {
      page: 1,
      sort_by: mode === 'explore' ? 'popularity.desc' : 'vote_average.desc',
      'vote_average.gte': Math.max(asNumber(filters.minRating, 0), mode === 'explore' ? 6.0 : clamp(asNumber(profile.qualityFloor, 6.2) - 0.3, 5.8, 8.2)),
      'vote_count.gte': mode === 'explore' ? 120 : 60,
    };

    if (topGenreIds.length > 0 && mode !== 'explore') {
      params.with_genres = topGenreIds.join(',');
    }
    if (topLanguage && mode !== 'explore') {
      params.with_original_language = topLanguage;
    }

    const fromYear = asNumber(filters.yearFrom, 0) || yearFloor;
    const toYear = asNumber(filters.yearTo, 0) || yearCeiling;
    if (fromYear) {
      params[type === 'tv' ? 'first_air_date.gte' : 'primary_release_date.gte'] = `${fromYear}-01-01`;
    }
    if (toYear) {
      params[type === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = `${toYear}-12-31`;
    }
    return params;
  }

  applyFilters(items, filters = {}) {
    return items.filter((item) => {
      if (filters.type && item.type !== filters.type) return false;
      if (filters.genre && !item.genreIds.includes(asNumber(filters.genre, 0))) return false;
      if (filters.minRating && asNumber(item.voteAverage, 0) < asNumber(filters.minRating, 0)) return false;
      if (filters.yearFrom && (!item.year || item.year < asNumber(filters.yearFrom, 0))) return false;
      if (filters.yearTo && (!item.year || item.year > asNumber(filters.yearTo, 9999))) return false;
      return true;
    });
  }

  async buildCandidates({ filters, profile, state, history }) {
    const watchedKeys = new Set([
      ...Object.keys(history.movies || {}).map((id) => `movie:${id}`),
      ...Object.keys(history.tvShows || {}).map((id) => `tv:${id}`),
    ]);

    const seeds = this.collectSeedMap({ state, history });
    const topSeedScore = seeds.length > 0 ? seeds[0].score : 1;
    const selectedSeeds = uniqueBy(
      []
        .concat(seeds.filter((seed) => seed.primarySourceKind === 'history').slice(0, 4))
        .concat(seeds.filter((seed) => seed.primarySourceKind === 'watchlist').slice(0, 3))
        .concat(seeds.filter((seed) => seed.primarySourceKind === 'click').slice(0, 2))
        .concat(seeds.slice(0, 3)),
      (seed) => seed.key
    ).slice(0, 8);

    const candidateMap = new Map();

    const registerCandidates = (items, mediaType, signal) => {
      for (const raw of items || []) {
        const normalized = normalizeRecommendationItem(mediaType || raw.media_type, raw);
        if (!normalized.tmdbId || watchedKeys.has(`${normalized.type}:${normalized.tmdbId}`)) continue;
        const key = `${normalized.type}:${normalized.tmdbId}`;
        if (!candidateMap.has(key)) {
          candidateMap.set(key, {
            ...raw,
            ...normalized,
            id: normalized.tmdbId,
            sourceSignals: [],
          });
        }

        const existing = candidateMap.get(key);
        if ((!existing.poster_path && raw.poster_path) || (!existing.backdrop_path && raw.backdrop_path)) {
          existing.poster_path = existing.poster_path || raw.poster_path || null;
          existing.backdrop_path = existing.backdrop_path || raw.backdrop_path || null;
        }
        existing.voteAverage = asNumber(existing.voteAverage || raw.vote_average, 0);
        existing.popularity = asNumber(existing.popularity || raw.popularity, 0);
        existing.genreIds = existing.genreIds && existing.genreIds.length > 0
          ? existing.genreIds
          : normalizeRecommendationItem(mediaType || raw.media_type, raw).genreIds;
        existing.sourceSignals.push(signal);
      }
    };

    const seedCalls = [];
    for (const seed of selectedSeeds) {
      seedCalls.push(
        this.tmdbClient.get(`/${seed.type}/${seed.tmdbId}/recommendations`, { page: 1 }).then((data) => {
          registerCandidates(data.results || [], seed.type, {
            kind: 'recommendations',
            sourceKind: seed.primarySourceKind,
            seedId: seed.tmdbId,
            seedType: seed.type,
            seedTitle: seed.title,
            seedScore: seed.score,
            topSeedScore,
          });
        }).catch(() => null),
        this.tmdbClient.get(`/${seed.type}/${seed.tmdbId}/similar`, { page: 1 }).then((data) => {
          registerCandidates(data.results || [], seed.type, {
            kind: 'similar',
            sourceKind: seed.primarySourceKind,
            seedId: seed.tmdbId,
            seedType: seed.type,
            seedTitle: seed.title,
            seedScore: seed.score,
            topSeedScore,
          });
        }).catch(() => null)
      );
    }

    const discoverTypes = filters.type ? [filters.type] : ['movie', 'tv'];
    for (const type of discoverTypes) {
      seedCalls.push(
        this.tmdbClient.get(`/discover/${type}`, this.buildDiscoverParams(type, filters, profile, 'profile')).then((data) => {
          registerCandidates(data.results || [], type, {
            kind: 'discover_profile',
            sourceKind: 'profile',
            seedId: null,
            seedType: type,
            seedTitle: null,
            seedScore: Math.max(asNumber(profile.positiveSignalWeight, 0), 1),
            topSeedScore,
          });
        }).catch(() => null),
        this.tmdbClient.get(`/discover/${type}`, this.buildDiscoverParams(type, filters, profile, 'explore')).then((data) => {
          registerCandidates(data.results || [], type, {
            kind: 'discover_explore',
            sourceKind: 'explore',
            seedId: null,
            seedType: type,
            seedTitle: null,
            seedScore: 1,
            topSeedScore,
          });
        }).catch(() => null)
      );
    }

    const trendingType = filters.type || 'all';
    seedCalls.push(
      this.tmdbClient.get(`/trending/${trendingType}/week`, { page: 1 }).then((data) => {
        registerCandidates(data.results || [], filters.type || null, {
          kind: 'trending',
          sourceKind: 'explore',
          seedId: null,
          seedType: filters.type || null,
          seedTitle: null,
          seedScore: 1,
          topSeedScore,
        });
      }).catch(() => null)
    );

    await Promise.all(seedCalls);

    let candidates = Array.from(candidateMap.values());
    candidates = this.applyFilters(candidates, filters);

    const coarseRanked = candidates
      .map((candidate) => {
        const breakdown = scoreCandidateBasic(profile, candidate);
        return {
          ...candidate,
          score: breakdown.total,
          scoreBreakdown: breakdown,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);

    const hydrated = await Promise.all(
      coarseRanked.map(async (candidate) => {
        try {
          const detail = await this.fetchDetail(candidate.type, candidate.tmdbId);
          return {
            ...candidate,
            ...this.normalizeStoredItem(candidate.type, {
              ...detail,
              media_type: candidate.type,
              type: candidate.type,
            }),
            sourceSignals: candidate.sourceSignals,
          };
        } catch (error) {
          return candidate;
        }
      })
    );

    return hydrated;
  }

  async getRecommendations(filters = {}) {
    const state = this.readState();
    const history = this.readHistory();
    const profile = buildProfile({
      interactions: state.interactions,
      watchlist: state.watchlist,
      history,
    });
    this.recommendationStore.write({
      ...state,
      profile,
    });

    const candidates = await this.buildCandidates({ filters, profile, state, history });
    const personalized = candidates
      .map((candidate) => {
        const breakdown = scoreCandidate(profile, candidate);
        const reason = pickReason(candidate, breakdown);
        const sectionId = classifyRecommendation(candidate, breakdown);
        return {
          ...candidate,
          score: Number((breakdown.total).toFixed(2)),
          sectionId,
          reasonType: reason.reasonType,
          reasonLabel: reason.reasonLabel,
          seedContext: reason.seedContext,
          scoreBreakdown: breakdown,
          isSaved: !!((state.watchlist[candidate.type] || {})[String(candidate.tmdbId)]),
        };
      })
      .sort((a, b) => b.score - a.score);

    let sections;
    let source = 'personalized';
    if (personalized.length === 0) {
      sections = [];
      source = 'empty';
    } else if (!hasMeaningfulSignals(profile)) {
      sections = [{
        id: 'top_picks',
        title: 'Start With These',
        subtitle: 'Trending picks while your taste profile is still warming up',
        items: personalized.slice(0, 18).map((item) => ({
          ...item,
          sectionId: 'top_picks',
          reasonType: 'cold_start',
          reasonLabel: 'Trending while we learn your taste',
          seedContext: null,
        })),
      }];
      source = 'trending';
    } else {
      sections = buildRecommendationSections(personalized);
      source = isFullyPersonalized(profile) ? 'personalized' : 'hybrid';
    }

    const results = flattenSections(sections);
    const watchlistItems = this.getWatchlist();

    return {
      source,
      sections,
      results,
      total_pages: 1,
      personalization: this.summarizeProfile(profile),
      watchlist: {
        total: watchlistItems.total,
      },
    };
  }
}

module.exports = {
  RecommendationService,
};
