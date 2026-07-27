'use strict';

// Which running stream session the wizard should ATTACH to when the stream page
// opens — or null, meaning: start a fresh one.
//
// The backend has always allowed concurrent sessions (UPLAYER_MAX_STREAMS, default 4;
// each gets its own StreamManager and torrent, TorrServer serves them all). What
// prevented playing two torrents at once was this decision, inlined in
// renderStreamPage: it adopted THE first running session unconditionally, so clicking
// Watch on a second title while one was streaming just hijacked the wizard into the
// first title's step 4.
//
// The rules now:
//   • Route names a session id (the "Manage" button in the active-streams list):
//     attach to exactly that session — or null if it's gone, never a substitute.
//   • Bare stream page (no title in the route — nav click, reload): attach to the
//     first running session, exactly as before. Reopening the page must never spawn
//     a duplicate.
//   • Route names a title (a Watch/Resume click): attach ONLY to a session already
//     playing that same title (same tmdbId — and same season+episode when both sides
//     know them). Anything else returns null and the wizard runs normally, creating
//     a second concurrent session. The active-streams list keeps the others reachable.
//   • A session whose media is unknown is never adopted for an explicit title
//     request: wrongly starting a duplicate is recoverable (stop it), wrongly
//     hijacking a different movie is the exact bug this replaces.
//
// PURE and fed by the caller, like next-episode.js, and for the same reason:
// tests/session-adopt.test.js require()s it with controlled sessions instead of
// slicing app.js source. Loaded as a classic script BEFORE app.js (see index.html),
// so `adoptableSession` is a window global there.

function adoptableSession(activeSessions, route) {
  const live = (activeSessions || []).filter((s) => s && (s.running || !s.exited));
  if (!live.length) return null;
  const r = route || {};
  // An explicit session id is the user pointing at a row in the list — exact match
  // or nothing. Falling back to "some other stream" here would be the hijack again.
  if (r.sessionId) return live.find((s) => String(s.id) === String(r.sessionId)) || null;
  if (!r.tmdbId) return live[0]; // bare page → historical behaviour

  const wantS = r.season != null ? Number(r.season) : null;
  const wantE = r.episode != null ? Number(r.episode) : null;
  return live.find((s) => {
    const m = s.media;
    if (!m || m.tmdbId == null) return false;
    if (String(m.tmdbId) !== String(r.tmdbId)) return false;
    if (wantS != null && m.season != null && Number(m.season) !== wantS) return false;
    if (wantE != null && m.episode != null && Number(m.episode) !== wantE) return false;
    return true;
  }) || null;
}

// Node require() for the test; harmless no-op in the browser (no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { adoptableSession };
}
