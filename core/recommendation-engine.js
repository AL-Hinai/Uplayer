'use strict';

const EVENT_WEIGHTS = {
  detail_click: 2,
  stream_start: 5,
  watch_complete: 10,
  tv_progress: 7,
  watchlist_add: 6,
  watchlist_remove: -4,
};

const HALF_LIFE_DAYS = 45;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SECTION_ORDER = [
  'top_picks',
  'because_watched',
  'from_watchlist',
  'usual_taste',
  'explore_new',
];
const SECTION_LIMITS = {
  top_picks: 10,
  because_watched: 10,
  from_watchlist: 8,
  usual_taste: 10,
  explore_new: 6,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function increment(map, key, amount, label) {
  if (!key || !Number.isFinite(amount) || amount === 0) return;
  if (!map[key]) {
    map[key] = { value: 0 };
  }
  map[key].value += amount;
  if (label && !map[key].label) {
    map[key].label = label;
  }
}

function toSortedArray(map) {
  return Object.entries(map || {})
    .map(([key, value]) => ({ key, value: asNumber(value.value, value), label: value.label || null }))
    .filter((entry) => Number.isFinite(entry.value) && entry.value !== 0)
    .sort((a, b) => b.value - a.value);
}

function getReleaseYear(item = {}) {
  const value = item.release_date || item.first_air_date || item.year || '';
  const year = parseInt(String(value).slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function getRuntimeBand(runtime) {
  const minutes = asNumber(runtime, 0);
  if (!minutes) return null;
  if (minutes < 40) return 'short';
  if (minutes < 90) return 'compact';
  if (minutes < 150) return 'feature';
  return 'epic';
}

function getYearBucket(year) {
  if (!Number.isFinite(year)) return null;
  return `${Math.floor(year / 5) * 5}s`;
}

function normalizeGenres(item = {}) {
  if (Array.isArray(item.genres) && item.genres.length > 0) {
    return item.genres
      .map((genre) => {
        if (genre && typeof genre === 'object') {
          return { id: asNumber(genre.id, 0), name: genre.name || null };
        }
        return { id: asNumber(genre, 0), name: null };
      })
      .filter((genre) => genre.id);
  }

  if (Array.isArray(item.genre_ids)) {
    return item.genre_ids
      .map((genreId) => ({ id: asNumber(genreId, 0), name: null }))
      .filter((genre) => genre.id);
  }

  return [];
}

function normalizePeople(item = {}) {
  const credits = item.credits || {};
  const cast = Array.isArray(credits.cast) ? credits.cast.slice(0, 6) : [];
  const crew = Array.isArray(credits.crew) ? credits.crew : [];
  const directors = crew.filter((person) => person && person.job === 'Director').slice(0, 3);
  const writers = crew.filter((person) => person && /Writer|Screenplay|Story/i.test(person.job || '')).slice(0, 2);
  const creators = Array.isArray(item.created_by) ? item.created_by.slice(0, 3) : [];

  return {
    cast: cast.map((person) => ({ id: asNumber(person.id, 0), name: person.name || null })).filter((person) => person.id),
    directors: directors.map((person) => ({ id: asNumber(person.id, 0), name: person.name || null })).filter((person) => person.id),
    writers: writers.map((person) => ({ id: asNumber(person.id, 0), name: person.name || null })).filter((person) => person.id),
    creators: creators.map((person) => ({ id: asNumber(person.id, 0), name: person.name || null })).filter((person) => person.id),
  };
}

function normalizeRecommendationItem(type, item = {}) {
  const runtime = asNumber(item.runtime || (Array.isArray(item.episode_run_time) ? item.episode_run_time[0] : 0), 0);
  const year = getReleaseYear(item);
  const mediaType = type || item.media_type || (item.first_air_date !== undefined ? 'tv' : 'movie');
  const tmdbId = asNumber(item.tmdbId || item.id, 0);
  const people = normalizePeople(item);
  const genres = normalizeGenres(item);

  return {
    tmdbId,
    type: mediaType,
    title: item.title || item.name || item.original_title || item.original_name || 'Unknown',
    originalLanguage: item.original_language || null,
    year,
    yearBucket: getYearBucket(year),
    runtime,
    runtimeBand: getRuntimeBand(runtime),
    genres,
    genreIds: genres.map((genre) => genre.id),
    voteAverage: asNumber(item.vote_average, 0),
    popularity: asNumber(item.popularity, 0),
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    collectionId: item.belongs_to_collection ? asNumber(item.belongs_to_collection.id, 0) : 0,
    collectionName: item.belongs_to_collection ? item.belongs_to_collection.name || null : null,
    people,
  };
}

function decayWeight(baseWeight, createdAt, now = Date.now()) {
  const createdMs = createdAt ? new Date(createdAt).getTime() : now;
  const ageDays = clamp((now - createdMs) / MS_PER_DAY, 0, 3650);
  return baseWeight * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

function buildProfile({ interactions = [], watchlist = { movie: {}, tv: {} }, history = { movies: {}, tvShows: {} }, now = Date.now() } = {}) {
  const mediaTypes = {};
  const genres = {};
  const languages = {};
  const years = {};
  const runtimeBands = {};
  const cast = {};
  const crew = {};
  const franchises = {};
  const seedWeights = {};
  const qualitySamples = [];

  let totalSignalWeight = 0;
  let positiveSignalWeight = 0;

  const applySignal = (eventType, type, item, createdAt, sourceKind) => {
    if (!item || !item.tmdbId || !type) return;
    const baseWeight = asNumber(EVENT_WEIGHTS[eventType], 0);
    const weight = decayWeight(baseWeight, createdAt, now);
    if (!Number.isFinite(weight) || weight === 0) return;

    totalSignalWeight += Math.abs(weight);
    if (weight > 0) positiveSignalWeight += weight;

    increment(mediaTypes, type, weight);
    increment(seedWeights, `${type}:${item.tmdbId}`, weight, item.title);

    for (const genre of item.genres || []) {
      increment(genres, String(genre.id), weight, genre.name || null);
    }

    if (item.originalLanguage) {
      increment(languages, item.originalLanguage, weight);
    }

    if (item.yearBucket) {
      increment(years, item.yearBucket, weight, String(item.yearBucket));
    }

    if (item.runtimeBand) {
      increment(runtimeBands, item.runtimeBand, weight);
    }

    for (const person of item.people && item.people.cast ? item.people.cast : []) {
      increment(cast, String(person.id), weight * 0.9, person.name || null);
    }

    const crewPeople = []
      .concat(item.people && item.people.directors ? item.people.directors : [])
      .concat(item.people && item.people.creators ? item.people.creators : [])
      .concat(item.people && item.people.writers ? item.people.writers : []);
    for (const person of crewPeople) {
      increment(crew, String(person.id), weight * 1.05, person.name || null);
    }

    if (item.collectionId) {
      increment(franchises, `collection:${item.collectionId}`, weight, item.collectionName || item.title);
    } else if (sourceKind === 'history' && type === 'tv') {
      increment(franchises, `series:${type}:${item.tmdbId}`, weight * 0.65, item.title);
    }

    if (weight > 0 && item.voteAverage) {
      qualitySamples.push({ weight, voteAverage: item.voteAverage });
    }
  };

  for (const interaction of interactions) {
    const type = interaction.type;
    const item = normalizeRecommendationItem(type, interaction.item || interaction.metadata || {});
    applySignal(interaction.eventType, type, item, interaction.createdAt, interaction.sourceKind || 'interaction');
  }

  const watchlistItems = Object.values((watchlist && watchlist.movie) || {})
    .concat(Object.values((watchlist && watchlist.tv) || {}));
  for (const item of watchlistItems) {
    applySignal('watchlist_add', item.type || item.media_type, normalizeRecommendationItem(item.type || item.media_type, item), item.addedAt, 'watchlist');
  }

  for (const movie of Object.values(history.movies || {})) {
    applySignal('watch_complete', 'movie', normalizeRecommendationItem('movie', movie), movie.watchedAt, 'history');
  }
  for (const show of Object.values(history.tvShows || {})) {
    const normalized = normalizeRecommendationItem('tv', show);
    applySignal(show.lastEpisode || show.lastSeason ? 'tv_progress' : 'watch_complete', 'tv', normalized, show.watchedAt, 'history');
    applySignal('watch_complete', 'tv', normalized, show.watchedAt, 'history');
  }

  const weightedVoteTotal = qualitySamples.reduce((sum, sample) => sum + (sample.voteAverage * sample.weight), 0);
  const weightedVoteWeight = qualitySamples.reduce((sum, sample) => sum + sample.weight, 0);
  const weightedAverageVote = weightedVoteWeight > 0 ? (weightedVoteTotal / weightedVoteWeight) : 0;
  const qualityFloor = weightedAverageVote > 0 ? clamp(weightedAverageVote - 1.1, 5.5, 8.2) : 6.2;

  return {
    updatedAt: new Date(now).toISOString(),
    totalSignalWeight,
    positiveSignalWeight,
    mediaTypes: toSortedArray(mediaTypes),
    genres: toSortedArray(genres),
    languages: toSortedArray(languages),
    years: toSortedArray(years),
    runtimeBands: toSortedArray(runtimeBands),
    cast: toSortedArray(cast),
    crew: toSortedArray(crew),
    franchises: toSortedArray(franchises),
    seedWeights: toSortedArray(seedWeights),
    qualityFloor,
    weightedAverageVote,
  };
}

function hasMeaningfulSignals(profile) {
  return asNumber(profile && profile.positiveSignalWeight, 0) >= 10;
}

function isFullyPersonalized(profile) {
  return asNumber(profile && profile.positiveSignalWeight, 0) >= 22;
}

function normalizeScore(value, maxValue) {
  if (!maxValue || !Number.isFinite(value)) return 0;
  return clamp(value / maxValue, 0, 1);
}

function lookupWeight(list, key) {
  const entry = (list || []).find((item) => item.key === key);
  return entry ? asNumber(entry.value, 0) : 0;
}

function topWeight(list) {
  return list && list.length > 0 ? asNumber(list[0].value, 0) : 0;
}

function scoreYear(profile, candidate) {
  if (!candidate.yearBucket || !profile.years || profile.years.length === 0) return 0;
  const direct = lookupWeight(profile.years, candidate.yearBucket);
  const max = topWeight(profile.years);
  return 8 * normalizeScore(direct, max);
}

function scoreGenres(profile, candidate) {
  const topGenres = (profile.genres || []).slice(0, 8);
  if (topGenres.length === 0 || !candidate.genreIds || candidate.genreIds.length === 0) return 0;
  const denom = topGenres.reduce((sum, genre) => sum + asNumber(genre.value, 0), 0) || 1;
  const total = topGenres.reduce((sum, genre) => (
    candidate.genreIds.includes(asNumber(genre.key, 0)) ? sum + asNumber(genre.value, 0) : sum
  ), 0);
  return 28 * clamp(total / denom, 0, 1);
}

function scoreLanguage(profile, candidate) {
  if (!candidate.originalLanguage) return 0;
  return 6 * normalizeScore(
    lookupWeight(profile.languages, candidate.originalLanguage),
    topWeight(profile.languages)
  );
}

function scoreRuntime(profile, candidate) {
  if (!candidate.runtimeBand) return 0;
  return 4 * normalizeScore(
    lookupWeight(profile.runtimeBands, candidate.runtimeBand),
    topWeight(profile.runtimeBands)
  );
}

function scoreMediaType(profile, candidate) {
  return 10 * normalizeScore(
    lookupWeight(profile.mediaTypes, candidate.type),
    topWeight(profile.mediaTypes)
  );
}

function scoreQuality(profile, candidate) {
  const ratingNorm = clamp((candidate.voteAverage - (profile.qualityFloor - 1.0)) / 3.5, 0, 1);
  const popularityNorm = clamp(candidate.popularity / 100, 0, 1);
  return 10 * ((ratingNorm * 0.75) + (popularityNorm * 0.25));
}

function scorePopularity(candidate) {
  return 4 * clamp(candidate.popularity / 120, 0, 1);
}

function scorePeople(profile, candidate) {
  const topCast = (profile.cast || []).slice(0, 10);
  const topCrew = (profile.crew || []).slice(0, 8);
  const castDenom = topCast.reduce((sum, item) => sum + asNumber(item.value, 0), 0) || 1;
  const crewDenom = topCrew.reduce((sum, item) => sum + asNumber(item.value, 0), 0) || 1;

  const castIds = new Set((candidate.people && candidate.people.cast ? candidate.people.cast : []).map((person) => String(person.id)));
  const crewIds = new Set(
    []
      .concat(candidate.people && candidate.people.directors ? candidate.people.directors : [])
      .concat(candidate.people && candidate.people.creators ? candidate.people.creators : [])
      .concat(candidate.people && candidate.people.writers ? candidate.people.writers : [])
      .map((person) => String(person.id))
  );

  const castScore = topCast.reduce((sum, item) => (castIds.has(item.key) ? sum + asNumber(item.value, 0) : sum), 0) / castDenom;
  const crewScore = topCrew.reduce((sum, item) => (crewIds.has(item.key) ? sum + asNumber(item.value, 0) : sum), 0) / crewDenom;

  return 12 * clamp((castScore * 0.55) + (crewScore * 0.45), 0, 1);
}

function getSourceAffinity(candidate) {
  const signals = candidate.sourceSignals || [];
  let franchise = 0;
  let watchlist = 0;
  let because = 0;
  for (const signal of signals) {
    const seedNorm = clamp(asNumber(signal.seedScore, 0) / Math.max(asNumber(signal.topSeedScore, 1), 1), 0, 1);
    const endpointFactor = signal.kind === 'similar' ? 1
      : signal.kind === 'recommendations' ? 0.82
      : signal.kind === 'discover_profile' ? 0.45
      : signal.kind === 'discover_explore' ? 0.25
      : 0.15;
    const sourceFactor = signal.sourceKind === 'watchlist' ? 0.9
      : signal.sourceKind === 'history' ? 1
      : signal.sourceKind === 'click' ? 0.55
      : 0.35;
    const strength = seedNorm * endpointFactor * sourceFactor;
    franchise = Math.max(franchise, strength);
    if (signal.sourceKind === 'watchlist') {
      watchlist = Math.max(watchlist, strength);
    }
    if (signal.sourceKind === 'history' || signal.sourceKind === 'click') {
      because = Math.max(because, strength);
    }
  }

  if (candidate.collectionId) {
    const explicit = normalizeScore(
      lookupWeight(candidate.profileFranchises, `collection:${candidate.collectionId}`),
      topWeight(candidate.profileFranchises)
    );
    franchise = Math.max(franchise, explicit);
  }

  return {
    franchise: 18 * clamp(franchise, 0, 1),
    watchlist: 14 * clamp(watchlist, 0, 1),
    because: clamp(because, 0, 1),
  };
}

function scoreCandidate(profile, candidate) {
  const genreScore = scoreGenres(profile, candidate);
  const yearScore = scoreYear(profile, candidate);
  const languageScore = scoreLanguage(profile, candidate);
  const runtimeScore = scoreRuntime(profile, candidate);
  const mediaTypeScore = scoreMediaType(profile, candidate);
  const qualityScore = scoreQuality(profile, candidate);
  const popularityScore = scorePopularity(candidate);
  const peopleScore = scorePeople(profile, candidate);
  candidate.profileFranchises = profile.franchises || [];
  const sourceAffinity = getSourceAffinity(candidate);

  const total = genreScore
    + sourceAffinity.franchise
    + sourceAffinity.watchlist
    + peopleScore
    + mediaTypeScore
    + qualityScore
    + yearScore
    + languageScore
    + runtimeScore
    + popularityScore;

  return {
    total,
    genreScore,
    franchiseScore: sourceAffinity.franchise,
    watchlistScore: sourceAffinity.watchlist,
    peopleScore,
    mediaTypeScore,
    qualityScore,
    yearScore,
    languageScore,
    runtimeScore,
    popularityScore,
    becauseAffinity: sourceAffinity.because,
  };
}

function scoreCandidateBasic(profile, candidate) {
  const coarse = {
    ...candidate,
    people: { cast: [], directors: [], creators: [], writers: [] },
    runtimeBand: candidate.runtimeBand || null,
    collectionId: candidate.collectionId || 0,
  };
  return scoreCandidate(profile, coarse);
}

function pickReason(candidate, scoreBreakdown) {
  const watchlistSignal = (candidate.sourceSignals || []).find((signal) => signal.sourceKind === 'watchlist' && signal.seedTitle);
  if (watchlistSignal && scoreBreakdown.watchlistScore >= 5) {
    return {
      reasonType: 'watchlist',
      reasonLabel: 'Close to your saved list',
      seedContext: { type: watchlistSignal.seedType, id: watchlistSignal.seedId, title: watchlistSignal.seedTitle },
    };
  }

  const watchedSignal = (candidate.sourceSignals || []).find((signal) => (signal.sourceKind === 'history' || signal.sourceKind === 'click') && signal.seedTitle);
  if (watchedSignal && scoreBreakdown.becauseAffinity >= 0.28) {
    return {
      reasonType: 'because_watched',
      reasonLabel: `Because you watched ${watchedSignal.seedTitle}`,
      seedContext: { type: watchedSignal.seedType, id: watchedSignal.seedId, title: watchedSignal.seedTitle },
    };
  }

  if (scoreBreakdown.genreScore >= 15) {
    return {
      reasonType: 'genre_match',
      reasonLabel: 'Matches your usual taste',
      seedContext: null,
    };
  }

  if (scoreBreakdown.peopleScore >= 5) {
    return {
      reasonType: 'people_match',
      reasonLabel: 'Includes talent you often watch',
      seedContext: null,
    };
  }

  return {
    reasonType: 'discovery',
    reasonLabel: 'Discovery pick outside your usual pattern',
    seedContext: null,
  };
}

function classifyRecommendation(candidate, scoreBreakdown) {
  const exploreSignal = (candidate.sourceSignals || []).some((signal) => signal.kind === 'discover_explore' || signal.kind === 'trending' || signal.kind === 'popular');
  const overlapStrength = scoreBreakdown.genreScore + scoreBreakdown.peopleScore + scoreBreakdown.watchlistScore;
  if (exploreSignal && overlapStrength < 16) {
    return 'explore_new';
  }
  if (scoreBreakdown.watchlistScore >= 5) {
    return 'from_watchlist';
  }
  if (scoreBreakdown.becauseAffinity >= 0.28) {
    return 'because_watched';
  }
  return 'usual_taste';
}

function applyDiversityPenalty(sections, sectionId, candidate) {
  const sectionItems = sections[sectionId];
  if (!sectionItems || sectionItems.length === 0) return 0;

  const primaryGenre = candidate.genreIds && candidate.genreIds.length > 0 ? candidate.genreIds[0] : null;
  const sameGenreCount = sectionItems.filter((item) => item.genreIds && item.genreIds[0] === primaryGenre).length;
  const sameSeedCount = sectionItems.filter((item) => (
    item.seedContext && candidate.seedContext && item.seedContext.id === candidate.seedContext.id && item.seedContext.type === candidate.seedContext.type
  )).length;
  const sameCollectionCount = sectionItems.filter((item) => item.collectionId && candidate.collectionId && item.collectionId === candidate.collectionId).length;

  return clamp((sameGenreCount * 3) + (sameSeedCount * 5) + (sameCollectionCount * 6), 0, 10);
}

function buildRecommendationSections(items) {
  const sections = {
    top_picks: [],
    because_watched: [],
    from_watchlist: [],
    usual_taste: [],
    explore_new: [],
  };
  let exploreCount = 0;
  const totalTarget = SECTION_ORDER.reduce((sum, id) => sum + SECTION_LIMITS[id], 0);
  const maxExploreItems = Math.max(4, Math.floor(totalTarget * 0.3));

  const sorted = items.slice().sort((a, b) => b.score - a.score);

  for (const candidate of sorted) {
    if (sections.top_picks.length < SECTION_LIMITS.top_picks) {
      const penalty = applyDiversityPenalty(sections, 'top_picks', candidate);
      candidate.score -= penalty;
      sections.top_picks.push(candidate);
      continue;
    }

    const preferredSection = candidate.sectionId;
    if (preferredSection === 'explore_new' && exploreCount >= maxExploreItems) {
      candidate.sectionId = 'usual_taste';
    }

    const targetSection = SECTION_ORDER.find((sectionId) => {
      if (sectionId === 'top_picks') return false;
      if (candidate.sectionId !== sectionId && sectionId !== 'usual_taste') return false;
      return sections[sectionId].length < SECTION_LIMITS[sectionId];
    });

    if (!targetSection) continue;
    const penalty = applyDiversityPenalty(sections, targetSection, candidate);
    candidate.score -= penalty;
    sections[targetSection].push(candidate);
    if (targetSection === 'explore_new') {
      exploreCount++;
    }
  }

  const metadata = {
    top_picks: {
      title: 'Top Picks For You',
      subtitle: 'Best overall matches from your profile',
    },
    because_watched: {
      title: 'Because You Watched',
      subtitle: 'Anchored to titles you engaged with strongly',
    },
    from_watchlist: {
      title: 'From Your Watchlist',
      subtitle: 'Related to titles you explicitly saved',
    },
    usual_taste: {
      title: 'More Like Your Usual Taste',
      subtitle: 'Strong genre, era, and affinity matches',
    },
    explore_new: {
      title: 'Explore Something New',
      subtitle: 'Controlled discovery outside your core pattern',
    },
  };

  return SECTION_ORDER
    .map((id) => ({
      id,
      title: metadata[id].title,
      subtitle: metadata[id].subtitle,
      items: sections[id],
    }))
    .filter((section) => section.items.length > 0);
}

function flattenSections(sections) {
  return sections.reduce((all, section) => all.concat(section.items), []);
}

module.exports = {
  EVENT_WEIGHTS,
  HALF_LIFE_DAYS,
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
};
