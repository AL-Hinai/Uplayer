'use strict';

// Searches and downloads subtitles across providers (OpenSubtitles.com, Addic7ed, SubsPlease),
// fanning out and merging. Each provider has its own search+download pair; downloadSubtitle
// dispatches by source. Degrades quietly when a provider is unreachable.
//
// IO: HTTP to subtitle providers, writes downloaded files. No timers.

const axios = require('axios');
const cheerio = require('cheerio');
const chalk = require('chalk');
const http = require('http');
const fs = require('fs');
const OpenSubtitles = require('opensubtitles.com');

// Subtitle Manager - searches and downloads subtitles from multiple sources
// Supports OpenSubtitles.com and Addic7ed
// Credentials should be configured in core/system-config.js (env still supported as fallback).
class SubtitleManager {
  constructor(options = {}) {
    const creds = options.openSubtitles || {};
    this.apiKey = creds.apiKey || process.env.OPENSUBTITLES_API_KEY || '';
    this.username = creds.username || process.env.OPENSUBTITLES_USERNAME || '';
    this.password = creds.password || process.env.OPENSUBTITLES_PASSWORD || '';

    this.client = new OpenSubtitles({
      apikey: this.apiKey,
      useragent: 'TemporaryUserAgent'
    });
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

    if (!this.apiKey || !this.username || !this.password) {
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

  // Search OpenSubtitles with enhanced TMDB metadata
  async searchOpenSubtitles(query, language = 'en', season = null, episode = null, year = null, tmdbId = null, mediaType = null) {
    try {
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

  // Search all subtitle sources (unified method)
  async searchSubtitles(query, language = 'en', season = null, episode = null, year = null, tmdbId = null, mediaType = null) {
    const results = [];
    
    // Build enhanced query with year for other sources (Addic7ed, SubsPlease)
    const enhancedQuery = year ? `${query} ${year}` : query;
    
    // Search all sources in parallel
    // OpenSubtitles gets full TMDB metadata for best results
    // Other sources get enhanced query string
    const [openSubtitlesResults, addic7edResults, subsPleaseResults] = await Promise.all([
      this.searchOpenSubtitles(query, language, season, episode, year, tmdbId, mediaType),
      this.searchAddic7ed(enhancedQuery, language, season, episode),
      this.searchSubsPlease(enhancedQuery, language, season, episode)
    ]);

    results.push(...openSubtitlesResults);
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
  async downloadOpenSubtitles(fileId, outputPath) {
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

        fs.writeFileSync(outputPath, response.data);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Download from Addic7ed
  async downloadAddic7ed(url, outputPath) {
    try {
      const fullUrl = url.startsWith('http') ? url : `https://www.addic7ed.com${url}`;
      const response = await axios.get(fullUrl, {
        headers: this.addic7edHeaders,
        responseType: 'arraybuffer',
        timeout: 15000
      });

      if (response.status === 200) {
        fs.writeFileSync(outputPath, response.data);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Download from SubsPlease
  async downloadSubsPlease(url, outputPath) {
    try {
      const fullUrl = url.startsWith('http') ? url : `https://subsplease.org${url}`;
      const response = await axios.get(fullUrl, {
        headers: this.addic7edHeaders,
        responseType: 'arraybuffer',
        timeout: 15000
      });

      if (response.status === 200) {
        fs.writeFileSync(outputPath, response.data);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Unified download method
  async downloadSubtitle(subtitleId, outputPath, source = 'OpenSubtitles', downloadUrl = null) {
    if (source === 'Addic7ed' || (downloadUrl && downloadUrl.toLowerCase().includes('addic7ed'))) {
      return await this.downloadAddic7ed(downloadUrl || subtitleId, outputPath);
    } else if (source === 'SubsPlease' || (downloadUrl && downloadUrl.toLowerCase().includes('subsplease'))) {
      return await this.downloadSubsPlease(downloadUrl || subtitleId, outputPath);
    } else {
      return await this.downloadOpenSubtitles(subtitleId, outputPath);
    }
  }
}

function createSubtitleManager(...args) {
  return new SubtitleManager(...args);
}

module.exports = { SubtitleManager, createSubtitleManager };
