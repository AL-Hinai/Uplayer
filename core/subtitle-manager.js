'use strict';

// Searches and downloads subtitles across providers, fanning out and merging. Each
// provider has its own search+download pair; downloadSubtitle dispatches by source.
// Degrades quietly when a provider is unreachable.
//
// KEYLESS BY DEFAULT. The scraper/open-API providers need no credentials:
//   - YIFY (yifysubtitles.ch)  : movies, looked up by IMDb id (server resolves it
//                                from TMDB), zips extracted via core/zip-extract.
//   - Gestdown                 : TV — a keyless JSON proxy over Addic7ed's data,
//                                far sturdier than scraping addic7ed.com directly.
//   - Addic7ed, SubsPlease     : the original HTML scrapers, kept as extra reach.
// The OpenSubtitles.com API is OPTIONAL: it joins the fan-out only when an API key
// + account are configured, and its absence is silent — not a warning per search.
//
// IO: HTTP to subtitle providers, writes downloaded files. No timers.

const axios = require('axios');
const cheerio = require('cheerio');
const chalk = require('chalk');
const http = require('http');
const fs = require('fs');
const OpenSubtitles = require('opensubtitles.com');
const { extractFirstSubtitle } = require('./zip-extract');
const { decodeSubtitle } = require('./subtitle-encoding');

// ISO code → English language name. Keyless providers label rows by name
// (yify: "Arabic"; gestdown routes by "/…/Arabic"), while the app speaks codes —
// mirror of server.js SUBTITLE_LANGUAGES.
const LANGUAGE_NAMES = {
  en: 'English', ar: 'Arabic', fr: 'French', es: 'Spanish', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese',
};

const YIFY_BASE = 'https://yifysubtitles.ch';
const GESTDOWN_BASE = 'https://api.gestdown.info';

// Subtitle Manager - searches and downloads subtitles from multiple sources
// Supports OpenSubtitles.com and Addic7ed
// Credentials should be configured in core/system-config.js (env still supported as fallback).
class SubtitleManager {
  constructor(options = {}) {
    const creds = options.openSubtitles || {};
    this.apiKey = creds.apiKey || process.env.OPENSUBTITLES_API_KEY || '';
    this.username = creds.username || process.env.OPENSUBTITLES_USERNAME || '';
    this.password = creds.password || process.env.OPENSUBTITLES_PASSWORD || '';

    // Provider base URLs — injectable so tests can point them at a local fake.
    this.yifyBase = options.yifyBase || YIFY_BASE;
    this.gestdownBase = options.gestdownBase || GESTDOWN_BASE;

    // The opensubtitles.com client THROWS on a missing api key, which used to
    // crash the whole manager at construction on keyless installs — the reason
    // subtitle search appeared to "require the API". Built only when configured.
    this.client = null;
    if (this.apiKey) {
      try {
        this.client = new OpenSubtitles({ apikey: this.apiKey, useragent: 'TemporaryUserAgent' });
      } catch (e) {
        this.client = null;
      }
    }
    this.loggedIn = false;
    this.token = null;
    this.userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    this.addic7edHeaders = {
      'User-Agent': this.userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.addic7ed.com/'
    };
  }

  async login() {
    if (this.loggedIn && this.token) {
      return true;
    }

    if (!this.client || !this.apiKey || !this.username || !this.password) {
      console.error(chalk.yellow('OpenSubtitles credentials are missing. Configure credentials in core/system-config.js.'));
      return false;
    }
    
    try {
      await this.client.login({
        username: this.username,
        password: this.password
      });
      this.loggedIn = true;
      return true;
    } catch (error) {
      console.error(chalk.yellow(`OpenSubtitles login error: ${error.message}`));
      return false;
    }
  }

  // True when the OPTIONAL OpenSubtitles.com API is configured. Without it the
  // keyless providers carry the search — no login attempt, no warning spam.
  hasOpenSubtitlesCredentials() {
    return !!(this.client && this.apiKey && this.username && this.password);
  }

