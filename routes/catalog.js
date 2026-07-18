'use strict';

// TMDB catalog routes — trending, search, detail, recommendations, discover, genres, seasons,
// popular/top-rated/now-playing. Thin proxies over the TMDB client; they touch NO stream
// session state, which is why they were the first clean lift-out of the server.js split.
//
// register(app, ctx) is the route-module contract: dependencies arrive in ctx (injected, per
// the core/ convention) instead of each handler reaching for a module global.

function register(app, ctx) {
  const { tmdb } = ctx;
  // Trending ? type: all | movie | tv, window: day | week
  app.get('/api/trending', async (req, res) => {
    try {
      const type = ['all', 'movie', 'tv'].includes(req.query.type) ? req.query.type : 'all';
      const win = req.query.window === 'day' ? 'day' : 'week';
      const data = await tmdb(`/trending/${type}/${win}`);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Search ? q, type: multi | movie | tv, page
  app.get('/api/search', async (req, res) => {
    try {
      const q = req.query.q || '';
      const type = ['movie', 'tv'].includes(req.query.type) ? req.query.type : 'multi';
      const page = parseInt(req.query.page) || 1;
      if (!q.trim()) return res.json({ results: [], total_pages: 0, total_results: 0 });
      const data = await tmdb(`/search/${type}`, { query: q, page });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Detail ? type: movie | tv, id
  app.get('/api/detail/:type/:id', async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
      const data = await tmdb(`/${type}/${id}`, {
        append_to_response: 'credits,videos,external_ids',
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Recommendations for a specific item
  app.get('/api/:type/:id/recommendations', async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
      const data = await tmdb(`/${type}/${id}/recommendations`, { page: req.query.page || 1 });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Similar items
  app.get('/api/:type/:id/similar', async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!['movie', 'tv'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
      const data = await tmdb(`/${type}/${id}/similar`, { page: req.query.page || 1 });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Discover with filters
  app.get('/api/discover', async (req, res) => {
    try {
      const type = req.query.type === 'tv' ? 'tv' : 'movie';
      const params = {
        page: parseInt(req.query.page) || 1,
        sort_by: req.query.sort || 'popularity.desc',
      };
      if (req.query.genre) params.with_genres = req.query.genre;
      if (req.query.year) {
        if (type === 'movie') params.primary_release_year = req.query.year;
        else params.first_air_date_year = req.query.year;
      }
      if (req.query.minRating) params['vote_average.gte'] = req.query.minRating;
      if (req.query.maxRating) params['vote_average.lte'] = req.query.maxRating;
      if (req.query.yearFrom) {
        if (type === 'movie') params['primary_release_date.gte'] = `${req.query.yearFrom}-01-01`;
        else params['first_air_date.gte'] = `${req.query.yearFrom}-01-01`;
      }
      if (req.query.yearTo) {
        if (type === 'movie') params['primary_release_date.lte'] = `${req.query.yearTo}-12-31`;
        else params['first_air_date.lte'] = `${req.query.yearTo}-12-31`;
      }
      const data = await tmdb(`/discover/${type}`, params);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Genres
  app.get('/api/genres', async (req, res) => {
    try {
      const [movies, tv] = await Promise.all([
        tmdb('/genre/movie/list'),
        tmdb('/genre/tv/list'),
      ]);
      res.json({ movie: movies.genres, tv: tv.genres });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // TV Season episodes
  app.get('/api/tv/:id/season/:n', async (req, res) => {
    try {
      const data = await tmdb(`/tv/${req.params.id}/season/${req.params.n}`);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Popular people
  app.get('/api/popular', async (req, res) => {
    try {
      const type = req.query.type === 'tv' ? 'tv' : 'movie';
      const data = await tmdb(`/${type}/popular`, { page: req.query.page || 1 });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Top Rated
  app.get('/api/top-rated', async (req, res) => {
    try {
      const type = req.query.type === 'tv' ? 'tv' : 'movie';
      const data = await tmdb(`/${type}/top_rated`, { page: req.query.page || 1 });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Now Playing / On The Air
  app.get('/api/now-playing', async (req, res) => {
    try {
      const type = req.query.type === 'tv' ? 'tv' : 'movie';
      const endpoint = type === 'tv' ? '/tv/on_the_air' : '/movie/now_playing';
      const data = await tmdb(endpoint, { page: req.query.page || 1 });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

}

module.exports = { register };
