'use strict';

// AnimeTosho, queried by AniDB ids instead of by name. It is a separate module from
// torrent-scraper.js rather than a sixth method on it because the two answer different
// questions: that file plans text queries and parses HTML, this one hands integers to a
// JSON API and parses nothing. Nothing is shared but the result shape.
//
// Two queries per lookup, always, and the pair is the point:
//   exact  ?aids=<show>&eids=<episode>  — every row IS the requested episode. No name
//          parsing can improve on it, so these rows carry idMatched and skip the
//          classifier entirely.
//   broad  ?aids=<show>                 — the show's recent releases. Needed because the
//          eid filter silently drops BATCHES and SEASON PACKS, which carry no episode id
//          at all (measured: of 75 rows for one show, only 22 had an eid). These rows are
//          NOT idMatched and go through name classification like any other source.
// Querying only `eids` would therefore hide every pack; querying only `aids` would throw
// away the exactness. (bench/ANIME-LOOKUP.md)
//
// MIRRORS: feed.animetosho.org is NXDOMAIN and animetosho.org/feed/json answers
// "Feed disabled" — the live host is feed.animetosho.xyz. That migration is why the host
// list is a list and why a sticky choice is remembered: a dead host must cost one failed
// request per process, not one per query.
//
// Three normalisation rules the field names make easy to get wrong, each of which fails
// silently rather than loudly:
//   - the release name is `title`/`torrent_name`. `article_title` is the SOURCE SITE
//     ("Nyaa", "nBT"); feeding that to parseName yields garbage with no error.
//   - `link` must be the magnet. dedupeTorrentResults extracts the infohash from `link`,
//     and tosho re-indexes nyaa, so with the magnet a tosho row and the nyaa row for the
//     same release merge for free and keep the higher seeder count. The `link` field in
//     the payload is an animetosho.net PAGE url, which has no infohash in it.
//   - sizes arrive as bytes in `total_size`, not as a display string.
//
// IO: HTTPS GET only. No timers, no files.

const axios = require('axios');

const TOSHO_MIRRORS = ['https://feed.animetosho.xyz'];
const TIMEOUT_MS = 12000;
const MAX_ROWS = 75; // one page; the UI shows 20 and the API caps a page here anyway

class ToshoClient {
  constructor(options = {}) {
    this.hosts = Array.isArray(options.hosts) && options.hosts.length ? options.hosts : TOSHO_MIRRORS;
    this.userAgent = options.userAgent
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    this.sticky = null; // the host that last answered
  }

  async _get(pathAndQuery) {
    const ordered = this.sticky
      ? [this.sticky, ...this.hosts.filter((h) => h !== this.sticky)]
      : this.hosts.slice();
    let lastErr = null;
    for (const host of ordered) {
      try {
        const res = await axios.get(`${host}${pathAndQuery}`, {
          headers: { 'User-Agent': this.userAgent },
          timeout: TIMEOUT_MS,
          maxRedirects: 5,
        });
        if (Array.isArray(res.data)) {
          this.sticky = host;
          return res.data;
        }
        lastErr = new Error('unexpected payload shape');
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  /**
   * @param {object} q
   * @param {number} q.aids  AniDB show id.
   * @param {number|null} [q.eids]  AniDB episode id. Present => the rows are exact.
   * @returns {Promise<object[]>} scraper-shaped results; [] on any failure.
   */
  async search({ aids, eids = null } = {}) {
    if (!aids) return [];
    const qs = eids ? `/json?qx=1&aids=${aids}&eids=${eids}` : `/json?qx=1&aids=${aids}`;
    let rows = [];
    try {
      rows = await this._get(qs);
    } catch (e) {
      return []; // one dead provider must never fail a search
    }
    return rows.slice(0, MAX_ROWS).map((r) => normalizeRow(r, !!eids)).filter(Boolean);
  }
}

// Pure: payload row -> the shape every other source in torrent-scraper.js returns.
function normalizeRow(r, isExact) {
  if (!r) return null;
  const name = r.title || r.torrent_name;
  const magnet = r.magnet_uri;
  if (!name || !magnet) return null;
  return {
    name: String(name),
    seeders: Number(r.seeders) || 0,
    leechers: Number(r.leechers) || 0,
    size: formatBytes(r.total_size),
    sizeBytes: Number(r.total_size) || 0,
    link: magnet,
    source: 'Tosho',
    // Only the eid-filtered query yields this. torrent-scraper.js reads it to skip
    // classification, so it must never be set on a broad-query row.
    ...(isExact ? { idMatched: true } : {}),
  };
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 2 : 0)} ${units[i]}`;
}

function createToshoClient(options) {
  return new ToshoClient(options);
}

module.exports = {
  ToshoClient,
  createToshoClient,
  // exposed for unit tests
  _internals: { normalizeRow, formatBytes, TOSHO_MIRRORS },
};
