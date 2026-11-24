'use strict';

// Keeping one person's library identical on every device they use, without ever putting the
// network on the playback path. The local JSON stores stay authoritative: this engine reads
// them, reconciles with the copy in the cloud, writes back, and uploads. If the network is
// gone the app does not notice.
//
// The whole library is ONE row (see scripts/supabase-schema.sql). A watch history is a few hundred
// KB, so the per-item row model this replaced — a server-assigned cursor, paging, per-row
// upserts, an overlap window — was machinery for a scale that does not exist here.
//
// Three rules shape what remains:
//
//  1. MERGE BEFORE UPLOAD, always. The database stores an opaque blob, so an upload replaces
//     the library WHOLESALE and the field-aware rules (history-merge.js) only ever run on a
//     device. Uploading without merging first publishes a regression that every other device
//     then reads as fact — that is not theoretical, it put "S2E3" over a show watched to
//     S5E10 during testing of the earlier design.
//  2. An idle sync costs ONE small query. The version integer is checked first; the blob is
//     downloaded only when it has actually moved, or when we have something to send.
//  3. The upload names the version it read. Two devices writing at once are ordered by the
//     database: the loser matches zero rows, re-reads, re-merges and retries, rather than
//     silently overwriting the winner.
//
// Deliberately excluded: any notion of who is allowed to sync what. Not because it does not
// matter — because it is not decided here. Row Level Security in Postgres ties every request
// to the signed-in user (scripts/supabase-schema.sql), so this engine names a user id to
// target a row, and the database is what refuses if that id is not the caller's. A check in
// this file would be a second opinion running on the user's own machine, which is worth
// nothing against anyone who edits it.
//
// The client is an interface, not a database: readVersion, readLibrary, insertLibrary and
// updateLibrary are the whole of it. That is what let the backend move from Turso to Supabase
// without touching the merge rules or the race handling below, and it is worth keeping narrow
// for the same reason.
//
// IO: four calls through the injected client, and the two stores it is handed. Owns one timer
// while start()ed; stop() clears it.

const { mergeSnapshots, collectLocalChanges } = require('./history-merge');

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const BACKOFF_START_MS = 30 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

// How many times to re-merge when another device wins the race. Three is generous: each retry
// only loses if a DIFFERENT device commits in the microseconds between our read and our write.
const MAX_VERSION_RETRIES = 3;

class CloudSync {
  /**
   * @param {object} deps
   * @param {object} deps.client               TursoClient
   * @param {object} deps.historyStore
   * @param {object} deps.recommendationStore
   * @param {object} deps.meta                 {read(): {version, lastPushedAt}, write(obj)}
   * @param {string} deps.userId               whose row to sync
   * @param {function} [deps.onEvent]          (event, payload) => void — status for the UI
   */
  constructor({ client, historyStore, recommendationStore, meta, userId, onEvent } = {}) {
    this.client = client;
    this.historyStore = historyStore;
    this.recommendationStore = recommendationStore;
    this.meta = meta;
    this.userId = userId;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.timer = null;
    this.backoffMs = 0;
    this.inFlight = null;
    this.lastError = null;
    this.lastSyncAt = null;
    // Refreshed on every sync rather than recomputed per call: a status route polling this
    // would otherwise read both library files off disk once a second, forever.
    this.pending = 0;
  }

  isReady() {
    return !!(this.client && this.client.isConfigured() && this.userId);
  }

  _snapshot() {
    return {
      history: this.historyStore.read(),
      recommendations: this.recommendationStore.read(),
    };
  }

  _countPending(snapshot, lastPushedAt) {
    return collectLocalChanges(snapshot, lastPushedAt || 0).length;
  }