  // Search OpenSubtitles with enhanced TMDB metadata
  async searchOpenSubtitles(query, language = 'en', season = null, episode = null, year = null, tmdbId = null, mediaType = null) {
    try {
      if (!this.hasOpenSubtitlesCredentials()) return [];
      const loggedIn = await this.login();
      if (!loggedIn) {
        return [];
      }

      // Build search params using OpenSubtitles API fields
      const searchParams = {
        languages: language
      };

      // Priority 1: Use TMDB ID for most accurate results (if available)
      if (tmdbId && mediaType) {
        if (mediaType === 'movie') {
          searchParams.tmdb_id = parseInt(tmdbId);
          console.log(`   Searching with TMDB Movie ID: ${tmdbId}`);
        } else if (mediaType === 'tv') {
          searchParams.parent_tmdb_id = parseInt(tmdbId);
          console.log(`   Searching with TMDB TV ID: ${tmdbId}`);
        }
      }

      // Priority 2: Use query (title) - always include
      searchParams.query = query;

      // Priority 3: Add year for better filtering
      if (year) {
        searchParams.year = parseInt(year);
        console.log(`   Filtering by year: ${year}`);
      }

      // Priority 4: Add season/episode for TV shows
      if (season !== null) {
        searchParams.season_number = parseInt(season);
        console.log(`   Season: ${season}`);
      }
      if (episode !== null) {
        searchParams.episode_number = parseInt(episode);
        console.log(`   Episode: ${episode}`);
      }

      // Set media type for better filtering
      if (mediaType === 'movie') {
        searchParams.type = 'movie';
      } else if (mediaType === 'tv') {
        searchParams.type = 'episode';
      }

      console.log(`   OpenSubtitles search params:`, JSON.stringify(searchParams, null, 2));

      // Try subtitles() method (the correct method for opensubtitles.com library)
      const results = await this.client.subtitles(searchParams);
      
      if (!results || !results.data) {
        return [];
      }

      return results.data.map(item => ({
        id: item.id,
        title: item.attributes.release || item.attributes.file_name || 'Unknown',
        language: item.attributes.language || language,
        downloadCount: item.attributes.download_count || 0,
        fileId: item.attributes.files?.[0]?.file_id || null,
        source: 'OpenSubtitles',
        attributes: item.attributes
      }));
    } catch (error) {
      console.error(`   OpenSubtitles error: ${error.message}`);
      return [];
    }
  }

