'use strict';

const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { loadEnvFileOnce, setConfigValues, getConfigStatus, getRuntimeConfig, getEnv } = require('./core/config');
const { createSharedServices } = require('./core/shared-services');
const { StreamLifecycleState } = require('./core/stream-lifecycle');
const { PlaybackTarget, MIN_POSITION_SEC } = require('./core/playback-target');
const { buildAccessibleUrls, getLocalIPv4Address } = require('./core/network-address');
const { createSessionRegistry } = require('./core/session-registry');
const dlna = require('./core/dlna-caster');

// Resilient global error handling — a streaming server must survive client
// disconnects and transient stream errors instead of crashing the whole app.
// (Node crashes on an unhandled rejection unless a handler is present.)
function isBenignStreamError(e) {
  const c = e && e.code;
  return c === 'EPIPE' || c === 'ECONNRESET' || c === 'ERR_STREAM_DESTROYED'
    || c === 'ERR_STREAM_PREMATURE_CLOSE' || c === 'ECONNABORTED';
}
process.on('unhandledRejection', (reason) => {
  if (isBenignStreamError(reason)) return;
  console.error('[uplayer] unhandledRejection (kept alive):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  if (isBenignStreamError(err)) return;
  console.error('[uplayer] uncaughtException (kept alive):', err && err.stack ? err.stack : err);
});

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

// Deliberately a function, not a const. As a const this ran getServices() at module load,
// which does require('./uplayer.js') — so merely importing server.js dragged in the whole CLI
// and resolved the server<->uplayer cycle at import time, defeating the point of getServices()
// being lazy at all. Nothing else here needs the port before startServer() is called.
// tests/module-graph.test.js pins this: it asserts uplayer.js is absent from require.cache
// after requiring server.js.
function getPort() {
  return getServices().runtime.config.port || 3000;
}
const VLC_DOWNLOAD_URL = 'https://www.videolan.org/vlc/';

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

// TMDB catalog routes live in routes/catalog.js (no session state).
require('./routes/catalog').register(app, { tmdb });

// --- History Routes -----------------------------------------------------------

require('./routes/library').register(app, { tmdb, readHistory, getRecommendationService, getServices });

// --- Streaming Session Store --------------------------------------------------

const streamSessions = new Map();
// The registry wraps the SAME Map (identity preserved for the ~19 direct call sites and for
// _internals.streamSessions, which tests/vlc-progress.test.js mutates directly). It exists to
// give "the current stream" one definition instead of five hand-copied ones. onEvent surfaces
// the case the single-stream invariant says can't happen — two active sessions at once.
const sessionRegistry = createSessionRegistry({
  sessions: streamSessions,
  onEvent: (event, payload) => {
    if (event === 'multiple-active-sessions') {
      console.warn(`Multiple active stream sessions (${payload.count}): ${payload.ids.join(', ')}`);
    }
  },
});
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
    playerUrl: null,
    vlcUrl: null,
    castUrl: null,
    subtitleManifestUrl: null,
    playerUrls: null,
    mediaUrls: null,
    castUrls: null,
    subtitleManifestUrls: null,
    videoFormat: null,
    mediaFacts: null,
    streamHealth: null,
    targets: [],
    // One entry per playback target, keyed 'web' | 'vlc' | 'dlna:<deviceId>' | 'cast'.
    // Was a single timer slot, which meant casting to a TV silently stopped an
    // unrelated session's VLC tracking — targets are independent and now tracked so.
    playbackTargets: new Map(),
  };
  session.lifecycle = new StreamLifecycleState((event, data) => {
    broadcastToSession(sessionId, event, data);
  });
  return session;
}

// Session player-URL resolution moved to core/session-player-state.js so it can be
// require()d and unit-tested directly. resolveOpenableSession takes the registry Map as its
// first argument now (it used to reach the streamSessions module global); server.js binds it
// below so existing call sites keep the single-argument shape.
const {
  applySessionPlayerReady,
  getSessionPlayerState,
  resolveOpenableSession: resolveOpenableSessionIn,
} = require('./core/session-player-state.js');

function resolveOpenableSession(sessionId) {
  return resolveOpenableSessionIn(streamSessions, sessionId);
}

