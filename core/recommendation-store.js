'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneTombstones } = require('./history-merge');

class RecommendationStore {
  constructor(filePath = path.join(os.homedir(), '.uplayer-recommendations.json')) {
    this.filePath = filePath;
  }

  defaultValue() {
    return {
      watchlist: { movie: {}, tv: {} },
      interactions: [],
      profile: {
        updatedAt: null,
        totalSignalWeight: 0,
      },
      // Tombstones for watchlist removals, keyed the way the sync wire format keys them
      // (watchlistMovie / watchlistTv). See HistoryStore.remove for why a delete cannot
      // simply drop the key.
      deleted: {},
    };
  }

  normalize(data = {}) {
    return {
      watchlist: {
        movie: data.watchlist && data.watchlist.movie ? data.watchlist.movie : {},
        tv: data.watchlist && data.watchlist.tv ? data.watchlist.tv : {},
      },
      interactions: Array.isArray(data.interactions) ? data.interactions : [],
      profile: data.profile && typeof data.profile === 'object'
        ? data.profile
        : { updatedAt: null, totalSignalWeight: 0 },
      deleted: data.deleted && typeof data.deleted === 'object' ? data.deleted : {},
    };
  }

  read() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        return this.normalize(raw);
      }
    } catch (e) {
      // Ignore corrupt recommendation state and return defaults.
    }
    return this.defaultValue();
  }

  write(data) {
    const normalized = this.normalize(data);
    normalized.deleted = pruneTombstones(normalized.deleted, Date.now());
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), 'utf8');
  }

  update(mutator) {
    const data = this.read();
    const maybeResult = mutator(data);
    this.write(data);
    return maybeResult == null ? data : maybeResult;
  }
}

module.exports = {
  RecommendationStore,
};
