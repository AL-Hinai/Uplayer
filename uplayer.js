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
const OpenSubtitles = require('opensubtitles.com');

// Media searcher - searches TMDB using API only (like Elementum/Kodi approach)
class MediaSearcher {
  constructor() {
    this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
    // Use provided API key or environment variable
    this.apiKey = process.env.TMDB_API_KEY || 'aee3a88db6bb9228aec32784ef2dd1c1';
    this.baseUrl = 'https://api.themoviedb.org/3';
    
    if (!this.apiKey) {
      console.warn(chalk.yellow('⚠️  TMDB API key not set. Set TMDB_API_KEY environment variable for best results.'));
    }
  }
  
  // TMDB API search for movies - clean and simple
  async searchMoviesAPI(query) {
    if (!this.apiKey) {
      throw new Error('TMDB API key is required. Please set TMDB_API_KEY environment variable.');
    }
    
    try {
      const url = `${this.baseUrl}/search/movie`;
      const response = await axios.get(url, {
        params: {
          api_key: this.apiKey,
          query: query,
          language: 'en-US',
          include_adult: false
        },
        timeout: 15000
      });

      const results = [];
      for (const movie of (response.data.results || []).slice(0, 10)) {
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
      if (error.response) {
        throw new Error(`TMDB API Error: ${error.response.status} - ${error.response.statusText}`);
      }
      throw new Error(`Failed to search TMDB: ${error.message}`);
    }
  }
  
  // TMDB API search for TV shows - clean and simple
  async searchTVShowsAPI(query) {
    if (!this.apiKey) {
      throw new Error('TMDB API key is required. Please set TMDB_API_KEY environment variable.');
    }
    
    try {
      const url = `${this.baseUrl}/search/tv`;
      const response = await axios.get(url, {
        params: {
          api_key: this.apiKey,
          query: query,
          language: 'en-US',
          include_adult: false
        },
        timeout: 15000
      });

      const results = [];
      for (const tv of (response.data.results || []).slice(0, 10)) {
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
      if (error.response) {
        throw new Error(`TMDB API Error: ${error.response.status} - ${error.response.statusText}`);
      }
      throw new Error(`Failed to search TMDB: ${error.message}`);
    }
  }
  
  // Get TV show details with seasons using TMDB API - clean and reliable
  async getTVShowDetailsAPI(tvShowId) {
    if (!this.apiKey) {
      throw new Error('TMDB API key is required.');
    }
    
    try {
      const url = `${this.baseUrl}/tv/${tvShowId}`;
      const response = await axios.get(url, {
        params: {
          api_key: this.apiKey,
          language: 'en-US'
          // Note: seasons are included by default in the TV details endpoint
        },
        timeout: 15000
      });

      const tv = response.data;
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
      if (error.response) {
        throw new Error(`TMDB API Error: ${error.response.status} - ${error.response.statusText}`);
      }
      throw new Error(`Failed to get TV show details: ${error.message}`);
    }
  }
  
  // Get season episodes using TMDB API - clean and reliable
  async getSeasonEpisodesAPI(tvShowId, seasonNumber) {
    if (!this.apiKey) {
      throw new Error('TMDB API key is required.');
    }
    
    try {
      const url = `${this.baseUrl}/tv/${tvShowId}/season/${seasonNumber}`;
      const response = await axios.get(url, {
        params: {
          api_key: this.apiKey,
          language: 'en-US'
        },
        timeout: 15000
      });

      const season = response.data;
      return (season.episodes || []).map(ep => ({
        episode_number: ep.episode_number || 0,
        name: ep.name || `Episode ${ep.episode_number || 0}`,
        air_date: ep.air_date || '',
        overview: ep.overview || ''
      }));
    } catch (error) {
      if (error.response) {
        throw new Error(`TMDB API Error: ${error.response.status} - ${error.response.statusText}`);
      }
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
// API Key: Set OPENSUBTITLES_API_KEY env var or uses default key below
class SubtitleManager {
  constructor() {
    this.client = new OpenSubtitles({
      apikey: process.env.OPENSUBTITLES_API_KEY || '4bzTWMHnRRVaW4RkftqVjuy9bYEOpsJA', // Default working API key
      useragent: 'TemporaryUserAgent'
    });
    this.username = process.env.OPENSUBTITLES_USERNAME || 'msalim245';
    this.password = process.env.OPENSUBTITLES_PASSWORD || 'al9hinai5';
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
    
    try {
      await this.client.login({
        username: this.username,
        password: this.password
      });
      this.loggedIn = true;
      return true;
    } catch (error) {
      console.error(chalk.yellow(`⚠️  OpenSubtitles login error: ${error.message}`));
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
          console.log(`   🎯 Searching with TMDB Movie ID: ${tmdbId}`);
        } else if (mediaType === 'tv') {
          searchParams.parent_tmdb_id = parseInt(tmdbId);
          console.log(`   🎯 Searching with TMDB TV ID: ${tmdbId}`);
        }
      }

      // Priority 2: Use query (title) - always include
      searchParams.query = query;

      // Priority 3: Add year for better filtering
      if (year) {
        searchParams.year = parseInt(year);
        console.log(`   📅 Filtering by year: ${year}`);
      }

      // Priority 4: Add season/episode for TV shows
      if (season !== null) {
        searchParams.season_number = parseInt(season);
        console.log(`   📺 Season: ${season}`);
      }
      if (episode !== null) {
        searchParams.episode_number = parseInt(episode);
        console.log(`   📺 Episode: ${episode}`);
      }

      // Set media type for better filtering
      if (mediaType === 'movie') {
        searchParams.type = 'movie';
      } else if (mediaType === 'tv') {
        searchParams.type = 'episode';
      }

      console.log(`   🔍 OpenSubtitles search params:`, JSON.stringify(searchParams, null, 2));

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
      console.error(`   ⚠️  OpenSubtitles error: ${error.message}`);
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

  async searchAllSources(query, year = null, season = null, episode = null) {
    // Search by show/movie name only, then filter results by season/episode
    const results = [];
    
    // Extract episode/season info from query if not provided separately
    let episodeMatch = null;
    let seasonMatch = null;
    
    if (season !== null && episode !== null) {
      // Use provided season/episode for filtering
      episodeMatch = { 1: season.toString(), 2: episode.toString() };
    } else {
      // Try to extract from query
      episodeMatch = query.match(/[Ss][_\s]?(\d{1,3})[Ee][_\s]?(\d{1,5})/i);
    }
    
    if (!episodeMatch) {
      if (season !== null) {
        seasonMatch = { 1: season.toString() };
      } else {
        seasonMatch = query.match(/[Ss][_\s]?(\d{1,3})(?![Ee])|Season\s+(\d{1,3})/i);
      }
    }
    
    // Extract show name - remove season/episode info from query
    const showName = query.split(/[Ss][_\s]?\d|Season\s+\d/i)[0].trim();
    
    // Build search queries using only the show/movie name (no season/episode)
    let queries = [];
    
    if (episodeMatch) {
      const season = parseInt(episodeMatch[1]);
      const episode = parseInt(episodeMatch[2]);
      const seasonStr = season.toString().padStart(2, '0');
      const episodeStr = episode.toString();
      
      // For high episode numbers (3+ digits), don't over-pad
      const episodeStrPadded2 = episodeStr.padStart(2, '0');
      const episodeStrPadded3 = episodeStr.padStart(3, '0');
      const episodeStrPadded4 = episodeStr.padStart(4, '0');
      
      // Search by show name only - filtering will happen after getting results
      queries = [
        showName  // Use only show name for search, filter by season/episode later
      ];
    } else if (seasonMatch) {
      // Search by show name only - filtering will happen after getting results
      queries = [
        showName  // Use only show name for search, filter by season later
      ];
    } else {
      queries = [showName || query];  // Use show name if extracted, otherwise original query
    }
    
    // Remove duplicates
    queries = [...new Set(queries)];
    
    console.log(chalk.cyan(`\n🔍 Searching ${queries.length} query variation(s) across all sources...`));
    
    // Search all sources in parallel for each query (fast!)
    const allPromises = [];
    
    for (const q of queries) {
      const sources = [
        { name: '1337x', fn: () => this.search1337x(q) },
        { name: 'YTS', fn: () => this.searchYTS(q) },
        { name: 'PirateBay', fn: () => this.searchPirateBay(q) },
        { name: 'Nyaa', fn: () => this.searchNyaa(q) }
      ];

      for (const source of sources) {
        allPromises.push(
          source.fn()
            .then(sourceResults => {
              if (sourceResults && sourceResults.length > 0) {
                return sourceResults;
              }
              return [];
            })
            .catch(() => [])  // Ignore errors, continue
        );
      }
    }
    
    // Wait for all searches to complete in parallel
    const allResults = await Promise.all(allPromises);
    
    // Flatten results
    for (const sourceResults of allResults) {
      if (sourceResults && sourceResults.length > 0) {
        results.push(...sourceResults);
      }
    }
    
    // Remove duplicates
    const seen = new Set();
    const uniqueResults = [];
    
    for (const result of results) {
      const key = `${result.name}|${result.source}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueResults.push(result);
      }
    }
    
    // Score and filter results for episode-specific searches - improved matching
    // Use provided season/episode or extract from episodeMatch
    if (episodeMatch) {
      const seasonNum = season !== null ? season : parseInt(episodeMatch[1]);
      const episodeNum = episode !== null ? episode : parseInt(episodeMatch[2]);
      const seasonValue = seasonNum;
      const episodeValue = episodeNum;
      const seasonStr = seasonValue.toString().padStart(2, '0');
      const episodeStr = episodeValue.toString();
      const episodeStrPadded2 = episodeStr.padStart(2, '0');
      const episodeStrPadded3 = episodeStr.padStart(3, '0');
      const episodeStrPadded4 = episodeStr.padStart(4, '0');
      
      // Extract season/episode from result names for better matching
      const scoredResults = uniqueResults.map(result => {
        let score = result.seeders;
        const nameLower = result.name.toLowerCase();
        let hasSeason = false;
        let hasEpisode = false;
        let exactMatch = false;
        
        // Check for exact season and episode match (various formats)
        const seasonPatterns = [
          `s${seasonStr}e`,
          `s${seasonValue}e`,
          `season ${seasonValue} episode`,
          `season ${seasonStr} episode`
        ];
        
        const episodePatterns = [
          `ep${episodeStrPadded4}`,  // EP1154 format (like ToonsHub)
          `ep${episodeStrPadded3}`,
          `ep${episodeStrPadded2}`,
          `ep${episodeStr}`,
          `e${episodeStrPadded4}`,  // E1154 format
          `e${episodeStrPadded3}`,
          `e${episodeStrPadded2}`,
          `e${episodeStr}`,
          `episode ${episodeValue}`,
          `ep ${episodeValue}`
        ];
        
        // Check for exact S##E#### match (highest priority) - includes EP format
        const exactPatterns = [
          // EP format (like ToonsHub)
          `s${seasonStr}ep${episodeStrPadded4}`,
          `s${seasonStr}ep${episodeStrPadded3}`,
          `s${seasonStr}ep${episodeStrPadded2}`,
          `s${seasonStr}ep${episodeStr}`,
          `s${seasonValue}ep${episodeStrPadded4}`,
          `s${seasonValue}ep${episodeStrPadded3}`,
          `s${seasonValue}ep${episodeStrPadded2}`,
          `s${seasonValue}ep${episodeStr}`,
          // E format
          `s${seasonStr}e${episodeStrPadded4}`,
          `s${seasonStr}e${episodeStrPadded3}`,
          `s${seasonStr}e${episodeStrPadded2}`,
          `s${seasonStr}e${episodeStr}`,
          `s${seasonValue}e${episodeStrPadded4}`,
          `s${seasonValue}e${episodeStrPadded3}`,
          `s${seasonValue}e${episodeStrPadded2}`,
          `s${seasonValue}e${episodeStr}`,
          // With spaces/underscores
          `s${seasonStr} e${episodeStrPadded4}`,
          `s${seasonStr} ep${episodeStrPadded4}`,
          `s${seasonStr}_e${episodeStrPadded4}`,
          `s${seasonStr}_ep${episodeStrPadded4}`,
          // Full text
          `season ${seasonValue} episode ${episodeValue}`
        ];
        
        for (const pattern of exactPatterns) {
          if (nameLower.includes(pattern)) {
            exactMatch = true;
            score += 2000;  // Highest boost for exact match
            hasSeason = true;
            hasEpisode = true;
            break;
          }
        }
        
        // Check for season match
        if (!hasSeason) {
          for (const pattern of seasonPatterns) {
            if (nameLower.includes(pattern)) {
              hasSeason = true;
              score += 300;
              break;
            }
          }
        }
        
        // Check for episode match
        if (!hasEpisode) {
          for (const pattern of episodePatterns) {
            if (nameLower.includes(pattern)) {
              hasEpisode = true;
              score += 500;
              break;
            }
          }
        }
        
        // Bonus for having both season and episode (even if not exact format)
        if (hasSeason && hasEpisode && !exactMatch) {
          score += 800;
        }
        
        // Extract episode number from result name using regex (supports EP, E, Episode formats)
        const resultEpisodeMatch = nameLower.match(/(?:ep|e|episode)[\s_]*(\d{1,5})/i);
        if (resultEpisodeMatch) {
          const resultEpisode = parseInt(resultEpisodeMatch[1]);
          if (resultEpisode === episodeValue) {
            score += 400;  // Bonus for matching episode number
            // Extra bonus for EP format match (like ToonsHub: "EP1154")
            if (nameLower.includes(`ep${episodeValue}`) || nameLower.includes(`ep${episodeStrPadded4}`)) {
              score += 300;  // Higher bonus for EP format
            }
          } else {
            // Penalty for wrong episode (but not too harsh)
            const diff = Math.abs(resultEpisode - episodeValue);
            if (diff > 10) {
              score -= 200;  // Large penalty for very wrong episodes
            }
          }
        }
        
        // Special handling for ToonsHub format: "[ToonsHub] One Piece EP1154"
        const toonsHubMatch = nameLower.match(/\[toonshub\].*ep(\d{1,5})/i);
        if (toonsHubMatch) {
          const toonsHubEpisode = parseInt(toonsHubMatch[1]);
          if (toonsHubEpisode === episodeValue) {
            score += 500;  // High bonus for ToonsHub format match
            hasEpisode = true;
          }
        }
        
        // Extract season number from result name
        const resultSeasonMatch = nameLower.match(/[sseason\s]+(\d{1,3})/i);
        if (resultSeasonMatch) {
          const resultSeason = parseInt(resultSeasonMatch[1]);
          if (resultSeason === seasonValue) {
            score += 200;  // Bonus for matching season
          } else {
            // Penalty for wrong season
            score -= 500;  // Strong penalty for wrong season
          }
        }
        
        return { 
          ...result, 
          score,
          hasSeason,
          hasEpisode,
          exactMatch
        };
      });
      
      // Filter out results that don't match the episode (unless they have very high seeders)
      const filteredResults = scoredResults.filter(result => {
        // Keep if exact match
        if (result.exactMatch) return true;
        // Keep if has both season and episode
        if (result.hasSeason && result.hasEpisode) return true;
        // Keep if has episode and high seeders (might be correct)
        if (result.hasEpisode && result.seeders > 50) return true;
        // Keep if very high seeders (might be popular pack)
        if (result.seeders > 200) return true;
        // Filter out others
        return false;
      });
      
      // Sort by score first, then by seeders (higher is better)
      filteredResults.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.seeders - a.seeders;
      });
      
      return filteredResults;
    }
    
    // Sort by seeders (highest first) - most important for regular searches
    uniqueResults.sort((a, b) => {
      // First sort by seeders (higher is better)
      if (b.seeders !== a.seeders) {
        return b.seeders - a.seeders;
      }
      // If seeders are equal, sort by name
      return a.name.localeCompare(b.name);
    });
    return uniqueResults;
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

    // For Nyaa and PirateBay, link should already be a magnet link
    if (torrentResult.source === 'Nyaa' || torrentResult.source === 'PirateBay') {
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
      console.log(chalk.cyan('\n📊 Memory tracking enabled'));
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
    
    console.log(chalk.blue(`\n📊 [${label}] Memory at ${(timestamp / 1000).toFixed(1)}s:`));
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
      console.log(chalk.yellow(`\n⚠️  Memory warning: ${this.formatBytes(usage.heapUsed)} heap used`));
      this.logMemory('Warning');
    }
    
    // Critical threshold
    if (usage.heapUsed > this.criticalThreshold) {
      console.log(chalk.red(`\n🚨 CRITICAL: High memory usage: ${this.formatBytes(usage.heapUsed)}`));
      this.logMemory('Critical');
      
      // Suggest actions
      console.log(chalk.yellow('   💡 Suggestions:'));
      console.log(chalk.yellow('      - Use --low-memory flag'));
      console.log(chalk.yellow('      - Use --no-subtitles flag'));
      console.log(chalk.yellow('      - Close other applications'));
      console.log(chalk.yellow('      - Consider using VLC instead of browser'));
    }
  }
  
  generateReport() {
    if (!this.enabled || this.snapshots.length === 0) return;
    
    console.log(chalk.cyan('\n\n' + '='.repeat(60)));
    console.log(chalk.cyan('📊 MEMORY TRACKING REPORT'));
    console.log(chalk.cyan('='.repeat(60)));
    
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    const peak = this.snapshots.reduce((max, s) => s.heapUsed > max.heapUsed ? s : max, first);
    
    console.log(chalk.white('\n📈 Summary:'));
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
    console.log(chalk.white('\n🔍 Potential Issues:'));
    
    const avgArrayBuffers = this.snapshots.reduce((sum, s) => sum + (s.arrayBuffers || 0), 0) / this.snapshots.length;
    if (avgArrayBuffers > 100 * 1024 * 1024) {
      console.log(chalk.yellow(`   ⚠️  High ArrayBuffer usage (${this.formatBytes(avgArrayBuffers)})`));
      console.log(chalk.yellow('      → Likely video buffering issue'));
      console.log(chalk.yellow('      → Try --low-memory flag'));
    }
    
    const avgExternal = this.snapshots.reduce((sum, s) => sum + s.external, 0) / this.snapshots.length;
    if (avgExternal > 200 * 1024 * 1024) {
      console.log(chalk.yellow(`   ⚠️  High external memory (${this.formatBytes(avgExternal)})`));
      console.log(chalk.yellow('      → Likely WebTorrent buffering'));
      console.log(chalk.yellow('      → Reduce peer connections'));
    }
    
    if (growth > 100 * 1024 * 1024) {
      console.log(chalk.red(`   🚨 Memory leak detected!`));
      console.log(chalk.yellow('      → Memory growing over time'));
      console.log(chalk.yellow('      → Check browser developer console for errors'));
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
      console.log(chalk.green(`\n💾 Report saved: ${reportPath}`));
    } catch (err) {
      console.log(chalk.red(`\n❌ Could not save report: ${err.message}`));
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
class StreamManager {
  constructor(lowMemoryMode = false, memoryTracker = null) {
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
    console.log(chalk.cyan(`🔒 STRICT Isolation: ${sandboxInfo.type} (${sandboxInfo.sizeLimit} limit)`));
    console.log(chalk.cyan(`   ✓ No file execution allowed`));
    console.log(chalk.cyan(`   ✓ No path escape allowed`));
    console.log(chalk.cyan(`   ✓ Stream-only access`));
    
    this.subtitlePath = null;
    this.subtitlePaths = []; // Array of all available subtitles with metadata
    this.cleanupInterval = null; // Periodic cleanup timer
    
    // ENHANCED: Start periodic memory cleanup in low-memory mode
    if (lowMemoryMode) {
      console.log(chalk.yellow('⚡ Low-memory mode enabled (with maximum speed settings)'));
      console.log(chalk.yellow('   - Max connections: 100 (unlimited)'));
      console.log(chalk.yellow('   - Upload limit: Unlimited'));
      console.log(chalk.yellow('   - Download limit: Unlimited'));
      console.log(chalk.yellow('   - Stream buffer: ' + (this.streamBufferSize / 1024 / 1024) + 'MB'));
      console.log(chalk.yellow('   - Periodic cleanup: Every 2 minutes'));
      
      // Schedule periodic cleanup every 2 minutes
      this.cleanupInterval = setInterval(() => {
        const activeCount = this.activeStreams.size;
        if (activeCount > 0) {
          console.log(chalk.cyan(`🧹 Periodic cleanup (${activeCount} active streams)...`));
          this.cleanup();
        }
      }, 120000); // Every 2 minutes
    }
    
    // Cache ffmpeg/ffprobe paths
    this.ffmpegPath = this.findFFmpegBinary('ffmpeg');
    this.ffprobePath = this.findFFmpegBinary('ffprobe');
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
        const result = spawnSync(cmd, args, { encoding: 'utf8' });
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
      const directRun = spawnSync(binaryName, ['-version'], { stdio: 'ignore' });
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
          ], { stdio: ['pipe', 'pipe', 'pipe'] });

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

              console.log(chalk.cyan(`\n📝 Found ${subtitleStreams.length} embedded subtitle track(s) - extracting during download...`));
              
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
                  console.log(chalk.gray(`   📝 Reserved slot for: ${placeholderInfo.label} (will be available during streaming)`));
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
                    ], { stdio: ['pipe', 'pipe', 'pipe'] });

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
                  console.log(chalk.green(`\n✅ Successfully extracted ${extracted.length} subtitle track(s):`));
                  extracted.forEach(sub => {
                    if (sub && sub.label) {
                      console.log(chalk.green(`   ✅ ${sub.label}`));
                    }
                  });
                  console.log(chalk.cyan('   💡 Subtitles are available during streaming\n'));
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
    return new Promise((resolve, reject) => {
      console.log(chalk.blue('\n📥 Adding torrent...'));
      
      if (this.memoryTracker) {
        this.memoryTracker.logMemory('Before adding torrent');
      }

      // Set up error handler BEFORE adding torrent
      const errorHandler = (err) => {
        console.log(chalk.red(`\n❌ WebTorrent error: ${err.message}`));
        reject(err);
      };
      this.client.once('error', errorHandler);

      // Add timeout for torrent connection (60 seconds)
      const connectionTimeout = setTimeout(() => {
        this.client.removeListener('error', errorHandler);
        console.log(chalk.red('\n❌ Timeout: Could not connect to torrent after 60 seconds'));
        console.log(chalk.yellow('💡 Try:'));
        console.log(chalk.yellow('   1. Check your internet connection'));
        console.log(chalk.yellow('   2. Try a different torrent'));
        console.log(chalk.yellow('   3. Make sure no other torrent client is running'));
        reject(new Error('Torrent connection timeout'));
      }, 60000);

      // Show connection progress
      console.log(chalk.cyan('   💡 Connecting to DHT and trackers to find peers...'));
      let connectionTimer = 0;
      const progressInterval = setInterval(() => {
        connectionTimer += 5;
        if (connectionTimer >= 15 && connectionTimer % 5 === 0) {
          if (connectionTimer === 15) {
            console.log(chalk.yellow('\n⚠️  Taking longer than expected...'));
            console.log(chalk.yellow('   This can happen if:'));
            console.log(chalk.yellow('   - Torrent has few seeders'));
            console.log(chalk.yellow('   - DHT/trackers are slow to respond'));
            console.log(chalk.yellow('   - Network connection issues'));
            console.log(chalk.yellow('\n   💡 Tip: Try using a different torrent source'));
            console.log(chalk.yellow('   Please wait...'));
          }
          console.log(chalk.cyan(`   ⏳ Still connecting... (${connectionTimer}s)`));
        }
      }, 5000);

      this.client.add(magnetLink, (torrent) => {
        // Clear timeout and progress indicators
        clearTimeout(connectionTimeout);
        clearInterval(progressInterval);
        this.client.removeListener('error', errorHandler);
        this.currentTorrent = torrent;
        
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('After adding torrent');
        }
        
        console.log(chalk.green(`\n✅ Torrent added: ${torrent.name}`));
        console.log(chalk.cyan(`📊 Files: ${torrent.files.length}`));
        console.log(chalk.cyan(`👥 Peers: ${torrent.numPeers}`));
        
        // CRITICAL: Deselect all files first to prevent memory allocation
        // Analysis shows 138MB ArrayBuffer spike when torrent is added
        torrent.files.forEach(file => file.deselect());
        
        // Find video file
        const videoFile = torrent.files.find(file => {
          const ext = path.extname(file.name).toLowerCase();
          return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v'].includes(ext);
        });

        if (!videoFile) {
          reject(new Error('No video file found in torrent'));
          return;
        }
        
        // CRITICAL: Select ONLY the video file to prevent unnecessary memory allocation
        videoFile.select();
        
        // ENHANCED: Smart piece management for optimal streaming
        // WebTorrent handles piece selection automatically for streaming
        // We just need to ensure sequential downloading for the video file
        
        // WebTorrent's file.select() already enables sequential downloading
        // and prioritizes pieces needed for streaming
        console.log(chalk.cyan(`💡 Sequential streaming enabled (WebTorrent auto-prioritization)`));
        
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
        
        console.log(chalk.green(`\n🎬 Video file: ${videoFile.name}`));
        console.log(chalk.cyan(`📦 Size: ${(videoFile.length / 1024 / 1024 / 1024).toFixed(2)} GB`));
        console.log(chalk.yellow(`💡 Other files deselected to save memory`));
        
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('Video file found');
        }
        
        // Skip subtitle processing if disabled (memory optimization)
        if (options.disableSubtitles) {
          console.log(chalk.yellow('\n⚠️  Subtitles disabled (--no-subtitles flag) for better performance'));
          console.log(chalk.green('   ✅ Skipping subtitle extraction (saves ~50MB memory)'));
        } else {
          // Extract embedded subtitles as video downloads (streaming extraction)
          if (this.ffmpegPath && this.ffprobePath) {
            console.log(chalk.cyan('\n🎬 Extracting embedded subtitles (may use extra memory)...'));
            console.log(chalk.yellow('   💡 Use --no-subtitles flag to disable and save ~50MB'));
            
            this.extractEmbeddedSubtitlesStreaming(videoFile, torrent).then(() => {
              // Subtitles extracted (or not found), continue with streaming setup
              if (this.memoryTracker) {
                this.memoryTracker.logMemory('After subtitle extraction');
              }
            }).catch(() => {
              // Ignore extraction errors
            });
          } else {
            console.log(chalk.yellow('\n⚠️  Embedded subtitle extraction unavailable: ffmpeg/ffprobe not found in PATH'));
            console.log(chalk.yellow('   💡 Install ffmpeg (with ffprobe) to load subtitles from MultiSub torrents in browser'));
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
        }
        
        // Start HTTP server for streaming (pass subtitle path and disable flag)
        this.startStreamingServer(videoFile, (url) => {
          if (this.memoryTracker) {
            this.memoryTracker.logMemory('Streaming server started');
          }
          
          // Show subtitle info if available
          if (!options.disableSubtitles && options.subtitlePath && fs.existsSync(options.subtitlePath)) {
            console.log(chalk.green(`\n📝 Subtitle available: ${url}/subtitle.srt`));
            console.log(chalk.cyan('   💡 Most players will auto-detect the subtitle file'));
          }
          console.log(chalk.green(`\n🚀 Streaming server started!`));
          console.log(chalk.yellow(`\n📺 Stream URL: ${url}`));
          if (options.disableSubtitles) {
            console.log(chalk.cyan('\n💡 Opening lightweight player (subtitles disabled)...'));
          } else {
            console.log(chalk.cyan('\n💡 Opening in default player...'));
          }
          console.log(chalk.gray('   Press Ctrl+C to stop streaming\n'));

          // Open in default player (force new tab for better memory management)
          if (options.openPlayer !== false) {
            open(url, { newInstance: true, wait: false }).catch(() => {
              console.log(chalk.yellow('\n⚠️  Could not auto-open player. Copy the URL above and open it in VLC or your preferred player.'));
            });
          }

          resolve({ url, torrent, videoFile, subtitlePath: options.subtitlePath });
        }, options.subtitlePath, options.disableSubtitles);

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
            // Clear current line, move to new line for memory log
            process.stdout.write('\r\x1b[K\n'); // Clear line and move to new line
            this.memoryTracker.logMemory(`Download progress: ${progress}%`);
            // Don't add extra spacing - memory log already has newline
          }
          
          // Always draw progress on same line (clearing previous content)
          process.stdout.write(`\r\x1b[K${chalk.cyan(`⬇️  Progress: ${progress}% | Downloaded: ${downloaded} MB | Speed: ${speed} MB/s`)}`);
        });

        torrent.on('done', () => {
          downloadComplete = true;
          process.stdout.write('\r\x1b[K'); // Clear the progress line
          console.log(chalk.green('\n✅ Download complete!'));
          if (this.memoryTracker) {
            this.memoryTracker.logMemory('Download complete');
          }
        });
      });
    });
  }

  startStreamingServer(videoFile, callback, subtitlePath = null, disableSubtitles = false) {
    const port = 8000;
    const videoUrl = `/video${path.extname(videoFile.name)}`;
    const videoName = videoFile.name;
    const videoExt = path.extname(videoFile.name).toLowerCase();
    let htmlVideoType = 'type="video/mp4"';
    if (videoExt === '.mkv') {
      htmlVideoType = 'type="video/mp4"';
    } else if (videoExt === '.webm') {
      htmlVideoType = 'type="video/webm"';
    } else if (videoExt === '.mp4') {
      htmlVideoType = 'type="video/mp4"';
    } else if (videoExt === '.mov') {
      htmlVideoType = 'type="video/quicktime"';
    }
    
    this.server = http.createServer((req, res) => {
      // Handle root request - serve HTML player page
      if (req.url === '/' || req.url === '/index.html') {
        const html = this.getHTMLPlayer(videoUrl, htmlVideoType, videoName, disableSubtitles);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
        return;
      }
      
      // API endpoint to check available subtitles
      if (req.url === '/api/subtitles' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        const subtitleList = this.subtitlePaths.map((sub, index) => ({
          index: index,
          url: `/subtitle_${index}.vtt`,
          language: sub.language || 'en',
          label: sub.label || `Subtitle ${index + 1}`,
          source: sub.source || 'unknown'
        }));
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
        
        // Handle range requests for video streaming
        const range = req.headers.range;
      
        let stream;
        
        // ENHANCED: Helper function to safely destroy stream with cleanup
        const destroyStream = () => {
          if (stream && !stream.destroyed) {
            // Remove from active streams tracking
            this.activeStreams.delete(stream);
            stream.destroy();
            stream = null; // Clear reference for GC
          }
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
          // Silently ignore client disconnect errors
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
            console.error('Response error:', err.message);
          }
        });
        
          if (!range) {
            res.writeHead(200, {
          'Content-Length': videoFile.length,
          'Content-Type': 'video/mp4',
        });
        // CRITICAL: Create stream with priority on initial pieces
        stream = videoFile.createReadStream({ start: 0, end: Math.min(videoFile.length - 1, 10 * 1024 * 1024) });
        
        // Handle stream errors
        stream.on('error', (err) => {
          if (!res.destroyed) {
            destroyStream();
            // Silently ignore common streaming errors
            if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
              console.error('Stream error:', err.message);
            }
          }
        });
        
        stream.pipe(res);
            return;
          }

          const positions = range.replace(/bytes=/, '').split('-');
          const start = parseInt(positions[0], 10);
          
          // ENHANCED: Large chunk size for maximum streaming speed
          // No artificial limits - let the browser/player request what it needs
          const maxChunkSize = 10 * 1024 * 1024; // 10MB chunks for fast streaming
          
          const requestedEnd = positions[1] ? parseInt(positions[1], 10) : Math.min(start + maxChunkSize - 1, videoFile.length - 1);
          const end = Math.min(requestedEnd, videoFile.length - 1);
          const chunksize = (end - start) + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${videoFile.length}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      });

      // ENHANCED: Create stream with large buffer for maximum speed
      stream = videoFile.createReadStream({
        start, 
        end,
        highWaterMark: 5 * 1024 * 1024 // 5MB buffer for fast streaming
      });
      
      // Track this stream for memory management
      this.activeStreams.add(stream);
      
      // ENHANCED: Handle stream errors with proper cleanup
      stream.on('error', (err) => {
        if (!res.destroyed) {
          destroyStream();
          // Silently ignore common streaming errors
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.error('Stream error:', err.message);
          }
        }
      });
      
      // ENHANCED: Handle backpressure to prevent memory buildup
      // If response buffer is full, pause the stream
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

    this.server.listen(port, () => {
      callback(`http://localhost:${port}`);
    });
  }
  
  getHTMLPlayer(videoUrl, htmlVideoType, videoName, disableSubtitles = false) {
    // If subtitles are disabled, return a lightweight player with NO subtitle functionality
    if (disableSubtitles) {
      return this.getLightweightHTMLPlayer(videoUrl, htmlVideoType, videoName);
    }
    
    const normalizeTrackLanguage = (language) => {
      const lang = (language || '').toString().trim().toLowerCase();
      if (!lang || lang === 'unknown' || lang === 'und' || lang === 'n/a' || lang === 'null') {
        return 'en';
      }
      return lang;
    };

    const tracks = this.subtitlePaths.length > 0 ? this.subtitlePaths.map((sub, index) => {
      const normalizedLanguage = normalizeTrackLanguage(sub.language);
      return `            <track kind="subtitles" src="/subtitle_${index}.vtt" srclang="${normalizedLanguage}" label="${sub.label || `Subtitle ${index + 1}`}" data-source="${sub.source || 'unknown'}" ${index === 0 ? 'default' : ''} type="text/vtt">`;
    }).join('\n') : '            <!-- Subtitles will appear here as they are extracted during download -->';
    
    // Pass subtitle metadata to the player for smart refresh logic
    const subtitleMetadata = JSON.stringify(this.subtitlePaths.map((sub, index) => ({
      index: index,
      source: sub.source || 'unknown',
      language: normalizeTrackLanguage(sub.language),
      label: sub.label || `Subtitle ${index + 1}`
    })));
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoName}</title>
    <link href="https://vjs.zencdn.net/8.6.1/video-js.css" rel="stylesheet" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; display: flex; justify-content: center; align-items: center; min-height: 100vh; font-family: Arial, sans-serif; }
        .container { width: 100%; max-width: 1280px; padding: 20px; }
        .video-js { width: 100%; height: auto; background: #000; }
        .video-info { margin-top: 10px; color: #fff; text-align: center; font-size: 14px; }
        .subtitle-adjust-btn {
            position: fixed; top: 20px; left: 20px; width: 48px; height: 48px;
            background: rgba(0, 0, 0, 0.8); border: 2px solid #4CAF50; border-radius: 50%;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            font-size: 24px; color: #4CAF50; z-index: 10000; transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }
        .subtitle-adjust-btn:hover { background: rgba(76, 175, 80, 0.2); transform: scale(1.1); }
        .subtitle-adjust-popup {
            position: fixed; top: 80px; left: 20px; width: 400px; max-height: 600px;
            background: rgba(0, 0, 0, 0.95); border: 2px solid #4CAF50; border-radius: 12px;
            padding: 20px; z-index: 10001; display: none; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.7);
            color: #fff; font-family: 'Segoe UI', Arial, sans-serif;
        }
        .subtitle-adjust-popup.active { display: block; }
        .subtitle-adjust-popup h3 {
            margin: 0 0 15px 0; color: #4CAF50; font-size: 18px;
            border-bottom: 1px solid rgba(76, 175, 80, 0.3); padding-bottom: 10px;
        }
        .subtitle-preview {
            max-height: 200px; overflow-y: auto; background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(76, 175, 80, 0.3); border-radius: 6px; padding: 10px;
            margin-bottom: 15px; font-size: 13px; line-height: 1.6;
        }
        .subtitle-item {
            padding: 8px; margin-bottom: 5px; border-radius: 4px; cursor: pointer;
            transition: background 0.2s;
        }
        .subtitle-item:hover { background: rgba(76, 175, 80, 0.2); }
        .subtitle-item.active {
            background: rgba(76, 175, 80, 0.4); border-left: 3px solid #4CAF50;
        }
        .subtitle-item .time {
            color: #4CAF50; font-weight: bold; font-size: 11px; margin-bottom: 4px;
        }
        .subtitle-item .text { color: #fff; }
        .adjust-controls {
            display: flex; gap: 10px; margin-bottom: 15px;
        }
        .adjust-btn {
            flex: 1; padding: 10px; background: rgba(76, 175, 80, 0.2);
            border: 1px solid #4CAF50; border-radius: 6px; color: #4CAF50;
            cursor: pointer; font-size: 14px; font-weight: bold; transition: all 0.2s;
        }
        .adjust-btn:hover { background: rgba(76, 175, 80, 0.4); transform: translateY(-2px); }
        .offset-display {
            text-align: center; padding: 10px; background: rgba(76, 175, 80, 0.1);
            border-radius: 6px; margin-bottom: 15px;
        }
        .offset-display .value {
            font-size: 20px; color: #4CAF50; font-weight: bold;
        }
        .close-btn {
            position: absolute; top: 10px; right: 10px; width: 30px; height: 30px;
            background: rgba(255, 255, 255, 0.1); border: 1px solid #4CAF50;
            border-radius: 50%; color: #4CAF50; cursor: pointer; display: flex;
            align-items: center; justify-content: center; font-size: 18px;
        }
        .close-btn:hover { background: rgba(255, 0, 0, 0.2); border-color: #f44336; color: #f44336; }
    </style>
</head>
<body>
    <div class="subtitle-adjust-btn" id="subtitleAdjustBtn" title="Adjust Subtitle Timing">⏱️</div>
    <div class="subtitle-adjust-popup" id="subtitleAdjustPopup">
        <div class="close-btn" id="closePopupBtn">×</div>
        <h3>⏱️ Subtitle Timing Adjustment</h3>
        <div class="offset-display">
            <div class="value" id="offsetValue">+0.00s</div>
        </div>
        <div class="adjust-controls">
            <button class="adjust-btn" id="subtract1Btn">-1.0s</button>
            <button class="adjust-btn" id="subtract0_5Btn">-0.5s</button>
            <button class="adjust-btn" id="add0_5Btn">+0.5s</button>
            <button class="adjust-btn" id="add1Btn">+1.0s</button>
        </div>
        <div class="adjust-controls">
            <button class="adjust-btn" id="subtract0_1Btn">-0.1s</button>
            <button class="adjust-btn" id="resetBtn">Reset</button>
            <button class="adjust-btn" id="add0_1Btn">+0.1s</button>
        </div>
        <div class="subtitle-preview" id="subtitlePreview">
            <div style="text-align: center; color: #999; padding: 20px;">Load video to see subtitles</div>
        </div>
    </div>
    <div class="container">
        <video id="videoPlayer" class="video-js vjs-default-skin vjs-big-play-centered" controls preload="metadata" data-setup='{}' crossorigin="anonymous" playsinline>
            <source src="${videoUrl}" ${htmlVideoType}>
${tracks}
        </video>
        <div class="video-info"><p>${videoName}</p></div>
    </div>
    <script src="https://vjs.zencdn.net/8.6.1/video.min.js"></script>
    <script>
        // Subtitle metadata from server - tells us which subtitles need refresh monitoring
        const subtitleMetadata = ${subtitleMetadata};
        
        const player = videojs('videoPlayer', {
            fluid: true, responsive: true,
            html5: { nativeTextTracks: true }
        });
        
        let subtitleOffset = 0;
        let allSubtitles = [];
        let selectedSubtitleLanguage = null; // Track user's selected subtitle language
        const adjustBtn = document.getElementById('subtitleAdjustBtn');
        const popup = document.getElementById('subtitleAdjustPopup');
        const closeBtn = document.getElementById('closePopupBtn');
        const offsetValue = document.getElementById('offsetValue');
        const subtitlePreview = document.getElementById('subtitlePreview');
        
        adjustBtn.addEventListener('click', () => {
            popup.classList.toggle('active');
            if (popup.classList.contains('active')) {
                loadSubtitles();
            } else {
                // Free memory when popup closes (critical for preventing tab crashes)
                allSubtitles = [];
                subtitlePreview.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">Load video to see subtitles</div>';
            }
        });
        closeBtn.addEventListener('click', () => {
            popup.classList.remove('active');
            // Free memory when popup closes (critical for preventing tab crashes)
            allSubtitles = [];
            subtitlePreview.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">Load video to see subtitles</div>';
        });
        
        // Event delegation for subtitle items (prevents memory leaks)
        subtitlePreview.addEventListener('click', (e) => {
            const item = e.target.closest('.subtitle-item');
            if (item) {
                const index = parseInt(item.dataset.index);
                if (!isNaN(index) && allSubtitles[index]) {
                    const sub = allSubtitles[index];
                    player.currentTime(sub.start + subtitleOffset);
                }
            }
        });
        
        function loadSubtitles() {
            allSubtitles = [];
            const tracks = player.textTracks();
            
            if (!tracks || tracks.length === 0) {
                renderSubtitlePreview();
                return;
            }
            
            const subtitleTracks = Array.from(tracks).filter(t => t.kind === 'subtitles');
            
            if (subtitleTracks.length === 0) {
                renderSubtitlePreview();
                return;
            }
            
            // Prioritize user's selected language
            let subtitleTrack = null;
            if (selectedSubtitleLanguage) {
                subtitleTrack = subtitleTracks.find(t => 
                    (t.language === selectedSubtitleLanguage || t.label === selectedSubtitleLanguage) && 
                    t.cues && t.cues.length > 0
                );
            }
            
            // Fallback to any track with cues or the showing track
            if (!subtitleTrack) {
                subtitleTrack = subtitleTracks.find(t => t.cues && t.cues.length > 0);
            }
            
            if (!subtitleTrack) {
                subtitleTrack = subtitleTracks.find(t => t.mode === 'showing') || subtitleTracks[0];
                
                if (subtitleTrack && (!subtitleTrack.cues || subtitleTrack.cues.length === 0)) {
                    // Track exists but cues aren't loaded, wait for them
                    const waitForCues = (attempts = 0) => {
                        if (subtitleTrack.cues && subtitleTrack.cues.length > 0) {
                            // Memory optimization: limit cues for TV shows (reduced to prevent tab crashes)
                            const maxCuesToLoad = 2000;
                            const cuesToLoad = Math.min(subtitleTrack.cues.length, maxCuesToLoad);
                            for (let i = 0; i < cuesToLoad; i++) {
                                const cue = subtitleTrack.cues[i];
                                allSubtitles.push({
                                    start: cue.startTime,
                                    end: cue.endTime,
                                    text: cue.text
                                });
                            }
                            renderSubtitlePreview();
                        } else if (attempts < 20) {
                            setTimeout(() => waitForCues(attempts + 1), 500);
                        } else {
                            renderSubtitlePreview();
                        }
                    };
                    
                    subtitleTrack.addEventListener('load', () => {
                        if (subtitleTrack.cues && subtitleTrack.cues.length > 0) {
                            // Memory optimization: limit cues for TV shows (reduced to prevent tab crashes)
                            const maxCuesToLoad = 2000;
                            const cuesToLoad = Math.min(subtitleTrack.cues.length, maxCuesToLoad);
                            for (let i = 0; i < cuesToLoad; i++) {
                                const cue = subtitleTrack.cues[i];
                                allSubtitles.push({
                                    start: cue.startTime,
                                    end: cue.endTime,
                                    text: cue.text
                                });
                            }
                            renderSubtitlePreview();
                        }
                    });
                    
                    subtitleTrack.addEventListener('loadeddata', () => {
                        if (subtitleTrack.cues && subtitleTrack.cues.length > 0) {
                            // Memory optimization: limit cues for TV shows (reduced to prevent tab crashes)
                            const maxCuesToLoad = 2000;
                            const cuesToLoad = Math.min(subtitleTrack.cues.length, maxCuesToLoad);
                            for (let i = 0; i < cuesToLoad; i++) {
                                const cue = subtitleTrack.cues[i];
                                allSubtitles.push({
                                    start: cue.startTime,
                                    end: cue.endTime,
                                    text: cue.text
                                });
                            }
                            renderSubtitlePreview();
                        }
                    });
                    
                    waitForCues();
                    return;
                }
            }
            
            if (subtitleTrack && subtitleTrack.cues && subtitleTrack.cues.length > 0) {
                // Memory optimization: For large subtitle files (TV shows), limit initial load
                const maxCuesToLoad = 2000; // Reduced limit to prevent tab crashes
                const totalCues = subtitleTrack.cues.length;
                const cuesToLoad = Math.min(totalCues, maxCuesToLoad);
                
                for (let i = 0; i < cuesToLoad; i++) {
                    const cue = subtitleTrack.cues[i];
                    allSubtitles.push({
                        start: cue.startTime,
                        end: cue.endTime,
                        text: cue.text
                    });
                }
                
                if (totalCues > maxCuesToLoad) {
                    console.log('Loaded ' + cuesToLoad + ' of ' + totalCues + ' subtitles for better performance');
                }
            }
            
            renderSubtitlePreview();
        }
        
        function renderSubtitlePreview() {
            if (allSubtitles.length === 0) {
                subtitlePreview.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">No subtitles available</div>';
                return;
            }
            const currentTime = player.currentTime();
            const timeWindow = 120; // Show subtitles within ±2 minutes (120 seconds) to prevent tab crashes
            let html = '';
            let activeIndex = -1;
            
            // Find active subtitle first
            for (let i = 0; i < allSubtitles.length; i++) {
                const sub = allSubtitles[i];
                const adjustedStart = sub.start + subtitleOffset;
                const adjustedEnd = sub.end + subtitleOffset;
                if (currentTime >= adjustedStart && currentTime <= adjustedEnd) {
                    activeIndex = i;
                    break;
                }
            }
            
            // Only render subtitles within time window to reduce memory usage
            allSubtitles.forEach((sub, index) => {
                const adjustedStart = sub.start + subtitleOffset;
                const adjustedEnd = sub.end + subtitleOffset;
                
                // Skip subtitles outside the time window (memory optimization for TV shows)
                if (Math.abs(adjustedStart - currentTime) > timeWindow) {
                    return;
                }
                
                const isActive = index === activeIndex;
                const timeStr = formatTime(adjustedStart) + ' → ' + formatTime(adjustedEnd);
                html += '<div class="subtitle-item ' + (isActive ? 'active' : '') + '" data-index="' + index + '">';
                html += '<div class="time">' + timeStr + '</div>';
                html += '<div class="text">' + sub.text.replace(/\\n/g, '<br>') + '</div>';
                html += '</div>';
            });
            
            if (html === '') {
                html = '<div style="text-align: center; color: #999; padding: 20px;">No subtitles in current time range</div>';
            }
            
            subtitlePreview.innerHTML = html;
            if (activeIndex >= 0) {
                const activeItem = subtitlePreview.querySelector('.subtitle-item[data-index="' + activeIndex + '"]');
                if (activeItem) {
                    activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
            // Use event delegation to avoid memory leaks from repeated event listener attachment
            // This was a major cause of tab crashes
        }
        
        function formatTime(seconds) {
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            const ms = Math.floor((seconds % 1) * 1000);
            if (h > 0) {
                return h + ':' + m.toString().padStart(2, '0') + ':' + s.toString().padStart(2, '0') + '.' + ms.toString().padStart(3, '0');
            }
            return m + ':' + s.toString().padStart(2, '0') + '.' + ms.toString().padStart(3, '0');
        }
        
        function updateOffsetDisplay() {
            const sign = subtitleOffset >= 0 ? '+' : '';
            offsetValue.textContent = sign + subtitleOffset.toFixed(2) + 's';
            renderSubtitlePreview();
        }
        
        function adjustOffset(seconds) {
            subtitleOffset += seconds;
            updateOffsetDisplay();
        }
        
        document.getElementById('subtract1Btn').addEventListener('click', () => adjustOffset(-1.0));
        document.getElementById('subtract0_5Btn').addEventListener('click', () => adjustOffset(-0.5));
        document.getElementById('add0_5Btn').addEventListener('click', () => adjustOffset(0.5));
        document.getElementById('add1Btn').addEventListener('click', () => adjustOffset(1.0));
        document.getElementById('subtract0_1Btn').addEventListener('click', () => adjustOffset(-0.1));
        document.getElementById('add0_1Btn').addEventListener('click', () => adjustOffset(0.1));
        document.getElementById('resetBtn').addEventListener('click', () => {
            subtitleOffset = 0;
            updateOffsetDisplay();
        });
        
        // Throttle timeupdate to reduce memory/CPU usage (was causing tab crashes)
        let lastUpdateTime = 0;
        player.on('timeupdate', () => {
            if (popup.classList.contains('active')) {
                const now = Date.now();
                // Only update every 500ms instead of every frame (major performance improvement)
                if (now - lastUpdateTime > 500) {
                    lastUpdateTime = now;
                    renderSubtitlePreview();
                }
            }
        });
        
        function getTrackElement(track) {
            const videoElement = document.getElementById('videoPlayer');
            if (!videoElement) {
                return null;
            }

            const trackElements = videoElement.querySelectorAll('track');
            for (const trackElement of trackElements) {
                if (trackElement.track === track) {
                    return trackElement;
                }
            }
            return null;
        }

        function getTrackSource(track, trackIndex) {
            const trackElement = getTrackElement(track);
            if (trackElement && trackElement.dataset && trackElement.dataset.source) {
                return trackElement.dataset.source;
            }

            const byIndex = subtitleMetadata.find(m => m.index === trackIndex);
            if (byIndex && byIndex.source) {
                return byIndex.source;
            }

            const byLabelOrLanguage = subtitleMetadata.find(m =>
                (m.label && track.label && m.label === track.label) ||
                (m.language && track.language && m.language === track.language)
            );
            return byLabelOrLanguage ? byLabelOrLanguage.source : 'unknown';
        }

        function ensureSubtitleVisible() {
            const tracks = player.textTracks();
            if (!tracks) {
                return;
            }

            const subtitleTracks = Array.from(tracks).filter(t => t.kind === 'subtitles');
            if (subtitleTracks.length === 0) {
                return;
            }

            const hasShowingTrack = subtitleTracks.some(t => t.mode === 'showing');
            if (hasShowingTrack) {
                return;
            }

            const preferredTrack = subtitleTracks.find(t => t.cues && t.cues.length > 0) || subtitleTracks[0];
            if (preferredTrack) {
                preferredTrack.mode = 'showing';
            }
        }

        // Set up automatic subtitle detection - listens for cues as they load
        function setupAutoSubtitleDetection() {
            const tracks = player.textTracks();
            if (tracks) {
                const monitoredTracks = new Set();
                
                const monitorTracks = () => {
                    Array.from(tracks).forEach((track, trackIndex) => {
                        if (track.kind === 'subtitles' && !monitoredTracks.has(track)) {
                            const trackSource = getTrackSource(track, trackIndex);
                            const isEmbedded = trackSource === 'embedded';
                            
                            // Only monitor embedded subtitles - external/downloaded ones are already complete
                            if (!isEmbedded) {
                                console.log('Skipping refresh monitoring for', track.label, '(source:', trackSource + ')');
                                return;
                            }
                            
                            console.log('Setting up refresh monitoring for embedded subtitle:', track.label);
                            monitoredTracks.add(track);
                            
                            track.addEventListener('load', function() {
                                const cueCount = track.cues ? track.cues.length : 0;
                                console.log('Subtitle track loaded:', track.label, 'cues:', cueCount);
                                ensureSubtitleVisible();
                                if (popup && popup.classList.contains('active')) {
                                    loadSubtitles();
                                }
                            });
                            
                            track.addEventListener('loadeddata', function() {
                                const cueCount = track.cues ? track.cues.length : 0;
                                console.log('Subtitle track data loaded:', track.label, 'cues:', cueCount);
                                ensureSubtitleVisible();
                                if (popup && popup.classList.contains('active')) {
                                    loadSubtitles();
                                }
                            });
                            
                            // Periodically reload track to pick up new cues as file is being written
                            let trackElement = getTrackElement(track);
                            
                            let lastCueCount = 0;
                            let lastFileSize = 0;
                            let noChangeCount = 0;
                            let checkCount = 0;
                            let isComplete = false; // Track if subtitle extraction is complete
                            const maxChecks = 30; // Stop after 30 checks (1 minute) to prevent memory leaks
                            
                            const reloadInterval = setInterval(() => {
                                checkCount++;
                                
                                // Stop checking after max attempts to prevent memory leaks (critical fix for tab crashes)
                                if (checkCount > maxChecks) {
                                    clearInterval(reloadInterval);
                                    isComplete = true;
                                    console.log('Stopped subtitle polling after ' + maxChecks + ' checks to conserve memory');
                                    return;
                                }
                                
                                // Skip all checks if extraction is complete
                                if (isComplete) {
                                    return;
                                }
                                
                                const currentCueCount = track.cues ? track.cues.length : 0;
                                
                                // Check if file has changed by fetching its size
                                if (trackElement && trackElement.src) {
                                    const originalSrc = trackElement.src.split('?')[0];
                                    
                                    fetch(originalSrc, { method: 'HEAD' })
                                        .then(response => {
                                            if (response.ok) {
                                                const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
                                                
                                                // Only reload if file size actually changed (new subtitles extracted)
                                                if (contentLength > lastFileSize && lastFileSize > 0) {
                                                    console.log('File updated: ' + contentLength + ' bytes (was ' + lastFileSize + ')');
                                                    lastFileSize = contentLength;
                                                    noChangeCount = 0;
                                                    
                                                    // Save current track mode and selected language
                                                    const currentMode = track.mode;
                                                    const wasShowing = currentMode === 'showing';
                                                    
                                                    const newSrc = originalSrc + '?t=' + Date.now();
                                                    if (trackElement.parentNode) {
                                                        const parent = trackElement.parentNode;
                                                        const newTrack = trackElement.cloneNode(false);
                                                        newTrack.src = newSrc;
                                                        newTrack.dataset.source = 'embedded';
                                                        
                                                        // DON'T set default - let restoration handle it
                                                        // This prevents browser from auto-selecting wrong language
                                                        
                                                        parent.removeChild(trackElement);
                                                        parent.appendChild(newTrack);
                                                        trackElement = newTrack;
                                                        
                                                        // Restore the user's selected subtitle language after track loads
                                                        const restoreTrack = () => {
                                                            if (newTrack.track) {
                                                                // Restore user's selection or keep showing if it was showing
                                                                if (selectedSubtitleLanguage) {
                                                                    console.log('Restoring after reload...');
                                                                    restoreSubtitleSelection();
                                                                } else if (wasShowing) {
                                                                    // If no specific language selected, just keep this track showing
                                                                    newTrack.track.mode = 'showing';
                                                                }
                                                                ensureSubtitleVisible();
                                                            }
                                                        };
                                                        
                                                        newTrack.addEventListener('load', function() {
                                                            // Wait a bit for track to be fully ready
                                                            setTimeout(restoreTrack, 150);
                                                        }, { once: true });
                                                        
                                                        // Also try to restore after a delay in case 'load' event doesn't fire
                                                        setTimeout(restoreTrack, 300);
                                                    }
                                                } else if (lastFileSize === 0) {
                                                    // First check - just record the size
                                                    lastFileSize = contentLength;
                                                } else {
                                                    // Size hasn't changed
                                                    noChangeCount++;
                                                    
                                                    if (noChangeCount >= 3) {
                                                        clearInterval(reloadInterval);
                                                        isComplete = true; // Mark as complete to prevent any further checks
                                                        console.log('File extraction complete - stopped reloading (no more updates needed)');
                                                        // Don't do any final reload - subtitles are already loaded and complete
                                                        // This prevents unnecessary refreshing when extraction is done
                                                    }
                                                }
                                            }
                                        })
                                        .catch(() => {});
                                }
                                
                                if (currentCueCount > lastCueCount) {
                                    console.log('New cues detected: ' + currentCueCount + ' (was ' + lastCueCount + ')');
                                    lastCueCount = currentCueCount;
                                    ensureSubtitleVisible();
                                    if (popup && popup.classList.contains('active')) {
                                        loadSubtitles();
                                    }
                                }
                            }, 2000);
                        }
                    });
                };
                
                monitorTracks();

                if (typeof tracks.addEventListener === 'function') {
                    tracks.addEventListener('addtrack', function(event) {
                        if (event.track.kind === 'subtitles') {
                            monitorTracks();
                            ensureSubtitleVisible();
                            if (popup && popup.classList.contains('active')) {
                                loadSubtitles();
                            }
                        }
                    });
                } else {
                    tracks.onaddtrack = function(event) {
                        if (event.track.kind === 'subtitles') {
                            monitorTracks();
                            ensureSubtitleVisible();
                            if (popup && popup.classList.contains('active')) {
                                loadSubtitles();
                            }
                        }
                    };
                }
            }
        }
        
        // Track user's subtitle language selection
        function trackSubtitleSelection() {
            const tracks = player.textTracks();
            if (tracks) {
                // Listen for track changes to remember user's selection
                tracks.addEventListener('change', function() {
                    Array.from(tracks).forEach(track => {
                        if (track.kind === 'subtitles' && track.mode === 'showing') {
                            selectedSubtitleLanguage = track.language || track.label;
                            console.log('User selected subtitle language:', selectedSubtitleLanguage);
                        }
                    });
                });
            }
        }
        
        // Restore user's selected subtitle language
        function restoreSubtitleSelection() {
            if (!selectedSubtitleLanguage) {
                console.log('No subtitle language to restore');
                return;
            }
            
            const tracks = player.textTracks();
            if (!tracks) {
                console.log('No tracks available to restore');
                return;
            }
            
            console.log('Attempting to restore subtitle language:', selectedSubtitleLanguage);
            
            // First, hide ALL subtitle tracks to prevent conflicts
            Array.from(tracks).forEach(track => {
                if (track.kind === 'subtitles') {
                    track.mode = 'disabled';
                }
            });
            
            // Then find and activate ONLY the previously selected language
            let restored = false;
            Array.from(tracks).forEach(track => {
                if (track.kind === 'subtitles') {
                    const trackLang = track.language || track.label;
                    console.log('Checking track:', trackLang, 'against selected:', selectedSubtitleLanguage);
                    
                    if (trackLang === selectedSubtitleLanguage) {
                        track.mode = 'showing';
                        restored = true;
                        console.log('✓ Restored subtitle language:', selectedSubtitleLanguage);
                    }
                }
            });
            
            if (!restored) {
                console.log('⚠ Could not find track with language:', selectedSubtitleLanguage);
                // Try partial match as fallback
                Array.from(tracks).forEach(track => {
                    if (track.kind === 'subtitles' && !restored) {
                        const trackLang = track.language || track.label;
                        if (trackLang && selectedSubtitleLanguage && 
                            (trackLang.includes(selectedSubtitleLanguage) || selectedSubtitleLanguage.includes(trackLang))) {
                            track.mode = 'showing';
                            restored = true;
                            console.log('✓ Restored subtitle language (partial match):', trackLang);
                        }
                    }
                });
            }
        }
        
        player.ready(() => {
            setupAutoSubtitleDetection();
            trackSubtitleSelection();
            ensureSubtitleVisible();
            setTimeout(ensureSubtitleVisible, 400);
            // Don't auto-load subtitles to save memory - only load when user opens popup
            // This prevents tab crashes on TV shows with large subtitle files
        });
        
        player.on('loadedmetadata', () => {
            // Subtitles will load on-demand when popup is opened
            restoreSubtitleSelection();
            ensureSubtitleVisible();
        });
    </script>
</body>
</html>`;
  }

  getLightweightHTMLPlayer(videoUrl, htmlVideoType, videoName) {
    // Ultra-lightweight player with ZERO subtitle functionality
    // This eliminates ALL memory overhead from subtitle processing
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${videoName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            background: #000; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            font-family: Arial, sans-serif; 
        }
        .container { 
            width: 100%; 
            max-width: 1280px; 
            padding: 20px; 
        }
        video { 
            width: 100%; 
            height: auto; 
            background: #000; 
            outline: none;
        }
        .video-info { 
            margin-top: 10px; 
            color: #fff; 
            text-align: center; 
            font-size: 14px; 
        }
        .lightweight-badge {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(76, 175, 80, 0.9);
            color: #fff;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .memory-stats {
            position: fixed;
            top: 60px;
            right: 20px;
            background: rgba(0, 0, 0, 0.8);
            color: #4CAF50;
            padding: 10px;
            border-radius: 8px;
            font-size: 11px;
            font-family: monospace;
            z-index: 1000;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
            display: none;
        }
        .memory-stats.visible {
            display: block;
        }
        .memory-warning {
            color: #ff9800;
        }
        .memory-critical {
            color: #f44336;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="lightweight-badge">⚡ Lightweight Mode - No Subtitles</div>
    <div class="memory-stats" id="memoryStats">
        <div>Memory: <span id="memUsed">--</span> MB</div>
        <div>Status: <span id="memStatus">OK</span></div>
    </div>
    <div class="container">
        <video id="videoPlayer" controls preload="none" playsinline>
            <source src="${videoUrl}" ${htmlVideoType}>
            Your browser does not support the video tag.
        </video>
        <div class="video-info">
            <p>${videoName}</p>
            <p style="color: #4CAF50; font-size: 12px; margin-top: 5px;">
                🚀 Lightweight player for maximum performance
            </p>
        </div>
    </div>
    <script>
        // Minimal JavaScript - no subtitle processing, no memory overhead
        const video = document.getElementById('videoPlayer');
        const memoryStats = document.getElementById('memoryStats');
        const memUsed = document.getElementById('memUsed');
        const memStatus = document.getElementById('memStatus');
        
        // ENHANCED: Browser-side memory tracking with auto-cleanup
        let memoryCheckCount = 0;
        let lastCleanupTime = Date.now();
        const CLEANUP_INTERVAL = 60000; // Cleanup every 60 seconds if needed
        
        function trackMemory() {
            if (performance.memory) {
                memoryStats.classList.add('visible');
                
                setInterval(() => {
                    memoryCheckCount++;
                    const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
                    const limit = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
                    const percent = (used / limit) * 100;
                    
                    memUsed.textContent = used;
                    
                    // CRITICAL: Auto-cleanup when memory is high
                    if (percent > 80) {
                        memStatus.textContent = 'CRITICAL';
                        memStatus.className = 'memory-critical';
                        console.error('⚠️ CRITICAL: Memory usage at ' + percent.toFixed(1) + '%');
                        console.error('💡 Triggering emergency cleanup...');
                        
                        // Emergency cleanup: clear video buffer
                        if (video && !video.paused) {
                            const currentTime = video.currentTime;
                            // Force browser to release buffered data
                            video.load();
                            video.currentTime = currentTime;
                            video.play().catch(e => console.log('Playback resume failed:', e));
                        }
                        
                        // Clear any cached data
                        if (window.caches) {
                            caches.keys().then(names => {
                                names.forEach(name => caches.delete(name));
                            });
                        }
                    } else if (percent > 60) {
                        memStatus.textContent = 'WARNING';
                        memStatus.className = 'memory-warning';
                        console.warn('⚠️ Memory usage high: ' + percent.toFixed(1) + '%');
                        
                        // Preventive cleanup every minute when in warning zone
                        const now = Date.now();
                        if (now - lastCleanupTime > CLEANUP_INTERVAL) {
                            console.log('🧹 Running preventive cleanup...');
                            lastCleanupTime = now;
                            
                            // Reduce video buffer
                            if (video && video.buffered.length > 0) {
                                const currentTime = video.currentTime;
                                const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                                
                                // If buffered more than 30 seconds ahead, trigger cleanup
                                if (bufferedEnd - currentTime > 30) {
                                    console.log('🧹 Clearing excess buffer (' + (bufferedEnd - currentTime).toFixed(1) + 's ahead)');
                                    video.load();
                                    video.currentTime = currentTime;
                                    if (!video.paused) {
                                        video.play().catch(e => console.log('Playback resume failed:', e));
                                    }
                                }
                            }
                        }
                    } else {
                        memStatus.textContent = 'OK';
                        memStatus.className = '';
                    }
                    
                    // Log memory stats every 30 checks (~60 seconds)
                    if (memoryCheckCount % 30 === 0) {
                        console.log('📊 Memory: ' + used + 'MB / ' + limit + 'MB (' + percent.toFixed(1) + '%)');
                        if (video && video.buffered.length > 0) {
                            const bufferedSeconds = video.buffered.end(video.buffered.length - 1) - video.currentTime;
                            console.log('📦 Buffer: ' + bufferedSeconds.toFixed(1) + 's ahead');
                        }
                    }
                }, 2000); // Check every 2 seconds
            } else {
                console.log('Memory tracking not available in this browser');
            }
        }
        
        // Start memory tracking
        trackMemory();
        
        // Basic error handling
        video.addEventListener('error', (e) => {
            console.error('Video error:', e);
            console.error('If video fails to play, try:');
            console.error('1. Refresh the page');
            console.error('2. Use --low-memory flag');
            console.error('3. Use VLC instead: vlc http://localhost:8000/video.mp4');
        });
        
        // ENHANCED: Configure video for optimal memory usage
        video.addEventListener('loadedmetadata', () => {
            console.log('✅ Video loaded successfully');
            
            // Set preload to 'auto' but browser will respect memory constraints
            video.preload = 'auto';
            
            if (performance.memory) {
                const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
                console.log('📊 Memory usage: ' + used + ' MB');
            }
            
            console.log('🎬 Video duration: ' + (video.duration / 60).toFixed(1) + ' minutes');
        });
        
        // ENHANCED: Monitor buffer levels and prevent excessive buffering
        video.addEventListener('progress', () => {
            if (video.buffered.length > 0) {
                const bufferedEnd = video.buffered.end(video.buffered.length - 1);
                const bufferedSeconds = bufferedEnd - video.currentTime;
                
                // If buffered more than 60 seconds ahead, pause buffering temporarily
                // This prevents excessive memory usage from over-buffering
                if (bufferedSeconds > 60 && performance.memory) {
                    const percent = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
                    if (percent > 50) {
                        console.log('⚠️ Excessive buffering detected (' + bufferedSeconds.toFixed(1) + 's), memory at ' + percent.toFixed(1) + '%');
                    }
                }
            }
        });
        
        // Log playback events
        video.addEventListener('play', () => {
            console.log('▶️ Playback started');
        });
        
        video.addEventListener('pause', () => {
            console.log('⏸️ Playback paused');
        });
        
        // Warning before page close
        window.addEventListener('beforeunload', (e) => {
            if (!video.paused) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        
        // Log memory on visibility change (tab switch)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && performance.memory) {
                const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
                console.log('📊 Memory on tab focus: ' + used + ' MB');
            }
        });
        
        // That's it! Minimal code = minimal memory issues
    </script>
</body>
</html>`;
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

  destroy() {
    // Stop periodic cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clean up all active streams
    this.activeStreams.forEach(stream => {
      if (stream && !stream.destroyed) {
        stream.destroy();
      }
    });
    this.activeStreams.clear();
    
    this.stop();
    this.client.destroy();
    
    // SECURITY: Clean up sandbox
    if (this.sandbox) {
      this.sandbox.cleanup();
    }
  }
}

// Main CLI interface
async function main() {
  program
    .name('uplayer')
    .description('Uplayer - Simple torrent player. Search and play movies instantly')
    .version('1.0.0')
    .argument('[query]', 'Movie name to search and stream')
    .option('-m, --magnet <link>', 'Direct magnet link to stream')
    .option('-t, --torrent <file>', 'Torrent file path')
    .option('--no-open', 'Do not auto-open player')
    .option('--no-subtitles', 'Disable all subtitle features (reduces memory usage, prevents tab crashes)')
    .option('--low-memory', 'Ultra low-memory mode (limits connections, reduces buffer, minimal UI, periodic cleanup)')
    .option('--debug-memory', 'Enable detailed memory tracking and diagnostics (helps identify crash causes)')
    .option('--expose-gc', 'Enable garbage collection (run with: node --expose-gc stream.js)')
    .action(async (query, options) => {
      const lowMemoryMode = options.lowMemory === true;
      const debugMemory = options.debugMemory === true;
      
      // Initialize memory tracker if requested
      const memoryTracker = new MemoryTracker(debugMemory);
      
      const streamManager = new StreamManager(lowMemoryMode, memoryTracker);
      const scraper = new TorrentScraper();
      const mediaSearcher = new MediaSearcher();

      // Cleanup function to ensure proper resource cleanup
      const cleanup = (exitCode = 0) => {
        try {
          // Clear the progress line first to prevent terminal clutter
          process.stdout.write('\r\x1b[K');
          console.log(chalk.yellow('\n🛑 Stopping stream...'));
          if (memoryTracker) {
            memoryTracker.stop();
          }
          if (streamManager) {
            streamManager.destroy();
          }
        } catch (err) {
          // Ignore cleanup errors
        }
        process.exit(exitCode);
      };

      // Handle cleanup on all exit scenarios
      process.on('SIGINT', () => cleanup(0));
      process.on('SIGTERM', () => cleanup(0));
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
                { name: '🎬 Movie', value: 'movie' },
                { name: '📺 TV Show', value: 'tv' }
              ]
            }
          ]);
          const mediaType = typeAnswer.mediaType;

          // Search TMDB database using API only
          console.log(chalk.blue(`\n🔍 Searching TMDB database for: ${searchQuery}...`));
          let tmdbResults = [];
          
          try {
            if (mediaType === 'movie') {
              tmdbResults = await mediaSearcher.searchMovies(searchQuery);
            } else {
              tmdbResults = await mediaSearcher.searchTVShows(searchQuery);
            }
          } catch (error) {
            console.error(chalk.red(`\n❌ Error searching TMDB: ${error.message}`));
            console.log(chalk.yellow('💡 Falling back to direct torrent search...'));
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
            console.log(chalk.green(`\n✅ Selected: ${selectedMedia.displayTitle}`));
            
            // Use TMDB title for torrent search (without year - only title)
            searchQuery = selectedMedia.title;
            // Don't include year in search query - only title, season/episode filtered after search

            // For TV shows, get seasons and episodes from TMDB (like Elementum)
            if (mediaType === 'tv' && (selectedMedia.tmdbId || selectedMedia.id)) {
              const tvShowId = selectedMedia.tmdbId || selectedMedia.id;
              console.log(chalk.blue(`\n📺 Loading seasons for ${selectedMedia.title}...`));
              let seasons = [];
              try {
                seasons = await mediaSearcher.getTVShowSeasons(tvShowId);
              } catch (error) {
                console.error(chalk.red(`\n❌ Error loading seasons: ${error.message}`));
              }
              
              if (seasons.length > 0) {
                // Add "Last Season" option at the top
                const seasonChoices = [
                  { name: '📺 Last Season', value: 'last' },
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
                  console.log(chalk.cyan(`\n📋 Loading episodes for ${selectedSeason.displayName}...`));
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
                console.log(chalk.yellow('\n⚠️  Could not load seasons. Enter manually...'));
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
            console.log(chalk.yellow('\n⚠️  No results from TMDB. Using original search query...'));
          }

          // Search for torrents using only the show/movie name (filter by season/episode after)
          console.log(chalk.blue(`\n🔍 Searching torrents for: ${searchQuery}...`));
          const results = await scraper.searchAllSources(searchQuery, null, searchSeason, searchEpisode);
            
          if (results.length === 0) {
            console.error(chalk.red('\n❌ No torrents found. Try a different search term.'));
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
              name: `${r.name} | ${r.size} | 👥 ${r.seeders} | 📍 ${r.source}`,
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

          console.log(chalk.green(`\n✅ Selected: ${selectedResult.name}`));
          
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
                  { name: '🇬🇧 English', value: 'en' },
                  { name: '🇸🇦 Arabic', value: 'ar' },
                  { name: '🇪🇸 Spanish', value: 'es' },
                  { name: '🇫🇷 French', value: 'fr' },
                  { name: '🇩🇪 German', value: 'de' },
                  { name: '🇮🇹 Italian', value: 'it' },
                  { name: '🇵🇹 Portuguese', value: 'pt' },
                  { name: '🇷🇺 Russian', value: 'ru' },
                  { name: '🇨🇳 Chinese', value: 'zh' },
                  { name: '🇯🇵 Japanese', value: 'ja' },
                  { name: '🇰🇷 Korean', value: 'ko' }
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
            
            console.log(chalk.green(`✅ Selected language: ${languageNames[selectedLanguage]}`));
            
            const subtitleManager = new SubtitleManager();
            
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
              
              console.log(chalk.cyan(`💡 Using TMDB data for subtitles:`));
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
              console.log(chalk.cyan(`💡 No TMDB data - using search query: ${subtitleQuery} (${subtitleYear || 'N/A'})`));
            }
            
            // Build display query with year for user feedback
            const displayQuery = subtitleYear ? `${subtitleQuery} (${subtitleYear})` : subtitleQuery;
            if (subtitleSeason && subtitleEpisode) {
              console.log(chalk.blue(`\n🔍 Searching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery} S${subtitleSeason.toString().padStart(2, '0')}E${subtitleEpisode.toString().padStart(2, '0')}...`));
            } else {
              console.log(chalk.blue(`\n🔍 Searching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery}...`));
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
                name: `${s.title} | 🌐 ${s.language} | ⬇️ ${s.downloadCount} downloads`,
                value: i
              }));

              subtitleChoices.push({ name: '❌ Skip subtitles', value: -1 });

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
                
                console.log(chalk.cyan(`📥 Downloading subtitle from ${selectedSubtitle.source}...`));
                const downloaded = await subtitleManager.downloadSubtitle(
                  selectedSubtitle.fileId || selectedSubtitle.id,
                  subtitlePath,
                  selectedSubtitle.source,
                  selectedSubtitle.downloadUrl || selectedSubtitle.attributes?.addic7ed_url || selectedSubtitle.attributes?.subsplease_url
                );
                
                if (downloaded) {
                  console.log(chalk.green(`✅ Subtitle downloaded: ${subtitlePath}`));
                } else {
                  console.log(chalk.yellow(`⚠️  Failed to download subtitle`));
                  subtitlePath = null;
                }
              }
            } else {
              console.log(chalk.yellow(`⚠️  No subtitles found`));
            }
          }
          
          console.log(chalk.cyan(`📥 Getting magnet link...`));
          magnetLink = await scraper.getMagnetLink(selectedResult);
          
          // Store subtitle path for later use
          if (subtitlePath) {
            selectedResult.subtitlePath = subtitlePath;
          }
        }

        if (!magnetLink) {
          console.error(chalk.red('\n❌ Could not get magnet link.'));
          cleanup(1);
          return;
        }

        // Start streaming with subtitle if available
        await streamManager.stream(magnetLink, {
          openPlayer: options.open !== false,
          subtitlePath: selectedResult?.subtitlePath || null,
          disableSubtitles: options.subtitles === false  // Pass the --no-subtitles flag
        });
      }
    } catch (error) {
        // Handle user cancellation (Ctrl+C during prompts)
        if (error.isTtyError || error.name === 'ExitPromptError') {
          cleanup(0);
          return;
        }
        console.error(chalk.red(`\n❌ Error: ${error.message}`));
        cleanup(1);
      }
    });

  program.parse();
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { TorrentScraper, StreamManager, MediaSearcher, SubtitleManager };

