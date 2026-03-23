'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

class HistoryStore {
  constructor(filePath = path.join(os.homedir(), '.uplayer-history.json')) {
    this.filePath = filePath;
  }

  defaultValue() {
    return { movies: {}, tvShows: {} };
  }

  read() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        return {
          movies: data.movies || {},
          tvShows: data.tvShows || {},
        };
      }
    } catch (e) {
      // Ignore corrupt history file and return defaults.
    }
    return this.defaultValue();
  }

  write(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  markWatched(type, item) {
    const db = this.read();
    const normalized = { ...item, watchedAt: new Date().toISOString() };
    if (type === 'movie') {
      db.movies[String(item.tmdbId)] = normalized;
    } else if (type === 'tv') {
      db.tvShows[String(item.tmdbId)] = normalized;
    } else {
      throw new Error('type must be movie or tv');
    }
    this.write(db);
    return db;
  }

  remove(type, id) {
    const db = this.read();
    if (type === 'movie') delete db.movies[id];
    else if (type === 'tv') delete db.tvShows[id];
    this.write(db);
    return db;
  }
}

module.exports = {
  HistoryStore,
};
