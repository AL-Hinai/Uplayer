'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HistoryStore } = require('../core/history-store');
const { RecommendationStore } = require('../core/recommendation-store');
const { RecommendationService } = require('../core/recommendation-service');
const {
  buildProfile,
  normalizeRecommendationItem,
  scoreCandidate,
  buildRecommendationSections,
} = require('../core/recommendation-engine');

function makeCredits(castIds = [], directorId = 900) {
  return {
    cast: castIds.map((id, index) => ({ id, name: `Cast ${id}`, character: `Role ${index + 1}` })),
    crew: [
      { id: directorId, name: `Director ${directorId}`, job: 'Director' },
      { id: directorId + 1, name: `Writer ${directorId + 1}`, job: 'Writer' },
    ],
  };
}

function makeMovie(id, title, options = {}) {
  return {
    id,
    tmdbId: id,
    title,
    media_type: 'movie',
    poster_path: `/poster-${id}.jpg`,
    backdrop_path: `/backdrop-${id}.jpg`,
    release_date: options.release_date || '2024-01-01',
    vote_average: options.vote_average || 8.1,
    popularity: options.popularity || 70,
    original_language: options.original_language || 'en',
    genres: options.genres || [{ id: 28, name: 'Action' }],
    genre_ids: (options.genres || [{ id: 28, name: 'Action' }]).map((genre) => genre.id),
    runtime: options.runtime || 118,
    credits: options.credits || makeCredits([101, 102], 901),
    belongs_to_collection: options.belongs_to_collection || null,
  };
}

function createFakeTmdbClient() {
  const details = {
    'movie:100': makeMovie(100, 'Seed One', {
      genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
      vote_average: 8.7,
      popularity: 88,
      belongs_to_collection: { id: 5000, name: 'Seed Saga' },
      credits: makeCredits([101, 103], 901),
    }),
    'movie:200': makeMovie(200, 'Perfect Match', {
      genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
      vote_average: 8.6,
      popularity: 92,
      belongs_to_collection: { id: 5000, name: 'Seed Saga' },
      credits: makeCredits([101, 104], 901),
    }),
    'movie:201': makeMovie(201, 'Saved Neighbor', {
      genres: [{ id: 28, name: 'Action' }, { id: 12, name: 'Adventure' }],
      vote_average: 8.2,
      popularity: 78,
      credits: makeCredits([105, 106], 903),
    }),
    'movie:202': makeMovie(202, 'Genre Fit', {
      genres: [{ id: 28, name: 'Action' }, { id: 14, name: 'Fantasy' }],
      vote_average: 8.0,
      popularity: 66,
      credits: makeCredits([101, 107], 904),
    }),
    'movie:203': makeMovie(203, 'Explore Pick', {
      genres: [{ id: 53, name: 'Thriller' }],
      vote_average: 7.4,
      popularity: 84,
      credits: makeCredits([205, 206], 905),
    }),
    'movie:204': makeMovie(204, 'Trending Backup', {
      genres: [{ id: 28, name: 'Action' }],
      vote_average: 7.9,
      popularity: 90,
      credits: makeCredits([101, 208], 901),
    }),
    'movie:300': makeMovie(300, 'Saved Anchor', {
      genres: [{ id: 28, name: 'Action' }, { id: 14, name: 'Fantasy' }],
      vote_average: 8.3,
      popularity: 64,
      credits: makeCredits([105, 109], 903),
    }),
  };

  return {
    async get(endpoint) {
      if (/^\/movie\/\d+$/.test(endpoint)) {
        const id = endpoint.split('/').pop();
        return details[`movie:${id}`];
      }
      if (endpoint === '/movie/100/recommendations') {
        return { results: [details['movie:200'], details['movie:201']] };
      }
      if (endpoint === '/movie/100/similar') {
        return { results: [details['movie:202']] };
      }
      if (endpoint === '/movie/300/recommendations') {
        return { results: [details['movie:201']] };
      }
      if (endpoint === '/movie/300/similar') {
        return { results: [details['movie:202']] };
      }
      if (endpoint === '/discover/movie') {
        return { results: [details['movie:203']] };
      }
      if (endpoint === '/discover/tv') {
        return { results: [] };
      }
      if (endpoint === '/trending/movie/week' || endpoint === '/trending/all/week') {
        return { results: [details['movie:204']] };
      }
      return { results: [] };
    },
  };
}

