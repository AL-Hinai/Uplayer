'use strict';

// Pure helpers for torrent scraper results: dedupe across indexers (same infohash listed
// twice collapses to the higher-seeded copy), size/date parsing, the 1337x query planner and
// its stopword/normalisation tables, and the preferred-quality filter. Extracted from the
// scraper so both it and any future caller share one definition of "same torrent".
//
// Pure: no IO, no timers.

const { qualityTier, extractInfohash } = require('./torrent-name-patterns');

// Dedupe raw scraper results: infohash first (the same torrent listed by two
// indexers collapses to one entry, keeping whichever reports more seeders),
// falling back to name|source for results without a magnet link.
function dedupeTorrentResults(rawResults) {
  const seen = new Set();
  const byHash = new Map(); // infohash -> index into uniqueResults
  const uniqueResults = [];
  for (const r of rawResults) {
    if (!r || !r.name) continue;
    const hash = extractInfohash(r.link);
    if (hash) {
      const existingIdx = byHash.get(hash);
      if (existingIdx != null) {
        if ((r.seeders || 0) > (uniqueResults[existingIdx].seeders || 0)) uniqueResults[existingIdx] = r;
        continue;
      }
      byHash.set(hash, uniqueResults.length);
    } else {
      const key = `${r.name}|${r.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    uniqueResults.push(r);
  }
  return uniqueResults;
}

// 1337x fronts its canonical domains with Cloudflare, which 403s plain HTTP
// clients. These mirrors serve the same markup without the challenge; the first
// one that answers is reused for the rest of the process.
const X1337_MIRRORS = [
  'https://www.1337xx.to',
  'https://1337xx.to',
  'https://1337x.to'
];

// yts.mx stopped resolving (NXDOMAIN), which silently zeroed out the YTS source.
// These serve the same v2 API; the first one that answers is reused.
const YTS_MIRRORS = [
  'https://yts.lt',
  'https://yts.am',
  'https://yts.mx',
  'https://yts.rs'
];

// "1.4 GB" -> 1503238553. Returns 0 when the cell is unparseable.
function parseSizeToBytes(size) {
  const m = /^([\d.]+)\s*([kmgt])?i?b?$/i.exec(String(size).trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return 0;
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.round(n * (m[2] ? mult[m[2].toLowerCase()] : 1));
}

const X1337_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and']);
const X1337_SE_TAG = /^(s\d{1,2}(e\d{1,3})?|e\d{1,3})$/;

function x1337Normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The mirrors OR their search terms and then rank by seeders, so a query like
// `the matrix 1999` leads with whatever huge torrent happens to contain "the".
// Searching the single most distinctive word and re-filtering locally gets us
// the AND semantics the real site would have applied.
function x1337QueryPlan(query) {
  const tokens = x1337Normalize(query).split(' ').filter(Boolean);
  const core = tokens.filter((t) => !X1337_STOPWORDS.has(t) && !X1337_SE_TAG.test(t));
  const term = core.slice().sort((a, b) => b.length - a.length)[0] || tokens[0] || '';
  return { core, term };
}

// "May. 18th '15" or "11:45pm" (uploaded today) -> ISO string, or '' if unknown.
function parseUploadDate(date) {
  const text = String(date).replace(/\s+/g, ' ').trim();

  const abs = /^([A-Za-z]{3})\.? (\d{1,2})(?:st|nd|rd|th) '(\d{2})$/.exec(text);
  if (abs) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mi = months.indexOf(abs[1].toLowerCase());
    if (mi < 0) return '';
    return new Date(Date.UTC(2000 + Number(abs[3]), mi, Number(abs[2]))).toISOString();
  }

  const rel = /^(\d{1,2}):(\d{2}) ?(am|pm)$/i.exec(text);
  if (rel) {
    let hour = Number(rel[1]) % 12;
    if (rel[3].toLowerCase() === 'pm') hour += 12;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(rel[2])).toISOString();
  }

  return '';
}

// Preferred quality is a hard filter: keep only releases in the chosen tier.
// Releases with no resolution tag (tier 0) can't be shown to match, so they're
// dropped too. If nothing matches, the full list comes back unchanged — a
// preference must never leave the user staring at zero results.
function filterByPreferredQuality(results, preferredTier) {
  if (!preferredTier || preferredTier <= 0) return results;
  const matches = results.filter((r) => qualityTier(r.name) === preferredTier);
  return matches.length > 0 ? matches : results;
}

module.exports = {
  dedupeTorrentResults, filterByPreferredQuality, parseSizeToBytes, parseUploadDate,
  x1337QueryPlan, x1337Normalize, X1337_MIRRORS, YTS_MIRRORS, X1337_STOPWORDS, X1337_SE_TAG,
};
