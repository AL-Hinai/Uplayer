'use strict';

// How the BYTE SUPPLY is doing — download speed, swarm, how far ahead of the playhead
// the cache has got.
//
// Session-level and target-independent, like media-facts: there is one torrent, and it
// feeds whoever is playing. But unlike source facts (probed once, immutable), this is
// live — it ticks every second. Same scope, different lifetime, which is why they're
// separate modules rather than one "session info" bag.
//
// Pure: no IO, no timers. The caller polls TorrServer and hands the stats in.

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function num(value) {
  const n = finiteOrNull(value);
  return n == null ? 0 : n;
}

class StreamHealth {
  constructor() {
    this.sizeBytes = null;
    this.durationSec = null;
    this.downloadedBytes = 0;
    this.loadedBytes = 0;
    this.downloadSpeedBps = 0;
    this.uploadSpeedBps = 0;
    this.seeds = 0;
    this.peers = 0;
    this.swarmPeers = 0;
    this.pendingPeers = 0;
    this.torrentSizeBytes = 0;
    this.engineState = null;
    this.engineStateText = null;
    this.wasteRatio = null;
    this.playheadSec = null;
    this.playheadFrom = null;
    this.updatedAt = null;
  }

  /**
   * `sizeBytes` is the video file's length (always known). `durationSec` comes from
   * mediaFacts and may be null when the probe failed — without it there's no bitrate,
   * so no buffer estimate.
   */
  attachSource({ sizeBytes, durationSec } = {}) {
    const size = finiteOrNull(sizeBytes);
    if (size != null && size > 0) this.sizeBytes = size;
    const duration = finiteOrNull(durationSec);
    if (duration != null && duration > 0) this.durationSec = duration;
    return this;
  }

  /** Fold one TorrServer stats poll in. Field names are TorrServer's, snake_case. */
  report(stats) {
    const s = stats && typeof stats === 'object' ? stats : {};

    // Monotonic: TorrServer can report a smaller cache after eviction, but "downloaded"
    // going backwards would make the progress bar jump about.
    this.downloadedBytes = Math.max(this.downloadedBytes, num(s.preloadedBytes));
    this.loadedBytes = Math.max(this.loadedBytes, num(s.loadedBytes));
    this.downloadSpeedBps = num(s.downloadSpeed);
    this.uploadSpeedBps = num(s.uploadSpeed);

    // Three genuinely different numbers that used to be collapsed into one with `||`:
    // on a live swarm, 84 seeds / 86 active peers / 205 known peers. "Peers: 86" threw
    // away both of the others.
    this.seeds = num(s.seeds);
    this.peers = num(s.peers);
    this.swarmPeers = num(s.swarmPeers);
    this.pendingPeers = num(s.pendingPeers);

    this.torrentSizeBytes = num(s.torrentSize);
    this.engineState = finiteOrNull(s.stat);
    this.engineStateText = s.statText || null;

    // Fraction of read chunks thrown away — the honest "is this swarm wasting my
    // bandwidth" number. Null rather than 0 when TorrServer doesn't report it.
    const read = finiteOrNull(s.chunksRead);
    const wasted = finiteOrNull(s.chunksWasted);
    this.wasteRatio = read != null && read > 0 && wasted != null
      ? Math.round((wasted / read) * 10000) / 10000
      : null;

    this.updatedAt = Date.now();
    return this.status();
  }

  /**
   * Where the playhead is. Comes from the PlaybackTarget fan-out, so it's a TARGET
   * fact crossing into this plane — that crossing is the only way to answer "how much
   * buffer is ahead of me", which neither plane can answer alone.
   *
   * Two targets playing at once ⇒ last reporter wins, and we stamp who it was: there
   * is no single buffer question when someone watches in two places.
   */
  observePlayhead(positionSec, fromKey) {
    const pos = finiteOrNull(positionSec);
    if (pos == null || pos < 0) return;
    this.playheadSec = pos;
    this.playheadFrom = fromKey || null;
  }

  get percent() {
    if (!this.sizeBytes) return 0;
    // Matches the historical calculation exactly, including the clamp: preloaded_bytes
    // is torrent-wide while sizeBytes is one file, so on a multi-file torrent the ratio
    // can exceed 1.
    return Math.min(1, this.downloadedBytes / this.sizeBytes);
  }

  /**
   * Buffer ahead of the playhead — AN ESTIMATE, and it says so.
   *
   * Verified against a live TorrServer: there is no piece bitmap and no positional
   * field in the API. `preloaded_bytes` equals `loaded_size` — it is a total-cached
   * counter, not a contiguous window. So this is only sound if the download is
   * sequential from the front, which is what the reader does but not a guarantee. It's
   * also averaged over the whole file, so a VBR-heavy scene will read wrong.
   *
   * Null — never a guess — when the duration is unknown or nothing has reported a
   * playhead yet.
   */
  get buffer() {
    if (!this.sizeBytes || !this.durationSec) return null;
    if (this.playheadSec == null) return null;

    const avgBitrateBps = (this.sizeBytes * 8) / this.durationSec;
    const playheadBytes = (this.playheadSec / this.durationSec) * this.sizeBytes;
    const aheadBytes = Math.max(0, this.downloadedBytes - playheadBytes);
    return {
      aheadBytes: Math.round(aheadBytes),
      aheadSec: Math.round(((aheadBytes * 8) / avgBitrateBps) * 10) / 10,
      estimated: true,
      basis: 'sequential',
      playheadFrom: this.playheadFrom,
    };
  }

  status() {
    return {
      percent: this.percent,
      downloadedBytes: this.downloadedBytes,
      loadedBytes: this.loadedBytes,
      downloadSpeedBps: this.downloadSpeedBps,
      uploadSpeedBps: this.uploadSpeedBps,
      seeds: this.seeds,
      peers: this.peers,
      swarmPeers: this.swarmPeers,
      pendingPeers: this.pendingPeers,
      torrentSizeBytes: this.torrentSizeBytes,
      engineState: this.engineState,
      engineStateText: this.engineStateText,
      wasteRatio: this.wasteRatio,
      buffer: this.buffer,
      updatedAt: this.updatedAt,
    };
  }
}

/**
 * The `progress` SSE payload, byte-for-byte as the UI has always received it —
 * pre-formatted strings and all. This is the ONLY place those strings are made.
 *
 * `progress` means torrent download percent and is consumed by the existing progress
 * bar; the richer numbers ride a separate `stream_health` event rather than changing
 * this shape. Freezing it here is what makes that safe.
 */
function legacyProgressPayload(status) {
  return {
    percent: parseFloat((status.percent * 100).toFixed(1)),
    speed: `${(status.downloadSpeedBps / 1024 / 1024).toFixed(2)} MB/s`,
    downloaded: `${(status.downloadedBytes / 1024 / 1024).toFixed(2)} MB`,
    // The old `active_peers || connected_seeders || total_peers` collapse, reproduced
    // exactly. The client no longer does it, so it has to happen here or a swarm with 0
    // active but 84 connected seeders would suddenly display "0 peers".
    peers: status.peers || status.seeds || status.swarmPeers || 0,
  };
}

module.exports = {
  StreamHealth,
  legacyProgressPayload,
};
