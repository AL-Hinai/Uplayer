#!/usr/bin/env node

const WebTorrent = require('webtorrent-hybrid').default || require('webtorrent-hybrid');
const axios = require('axios');
const cheerio = require('cheerio');
const { program } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const open = require('open');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const OpenSubtitles = require('opensubtitles.com');
const { loadEnvFileOnce } = require('./core/config');
const { createTmdbClient } = require('./core/tmdb-client');
const { createSharedServices } = require('./core/shared-services');
const { buildAccessibleUrls } = require('./core/network-address');
const { parseName, classify } = require('./core/torrent-name-patterns');

loadEnvFileOnce();

function hiddenChildProcessOptions(options = {}) {
  return {
    shell: false,
    ...options,
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  };
}

function waitForServerReady(server) {
  if (server.listening) {
    return Promise.resolve(server);
  }
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function probeExistingWebServer(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/stream/status',
      timeout: 2000,
    }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Media searcher - searches TMDB using API only (like Elementum/Kodi approach)
class MediaSearcher {
  constructor(options = {}) {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    // Use injected or system-config API key.
    this.tmdb = options.tmdbClient || createTmdbClient(process.env.TMDB_API_KEY);
    
    if (!this.tmdb.hasApiKey()) {
      console.warn(chalk.yellow('TMDB API key not set. Configure TMDB_API_KEY in core/system-config.js.'));
    }
  }
  
  // TMDB API search for movies - clean and simple
  async searchMoviesAPI(query) {
    if (!this.tmdb.hasApiKey()) {
      throw new Error('TMDB API key is required. Configure TMDB_API_KEY in core/system-config.js.');
    }
    
    try {
      const response = await this.tmdb.get('/search/movie', {
        query: query,
        language: 'en-US',
        include_adult: false
      });

      const results = [];
      for (const movie of (response.results || []).slice(0, 10)) {
        results.push({
          id: movie.id,
          title: movie.title,
          year: movie.release_date ? movie.release_date.substring(0, 4) : null,
          type: 'movie',
          displayTitle: `${movie.title}${movie.release_date ? ` (${movie.release_date.substring(0, 4)})` : ''} [Movie]`,
          tmdbId: movie.id.toString(),
          overview: movie.overview || ''
        });
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to search TMDB: ${error.message}`);
    }
  }
  
  // TMDB API search for TV shows - clean and simple
  async searchTVShowsAPI(query) {
    if (!this.tmdb.hasApiKey()) {
      throw new Error('TMDB API key is required. Configure TMDB_API_KEY in core/system-config.js.');
    }
    
    try {
      const response = await this.tmdb.get('/search/tv', {
        query: query,
        language: 'en-US',
        include_adult: false
      });

      const results = [];
      for (const tv of (response.results || []).slice(0, 10)) {
        results.push({
          id: tv.id,
          title: tv.name,
          year: tv.first_air_date ? tv.first_air_date.substring(0, 4) : null,
          type: 'tv',
          displayTitle: `${tv.name}${tv.first_air_date ? ` (${tv.first_air_date.substring(0, 4)})` : ''} [TV Show]`,
          tmdbId: tv.id.toString(),
          overview: tv.overview || ''
        });
      }
      return results;
    } catch (error) {
      throw new Error(`Failed to search TMDB: ${error.message}`);
    }
  }
  
  // Get TV show details with seasons using TMDB API - clean and reliable
  async getTVShowDetailsAPI(tvShowId) {
    if (!this.tmdb.hasApiKey()) {
      throw new Error('TMDB API key is required.');
    }
    
    try {
      const tv = await this.tmdb.get(`/tv/${tvShowId}`, {
        language: 'en-US'
      });
      // The API returns all seasons in the seasons array - this is the most reliable method
      const allSeasons = tv.seasons || [];
      
      return {
        id: tv.id,
        title: tv.name,
        overview: tv.overview || '',
        seasons: allSeasons.map(s => ({
          season_number: s.season_number || 0,
          episode_count: s.episode_count || 0,
          name: s.name || `Season ${s.season_number || 0}`
        })),
        number_of_seasons: tv.number_of_seasons || allSeasons.length
      };
    } catch (error) {
      throw new Error(`Failed to get TV show details: ${error.message}`);
    }
  }
  
  // Get season episodes using TMDB API - clean and reliable
  async getSeasonEpisodesAPI(tvShowId, seasonNumber) {
    if (!this.tmdb.hasApiKey()) {
      throw new Error('TMDB API key is required.');
    }
    
    try {
      const season = await this.tmdb.get(`/tv/${tvShowId}/season/${seasonNumber}`, {
        language: 'en-US'
      });

      return (season.episodes || []).map(ep => ({
        episode_number: ep.episode_number || 0,
        name: ep.name || `Episode ${ep.episode_number || 0}`,
        air_date: ep.air_date || '',
        overview: ep.overview || ''
      }));
    } catch (error) {
      throw new Error(`Failed to get season episodes: ${error.message}`);
    }
  }

  // Simple API-only search for movies
  async searchMovies(query) {
    return await this.searchMoviesAPI(query);
  }

  // Simple API-only search for TV shows
  async searchTVShows(query) {
    return await this.searchTVShowsAPI(query);
  }

  // Enhanced scraper method - works without API key (multiple selectors for better results)
  async searchMoviesScraper(query) {
    try {
      // Try multiple search URL formats
      const searchUrls = [
        `https://www.themoviedb.org/search?query=${encodeURIComponent(query)}&type=movie`,
        `https://www.themoviedb.org/search/movie?query=${encodeURIComponent(query)}`
      ];
      
      for (const searchUrl of searchUrls) {
        try {
          const response = await axios.get(searchUrl, {
            headers: { 
              'User-Agent': this.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 15000
          });

          const $ = cheerio.load(response.data);
          const results = [];
          const seenTitles = new Set();

          // Try multiple selectors for different page layouts
          const selectors = [
            '.card',
            '.search_result',
            '.result',
            '[class*="card"]',
            'article',
            '.media',
            'a[href*="/movie/"]'
          ];

          for (const selector of selectors) {
            $(selector).slice(0, 15).each((i, elem) => {
              const $card = $(elem);
              
              // Try multiple title selectors
              const $titleLink = $card.find('h2 a, .title a, a[href*="/movie/"]').first();
              let title = $titleLink.text().trim();
              let href = $titleLink.attr('href');
              
              // If no title, try alternative
              if (!title) {
                title = $card.find('h2, .title, [class*="title"]').first().text().trim();
              }
              
              // Extract year from multiple possible locations
              let year = $card.find('.release_date, .date, [class*="date"], [class*="year"]').text().trim();
              if (year && year.length > 4) {
                year = year.substring(0, 4);
              }
              
              // Extract TMDB ID from href
              let tmdbId = null;
              if (href) {
                const idMatch = href.match(/\/movie\/(\d+)/);
                if (idMatch) {
                  tmdbId = idMatch[1];
                }
              }
              
              // Clean and validate
              if (title && title.length > 0 && !seenTitles.has(title.toLowerCase())) {
                seenTitles.add(title.toLowerCase());
                if (year && (isNaN(year) || year.length !== 4)) {
                  year = null;
                }
                
                results.push({
                  id: tmdbId ? parseInt(tmdbId) : null,
                  title: title,
                  year: year || null,
                  type: 'movie',
                  displayTitle: `${title}${year ? ` (${year})` : ''} [Movie]`,
                  tmdbId: tmdbId
                });
              }
            });
            
            if (results.length > 0) break; // Found results, stop trying other selectors
          }

          if (results.length > 0) {
            return results.slice(0, 10);
          }
        } catch (err) {
          continue; // Try next URL
        }
      }

      return [];
    } catch (error) {
      return [];
    }
  }

  // Enhanced scraper method for TV shows - works without API key
  async searchTVShowsScraper(query) {
    try {
      // Try multiple search URL formats
      const searchUrls = [
        `https://www.themoviedb.org/search?query=${encodeURIComponent(query)}&type=tv`,
        `https://www.themoviedb.org/search/tv?query=${encodeURIComponent(query)}`
      ];
      
      for (const searchUrl of searchUrls) {
        try {
          const response = await axios.get(searchUrl, {
            headers: { 
              'User-Agent': this.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: 15000
          });

          const $ = cheerio.load(response.data);
          const results = [];
          const seenTitles = new Set();

          // Try multiple selectors for different page layouts
          const selectors = [
            '.card',
            '.search_result',
            '.result',
            '[class*="card"]',
            'article',
            '.media',
            'a[href*="/tv/"]'
          ];

          for (const selector of selectors) {
            $(selector).slice(0, 15).each((i, elem) => {
              const $card = $(elem);
              
              // Try multiple title selectors
              const $titleLink = $card.find('h2 a, .title a, a[href*="/tv/"]').first();
              let title = $titleLink.text().trim();
              let href = $titleLink.attr('href');
              
              // If no title from link, try other methods
              if (!title) {
                title = $card.find('h2, .title, [class*="title"]').first().text().trim();
                if (!href) {
                  href = $card.find('a[href*="/tv/"]').first().attr('href');
                }
              }
              
              // Extract year from multiple possible locations
              let year = $card.find('.first_air_date, .release_date, .date, [class*="date"], [class*="year"]').text().trim();
              if (year && year.length > 4) {
                year = year.substring(0, 4);
              }
              
              // Extract TMDB ID from href
              let tmdbId = null;
              if (href) {
                const idMatch = href.match(/\/tv\/(\d+)/);
                if (idMatch) {
                  tmdbId = idMatch[1];
                } else {
                  // Fallback: try to find number in href
                  const parts = href.split('/').filter(p => p && !isNaN(p));
                  if (parts.length > 0) {
                    tmdbId = parts[0];
                  }
                }
              }
              
              // Clean and validate
              if (title && title.length > 0 && !seenTitles.has(title.toLowerCase())) {
                seenTitles.add(title.toLowerCase());
                if (year && (isNaN(year) || year.length !== 4)) {
                  year = null;
                }
                
                results.push({
                  id: tmdbId ? parseInt(tmdbId) : null,
                  title: title,
                  year: year || null,
                  type: 'tv',
                  displayTitle: `${title}${year ? ` (${year})` : ''} [TV Show]`,
                  tmdbId: tmdbId
                });
              }
            });
            
            if (results.length > 0) break; // Found results, stop trying other selectors
          }

          if (results.length > 0) {
            return results.slice(0, 10);
          }
        } catch (err) {
          continue; // Try next URL
        }
      }

      return [];
    } catch (error) {
      return [];
    }
  }

  // Get TV show details including seasons (like Elementum - API first, then scraping)
  async getTVShowSeasons(tmdbId) {
    // Try API first (like Elementum) - this is the best method
    const apiResult = await this.getTVShowDetailsAPI(tmdbId);
    if (apiResult && apiResult.seasons && apiResult.seasons.length > 0) {
      // Filter out season 0 (specials) and sort
      const seasons = apiResult.seasons
        .filter(s => s.season_number > 0)
        .map(s => ({
          number: s.season_number,
          name: s.name,
          displayName: s.name || `Season ${s.season_number}`,
          episode_count: s.episode_count
        }))
        .sort((a, b) => b.number - a.number); // Latest first
      
      if (seasons.length > 0) {
        return seasons;
      }
    }
    
    // Fallback to web scraping - use the /seasons page to get all seasons
    try {
      // First, get the TV show page to find the slug
      const tvUrl = `https://www.themoviedb.org/tv/${tmdbId}`;
      const tvResponse = await axios.get(tvUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 15000
      });
      
      // Extract slug from URL or page
      const $tv = cheerio.load(tvResponse.data);
      let slug = null;
      const canonicalLink = $tv('link[rel="canonical"]').attr('href');
      if (canonicalLink) {
        const slugMatch = canonicalLink.match(/\/tv\/(\d+[^\/]*)/);
        if (slugMatch) {
          slug = slugMatch[1];
        }
      }
      
      // If no slug found, construct it from ID
      if (!slug) {
        slug = tmdbId;
      }
      
      // Now get the seasons page which lists all seasons
      const seasonsUrl = `https://www.themoviedb.org/tv/${slug}/seasons`;
      const response = await axios.get(seasonsUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 15000
      });

      const $ = cheerio.load(response.data);
      const seasons = [];
      const seenSeasons = new Set();

      // Find all season links on the seasons page
      $('a[href*="/season/"]').each((i, elem) => {
        const $link = $(elem);
        const href = $link.attr('href');
        const text = $link.text().trim();
        
        // Extract season number from href (format: /tv/106379-fallout/season/1)
        const seasonMatch = href ? href.match(/\/season\/(\d+)/) : null;
        const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : null;
        
        if (seasonNum !== null && seasonNum > 0 && !seenSeasons.has(seasonNum)) {
          seenSeasons.add(seasonNum);
          seasons.push({
            number: seasonNum,
            name: text || `Season ${seasonNum}`,
            displayName: text || `Season ${seasonNum}`
          });
        }
      });

      // Also look for season cards or items
      $('[class*="season"], [data-season]').each((i, elem) => {
        const $elem = $(elem);
        const href = $elem.find('a').attr('href') || $elem.attr('href');
        const text = $elem.text().trim();
        
        if (href) {
          const seasonMatch = href.match(/\/season\/(\d+)/);
          const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : null;
          
          if (seasonNum !== null && seasonNum > 0 && !seenSeasons.has(seasonNum)) {
            seenSeasons.add(seasonNum);
            const nameMatch = text.match(/season[_\s]?(\d+)/i);
            const displayName = nameMatch ? text : `Season ${seasonNum}`;
            
            seasons.push({
              number: seasonNum,
              name: displayName,
              displayName: displayName
            });
          }
        }
      });

      // Sort by season number (latest first)
      seasons.sort((a, b) => b.number - a.number);
      
      return seasons;
    } catch (error) {
      // If /seasons page fails, try the main TV page as fallback
      try {
        const tvUrl = `https://www.themoviedb.org/tv/${tmdbId}`;
        const response = await axios.get(tvUrl, {
          headers: { 'User-Agent': this.userAgent },
          timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const seasons = [];
        const seenSeasons = new Set();

        $('a[href*="/season/"]').each((i, elem) => {
          const $link = $(elem);
          const href = $link.attr('href');
          const seasonMatch = href ? href.match(/\/season\/(\d+)/) : null;
          const seasonNum = seasonMatch ? parseInt(seasonMatch[1]) : null;
          
          if (seasonNum !== null && seasonNum > 0 && !seenSeasons.has(seasonNum)) {
            seenSeasons.add(seasonNum);
            seasons.push({
              number: seasonNum,
              name: `Season ${seasonNum}`,
              displayName: `Season ${seasonNum}`
            });
          }
        });

        seasons.sort((a, b) => b.number - a.number);
        return seasons;
      } catch (error2) {
        return [];
      }
    }
  }

  // Get episodes for a specific season using API only - clean and simple
  async getSeasonEpisodes(tmdbId, seasonNumber) {
    try {
      const apiEpisodes = await this.getSeasonEpisodesAPI(tmdbId, seasonNumber);
      return apiEpisodes.map(ep => ({
        number: ep.episode_number,
        name: ep.name,
        displayName: `${ep.episode_number}. ${ep.name || `Episode ${ep.episode_number}`}`
      }));
    } catch (error) {
      throw error; // Let the caller handle the error
    }
  }
}

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

// Scraper class for finding torrent links
class TorrentScraper {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
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

    if (rest.length === 1 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      const opts = rest[0];
      season = opts.season != null ? Number(opts.season) : null;
      episode = opts.episode != null ? Number(opts.episode) : null;
      isAnime = !!opts.isAnime;
      absoluteEpisode = opts.absoluteEpisode != null ? Number(opts.absoluteEpisode) : null;
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

    // ---- Provider-specific query plan --------------------------------------
    // Per the corpus survey: PirateBay/1337x respond well to `Title S##E##`,
    // SubsPlease only carries anime and uses `Show - NN` (search by absolute
    // number), Nyaa needs both forms because modern anime use S##E## while
    // long-running shows use absolute numbering.
    const queriesPerSource = {
      '1337x': seTag ? [`${showName} ${seTag}`] : [showName],
      'YTS': season == null ? [showName] : [],
      'PirateBay': seTag ? [`${showName} ${seTag}`, showName] : [showName],
      'Nyaa': [],
      'SubsPlease': [],
    };

    // Nyaa: combine formatted-SE and (for anime) absolute-episode query.
    if (seTag) queriesPerSource.Nyaa.push(`${showName} ${seTag}`);
    if (isAnime && absoluteEpisode != null) {
      queriesPerSource.Nyaa.push(`${showName} ${absoluteEpisode}`);
    }
    if (queriesPerSource.Nyaa.length === 0) queriesPerSource.Nyaa.push(showName);

    // SubsPlease: anime-only. Prefer absolute-episode query (their format).
    if (isAnime && absoluteEpisode != null) {
      queriesPerSource.SubsPlease.push(`${showName} ${absoluteEpisode}`);
    } else if (isAnime || season == null) {
      queriesPerSource.SubsPlease.push(showName);
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

    // ---- Issue all queries in parallel -------------------------------------
    const allPromises = [];
    for (const src of sources) {
      const qs = queriesPerSource[src.name] || [];
      for (const q of qs) {
        allPromises.push(src.fn(q).catch(() => []));
      }
    }
    const settled = await Promise.all(allPromises);
    const flat = [].concat(...settled.filter(Boolean));

    // ---- Dedupe by (name|source) -------------------------------------------
    const seen = new Set();
    const uniqueResults = [];
    for (const r of flat) {
      if (!r || !r.name) continue;
      const key = `${r.name}|${r.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueResults.push(r);
    }

    // ---- No S/E filtering needed (movie or freeform query) -----------------
    if (season == null || episode == null) {
      uniqueResults.sort((a, b) => {
        if ((b.seeders || 0) !== (a.seeders || 0)) return (b.seeders || 0) - (a.seeders || 0);
        return String(a.name).localeCompare(String(b.name));
      });
      return uniqueResults;
    }

    // ---- Classify and score using the shared rule set ----------------------
    const expected = { season, episode, isAnime, absoluteEpisode };
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

      return { ...result, score, exactMatch, hasSeason, hasEpisode, verdict };
    });

    // ---- Filter: only keep real matches; drop wrong-season hard ------------
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
      if (b.score !== a.score) return b.score - a.score;
      return (b.seeders || 0) - (a.seeders || 0);
    });

    return filtered;
  }

  async search1337x(query) {
    try {
      const searchUrl = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
      const response = await axios.get(searchUrl, {
        headers: { 'User-Agent': this.userAgent },
        timeout: 10000
      });

        const $ = cheerio.load(response.data);
        const results = [];

      $('table.table-list tbody tr').each((i, elem) => {
        if (i >= 10) return false; // Limit to 10 results
            
            const $row = $(elem);
        const name = $row.find('td.name a').last().text().trim();
        const seeders = parseInt($row.find('td.seeds').text().trim()) || 0;
        const leechers = parseInt($row.find('td.leeches').text().trim()) || 0;
        const size = $row.find('td.size').text().trim();
        const link = $row.find('td.name a').last().attr('href');

            if (name && link && seeders > 0) {
              results.push({
                name,
                seeders,
                leechers,
            size,
            link: `https://1337x.to${link}`,
                source: '1337x'
              });
            }
          });
          
          return results;
      } catch (error) {
      return [];
      }
  }

  async searchYTS(query) {
      try {
      const searchUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&sort_by=seeds&order_by=desc`;
        const response = await axios.get(searchUrl, {
          headers: { 'User-Agent': this.userAgent },
        timeout: 10000
        });

        const results = [];
        const movies = response.data?.data?.movies || [];

        for (const movie of movies.slice(0, 10)) {
        for (const torrent of movie.torrents || []) {
          if (torrent.seeds > 0) {
              results.push({
              name: `${movie.title} (${movie.year}) - ${torrent.quality}`,
              seeders: torrent.seeds,
              leechers: torrent.peers,
              size: `${(torrent.size_bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
                link: torrent.url,
                source: 'YTS'
              });
            }
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
            seeders: 100,
            leechers: 0,
            size: 'Unknown',
            link: dl.magnet,
            source: 'SubsPlease',
          });
          if (results.length >= 30) break;
        }
        if (results.length >= 30) break;
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
        const response = await axios.get(torrentResult.link, {
          headers: { 'User-Agent': this.userAgent },
          timeout: 10000
        });

        const $ = cheerio.load(response.data);
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

