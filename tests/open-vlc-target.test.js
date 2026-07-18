'use strict';

// The VLC/cast/subtitle URLs a session exposes must stay SEPARATE — the localhost VLC media URL
// must never be handed to a Chromecast, and the raw media URL (not the player root) is what VLC
// should open so its seek bar works.
//
// This used to slice the three helpers out of server.js as text and vm-eval them, injecting a
// fake streamSessions Map. They now live in core/session-player-state.js and resolveOpenableSession
// takes the registry as an argument, so this is a plain require.

const assert = require('assert');
const {
  applySessionPlayerReady,
  getSessionPlayerState,
  resolveOpenableSession,
} = require('../core/session-player-state.js');

// The lifecycle's playerReady/status, minimal — enough for the helpers to read back what
// applySessionPlayerReady wrote. Mirrors core/stream-lifecycle.js's shape.
function createLifecycle() {
  return {
    _playerUrl: null,
    _playerReadyData: null,
    playerReady(payloadOrUrl) {
      const payload = payloadOrUrl && typeof payloadOrUrl === 'object' && !Array.isArray(payloadOrUrl)
        ? { ...payloadOrUrl }
        : { url: payloadOrUrl };
      const url = payload && payload.url ? String(payload.url) : '';
      if (!url || this._playerUrl) return false;
      this._playerUrl = url;
      this._playerReadyData = { ...payload, url };
      return true;
    },
    status() {
      return { playerUrl: this._playerUrl, playerReadyData: this._playerReadyData, exited: false };
    },
  };
}

function testResolveOpenableSessionPrefersRawMediaUrlForVlc() {
  const streamSessions = new Map();
  const session = {
    id: 'stream_1',
    lifecycle: createLifecycle(),
    streamManager: {},
    playerUrl: null,
    vlcUrl: null,
    playerUrls: null,
    mediaUrls: null,
  };

  applySessionPlayerReady(session, {
    url: 'http://192.168.1.50:8000',
    urls: { preferred: 'http://192.168.1.50:8000' },
    mediaUrl: 'http://localhost:8000/video.mkv',
    mediaUrls: { localhost: 'http://localhost:8000/video.mkv' },
  });

  streamSessions.set(session.id, session);

  // The player root is normalized to exactly one trailing slash — the stream-id prefix lives in
  // the path, and downstream code strips the slash where it needs to. (The old vm-slice version
  // of this test asserted NO slash, but only because its sandbox never provided the URL global,
  // so new URL() threw and the whole normalization was skipped into the catch. It was testing
  // the fallback, not the code. This is what the normalization actually does.)
  const status = getSessionPlayerState(session);
  assert.strictEqual(status.playerUrl, 'http://192.168.1.50:8000/');
  assert.strictEqual(status.vlcUrl, 'http://localhost:8000/video.mkv');

  const resolved = resolveOpenableSession(streamSessions, session.id);
  assert.strictEqual(resolved.url, 'http://192.168.1.50:8000/');
  assert.strictEqual(resolved.vlcUrl, 'http://localhost:8000/video.mkv');
}

function testTracksCastAndSubtitleUrlsSeparatelyFromVlcUrl() {
  const session = {
    id: 'stream_cast',
    lifecycle: createLifecycle(),
    streamManager: {},
    playerUrl: null,
    vlcUrl: null,
    castUrl: null,
    subtitleManifestUrl: null,
    playerUrls: null,
    mediaUrls: null,
    castUrls: null,
    subtitleManifestUrls: null,
  };

  applySessionPlayerReady(session, {
    url: 'http://192.168.1.50:8000',
    urls: { preferred: 'http://192.168.1.50:8000' },
    mediaUrl: 'http://localhost:8000/video.mkv',
    mediaUrls: { localhost: 'http://localhost:8000/video.mkv' },
    castUrl: 'http://192.168.1.50:8000/video.mp4?compat=1',
    castUrls: { preferred: 'http://192.168.1.50:8000/video.mp4?compat=1' },
    subtitleManifestUrl: 'http://192.168.1.50:8000/api/subtitles',
    subtitleManifestUrls: { preferred: 'http://192.168.1.50:8000/api/subtitles' },
  });

  const status = getSessionPlayerState(session);
  assert.strictEqual(status.playerUrl, 'http://192.168.1.50:8000/');
  assert.strictEqual(status.vlcUrl, 'http://localhost:8000/video.mkv');
  assert.strictEqual(status.castUrl, 'http://192.168.1.50:8000/video.mp4?compat=1');
  assert.strictEqual(status.subtitleManifestUrl, 'http://192.168.1.50:8000/api/subtitles');
  assert.notStrictEqual(status.vlcUrl, status.castUrl, 'Chromecast should not reuse the localhost VLC media URL');
}

// resolveOpenableSession without an id must skip an exited session and find the live one.
function testResolveWithoutIdPrefersLiveSession() {
  const streamSessions = new Map();

  const exited = { id: 'old', lifecycle: { status: () => ({ playerUrl: 'http://x/old/', exited: true }) }, streamManager: {}, playerUrl: 'http://x/old/' };
  const live = { id: 'new', lifecycle: createLifecycle(), streamManager: {}, playerUrl: null };
  applySessionPlayerReady(live, { url: 'http://x/new' });
  streamSessions.set(exited.id, exited);
  streamSessions.set(live.id, live);

  const resolved = resolveOpenableSession(streamSessions, null);
  assert.strictEqual(resolved.url, 'http://x/new/', 'should skip the exited session for the live one');
}

function main() {
  testResolveOpenableSessionPrefersRawMediaUrlForVlc();
  testTracksCastAndSubtitleUrlsSeparatelyFromVlcUrl();
  testResolveWithoutIdPrefersLiveSession();
  console.log('open-vlc-target.test.js passed');
}

main();
