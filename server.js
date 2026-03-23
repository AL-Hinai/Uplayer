'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnvFileOnce } = require('./core/config');
const { createSharedServices } = require('./core/shared-services');
const { StreamLifecycleState } = require('./core/stream-lifecycle');
const { buildAccessibleUrls } = require('./core/network-address');

loadEnvFileOnce();

const app = express();
const PLAYER_MODE = 'native-js';
let services = null;
let servicesWarningsShown = false;

function getServices() {
  if (services) return services;
  const { TorrentScraper, SubtitleManager, StreamManager } = require('./uplayer.js');
  services = createSharedServices({
    constructors: {
      TorrentScraper,
      SubtitleManager,
      StreamManager,
    },
  });
  if (!servicesWarningsShown) {
    for (const warning of services.runtime.warnings) {
      console.warn(warning);
    }
    servicesWarningsShown = true;
  }
  return services;
}

const PORT = getServices().runtime.config.port || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- History DB Helpers -------------------------------------------------------

function readHistory() {
  return getServices().historyStore.read();
}

function writeHistory(data) {
  getServices().historyStore.write(data);
}

function getRecommendationService() {
  return getServices().recommendationService;
}

// --- TMDB Helper --------------------------------------------------------------

async function tmdb(endpoint, params = {}) {
  return getServices().tmdbClient.get(endpoint, params);
}

// --- API Routes ---------------------------------------------------------------

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