function tempFile(name) {
  return path.join(os.tmpdir(), `uplayer-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

async function testScoringWeightsPreferBetterMatch() {
  const history = {
    movies: {
      '100': {
        ...makeMovie(100, 'Seed One', {
          genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
          vote_average: 8.7,
          popularity: 88,
          belongs_to_collection: { id: 5000, name: 'Seed Saga' },
          credits: makeCredits([101, 103], 901),
        }),
        watchedAt: new Date().toISOString(),
      },
    },
    tvShows: {},
  };

  const profile = buildProfile({ history });
  const strongMatch = normalizeRecommendationItem('movie', makeMovie(200, 'Perfect Match', {
    genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
    belongs_to_collection: { id: 5000, name: 'Seed Saga' },
    credits: makeCredits([101, 104], 901),
    vote_average: 8.4,
    popularity: 88,
  }));
  strongMatch.sourceSignals = [{
    kind: 'recommendations',
    sourceKind: 'history',
    seedId: 100,
    seedType: 'movie',
    seedTitle: 'Seed One',
    seedScore: 10,
    topSeedScore: 10,
  }];

  const weakMatch = normalizeRecommendationItem('movie', makeMovie(203, 'Explore Pick', {
    genres: [{ id: 18, name: 'Drama' }],
    original_language: 'fr',
    credits: makeCredits([301, 302], 990),
    vote_average: 7.0,
    popularity: 30,
  }));
  weakMatch.sourceSignals = [{
    kind: 'discover_explore',
    sourceKind: 'explore',
    seedId: null,
    seedType: 'movie',
    seedTitle: null,
    seedScore: 1,
    topSeedScore: 10,
  }];

  const strongScore = scoreCandidate(profile, strongMatch).total;
  const weakScore = scoreCandidate(profile, weakMatch).total;

  assert.ok(strongScore > weakScore, 'close profile matches should score higher than weak exploratory candidates');
}

async function testRecommendationServiceFlow() {
  const historyPath = tempFile('history');
  const recommendationPath = tempFile('recommendation');
  const historyStore = new HistoryStore(historyPath);
  const recommendationStore = new RecommendationStore(recommendationPath);
  const service = new RecommendationService({
    tmdbClient: createFakeTmdbClient(),
    historyStore,
    recommendationStore,
  });

  try {
    historyStore.markWatched('movie', {
      ...makeMovie(100, 'Seed One', {
        genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
        vote_average: 8.7,
        popularity: 88,
        belongs_to_collection: { id: 5000, name: 'Seed Saga' },
        credits: makeCredits([101, 103], 901),
      }),
    });

    await service.recordEvent({
      eventType: 'detail_click',
      type: 'movie',
      tmdbId: 100,
      metadata: { id: 100, title: 'Seed One' },
    });

    const saved = await service.addWatchlist({
      type: 'movie',
      tmdbId: 300,
    });
    assert.strictEqual(saved.item.tmdbId, 300);

    const recommendations = await service.getRecommendations({ type: 'movie' });
    assert.ok(recommendations.sections.length > 0, 'recommendation sections should be returned');
    assert.ok(recommendations.results.length > 0, 'flattened results should be returned');
    assert.ok(recommendations.personalization.meaningful, 'profile should become meaningful after history plus interactions');
    assert.ok(recommendations.results.every((item) => item.reasonLabel && typeof item.score === 'number'));
    assert.ok(recommendations.results.every((item) => item.tmdbId !== 100), 'already watched seeds should be excluded');
    assert.ok(recommendations.results.some((item) => item.reasonType === 'watchlist' || item.reasonType === 'because_watched'));

    const sections = buildRecommendationSections(recommendations.results.map((item) => ({
      ...item,
      sectionId: item.sectionId || 'usual_taste',
    })));
    assert.ok(sections.length > 0, 'sections builder should preserve grouped output');

    const removed = service.removeWatchlist('movie', 300);
    assert.strictEqual(removed.removed, true, 'watchlist removal should report success');
    assert.strictEqual(service.getWatchlist().total, 0, 'watchlist should be empty after removal');
  } finally {
    fs.rmSync(historyPath, { force: true });
    fs.rmSync(recommendationPath, { force: true });
  }
}

async function main() {
  await testScoringWeightsPreferBetterMatch();
  await testRecommendationServiceFlow();
  console.log('recommendation-engine.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