// Memory Tracker - Monitors memory usage and helps identify crash causes
class MemoryTracker {
  constructor(enabled = false) {
    this.enabled = enabled;
    this.snapshots = [];
    this.maxSnapshots = 100;
    this.startTime = Date.now();
    this.startMemory = null;
    this.warningThreshold = 500 * 1024 * 1024; // 500MB warning
    this.criticalThreshold = 800 * 1024 * 1024; // 800MB critical
    this.interval = null;
    
    if (this.enabled) {
      this.startMemory = process.memoryUsage();
      console.log(chalk.cyan('\nMemory tracking enabled'));
      this.logMemory('Initial');
      
      // Start periodic monitoring
      this.interval = setInterval(() => {
        this.checkMemory();
      }, 5000); // Check every 5 seconds
    }
  }
  
  formatBytes(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }
  
  logMemory(label = 'Current') {
    if (!this.enabled) return;
    
    const usage = process.memoryUsage();
    const timestamp = Date.now() - this.startTime;
    
    const snapshot = {
      timestamp,
      label,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      arrayBuffers: usage.arrayBuffers
    };
    
    this.snapshots.push(snapshot);
    
    // Keep only last N snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }
    
    console.log(chalk.blue(`\n[${label}] Memory at ${(timestamp / 1000).toFixed(1)}s:`));
    console.log(chalk.white(`   Heap Used:     ${this.formatBytes(usage.heapUsed)}`));
    console.log(chalk.white(`   Heap Total:    ${this.formatBytes(usage.heapTotal)}`));
    console.log(chalk.white(`   RSS:           ${this.formatBytes(usage.rss)}`));
    console.log(chalk.white(`   External:      ${this.formatBytes(usage.external)}`));
    console.log(chalk.white(`   ArrayBuffers:  ${this.formatBytes(usage.arrayBuffers || 0)}`));
    
    // Calculate delta from start
    if (this.startMemory) {
      const delta = usage.heapUsed - this.startMemory.heapUsed;
      const deltaColor = delta > 0 ? chalk.red : chalk.green;
      console.log(deltaColor(`   Delta:         ${this.formatBytes(Math.abs(delta))} (${delta > 0 ? '+' : '-'})`));
    }
  }
  
  checkMemory() {
    if (!this.enabled) return;
    
    const usage = process.memoryUsage();
    
    // Warning threshold
    if (usage.heapUsed > this.warningThreshold && usage.heapUsed < this.criticalThreshold) {
      console.log(chalk.yellow(`\nMemory warning: ${this.formatBytes(usage.heapUsed)} heap used`));
      this.logMemory('Warning');
    }
    
    // Critical threshold
    if (usage.heapUsed > this.criticalThreshold) {
      console.log(chalk.red(`\nCRITICAL: High memory usage: ${this.formatBytes(usage.heapUsed)}`));
      this.logMemory('Critical');
      
      // Suggest actions
      console.log(chalk.yellow('   Suggestions:'));
      console.log(chalk.yellow('      - Stop and restart the current stream'));
      console.log(chalk.yellow('      - Pick a torrent with fewer/lighter files'));
      console.log(chalk.yellow('      - Close other applications'));
      console.log(chalk.yellow('      - Keep only one active player tab'));
    }
  }
  
