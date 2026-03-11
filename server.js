'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TorrentScraper, SubtitleManager, StreamManager } = require('./uplayer.js');

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || 'aee3a88db6bb9228aec32784ef2dd1c1';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const HISTORY_FILE = path.join(os.homedir(), '.uplayer-history.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── History DB Helpers ───────────────────────────────────────────────────────

function readHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) { /* ignore corrupt file */ }
  return { movies: {}, tvShows: {} };
}

function writeHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ─── TMDB Helper ──────────────────────────────────────────────────────────────

async function tmdb(endpoint, params = {}) {
  const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
    params: { api_key: TMDB_API_KEY, ...params },
    timeout: 15000,
  });
  return res.data;
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Trending — type: all | movie | tv, window: day | week
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

// Search — q, type: multi | movie | tv, page
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

// Detail — type: movie | tv, id
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

// ─── History Routes ───────────────────────────────────────────────────────────

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.post('/api/history', (req, res) => {
  try {
    const { type, item } = req.body;
    if (!type || !item || !item.tmdbId) return res.status(400).json({ error: 'Missing type or item' });
    const db = readHistory();
    if (type === 'movie') {
      db.movies[String(item.tmdbId)] = { ...item, watchedAt: new Date().toISOString() };
    } else if (type === 'tv') {
      db.tvShows[String(item.tmdbId)] = { ...item, watchedAt: new Date().toISOString() };
    } else {
      return res.status(400).json({ error: 'type must be movie or tv' });
    }
    writeHistory(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/history/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    const db = readHistory();
    if (type === 'movie') delete db.movies[id];
    else if (type === 'tv') delete db.tvShows[id];
    writeHistory(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check for new episodes on tracked TV shows
app.get('/api/newEpisodes', async (req, res) => {
  try {
    const db = readHistory();
    const shows = Object.values(db.tvShows);
    if (shows.length === 0) return res.json([]);

    const updates = await Promise.all(
      shows.map(async (show) => {
        try {
          const detail = await tmdb(`/tv/${show.tmdbId}`);
          const latestSeason = detail.last_episode_to_air;
          if (!latestSeason) return null;

          const lastS = show.lastSeason || 0;
          const lastE = show.lastEpisode || 0;
          const newS = latestSeason.season_number;
          const newE = latestSeason.episode_number;

          const hasNew = newS > lastS || (newS === lastS && newE > lastE);
          if (!hasNew) return null;

          return {
            tmdbId: show.tmdbId,
            title: show.title || detail.name,
            poster_path: show.poster_path || detail.poster_path,
            lastWatchedSeason: lastS,
            lastWatchedEpisode: lastE,
            latestSeason: newS,
            latestEpisode: newE,
            latestEpisodeName: latestSeason.name,
            latestAirDate: latestSeason.air_date,
          };
        } catch (e) {
          return null;
        }
      })
    );

    res.json(updates.filter(Boolean));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Personalised recommendations based on watch history
app.get('/api/recommendations', async (req, res) => {
  try {
    const db = readHistory();
    const type = req.query.type; // movie | tv | undefined (both)
    const page = parseInt(req.query.page) || 1;

    const movieIds = Object.keys(db.movies);
    const tvIds = Object.keys(db.tvShows);

    // Pick up to 5 seeds from history (most recently watched first)
    const movieSeeds = Object.values(db.movies)
      .sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt))
      .slice(0, 5)
      .map((m) => ({ id: m.tmdbId, type: 'movie' }));

    const tvSeeds = Object.values(db.tvShows)
      .sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt))
      .slice(0, 5)
      .map((s) => ({ id: s.tmdbId, type: 'tv' }));

    let seeds = [];
    if (type === 'movie') seeds = movieSeeds;
    else if (type === 'tv') seeds = tvSeeds;
    else seeds = [...movieSeeds, ...tvSeeds];

    if (seeds.length === 0) {
      // Fallback: trending
      const fallback = await tmdb(`/trending/${type || 'all'}/week`, { page });
      return res.json({ results: fallback.results, total_pages: fallback.total_pages, source: 'trending' });
    }

    // Fetch recommendations from each seed in parallel
    const allRecs = await Promise.all(
      seeds.map(async (seed) => {
        try {
          const d = await tmdb(`/${seed.type}/${seed.id}/recommendations`, { page: 1 });
          return (d.results || []).map((r) => ({ ...r, media_type: seed.type }));
        } catch (e) {
          return [];
        }
      })
    );

    // Flatten, deduplicate, remove already-watched
    const seen = new Set([...movieIds, ...tvIds]);
    const unique = new Map();
    for (const list of allRecs) {
      for (const item of list) {
        const key = `${item.media_type}-${item.id}`;
        if (!seen.has(String(item.id)) && !unique.has(key)) {
          unique.set(key, item);
        }
      }
    }

    let results = Array.from(unique.values());

    // Apply optional filters
    if (req.query.genre) {
      const g = parseInt(req.query.genre);
      results = results.filter((r) => (r.genre_ids || []).includes(g));
    }
    if (req.query.minRating) {
      results = results.filter((r) => r.vote_average >= parseFloat(req.query.minRating));
    }
    if (req.query.yearFrom) {
      results = results.filter((r) => {
        const yr = parseInt((r.release_date || r.first_air_date || '').slice(0, 4));
        return yr >= parseInt(req.query.yearFrom);
      });
    }
    if (req.query.yearTo) {
      results = results.filter((r) => {
        const yr = parseInt((r.release_date || r.first_air_date || '').slice(0, 4));
        return yr <= parseInt(req.query.yearTo);
      });
    }

    // Sort by vote_average desc, then paginate
    results.sort((a, b) => b.vote_average - a.vote_average);
    const perPage = 20;
    const totalPages = Math.ceil(results.length / perPage);
    const paged = results.slice((page - 1) * perPage, page * perPage);

    res.json({ results: paged, total_pages: totalPages, source: 'history' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Streaming Session Store ──────────────────────────────────────────────────

const streamSessions = new Map();
let sessionCounter = 0;

function broadcastToSession(sessionId, event, data) {
  const session = streamSessions.get(sessionId);
  if (!session) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  session.clients = session.clients.filter((client) => {
    try { client.write(msg); return true; } catch (e) { return false; }
  });
  session.buffer.push({ event, data });
  if (session.buffer.length > 500) session.buffer.shift();
}

// ─── Torrent Search ───────────────────────────────────────────────────────────

app.post('/api/torrents/search', async (req, res) => {
  try {
    const { title, type, season, episode } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const scraper = new TorrentScraper();
    const results = await scraper.searchAllSources(
      title,
      null,
      season != null ? Number(season) : null,
      episode != null ? Number(episode) : null
    );

    // Sort by seeders descending, take top 20
    const sorted = results
      .filter((r) => r && r.name)
      .sort((a, b) => (parseInt(b.seeders) || 0) - (parseInt(a.seeders) || 0))
      .slice(0, 20);

    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve magnet link from a torrent result
app.post('/api/torrents/magnet', async (req, res) => {
  try {
    const { torrent } = req.body;
    if (!torrent) return res.status(400).json({ error: 'torrent required' });
    const scraper = new TorrentScraper();
    const magnet = await scraper.getMagnetLink(torrent);
    if (!magnet) return res.status(404).json({ error: 'Could not resolve magnet link' });
    res.json({ magnet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Subtitle Routes ──────────────────────────────────────────────────────────

const SUBTITLE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

app.get('/api/subtitles/languages', (req, res) => {
  res.json(SUBTITLE_LANGUAGES);
});

app.post('/api/subtitles/search', async (req, res) => {
  try {
    const { title, type, season, episode, year, tmdbId, language } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const manager = new SubtitleManager();
    const results = await manager.searchSubtitles(
      title,
      language || 'en',
      season != null ? Number(season) : null,
      episode != null ? Number(episode) : null,
      year || null,
      tmdbId || null,
      type || null
    );
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/subtitles/download', async (req, res) => {
  try {
    const { subtitle } = req.body;
    if (!subtitle) return res.status(400).json({ error: 'subtitle required' });

    const tmpDir = path.join(os.tmpdir(), 'uplayer-subs');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const ext = subtitle.source === 'SubsPlease' || subtitle.source === 'Addic7ed' ? '.srt' : '.srt';
    const filename = `sub_${Date.now()}${ext}`;
    const outputPath = path.join(tmpDir, filename);

    const manager = new SubtitleManager();
    const ok = await manager.downloadSubtitle(
      subtitle.id,
      outputPath,
      subtitle.source,
      subtitle.downloadUrl || subtitle.attributes?.subsplease_url || null
    );

    if (!ok || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Subtitle download failed' });
    }

    res.json({ path: outputPath, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Stream Management ────────────────────────────────────────────────────────

// Start a new stream session — runs StreamManager in-process (no child process spawn)
app.post('/api/stream/start', async (req, res) => {
  try {
    const { magnet, subtitlePath, noSubtitles } = req.body;
    if (!magnet) return res.status(400).json({ error: 'magnet required' });

    // Destroy any existing stream sessions
    for (const [id, session] of streamSessions.entries()) {
      if (session.streamManager) {
        try { await session.streamManager.destroy(); } catch (e) { /* ignore */ }
      }
      streamSessions.delete(id);
    }

    const sessionId = `stream_${++sessionCounter}_${Date.now()}`;
    const session = {
      id: sessionId,
      streamManager: null,
      clients: [],
      buffer: [],
      playerUrl: null,
      started: Date.now(),
    };
    streamSessions.set(sessionId, session);

    // Instantiate StreamManager directly in the same process
    const sm = new StreamManager();
    session.streamManager = sm;

    sm.on('line', (data) => broadcastToSession(sessionId, 'line', data));

    sm.on('progress', (data) => broadcastToSession(sessionId, 'progress', data));

    sm.on('player_ready', (data) => {
      const s = streamSessions.get(sessionId);
      if (s && !s.playerUrl) {
        s.playerUrl = data.url;
        broadcastToSession(sessionId, 'player_ready', data);
      }
    });

    sm.on('exit', (data) => {
      broadcastToSession(sessionId, 'exit', data);
      streamSessions.delete(sessionId);
    });

    // Run stream non-blocking — resolves when player server is ready
    sm.stream(magnet, {
      openPlayer: false,
      subtitlePath: subtitlePath && fs.existsSync(subtitlePath) ? subtitlePath : null,
      disableSubtitles: !!noSubtitles,
    }).then(({ url }) => {
      // player_ready already emitted via EventEmitter; ensure session has URL
      const s = streamSessions.get(sessionId);
      if (s && !s.playerUrl) {
        s.playerUrl = url;
        broadcastToSession(sessionId, 'player_ready', { url });
      }
    }).catch((err) => {
      broadcastToSession(sessionId, 'line', { text: `Error: ${err.message}` });
      broadcastToSession(sessionId, 'exit', { code: 1 });
      streamSessions.delete(sessionId);
    });

    res.json({ sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSE output stream for a session
app.get('/api/stream/output/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = streamSessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered output to new client
  for (const msg of session.buffer) {
    res.write(`event: ${msg.event}\ndata: ${JSON.stringify(msg.data)}\n\n`);
  }

  // If player is already ready, send it again
  if (session.playerUrl) {
    res.write(`event: player_ready\ndata: ${JSON.stringify({ url: session.playerUrl })}\n\n`);
  }

  session.clients.push(res);

  req.on('close', () => {
    session.clients = session.clients.filter((c) => c !== res);
  });
});

// Stop a stream — destroy StreamManager (closes WebTorrent + port 8000 server)
app.delete('/api/stream/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = streamSessions.get(sessionId);
  if (session) {
    if (session.streamManager) {
      try { await session.streamManager.destroy(); } catch (e) { /* ignore */ }
      session.streamManager = null;
    }
    broadcastToSession(sessionId, 'exit', { code: 0 });
    streamSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

// Stop all streams
app.delete('/api/stream/kill-all', async (req, res) => {
  for (const [id, session] of streamSessions.entries()) {
    if (session.streamManager) {
      try { await session.streamManager.destroy(); } catch (e) { /* ignore */ }
    }
    broadcastToSession(id, 'exit', { code: 0 });
  }
  streamSessions.clear();
  res.json({ ok: true });
});

// Status of all sessions
app.get('/api/stream/status', (req, res) => {
  const active = [];
  for (const [id, session] of streamSessions.entries()) {
    active.push({
      id,
      running: !!session.streamManager,
      playerUrl: session.playerUrl,
      started: session.started,
    });
  }
  res.json(active);
});

// ─── SPA Catch-all ────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  Uplayer Web GUI running at http://localhost:${PORT}\n`);
});

module.exports = app;