// --- History Routes -----------------------------------------------------------

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.post('/api/history', (req, res) => {
  try {
    const { type, item } = req.body || {};
    const tmdbId = item && (item.tmdbId || item.id);
    if (!type || !item || !tmdbId) {
      return res.status(400).json({ error: 'Missing type or item' });
    }

    const normalizedItem = {
      ...item,
      tmdbId,
      title: item.title || item.name || item.original_title || item.original_name || 'Unknown',
    };

    const db = getServices().historyStore.markWatched(type, normalizedItem);
    try {
      getRecommendationService().buildAndPersistProfile();
    } catch (profileError) {
      console.warn('Failed to refresh recommendation profile after history save:', profileError.message);
    }
    const savedItem = type === 'movie'
      ? db.movies[String(tmdbId)]
      : db.tvShows[String(tmdbId)];

    res.json({ ok: true, item: savedItem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/history/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    getServices().historyStore.remove(type, id);
    try {
      getRecommendationService().buildAndPersistProfile();
    } catch (profileError) {
      console.warn('Failed to refresh recommendation profile after history delete:', profileError.message);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/watchlist', (req, res) => {
  try {
    res.json(getRecommendationService().getWatchlist());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const { type, tmdbId, item, metadata } = req.body || {};
    const resolvedType = type === 'tv' ? 'tv' : type === 'movie' ? 'movie' : null;
    const resolvedId = tmdbId || item?.tmdbId || item?.id || metadata?.tmdbId || metadata?.id;
    if (!resolvedType || !resolvedId) {
      return res.status(400).json({ error: 'type and tmdbId are required' });
    }

    const saved = await getRecommendationService().addWatchlist({
      type: resolvedType,
      tmdbId: resolvedId,
      item,
      metadata,
    });
    res.json({
      ok: true,
      item: saved.item,
      profile: getRecommendationService().summarizeProfile(saved.profile),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/watchlist/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    if (!['movie', 'tv'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    const removed = getRecommendationService().removeWatchlist(type, id);
    res.json({
      ok: true,
      removed: !!removed.removed,
      item: removed.item || null,
      profile: getRecommendationService().summarizeProfile(removed.profile || {}),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recommendations/event', async (req, res) => {
  try {
    const { eventType, type, tmdbId, metadata } = req.body || {};
    if (!eventType || !['movie', 'tv'].includes(type) || !tmdbId) {
      return res.status(400).json({ error: 'eventType, type, and tmdbId are required' });
    }
    const recorded = await getRecommendationService().recordEvent({
      eventType,
      type,
      tmdbId,
      metadata,
    });
    res.json({
      ok: true,
      interaction: recorded.interaction,
      profile: getRecommendationService().summarizeProfile(recorded.profile),
    });
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
    const filters = {
      type: ['movie', 'tv'].includes(req.query.type) ? req.query.type : '',
      genre: req.query.genre ? String(req.query.genre) : '',
      minRating: req.query.minRating ? String(req.query.minRating) : '',
      yearFrom: req.query.yearFrom ? String(req.query.yearFrom) : '',
      yearTo: req.query.yearTo ? String(req.query.yearTo) : '',
    };
    const data = await getRecommendationService().getRecommendations(filters);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Streaming Session Store --------------------------------------------------

const streamSessions = new Map();
let sessionCounter = 0;
const STREAM_CLEANUP_DELAY_MS = 15000;
const LEGACY_STREAM_FIELDS = ['subtitlePath', 'playerMode', 'noSubtitles'];

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

function createStreamSession() {
  const sessionId = `stream_${++sessionCounter}_${Date.now()}`;
  const session = {
    id: sessionId,
    streamManager: null,
    clients: [],
    buffer: [],
    started: Date.now(),
    mode: PLAYER_MODE,
    destroyPromise: null,
    cleanupTimer: null,
    exitedAt: null,
    history: null,
    historySaved: false,
  };
  session.lifecycle = new StreamLifecycleState((event, data) => {
    broadcastToSession(sessionId, event, data);
  });
  return session;
}

function scheduleSessionCleanup(sessionId, delayMs = STREAM_CLEANUP_DELAY_MS) {
  const session = streamSessions.get(sessionId);
  if (!session) return;
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  session.cleanupTimer = setTimeout(() => {
    const current = streamSessions.get(sessionId);
    if (current && current.lifecycle && current.lifecycle.exited) {
      streamSessions.delete(sessionId);
    }
  }, delayMs);
}

function failStartRequest(res, message) {
  return res.status(400).json({ error: message });
}

function validateStreamStartBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Invalid request body' };
  }

  const legacyFieldsUsed = LEGACY_STREAM_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field)
  );
  if (legacyFieldsUsed.length > 0) {
    return {
      error: `Legacy fields are not supported: ${legacyFieldsUsed.join(', ')}`,
    };
  }

  if (!body.magnet || !String(body.magnet).trim()) {
    return { error: 'magnet required' };
  }

  if (
    typeof body.subtitleToken !== 'undefined' &&
    body.subtitleToken !== null &&
    typeof body.subtitleToken !== 'string'
  ) {
    return { error: 'subtitleToken must be a string' };
  }

  let history = null;
  if (typeof body.history !== 'undefined' && body.history !== null) {
    const historyType = body.history.type;
    const historyItem = body.history.item;
    const historyTmdbId = historyItem && (historyItem.tmdbId || historyItem.id);

    if (!['movie', 'tv'].includes(historyType)) {
      return { error: 'history.type must be movie or tv' };
    }

    if (!historyItem || !historyTmdbId) {
      return { error: 'history.item.tmdbId is required' };
    }

    history = {
      type: historyType,
      item: {
        ...historyItem,
        tmdbId: historyTmdbId,
        title: historyItem.title || historyItem.name || historyItem.original_title || historyItem.original_name || 'Unknown',
      },
    };
  }

  return {
    magnet: String(body.magnet),
    subtitleToken: body.subtitleToken ? String(body.subtitleToken) : null,
    history,
  };
}

function persistSessionHistory(session) {
  if (!session || session.historySaved || !session.history) return null;
  const { type, item } = session.history;
  const db = getServices().historyStore.markWatched(type, item);
  try {
    getRecommendationService().buildAndPersistProfile();
  } catch (profileError) {
    console.warn('Failed to refresh recommendation profile after stream history save:', profileError.message);
  }
  session.historySaved = true;
  return type === 'movie'
    ? db.movies[String(item.tmdbId)]
    : db.tvShows[String(item.tmdbId)];
}

async function destroySession(sessionId, code = 0) {
  const session = streamSessions.get(sessionId);
  if (!session) return false;
  if (session.destroyPromise) {
    await session.destroyPromise;
    return true;
  }

  session.destroyPromise = (async () => {
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    const sm = session.streamManager;
    session.streamManager = null;
    if (sm) {
      try {
        await sm.destroy();
      } catch (e) {
        // Ignore teardown failures so API stop remains reliable.
      }
    }

    session.lifecycle.exit(code);
    session.exitedAt = Date.now();
    streamSessions.delete(sessionId);
  })();

  await session.destroyPromise;
  return true;
}

async function destroyAllSessions(code = 0) {
  const ids = Array.from(streamSessions.keys());
  for (const id of ids) {
    await destroySession(id, code);
  }
}

// --- Torrent Search -----------------------------------------------------------

app.post('/api/torrents/search', async (req, res) => {
  try {
    const { title, type, season, episode } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const scraper = getServices().createTorrentScraper();
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
    const scraper = getServices().createTorrentScraper();
    const magnet = await scraper.getMagnetLink(torrent);
    if (!magnet) return res.status(404).json({ error: 'Could not resolve magnet link' });
    res.json({ magnet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Subtitle Routes ----------------------------------------------------------

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

    const manager = getServices().createSubtitleManager();
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

    const manager = getServices().createSubtitleManager();
    const subtitleId = subtitle.fileId || subtitle.id;
    const ok = await manager.downloadSubtitle(
      subtitleId,
      outputPath,
      subtitle.source,
      subtitle.downloadUrl || subtitle.attributes?.subsplease_url || subtitle.attributes?.addic7ed_url || null
    );

    if (!ok || !fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Subtitle download failed' });
    }

    const tokenMeta = getServices().subtitleTokenStore.issueWithMetadata(outputPath);
    res.json({
      filename,
      subtitleToken: tokenMeta.token,
      tokenExpiresAt: tokenMeta.expiresAt,
      tokenTtlMs: tokenMeta.ttlMs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Stream Management --------------------------------------------------------

// Start a new stream session ? runs StreamManager in-process (no child process spawn)
app.post('/api/stream/start', async (req, res) => {
  try {
    const parsed = validateStreamStartBody(req.body);
    if (parsed.error) return failStartRequest(res, parsed.error);

    let resolvedSubtitlePath = null;
    if (parsed.subtitleToken) {
      const byToken = getServices().subtitleTokenStore.resolve(parsed.subtitleToken);
      if (!byToken || !fs.existsSync(byToken)) {
        return failStartRequest(res, 'Invalid or expired subtitle token');
      }
      resolvedSubtitlePath = byToken;
    }

    // Single active stream policy: start request replaces any running session.
    await destroyAllSessions(0);

    const session = createStreamSession();
    session.history = parsed.history;
    if (parsed.history && parsed.history.type && parsed.history.item && parsed.history.item.tmdbId) {
      try {
        await getRecommendationService().recordEvent({
          eventType: 'stream_start',
          type: parsed.history.type,
          tmdbId: parsed.history.item.tmdbId,
          metadata: parsed.history.item,
        });
      } catch (eventError) {
        console.warn('Failed to record stream_start recommendation signal:', eventError.message);
      }
    }
    persistSessionHistory(session);
    streamSessions.set(session.id, session);

    const sm = getServices().createStreamManager();
    session.streamManager = sm;

    sm.on('line', (data) => {
      const text = data && data.text ? data.text : '';
      session.lifecycle.line(text);
    });

    sm.on('progress', (data) => {
      session.lifecycle.progress(data);
    });

    sm.on('player_ready', (data) => {
      const url = data && data.url ? data.url : null;
      if (url) {
        persistSessionHistory(session);
        session.lifecycle.playerReady(url);
      }
    });

    sm.on('exit', (data) => {
      const code = data && Number.isFinite(Number(data.code)) ? Number(data.code) : 0;
      session.streamManager = null;
      session.lifecycle.exit(code);
      session.exitedAt = Date.now();
      scheduleSessionCleanup(session.id);
    });

    sm.stream(parsed.magnet, {
      openPlayer: false,
      subtitlePath: resolvedSubtitlePath,
    }).then(({ url }) => {
      if (url) {
        persistSessionHistory(session);
        session.lifecycle.playerReady(url);
      }
    }).catch((err) => {
      session.lifecycle.line(`Error: ${err.message}`);
      session.streamManager = null;
      session.lifecycle.exit(1);
      session.exitedAt = Date.now();
      scheduleSessionCleanup(session.id);
    });

    res.json({ sessionId: session.id, mode: PLAYER_MODE });
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
  const lifecycleStatus = session.lifecycle ? session.lifecycle.status() : { playerUrl: null };
  if (lifecycleStatus.playerUrl) {
    res.write(`event: player_ready\ndata: ${JSON.stringify({ url: lifecycleStatus.playerUrl })}\n\n`);
  }

  session.clients.push(res);

  req.on('close', () => {
    session.clients = session.clients.filter((c) => c !== res);
  });
});

// Stop a stream ? destroy StreamManager (closes WebTorrent + port 8000 server)
app.delete('/api/stream/stop/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  await destroySession(sessionId, 0);
  res.json({ ok: true });
});

// Stop all streams
app.delete('/api/stream/kill-all', async (req, res) => {
  await destroyAllSessions(0);
  res.json({ ok: true });
});

// Status of all sessions
app.get('/api/stream/status', (req, res) => {
  const active = [];
  for (const [id, session] of streamSessions.entries()) {
    const lifecycleStatus = session.lifecycle ? session.lifecycle.status() : { playerUrl: null, exited: false };
    active.push({
      id,
      running: !!session.streamManager && !lifecycleStatus.exited,
      playerUrl: lifecycleStatus.playerUrl,
      started: session.started,
      mode: session.mode || PLAYER_MODE,
      exited: !!lifecycleStatus.exited,
      exitedAt: session.exitedAt,
    });
  }
  res.json(active);
});

// --- SPA Catch-all ------------------------------------------------------------

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start --------------------------------------------------------------------

let activeServer = null;

function getServerUrl(server = activeServer) {
  if (!server || !server.listening) return null;
  const addr = server.address();
  const resolvedPort = addr && typeof addr === 'object' ? addr.port : PORT;
  return buildAccessibleUrls(resolvedPort).preferred;
}

function startServer(port = PORT) {
  if (activeServer && activeServer.listening) {
    const addr = activeServer.address();
    const activePort = addr && typeof addr === 'object' ? addr.port : port;
    if (port === activePort) {
      return activeServer;
    }
    throw new Error(`Uplayer web server is already running on port ${activePort}`);
  }

  const server = app.listen(port, buildAccessibleUrls(port).bindHost);
  activeServer = server;

  server.once('listening', () => {
    const resolvedUrl = getServerUrl(server);
    console.log(`\n  Uplayer Web GUI running at ${resolvedUrl}\n`);
  });

  server.once('close', () => {
    if (activeServer === server) {
      activeServer = null;
    }
  });

  server.once('error', () => {
    if (activeServer === server) {
      activeServer = null;
    }
  });

  return server;
}

async function stopServer() {
  if (!activeServer) return;
  const server = activeServer;
  await destroyAllSessions(0);
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = app;
module.exports.app = app;
module.exports.startServer = startServer;
module.exports.stopServer = stopServer;
module.exports.getServerUrl = getServerUrl;