  generateReport() {
    if (!this.enabled || this.snapshots.length === 0) return;
    
    console.log(chalk.cyan('\n\n' + '='.repeat(60)));
    console.log(chalk.cyan('MEMORY TRACKING REPORT'));
    console.log(chalk.cyan('='.repeat(60)));
    
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const peak = this.snapshots.reduce((max, s) => s.heapUsed > max.heapUsed ? s : max, first);
    
    console.log(chalk.white('\nSummary:'));
    console.log(chalk.white(`   Duration:      ${(last.timestamp / 1000 / 60).toFixed(1)} minutes`));
    console.log(chalk.white(`   Snapshots:     ${this.snapshots.length}`));
    console.log(chalk.white(`   Start Memory:  ${this.formatBytes(first.heapUsed)}`));
    console.log(chalk.white(`   End Memory:    ${this.formatBytes(last.heapUsed)}`));
    console.log(chalk.white(`   Peak Memory:   ${this.formatBytes(peak.heapUsed)} at ${(peak.timestamp / 1000).toFixed(1)}s`));
    
    const growth = last.heapUsed - first.heapUsed;
    const growthRate = (growth / last.timestamp) * 1000; // bytes per second
    
    if (growth > 0) {
      console.log(chalk.red(`   Memory Growth: +${this.formatBytes(growth)}`));
      console.log(chalk.yellow(`   Growth Rate:   ${this.formatBytes(growthRate)}/sec`));
      
      // Estimate time to crash
      const remainingMemory = this.criticalThreshold - last.heapUsed;
      if (growthRate > 0 && remainingMemory > 0) {
        const timeToFull = remainingMemory / growthRate;
        console.log(chalk.red(`   Est. Crash In: ${(timeToFull / 60).toFixed(1)} minutes (if growth continues)`));
      }
    } else {
      console.log(chalk.green(`   Memory Growth: ${this.formatBytes(growth)} (stable)`));
    }
    
    // Identify potential issues
    console.log(chalk.white('\nPotential Issues:'));
    
    const avgArrayBuffers = this.snapshots.reduce((sum, s) => sum + (s.arrayBuffers || 0), 0) / this.snapshots.length;
    if (avgArrayBuffers > 100 * 1024 * 1024) {
      console.log(chalk.yellow(`   High ArrayBuffer usage (${this.formatBytes(avgArrayBuffers)})`));
      console.log(chalk.yellow('      ? Likely video buffering issue'));
      console.log(chalk.yellow('      ? Restart stream and choose a higher-seeder torrent'));
    }
    
    const avgExternal = this.snapshots.reduce((sum, s) => sum + s.external, 0) / this.snapshots.length;
    if (avgExternal > 200 * 1024 * 1024) {
      console.log(chalk.yellow(`   High external memory (${this.formatBytes(avgExternal)})`));
      console.log(chalk.yellow('      ? Likely WebTorrent buffering'));
      console.log(chalk.yellow('      ? Reduce peer connections'));
    }
    
    if (growth > 100 * 1024 * 1024) {
      console.log(chalk.red(`   Memory leak detected!`));
      console.log(chalk.yellow('      ? Memory growing over time'));
      console.log(chalk.yellow('      ? Check browser developer console for errors'));
    }
    
    // Save to file
    const reportPath = path.join(require('os').tmpdir(), `stream-memory-report-${Date.now()}.json`);
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        summary: {
          duration: last.timestamp,
          snapshots: this.snapshots.length,
          startMemory: first.heapUsed,
          endMemory: last.heapUsed,
          peakMemory: peak.heapUsed,
          growth,
          growthRate
        },
        snapshots: this.snapshots
      }, null, 2));
      console.log(chalk.green(`\nReport saved: ${reportPath}`));
    } catch (err) {
      console.log(chalk.red(`\n? Could not save report: ${err.message}`));
    }
    
    console.log(chalk.cyan('\n' + '='.repeat(60) + '\n'));
  }
  
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    
    if (this.enabled) {
      this.logMemory('Final');
      this.generateReport();
    }
  }
}

// Stream manager
class StreamManager extends EventEmitter {
  constructor(lowMemoryMode = false, memoryTracker = null) {
    super();
    // Create WebTorrent client with NO LIMITS for maximum speed
    // All artificial restrictions removed to allow full download speed
    
    this.client = new WebTorrent({
      maxConns: 100,             // INCREASED: Allow up to 100 peer connections for maximum speed
      downloadLimit: -1,         // No download limit (unlimited)
      uploadLimit: -1,           // No upload limit (unlimited) - helps with peer exchange
      dht: true,                 // Enable DHT
      tracker: true,             // Enable trackers
      utp: true,                 // Enable uTP
      webSeeds: true,            // Enable web seeds
    });
    
    this.lowMemoryMode = lowMemoryMode;
    this.memoryTracker = memoryTracker;
    this.activeStreams = new Set(); // Track active streams for cleanup
    this.streamBufferSize = 2 * 1024 * 1024; // 2MB buffer (increased from 256-512KB)
    this.maxConcurrentStreams = 10; // Allow more concurrent streams
    this.server = null;
    this.currentTorrent = null;
    
    // SECURITY: Use STRICT sandboxed temp directory with complete isolation
    const SandboxManager = require('./sandbox.js');
    this.sandbox = new SandboxManager({
      useTmpfs: true,           // Use RAM-based storage (Linux)
      useIsolated: true,        // Use isolated directory
      maxSize: '5G',            // Limit to 5GB max
      maxAge: 3600000,          // Clean files older than 1 hour
      autoCleanup: true,        // Auto cleanup on exit
      strictIsolation: true,    // STRICT: No execute, no escape
      noExec: true,             // Prevent execution of any files
      readOnlyForOthers: true   // Only owner can access
    });
    this.tempDir = this.sandbox.createSandbox();
    this.sandbox.startAutoCleanup();
    this.sandbox.setupCleanupHandlers();
    
    const sandboxInfo = this.sandbox.getInfo();
    console.log(chalk.cyan(`STRICT Isolation: ${sandboxInfo.type} (${sandboxInfo.sizeLimit} limit)`));
    console.log(chalk.cyan(`   ? No file execution allowed`));
    console.log(chalk.cyan(`   ? No path escape allowed`));
    console.log(chalk.cyan(`   ? Stream-only access`));
    
    this.subtitlePath = null;
    this.subtitlePaths = []; // Array of all available subtitles with metadata
    this.cleanupInterval = null; // Periodic cleanup timer
    this._cancelPendingStream = null; // Abort in-flight stream setup during teardown
    this._transcodedPath = null; // Path to background-transcoded temp MP4 file
    this._transcodeProc = null;  // ffmpeg child process for background transcoding
    this._bestEncoder = null;    // Cached best encoder result
    
    // ENHANCED: Start periodic memory cleanup in low-memory mode
    if (lowMemoryMode) {
      console.log(chalk.yellow('? Low-memory mode enabled (with maximum speed settings)'));
      console.log(chalk.yellow('   - Max connections: 100 (unlimited)'));
      console.log(chalk.yellow('   - Upload limit: Unlimited'));
      console.log(chalk.yellow('   - Download limit: Unlimited'));
      console.log(chalk.yellow('   - Stream buffer: ' + (this.streamBufferSize / 1024 / 1024) + 'MB'));
      console.log(chalk.yellow('   - Periodic cleanup: Every 2 minutes'));
      
      // Schedule periodic cleanup every 2 minutes
      this.cleanupInterval = setInterval(() => {
        const activeCount = this.activeStreams.size;
        if (activeCount > 0) {
          console.log(chalk.cyan(`Periodic cleanup (${activeCount} active streams)...`));
          this.cleanup();
        }
      }, 120000); // Every 2 minutes
    }
    
    // Cache ffmpeg/ffprobe paths
    this.ffmpegPath = this.findFFmpegBinary('ffmpeg');
    this.ffprobePath = this.findFFmpegBinary('ffprobe');
  }