// `http` (optional) enables VLC's built-in web interface on a loopback port so we can
// read the playhead back out of it — VLC is a separate process and reports nothing on
// its own. Purely additive: if VLC ignores the flags (or is already running, so the URL
// is handed to the existing instance instead) the poller just never connects and VLC
// plays exactly as before.
function buildVlcLaunchAttempts(url, http = null, subtitlePath = null) {
  const target = String(url || '');
  const attempts = [];
  const httpArgs = http
    ? ['--extraintf=http', '--http-host=127.0.0.1', `--http-port=${http.port}`, `--http-password=${http.password}`]
    : [];
  // The downloaded external subtitle. VLC picks up EMBEDDED tracks on its own
  // (it plays the original MKV from :8090), but a downloaded .srt lives in a temp
  // dir VLC has never heard of — without this flag the web/cast players showed
  // the chosen subtitle and VLC silently didn't.
  const subArgs = subtitlePath ? [`--sub-file=${subtitlePath}`] : [];
  const withHttp = (t) => [t, ...httpArgs, ...subArgs];

  // VLC on Windows sometimes fails with localhost - try network IP first
  let networkTarget = target;
  if (target.includes('localhost') || target.includes('127.0.0.1')) {
    try {
      // Get network IP for VLC
      const { getLocalIPv4Address } = require('./core/network-address');
      const networkIp = getLocalIPv4Address();
      if (networkIp && networkIp !== 'localhost') {
        networkTarget = target.replace(/localhost|127\.0\.0\.1/g, networkIp);
      }
    } catch (e) {
      // Ignore network IP detection errors
    }
  }

  if (process.platform === 'win32') {
    // Try network IP first (more reliable for VLC on Windows)
    if (networkTarget !== target) {
      attempts.push({ command: 'vlc.exe', args: withHttp(networkTarget) });
    }
    // Then try localhost
    attempts.push(
      { command: 'vlc.exe', args: withHttp(target) },
      { command: 'vlc', args: withHttp(target) }
    );

    const envPaths = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    for (const root of envPaths) {
      attempts.push({
        command: path.join(root, 'VideoLAN', 'VLC', 'vlc.exe'),
        args: withHttp(target),
      });
    }
  } else if (process.platform === 'darwin') {
    attempts.push(
      // `open` forwards app flags only after --args.
      { command: 'open', args: ['-a', 'VLC', target, ...((httpArgs.length || subArgs.length) ? ['--args', ...httpArgs, ...subArgs] : [])] },
      { command: '/Applications/VLC.app/Contents/MacOS/VLC', args: withHttp(target) },
      { command: 'vlc', args: withHttp(target) }
    );
  } else {
    attempts.push(
      { command: 'vlc', args: withHttp(target) },
      { command: '/usr/bin/vlc', args: withHttp(target) },
      { command: '/usr/local/bin/vlc', args: withHttp(target) },
      { command: '/snap/bin/vlc', args: withHttp(target) }
    );
  }

  const seen = new Set();
  return attempts.filter((attempt) => {
    const key = `${attempt.command}\n${attempt.args.join('\n')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let readyTimer = null;

    const finishResolve = (child) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (child && typeof child.unref === 'function') child.unref();
      resolve();
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      reject(error);
    };

    try {
      const child = spawn(command, args, {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', (error) => {
        finishReject(error);
      });
      child.once('spawn', () => {
        readyTimer = setTimeout(() => finishResolve(child), 300);
      });
      child.once('exit', (code, signal) => {
        if (code === 0 || signal) {
          finishResolve(child);
          return;
        }
        finishReject(new Error(`Command exited with code ${code}`));
      });
    } catch (error) {
      finishReject(error);
    }
  });
}

async function openStreamInVlc(url, http = null, subtitlePath = null) {
  let lastError = null;
  for (const attempt of buildVlcLaunchAttempts(url, http, subtitlePath)) {
    try {
      await spawnDetached(attempt.command, attempt.args);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  const message = `VLC is not installed or could not be started. Install it from ${VLC_DOWNLOAD_URL}`;
  const error = new Error(message);
  error.cause = lastError;
  throw error;
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

  // Optional: how this release was chosen, remembered against the history entry so
  // "Resume" can restart from the same source without a second trip through the
  // picker. Purely advisory — a malformed/absent playback block is not an error.
  let playback = null;
  if (body.playback && typeof body.playback === 'object') {
    const source = body.playback.source;
    if (source && String(source).trim()) {
      playback = { source: String(source).trim() };
      const season = Number(body.playback.season);
      const episode = Number(body.playback.episode);
      if (Number.isFinite(season)) playback.season = season;
      if (Number.isFinite(episode)) playback.episode = episode;
      // Which SUBTITLE was chosen, so Resume can fetch the same one again. Resume goes
      // through the auto path, which skips the subtitle step entirely — without this a
      // resumed film comes back with no subtitle at all, and on a release with no
      // embedded tracks (a YIFY rip, say) that means none whatsoever. Enough to re-run
      // the download and nothing more: the FILE is temporary, the choice is not.
      const sub = body.playback.subtitle;
      if (sub && typeof sub === 'object' && (sub.id || sub.fileId || sub.downloadUrl)) {
        playback.subtitle = {
          source: sub.source ? String(sub.source) : null,
          id: sub.id != null ? String(sub.id) : null,
          fileId: sub.fileId != null ? String(sub.fileId) : null,
          downloadUrl: sub.downloadUrl ? String(sub.downloadUrl) : null,
          language: sub.language ? String(sub.language) : null,
        };
      }
    }
  }

  return {
    magnet: String(body.magnet),
    subtitleToken: body.subtitleToken ? String(body.subtitleToken) : null,
    burnSubtitle: body.burnSubtitle === true,
    history,
    playback,
  };
}

// Each player has its own vocabulary for "what am I doing"; PlaybackTarget has one.
// Anything not mapped here is a state we have no opinion about and is dropped.
const VLC_STATES = { playing: 'playing', paused: 'paused', stopped: 'stopped' };
const DLNA_STATES = {
  PLAYING: 'playing',
  PAUSED_PLAYBACK: 'paused',
  PAUSED_RECORDING: 'paused',
  TRANSITIONING: 'buffering',
  STOPPED: 'stopped',
  NO_MEDIA_PRESENT: 'idle',
};

// "H:MM:SS" / "MM:SS" (UPnP RelTime, VLC) -> seconds. Returns null when unparseable
// (renderers report "NOT_IMPLEMENTED" or empty before playback settles).
function hhmmssToSeconds(text) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(String(text || '').trim());
  if (!m) return null;
  const secs = (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
  return Number.isFinite(secs) ? secs : null;
}

// Fold a playhead reported by ANY player into watch history — same session history
// context, same updateProgress path, so "Continue Watching" works regardless of where
// the user actually watched. Reached only via a PlaybackTarget's 'playback' event
// (see getPlaybackTarget), so position is already past the noise floor and `ended` is
// already derived by the time it lands here. Best-effort throughout.
function recordSessionProgress(session, { positionSec, durationSec, ended = false } = {}) {
  if (!session) return;
  const position = Number(positionSec);
  const duration = Number(durationSec);
  if (!Number.isFinite(position)) return;

  // `ended` is assigned, not OR-ed with what came before. The target already decided —
  // including clearing it when the user seeks back after the credits, which the old
  // OR made impossible (once ended, ended forever).
  session.playback = {
    ...(session.playback || {}),
    positionSec: Math.floor(position),
    durationSec: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
    ended: ended === true,
    updatedAt: Date.now(),
  };

  const h = session.history;
  if (!h || !h.item || !h.item.tmdbId) return;
  try {
    getServices().historyStore.updateProgress(h.type, h.item.tmdbId, {
      season: h.type === 'tv' ? h.item.lastSeason : undefined,
      episode: h.type === 'tv' ? h.item.lastEpisode : undefined,
      positionSec: Math.floor(position),
      durationSec: Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : null,
      item: h.item,
    });
  } catch (e) { /* progress persistence is best-effort */ }
}

// The bridge's junction point. Every target — the web player, VLC, a DLNA TV, a
// Chromecast — reports through a PlaybackTarget, and its events fan out here to BOTH
// destinations at once: watch history (so "Continue Watching" works wherever you
// watched) and the session's SSE channel (so the UI learns about a finish or a failure
// without polling for it). Targets are created lazily on first report.
// The roster the UI reads: every target this session has ever fed, and what each is
// doing now. Built from the map rather than from the last event, because the map is the
// only thing that knows about a target that has stopped reporting — and a TV that went
// quiet is precisely what you'd be looking at this for.
function sessionTargetsSnapshot(session) {
  if (!session || !session.playbackTargets) return [];
  const out = [];
  for (const [key, entry] of session.playbackTargets.entries()) {
    const t = entry.target;
    out.push({
      key,
      ...t.status(),
      // `gone` is terminal — VLC closed, the TV stopped answering. Distinct from a
      // target that is merely paused or idle, which is still there.
      gone: t.finished === true,
      // A live poller vs. one we've stopped. Without this a dead DLNA target and a
      // paused one look identical from outside.
      polling: !!entry.timer,
    });
  }
  return out;
}

function broadcastTargets(session) {
  if (!session || !session.lifecycle) return;
  session.targets = sessionTargetsSnapshot(session);
  session.lifecycle.targets(session.targets);
}

function getPlaybackTarget(session, key, kind, device = null) {
  if (!session) return null;
  if (!session.playbackTargets) session.playbackTargets = new Map();

  const existing = session.playbackTargets.get(key);
  if (existing) {
    // A name can arrive after the target does (the cast sender learns the friendly name
    // from its own SDK, on its first report). Take it whenever it shows up.
    if (device) existing.target.describe(device);
    return existing.target;
  }

  const target = new PlaybackTarget(kind, (event, payload) => {
    if (event === 'playback') {
      recordSessionProgress(session, payload);
      // The one place a TARGET fact crosses into the stream-health plane: "how much
      // buffer is ahead of me" needs the playhead (target) and the average bitrate
      // (source), and neither plane can answer it alone. Every target lands here, so
      // this is the only wiring needed — but with two players running, last one wins,
      // which is why the payload stamps who reported it.
      if (session.streamManager && session.streamManager.streamHealth) {
        session.streamManager.streamHealth.observePlayhead(payload.positionSec, key);
      }
      if (session.lifecycle) session.lifecycle.playback(payload);
      broadcastTargets(session);
      return;
    }
    if (event === 'playback_error' && session.lifecycle) {
      session.lifecycle.playbackError(payload);
      broadcastTargets(session); // `gone` flips here — the roster has to say so
    }
  });

  session.playbackTargets.set(key, { target, timer: null, device: device || null });
  broadcastTargets(session); // a new target appearing IS the news
  return target;
}

// Hand a poller's interval to the registry so it can be cleared per-target.
function setPlaybackTimer(session, key, timer) {
  if (!session || !session.playbackTargets) return;
  const entry = session.playbackTargets.get(key);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = timer;
  if (timer && timer.unref) timer.unref();
  broadcastTargets(session);
}

// Stop polling one target, leaving every other target on the session running.
function stopPlaybackTarget(session, key) {
  if (!session || !session.playbackTargets) return;
  const entry = session.playbackTargets.get(key);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = null;
  broadcastTargets(session);
}

// Stop every poller on a session. Session teardown still wants the blunt version.
function stopExternalProgress(session) {
  if (!session || !session.playbackTargets) return;
  for (const key of session.playbackTargets.keys()) stopPlaybackTarget(session, key);
}

// A loopback port for VLC's web interface. Bind :0 and let the OS pick, so two
// concurrent VLC launches can't collide on a hardcoded port.
function findFreePort() {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.once('error', () => resolve(null));
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Read VLC's playhead out of its web interface. VLC is a separate process that pings
// nothing, so without this a full film watched in VLC leaves Continue Watching at 0.
// Entirely best-effort: if the interface never comes up (VLC too old, flags ignored
// because an instance was already running, user's own VLC config), we simply stop.
function startVlcProgress(session, { port, password }) {
  stopPlaybackTarget(session, 'vlc');
  const auth = 'Basic ' + Buffer.from(':' + password).toString('base64');
  const target = getPlaybackTarget(session, 'vlc', 'vlc');
  let misses = 0;
  let everAnswered = false;
  // Kept on the session so a finished subtitle auto-sync can PUSH the corrected
  // file into this running VLC (addsubtitle) instead of waiting for a relaunch.
  session.vlcHttp = { port, password };

  // Whether we ever reached the interface is the only signal we have to tell "the user
  // closed VLC" apart from "this VLC never had an interface to begin with" (flags went
  // to an already-running instance, or it's too old). The process itself is spawned
  // detached with stdio ignored, so its exit is invisible to us.
  const giveUpNow = () => {
    session.vlcHttp = null;
    target.gone(everAnswered ? 'closed' : 'unavailable');
    stopPlaybackTarget(session, 'vlc');
  };

  const poll = () => {
    if (!streamSessions.has(session.id)) return stopPlaybackTarget(session, 'vlc');
    const req = require('http').request(
      { host: '127.0.0.1', port, path: '/requests/status.xml', headers: { Authorization: auth }, timeout: 4000 },
      (res) => {
        let xml = '';
        res.on('data', (d) => { xml += d; if (xml.length > 200000) req.destroy(); });
        res.on('end', () => {
          if (res.statusCode !== 200) { if (++misses >= 4) giveUpNow(); return; }
          misses = 0;
          everAnswered = true;
          // Report every state, not just 'playing'. A 'stopped' is exactly the event
          // that means the film finished — dropping it here is why auto-next-episode
          // never fired in VLC. VLC zeroes <time>/<length> on stop, so the numbers in
          // that last report are junk; the target ignores them and consults the
          // playhead it retained while the film was actually running.
          const raw = String((/<state>([^<]*)<\/state>/i.exec(xml) || [])[1] || '').toLowerCase();
          const state = VLC_STATES[raw];
          if (!state) return;
          target.report({
            state,
            positionSec: Number((/<time>(\d+)<\/time>/i.exec(xml) || [])[1]),
            durationSec: Number((/<length>(\d+)<\/length>/i.exec(xml) || [])[1]),
          });
          if (state === 'stopped') stopPlaybackTarget(session, 'vlc');
        });
      }
    );
    // VLC closed, or the interface never started — stop after a few failures.
    const giveUp = () => { try { req.destroy(); } catch (e) {} if (++misses >= 4) giveUpNow(); };
    req.on('error', giveUp);
    req.on('timeout', giveUp);
    req.end();
  };

  setPlaybackTimer(session, 'vlc', setInterval(poll, 15000));
  return poll; // returned so tests can drive a scrape without waiting out the interval
}

// The one subtitle file worth handing VLC at launch: a DOWNLOADED (external)
// track, and nothing else. `streamManager.subtitlePath` is NOT that — the
// embedded-subtitle extractor claims it when no download exists, pointing it at
// a partial, progressively-rewritten VTT. Passing that to VLC named it "Track",
// outranked the properly-named embedded tracks inside the MKV, and broke anime
// subtitles entirely. Embedded tracks live in the container; VLC finds them
// itself. First external entry wins — after an auto-sync that IS the corrected
// file ("Original timing" sits later in the list).
function pickVlcSubtitle(session) {
  const sm = session && session.streamManager;
  if (!sm || !Array.isArray(sm.subtitlePaths)) return null;
  const ext = sm.subtitlePaths.find((s) => s && s.source === 'external' && s.path && fs.existsSync(s.path));
  return ext ? ext.path : null;
}

// pickVlcSubtitle answers WHICH subtitle; this answers WHAT FILE to hand VLC. Same cues,
// wrapped so the menu shows the label instead of "Track 1" — see core/vlc-subtitle-label.js
// for why the file NAME cannot do that job. Kept separate from pickVlcSubtitle so the
// choice stays synchronous and testable without ffmpeg.
//
// `subPath` overrides the pick, for the auto-sync push (the corrected file is already in
// hand, and its label came along on the event).
async function vlcSubtitleFile(session, subPath, label) {
  const sm = session && session.streamManager;
  const picked = subPath || pickVlcSubtitle(session);
  if (!picked || !sm) return picked || null;
  const entry = Array.isArray(sm.subtitlePaths)
    ? sm.subtitlePaths.find((s) => s && s.path === picked)
    : null;
  try {
    return await require('./core/vlc-subtitle-label').labelSubtitleForVlc({
      ffmpegPath: sm.ffmpegPath,
      subPath: picked,
      label: label || (entry && entry.label),
      language: entry && entry.language,
      outDir: sm.tempDir,
    });
  } catch (e) {
    return picked; // a nicer menu entry is never worth losing the subtitle over
  }
}

// One request to VLC's web interface, resolving with the body (or null). Best-effort:
// only possible when VLC was launched by Uplayer, so the interface is up at all.
function vlcRequest(creds, query) {
  return new Promise((resolve) => {
    const auth = 'Basic ' + Buffer.from(':' + creds.password).toString('base64');
    const req = require('http').request({
      host: '127.0.0.1',
      port: creds.port,
      path: '/requests/status.xml?' + query,
      headers: { Authorization: auth },
      timeout: 4000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
    req.end();
  });
}

// Subtitle ES ids parsed out of a status.xml body: every <category name='Stream N'>
// whose Type is Subtitle. N is the ES id, i.e. the value `spu-es` — and therefore the
// `subtitle_track` command — takes.
//
// That identity is measured, not assumed. On an MKV with two embedded subtitle tracks
// plus an external one, status.xml listed [3,5,4,2] (note: out of document order) and
// VLC's own rc `strack` reported ES ids [2,3,4,5] — the same set, and selecting the id
// derived from here moved the active track. Order in the XML means nothing; the numbers
// do.
//
// Pure: a regex over a string. No IO.
function vlcSubtitleTrackIds(xml) {
  const ids = [];
  if (!xml) return ids;
  const re = /<category name=['"]Stream (\d+)['"]>([\s\S]*?)<\/category>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (/>Subtitle</.test(m[2])) ids.push(Number(m[1]));
  }
  return ids;
}

// Get a corrected subtitle into an already-running VLC.
//
// VLC has no "replace this subtitle file" command, so `addsubtitle` necessarily produces
// a SECOND track, and it does NOT select it — measured on 3.0.23, where the original
// stayed starred in `strack` and the corrected file sat there inert. A track the viewer
// has to go and find is not a fix.
//
// The best path is still not to send a file at all. When the correction is a pure offset
// — "everything is 7 seconds late", the usual case for a subtitle cut for another
// release — `subdelay` applies it to the track VLC ALREADY has. One track, its original
// name, correct timing, nothing added. Confirmed round-tripping through <subtitledelay>.
//
// Only a non-uniform correction (frame-rate drift) needs the file, because a single delay
// cannot express it. That case DOES gain a second track — but it can be selected, which
// is what makes it a fix rather than homework. An earlier note here claimed otherwise
// ("status.xml lists only Video and Audio ... nothing to address a subtitle_track command
// at"); that was wrong on the very version it cited. Subtitle streams are listed, their
// Stream number is the ES id, and `command=subtitle_track&val=<id>` moves the selection.
//
// The id is found by DIFFING the track list around the add rather than by trusting a
// numbering rule: whichever subtitle ES is present afterwards and was not present before
// is the file we just loaded. Anything other than exactly one new id — zero (the add
// failed) or several (something else touched the input) — selects nothing. Guessing wrong
// here puts the UNCORRECTED subtitle on screen, which is worse than leaving the viewer to
// pick.
//
// Best-effort throughout: on failure the corrected file is still what --sub-file picks up
// next launch (see pickVlcSubtitle).
async function pushSubtitleToVlc(session, subPath, shiftMs, label) {
  const creds = session && session.vlcHttp;
  if (!creds || !subPath) return;

  if (Number.isFinite(shiftMs)) {
    // VLC takes seconds, positive = show later. shiftMs is corrected-minus-original, so
    // a subtitle running 7s late is -7 here, which is exactly the delay that fixes it.
    await vlcRequest(creds, 'command=subdelay&val=' + (shiftMs / 1000));
    return;
  }

  // Only the file path needs the naming wrapper, and only on this branch — the subdelay
  // above sends no file at all, so wrapping there would be work for a menu entry nobody
  // gains.
  const file = await vlcSubtitleFile(session, subPath, label);
  const before = new Set(vlcSubtitleTrackIds(await vlcRequest(creds, '')));
  await vlcRequest(creds, 'command=addsubtitle&val=' + encodeURIComponent(file));

  // The slave is attached by the input thread, so the new ES is not in status.xml the
  // instant addsubtitle returns — it took a couple of seconds to appear in testing. Poll
  // instead of sleeping a fixed amount, which is either a guess that is too short or a
  // stall that is too long.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const added = vlcSubtitleTrackIds(await vlcRequest(creds, '')).filter((id) => !before.has(id));
    if (added.length === 1) {
      await vlcRequest(creds, 'command=subtitle_track&val=' + added[0]);
      return;
    }
    if (added.length > 1) return; // ambiguous — see the header
  }
}

function persistSessionHistory(session) {
  if (!session || session.historySaved || !session.history) return null;
  const { type, item } = session.history;
  const db = getServices().historyStore.markWatched(type, item);
  // Record the release source alongside the entry markWatched just created, so the
  // Continue Watching shelf can resume straight back into the same one.
  if (session.playback) {
    try {
      getServices().historyStore.setLastPlayback(type, item.tmdbId, session.playback);
    } catch (playbackError) {
      console.warn('Failed to record last playback source:', playbackError.message);
    }
  }
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
    stopExternalProgress(session); // no session left to attribute VLC/DLNA progress to
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
    const { title, type, tmdbId, season, episode } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const seasonNum = season != null ? Number(season) : null;
    const episodeNum = episode != null ? Number(episode) : null;

    // Derive anime metadata from TMDB so the scraper can pick the right query
    // strategy (Nyaa/SubsPlease for anime, S##E## for live-action) and the
    // right filter rules (absolute-episode matching for anime).
    let isAnime = false;
    let absoluteEpisode = null;
    let altTitles = [];

    if (type === 'tv' && tmdbId && seasonNum != null && episodeNum != null) {
      try {
        const detail = await tmdb(`/tv/${tmdbId}`, { append_to_response: 'alternative_titles' });
        const genres = (detail.genres || []).map((g) => g.id);
        const origins = detail.origin_country || [];
        const lang = detail.original_language;
        isAnime = genres.includes(16) && (origins.includes('JP') || lang === 'ja');

        if (isAnime) {
          // Anime trackers (Nyaa/SubsPlease) list by romaji title. TMDB exposes it
          // as a JP romaji/hepburn alternative title. Some shows also store their
          // original_name already romanized (Latin script) — include that too, but
          // skip the CJK/kanji original_name since these trackers never match it.
          const altResults = (detail.alternative_titles && detail.alternative_titles.results) || [];
          // Anime trackers use double-vowel romaji (Yuusha), but TMDB often stores
          // the Hepburn macron form (Yūsha). Normalize macrons so the API's literal
          // token match lands. ō→ou matches the おう the trackers spell out.
          const deMacron = (s) => String(s || '')
            .replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu')
            .replace(/ē/g, 'ee').replace(/ō/g, 'ou')
            .replace(/Ā/g, 'Aa').replace(/Ī/g, 'Ii').replace(/Ū/g, 'Uu')
            .replace(/Ē/g, 'Ee').replace(/Ō/g, 'Ou');
          // SubsPlease/Nyaa file a show under a SHORT title; TMDB frequently appends
          // a long subtitle after a colon (e.g. "Yuusha-kei ni Shosu: Choubatsu
          // Yuusha 9004-tai Keimu Kiroku"). Searching the full string returns nothing,
          // so also emit the pre-colon form.
          const stripSubtitle = (s) => String(s).split(/[:：]/)[0].trim();
          const hasCjk = (s) => /[　-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/.test(String(s || ''));
          // Seed from JP alt titles that are romaji-typed OR simply non-CJK (many
          // romaji entries carry no type), plus a romanized original_name.
          const romajiSeeds = altResults
            .filter((a) => a && a.iso_3166_1 === 'JP' && (/romaji|hepburn/i.test(a.type || '') || !hasCjk(a.title)))
            .map((a) => a.title);
          if (detail.original_name && !hasCjk(detail.original_name)) romajiSeeds.push(detail.original_name);
          const expanded = [];
          for (const seed of romajiSeeds) {
            const n = deMacron(seed);
            expanded.push(n, stripSubtitle(n));
          }
          altTitles = [...new Set(expanded.map((s) => s.trim()).filter(Boolean))];
        }

        if (isAnime) {
          // Two TMDB anime schemas: (a) reset-per-season (Bleach: S2E40 →
          // abs = 366 + 40 = 406); (b) already-absolute (One Piece: S23E1159
          // → abs = 1159, NOT priorSum + 1159). If the chosen episode_number
          // is bigger than all prior seasons combined, it must already be the
          // global counter — using priorSum + episode would double-count.
          let priorSum = 0;
          for (const s of detail.seasons || []) {
            if (s && s.season_number > 0 && s.season_number < seasonNum) {
              priorSum += s.episode_count || 0;
            }
          }
          absoluteEpisode = episodeNum > priorSum ? episodeNum : priorSum + episodeNum;
        }
      } catch (lookupErr) {
        // Non-fatal: fall back to non-anime behaviour if TMDB is unreachable.
        console.warn(`/api/torrents/search: TMDB lookup failed for tmdbId=${tmdbId}: ${lookupErr.message}`);
      }
    }

    const scraper = getServices().createTorrentScraper();

    // Stream ranked snapshots as NDJSON: one JSON object per line. Each `partial`
    // carries the best-ranked results found so far (emitted as each source returns),
    // and a closing `final` carries the complete ranked list. This lets the wizard
    // show results immediately and re-rank as more sources arrive.
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');

    const top20 = (results) => (results || []).filter((r) => r && r.name).slice(0, 20);

    const results = await scraper.searchAllSources(title, {
      season: seasonNum,
      episode: episodeNum,
      isAnime,
      absoluteEpisode,
      altTitles,
      onPartial: (snapshot) => {
        if (res.writableEnded) return;
        try {
          res.write(JSON.stringify({ type: 'partial', results: top20(snapshot) }) + '\n');
        } catch (_) { /* client may have disconnected */ }
      },
    });

    res.write(JSON.stringify({ type: 'final', results: top20(results) }) + '\n');
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      try { res.write(JSON.stringify({ type: 'error', error: e.message }) + '\n'); } catch (_) {}
      res.end();
    }
  }
});

// Resolve magnet link from a torrent result
// Warm a candidate before the user commits to it. Measured: engine start is 14ms and
// `add` is 16ms — the real 10s+ of time-to-first-frame is metadata resolution and the
// first read, both swarm-bound and unavoidable ONCE STARTED. So start them earlier:
// while the search is still running and the user is still reading the list. `add` uses
// save_to_db:false and downloads no data until a reader opens, so this costs metadata
// and peer discovery only, and leaves nothing behind if the user picks something else.
// Deliberately never fails the caller — a prefetch miss just means today's timing.
// Process-wide singleton — the same engine instance the app starts at boot and that
// every stream shares (see core/torrserver-client.js getSharedClient).
function getSharedTorrServer() {
  return require('./core/torrserver-client').getSharedClient();
}

// Open a brief reader so TorrServer resolves metadata AND initialises its reader now,
// while the user is still choosing. Measured against a warm, actively-seeded torrent:
// the FIRST read costs ~7.8s, every read after it ~200ms — that cost is paid on the
// click today. Reading ~1MB here moves it off the critical path. Bounded and
// best-effort: worst case it warms a torrent the user doesn't pick.
async function warmTorrentReader(hash) {
  const ts = getSharedTorrServer();
  const file = await ts.resolveLargestFile(hash, { timeout: 45000 });
  const url = ts.streamUrl(hash, file.id, file.path);
  await new Promise((resolve) => {
    const req = require('http').get(url, { headers: { Range: 'bytes=0-1048575' } }, (res) => {
      res.on('data', () => {}); // drain and discard; we only want the reader warm
      res.on('end', resolve);
      res.on('error', resolve);
    });
    req.on('error', resolve);
    req.setTimeout(60000, () => { try { req.destroy(); } catch (e) {} resolve(); });
  });
}

const prefetchedTorrents = new Map(); // magnet -> hash, so a repeat pick skips the scrape
app.post('/api/torrents/prefetch', async (req, res) => {
  try {
    const { torrent, magnet } = req.body || {};
    let link = magnet && String(magnet).startsWith('magnet:') ? String(magnet) : null;
    if (!link) {
      if (!torrent) return res.json({ ok: false, reason: 'torrent or magnet required' });
      const scraper = getServices().createTorrentScraper();
      link = await scraper.getMagnetLink(torrent); // scraping overlaps with the search too
    }
    if (!link) return res.json({ ok: false, reason: 'could not resolve magnet' });
    if (prefetchedTorrents.has(link)) return res.json({ ok: true, hash: prefetchedTorrents.get(link), cached: true });

    const hash = await getSharedTorrServer().add(link, (torrent && torrent.name) || '');
    prefetchedTorrents.set(link, hash);
    // Bound the map; it only exists to skip a repeat scrape.
    if (prefetchedTorrents.size > 50) prefetchedTorrents.delete(prefetchedTorrents.keys().next().value);
    res.json({ ok: true, hash, magnet: link });
    // Reply first, then keep warming in the background — the caller never waits on this.
    warmTorrentReader(hash).catch(() => {});
  } catch (e) {
    res.json({ ok: false, reason: e.message });
  }
});

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

    // The YIFY provider is addressed by IMDb id (its movie pages are
    // /movie-imdb/<id>, server-rendered and unambiguous). TMDB knows the mapping;
    // best-effort — a failed lookup just means one fewer source in the fan-out.
    let imdbId = null;
    if ((type || 'movie') !== 'tv' && tmdbId) {
      try {
        const ext = await getServices().tmdbClient.get(`/movie/${tmdbId}/external_ids`);
        imdbId = ext && ext.imdb_id ? String(ext.imdb_id) : null;
      } catch (e) { /* keyless sources still run */ }
    }

    const manager = getServices().createSubtitleManager();
    const results = await manager.searchSubtitles(
      title,
      language || 'en',
      season != null ? Number(season) : null,
      episode != null ? Number(episode) : null,
      year || null,
      tmdbId || null,
      type || null,
      imdbId
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
      subtitle.downloadUrl || subtitle.attributes?.subsplease_url || subtitle.attributes?.addic7ed_url || null,
      // Decoding hint only. Providers label rows either way — 'ar' from the API,
      // 'Arabic' from the scrapers — and subtitle-encoding accepts both.
      subtitle.language || subtitle.attributes?.language || null
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

// Auto-sync an external subtitle (by token) to the active stream's audio via alass.
app.post('/api/subtitles/sync', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = typeof body.subtitleToken === 'string' ? body.subtitleToken.trim() : '';
    if (!token) return res.status(400).json({ error: 'subtitleToken required' });
    const subPath = getServices().subtitleTokenStore.resolve(token);
    if (!subPath || !fs.existsSync(subPath)) return res.status(400).json({ error: 'Invalid or expired subtitle token' });
    const session = sessionRegistry.currentStreamSession();
    if (!session) return res.status(409).json({ error: 'No active stream to sync against' });
    const r = await session.streamManager.syncSubtitle(subPath, { maxSeconds: body.maxSeconds });
    if (!r.ok) return res.status(500).json({ error: r.reason || 'sync failed' });
    const issued = getServices().subtitleTokenStore.issueWithMetadata(r.output, 2 * 60 * 60 * 1000);
    res.json({ subtitleToken: issued.token, expiresAt: issued.expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate subtitles for the active stream via whisper.cpp (speech-to-text).
app.post('/api/subtitles/generate', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const session = sessionRegistry.currentStreamSession();
    if (!session) return res.status(409).json({ error: 'No active stream' });
    const r = await session.streamManager.generateSubtitles({ language: body.language, maxSeconds: body.maxSeconds });
    if (!r.ok) return res.status(500).json({ error: r.reason || 'generation failed' });
    res.json({ ok: true, index: r.index });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

    // Concurrent streams: each start adds a new session (its own player server + torrent;
    // TorrServer serves them all). A small cap avoids runaway resource use; the oldest
    // is retired when exceeded.
    const MAX_CONCURRENT_STREAMS = Math.max(1, Number(process.env.UPLAYER_MAX_STREAMS) || 4);
    const live = sessionRegistry.activeStreamSessions();
    if (live.length >= MAX_CONCURRENT_STREAMS) {
      const oldest = live.sort((a, b) => (a.started || 0) - (b.started || 0))[0];
      if (oldest) { try { await destroySession(oldest.id, 0); } catch (e) {} }
    }

    const session = createStreamSession();
    session.history = parsed.history;
    session.playback = parsed.playback;
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

    // The byte supply, in real numbers. `progress` above stays exactly as it was.
    sm.on('stream_health', (data) => {
      session.streamHealth = data;
      session.lifecycle.streamHealth(data);
    });

    // A subtitle finished syncing AFTER playback began. The web player refreshes on
    // its own (manifest poll); a running VLC only updates if we push the corrected
    // file into it via its web interface.
    sm.on('subtitle_updated', (data) => {
      // data.label is what the manifest calls this track ("… (auto-synced −7.0s)"); it
      // becomes the name VLC's own menu shows, so the two agree.
      if (data && data.path) pushSubtitleToVlc(session, data.path, data.shiftMs, data.label);
    });

    // Playhead pings from the player page (via the stream hub). The web player is the
    // one target that reports a real `ended` event rather than having it inferred from
    // an ambiguous stop, so it's passed straight through and believed.
    sm.on('playback_position', (data) => {
      getPlaybackTarget(session, 'web', 'web').report({
        positionSec: data.positionSec,
        durationSec: data.durationSec,
        state: data.ended === true ? 'stopped' : 'playing',
        ended: data.ended === true,
      });
    });

    // The player page failed to play at all (bad codec, dead source). Nothing used to
    // arrive here — the page swallowed its own errors — so a failed stream just sat
    // there looking like it was still loading.
    sm.on('playback_error', (data) => {
      getPlaybackTarget(session, 'web', 'web').error({
        code: data && data.code,
        message: (data && data.message) || 'The player could not play this file',
      });
    });

    sm.on('player_ready', (data) => {
      const url = data && data.url ? data.url : null;
      if (url) {
        persistSessionHistory(session);
        applySessionPlayerReady(session, data);
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
      burnSubtitle: parsed.burnSubtitle,
    }).then((result) => {
      if (result && result.url) {
        persistSessionHistory(session);
        applySessionPlayerReady(session, result);
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

app.post('/api/stream/open-vlc', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
      ? body.sessionId.trim()
      : null;
    const resolved = resolveOpenableSession(sessionId);

    if (resolved.error === 'Session not found') {
      return res.status(404).json({ error: resolved.error });
    }
    if (resolved.error) {
      return res.status(409).json({ error: resolved.error });
    }

    const vlcUrl = resolved.vlcUrl || resolved.url;
    // Enable VLC's web interface on a loopback port so we can poll the playhead back
    // into watch history. Never fatal: no port -> launch VLC exactly as before.
    const port = await findFreePort();
    const vlcHttp = port
      ? { port, password: require('crypto').randomBytes(12).toString('hex') }
      : null;
    await openStreamInVlc(vlcUrl, vlcHttp, await vlcSubtitleFile(resolved.session));
    if (vlcHttp && resolved.session) startVlcProgress(resolved.session, vlcHttp);
    res.json({
      ok: true,
      url: resolved.url,
      vlcUrl: resolved.vlcUrl || resolved.url,
      message: 'Opening stream in VLC',
    });
  } catch (e) {
    res.status(503).json({
      error: e.message,
      installUrl: VLC_DOWNLOAD_URL,
    });
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
  const lifecycleStatus = getSessionPlayerState(session);
  if (lifecycleStatus.playerUrl) {
    res.write(`event: player_ready\ndata: ${JSON.stringify({
      url: lifecycleStatus.playerUrl,
      playerUrl: lifecycleStatus.playerUrl,
      vlcUrl: lifecycleStatus.vlcUrl,
      castUrl: lifecycleStatus.castUrl,
      subtitleManifestUrl: lifecycleStatus.subtitleManifestUrl,
      videoFormat: lifecycleStatus.videoFormat,
    })}\n\n`);
  }

  // The roster is state, not a stream of news: replay the CURRENT one rather than
  // relying on the event buffer, which may have aged the earlier ones out.
  const targets = sessionTargetsSnapshot(session);
  if (targets.length) {
    res.write(`event: targets\ndata: ${JSON.stringify(targets)}\n\n`);
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
// Chromecast reports through the browser rather than the server: only the sender page
// can talk to the CAF SDK, so unlike VLC and DLNA there is nothing here to poll. This
// endpoint is how it joins the bridge anyway — the sender posts what the SDK told it,
// and from here on it's an ordinary target like any other.
app.post('/api/stream/:id/playback', (req, res) => {
  const session = streamSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Unknown session' });
  const { positionSec, durationSec, state, ended, kind, device } = req.body || {};

  const key = kind === 'cast' ? 'cast' : 'web';
  // The sender is the only thing that can know the receiver's friendly name — the CAF
  // SDK hands it to the page, never to us — so it rides along with the report.
  const target = getPlaybackTarget(session, key, key, device);
  const out = target.report({
    positionSec,
    durationSec,
    state: state || 'playing',
    ended: ended === true,
  });
  res.json({ ok: true, playback: out || session.playback || null });
});

app.get('/api/stream/status', (req, res) => {
  const active = [];
  for (const [id, session] of streamSessions.entries()) {
    const lifecycleStatus = getSessionPlayerState(session);
    active.push({
      id,
      running: !!session.streamManager && !lifecycleStatus.exited,
      playerUrl: lifecycleStatus.playerUrl,
      vlcUrl: lifecycleStatus.vlcUrl,
      castUrl: lifecycleStatus.castUrl,
      subtitleManifestUrl: lifecycleStatus.subtitleManifestUrl,
      videoFormat: lifecycleStatus.videoFormat,
      mediaFacts: lifecycleStatus.mediaFacts,
      streamHealth: session.streamHealth || null,
      // `playback` above is the last report from whichever target spoke most recently;
      // this is every target and what each is doing. A client that didn't start the
      // session (a phone opening /#/stream fresh) gets the roster from here.
      targets: sessionTargetsSnapshot(session),
      started: session.started,
      mode: session.mode || PLAYER_MODE,
      exited: !!lifecycleStatus.exited,
      exitedAt: session.exitedAt,
      playback: session.playback || null,
      // Surface what this session is playing so a client that didn't start it
      // (e.g. a phone opening /#/stream fresh) can rebuild the wizard — this is
      // what lets "Next Episode" work without relying on that device's localStorage.
      media: session.history ? {
        type: session.history.type || null,
        tmdbId: (session.history.item && (session.history.item.tmdbId || session.history.item.id)) || null,
        title: (session.history.item && session.history.item.title) || null,
        season: (session.history.item && session.history.item.lastSeason) || null,
        episode: (session.history.item && session.history.item.lastEpisode) || null,
      } : null,
    });
  }
  res.json(active);
});

// TV Cast readiness test endpoint
app.get('/api/cast/test', (req, res) => {
  // { live: true } == the old `s.streamManager && !exited` predicate this route used on its own.
  // It is the ONE finder site that excluded exited sessions; kept explicit rather than silently
  // unified with the others (see core/session-registry.js).
  const activeSession = sessionRegistry.currentStreamSession({ live: true });

  if (!activeSession) {
    return res.status(404).json({
      ready: false,
      error: 'No active stream session',
      message: 'Start a stream first, then try casting'
    });
  }
  
  const lifecycleStatus = getSessionPlayerState(activeSession);
  const castUrl = lifecycleStatus.castUrl || activeSession.castUrl;
  const subtitleManifestUrl = lifecycleStatus.subtitleManifestUrl || activeSession.subtitleManifestUrl;
  
  // Build test URLs for TV verification
  const testResults = {
    ready: !!castUrl,
    timestamp: Date.now(),
    sessionId: activeSession.id,
    castUrl: castUrl || null,
    subtitleManifestUrl: subtitleManifestUrl || null,
    playerUrl: lifecycleStatus.playerUrl || null,
    tests: {
      castUrlAccessible: castUrl ? !castUrl.includes('localhost') : false,
      subtitleManifestAccessible: subtitleManifestUrl ? !subtitleManifestUrl.includes('localhost') : false,
      streamRunning: !!activeSession.streamManager,
    },
    recommendations: []
  };
  
  // Add recommendations if there are issues
  if (!testResults.tests.castUrlAccessible && castUrl) {
    testResults.recommendations.push(
      'Cast URL uses localhost. Open Uplayer from your network IP (e.g., http://192.168.x.x:3000) instead of localhost.'
    );
  }
  
  if (!testResults.tests.castUrlAccessible && !castUrl) {
    testResults.recommendations.push(
      'No cast URL available. Make sure the stream has started successfully.'
    );
  }
  
  res.json(testResults);
});

// --- DLNA push-cast (smart TVs) -----------------------------------------------
// Discover UPnP MediaRenderers on the LAN and push the active stream to one. Unlike
// Chromecast (which needs H.264/AAC via the :8000 HLS), DLNA TVs play TorrServer's
// native :8090 stream — the ORIGINAL file at full quality, no transcoding.

// Rewrite a localhost/loopback media URL to the server's LAN IP so the TV can reach it.
function lanReachable(urlStr) {
  if (!urlStr) return urlStr;
  try {
    const u = new URL(urlStr);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
      u.hostname = getLocalIPv4Address();
    }
    return u.toString();
  } catch (e) { return urlStr; }
}

app.get('/api/dlna/devices', async (req, res) => {
  try {
    const debug = req.query.debug === '1';
    const devices = await dlna.discover({
      timeout: Math.min(8000, Math.max(1500, Number(req.query.timeout) || 4000)),
      debug,
    });
    const payload = { devices };
    if (debug) payload.raw = dlna.getLastRaw(); // every SSDP responder, to diagnose "TV not found"
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message, devices: [] }); }
});

app.post('/api/dlna/play', async (req, res) => {
  try {
    const { deviceId, sessionId, title, subtitleUrl } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    let session = sessionId ? streamSessions.get(sessionId) : null;
    if (!session) session = sessionRegistry.currentStreamSession();
    if (!session) return res.status(404).json({ error: 'No active stream to cast' });
    const st = getSessionPlayerState(session);
    const mediaUrl = lanReachable(st.vlcUrl); // TorrServer :8090 native stream = original quality
    if (!mediaUrl) return res.status(409).json({ error: 'Stream not ready yet' });
    const r = await dlna.play(deviceId, mediaUrl, {
      title: title || 'Uplayer',
      subtitleUrl: subtitleUrl ? lanReachable(subtitleUrl) : '',
    });
    startDlnaProgress(session, deviceId);
    res.json(Object.assign({ mediaUrl }, r));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// A TV plays on its own — nothing pings /api/progress the way the web player does — so
// poll the renderer for its playhead and fold it into history. Without this, watching a
// whole episode on the TV leaves "Continue Watching" stuck at 0.
function startDlnaProgress(session, deviceId) {
  const key = `dlna:${deviceId}`;
  stopPlaybackTarget(session, key);
  // Discovery already learned the TV's friendly name, model and address — carry them
  // onto the target so the UI can say "Samsung Q80 (192.168.1.42)" rather than echoing
  // a UUID nobody can match to a box in their living room.
  const known = typeof dlna.getDevice === 'function' ? dlna.getDevice(deviceId) : null;
  const target = getPlaybackTarget(session, key, 'dlna', known ? {
    name: known.name, model: known.model, address: known.address,
  } : null);
  let misses = 0;

  setPlaybackTimer(session, key, setInterval(async () => {
    // The session went away (stream stopped) — nothing left to attribute progress to.
    if (!streamSessions.has(session.id)) return stopPlaybackTarget(session, key);
    let st;
    try {
      st = await dlna.status(deviceId);
    } catch (e) {
      st = null;
    }

    // A device that won't answer at all is a miss: TV switched off, or off the network.
    // Give up rather than poll a dead renderer forever.
    if (!st || !st.ok) {
      misses += 1;
      if (misses >= 3) {
        target.gone('unreachable');
        stopPlaybackTarget(session, key);
      }
      return;
    }
    misses = 0;

    // A device that answers STOPPED is NOT a miss — it's an answer, and the most
    // important one we get. Lumping it in with unreachable (as this used to) threw away
    // the only signal that the episode finished, which is why casting never triggered
    // auto-next. Whether it means "finished" or "user bailed" is for the target to
    // decide from the playhead it retained.
    const state = DLNA_STATES[String(st.state || '').toUpperCase()];
    if (!state) return;
    target.report({
      state,
      positionSec: hhmmssToSeconds(st.relTime), // null when the renderer says NOT_IMPLEMENTED
      durationSec: hhmmssToSeconds(st.duration),
    });
    if (state === 'stopped' || state === 'idle') stopPlaybackTarget(session, key);
  }, 15000));
}

app.post('/api/dlna/stop', async (req, res) => {
  try {
    const deviceId = (req.body || {}).deviceId;
    // Casting stopped — stop polling this TV (the last position is already recorded).
    // Only this device's target: a blanket sweep here used to also kill an unrelated
    // session's VLC poller, back when every session had a single shared timer slot.
    for (const s of streamSessions.values()) stopPlaybackTarget(s, `dlna:${deviceId}`);
    res.json(await dlna.stop(deviceId));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/dlna/pause', async (req, res) => { try { res.json(await dlna.pause((req.body || {}).deviceId)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.post('/api/dlna/resume', async (req, res) => { try { res.json(await dlna.resume((req.body || {}).deviceId)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get('/api/dlna/status', async (req, res) => { try { res.json(await dlna.status(req.query.deviceId)); } catch (e) { res.status(502).json({ error: e.message }); } });
// Whether this renderer supports Seek, asked before offering a restart-and-seek so the
// offer can be honest about what it will cost. "unknown" is a real answer here — see
// core/dlna-caster transportActions.
app.get('/api/dlna/capabilities', async (req, res) => {
  try { res.json(await dlna.transportActions(req.query.deviceId)); }
  catch (e) { res.status(502).json({ error: e.message, ok: false, actions: [], canSeek: false }); }
});
// UPnP has no way to hot-swap a subtitle sidecar: a corrected file only reaches the TV
// by re-sending the URI, which restarts the title at 00:00. Seek is what puts the viewer
// back where they were. `target` is REL_TIME, "HH:MM:SS".
app.post('/api/dlna/seek', async (req, res) => {
  try {
    const { deviceId, target } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    if (!/^\d{1,2}:\d{2}:\d{2}$/.test(String(target || ''))) return res.status(400).json({ error: 'target must be HH:MM:SS' });
    res.json(await dlna.seek(deviceId, String(target)));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// --- App configuration (API keys) --------------------------------------------
// Keys are entered in the Settings popup instead of a .env file, so a fresh PC
// needs no setup — it just asks for what it needs. Status returns booleans only;
// the secret values are never sent back to the browser.

app.get('/api/config', (req, res) => {
  const status = getConfigStatus();
  res.json({
    status,
    needsSetup: !status.TMDB_API_KEY, // TMDB is required for browsing/search
    fields: [
      { key: 'TMDB_API_KEY', label: 'TMDB API Key', required: true, help: 'Free at themoviedb.org → Settings → API. Powers all movie/TV browsing & search.' },
      { key: 'OPENSUBTITLES_API_KEY', label: 'OpenSubtitles API Key', required: false, help: 'Optional. Subtitles work without it (YIFY/Gestdown/Addic7ed/SubsPlease scrapers); an opensubtitles.com key just adds one more source.' },
      { key: 'OPENSUBTITLES_USERNAME', label: 'OpenSubtitles Username', required: false },
      { key: 'OPENSUBTITLES_PASSWORD', label: 'OpenSubtitles Password', required: false, secret: true },
    ],
    // Rendered by dedicated Settings sections (not the generic field loop).
    preferredQuality: getEnv('PREFERRED_QUALITY', '1080p'),
  });
});

app.post('/api/config', (req, res) => {
  try {
    const allowed = ['TMDB_API_KEY', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD', 'PREFERRED_QUALITY'];
    const values = {};
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) values[k] = req.body[k];
    }
    setConfigValues(values);

    // Apply to the already-running services without a restart.
    const svc = getServices();
    const cfg = getRuntimeConfig();
    svc.runtime.config.tmdbApiKey = cfg.tmdbApiKey;
    svc.runtime.config.openSubtitles = cfg.openSubtitles;
    if (svc.tmdbClient) svc.tmdbClient.apiKey = cfg.tmdbApiKey;

    res.json({ ok: true, status: getConfigStatus() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  const resolvedPort = addr && typeof addr === 'object' ? addr.port : getPort();
  return buildAccessibleUrls(resolvedPort).localhost;
}

function startServer(port = getPort()) {
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
  startServer(getPort());

  // Start the torrent engine ONCE, up front, so it's ready before the first stream and
  // stays up for the whole life of the app — no per-stream start/stop churn. Streams just
  // add/remove torrents against it. It's stopped only when the app itself exits.
  const { getSharedClient } = require('./core/torrserver-client');
  const torrServer = getSharedClient({
    log: (m) => console.log(String(m)),
    // Engine lifecycle (crash / respawn / respawn-failed). The per-session view of
    // the same fact rides stream_health.engineDown, fed by each session's stats poll;
    // this callback is the app-level record of it.
    onEvent: (ev) => console.warn('[torrserver] ' + JSON.stringify(ev)),
  });
  torrServer.start().catch((e) => console.error('TorrServer failed to start:', e && e.message));

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { torrServer.stop(); } catch (e) { /* ignore */ }
    // Give the kill a beat to fire, then exit.
    setTimeout(() => process.exit(0), 300);
    if (signal) console.log(`\nShutting down (${signal})…`);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
module.exports.app = app;
module.exports.startServer = startServer;
module.exports.stopServer = stopServer;
module.exports.getServerUrl = getServerUrl;

// Exposed for tests/vlc-progress.test.js, which drives the real poller against a fake
// VLC web interface — the only way to cover the scrape without launching VLC.
module.exports._internals = {
  streamSessions,
  createStreamSession,
  startVlcProgress,
  getPlaybackTarget,
  stopExternalProgress,
  pushSubtitleToVlc,
  pickVlcSubtitle,
  vlcSubtitleFile,
  vlcSubtitleTrackIds,
};

