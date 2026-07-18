'use strict';

// Resolving a stream session's player-facing URLs, in one place.
//
// A session accumulates URLs from several sources: the StreamManager's player_ready payload,
// per-target fallbacks, the lifecycle's remembered playerReadyData. Three questions recur, and
// each used to be answered inline in a route:
//
//   applySessionPlayerReady  — fold a player_ready payload onto the session (normalize the
//                              player root, keep VLC/cast/subtitle URLs SEPARATE — the whole
//                              point is that a Chromecast must not reuse the localhost VLC URL)
//   getSessionPlayerState    — read those URLs back, with the fallback priority spelled out
//   resolveOpenableSession   — "which session should this open?", by id or by finding a live one
//
// The first two are pure — hand them a session, get an answer. The third needs the session
// registry, so it's INJECTED (the Map is the first argument) rather than reaching for a global.
// That is what lets this module be require()d and unit-tested directly, instead of being sliced
// out of server.js as text (which is what tests/open-vlc-target.test.js used to do).
//
// Pure: no IO, no timers. The caller owns the session objects and the registry.

function applySessionPlayerReady(session, payload = {}) {
  if (!session || !payload || typeof payload !== 'object') return false;

  // Normalize playerUrl to the player root. The path is PRESERVED because it carries this
  // stream's id prefix (http://host:port/<streamId>/) — that's how concurrent streams are told
  // apart now, instead of by port. We only drop any query/hash and guarantee one trailing slash.
  let rawPlayerUrl = payload.url ? String(payload.url) : null;
  let playerUrl = rawPlayerUrl;
  if (rawPlayerUrl) {
    try {
      const urlObj = new URL(rawPlayerUrl);
      const basePath = urlObj.pathname.replace(/\/+$/, '');
      playerUrl = urlObj.protocol + '//' + urlObj.host + basePath + '/';
    } catch (e) {
      // Keep original URL if parsing fails
    }
  }

  // VLC URL should be the full video URL, not the root URL.
  // Priority: payload.vlcUrl > payload.mediaUrl > payload.url + payload.videoPath > payload.url
  let vlcUrl = null;
  if (payload.vlcUrl) {
    vlcUrl = String(payload.vlcUrl);
  } else if (payload.mediaUrl) {
    vlcUrl = String(payload.mediaUrl);
  } else if (payload.videoPath && rawPlayerUrl) {
    vlcUrl = `${rawPlayerUrl.replace(/\/$/, '')}${payload.videoPath}`;
  } else if (rawPlayerUrl) {
    vlcUrl = rawPlayerUrl;
  }

  const castUrl = payload.castUrl
    ? String(payload.castUrl)
    : (payload.castUrls && payload.castUrls.preferred ? String(payload.castUrls.preferred) : null);
  const subtitleManifestUrl = payload.subtitleManifestUrl
    ? String(payload.subtitleManifestUrl)
    : (payload.subtitleManifestUrls && payload.subtitleManifestUrls.preferred
      ? String(payload.subtitleManifestUrls.preferred)
      : null);
  const videoFormat = payload.videoFormat || null;
  // What the file IS — probed once, true for every target that plays it.
  const mediaFacts = payload.mediaFacts || null;

  if (playerUrl) {
    session.playerUrl = playerUrl;
    session.playerUrls = payload.urls || session.playerUrls || null;
    if (videoFormat) {
      session.videoFormat = videoFormat;
    }
    if (mediaFacts) {
      session.mediaFacts = mediaFacts;
    }
    if (session.lifecycle) {
      session.lifecycle.playerReady({
        url: playerUrl,
        playerUrl,
        vlcUrl,
        castUrl,
        subtitleManifestUrl,
        videoFormat,
        mediaFacts,
      });
    }
  }

  if (vlcUrl) {
    session.vlcUrl = vlcUrl;
    session.mediaUrls = payload.mediaUrls || session.mediaUrls || null;
  }

  if (castUrl) {
    session.castUrl = castUrl;
    session.castUrls = payload.castUrls || session.castUrls || null;
  }

  if (subtitleManifestUrl) {
    session.subtitleManifestUrl = subtitleManifestUrl;
    session.subtitleManifestUrls = payload.subtitleManifestUrls || session.subtitleManifestUrls || null;
  }

  return !!playerUrl;
}

function getSessionPlayerState(session) {
  const lifecycleStatus = session && session.lifecycle
    ? session.lifecycle.status()
    : { playerUrl: null, exited: false };
  const playerReadyData = lifecycleStatus.playerReadyData || {};
  const playerUrl = session && session.playerUrl
    ? session.playerUrl
    : (playerReadyData.url || lifecycleStatus.playerUrl);
  const castUrl = session && session.castUrl
    ? session.castUrl
    : (playerReadyData.castUrl || null);
  const subtitleManifestUrl = session && session.subtitleManifestUrl
    ? session.subtitleManifestUrl
    : (playerReadyData.subtitleManifestUrl || null);
  const videoFormat = session && session.videoFormat
    ? session.videoFormat
    : (playerReadyData.videoFormat || null);
  const mediaFacts = session && session.mediaFacts
    ? session.mediaFacts
    : (playerReadyData.mediaFacts || null);

  // VLC URL fallback priority:
  // session.vlcUrl > playerReadyData.vlcUrl > playerReadyData.mediaUrl > playerReadyData.url > playerUrl
  let vlcUrl = session && session.vlcUrl ? session.vlcUrl : null;
  if (!vlcUrl && playerReadyData) {
    vlcUrl = playerReadyData.vlcUrl || playerReadyData.mediaUrl || playerReadyData.url || playerUrl;
  }

  return {
    playerUrl,
    vlcUrl: vlcUrl || playerUrl,
    castUrl,
    subtitleManifestUrl,
    videoFormat,
    mediaFacts,
    exited: !!lifecycleStatus.exited,
    // Additive: what the last-reporting target was doing. A client that reconnects mid-stream
    // picks the playback state up here instead of waiting for the next SSE event, which may be
    // 15s away on a polled target.
    playback: lifecycleStatus.playback || null,
  };
}

// `sessions` is the live registry Map, injected rather than reached for. With an id, resolve
// that session; without one, prefer a running session that has a player, then fall back to any
// session that has one.
function resolveOpenableSession(sessions, sessionId) {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { error: 'Session not found' };
    const status = getSessionPlayerState(session);
    if (!status.playerUrl) return { error: 'Player is still starting' };
    return { session, url: status.playerUrl, vlcUrl: status.vlcUrl || status.playerUrl };
  }

  for (const session of sessions.values()) {
    const status = getSessionPlayerState(session);
    if (status.playerUrl && session.streamManager && !status.exited) {
      return { session, url: status.playerUrl, vlcUrl: status.vlcUrl || status.playerUrl };
    }
  }

  for (const session of sessions.values()) {
    const status = getSessionPlayerState(session);
    if (status.playerUrl) {
      return { session, url: status.playerUrl, vlcUrl: status.vlcUrl || status.playerUrl };
    }
  }

  return { error: 'Player is still starting' };
}

module.exports = {
  applySessionPlayerReady,
  getSessionPlayerState,
  resolveOpenableSession,
};
