'use strict';

// Reconciling one account's library across devices that were edited independently — a phone
// watched offline on a plane, a PC that kept going at home — into a single state both can
// agree on. It answers exactly one question: given two versions of the same entry, what is
// the correct third version?
//
// It is NOT last-write-wins, and that is the whole reason this module exists. Two fields in
// a history entry carry ordering semantics that a blanket "newest object wins" destroys:
//
//   • lastSeason/lastEpisode is the FURTHEST-watched marker, kept monotonic on write
//     (history-store.js:63-78). A phone whose last sync was S2E3 has a legitimately newer
//     timestamp than a PC sitting on S5E10 — LWW would hand the phone the win and silently
//     un-watch thirty episodes, with no error anywhere. So this field merges as a max.
//   • progress is the opposite: it moves freely with the playhead, so newest genuinely does
//     win. Its absence is meaningful too — crossing 90% CLEARS it — so a newer side with no
//     progress must beat an older side that still has one.
//
// Deliberately excluded: the recommendation `profile`. It is a pure function of interactions
// + watchlist + history (buildProfile), so syncing it would invent conflicts that cannot be
// resolved and that recomputing locally settles for free.
//
// Pure: no IO, no timers, no clock. Every input arrives as an argument and every output is a
// new object — the caller owns reading and writing the stores. That is what lets
// tests/history-merge.test.js pin all of this without a network or a temp file.

// Mirrors MAX_INTERACTIONS in recommendation-service.js:17. Both cap the same array; if one
// moves the other must follow, or a sync would keep re-trimming what the writer just wrote.
const MAX_INTERACTIONS = 1000;

// Tombstones are kept this long so a delete can still beat a stale device that has been
// offline. Past that the device would lose anyway, and the row is dead weight.
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// --- timestamps --------------------------------------------------------------
// Entries written before this module existed have no updatedAt, only the user-facing
// watchedAt/addedAt ISO strings. Falling back to those makes an upgrade in place merge
// correctly instead of treating every pre-existing entry as infinitely old.
function entryUpdatedAt(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  if (Number.isFinite(entry.updatedAt)) return entry.updatedAt;
  const iso = entry.watchedAt || entry.addedAt || (entry.progress && entry.progress.updatedAt);
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function progressUpdatedAt(entry) {
  if (!entry || !entry.progress) return -Infinity;
  const parsed = Date.parse(entry.progress.updatedAt);
  return Number.isFinite(parsed) ? parsed : entryUpdatedAt(entry);
}

// Is (aS,aE) strictly later than (bS,bE)? Same comparison markWatched uses, so the merged
// marker and a locally written one can never disagree about what "further" means.
function isLaterEpisode(aS, aE, bS, bE) {
  if (aS == null || aE == null) return false;
  if (bS == null || bE == null) return true;
  return aS > bS || (aS === bS && aE > bE);
}

// --- history entries ---------------------------------------------------------

/**
 * Merge two versions of one movie/show entry. The two fields that carry meaning — the
 * furthest-watched marker and the playhead — resolve by their own rules (max, then further
 * position) rather than by argument order, so two devices writing in the same millisecond
 * still converge on those instead of ping-ponging. Remaining scalar fields fall to the local
 * side on an exact tie, which is as good as it needs to be for a same-millisecond collision.
 */
function mergeHistoryEntry(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;

  const localAt = entryUpdatedAt(local);
  const remoteAt = entryUpdatedAt(remote);
  const newer = remoteAt > localAt ? remote : local;
  const older = newer === remote ? local : remote;

  const merged = { ...newer };

  // "Reset progress" is the one thing that may legitimately move the marker BACKWARDS, so it
  // needs its own timestamp: without it the max rule below would faithfully restore S5E10
  // from the other device and quietly undo the button the user just pressed. A side whose
  // last edit predates the newest reset had its markers wiped by that reset and no longer
  // gets a vote; a side that watched something afterwards still does.
  const resetAt = Math.max(Number(local.progressResetAt) || 0, Number(remote.progressResetAt) || 0);
  if (resetAt) merged.progressResetAt = resetAt;
  if (entryUpdatedAt(newer) < resetAt) {
    delete merged.lastSeason;
    delete merged.lastEpisode;
  }

  // Furthest-watched never regresses, whichever side is newer.
  const olderMarkersValid = entryUpdatedAt(older) >= resetAt;
  if (olderMarkersValid
    && isLaterEpisode(older.lastSeason, older.lastEpisode, merged.lastSeason, merged.lastEpisode)) {
    merged.lastSeason = older.lastSeason;
    merged.lastEpisode = older.lastEpisode;
  }

  // Playhead: newest progress wins, and a newer side that CLEARED progress (completion)
  // beats an older side that still has one. Equal timestamps fall back to the further
  // position so the outcome is deterministic rather than device-order-dependent.
  const localProgAt = progressUpdatedAt(local);
  const remoteProgAt = progressUpdatedAt(remote);
  if (localProgAt === remoteProgAt && local.progress && remote.progress) {
    const localPos = Number(local.progress.positionSec) || 0;
    const remotePos = Number(remote.progress.positionSec) || 0;
    merged.progress = localPos >= remotePos ? local.progress : remote.progress;
  } else if (newer.progress) {
    merged.progress = newer.progress;
  } else if (progressUpdatedAt(older) > entryUpdatedAt(newer)) {
    // The older ENTRY carries a newer PROGRESS — it kept playing after the other side's last
    // edit. Keep it; the newer side simply never saw it.
    merged.progress = older.progress;
  } else {
    delete merged.progress;
  }

  // Fields the newer side may simply not carry. markWatched already lifts lastPlayback
  // across a wholesale replace (history-store.js:43) for the same reason: the write that
  // omits it isn't asserting its absence.
  if (merged.lastPlayback === undefined && older.lastPlayback !== undefined) {
    merged.lastPlayback = older.lastPlayback;
  }
  if (merged.tracking === undefined && older.tracking !== undefined) {
    merged.tracking = older.tracking;
  }
  for (const art of ['poster_path', 'backdrop_path']) {
    if (!merged[art] && older[art]) merged[art] = older[art];
  }

  merged.updatedAt = Math.max(localAt, remoteAt);
  return merged;
}

/** Watchlist entries carry no ordering semantics — newest intent wins outright. */
function mergeWatchlistEntry(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  const merged = entryUpdatedAt(remote) > entryUpdatedAt(local) ? { ...remote } : { ...local };
  merged.updatedAt = Math.max(entryUpdatedAt(local), entryUpdatedAt(remote));
  return merged;
}

// --- interactions ------------------------------------------------------------

// The signal log has no id (recommendation-service.js:209), so identity is the tuple that
// makes one event distinct from another.
function interactionKey(interaction) {
  if (!interaction || typeof interaction !== 'object') return '';
  return [
    interaction.createdAt || '',
    interaction.eventType || '',
    interaction.type || '',
    interaction.tmdbId == null ? '' : interaction.tmdbId,
  ].join('|');
}

/**
 * Union, not last-write-wins: an append-only log has no conflicts, only gaps. Two devices
 * that each recorded five events while apart should end with ten, not five. Sorted by
 * createdAt and capped exactly as the writer caps it.
 */
function mergeInteractions(local = [], remote = [], max = MAX_INTERACTIONS) {
  const byKey = new Map();
  for (const list of [local, remote]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const key = interactionKey(item);
      if (key && !byKey.has(key)) byKey.set(key, item);
    }
  }
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  return merged.length > max ? merged.slice(-max) : merged;
}

