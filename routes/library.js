'use strict';

// Library routes — watch history, watchlist, and recommendation signals/results. Reads and
// writes the history + recommendation stores (via the injected accessors) and enriches items
// from TMDB. Like the catalog routes, it touches NO stream session state.
//
// enrichHistoryItemFromTmdb lives here because these routes are its only caller.

function register(app, ctx) {
  const { tmdb, readHistory, getRecommendationService, getServices } = ctx;
  app.get('/api/history', (req, res) => {
    res.json(readHistory());
  });

  // Look up missing TMDB metadata (poster_path / backdrop_path) so history
  // items always have artwork. Multiple save paths (wizard auto-save, CLI
  // session persist, hero "mark watched") can race against the wizard's TMDB
  // detail fetch and otherwise persist an item with the artwork stripped.
  async function enrichHistoryItemFromTmdb(type, item) {
    if (!item || (item.poster_path && item.backdrop_path)) return item;
    const tmdbId = item.tmdbId || item.id;
    if (!tmdbId) return item;
    try {
      const detail = await tmdb(`/${type === 'movie' ? 'movie' : 'tv'}/${tmdbId}`);
      return {
        ...item,
        poster_path: item.poster_path || detail.poster_path || null,
        backdrop_path: item.backdrop_path || detail.backdrop_path || null,
        release_date: item.release_date || detail.release_date,
        first_air_date: item.first_air_date || detail.first_air_date,
        vote_average: item.vote_average != null ? item.vote_average : detail.vote_average,
      };
    } catch (e) {
      // Non-fatal — just keep what we have.
      return item;
    }
  }

  app.post('/api/history', async (req, res) => {
    try {
      const { type, item } = req.body || {};
      const tmdbId = item && (item.tmdbId || item.id);
      if (!type || !item || !tmdbId) {
        return res.status(400).json({ error: 'Missing type or item' });
      }

      const enriched = await enrichHistoryItemFromTmdb(type, item);
      const normalizedItem = {
        ...enriched,
        tmdbId,
        title: enriched.title || enriched.name || enriched.original_title || enriched.original_name || 'Unknown',
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

  // Timestamp-level playback progress from the player (every ~10s + on pause/
  // unload). Deliberately does NOT rebuild the recommendation profile — this is
  // called far too often for that; profile refresh stays on the coarser
  // markWatched paths.
  app.post('/api/history/progress', (req, res) => {
    try {
      const body = req.body || {};
      const { type, season, episode, positionSec, durationSec, item } = body;
      const tmdbId = body.tmdbId || (item && (item.tmdbId || item.id));
      if (!['movie', 'tv'].includes(type) || !tmdbId) {
        return res.status(400).json({ error: 'type (movie|tv) and tmdbId are required' });
      }
      // The noise floor lives here rather than in the caller. This endpoint is the one
      // history write that doesn't go through a PlaybackTarget (a direct-magnet cast play
      // has no session to attach one to), so without this it would be the only way a
      // 2-second playhead could reach "Continue Watching".
      if (Number(positionSec) < MIN_POSITION_SEC) return res.json({ ok: true, skipped: 'below floor' });
      const db = getServices().historyStore.updateProgress(type, tmdbId, {
        season, episode, positionSec, durationSec, item,
      });
      const saved = type === 'movie' ? db.movies[String(tmdbId)] : db.tvShows[String(tmdbId)];
      res.json({ ok: true, item: saved });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/history/tv/:id/tracking', (req, res) => {
    try {
      const { id } = req.params;
      const { tracking } = req.body || {};
      if (typeof tracking !== 'boolean') {
        return res.status(400).json({ error: 'tracking must be a boolean' });
      }
      const db = getServices().historyStore.setTracking(id, tracking);
      res.json({ ok: true, item: db.tvShows[String(id)] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // One-shot artwork backfill — sweeps current history and patches in missing
  // poster_path / backdrop_path from TMDB. The frontend calls this once when
  // the history page loads so previously-broken records get fixed without
  // requiring the user to re-watch anything.
  app.post('/api/history/backfill', async (req, res) => {
    try {
      const store = getServices().historyStore;
      const db = store.read();
      const buckets = [
        { type: 'movie', map: db.movies || {} },
        { type: 'tv', map: db.tvShows || {} },
      ];
      let fixed = 0;
      let attempted = 0;
      for (const { type, map } of buckets) {
        for (const id of Object.keys(map)) {
          const item = map[id];
          if (item && item.poster_path && item.backdrop_path) continue;
          attempted += 1;
          const enriched = await enrichHistoryItemFromTmdb(type, item);
          if (enriched && (enriched.poster_path !== item.poster_path || enriched.backdrop_path !== item.backdrop_path)) {
            map[id] = { ...item, ...enriched };
            fixed += 1;
          }
        }
      }
      if (fixed > 0) store.write(db);
      res.json({ ok: true, attempted, fixed });
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
      const shows = Object.values(db.tvShows).filter((s) => s.tracking !== false);
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

}

module.exports = { register };
