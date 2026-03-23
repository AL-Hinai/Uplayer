'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SubtitleTokenStore } = require('../core/subtitle-token-store');
const { HistoryStore } = require('../core/history-store');
const { TmdbClient } = require('../core/tmdb-client');
const { createSharedServices } = require('../core/shared-services');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testSubtitleTokenStore() {
  const store = new SubtitleTokenStore(1000);
  const token = store.issue('/tmp/sub.vtt', 1000);
  assert.ok(token, 'token should be issued');
  assert.strictEqual(store.resolve(token), '/tmp/sub.vtt');
  const inspect = store.inspect(token);
  assert.ok(inspect, 'inspect should return token metadata');
  assert.strictEqual(inspect.token, token);
  await sleep(1100);
  assert.strictEqual(store.resolve(token), null, 'expired token should resolve to null');
}

function testHistoryStore() {
  const tmpFile = path.join(os.tmpdir(), `uplayer-history-test-${Date.now()}.json`);
  const store = new HistoryStore(tmpFile);
  const empty = store.read();
  assert.deepStrictEqual(empty, { movies: {}, tvShows: {} });

  store.markWatched('movie', { tmdbId: 10, title: 'Test Movie' });
  const withMovie = store.read();
  assert.ok(withMovie.movies['10']);
  assert.strictEqual(withMovie.movies['10'].title, 'Test Movie');

  store.remove('movie', '10');
  const removed = store.read();
  assert.strictEqual(removed.movies['10'], undefined);

  fs.rmSync(tmpFile, { force: true });
}

async function testTmdbClientValidation() {
  const client = new TmdbClient('');
  await assert.rejects(
    () => client.get('/trending/all/week'),
    /TMDB_API_KEY is required/
  );
}

function testSharedServiceFactory() {
  class FakeMediaSearcher {
    constructor(options = {}) {
      this.options = options;
    }
  }
  class FakeTorrentScraper {}
  class FakeSubtitleManager {
    constructor(options = {}) {
      this.options = options;
    }
  }
  class FakeStreamManager {
    constructor(lowMemoryMode, memoryTracker) {
      this.lowMemoryMode = lowMemoryMode;
      this.memoryTracker = memoryTracker;
    }
  }

  const services = createSharedServices({
    constructors: {
      MediaSearcher: FakeMediaSearcher,
      TorrentScraper: FakeTorrentScraper,
      SubtitleManager: FakeSubtitleManager,
      StreamManager: FakeStreamManager,
    },
  });

  const searcher = services.createMediaSearcher();
  const scraper = services.createTorrentScraper();
  const subtitles = services.createSubtitleManager();
  const stream = services.createStreamManager({ memoryTracker: { id: 'mem' } });

  assert.ok(searcher.options.tmdbClient, 'tmdb client should be injected into media searcher');
  assert.ok(scraper instanceof FakeTorrentScraper);
  assert.ok(subtitles.options.openSubtitles, 'subtitle credentials should be injected');
  assert.strictEqual(stream.lowMemoryMode, false, 'shared factory should enforce default single mode');
  assert.ok(services.recommendationService, 'recommendation service should be exposed by shared services');
}

async function main() {
  await testSubtitleTokenStore();
  testHistoryStore();
  await testTmdbClientValidation();
  testSharedServiceFactory();
  console.log('core-services.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