// --- changesets --------------------------------------------------------------
// The wire format is one flat list of {kind, itemId, json, updatedAt, deleted} rows, so the
// cloud never needs to understand a history entry — it stores and orders opaque blobs.

function bucketFor(snapshot, kind) {
  if (kind === 'movie') return snapshot.history.movies;
  if (kind === 'tv') return snapshot.history.tvShows;
  if (kind === 'watchlistMovie') return snapshot.recommendations.watchlist.movie;
  if (kind === 'watchlistTv') return snapshot.recommendations.watchlist.tv;
  return null;
}

function tombstonesFor(snapshot, kind) {
  const deleted = kind === 'movie' || kind === 'tv'
    ? snapshot.history.deleted
    : snapshot.recommendations.deleted;
  if (!deleted) return null;
  if (!deleted[kind]) deleted[kind] = {};
  return deleted[kind];
}

const ENTRY_KINDS = ['movie', 'tv', 'watchlistMovie', 'watchlistTv'];

/**
 * Everything edited since `since` (a local wall-clock ms watermark), as wire rows. No queue
 * file is needed: an entry whose updatedAt is past the last successful push is by definition
 * unsent, which survives a crash, a restart, and an Android force-stop for free.
 */
function collectLocalChanges(snapshot, since = 0) {
  const changes = [];
  for (const kind of ENTRY_KINDS) {
    const bucket = bucketFor(snapshot, kind) || {};
    for (const [itemId, entry] of Object.entries(bucket)) {
      const updatedAt = entryUpdatedAt(entry);
      if (updatedAt > since) changes.push({ kind, itemId, json: entry, updatedAt, deleted: false });
    }
    const tombstones = tombstonesFor(snapshot, kind) || {};
    for (const [itemId, deletedAt] of Object.entries(tombstones)) {
      if (Number(deletedAt) > since) {
        changes.push({ kind, itemId, json: null, updatedAt: Number(deletedAt), deleted: true });
      }
    }
  }
  const interactions = snapshot.recommendations.interactions || [];
  for (const interaction of interactions) {
    const at = Date.parse(interaction.createdAt);
    if (Number.isFinite(at) && at > since) {
      changes.push({
        kind: 'interaction',
        itemId: interactionKey(interaction),
        json: interaction,
        updatedAt: at,
        deleted: false,
      });
    }
  }
  return changes;
}

