'use strict';

const { loadEnvFileOnce, getRuntimeConfig, validateRuntimeConfig } = require('./config');
const { createTmdbClient } = require('./tmdb-client');
const { HistoryStore } = require('./history-store');
const { RecommendationStore } = require('./recommendation-store');
const { RecommendationService } = require('./recommendation-service');
const { SubtitleTokenStore } = require('./subtitle-token-store');

function createSharedServices(options = {}) {
  const {
    constructors = {},
    historyPath,
    recommendationPath,
    subtitleTokenTtlMs,
  } = options;

  loadEnvFileOnce();
  const runtime = validateRuntimeConfig(getRuntimeConfig());

  const tmdbClient = createTmdbClient(runtime.config.tmdbApiKey);
  const historyStore = new HistoryStore(historyPath);
  const recommendationStore = new RecommendationStore(recommendationPath);
  const recommendationService = new RecommendationService({
    tmdbClient,
    historyStore,
    recommendationStore,
  });
  const subtitleTokenStore = new SubtitleTokenStore(subtitleTokenTtlMs);

  const serviceFactory = {
    runtime,
    tmdbClient,
    historyStore,
    recommendationStore,
    recommendationService,
    subtitleTokenStore,
    createMediaSearcher() {
      if (!constructors.MediaSearcher) {
        throw new Error('MediaSearcher constructor is not configured');
      }
      return new constructors.MediaSearcher({
        tmdbClient,
      });
    },
    createTorrentScraper() {
      if (!constructors.TorrentScraper) {
        throw new Error('TorrentScraper constructor is not configured');
      }
      return new constructors.TorrentScraper();
    },
    createSubtitleManager() {
      if (!constructors.SubtitleManager) {
        throw new Error('SubtitleManager constructor is not configured');
      }
      return new constructors.SubtitleManager({
        openSubtitles: runtime.config.openSubtitles,
      });
    },
    createStreamManager(optionsForManager = {}) {
      if (!constructors.StreamManager) {
        throw new Error('StreamManager constructor is not configured');
      }
      return new constructors.StreamManager(false, optionsForManager.memoryTracker || null);
    },
  };

  return serviceFactory;
}

module.exports = {
  createSharedServices,
};
