'use strict';

// Searches TMDB for movies and shows, with an HTML-scraper fallback for when the API key is
// absent or a title the API misses. The API path is the norm; the scraper path is the safety
// net. Season/episode listing lives here too, since it is the same TMDB surface.
//
// IO: HTTP to TMDB (via the injected client) and to scraper sites. No timers.

const axios = require('axios');
const cheerio = require('cheerio');
const chalk = require('chalk');
const { createTmdbClient } = require('./tmdb-client');

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

function createMediaSearcher(...args) {
  return new MediaSearcher(...args);
}

module.exports = { MediaSearcher, createMediaSearcher };
