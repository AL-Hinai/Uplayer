'use strict';

const axios = require('axios');

class TmdbClient {
  constructor(apiKey, baseUrl = 'https://api.themoviedb.org/3') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  hasApiKey() {
    return !!(this.apiKey && String(this.apiKey).trim());
  }

  async get(endpoint, params = {}) {
    if (!this.hasApiKey()) {
      throw new Error('TMDB_API_KEY is required for TMDB API operations');
    }

    const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const res = await axios.get(`${this.baseUrl}${normalizedEndpoint}`, {
      params: { api_key: this.apiKey, ...params },
      timeout: 15000,
    });
    return res.data;
  }
}

function createTmdbClient(apiKey = process.env.TMDB_API_KEY) {
  return new TmdbClient(apiKey);
}

module.exports = {
  TmdbClient,
  createTmdbClient,
};