/**
 * Fold a batch of remote rows into a snapshot, returning a NEW snapshot. Every row goes
 * through the same merge the local writer would have applied, so applying a batch twice is
 * the same as applying it once.
 */
function applyRemoteChanges(snapshot, changes = []) {
  // The tombstone maps are copied one level deeper than the rest: this function writes into
  // them, and a shallow copy would reach back through and mutate the caller's snapshot.
  const copyTombstones = (deleted = {}) => {
    const out = {};
    for (const [kind, entries] of Object.entries(deleted)) out[kind] = { ...entries };
    return out;
  };

  const next = {
    history: {
      movies: { ...snapshot.history.movies },
      tvShows: { ...snapshot.history.tvShows },
      deleted: copyTombstones(snapshot.history.deleted),
    },
    recommendations: {
      watchlist: {
        movie: { ...snapshot.recommendations.watchlist.movie },
        tv: { ...snapshot.recommendations.watchlist.tv },
      },
      interactions: [...(snapshot.recommendations.interactions || [])],
      profile: snapshot.recommendations.profile,
      deleted: copyTombstones(snapshot.recommendations.deleted),
    },
  };

  const incomingInteractions = [];

  for (const change of changes) {
    if (!change || !change.kind) continue;
    if (change.kind === 'interaction') {
      if (change.json) incomingInteractions.push(change.json);
      continue;
    }

    const bucket = bucketFor(next, change.kind);
    if (!bucket) continue;
    const tombstones = tombstonesFor(next, change.kind);
    const key = String(change.itemId);
    const localEntry = bucket[key];
    const localDeletedAt = Number(tombstones && tombstones[key]) || 0;

    if (change.deleted) {
      // A delete only wins against a copy that is older than it. "Deleted on the phone, then
      // re-added on the PC an hour later" must end with the title present.
      if (entryUpdatedAt(localEntry) <= change.updatedAt) {
        delete bucket[key];
        if (tombstones) tombstones[key] = change.updatedAt;
      }
      continue;
    }

    // A local tombstone that is newer than the incoming row means we deleted it after the
    // other device last touched it — do not resurrect.
    if (localDeletedAt > change.updatedAt) continue;
    if (localDeletedAt) delete tombstones[key];

    const remoteEntry = { ...change.json, updatedAt: change.updatedAt };
    const isWatchlist = change.kind === 'watchlistMovie' || change.kind === 'watchlistTv';
    bucket[key] = isWatchlist
      ? mergeWatchlistEntry(localEntry, remoteEntry)
      : mergeHistoryEntry(localEntry, remoteEntry);
  }

  if (incomingInteractions.length) {
    next.recommendations.interactions = mergeInteractions(
      next.recommendations.interactions,
      incomingInteractions
    );
  }

  return next;
}

/**
 * Reconcile two complete libraries — what the cloud holds against what this device holds.
 * Expressed in terms of the changeset functions rather than as a third merge implementation:
 * a remote snapshot IS every row it contains, so `-1` (not 0) as the watermark takes even
 * entries stamped at epoch 0.
 */
function mergeSnapshots(local, remote) {
  return applyRemoteChanges(local, collectLocalChanges(remote, -1));
}

/** Drop tombstones past the TTL. Takes `now` rather than reading the clock — see the header. */
function pruneTombstones(deleted = {}, now) {
  const pruned = {};
  for (const [kind, entries] of Object.entries(deleted)) {
    const kept = {};
    for (const [itemId, at] of Object.entries(entries || {})) {
      if (now - Number(at) < TOMBSTONE_TTL_MS) kept[itemId] = Number(at);
    }
    if (Object.keys(kept).length) pruned[kind] = kept;
  }
  return pruned;
}

module.exports = {
  mergeHistoryEntry,
  mergeWatchlistEntry,
  mergeInteractions,
  collectLocalChanges,
  applyRemoteChanges,
  mergeSnapshots,
  pruneTombstones,
  MAX_INTERACTIONS,
  TOMBSTONE_TTL_MS,
  // exposed for unit tests
  _internals: { entryUpdatedAt, progressUpdatedAt, isLaterEpisode, interactionKey, bucketFor },
};