  /**
   * One exchange. Returns a summary rather than throwing on a network failure — being offline
   * is this app's normal state, not an error worth interrupting anyone over. A SQL or auth
   * fault is reported the same way but recorded in lastError, because that one needs fixing.
   */
  async syncOnce() {
    if (!this.isReady()) return { skipped: 'not-configured' };
    // Coalesce rather than refuse. Signing in starts the background loop immediately, so a
    // "Sync now" pressed a moment later lands on top of a sync already in flight — reporting
    // "already running" to that caller made the button look broken and, worse, let it return
    // before the data it was waiting for had arrived.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _run() {
    try {
      const state = this.meta.read();
      let snapshot = this._snapshot();
      let pending = this._countPending(snapshot, state.lastPushedAt);
      this.pending = pending;

      // --- Cheapest possible check: has anything moved, and have we anything to send?
      const remoteVersion = await this.client.readVersion(this.userId);

      if (!pending && remoteVersion === (state.version || 0)) {
        this.backoffMs = 0;
        this.lastError = null;
        this.lastSyncAt = Date.now();
        const summary = { unchanged: true, version: remoteVersion };
        this.onEvent('sync_complete', summary);
        return summary;
      }

      let attempt = 0;
      let version = remoteVersion;
      for (;;) {
        // --- Download whatever is up there now.
        let remote = null;
        if (version > 0) {
          const row = await this.client.readLibrary(this.userId);
          if (row) {
            version = row.version;
            try {
              remote = JSON.parse(row.json);
            } catch (e) {
              // A corrupt blob must not wedge the account forever. Treat it as absent: the
              // local library is about to overwrite it anyway, and losing an unparseable
              // remote costs nothing that was not already lost.
              this.onEvent('sync_warning', { warning: 'remote library was unreadable; replacing it' });
              remote = null;
            }
          } else {
            version = 0;
          }
        }

        // --- Merge, then persist locally BEFORE uploading. Re-read here rather than reusing
        // the snapshot taken above: playback writes progress continuously, and an update that
        // landed while the download was in flight would otherwise be overwritten by our
        // stale copy.
        snapshot = this._snapshot();
        const merged = remote && remote.history
          ? mergeSnapshots(snapshot, remote)
          : snapshot;
        if (remote) {
          this.historyStore.write(merged.history);
          this.recommendationStore.write(merged.recommendations);
        }

        // --- Upload, naming the version we read.
        const payload = JSON.stringify({
          history: merged.history,
          recommendations: merged.recommendations,
        });

        // Both calls answer the same question — did MY write land, or did somebody else's? —
        // and both answer false rather than throwing when it did not, because a lost race is
        // an ordinary outcome here, not an error.
        const applied = version === 0
          ? await this.client.insertLibrary(this.userId, payload)
          : await this.client.updateLibrary(this.userId, payload, version);

        if (applied) {
          const newVersion = version + 1;
          // Clamped to now, and this is load-bearing. A device with a clock running fast
          // stamps entries in the future; those entries reach everyone else through the
          // merge, and an unclamped watermark would then sit ahead of real time — so every
          // genuine local edit after it looks "already sent" and is silently never uploaded.
          // That is how a delete went missing during end-to-end testing. Re-sending a
          // future-stamped entry until the clock catches up is the cheap half of the trade.
          const pushedThrough = Math.min(
            Date.now(),
            collectLocalChanges(merged, 0)
              .reduce((max, c) => Math.max(max, c.updatedAt), state.lastPushedAt || 0)
          );
          this.meta.write({ ...state, version: newVersion, lastPushedAt: pushedThrough });
          this.pending = 0;

          this.backoffMs = 0;
          this.lastError = null;
          this.lastSyncAt = Date.now();
          const summary = { uploaded: true, version: newVersion, pending: pending };
          this.onEvent('sync_complete', summary);
          return summary;
        }

        // Zero rows: another device committed between our read and our write. Its work is
        // now in the row we are about to re-read, so going round again folds both together.
        attempt += 1;
        if (attempt >= MAX_VERSION_RETRIES) {
          const message = 'another device kept winning the upload race; will retry on the next sync';
          this.lastError = message;
          this.onEvent('sync_failed', { error: message });
          return { error: message };
        }
        this.onEvent('sync_retry', { attempt });
        // Re-read the head so the next pass sees the winner's version.
        version = await this.client.readVersion(this.userId);
        pending = this._countPending(this._snapshot(), state.lastPushedAt);
      }
    } catch (err) {
      this.lastError = err.message;
      this.onEvent('sync_failed', { error: err.message });
      return { error: err.message };
    }
  }

  /** Sync now, then on a timer. Failures back off; they never stop the loop. */
  start() {
    if (this.timer) return;
    const tick = async () => {
      const result = await this.syncOnce();
      if (result && result.error) {
        this.backoffMs = this.backoffMs
          ? Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
          : BACKOFF_START_MS;
      }
      const delay = this.backoffMs || SYNC_INTERVAL_MS;
      this.timer = setTimeout(tick, delay);
      if (this.timer.unref) this.timer.unref();
    };
    this.timer = setTimeout(tick, 0);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status() {
    return {
      configured: this.isReady(),
      userId: this.userId || null,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      pending: this.pending,
      syncing: !!this.inFlight,
    };
  }
}

function createCloudSync(deps = {}) {
  return new CloudSync(deps);
}

module.exports = {
  CloudSync,
  createCloudSync,
  MAX_VERSION_RETRIES,
};
