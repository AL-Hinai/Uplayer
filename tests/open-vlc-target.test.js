'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadVlcSessionHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function applySessionPlayerReady');
  const end = source.indexOf('function buildVlcLaunchAttempts', start);

  assert.notStrictEqual(start, -1, 'applySessionPlayerReady not found');
  assert.notStrictEqual(end, -1, 'server VLC helper block not found');

  const context = {
    module: { exports: {} },
    exports: {},
    streamSessions: new Map(),
  };

  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nmodule.exports = { applySessionPlayerReady, getSessionPlayerState, resolveOpenableSession };`,
    context
  );

  return {
    ...context.module.exports,
    streamSessions: context.streamSessions,
  };
}

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
      this._playerReadyData = {
        ...payload,
        url,
      };
      return true;
    },
    status() {
      return {
        playerUrl: this._playerUrl,
        playerReadyData: this._playerReadyData,
        exited: false,
      };
    },
  };
}

function testResolveOpenableSessionPrefersRawMediaUrlForVlc() {
  const {
    applySessionPlayerReady,
    getSessionPlayerState,
    resolveOpenableSession,
    streamSessions,
  } = loadVlcSessionHelpers();

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

  const status = getSessionPlayerState(session);
  assert.strictEqual(status.playerUrl, 'http://192.168.1.50:8000');
  assert.strictEqual(status.vlcUrl, 'http://localhost:8000/video.mkv');

  const resolved = resolveOpenableSession(session.id);
  assert.strictEqual(resolved.url, 'http://192.168.1.50:8000');
  assert.strictEqual(resolved.vlcUrl, 'http://localhost:8000/video.mkv');
}

function testTracksCastAndSubtitleUrlsSeparatelyFromVlcUrl() {
  const {
    applySessionPlayerReady,
    getSessionPlayerState,
    streamSessions,
  } = loadVlcSessionHelpers();

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

  streamSessions.set(session.id, session);

  const status = getSessionPlayerState(session);
  assert.strictEqual(status.playerUrl, 'http://192.168.1.50:8000');
  assert.strictEqual(status.vlcUrl, 'http://localhost:8000/video.mkv');
  assert.strictEqual(status.castUrl, 'http://192.168.1.50:8000/video.mp4?compat=1');
  assert.strictEqual(status.subtitleManifestUrl, 'http://192.168.1.50:8000/api/subtitles');
  assert.notStrictEqual(status.vlcUrl, status.castUrl, 'Chromecast should not reuse the localhost VLC media URL');
}

function main() {
  testResolveOpenableSessionPrefersRawMediaUrlForVlc();
  testTracksCastAndSubtitleUrlsSeparatelyFromVlcUrl();
  console.log('open-vlc-target.test.js passed');
}

main();
