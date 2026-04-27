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
      const existing = db.tvShows[String(item.tmdbId)];
      // Preserve tracking state; default to true for new entries
      if (existing && existing.tracking !== undefined) {
        normalized.tracking = existing.tracking;
      } else if (normalized.tracking === undefined) {
        normalized.tracking = true;
      }

      // Monotonic-progress semantics: lastSeason/lastEpisode tracks the
      // FURTHEST-watched point, so marking S2E3 as watched after already
      // having watched up to S5E10 implicitly preserves S5E10 as progress
      // (everything ≤ that is treated as watched in the UI). This means
      // "marking an episode as watched also marks earlier ones" — the
      // progress marker stays at whichever is later.
      if (existing && existing.lastSeason != null && existing.lastEpisode != null) {
        const newS = normalized.lastSeason;
        const newE = normalized.lastEpisode;
        const oldS = existing.lastSeason;
        const oldE = existing.lastEpisode;
        const newIsLater =
          newS != null &&
          newE != null &&
          (newS > oldS || (newS === oldS && newE > oldE));
        if (!newIsLater) {
          // Caller's selection is at or before the existing progress —
          // keep the existing marker (still updates watchedAt).
          normalized.lastSeason = oldS;
          normalized.lastEpisode = oldE;
        }
      }

      db.tvShows[String(item.tmdbId)] = normalized;
    } else {
      throw new Error('type must be movie or tv');
    }
    this.write(db);
    return db;
  }

  /**
   * Reset TV progress back to the beginning (used by a "Reset progress"
   * button in the UI). Keeps the show in history but clears the
   * lastSeason/lastEpisode markers so the user can re-watch from S1E1.
   */
  resetProgress(id) {
    const db = this.read();
    const show = db.tvShows[String(id)];
    if (!show) throw new Error('TV show not found in history');
    delete show.lastSeason;
    delete show.lastEpisode;
    show.watchedAt = new Date().toISOString();
    this.write(db);
    return db;
  }

  setTracking(id, tracking) {
    const db = this.read();
    const show = db.tvShows[String(id)];
    if (!show) throw new Error('TV show not found in history');
    show.tracking = !!tracking;
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