  // Search Addic7ed
  async searchAddic7ed(query, language = 'en', season = null, episode = null) {
    try {
      const searchUrl = `https://www.addic7ed.com/search.php?search=${encodeURIComponent(query)}`;
      const response = await axios.get(searchUrl, {
        headers: this.addic7edHeaders,
        timeout: 15000
      });

      const $ = cheerio.load(response.data);
      const results = [];
      const showLinks = [];

      // Find show links
      $('table.tabel95 tbody tr').each((i, row) => {
        const $row = $(row);
        const $link = $row.find('a[href*="/show/"]');
        if ($link.length > 0) {
          const href = $link.attr('href');
          const name = $link.text().trim();
          if (href && name) {
            showLinks.push({
              name: name,
              url: href.startsWith('http') ? href : `https://www.addic7ed.com${href}`
            });
          }
        }
      });

      // If we have season/episode, find specific episode
      if (showLinks.length > 0 && season !== null && episode !== null) {
        const showUrl = showLinks[0].url;
        const showResponse = await axios.get(showUrl, {
          headers: this.addic7edHeaders,
          timeout: 15000
        });

        const $show = cheerio.load(showResponse.data);
        $show('table.tabel95 tbody tr').each((i, row) => {
          const $row = $show(row);
          const cells = $row.find('td');
          
          if (cells.length >= 4) {
            try {
              const rowSeason = parseInt($row.find('td').eq(0).text().trim());
              const rowEpisode = parseInt($row.find('td').eq(1).text().trim());
              const version = $row.find('td').eq(2).text().trim();
              const lang = $row.find('td').eq(3).text().trim();
              const $downloadLink = $row.find('a[href*="/original/"]');
              
              if (rowSeason === season && rowEpisode === episode && $downloadLink.length > 0) {
                const downloadHref = $downloadLink.attr('href');
                if (downloadHref) {
                  const idMatch = downloadHref.match(/\/original\/(\d+)/);
                  results.push({
                    id: idMatch ? idMatch[1] : `addic7ed_${results.length}`,
                    source: 'Addic7ed',
                    title: `${showLinks[0].name} - S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')} - ${version}`,
                    language: lang || 'English',
                    downloadCount: 0,
                    downloadUrl: downloadHref.startsWith('http') ? downloadHref : `https://www.addic7ed.com${downloadHref}`,
                    attributes: {
                      release: `${showLinks[0].name} - S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')} - ${version}`,
                      language: lang || 'English',
                      download_count: 0,
                      addic7ed_url: downloadHref.startsWith('http') ? downloadHref : `https://www.addic7ed.com${downloadHref}`
                    }
                  });
                }
              }
            } catch (e) {
              // Skip invalid rows
            }
          }
        });
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  // Search SubsPlease (for anime)
  async searchSubsPlease(query, language = 'en', season = null, episode = null) {
    try {
      const searchUrl = `https://subsplease.org/?s=${encodeURIComponent(query)}`;
      const response = await axios.get(searchUrl, {
        headers: this.addic7edHeaders,
        timeout: 15000
      });

      const $ = cheerio.load(response.data);
      const results = [];
      const showLinks = [];

      // Find show links
      $('.shows-wrapper .show, .archive-wrapper .show, article').each((i, elem) => {
        const $elem = $(elem);
        const $link = $elem.find('a').first();
        const href = $link.attr('href');
        
        if (href && href.includes('/shows/')) {
          const name = $link.text().trim() || $elem.find('h2, .title').text().trim();
          if (name) {
            showLinks.push({
              name: name,
              url: href.startsWith('http') ? href : `https://subsplease.org${href}`
            });
          }
        }
      });

      // If we have season/episode, find specific episode
      if (showLinks.length > 0 && season !== null && episode !== null) {
        const showUrl = showLinks[0].url;
        const showResponse = await axios.get(showUrl, {
          headers: this.addic7edHeaders,
          timeout: 15000
        });

        const $show = cheerio.load(showResponse.data);
        $show('.episode, .episodes-list li, table tbody tr').each((i, row) => {
          const $row = $show(row);
          const episodeText = $row.text();
          const $downloadLink = $row.find('a[href*=".srt"], a[href*=".ass"], a[href*="download"]');
          
          if ($downloadLink.length > 0) {
            // Try to match season/episode
            const seasonMatch = episodeText.match(/S(\d{1,2})/i);
            const episodeMatch = episodeText.match(/E(\d{1,4})|Episode\s+(\d{1,4})/i);
            
            if (seasonMatch && episodeMatch) {
              const rowSeason = parseInt(seasonMatch[1]);
              const rowEpisode = parseInt(episodeMatch[1] || episodeMatch[2]);
              
              if (rowSeason === season && rowEpisode === episode) {
                const downloadHref = $downloadLink.attr('href');
                if (downloadHref) {
                  results.push({
                    id: `subsplease_${results.length}_${Date.now()}`,
                    source: 'SubsPlease',
                    title: `${showLinks[0].name} - S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`,
                    language: 'English',
                    downloadCount: 0,
                    downloadUrl: downloadHref.startsWith('http') ? downloadHref : `https://subsplease.org${downloadHref}`,
                    attributes: {
                      release: `${showLinks[0].name} - S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`,
                      language: 'English',
                      download_count: 0,
                      subsplease_url: downloadHref.startsWith('http') ? downloadHref : `https://subsplease.org${downloadHref}`
                    }
                  });
                }
              }
            }
          }
        });
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  // Search YIFY (movies, keyless). Addressed by IMDb id, not by name: the movie
  // page at /movie-imdb/<id> is server-rendered while the name search is a JS
  // shell, and an id lookup can't land on the wrong film. Rows are release-named
  // (e.g. "1080p.WEBRip.x264.YIFY"), which is exactly what makes a subtitle's
  // TIMING match: picking the row named like the release being played gives subs
  // cut for that very encode.
  async searchYify(imdbId, language = 'en') {
    if (!imdbId) return [];
    try {
      const wanted = (LANGUAGE_NAMES[language] || 'English').toLowerCase();
      const response = await axios.get(`${this.yifyBase}/movie-imdb/${encodeURIComponent(imdbId)}`, {
        headers: this.addic7edHeaders, timeout: 15000,
      });
      const $ = cheerio.load(response.data);
      const results = [];
      $('tr[data-id]').each((i, row) => {
        const $row = $(row);
        const lang = $row.find('.sub-lang').text().trim();
        if (!lang || lang.toLowerCase() !== wanted) return;
        const href = $row.find('a[href^="/subtitles/"]').attr('href');
        if (!href) return;
        const rating = parseInt($row.find('.rating-cell').text().trim(), 10) || 0;
        const release = $row.find('a[href^="/subtitles/"]').text().replace(/^\s*subtitle\s*/i, '').trim();
        results.push({
          id: 'yify_' + (href.split('-').pop() || i),
          source: 'YIFY',
          title: release || 'YIFY subtitle',
          language: lang,
          downloadCount: rating, // yify's quality signal is the user rating
          // The zip lives at /subtitle/<slug>.zip (singular) and requires the sub
          // page as Referer — downloadYify derives the Referer back from this URL.
          downloadUrl: this.yifyBase + href.replace('/subtitles/', '/subtitle/') + '.zip',
          attributes: { release, language: lang, download_count: rating, rating },
        });
      });
      results.sort((a, b) => (b.attributes.rating || 0) - (a.attributes.rating || 0));
      return results.slice(0, 15);
    } catch (error) {
      return [];
    }
  }

  // Search Gestdown (TV, keyless JSON — a public proxy over Addic7ed's catalogue).
  // Needs season+episode; movies never match here.
  async searchGestdown(query, language = 'en', season = null, episode = null) {
    if (season == null || episode == null) return [];
    try {
      const headers = { Accept: 'application/json', 'User-Agent': this.userAgent };
      const found = await axios.get(`${this.gestdownBase}/shows/search/${encodeURIComponent(query)}`, {
        headers, timeout: 15000,
      });
      const show = found.data && Array.isArray(found.data.shows) ? found.data.shows[0] : null;
      if (!show || !show.id) return [];
      const langName = LANGUAGE_NAMES[language] || 'English';
      const r = await axios.get(
        `${this.gestdownBase}/subtitles/get/${show.id}/${season}/${episode}/${encodeURIComponent(langName)}`,
        { headers, timeout: 15000 }
      );
      const subs = (r.data && r.data.matchingSubtitles) || [];
      const se = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      return subs.map((s, i) => ({
        id: s.subtitleId || `gestdown_${i}`,
        source: 'Gestdown',
        title: `${show.name} - ${se} - ${s.version || 'unknown release'}`,
        language: s.language || langName,
        downloadCount: Number(s.downloadCount) || 0,
        downloadUrl: this.gestdownBase + (s.downloadUri || `/subtitles/download/${s.subtitleId}`),
        attributes: {
          release: s.version || '',
          language: s.language || langName,
          download_count: Number(s.downloadCount) || 0,
          hearing_impaired: s.hearingImpaired === true,
        },
      }));
    } catch (error) {
      return []; // includes gestdown's 404 for episodes it hasn't indexed
    }
  }

  // Search all subtitle sources (unified method)
  async searchSubtitles(query, language = 'en', season = null, episode = null, year = null, tmdbId = null, mediaType = null, imdbId = null) {
    const results = [];

    // Build enhanced query with year for other sources (Addic7ed, SubsPlease)
    const enhancedQuery = year ? `${query} ${year}` : query;

    // Search all sources in parallel. The keyless providers (YIFY by imdb id for
    // movies, Gestdown for TV) always run; the OpenSubtitles API joins only when
    // credentials are configured. Addic7ed/SubsPlease get the enhanced query.
    const [openSubtitlesResults, addic7edResults, subsPleaseResults, yifyResults, gestdownResults] = await Promise.all([
      this.searchOpenSubtitles(query, language, season, episode, year, tmdbId, mediaType),
      this.searchAddic7ed(enhancedQuery, language, season, episode),
      this.searchSubsPlease(enhancedQuery, language, season, episode),
      mediaType === 'tv' ? Promise.resolve([]) : this.searchYify(imdbId, language),
      this.searchGestdown(query, language, season, episode),
    ]);

    results.push(...openSubtitlesResults);
    results.push(...yifyResults);
    results.push(...gestdownResults);
    results.push(...addic7edResults);
    results.push(...subsPleaseResults);

    // Sort by download count
    results.sort((a, b) => {
      const aCount = a.downloadCount || a.attributes?.download_count || 0;
      const bCount = b.downloadCount || b.attributes?.download_count || 0;
      return bCount - aCount;
    });

    return results.slice(0, 25); // Return top 25
  }

  // Download from OpenSubtitles
  async downloadOpenSubtitles(fileId, outputPath, language) {
    try {
      const loggedIn = await this.login();
      if (!loggedIn) {
        return false;
      }

      const download = await this.client.download({
        file_id: fileId
      });

      if (download && download.link) {
        const response = await axios.get(download.link, {
          responseType: 'arraybuffer',
          timeout: 30000
        });

        writeSubtitleFile(outputPath, response.data, language);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Download from Addic7ed
  async downloadAddic7ed(url, outputPath, language) {
    try {
      const fullUrl = url.startsWith('http') ? url : `https://www.addic7ed.com${url}`;
      const response = await axios.get(fullUrl, {
        headers: this.addic7edHeaders,
        responseType: 'arraybuffer',
        timeout: 15000
      });

      if (response.status === 200) {
        writeSubtitleFile(outputPath, response.data, language);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Download from SubsPlease
  async downloadSubsPlease(url, outputPath, language) {
    try {
      const fullUrl = url.startsWith('http') ? url : `https://subsplease.org${url}`;
      const response = await axios.get(fullUrl, {
        headers: this.addic7edHeaders,
        responseType: 'arraybuffer',
        timeout: 15000
      });

      if (response.status === 200) {
        writeSubtitleFile(outputPath, response.data, language);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Download from YIFY: a zip that requires the subtitle PAGE as Referer (403
  // without it). The Referer derives from the zip URL itself, so nothing extra
  // has to survive the round-trip through the UI. The .srt is pulled out of the
  // archive here — callers only ever see a plain subtitle file.
  //
  // YIFY's non-Latin packs are routinely UTF-16LE, which every downstream reader
  // (all of which open the file as utf8) would see as an EMPTY subtitle — so the
  // write goes through writeSubtitleFile like every other provider's.
  async downloadYify(url, outputPath, language) {
    try {
      const referer = String(url).replace('/subtitle/', '/subtitles/').replace(/\.zip$/i, '');
      const response = await axios.get(url, {
        headers: { ...this.addic7edHeaders, Referer: referer },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      const sub = extractFirstSubtitle(Buffer.from(response.data));
      if (!sub) return false;
      writeSubtitleFile(outputPath, sub.data, language);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Download from Gestdown — a direct subtitle file, no archive.
  async downloadGestdown(url, outputPath, language) {
    try {
      const response = await axios.get(url, {
        headers: { 'User-Agent': this.userAgent },
        responseType: 'arraybuffer',
        timeout: 30000,
      });
      if (response.status !== 200 || !response.data || !response.data.byteLength) return false;
      writeSubtitleFile(outputPath, response.data, language);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Unified download method. `language` is only a hint for decoding a legacy-codepage
  // upload (see core/subtitle-encoding.js) — it never affects which file is fetched.
  async downloadSubtitle(subtitleId, outputPath, source = 'OpenSubtitles', downloadUrl = null, language = null) {
    const url = downloadUrl ? String(downloadUrl).toLowerCase() : '';
    if (source === 'YIFY' || url.includes('yifysubtitles')) {
      return await this.downloadYify(downloadUrl || subtitleId, outputPath, language);
    } else if (source === 'Gestdown' || url.includes('gestdown')) {
      return await this.downloadGestdown(downloadUrl || subtitleId, outputPath, language);
    } else if (source === 'Addic7ed' || url.includes('addic7ed')) {
      return await this.downloadAddic7ed(downloadUrl || subtitleId, outputPath, language);
    } else if (source === 'SubsPlease' || url.includes('subsplease')) {
      return await this.downloadSubsPlease(downloadUrl || subtitleId, outputPath, language);
    } else {
      return await this.downloadOpenSubtitles(subtitleId, outputPath, language);
    }
  }
}

// Every download lands here, and it is the ONLY place that sees the provider's raw
// bytes. Downstream — the /subtitle_N.vtt route, alass, the cue-span guard — everything
// does readFileSync(path, 'utf8'), so anything not already UTF-8 has to be converted
// now or it reads as an empty subtitle later. See core/subtitle-encoding.js.
function writeSubtitleFile(outputPath, data, language) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(outputPath, decodeSubtitle(buf, language), 'utf8');
}

function createSubtitleManager(...args) {
  return new SubtitleManager(...args);
}

module.exports = { SubtitleManager, createSubtitleManager };
