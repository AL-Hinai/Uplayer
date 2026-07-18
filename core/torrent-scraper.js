'use strict';

// Finds torrent releases across several public indexers (1337x, YTS, PirateBay, Nyaa,
// SubsPlease), ranks them, and resolves magnet links. Each site has its own scraper and its
// own query plan; searchAllSources fans out and merges. The pure result-wrangling (dedupe,
// size/quality parsing) lives in torrent-filters so this file is only the fetching and
// site-specific HTML parsing.
//
// IO: HTTP to third-party indexers. No timers.

const axios = require('axios');
const cheerio = require('cheerio');
const chalk = require('chalk');
const path = require('path');
const { getEnv } = require('./config');
const { parseName, classify, qualityTier, qualityLabel } = require('./torrent-name-patterns');
const {
  dedupeTorrentResults, filterByPreferredQuality, parseSizeToBytes, parseUploadDate,
  x1337QueryPlan, x1337Normalize, X1337_MIRRORS, YTS_MIRRORS,
} = require('./torrent-filters');

// Scraper class for finding torrent links
class TorrentScraper {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    // Per-site memory of the mirror that last answered, keyed by site name.
    this.mirrors = {};
  }

  // Fetch `path` from the first mirror in `hosts` that answers, remembering it
  // so the rest of the process skips the dead ones.
  async fetchMirrored(site, hosts, path) {
    const sticky = this.mirrors[site];
    const ordered = sticky ? [sticky, ...hosts.filter((h) => h !== sticky)] : hosts;

    let lastError;
    for (const mirror of ordered) {
      try {
        const response = await axios.get(`${mirror}${path}`, {
          headers: { 'User-Agent': this.userAgent },
          timeout: 10000
        });
        this.mirrors[site] = mirror;
        return { mirror, data: response.data };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`no ${site} mirror reachable`);
  }

  fetch1337x(path) {
    return this.fetchMirrored('1337x', X1337_MIRRORS, path);
  }

  fetchYTS(path) {
    return this.fetchMirrored('yts', YTS_MIRRORS, path);
  }

  async search(query) {
    const results = [];
    
    // Try multiple sources
    const sources = [
      () => this.search1337x(query),
      () => this.searchYTS(query),
      () => this.searchPirateBay(query),
      () => this.searchNyaa(query)
    ];

    for (const source of sources) {
      try {
        const sourceResults = await source();
        if (sourceResults && sourceResults.length > 0) {
          results.push(...sourceResults);
        }
    } catch (error) {
        // Continue to next source if one fails
        continue;
      }
      }

      return results;
  }

  /**
   * Search every torrent source and return scored, filtered results.
   *
   * Modern signature:
   *   searchAllSources(query, { season, episode, isAnime, absoluteEpisode })
   * Legacy positional signature (kept for old callers):
   *   searchAllSources(query, year, season, episode)
   *
   * Strategy (data-driven, see scripts/data/torrent-naming-report.md):
   * 1. Build provider-specific queries — `Title S##E##` for live-action
   *    sources (PirateBay/1337x have ~91% SE_PAIR results), and an extra
   *    `Title {absoluteEp}` for anime sources (Nyaa/SubsPlease) so we hit
   *    the absolute-numbering anime releases like `[SubsPlease] One Piece - 1163`.
   * 2. Use the shared classifier in core/torrent-name-patterns.js to decide
   *    whether each result actually matches the requested S/E. The same
   *    rules drive the corpus survey, the regression test, and this filter.
   * 3. Hard-drop wrong-season results (unless the anime absolute path
   *    redeems them) instead of the old `seeders > 200` catch-all that
   *    let live-action S02 packs through for anime S23 queries.
   */
  async searchAllSources(query, ...rest) {
    // ---- Argument parsing (modern + legacy) ---------------------------------
    let season = null;
    let episode = null;
    let isAnime = false;
    let absoluteEpisode = null;
    let onPartial = null;
    let altTitles = [];

    if (rest.length === 1 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      const opts = rest[0];
      season = opts.season != null ? Number(opts.season) : null;
      episode = opts.episode != null ? Number(opts.episode) : null;
      isAnime = !!opts.isAnime;
      absoluteEpisode = opts.absoluteEpisode != null ? Number(opts.absoluteEpisode) : null;
      onPartial = typeof opts.onPartial === 'function' ? opts.onPartial : null;
      if (Array.isArray(opts.altTitles)) altTitles = opts.altTitles;
    } else {
      // legacy: (query, year, season, episode)
      season = rest[1] != null ? Number(rest[1]) : null;
      episode = rest[2] != null ? Number(rest[2]) : null;
    }

    // Backfill from the query string if no S/E was provided explicitly.
    if (season == null || episode == null) {
      const m = String(query).match(/\b[sS](\d{1,3})[\s_]*[eE](\d{1,5})\b/);
      if (m) {
        if (season == null) season = parseInt(m[1], 10);
        if (episode == null) episode = parseInt(m[2], 10);
      }
    }

    // Extract bare show name (strip any S/E or "Season N" suffix from the query).
    const showName = String(query)
      .replace(/\b[sS]\d{1,3}[\s_]*[eE]\d{1,5}\b.*$/, '')
      .replace(/\bSeason\s+\d{1,3}\b.*$/i, '')
      .trim() || String(query);

    const pad2 = (n) => String(n).padStart(2, '0');
    const seTag = season != null && episode != null ? `S${pad2(season)}E${pad2(episode)}` : null;

    // Anime trackers (Nyaa/SubsPlease) index shows by their romaji title, not the
    // English TMDB title (e.g. "Witch Hat Atelier" is listed as "Tongari Boushi no
    // Atelier"). Search every known title variant so we don't miss the show.
    const cleanTitle = (t) => String(t || '')
      .replace(/\b[sS]\d{1,3}[\s_]*[eE]\d{1,5}\b.*$/, '')
      .replace(/\bSeason\s+\d{1,3}\b.*$/i, '')
      .trim();
    const titleVariants = [];
    const seenTitle = new Set();
    for (const t of [showName, ...altTitles]) {
      const c = cleanTitle(t);
      const key = c.toLowerCase();
      if (c && !seenTitle.has(key)) {
        seenTitle.add(key);
        titleVariants.push(c);
      }
    }

    // ---- Provider-specific query plan --------------------------------------
    // Per the corpus survey: PirateBay/1337x respond well to `Title S##E##`,
    // SubsPlease only carries anime and searches by show name (appending an
    // episode number returns nothing), Nyaa needs both S##E## and absolute forms.
    const queriesPerSource = {
      '1337x': seTag ? [`${showName} ${seTag}`] : [showName],
      'YTS': season == null ? [showName] : [],
      'PirateBay': seTag ? [`${showName} ${seTag}`, showName] : [showName],
      'Nyaa': [],
      'SubsPlease': [],
    };

    // Nyaa: formatted-SE and (for anime) absolute-episode queries, across every
    // title variant so romaji-only listings are found.
    for (const t of titleVariants) {
      if (seTag) queriesPerSource.Nyaa.push(`${t} ${seTag}`);
      if (isAnime && absoluteEpisode != null) {
        queriesPerSource.Nyaa.push(`${t} ${absoluteEpisode}`);
      }
    }
    if (queriesPerSource.Nyaa.length === 0) {
      for (const t of titleVariants) queriesPerSource.Nyaa.push(t);
    }

    // SubsPlease: anime-only. Search by show name only (no episode number) — the
    // API returns the show's episodes and scoring picks the right one.
    if (isAnime || season == null) {
      for (const t of titleVariants) queriesPerSource.SubsPlease.push(t);
    }

    // Dedupe queries per source to avoid redundant requests.
    for (const k of Object.keys(queriesPerSource)) {
      queriesPerSource[k] = [...new Set(queriesPerSource[k])];
    }

    const sources = [
      { name: '1337x', fn: (q) => this.search1337x(q) },
      { name: 'YTS', fn: (q) => this.searchYTS(q) },
      { name: 'PirateBay', fn: (q) => this.searchPirateBay(q) },
      { name: 'Nyaa', fn: (q) => this.searchNyaa(q) },
      { name: 'SubsPlease', fn: (q) => this.searchSubsPlease(q) },
    ];

    const totalQueries = Object.values(queriesPerSource).reduce((s, arr) => s + arr.length, 0);
    console.log(
      chalk.cyan(
        `\nSearching ${totalQueries} query/source combinations` +
          (isAnime ? ' (anime: absolute-episode enabled)' : '')
      )
    );

    // Dedupe + classify + score + sort a set of raw results. Pure over its input
    // so it can be re-run on the growing accumulator as each source returns.
    const expected = { season, episode, isAnime, absoluteEpisode };
    // Preferred quality: boosts matching releases, then filters the set down to
    // them (with a fallback when none match). Read per-rank so a live config
    // change (Settings) applies to the next search without a restart.
    const preferredTier = qualityTier(getEnv('PREFERRED_QUALITY', '1080p'));
    const QUALITY_BOOST = 300;

    const rankResults = (rawResults) => {
      const uniqueResults = dedupeTorrentResults(rawResults);
      // Tag every result with its parsed quality so the picker can badge it.
      for (const r of uniqueResults) {
        if (!r.quality) r.quality = qualityLabel(qualityTier(r.name));
      }

      // ---- No S/E filtering needed (movie or freeform query) ---------------
      if (season == null || episode == null) {
        uniqueResults.sort((a, b) => {
          const aq = qualityTier(a.name) === preferredTier && preferredTier > 0 ? QUALITY_BOOST : 0;
          const bq = qualityTier(b.name) === preferredTier && preferredTier > 0 ? QUALITY_BOOST : 0;
          const aScore = (a.seeders || 0) + aq;
          const bScore = (b.seeders || 0) + bq;
          if (bScore !== aScore) return bScore - aScore;
          return String(a.name).localeCompare(String(b.name));
        });
        return filterByPreferredQuality(uniqueResults, preferredTier);
      }

      // ---- Classify and score using the shared rule set --------------------
      const scored = uniqueResults.map((result) => {
        const parsed = parseName(result.name);
        const verdict = classify(parsed, expected);

        let score = result.seeders || 0;
        let exactMatch = false;
        let hasSeason = false;
        let hasEpisode = false;

        if (verdict.exactSEMatch || verdict.longformMatch) {
          score += 2000;
          exactMatch = true;
          hasSeason = true;
          hasEpisode = true;
        } else if (verdict.absoluteMatch) {
          // Anime absolute-episode hit (e.g. `One Piece - 1163`, `EP1163`).
          score += 1500;
          hasEpisode = true;
        } else if (verdict.animeDashMatch) {
          score += 1000;
          hasEpisode = true;
        } else if (verdict.episodeOnlyMatch) {
          // Episode tagged but no season tag, no contradicting season —
          // implicit-season match. Trustworthy per the survey data.
          score += 800;
          hasEpisode = true;
        }

        if (preferredTier > 0 && qualityTier(result.name) === preferredTier) score += QUALITY_BOOST;

        return { ...result, score, exactMatch, hasSeason, hasEpisode, verdict };
      });

      // ---- Filter: only keep real matches; drop wrong-season hard ----------
      const filtered = scored.filter((r) => {
        if (r.verdict.wrongSeason && !r.verdict.absoluteMatch) return false;
        if (r.verdict.hasContradictingSeason && !r.verdict.absoluteMatch) return false;
        return (
          r.verdict.exactSEMatch ||
          r.verdict.longformMatch ||
          r.verdict.absoluteMatch ||
          r.verdict.animeDashMatch ||
          r.verdict.episodeOnlyMatch
        );
      });

      filtered.sort((a, b) => {
        // Pin SubsPlease to the top for anime searches (no seeders to rank on).
        if (isAnime) {
          const aSub = a.source === 'SubsPlease' ? 1 : 0;
          const bSub = b.source === 'SubsPlease' ? 1 : 0;
          if (aSub !== bSub) return bSub - aSub;
        }
        if (b.score !== a.score) return b.score - a.score;
        return (b.seeders || 0) - (a.seeders || 0);
      });

      // Quality narrows the set only after the episode filter above, so it can
      // never trade the right episode for a wrong one at the right resolution.
      return filterByPreferredQuality(filtered, preferredTier);
    };

    // ---- Issue all queries in parallel; rank+emit as each source returns ---
    // Callers can pass opts.onPartial to receive a freshly-ranked snapshot every
    // time a source resolves, so the UI can show results without waiting for all.
    const accumulated = [];
    const tasks = [];
    for (const src of sources) {
      const qs = queriesPerSource[src.name] || [];
      for (const q of qs) {
        tasks.push(
          src.fn(q)
            .catch(() => [])
            .then((res) => {
              if (Array.isArray(res) && res.length) {
                for (const r of res) accumulated.push(r);
              }
              if (onPartial) {
                try { onPartial(rankResults(accumulated)); } catch (e) { /* ignore */ }
              }
            })
        );
      }
    }
    await Promise.all(tasks);

    return rankResults(accumulated);
  }

  // Parse one `sort-search` result page into result objects.
  parse1337xPage(html, mirror) {
    const $ = cheerio.load(html);
    const rows = [];

    $('table.table-list tbody tr').each((i, elem) => {
      const $row = $(elem);
      // The name cell holds a category icon link plus the title link; the
      // title is the one without a class.
      const $title = $row.find('td.name a').not('.icon').last();
      const name = $title.text().trim();
      const href = $title.attr('href');
      const seeders = parseInt($row.find('td.seeds').text().trim(), 10) || 0;
      const leechers = parseInt($row.find('td.leeches').text().trim(), 10) || 0;
      // The size cell also carries a hidden seed count on some mirrors, so take
      // only the leading text node.
      const size = $row.find('td.size').contents().first().text().trim();
      const uploaded = $row.find('td.coll-date').text().trim();

      if (!name || !href || seeders <= 0) return;

      rows.push({
        name,
        seeders,
        leechers,
        size,
        sizeBytes: parseSizeToBytes(size),
        uploaded: parseUploadDate(uploaded),
        link: `${mirror}${href}`,
        source: '1337x'
      });
    });

    return rows;
  }

  async search1337x(query) {
    try {
      const { core, term } = x1337QueryPlan(query);
      if (!term) return [];

      const results = [];

      // `sort-search` ranks by seeders server-side, so scanning a couple of
      // pages and keeping the rows that match every query word yields the best
      // *relevant* torrents rather than the biggest ones.
      for (let page = 1; page <= 3 && results.length < 10; page++) {
        const path = `/sort-search/${encodeURIComponent(term)}/seeders/desc/${page}/`;
        const { mirror, data } = await this.fetch1337x(path);
        const rows = this.parse1337xPage(data, mirror);
        if (rows.length === 0) break;

        for (const row of rows) {
          const name = x1337Normalize(row.name);
          if (core.every((t) => name.includes(t))) results.push(row);
        }
      }

      return results.slice(0, 10);
    } catch (error) {
      return [];
    }
  }

  async searchYTS(query) {
    try {
      const path = `/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&sort_by=seeds&order_by=desc`;
      const { data } = await this.fetchYTS(path);

      const results = [];
      const movies = data?.data?.movies || [];

      for (const movie of movies.slice(0, 10)) {
        for (const torrent of movie.torrents || []) {
          if (!(torrent.seeds > 0)) continue;

          // Prefer a magnet built from the infohash over the .torrent URL: it
          // dedupes against the other sources by hash and streams directly.
          const name = `${movie.title} (${movie.year}) - ${torrent.quality}`;
          const link = torrent.hash
            ? `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(name)}`
            : torrent.url;

          results.push({
            name,
            seeders: torrent.seeds,
            leechers: torrent.peers,
            size: `${(torrent.size_bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
            sizeBytes: torrent.size_bytes || 0,
            link,
            source: 'YTS'
          });
        }
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  async searchPirateBay(query) {
    try {
      // Using proxy or alternative domain
      const searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=200`;
      const response = await axios.get(searchUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 10000
      });

      const results = [];
      const data = Array.isArray(response.data) ? response.data : [];

      for (const item of data.slice(0, 10)) {
        if (item.seeders > 0) {
          const magnet = `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(item.name)}`;
          results.push({
            name: item.name,
            seeders: parseInt(item.seeders) || 0,
            leechers: parseInt(item.leechers) || 0,
            size: `${(item.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
            link: magnet,
            source: 'PirateBay'
          });
        }
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  async searchNyaa(query) {
    try {
      // Search Nyaa.si (for anime)
      const domains = ['https://nyaa.si', 'https://www.nyaa.si'];
      const results = [];

      for (const domain of domains) {
        try {
          const searchUrl = `${domain}/?q=${encodeURIComponent(query)}`;
          const response = await axios.get(searchUrl, {
            headers: { 'User-Agent': this.userAgent },
            timeout: 10000
          });

          const $ = cheerio.load(response.data);

          $('table.torrent-list tbody tr').each((i, elem) => {
            if (i >= 15) return false; // Limit to 15 results

            const $row = $(elem);
            const name = $row.find('td:nth-child(2) a:last-child').text().trim();
            const seeders = parseInt($row.find('td:nth-child(6)').text().trim()) || 0;
            const leechers = parseInt($row.find('td:nth-child(7)').text().trim()) || 0;
            const size = $row.find('td:nth-child(4)').text().trim();
            const magnet = $row.find('td:nth-child(3) a[href^="magnet:"]').attr('href');

            if (name && magnet && seeders >= 0) {
              results.push({
                name,
                seeders,
                leechers,
                size: size || 'Unknown',
                link: magnet,
                source: 'Nyaa'
              });
            }
          });

          if (results.length > 0) {
            break; // Successfully got results from this domain
          }
        } catch (error) {
          continue; // Try next domain
        }
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  async searchSubsPlease(query) {
    try {
      const apiUrl = `https://subsplease.org/api/?f=search&tz=UTC&s=${encodeURIComponent(query)}`;
      const response = await axios.get(apiUrl, {
        headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' },
        timeout: 10000,
      });

      const data = response.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return [];

      const results = [];
      for (const key of Object.keys(data)) {
        const entry = data[key];
        if (!entry || !Array.isArray(entry.downloads)) continue;

        const showName = entry.show || key;
        const episode = entry.episode != null ? String(entry.episode) : '';

        for (const dl of entry.downloads) {
          if (!dl || !dl.magnet) continue;
          const res = dl.res ? `${dl.res}p` : '';
          const name = `[SubsPlease] ${showName}${episode ? ` - ${episode}` : ''}${res ? ` (${res})` : ''}`;
          results.push({
            name,
            // SubsPlease is a trusted anime release source but its API exposes no
            // peer counts — leave them null instead of inventing numbers.
            seeders: null,
            leechers: null,
            size: null,
            link: dl.magnet,
            source: 'SubsPlease',
          });
          // No tight cap: the API returns a show's whole run newest-first, so a low cap
          // would drop OLDER episodes (e.g. a finished show currently at ep 24 would lose
          // ep 14). The caller filters down to the target episode, so return the full
          // catalog (bounded high only as a safety net against a pathological response).
          if (results.length >= 600) break;
        }
        if (results.length >= 600) break;
      }
      return results;
    } catch (error) {
      return [];
    }
  }

  async getMagnetLink(torrentResult) {
    if (torrentResult.link.startsWith('magnet:')) {
      return torrentResult.link;
    }

    // For 1337x, we need to get the actual magnet link
    if (torrentResult.source === '1337x') {
      try {
        // Go back through the mirror list: the one that served the search may
        // have gone away, and the detail page exists on any of them.
        const { pathname } = new URL(torrentResult.link);
        const { data } = await this.fetch1337x(pathname);

        const $ = cheerio.load(data);
        const magnetLink = $('a[href^="magnet:"]').attr('href');

        if (magnetLink) {
          return magnetLink;
        }
      } catch (error) {
        console.error(chalk.red('Error fetching magnet link from 1337x'));
      }
    }

    // For YTS, the link should be direct
    if (torrentResult.source === 'YTS') {
        return torrentResult.link;
    }

    // For Nyaa, PirateBay, and SubsPlease, link should already be a magnet link
    if (torrentResult.source === 'Nyaa' || torrentResult.source === 'PirateBay' || torrentResult.source === 'SubsPlease') {
      return torrentResult.link;
    }

      return torrentResult.link;
  }
}

function createTorrentScraper(...args) {
  return new TorrentScraper(...args);
}

module.exports = { TorrentScraper, createTorrentScraper };