  // Emit a log line to EventEmitter listeners AND write to stdout (CLI behaviour preserved)
  _log(text) {
    if (this.listenerCount('line') > 0) {
      // In server/in-process mode: emit structured event, suppress stdout
      const lines = String(text).split('\n');
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) this.emit('line', { text: trimmed });
      }
    } else {
      // In CLI mode: write directly to stdout as before
      process.stdout.write(String(text));
    }
  }

  findFFmpegBinary(binaryName = 'ffmpeg') {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    const lookupCommands = [];
    if (process.platform === 'win32') {
      lookupCommands.push(['where', [`${binaryName}.exe`]]);
      lookupCommands.push(['where', [binaryName]]);
    }
    lookupCommands.push(['which', [binaryName]]);

    for (const [cmd, args] of lookupCommands) {
      try {
        const result = spawnSync(cmd, args, hiddenChildProcessOptions({ encoding: 'utf8' }));
        if (result.status === 0 && result.stdout) {
          const firstMatch = result.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);
          if (firstMatch) {
            return firstMatch;
          }
        }
      } catch (e) {
        // Ignore and try next lookup strategy
      }
    }

    // Windows fallback: detect common install locations directly (winget/choco/scoop)
    if (process.platform === 'win32') {
      const exeName = `${binaryName}.exe`;
      const candidates = [];

      if (process.env.LOCALAPPDATA) {
        const linksPath = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exeName);
        candidates.push(linksPath);

        const wingetPackagesDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
        if (fs.existsSync(wingetPackagesDir)) {
          try {
            const packageDirs = fs.readdirSync(wingetPackagesDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && d.name.toLowerCase().startsWith('gyan.ffmpeg'))
              .map(d => path.join(wingetPackagesDir, d.name));

            for (const packageDir of packageDirs) {
              try {
                const builds = fs.readdirSync(packageDir, { withFileTypes: true })
                  .filter(d => d.isDirectory())
                  .map(d => path.join(packageDir, d.name, 'bin', exeName));
                candidates.push(...builds);
              } catch (e) {
                // Ignore unreadable package variant
              }
            }
          } catch (e) {
            // Ignore unreadable winget package directory
          }
        }
      }

      if (process.env.ProgramData) {
        candidates.push(path.join(process.env.ProgramData, 'chocolatey', 'bin', exeName));
      }

      if (process.env.USERPROFILE) {
        candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', exeName));
      }

      const foundCandidate = candidates.find(candidate => fs.existsSync(candidate));
      if (foundCandidate) {
        return foundCandidate;
      }
    }

    // Fallback: if executable name itself is callable in PATH
    try {
      const directRun = spawnSync(binaryName, ['-version'], hiddenChildProcessOptions({ stdio: 'ignore' }));
      if (directRun.status === 0) {
        return binaryName;
      }
    } catch (e) {
      // Not callable
    }

    return null;
  }
  
  // Convert SRT subtitle format to WebVTT format
  convertSRTtoVTT(srtContent) {
    if (srtContent.trim().startsWith('WEBVTT')) {
      return srtContent;
    }
    
    let vtt = 'WEBVTT\n\n';
    const lines = srtContent.split(/\r?\n/);
    let i = 0;
    
    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === '') {
        i++;
      }
      if (i >= lines.length) break;
      
      const seqLine = lines[i].trim();
      if (/^\d+$/.test(seqLine)) {
        i++;
      }
      
      if (i < lines.length && lines[i].includes('-->')) {
        let timecode = lines[i].trim();
        timecode = timecode.replace(/,/g, '.');
        vtt += timecode + '\n';
        i++;
      }
      
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      
      if (textLines.length > 0) {
        vtt += textLines.join('\n') + '\n\n';
      }
    }
    
    return vtt;
  }

  // Extract embedded subtitles from video file during streaming (works with partially downloaded files)
  async extractEmbeddedSubtitlesStreaming(videoFile, torrent) {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      
      if (!this.ffmpegPath || !this.ffprobePath) {
        resolve([]);
        return;
      }

      let checkAttempts = 0;
      const maxAttempts = 60;
      
      const tryExtraction = () => {
        checkAttempts++;
        
        const minSize = 10 * 1024 * 1024;
        const downloaded = torrent.downloaded || 0;
        const availableSize = Math.min(downloaded, videoFile.length);
        
        if (availableSize < minSize) {
          if (checkAttempts < maxAttempts) {
            setTimeout(tryExtraction, 500);
            return;
          }
        }
        
        const sampleSize = Math.min(availableSize, 50 * 1024 * 1024);
        const samplePath = path.join(this.tempDir, `sample_${Date.now()}.tmp`);
        const sampleStream = videoFile.createReadStream({ start: 0, end: sampleSize });
        const writeStream = fs.createWriteStream(samplePath);
        
        sampleStream.on('error', () => {
          if (checkAttempts < maxAttempts) {
            setTimeout(tryExtraction, 1000);
            return;
          }
          resolve([]);
        });
        
        sampleStream.pipe(writeStream);
        
        writeStream.on('finish', () => {
          const ffprobe = spawn(this.ffprobePath, [
            '-v', 'error',
            '-select_streams', 's',
            '-show_entries', 'stream=index:stream_tags=language,title',
            '-of', 'json',
            samplePath
          ], hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));

          let probeOutput = '';
          ffprobe.stdout.on('data', (data) => {
            probeOutput += data.toString();
          });

          ffprobe.on('close', (code) => {
            try {
              if (fs.existsSync(samplePath)) {
                fs.unlinkSync(samplePath);
              }
            } catch (e) {}
            
            if (code !== 0 || !probeOutput) {
              resolve([]);
              return;
            }

            try {
              const probeData = JSON.parse(probeOutput);
              const subtitleStreams = probeData.streams || [];
              
              if (subtitleStreams.length === 0) {
                resolve([]);
                return;
              }

              console.log(chalk.cyan(`\nFound ${subtitleStreams.length} embedded subtitle track(s) - extracting during download...`));
              
              // Create placeholder entries immediately so they appear in HTML
              subtitleStreams.forEach((stream, index) => {
                const trackIndex = stream.index;
                const language = stream.tags?.language || 'unknown';
                const title = stream.tags?.title || `Subtitle ${index + 1}`;
                const outputPath = path.join(this.tempDir, `subtitle_${trackIndex}_${Date.now()}.vtt`);
                
                const placeholderInfo = {
                  path: outputPath,
                  source: 'embedded',
                  language: language,
                  label: `${title} (${language})`,
                  codec: 'webvtt',
                  trackIndex: trackIndex,
                  isPlaceholder: true
                };
                
                const exists = this.subtitlePaths.some(s => s.trackIndex === trackIndex && s.source === 'embedded');
                if (!exists) {
                  this.subtitlePaths.push(placeholderInfo);
                  if (!this.subtitlePath) {
                    this.subtitlePath = outputPath;
                  }
                  console.log(chalk.gray(`   Reserved slot for: ${placeholderInfo.label} (will be available during streaming)`));
                }
              });
              
              // Extract each subtitle track
              const extractionPromises = subtitleStreams.map((stream, index) => {
                return new Promise((resolveTrack) => {
                  const trackIndex = stream.index;
                  const language = stream.tags?.language || 'unknown';
                  const title = stream.tags?.title || `Subtitle ${index + 1}`;
                  const outputPath = path.join(this.tempDir, `subtitle_${trackIndex}_${Date.now()}.vtt`);
                  
                  let subtitleInfo = null;
                  let extractionStarted = false;
                  
                  const attemptExtraction = () => {
                    if (extractionStarted) return;
                    extractionStarted = true;
                    
                    const ffmpeg = spawn(this.ffmpegPath, [
                      '-i', 'pipe:0',
                      '-map', `0:s:${index}`,
                      '-c:s', 'webvtt',
                      outputPath,
                      '-y',
                      '-loglevel', 'error',
                      '-fflags', '+genpts'
                    ], hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));

                    const videoStream = videoFile.createReadStream();
                    videoStream.pipe(ffmpeg.stdin);

                    let checkCount = 0;
                    let messageLogged = false;
                    const checkInterval = setInterval(() => {
                      checkCount++;
                      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        const existingEntry = this.subtitlePaths.find(s => 
                          s.trackIndex === trackIndex && s.source === 'embedded' && s.isPlaceholder
                        );
                        
                        if (existingEntry && !messageLogged) {
                          existingEntry.path = outputPath;
                          existingEntry.isPlaceholder = false;
                          subtitleInfo = existingEntry;
                          messageLogged = true;
                          // Don't log here - wait for ffmpeg to complete for final message
                          clearInterval(checkInterval);
                          resolveTrack(subtitleInfo);
                        }
                      }
                      
                      if (checkCount > 30 || torrent.progress === 1) {
                        clearInterval(checkInterval);
                      }
                    }, 1000);

                    ffmpeg.on('close', (code) => {
                      clearInterval(checkInterval);
                      
                      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        if (!subtitleInfo) {
                          const existingEntry = this.subtitlePaths.find(s => 
                            s.trackIndex === trackIndex && s.source === 'embedded' && s.isPlaceholder
                          );
                          
                          if (existingEntry) {
                            existingEntry.path = outputPath;
                            existingEntry.isPlaceholder = false;
                            subtitleInfo = existingEntry;
                            // Don't log individual extractions - they'll be shown in batch at the end
                          }
                          resolveTrack(subtitleInfo);
                        } else {
                          // Already resolved
                          resolveTrack(subtitleInfo);
                        }
                      } else {
                        resolveTrack(null);
                      }
                    });

                    ffmpeg.on('error', () => {
                      clearInterval(checkInterval);
                      extractionStarted = false;
                      if (!subtitleInfo && torrent.progress < 0.95) {
                        setTimeout(attemptExtraction, 5000);
                      } else {
                        resolveTrack(null);
                      }
                    });

                    videoStream.on('error', () => {
                      clearInterval(checkInterval);
                      extractionStarted = false;
                      ffmpeg.kill();
                      if (!subtitleInfo && torrent.progress < 0.95) {
                        setTimeout(attemptExtraction, 5000);
                      } else {
                        resolveTrack(null);
                      }
                    });
                  };
                  
                  setTimeout(attemptExtraction, 2000);
                });
              });

              Promise.all(extractionPromises).then((results) => {
                const extracted = results.filter(r => r !== null);
                if (extracted.length > 0) {
                  // Print all extracted subtitles in one batch to avoid interleaving with download progress
                  process.stdout.write('\r\x1b[K'); // Clear any progress line
                  console.log(chalk.green(`\n? Successfully extracted ${extracted.length} subtitle track(s):`));
                  extracted.forEach(sub => {
                    if (sub && sub.label) {
                      console.log(chalk.green(`   ? ${sub.label}`));
                    }
                  });
                  console.log(chalk.cyan('   Subtitles are available during streaming\n'));
                }
                resolve(extracted);
              });
            } catch (err) {
              resolve([]);
            }
          });

          ffprobe.on('error', () => {
            try {
              if (fs.existsSync(samplePath)) {
                fs.unlinkSync(samplePath);
              }
            } catch (e) {}
            resolve([]);
          });
        });

        writeStream.on('error', () => {
          try {
            if (fs.existsSync(samplePath)) {
              fs.unlinkSync(samplePath);
            }
          } catch (e) {}
          if (checkAttempts < maxAttempts) {
            setTimeout(tryExtraction, 1000);
          } else {
            resolve([]);
          }
        });
      };
      
      setTimeout(tryExtraction, 1000);
    });
  }

  async stream(magnetLink, options = {}) {
    // Determine if we are running in server/in-process mode (EventEmitter listeners attached)
    const serverMode = this.listenerCount('line') > 0 || this.listenerCount('progress') > 0;

    const log = (text) => {
      if (serverMode) {
        const lines = String(text).split('\n');
        for (const l of lines) { const t = l.trimEnd(); if (t) this.emit('line', { text: t }); }
      } else {
        process.stdout.write(String(text) + (String(text).endsWith('\n') ? '' : '\n'));
      }
    };

    return new Promise((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Stream client is not available'));
        return;
      }

      const client = this.client;
      let settled = false;
      let errorHandler = null;
      let connectionTimeout = null;
      let progressInterval = null;
      let cancelPendingStream = null;

      const clearPendingSetup = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
        if (errorHandler && client && typeof client.removeListener === 'function') {
          client.removeListener('error', errorHandler);
        }
        if (this._cancelPendingStream === cancelPendingStream) {
          this._cancelPendingStream = null;
        }
      };

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearPendingSetup();
        fn(value);
      };

      cancelPendingStream = (message = 'Stream manager destroyed') => {
        finish(reject, new Error(message));
      };

      log('Adding torrent...');

      if (this.memoryTracker) {
        this.memoryTracker.logMemory('Before adding torrent');
      }

      // Set up error handler BEFORE adding torrent
      errorHandler = (err) => {
        log(`? WebTorrent error: ${err.message}`);
        finish(reject, err);
      };
      client.once('error', errorHandler);
      this._cancelPendingStream = cancelPendingStream;

      // Add extra trackers to help find more peers
      const extraTrackers = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://tracker.bittor.pw:1337/announce',
        'udp://tracker.dler.org:6969/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://tracker.skynetcloud.tk:6969/announce',
        'udp://tracker.internetwarriors.net:1337/announce',
        'udp://retracker.lanta-net.ru:2710/announce',
        'udp://exodus.desync.com:6969/announce',
        'udp://tracker.tiny-vps.com:6969/announce',
        'udp://tracker.filemail.com:6969/announce',
        'udp://tracker.leech.ie:1337/announce',
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.btorrent.xyz',
        'wss://tracker.fastcast.nz'
      ];

      // Parse magnet link and add extra trackers
      let enhancedMagnet = magnetLink;
      try {
        const magnetParts = magnetLink.split('&');
        const hasTrailer = magnetParts.some(p => p.startsWith('tr='));
        
        if (!hasTrailer) {
          // No trackers in original magnet, add all extra ones
          extraTrackers.forEach(tracker => {
            enhancedMagnet += `&tr=${encodeURIComponent(tracker)}`;
          });
          log('   Added 15 extra trackers to magnet link');
        } else {
          // Add only web trackers (wss://) to existing magnet
          const webTrackers = extraTrackers.filter(t => t.startsWith('wss://'));
          webTrackers.forEach(tracker => {
            enhancedMagnet += `&tr=${encodeURIComponent(tracker)}`;
          });
          log('   Added 3 web trackers to existing magnet link');
        }
      } catch (e) {
        log('   Warning: Could not enhance magnet link, using original');
      }

      // Add timeout for torrent connection (5 minutes)
      connectionTimeout = setTimeout(() => {
        const peerCount = client.torrents && client.torrents.length > 0 
          ? client.torrents[0].numPeers 
          : 0;
        log(`? Timeout: Could not connect to torrent after 5 minutes`);
        log(`   Peers found: ${peerCount}`);
        log('Try:');
        log('   1. Check your internet connection');
        log('   2. Try a different torrent');
        log('   3. Make sure no other torrent client is running');
        log('   4. Wait longer - some torrents take time to find peers');
        finish(reject, new Error('Torrent connection timeout'));
      }, 300000);

      // Show connection progress with peer count
      log('   Connecting to DHT and trackers to find peers...');
      let connectionTimer = 0;
      progressInterval = setInterval(() => {
        connectionTimer += 5;
        const peerCount = client.torrents && client.torrents.length > 0 
          ? client.torrents[0].numPeers 
          : 0;
        
        if (connectionTimer >= 15 && connectionTimer % 5 === 0) {
          if (connectionTimer === 15) {
            log('Taking longer than expected...');
            log('   This can happen if:');
            log('   - Torrent metadata is being downloaded');
            log('   - DHT/trackers are slow to respond');
            log('   - Network connection issues');
            log('   Please wait - finding peers...');
          }
          log(`   ? Still connecting... (${connectionTimer}s) | Peers: ${peerCount}`);
        }
      }, 5000);

      client.add(enhancedMagnet, async (torrent) => {
        clearPendingSetup();
        if (settled) return;

        try {
          this.currentTorrent = torrent;
        
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('After adding torrent');
        }
        
        log(`? Torrent added: ${torrent.name}`);
        log(`Files: ${torrent.files.length}`);
        log(`Peers: ${torrent.numPeers}`);
        
        // CRITICAL: Deselect all files first to prevent memory allocation
        // Analysis shows 138MB ArrayBuffer spike when torrent is added
        torrent.files.forEach(file => file.deselect());
        
        // Find video file
        const videoFile = torrent.files.find(file => {
          const ext = path.extname(file.name).toLowerCase();
          return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'].includes(ext);
        });

        if (!videoFile) {
          finish(reject, new Error('No video file found in torrent'));
          return;
        }
        
        // CRITICAL: Select ONLY the video file to prevent unnecessary memory allocation
        videoFile.select();
        
        // WebTorrent's file.select() already enables sequential downloading
        // and prioritizes pieces needed for streaming
        log('Sequential streaming enabled (WebTorrent auto-prioritization)');
        
        // OPTIONAL: In low-memory mode, implement piece cleanup to free memory
        let lastCleanupPiece = 0;
        
        const pieceManagementInterval = setInterval(() => {
          if (!this.currentTorrent) {
            clearInterval(pieceManagementInterval);
            return;
          }
          
          // CLEANUP: Only in low-memory mode, deselect old pieces to free memory
          if (this.lowMemoryMode && videoFile._torrent) {
            const torrent = videoFile._torrent;
            const downloaded = torrent.downloaded;
            const pieceLength = torrent.pieceLength;
            const currentPiece = Math.floor(downloaded / pieceLength);
            
            // Deselect pieces that are far behind current position
            const cleanupThreshold = 200; // Keep 200 pieces (~100-400MB) before cleanup
            if (currentPiece > lastCleanupPiece + cleanupThreshold) {
              // Calculate byte ranges for old pieces
              const startByte = lastCleanupPiece * pieceLength;
              const endByte = (currentPiece - cleanupThreshold) * pieceLength;
              
              if (endByte > startByte) {
                try {
                  // Deselect byte range (this is the correct WebTorrent API)
                  videoFile.deselect(startByte, endByte);
                  lastCleanupPiece = currentPiece - cleanupThreshold;
                  
                  if (this.memoryTracker) {
                    this.memoryTracker.logMemory(`Cleaned up pieces ${lastCleanupPiece} to ${currentPiece - cleanupThreshold}`);
                  }
                } catch (e) {
                  // Ignore cleanup errors
                }
              }
            }
          }
        }, 10000); // Check every 10 seconds (cleanup doesn't need to be frequent)
        
        // Clean up interval when torrent is removed
        torrent.on('close', () => {
          clearInterval(pieceManagementInterval);
        });
        
        log(`Video file: ${videoFile.name}`);
        log(`Size: ${(videoFile.length / 1024 / 1024 / 1024).toFixed(2)} GB`);
        log('Other files deselected to save memory');
        
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('Video file found');
        }
        
        // Extract embedded subtitles as video downloads (streaming extraction)
        if (this.ffmpegPath && this.ffprobePath) {
          log('Extracting embedded subtitles...');
          this.extractEmbeddedSubtitlesStreaming(videoFile, torrent).then(() => {
            if (this.memoryTracker) {
              this.memoryTracker.logMemory('After subtitle extraction');
            }
          }).catch(() => {
            // Ignore extraction errors
          });
        } else {
          log('Embedded subtitle extraction unavailable: ffmpeg/ffprobe not found in PATH');
          log('   Install ffmpeg (with ffprobe) to load subtitles from multisub torrents in browser');
        }

        // Add external subtitle if provided
        if (options.subtitlePath && fs.existsSync(options.subtitlePath)) {
          const subtitleInfo = {
            path: options.subtitlePath,
            source: 'external',
            language: 'en',
            label: 'External Subtitle',
            codec: 'srt'
          };
          this.subtitlePaths.push(subtitleInfo);
          if (!this.subtitlePath) {
            this.subtitlePath = options.subtitlePath;
          }
        }
        
        // Start HTTP server for streaming
        await this.startStreamingServer(videoFile, async (url, urls, videoPath, originalVideoPath, streamMeta = {}) => {
          if (this.memoryTracker) {
            this.memoryTracker.logMemory('Streaming server started');
          }

          const subtitleManifestUrl = `${String(url).replace(/\/$/, '')}/api/subtitles`;
          if (options.subtitlePath && fs.existsSync(options.subtitlePath)) {
            log(`Subtitle available: ${subtitleManifestUrl}`);
            log('   Subtitles are available inside the native JS player track menu');
          } else if (this.ffmpegPath && this.ffprobePath) {
            log(`Subtitle manifest (embedded / streaming): ${subtitleManifestUrl}`);
          }
          log('Streaming server started!');
          log(`Stream URL: ${url}`);
          if (urls && urls.localhost && urls.localhost !== url) {
            log(`Local fallback: ${urls.localhost}`);
          }

          // Build full video URLs
          // videoPath is for web player (may be transcoded for HEVC)
          // originalVideoPath is for VLC (always original format - VLC can play anything)
          const fullVideoUrl = videoPath ? `${url.replace(/\/$/, '')}${videoPath}` : url;
          const fullOriginalVideoUrl = originalVideoPath ? `${url.replace(/\/$/, '')}${originalVideoPath}` : fullVideoUrl;

          // WAIT for torrent to have enough data for smooth playback
          // This prevents VLC from connecting before there's data to stream
          const minPiecesWait = 10; // Wait for at least 10 pieces to be downloaded
          const maxWaitTime = 30000; // Max wait time: 30 seconds
          const checkInterval = 500; // Check every 500ms

          log(`⏳ Waiting for torrent to buffer (${minPiecesWait} pieces minimum)...`);

          const waitForBuffer = new Promise((waitResolve) => {
            const startTime = Date.now();
            
            const checkReady = () => {
              const elapsed = Date.now() - startTime;
              const downloadedPieces = Math.floor(torrent.downloaded / torrent.pieceLength);
              
              if (downloadedPieces >= minPiecesWait) {
                log(`✅ Buffer ready: ${downloadedPieces} pieces downloaded (${(torrent.downloaded / 1024 / 1024).toFixed(1)} MB)`);
                waitResolve();
                return;
              }
              
              if (elapsed >= maxWaitTime) {
                log(`⚠️  Buffer timeout: Only ${downloadedPieces} pieces after ${maxWaitTime/1000}s (proceeding anyway)`);
                waitResolve();
                return;
              }
              
              setTimeout(checkReady, checkInterval);
            };
            
            checkReady();
          });
          
          await waitForBuffer;

          log('Opening native JS player...');
          log('   Press Ctrl+C to stop streaming');

          // Emit structured player_ready event for server mode
          if (serverMode) {
            const playerRoot = String(url || '').replace(/\/?$/, '/');
            // Keep playerUrl as the server root so the web app opens the HTML player, not raw video.
            const playerReadyData = {
              url: playerRoot,
              urls,
              playerUrl: playerRoot,
              vlcUrl: fullOriginalVideoUrl,
              mediaUrl: fullOriginalVideoUrl,
              castUrl: fullVideoUrl,
              subtitleManifestUrl,
              videoFormat: streamMeta.videoFormat || null,
            };
            this.emit('player_ready', playerReadyData);
          }

          // Open in default player (force new tab for better memory management)
          if (options.openPlayer !== false) {
            open(url, { newInstance: true, wait: false }).catch(() => {
              log('Could not auto-open player. Copy the URL above and open it in your browser.');
            });
          }

          finish(resolve, {
            url,
            urls,
            torrent,
            videoFile,
            subtitlePath: options.subtitlePath,
            videoPath,
            originalVideoPath,
            vlcUrl: fullOriginalVideoUrl,
            mediaUrl: fullOriginalVideoUrl,
            castUrl: fullVideoUrl,
            subtitleManifestUrl,
          });
        }, options.subtitlePath);

        // Show download progress with throttling to prevent terminal spam
        let downloadCount = 0;
        let downloadComplete = false;
        let lastProgressUpdate = 0;
        const progressUpdateInterval = 100; // Update progress every 100ms (10 times per second)
        
        torrent.on('download', () => {
          // Stop showing progress updates once download is complete
          if (downloadComplete) return;
          
          downloadCount++;
          
          // Throttle progress updates to prevent excessive terminal redraws
          const now = Date.now();
          if (now - lastProgressUpdate < progressUpdateInterval) {
            return; // Skip this update
          }
          lastProgressUpdate = now;
          
          const progress = (torrent.progress * 100).toFixed(1);
          const downloaded = (torrent.downloaded / 1024 / 1024).toFixed(2);
          const speed = (torrent.downloadSpeed / 1024 / 1024).toFixed(2);
          
          // Log memory every 500 download events (~every 500 MB typically)
          if (this.memoryTracker && downloadCount % 500 === 0) {
            if (!serverMode) process.stdout.write('\r\x1b[K\n');
            this.memoryTracker.logMemory(`Download progress: ${progress}%`);
          }
          
          if (serverMode) {
            // Emit structured progress event for the browser
            this.emit('progress', {
              percent: parseFloat(progress),
              speed: `${speed} MB/s`,
              downloaded: `${downloaded} MB`,
            });
          } else {
            // Always draw progress on same line (clearing previous content)
            process.stdout.write(`\r\x1b[K${chalk.cyan(`Progress: ${progress}% | Downloaded: ${downloaded} MB | Speed: ${speed} MB/s`)}`);
          }
        });

        torrent.on('done', () => {
          downloadComplete = true;
          if (!serverMode) process.stdout.write('\r\x1b[K'); // Clear the progress line
          log('? Download complete!');
          if (this.memoryTracker) {
            this.memoryTracker.logMemory('Download complete');
          }
        });
        } catch (err) {
          finish(reject, err);
        }
      });
    });
  }

  // Probe video codec from webtorrent file (HEVC/H.265 not supported in browsers - needs transcoding)
  async probeVideoCodec(videoFile) {
    const { spawn } = require('child_process');
    if (!this.ffprobePath) return null;
    const sampleSize = Math.min(10 * 1024 * 1024, videoFile.length);
    const samplePath = path.join(this.tempDir, `probe_${Date.now()}.tmp`);
    return new Promise((resolve) => {
      const readStream = videoFile.createReadStream({ start: 0, end: sampleSize - 1 });
      const writeStream = fs.createWriteStream(samplePath);
      readStream.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      writeStream.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      readStream.pipe(writeStream);
      writeStream.on('finish', () => {
        const ffprobe = spawn(this.ffprobePath, [
          '-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name', '-of', 'default=noprint_wrappers=1:nokey=1',
          samplePath
        ], hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));
        let out = '';
        ffprobe.stdout.on('data', (d) => { out += d.toString(); });
        ffprobe.on('close', (code) => {
          try { fs.unlinkSync(samplePath); } catch (e) {}
          resolve(code === 0 && out ? out.trim().toLowerCase() : null);
        });
        ffprobe.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      });
    });
  }

  // Detect the fastest available H.264 encoder by probing ffmpeg with a tiny null test.
  // Priority: NVIDIA NVENC ? Intel QSV ? AMD AMF/VCE ? Apple VideoToolbox ? CPU ultrafast
  async detectBestEncoder() {
    if (this._bestEncoder) return this._bestEncoder;
    if (!this.ffmpegPath) { this._bestEncoder = null; return null; }

    const { spawnSync } = require('child_process');

    // Bitrates tuned for Full HD (1080p): 10M target allows VBR headroom for complex scenes
    const candidates = [
      {
        encoder: 'h264_nvenc',
        extraArgs: ['-preset', 'p4', '-b:v', '10M', '-maxrate', '18M', '-bufsize', '18M'],
        label: 'NVIDIA NVENC (GPU)',
      },
      {
        encoder: 'h264_qsv',
        extraArgs: ['-preset', 'veryfast', '-b:v', '10M'],
        label: 'Intel QuickSync (GPU)',
      },
      {
        encoder: 'h264_amf',
        extraArgs: ['-quality', 'quality', '-b:v', '10M'],
        label: 'AMD AMF (GPU)',
      },
      {
        encoder: 'h264_videotoolbox',
        extraArgs: ['-b:v', '10M'],
        label: 'Apple VideoToolbox (GPU)',
      },
      {
        encoder: 'libx264',
        extraArgs: ['-preset', 'veryfast', '-crf', '20'],
        label: 'CPU ultrafast (libx264)',
      },
    ];

    for (const candidate of candidates) {
      const result = spawnSync(this.ffmpegPath, [
        '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
        '-c:v', candidate.encoder,
        ...candidate.extraArgs,
        '-f', 'null', '-',
      ], hiddenChildProcessOptions({ stdio: 'pipe', timeout: 6000 }));

      if (result.status === 0) {
        this._bestEncoder = candidate;
        console.log(chalk.green(`\n? GPU/HW encoder selected: ${candidate.label}`));
        return candidate;
      }
    }

    this._bestEncoder = null;
    return null;
  }

  // Build ffmpeg video encoding args. Inserts -vf scale (even dimensions) and -pix_fmt yuv420p
  // so GPU encoders (NVENC, QSV, AMF) don't fail with "Error while opening encoder".
  _encoderArgs(enc) {
    const scaleAndPix = [
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt', 'yuv420p',
    ];
    if (!enc) {
      return [...scaleAndPix, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
    }
    return [...scaleAndPix, '-c:v', enc.encoder, ...enc.extraArgs];
  }

  async startStreamingServer(videoFile, callback, subtitlePath = null) {
    const port = 8000;
    const videoExt = path.extname(videoFile.name).toLowerCase();

    // Probe codec - HEVC/H.265 not supported in browsers, transcode to H.264
    let needsTranscode = false;
    const codec = await this.probeVideoCodec(videoFile);

    // Detect best encoder BEFORE creating the server (must happen at async level)
    let selectedEncoder = null;
    if (codec && (codec === 'hevc' || codec === 'h265')) {
      needsTranscode = true;
      if (this.ffmpegPath) {
        selectedEncoder = await this.detectBestEncoder();
        this._log(`HEVC detected - will transcode live via ${selectedEncoder ? selectedEncoder.label : 'CPU ultrafast'}.`);
      } else {
        console.log(chalk.yellow('\nHEVC video - browser may not play it. Install ffmpeg for auto-transcoding.'));
      }
    }

    const serveTranscoded = needsTranscode && this.ffmpegPath;

    if (serveTranscoded) {
      this._log('HEVC will be transcoded live on-the-fly when you open the player.');
    }

    // Web player URL (may be transcoded for HEVC)
    const videoUrl = needsTranscode && this.ffmpegPath ? '/video.mp4' : `/video${videoExt}`;
    // Original file URL for VLC (VLC can play any format, no transcoding needed)
    // Always use the original file extension, even if transcoding is enabled for web
    const originalFileUrl = `/video${videoExt}`;
    const videoName = videoFile.name;
    const contentType = (needsTranscode && this.ffmpegPath) ? 'video/mp4' : (
      { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v' }[videoExt] || 'video/mp4'
    );
    const htmlVideoType = `type="${contentType}"`;

    this.server = http.createServer((req, res) => {
      // Handle root request - serve unified native JS player page
      if (req.url === '/' || req.url === '/index.html') {
        const html = this.getNativePlayerHTML(videoUrl, htmlVideoType, videoName, serveTranscoded);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
        return;
      }

      if (req.url === '/player.css') {
        const css = this.getNativePlayerCSS();
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(css);
        return;
      }

      if (req.url === '/player.js') {
        const js = this.getNativePlayerJS();
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(js);
        return;
      }
      
      // API endpoint to check available subtitles
      if (req.url === '/api/subtitles' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        const subtitleList = this.subtitlePaths.map((sub, index) => {
          let ready = false;
          if (!sub.isPlaceholder && sub.path) {
            try {
              if (fs.existsSync(sub.path)) {
                const st = fs.statSync(sub.path);
                // Placeholder / not-yet-written files must not look "ready" to Cast (empty WEBVTT breaks subs).
                ready = st.size > 24;
              }
            } catch (e) {
              ready = false;
            }
          }
          return {
            index,
            url: `/subtitle_${index}.vtt`,
            language: sub.language || 'en',
            label: sub.label || `Subtitle ${index + 1}`,
            source: sub.source || 'unknown',
            ready,
          };
        });
        res.end(JSON.stringify({ subtitles: subtitleList, count: subtitleList.length }));
        return;
      }
      
      // Serve subtitle files as WebVTT
      const subtitleMatch = req.url.match(/^\/subtitle_(\d+)\.vtt(\?.*)?$/);
      if (subtitleMatch) {
        const subtitleIndex = parseInt(subtitleMatch[1]);
        if (subtitleIndex >= 0 && subtitleIndex < this.subtitlePaths.length) {
          const subPath = this.subtitlePaths[subtitleIndex].path;
          const emptyVtt = 'WEBVTT\n\n';

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
              'Access-Control-Allow-Headers': 'Range',
              'Access-Control-Max-Age': '86400'
            });
            res.end();
            return;
          }

          let subtitleContent = emptyVtt;
          try {
            if (fs.existsSync(subPath)) {
              subtitleContent = fs.readFileSync(subPath, 'utf8');
            }
          } catch (err) {
            subtitleContent = emptyVtt;
          }

          const isSRT = subPath.toLowerCase().endsWith('.srt') ||
                       (!subPath.toLowerCase().endsWith('.vtt') &&
                        !subtitleContent.trim().startsWith('WEBVTT'));
          if (isSRT) {
            subtitleContent = this.convertSRTtoVTT(subtitleContent);
          }

          const vttBuffer = Buffer.from(subtitleContent, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Content-Length': vttBuffer.length,
            'Accept-Ranges': 'none',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Expose-Headers': 'Content-Length',
            'Cache-Control': 'no-cache'
          });

          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(vttBuffer);
          }
          return;
        }
        res.writeHead(404, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain'
        });
        res.end('');
        return;
      }

      const videoPathMatch = req.url.match(/^\/video\.(\w+)(\?.*)?$/);
      if (!videoPathMatch) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('');
        return;
      }

      // Extract requested video extension
      const requestedExt = videoPathMatch[1].toLowerCase();

      const forceCompatTranscode = /\bcompat=1\b/.test(req.url || '');
      const isTranscodedRequest = requestedExt === 'mp4' && videoExt !== '.mp4';

      // Chromecast receivers send User-Agent containing CrKey; they need Content-Range on the first
      // byte fetch so they know the full size. A plain 200 with a short body looks like the whole file
      // and MP4/Matroska may not have headers in the first 10MB (playback never starts).
      const chromecastReceiverLike = /\bCrKey\b/i.test(String(req.headers['user-agent'] || ''));

      if (req.method === 'HEAD') {
        if ((serveTranscoded && isTranscodedRequest || forceCompatTranscode) && this.ffmpegPath) {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*',
          });
        } else {
          res.writeHead(200, {
            'Content-Length': videoFile.length,
            'Accept-Ranges': 'bytes',
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          });
        }
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405, {
          'Content-Type': 'text/plain',
          'Allow': 'GET, HEAD',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('');
        return;
      }

      // Handle range requests for video streaming (or transcoding for HEVC)
      const range = req.headers.range;

      let stream;

      const destroyStream = () => {
        if (!stream) return;
        this.activeStreams.delete(stream);
        if (typeof stream.kill === 'function') stream.kill();
        else if (!stream.destroyed) stream.destroy();
        stream = null;
      };

      // ENHANCED: Handle client disconnect with stream cleanup
      res.on('close', () => {
        destroyStream();
        // Trigger garbage collection hint if available (V8 specific)
        if (global.gc && this.lowMemoryMode) {
          setImmediate(() => {
            try {
              global.gc();
            } catch (e) {
              // GC not exposed, ignore
            }
          });
        }
      });

      // Handle response errors
      res.on('error', (err) => {
        destroyStream();
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error('Response error:', err.message);
        }
      });

      // HEVC live on-the-fly transcoding: pipe torrent stream → ffmpeg → HTTP (chunked)
      // Only transcode when:
      // 1. serveTranscoded is true (HEVC detected)
      // 2. Requested URL is /video.mp4 (transcoded format)
      // 3. ffmpeg is available
      if ((serveTranscoded && isTranscodedRequest || forceCompatTranscode) && this.ffmpegPath) {
          const { spawn } = require('child_process');
          const videoArgs = this._encoderArgs(selectedEncoder);
          const inputStream = videoFile.createReadStream();

          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Access-Control-Allow-Origin': '*',
            'Transfer-Encoding': 'chunked',
          });

          const ffmpeg = spawn(this.ffmpegPath, [
            '-i', 'pipe:0',
            ...videoArgs,
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
            '-f', 'mp4', 'pipe:1',
          ], hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));

          stream = ffmpeg;
          this.activeStreams.add(ffmpeg);
          inputStream.pipe(ffmpeg.stdin);
          ffmpeg.stdout.pipe(res);

          ffmpeg.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line.includes('fps=') || line.includes('speed=')) {
              this._log(`Live transcode: ${line.replace(/\s+/g, ' ')}`);
            }
          });
          ffmpeg.on('close', () => { destroyStream(); });
          inputStream.on('error', () => { ffmpeg.kill(); destroyStream(); });
          res.on('close', () => { inputStream.destroy(); ffmpeg.kill(); });
          return;
        }

      // Without Range: use 200 + Content-Length matching the body (first chunk only).
      // Browsers/VLC expect 200 for a plain GET; 206 without a client Range breaks many stacks.
      // Chromecast still gets an honest length (no "wait for full file" hang).
      // With Range: 206 + Content-Range (standard partial content).
      const maxChunkSize = 10 * 1024 * 1024; // 10MB chunks for fast streaming
      let start;
      let end;
      let usePartialContent = false;
      if (!range) {
        start = 0;
        const firstByteCap = chromecastReceiverLike
          ? Math.min(32 * 1024 * 1024, videoFile.length)
          : maxChunkSize;
        end = Math.min(firstByteCap - 1, videoFile.length - 1);
        usePartialContent = chromecastReceiverLike;
      } else {
        const positions = range.replace(/bytes=/, '').split('-');
        start = parseInt(positions[0], 10);
        const requestedEnd = positions[1]
          ? parseInt(positions[1], 10)
          : Math.min(start + maxChunkSize - 1, videoFile.length - 1);
        end = Math.min(requestedEnd, videoFile.length - 1);
        usePartialContent = true;
      }
      if (
        !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end < 0 || start > end || start >= videoFile.length
      ) {
        res.writeHead(416, {
          'Content-Range': `bytes */${videoFile.length}`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end();
        return;
      }
      end = Math.min(end, videoFile.length - 1);
      const chunksize = (end - start) + 1;

      if (usePartialContent) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${videoFile.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        });
      } else {
        res.writeHead(200, {
          'Content-Length': chunksize,
          'Accept-Ranges': 'bytes',
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        });
      }

      stream = videoFile.createReadStream({
        start,
        end,
        highWaterMark: 5 * 1024 * 1024,
      });

      this.activeStreams.add(stream);

      stream.on('error', (err) => {
        if (!res.destroyed) {
          destroyStream();
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.error('Stream error:', err.message);
          }
        }
      });

      stream.on('data', (chunk) => {
        if (!res.write(chunk)) {
          stream.pause();
        }
      });

      res.on('drain', () => {
        stream.resume();
      });

      stream.on('end', () => {
        res.end();
      });
    });

    const urls = buildAccessibleUrls(port);
    this.server.listen(port, urls.bindHost, () => {
      // Pass the video path so the caller can construct the full video URL
      // videoUrl is for web player (may be transcoded), originalFileUrl is for VLC (always original format)
      callback(urls.preferred, urls, videoUrl, originalFileUrl, {
        videoFormat: {
          container: (videoExt || '').replace(/^\./, '') || 'unknown',
          codec: codec || null,
        },
      });
    });
  }
  
  getNativePlayerCSS() {
    try {
      return fs.readFileSync(path.join(__dirname, 'public', 'player', 'native-player.css'), 'utf8');
    } catch (e) {
      return 'body{margin:0;background:#000;color:#fff;font-family:Arial,sans-serif;}';
    }
  }

  getNativePlayerJS() {
    try {
      return fs.readFileSync(path.join(__dirname, 'public', 'player', 'native-player.js'), 'utf8');
    } catch (e) {
      return 'console.error("Native player script not found");';
    }
  }

  getNativePlayerHTML(videoUrl, htmlVideoType, videoName, transcoding = false) {
    const esc = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const normalizedTracks = this.subtitlePaths.map((sub, index) => {
      const language = (sub.language || 'en').toString().trim().toLowerCase() || 'en';
      return {
        index,
        language,
        label: sub.label || `Subtitle ${index + 1}`,
        source: sub.source || 'unknown',
      };
    });

    const trackTags = normalizedTracks.map((track, index) => {
      return `<track kind="subtitles" src="/subtitle_${track.index}.vtt" srclang="${esc(track.language)}" label="${esc(track.label)}" ${index === 0 ? 'default' : ''}>`;
    }).join('\n');

    const compatFallbackUrl = this.ffmpegPath && videoUrl !== '/video.mp4'
      ? '/video.mp4?compat=1'
      : null;

    const config = JSON.stringify({
      transcoding: !!transcoding,
      compatFallbackUrl,
      subtitleCount: normalizedTracks.length,
      subtitleTracks: normalizedTracks,
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(videoName)}</title>
  <link rel="stylesheet" href="/player.css">
</head>
<body>
  <div class="player-shell">
    <div class="video-wrap">
      <video id="videoPlayer" controls preload="metadata" playsinline>
        <source src="${esc(videoUrl)}" ${htmlVideoType}>
        ${trackTags}
      </video>
      <div id="subtitleOverlay" class="subtitle-overlay" aria-live="polite" aria-atomic="true"></div>
      <button id="subtitleAdjustBtn" class="subtitle-adjust-btn" type="button" title="Adjust subtitle timing" ${normalizedTracks.length > 0 ? '' : 'hidden'}>
        Sub Sync
      </button>
      <div id="subtitleAdjustPopup" class="subtitle-adjust-popup" hidden>
        <button class="close-btn" id="closePopupBtn" type="button" aria-label="Close subtitle timing controls">x</button>
        <h3>Subtitle Timing</h3>
        <p class="sync-hint">Positive values delay subtitles. Negative values show them earlier.</p>
        <div class="offset-display">
          <div class="label">Offset</div>
          <div class="value" id="offsetValue">+0.00s</div>
        </div>
        <div class="adjust-controls">
          <button class="btn adjust-btn" id="subtract1Btn" type="button">-1.0s</button>
          <button class="btn adjust-btn" id="subtract0_5Btn" type="button">-0.5s</button>
          <button class="btn adjust-btn" id="add0_5Btn" type="button">+0.5s</button>
          <button class="btn adjust-btn" id="add1Btn" type="button">+1.0s</button>
        </div>
        <div class="adjust-controls">
          <button class="btn adjust-btn" id="subtract0_1Btn" type="button">-0.1s</button>
          <button class="btn adjust-btn" id="resetBtn" type="button">Reset</button>
          <button class="btn adjust-btn" id="add0_1Btn" type="button">+0.1s</button>
        </div>
        <div class="subtitle-preview" id="subtitlePreview">
          <div class="subtitle-empty">Load video to inspect subtitle timing.</div>
        </div>
      </div>
      <div id="errorOverlay" class="error-overlay">
        <div class="error-card">
          <h2>Playback issue</h2>
          <p id="errorMessage">The media could not be played in the current format.</p>
          <div class="actions">
            <button class="btn" id="retryBtn" type="button">Retry</button>
            <button class="btn" id="reloadBtn" type="button">Reload</button>
          </div>
        </div>
      </div>
    </div>
    <div class="toolbar">
      <div class="meta">
        <h1>${esc(videoName)}</h1>
        <p id="statusText">${transcoding ? 'Transcoding in progress...' : 'Loading stream...'}</p>
      </div>
      <div class="controls">
        <select id="subtitleSelect" class="select">
          <option value="-1">Subtitles: Off</option>
        </select>
      </div>
    </div>
  </div>
  <script>window.__UPLAYER_PLAYER_CONFIG__ = ${config};</script>
  <script src="/player.js"></script>
</body>
</html>`;
  }
  getHTMLPlayer(videoUrl, htmlVideoType, videoName, transcoding = false) {
    return this.getNativePlayerHTML(videoUrl, htmlVideoType, videoName, transcoding);
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.currentTorrent) {
      this.client.remove(this.currentTorrent);
      this.currentTorrent = null;
    }
  }

  // ENHANCED: Cleanup method to free memory
  cleanup() {
    // Don't destroy active streams, just trigger GC
    // Active streams will be cleaned up when they finish naturally
    
    // Trigger garbage collection if available
    if (global.gc) {
      try {
        global.gc();
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('After cleanup');
        }
      } catch (e) {
        // GC not exposed, run with --expose-gc flag
      }
    }
  }

  async destroy() {
    // Stop periodic cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this._cancelPendingStream) {
      try {
        this._cancelPendingStream();
      } catch (e) {
        // Ignore pending setup cancellation failures during teardown
      }
      this._cancelPendingStream = null;
    }
    
    // Clean up all active streams
    this.activeStreams.forEach(stream => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    });
    this.activeStreams.clear();
    
    if (this.server) {
      try {
        await new Promise((resolve) => this.server.close(() => resolve()));
      } catch (e) {
        // Ignore close failures during teardown
      }
      this.server = null;
    }

    if (this.currentTorrent && this.client) {
      try {
        this.client.remove(this.currentTorrent);
      } catch (e) {
        // Ignore torrent removal failures during teardown
      }
      this.currentTorrent = null;
    }

    if (this.client) {
      try {
        await new Promise((resolve) => this.client.destroy(() => resolve()));
      } catch (e) {
        // Ignore client destroy failures during teardown
      }
      this.client = null;
    }
    
    // SECURITY: Clean up sandbox
    if (this.sandbox) {
      try {
        this.sandbox.cleanup();
      } catch (e) {
        // Ignore sandbox cleanup failures during teardown
      }
    }

    this.emit('exit', { code: 0 });
  }
}

// Main CLI interface
async function main() {
  const sandboxModule = require('./sandbox.js');

  program
    .name('uplayer')
    .description('Uplayer - Simple torrent player. Search and play movies instantly')
    .version('1.0.0');

  // Clean command: remove cached torrent chunks and temp files (fixes dark screen / stale data)
  program
    .command('clean')
    .description('Remove cached WebTorrent chunks and temp files (run when video shows dark screen or stale playback)')
    .action(() => {
      let count = sandboxModule.cleanAllStreamingTemp();
      // Also clean project .temp folder (subtitle downloads)
      const tempDir = path.join(__dirname, '.temp');
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          count++;
        } catch (e) { /* ignore */ }
      }
      console.log(chalk.green(`? Cleaned ${count} temp/cache location(s). Restart UPlayer and try again.`));
    });

  program
    .command('web')
    .description('Start the Uplayer web interface')
    .option('-p, --port <port>', 'Port to run the web interface on')
    .action(async (options) => {
      const requestedPort = options.port ? Number(options.port) : Number(process.env.PORT || 3000);
      const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 3000;
      const { startServer, stopServer, getServerUrl } = require('./server');

      let server;
      try {
        server = startServer(port);
        await waitForServerReady(server);
      } catch (error) {
        if (error && error.code === 'EADDRINUSE') {
          const alreadyRunning = await probeExistingWebServer(port);
          if (alreadyRunning) {
            const existingUrl = buildAccessibleUrls(port).preferred;
            console.log(chalk.yellow(`Uplayer web is already running at ${existingUrl}`));
            await open(existingUrl, { newInstance: true, wait: false }).catch(() => {});
            return;
          }
        }
        throw error;
      }

      const webUrl = typeof getServerUrl === 'function' ? getServerUrl() : buildAccessibleUrls(port).preferred;
      console.log(chalk.green(`Web interface ready at ${webUrl}`));
      await open(webUrl, { newInstance: true, wait: false }).catch(() => {});

      let shuttingDown = false;
      const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (signal) {
          console.log(chalk.yellow(`\nStopping web server (${signal})...`));
        }
        try {
          await stopServer();
        } catch (err) {
          // Ignore shutdown errors and exit cleanly.
        }
        process.exit(0);
      };

      process.on('SIGINT', () => { shutdown('SIGINT'); });
      process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    });

  program
    .argument('[query]', 'Movie name to search and stream')
    .option('-m, --magnet <link>', 'Direct magnet link to stream')
    .option('-t, --torrent <file>', 'Torrent file path')
    .option('--no-open', 'Do not auto-open player')
    .option('--no-subtitles', 'Deprecated no-op (single runtime mode always handles subtitles automatically)')
    .option('--low-memory', 'Deprecated no-op (single runtime mode always uses the default setup)')
    .option('--debug-memory', 'Enable detailed memory tracking and diagnostics (helps identify crash causes)')
    .option('--expose-gc', 'Enable garbage collection (run with: node --expose-gc stream.js)')
    .action(async (query, options) => {
      const debugMemory = options.debugMemory === true;
      const deprecatedFlags = [];
      if (options.lowMemory === true) deprecatedFlags.push('--low-memory');
      if (options.subtitles === false) deprecatedFlags.push('--no-subtitles');
      if (deprecatedFlags.length > 0) {
        console.log(
          chalk.yellow(
            `${deprecatedFlags.join(', ')} ${deprecatedFlags.length > 1 ? 'are' : 'is'} deprecated and now treated as no-op.`
          )
        );
      }

      const services = createSharedServices({
        constructors: {
          TorrentScraper,
          StreamManager,
          MediaSearcher,
          SubtitleManager,
        },
      });
      for (const warning of services.runtime.warnings) {
        console.warn(chalk.yellow(`${warning}`));
      }
      
      // Initialize memory tracker if requested
      const memoryTracker = new MemoryTracker(debugMemory);
      
      const streamManager = services.createStreamManager({ memoryTracker });
      const scraper = services.createTorrentScraper();
      const mediaSearcher = services.createMediaSearcher();

      // Cleanup function to ensure proper resource cleanup
      const cleanup = async (exitCode = 0) => {
        try {
          // Clear the progress line first to prevent terminal clutter
          process.stdout.write('\r\x1b[K');
          console.log(chalk.yellow('\nStopping stream...'));
          if (memoryTracker) {
            memoryTracker.stop();
          }
          if (streamManager) {
            await streamManager.destroy();
          }
        } catch (err) {
          // Ignore cleanup errors
        }
        process.exit(exitCode);
      };

      // Handle cleanup on all exit scenarios
      process.on('SIGINT', () => { cleanup(0); });
      process.on('SIGTERM', () => { cleanup(0); });
      process.on('exit', () => {
        // Synchronous cleanup only
        try {
          if (streamManager && streamManager.client) {
            streamManager.client.destroy();
          }
        } catch (err) {
          // Ignore
        }
      });

      try {
        let magnetLink = null;
        let selectedResult = null;  // Declare at higher scope

        // If direct magnet or torrent file provided
        if (options.magnet) {
          magnetLink = options.magnet;
        } else if (options.torrent) {
          const torrentPath = path.resolve(options.torrent);
          if (!fs.existsSync(torrentPath)) {
            console.error(chalk.red(`Error: Torrent file not found: ${torrentPath}`));
            process.exit(1);
          }
          magnetLink = torrentPath;
        } else {
          // Variables to store season/episode for filtering (declare at higher scope)
          let searchSeason = null;
          let searchEpisode = null;
          
          // Get search query
          let searchQuery = query;
          if (!searchQuery) {
            const answer = await inquirer.prompt([
              {
                type: 'input',
                name: 'query',
                message: 'Enter movie or TV show name:',
                validate: (input) => input.trim().length > 0 || 'Please enter a name'
              }
            ]);
            searchQuery = answer.query;
          }

          // Ask what type of content user is searching for
          const typeAnswer = await inquirer.prompt([
            {
              type: 'list',
              name: 'mediaType',
              message: 'What are you searching for?',
              choices: [
                { name: 'Movie', value: 'movie' },
                { name: 'TV Show', value: 'tv' }
              ]
            }
          ]);
          const mediaType = typeAnswer.mediaType;

          // Search TMDB database using API only
          console.log(chalk.cyan('\n[1/4] Discovering title metadata'));
          console.log(chalk.blue(`Searching TMDB database for: ${searchQuery}...`));
          let tmdbResults = [];
          
          try {
            if (mediaType === 'movie') {
              tmdbResults = await mediaSearcher.searchMovies(searchQuery);
            } else {
              tmdbResults = await mediaSearcher.searchTVShows(searchQuery);
            }
          } catch (error) {
            console.error(chalk.red(`\n? Error searching TMDB: ${error.message}`));
            console.log(chalk.yellow('Falling back to direct torrent search...'));
            tmdbResults = [];
          }

          let selectedMedia = null;
          
          if (tmdbResults.length > 0) {
            // Let user select from TMDB results
            const choices = tmdbResults.map((r, i) => ({
              name: r.displayTitle,
              value: i
            }));

            const mediaAnswer = await inquirer.prompt([
              {
                type: 'list',
                name: 'media',
                message: 'Select from TMDB database:',
                choices: choices,
                pageSize: 10
              }
            ]);

            selectedMedia = tmdbResults[mediaAnswer.media];
            console.log(chalk.green(`\n? Selected: ${selectedMedia.displayTitle}`));
            
            // Use TMDB title for torrent search (without year - only title)
            searchQuery = selectedMedia.title;
            // Don't include year in search query - only title, season/episode filtered after search

            // For TV shows, get seasons and episodes from TMDB (like Elementum)
            if (mediaType === 'tv' && (selectedMedia.tmdbId || selectedMedia.id)) {
              const tvShowId = selectedMedia.tmdbId || selectedMedia.id;
              console.log(chalk.blue(`\nLoading seasons for ${selectedMedia.title}...`));
              let seasons = [];
              try {
                seasons = await mediaSearcher.getTVShowSeasons(tvShowId);
              } catch (error) {
                console.error(chalk.red(`\n? Error loading seasons: ${error.message}`));
              }
              
              if (seasons.length > 0) {
                // Add "Last Season" option at the top
                const seasonChoices = [
                  { name: 'Last Season', value: 'last' },
                  ...seasons.map(s => ({
                    name: s.displayName,
                    value: s.number
                  }))
                ];

                const seasonAnswer = await inquirer.prompt([
                  {
                    type: 'list',
                    name: 'season',
                    message: 'Select a season:',
                    choices: seasonChoices,
                    pageSize: 10
                  }
                ]);

                let selectedSeason = null;
                if (seasonAnswer.season === 'last') {
                  selectedSeason = seasons[0]; // First one is the latest (sorted descending)
                } else {
                  selectedSeason = seasons.find(s => s.number === seasonAnswer.season);
                }

                if (selectedSeason) {
                  const tvShowId = selectedMedia.tmdbId || selectedMedia.id;
                  console.log(chalk.cyan(`\nLoading episodes for ${selectedSeason.displayName}...`));
                  const episodes = await mediaSearcher.getSeasonEpisodes(tvShowId, selectedSeason.number);
                  
                  if (episodes.length > 0) {
                    const episodeChoices = episodes.map(e => ({
                      name: e.displayName,
                      value: e.number
                    }));

                    const episodeAnswer = await inquirer.prompt([
                      {
                        type: 'list',
                        name: 'episode',
                        message: 'Select an episode:',
                        choices: episodeChoices,
                        pageSize: 15
                      }
                    ]);

                    const selectedEpisode = episodes.find(e => e.number === episodeAnswer.episode);
                    if (selectedEpisode) {
                      // Store season/episode separately for filtering - search by show name only
                      searchSeason = selectedSeason.number;
                      searchEpisode = selectedEpisode.number;
                    } else {
                      // If no episodes found, just use season
                      searchSeason = selectedSeason.number;
                      searchEpisode = null;
                    }
                }
              } else {
                // Fallback to manual input if seasons not found
                console.log(chalk.yellow('\nCould not load seasons. Enter manually...'));
                const seasonAnswer = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'season',
                    message: 'Enter season number (or press Enter to skip):',
                    validate: (input) => {
                      if (!input.trim()) return true;
                      const num = parseInt(input);
                      return !isNaN(num) && num > 0 || 'Please enter a valid season number';
                    }
                  }
                ]);

                if (seasonAnswer.season && seasonAnswer.season.trim()) {
                  const episodeAnswer = await inquirer.prompt([
                    {
                      type: 'input',
                      name: 'episode',
                      message: 'Enter episode number (or press Enter to skip):',
                      validate: (input) => {
                        if (!input.trim()) return true;
                        const num = parseInt(input);
                        return !isNaN(num) && num > 0 || 'Please enter a valid episode number';
                      }
                    }
                  ]);

                  const season = seasonAnswer.season.trim();
                  if (episodeAnswer.episode && episodeAnswer.episode.trim()) {
                    const episode = episodeAnswer.episode.trim();
                    // Store season/episode separately for filtering - search by show name only
                    searchSeason = parseInt(season);
                    searchEpisode = parseInt(episode);
                  } else {
                    searchSeason = parseInt(season);
                    searchEpisode = null;
                  }
                }
              }
            } else if (mediaType === 'tv') {
              // Fallback if no TMDB ID
              const seasonAnswer = await inquirer.prompt([
                {
                  type: 'input',
                  name: 'season',
                  message: 'Enter season number (or press Enter to skip):',
                  validate: (input) => {
                    if (!input.trim()) return true;
                    const num = parseInt(input);
                    return !isNaN(num) && num > 0 || 'Please enter a valid season number';
                  }
                }
              ]);

              if (seasonAnswer.season && seasonAnswer.season.trim()) {
                const episodeAnswer = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'episode',
                    message: 'Enter episode number (or press Enter to skip):',
                    validate: (input) => {
                      if (!input.trim()) return true;
                      const num = parseInt(input);
                      return !isNaN(num) && num > 0 || 'Please enter a valid episode number';
                    }
                  }
                ]);

                const season = seasonAnswer.season.trim();
                if (episodeAnswer.episode && episodeAnswer.episode.trim()) {
                  const episode = episodeAnswer.episode.trim();
                  // Store season/episode separately for filtering - search by show name only
                  searchSeason = parseInt(season);
                  searchEpisode = parseInt(episode);
                } else {
                  searchSeason = parseInt(season);
                  searchEpisode = null;
                }
              }
            }
          }
          
          // If no TMDB results, use original search query
          if (tmdbResults.length === 0) {
            console.log(chalk.yellow('\nNo results from TMDB. Using original search query...'));
          }

          // Search for torrents using only the show/movie name (filter by season/episode after)
          console.log(chalk.cyan('\n[2/4] Finding torrents'));
          console.log(chalk.blue(`Searching torrents for: ${searchQuery}...`));
          const results = await scraper.searchAllSources(searchQuery, null, searchSeason, searchEpisode);
            
          if (results.length === 0) {
            console.error(chalk.red('\n? No torrents found. Try a different search term.'));
            process.exit(1);
          }

          // Sort by seeders
          results.sort((a, b) => b.seeders - a.seeders);

          // If only one result, use it; otherwise let user choose
          if (results.length === 1) {
            selectedResult = results[0];
          } else {
            // Show top 10 results
            const choices = results.slice(0, 10).map((r, i) => ({
              name: `${r.name} | ${r.size} | Seeds ${r.seeders} | Source ${r.source}`,
              value: i
            }));

            const answer = await inquirer.prompt([
              {
                type: 'list',
                name: 'torrent',
                message: 'Select a torrent:',
                choices: choices,
                pageSize: 10
              }
            ]);

            selectedResult = results[answer.torrent];
          }

          console.log(chalk.green(`\n? Selected: ${selectedResult.name}`));
          
          // Ask if user wants subtitles
          const subtitleAnswer = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'wantSubtitles',
              message: 'Do you want to search for subtitles?',
              default: true
            }
          ]);

          let subtitlePath = null;
          if (subtitleAnswer.wantSubtitles) {
            // Ask for subtitle language
            const languageAnswer = await inquirer.prompt([
              {
                type: 'list',
                name: 'language',
                message: 'Select subtitle language:',
                choices: [
                  { name: 'English', value: 'en' },
                  { name: 'Arabic', value: 'ar' },
                  { name: 'Spanish', value: 'es' },
                  { name: 'French', value: 'fr' },
                  { name: 'German', value: 'de' },
                  { name: 'Italian', value: 'it' },
                  { name: 'Portuguese', value: 'pt' },
                  { name: 'Russian', value: 'ru' },
                  { name: 'Chinese', value: 'zh' },
                  { name: 'Japanese', value: 'ja' },
                  { name: 'Korean', value: 'ko' }
                ],
                default: 'en'
              }
            ]);

            const selectedLanguage = languageAnswer.language;
            const languageNames = {
              'en': 'English',
              'ar': 'Arabic',
              'es': 'Spanish',
              'fr': 'French',
              'de': 'German',
              'it': 'Italian',
              'pt': 'Portuguese',
              'ru': 'Russian',
              'zh': 'Chinese',
              'ja': 'Japanese',
              'ko': 'Korean'
            };
            
            console.log(chalk.cyan('\n[3/4] Resolving subtitles'));
            console.log(chalk.green(`? Selected language: ${languageNames[selectedLanguage]}`));
            
            const subtitleManager = services.createSubtitleManager();
            
            // Prepare subtitle search query - ALWAYS use TMDB data when available (clean and accurate)
            let subtitleQuery = searchQuery;
            let subtitleYear = null;
            let subtitleTmdbId = null;
            let subtitleMediaType = null;
            let subtitleSeason = null;
            let subtitleEpisode = null;
            
            // Use TMDB data (title + year + ID) for accurate subtitle search
            if (selectedMedia) {
              subtitleQuery = selectedMedia.title;
              subtitleYear = selectedMedia.year;
              subtitleTmdbId = selectedMedia.tmdbId || selectedMedia.id;
              subtitleMediaType = mediaType;
              
              console.log(chalk.cyan(`Using TMDB data for subtitles:`));
              console.log(chalk.cyan(`   Title: ${subtitleQuery}`));
              console.log(chalk.cyan(`   Year: ${subtitleYear || 'N/A'}`));
              console.log(chalk.cyan(`   TMDB ID: ${subtitleTmdbId || 'N/A'}`));
              console.log(chalk.cyan(`   Type: ${subtitleMediaType || 'N/A'}`));
              
              // Use stored season/episode for TV shows
              if (mediaType === 'tv') {
                subtitleSeason = searchSeason;
                subtitleEpisode = searchEpisode;
                console.log(chalk.cyan(`   Season: ${subtitleSeason}, Episode: ${subtitleEpisode}`));
              }
            } else {
              // Fallback: Extract year from torrent name if no TMDB data
              const torrentName = selectedResult.name;
              const yearMatch = torrentName.match(/\((\d{4})\)|\[(\d{4})\]|[\s\.](\d{4})[\s\.]/);
              subtitleYear = yearMatch ? (yearMatch[1] || yearMatch[2] || yearMatch[3]) : null;
              console.log(chalk.cyan(`No TMDB data - using search query: ${subtitleQuery} (${subtitleYear || 'N/A'})`));
            }
            
            // Build display query with year for user feedback
            const displayQuery = subtitleYear ? `${subtitleQuery} (${subtitleYear})` : subtitleQuery;
            if (subtitleSeason && subtitleEpisode) {
              console.log(chalk.blue(`\nSearching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery} S${subtitleSeason.toString().padStart(2, '0')}E${subtitleEpisode.toString().padStart(2, '0')}...`));
            } else {
              console.log(chalk.blue(`\nSearching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery}...`));
            }
            
            const subtitles = await subtitleManager.searchSubtitles(
              subtitleQuery,
              selectedLanguage,
              subtitleSeason,
              subtitleEpisode,
              subtitleYear,      // Pass year
              subtitleTmdbId,    // Pass TMDB ID for precise matching
              subtitleMediaType  // Pass media type (movie/tv)
            );

            if (subtitles.length > 0) {
              const subtitleChoices = subtitles.slice(0, 15).map((s, i) => ({
                name: `${s.title} | ${s.language} | ${s.downloadCount} downloads`,
                value: i
              }));

              subtitleChoices.push({ name: '? Skip subtitles', value: -1 });

              const subtitleSelect = await inquirer.prompt([
                {
                  type: 'list',
                  name: 'subtitle',
                  message: 'Select a subtitle:',
                  choices: subtitleChoices,
                  pageSize: 15
                }
              ]);

              if (subtitleSelect.subtitle !== -1) {
                const selectedSubtitle = subtitles[subtitleSelect.subtitle];
                const tempDir = path.join(__dirname, '.temp');
                if (!fs.existsSync(tempDir)) {
                  fs.mkdirSync(tempDir, { recursive: true });
                }
                subtitlePath = path.join(tempDir, `subtitle_${Date.now()}.srt`);
                
                console.log(chalk.cyan(`Downloading subtitle from ${selectedSubtitle.source}...`));
                const downloaded = await subtitleManager.downloadSubtitle(
                  selectedSubtitle.fileId || selectedSubtitle.id,
                  subtitlePath,
                  selectedSubtitle.source,
                  selectedSubtitle.downloadUrl || selectedSubtitle.attributes?.addic7ed_url || selectedSubtitle.attributes?.subsplease_url
                );
                
                if (downloaded) {
                  console.log(chalk.green(`? Subtitle downloaded: ${subtitlePath}`));
                } else {
                  console.log(chalk.yellow(`Failed to download subtitle`));
                  subtitlePath = null;
                }
              }
            } else {
              console.log(chalk.yellow(`No subtitles found`));
            }
          }
          
          console.log(chalk.cyan('\n[4/4] Starting stream'));
          console.log(chalk.cyan(`Getting magnet link...`));
          magnetLink = await scraper.getMagnetLink(selectedResult);
          
          // Store subtitle path for later use
          if (subtitlePath) {
            selectedResult.subtitlePath = subtitlePath;
          }
        }

        if (!magnetLink) {
          console.error(chalk.red('\n? Could not get magnet link.'));
          cleanup(1);
          return;
        }

        // Start streaming with subtitle if available
        await streamManager.stream(magnetLink, {
          openPlayer: options.open !== false,
          subtitlePath: selectedResult?.subtitlePath || null,
        });
      }
    } catch (error) {
        // Handle user cancellation (Ctrl+C during prompts)
        if (error.isTtyError || error.name === 'ExitPromptError') {
          cleanup(0);
          return;
        }
        const message = String(error && error.message ? error.message : error);
        console.error(chalk.red(`\n? Error: ${message}`));
        if (/timeout|no peers|Could not connect to torrent/i.test(message)) {
          console.log(chalk.yellow('   Hint: pick a torrent with more seeders or retry in a few minutes.'));
        }
        if (/EADDRINUSE|address already in use/i.test(message)) {
          console.log(chalk.yellow('   Hint: stop previous streams or run `uplayer clean`, then retry.'));
        }
        if (/subtitle token/i.test(message)) {
          console.log(chalk.yellow('   Hint: subtitle tokens expire; restart the subtitle step and try again.'));
        }
        cleanup(1);
      }
    });

  program.parse();
}

module.exports = { TorrentScraper, StreamManager, MediaSearcher, SubtitleManager };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}


