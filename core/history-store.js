'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneTombstones } = require('./history-merge');

class HistoryStore {
  constructor(filePath = path.join(os.homedir(), '.uplayer-history.json')) {
    this.filePath = filePath;
  }

  defaultValue() {
    return { movies: {}, tvShows: {}, deleted: {} };
  }

  read() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        return {
          movies: data.movies || {},
          tvShows: data.tvShows || {},
          deleted: data.deleted || {},
        };
      }
    } catch (e) {
      // Ignore corrupt history file and return defaults.
    }
    return this.defaultValue();
  }

  write(data) {
    const out = { ...data, deleted: pruneTombstones(data.deleted || {}, Date.now()) };
    fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2), 'utf8');
  }


  markWatched(type, item) {
    const db = this.read();
    // `updatedAt` accompanies every mutation from here down. `watchedAt` is user-facing and
    // formatted for display; sync needs a plain comparable number, and needs it to move even
    // on writes that leave watchedAt alone (setTracking, setLastPlayback).
    const normalized = { ...item, watchedAt: new Date().toISOString(), updatedAt: Date.now() };
    // This replaces the entry wholesale, so anything the caller's `item` doesn't carry
    // has to be lifted across explicitly — see `tracking` below. `lastPlayback` (which
    // release source to resume from) is written by a separate call and would otherwise
    // be wiped every time a stream start re-marks the title as watched.
    const prior = type === 'movie' ? db.movies[String(item.tmdbId)] : db.tvShows[String(item.tmdbId)];
    if (prior && prior.lastPlayback && normalized.lastPlayback === undefined) {
      normalized.lastPlayback = prior.lastPlayback;
    }
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
    delete show.progress;
    show.watchedAt = new Date().toISOString();
    // Stamped separately from updatedAt because a reset is the one edit that moves the
    // furthest-watched marker BACKWARDS — sync has to be able to tell it apart from a stale
    // copy, or another device would helpfully restore what the user just cleared.
    show.progressResetAt = Date.now();
    show.updatedAt = show.progressResetAt;
    this.write(db);
    return db;
  }

  /**
   * Timestamp-level playback progress ("resume where you left off").
   * Unlike lastSeason/lastEpisode (monotonic furthest-watched), `progress`
   * moves freely with the playhead. Crossing 90% of the duration counts as
   * completed: the progress marker is cleared and, for TV, the episode is
   * folded into the furthest-watched marker under the same monotonic rule
   * as markWatched. `item` (optional) seeds title/artwork when the entry
   * doesn't exist yet (e.g. a direct-magnet play).
   */
  updateProgress(type, id, { season, episode, positionSec, durationSec, item } = {}) {
    const position = Number(positionSec);
    const duration = Number(durationSec);
    if (!Number.isFinite(position) || position < 0) {
      throw new Error('positionSec must be a non-negative number');
    }
    if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');

    const db = this.read();
    const bucket = type === 'movie' ? db.movies : db.tvShows;
    const key = String(id);
    let entry = bucket[key];
    if (!entry) {
      entry = { ...(item && typeof item === 'object' ? item : {}), tmdbId: id };
      if (type === 'tv' && entry.tracking === undefined) entry.tracking = true;
      bucket[key] = entry;
    }

    const completed = Number.isFinite(duration) && duration > 0 && position / duration >= 0.9;
    if (completed) {
      delete entry.progress;
      if (type === 'tv' && season != null && episode != null) {
        const s = Number(season);
        const e = Number(episode);
        const later = entry.lastSeason == null || entry.lastEpisode == null
          || s > entry.lastSeason
          || (s === entry.lastSeason && e > entry.lastEpisode);
        if (later) {
          entry.lastSeason = s;
          entry.lastEpisode = e;
        }
      }
    } else {
      entry.progress = {
        positionSec: Math.floor(position),
        durationSec: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
        updatedAt: new Date().toISOString(),
      };
      if (type === 'tv' && season != null && episode != null) {
        entry.progress.season = Number(season);
        entry.progress.episode = Number(episode);
      }
    }
    entry.watchedAt = new Date().toISOString();
    entry.updatedAt = Date.now();
    this.write(db);
    return db;
  }

  /**
   * Remember HOW a title was last played — the release source it streamed from.
   * `progress` records where the playhead is; this records what to start again, so
   * "Resume" can go straight back to the same release instead of making the user
   * pick a source and subtitle a second time. Best-effort: a title that has never
   * been streamed simply has no entry to attach to, and resume falls back to
   * ranking releases normally.
   */
  setLastPlayback(type, id, { source, season, episode, subtitle } = {}) {
    if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
    const db = this.read();
    const bucket = type === 'movie' ? db.movies : db.tvShows;
    const entry = bucket[String(id)];
    if (!entry) return db; // markWatched creates the entry first; nothing to annotate yet

    const last = {};
    if (source) last.source = String(source);
    if (type === 'tv' && Number.isFinite(Number(season))) last.season = Number(season);
    if (type === 'tv' && Number.isFinite(Number(episode))) last.episode = Number(episode);
    // The subtitle CHOICE, not the file — enough to download it again on Resume. The
    // downloaded file lives in a temp dir and cannot be relied on to still exist, and
    // re-fetching also means the timing auto-fix runs again for the new session.
    if (subtitle && typeof subtitle === 'object') last.subtitle = subtitle;
    if (!Object.keys(last).length) return db; // nothing worth remembering

    last.savedAt = new Date().toISOString();
    entry.lastPlayback = last;
    entry.updatedAt = Date.now();
    this.write(db);
    return db;
  }

  setTracking(id, tracking) {
    const db = this.read();
    const show = db.tvShows[String(id)];
    if (!show) throw new Error('TV show not found in history');
    show.tracking = !!tracking;
    show.updatedAt = Date.now();
    this.write(db);
    return db;
  }

  /**
   * Removing leaves a tombstone rather than dropping the key. A hard delete is invisible to
   * sync — the entry is simply absent, which is indistinguishable from "this device has
   * never heard of it" — so the next pull would faithfully restore it, forever. The
   * tombstone carries the timestamp that lets a later re-add win instead.
   */
  remove(type, id) {
    const db = this.read();
    const key = String(id);
    if (!db.deleted) db.deleted = {};
    if (type === 'movie') {
      delete db.movies[key];
      db.deleted.movie = { ...(db.deleted.movie || {}), [key]: Date.now() };
    } else if (type === 'tv') {
      delete db.tvShows[key];
      db.deleted.tv = { ...(db.deleted.tv || {}), [key]: Date.now() };
    }
    this.write(db);
    return db;
  }
}

module.exports = {
  HistoryStore,
};
