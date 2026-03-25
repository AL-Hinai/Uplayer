'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadCastHelpers(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('const CAST_SENDER_SCRIPT');
  const end = source.indexOf('function goBackFromWizard', start);

  assert.notStrictEqual(start, -1, 'cast helper constants not found');
  assert.notStrictEqual(end, -1, 'cast helper block not found');

  const context = {
    module: { exports: {} },
    exports: {},
    Promise,
    Map,
    URL,
    console,
    wizard: {
      sessionId: null,
      playerUrl: null,
      vlcUrl: null,
      castUrl: null,
      subtitleManifestUrl: null,
      titleText: 'Demo Stream',
    },
    state: { currentPage: 'stream' },
    fetchJson: async () => ({ subtitles: [] }),
    navigate: () => {},
    toast: () => {},
    navigator: {},
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      getElementById: () => null,
      getElementsByTagName: () => [],
      head: { appendChild: () => {} },
    },
    window: {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        pathname: '/index.html',
        search: '?page=stream',
        hash: '#/stream',
        href: 'http://localhost:3000/index.html?page=stream#/stream',
      },
    },
    escape: escapeHtml,
    setTimeout,
    clearTimeout,
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nmodule.exports = { isCastSenderOriginAllowed, buildLocalhostSenderUrl, buildCastMediaDraft, renderCastTvModalContent, loadCastSubtitleOptions, startChromecastCast, castTvState };`,
    context
  );

  return {
    ...context.module.exports,
    context,
  };
}

function loadActionHelpers(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('function updateStreamReadyActions');
  const end = source.indexOf('async function wizardStartStream', start);

  assert.notStrictEqual(start, -1, 'updateStreamReadyActions not found');
  assert.notStrictEqual(end, -1, 'updateStreamReadyActions block not found');

  const context = {
    module: { exports: {} },
    exports: {},
    normalizeActiveStreamMeta(meta = {}) {
      return {
        playerUrl: meta.playerUrl || meta.url || null,
      };
    },
    document: {
      getElementById: () => null,
    },
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nmodule.exports = { updateStreamReadyActions };`,
    context
  );

  return {
    ...context.module.exports,
    context,
  };
}

async function testSubtitleManifestTracksBecomeAbsoluteUrls() {
  const { loadCastSubtitleOptions } = loadCastHelpers({
    fetchJson: async () => ({
      subtitles: [
        { url: '/subtitle_0.vtt', label: 'English', language: 'en' },
        { url: '/subtitle_1.vtt', label: 'Arabic', language: 'ar' },
      ],
    }),
  });

  const tracks = await loadCastSubtitleOptions('http://192.168.1.50:8000/api/subtitles');
  assert.deepStrictEqual(tracks.map((track) => track.trackId), [1, 2]);
  assert.deepStrictEqual(tracks.map((track) => track.trackContentId), [
    'http://192.168.1.50:8000/subtitle_0.vtt',
    'http://192.168.1.50:8000/subtitle_1.vtt',
  ]);
}

function testBuildCastMediaDraftHonorsSelectedSubtitleTrack() {
  const { buildCastMediaDraft } = loadCastHelpers();
  const draft = buildCastMediaDraft(
    { castUrl: 'http://192.168.1.50:8000/video.mp4?compat=1' },
    [
      { trackId: 1, trackContentId: 'http://192.168.1.50:8000/subtitle_0.vtt', name: 'English', language: 'en', ready: true },
      { trackId: 2, trackContentId: 'http://192.168.1.50:8000/subtitle_1.vtt', name: 'Arabic', language: 'ar', ready: true },
    ],
    '2',
    'Demo Movie'
  );

  assert.strictEqual(draft.contentId, 'http://192.168.1.50:8000/video.mp4?compat=1');
  assert.strictEqual(draft.contentType, 'video/mp4');
  assert.strictEqual(draft.streamType, 'LIVE');
  assert.deepStrictEqual(Array.from(draft.activeTrackIds), [2]);
  assert.strictEqual(draft.metadata.title, 'Demo Movie');
}

function testBuildCastMediaDraftOmitsTracksWhenNoSubtitlesSelected() {
  const { buildCastMediaDraft } = loadCastHelpers();
  const draft = buildCastMediaDraft(
    { castUrl: 'http://192.168.1.50:8000/video.mp4' },
    [
      { trackId: 1, trackContentId: 'http://192.168.1.50:8000/subtitle_0.vtt', name: 'English', ready: true },
    ],
    '',
    'Demo'
  );
  assert.strictEqual(draft.tracks.length, 0);
  assert.deepStrictEqual(Array.from(draft.activeTrackIds), []);
}

function testRenderCastTvModalUsesPlayerUrlForTvLinkOnly() {
  const { renderCastTvModalContent } = loadCastHelpers();
  const playerUrl = 'http://tv-link.example/player';
  const vlcUrl = 'http://localhost:8000/video.mkv';
  const castUrl = 'http://cast-link.example/video.mp4';
  const html = renderCastTvModalContent(
    {
      playerUrl,
      vlcUrl,
      castUrl,
    },
    {
      senderAllowed: false,
      senderHelperUrl: 'http://localhost:3000/#/stream',
      subtitleOptions: [],
      selectedSubtitleTrackId: '',
    }
  );

  assert.match(html, /Open on localhost for Cast/);
  assert.ok(html.includes(playerUrl), 'TV link should use the player URL');
  assert.ok(!html.includes(vlcUrl), 'TV link should not leak the VLC localhost URL');
  assert.ok(!html.includes(castUrl), 'TV link should not use the Chromecast media URL');
}

function testRenderCastTvModalShowsSubtitleChooserAndNoSubtitleWarning() {
  const { renderCastTvModalContent } = loadCastHelpers();
  const withTracks = renderCastTvModalContent(
    { playerUrl: 'http://tv-link.example/player' },
    {
      senderAllowed: true,
      subtitleOptions: [
        { trackId: 1, name: 'English', ready: true },
        { trackId: 2, name: 'Arabic', ready: true },
      ],
      selectedSubtitleTrackId: '2',
    }
  );
  assert.match(withTracks, /Subtitle track/);
  assert.match(withTracks, /value="2" selected/);
  assert.match(withTracks, /Preparing Chromecast|Choose Chromecast/);

  const withoutTracks = renderCastTvModalContent(
    { playerUrl: 'http://tv-link.example/player' },
    {
      senderAllowed: true,
      subtitleOptions: [],
      selectedSubtitleTrackId: '',
    }
  );
  assert.match(withoutTracks, /No subtitles available for this stream/);
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function testStartChromecastRequestsSessionBeforeSubtitleRefresh() {
  const calls = [];
  const session = {
    media: null,
    getStatus() {
      return 'connected';
    },
    getVolume() {
      return 0.5;
    },
    isMuted() {
      return false;
    },
    getReceiverStatus() {
      return { receiver: { friendlyName: 'Test TV' } };
    },
    async loadMedia() {
      calls.push('load');
    },
  };
  let mockCurrentSession = null;
  const { startChromecastCast, castTvState } = loadCastHelpers({
    fetchJson: async () => {
      calls.push('fetch');
      return {
        subtitles: [
          { url: '/subtitle_0.vtt', label: 'English', language: 'en', ready: true },
        ],
      };
    },
    toast: () => {},
    closeCastTvModal: () => {},
    window: {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '3000',
        pathname: '/index.html',
        search: '?page=stream',
        hash: '#/stream',
        href: 'http://localhost:3000/index.html?page=stream#/stream',
      },
      cast: {
        framework: {
          CastContext: {
            getInstance() {
              return {
                setOptions() {},
                getCurrentSession() {
                  return mockCurrentSession;
                },
                requestSession() {
                  calls.push('request');
                  // Real Cast Framework resolves with no session; session comes from getCurrentSession().
                  mockCurrentSession = session;
                  return Promise.resolve();
                },
              };
            },
          },
        },
      },
      chrome: {
        cast: {
          AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
          media: {
            DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
            MediaInfo: function MediaInfo(contentId, contentType) {
              this.contentId = contentId;
              this.contentType = contentType;
            },
            StreamType: { BUFFERED: 'BUFFERED', LIVE: 'LIVE' },
            PlayerState: { IDLE: 'IDLE', PLAYING: 'PLAYING' },
            IdleReason: { ERROR: 'ERROR' },
            GenericMediaMetadata: function GenericMediaMetadata() {},
            Track: function Track(trackId) {
              this.trackId = trackId;
            },
            TrackType: { TEXT: 'TEXT' },
            TextTrackType: { SUBTITLES: 'SUBTITLES' },
            LoadRequest: function LoadRequest(mediaInfo) {
              this.mediaInfo = mediaInfo;
            },
          },
        },
      },
    },
  });

  castTvState.senderAllowed = true;
  castTvState.castSdkReady = true;
  castTvState.meta = {
    castUrl: 'http://192.168.1.50:8000/video.mp4?compat=1',
    subtitleManifestUrl: 'http://192.168.1.50:8000/api/subtitles',
  };
  castTvState.subtitleOptions = [];
  castTvState.selectedSubtitleTrackId = '';

  assert.strictEqual(startChromecastCast(null), false);
  assert.deepStrictEqual(calls, ['request']);
  await flushAsyncWork();
  assert.deepStrictEqual(calls, ['request', 'fetch', 'load']);
}

function testUpdateStreamReadyActionsTogglesCastButtonWithPlayerReadiness() {
  const elements = {
    directPlayerLink: { href: '#', style: { display: 'none' } },
    castTvButton: { style: { display: 'none' } },
    vlcPlayerButton: { style: { display: 'none' } },
  };
  const { updateStreamReadyActions } = loadActionHelpers({
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
    },
  });

  updateStreamReadyActions(null);
  assert.strictEqual(elements.directPlayerLink.style.display, 'none');
  assert.strictEqual(elements.castTvButton.style.display, 'none');
  assert.strictEqual(elements.vlcPlayerButton.style.display, 'none');

  updateStreamReadyActions({ playerUrl: 'http://192.168.1.50:8000' });
  assert.strictEqual(elements.directPlayerLink.href, 'http://192.168.1.50:8000');
  assert.strictEqual(elements.directPlayerLink.style.display, '');
  assert.strictEqual(elements.castTvButton.style.display, '');
  assert.strictEqual(elements.vlcPlayerButton.style.display, '');
}

function testCastOriginHelpersPreferLocalhostOrHttps() {
  const { isCastSenderOriginAllowed, buildLocalhostSenderUrl } = loadCastHelpers();

  assert.strictEqual(isCastSenderOriginAllowed({
    protocol: 'http:',
    hostname: 'localhost',
  }), true);
  assert.strictEqual(isCastSenderOriginAllowed({
    protocol: 'https:',
    hostname: '192.168.1.50',
  }), true);
  assert.strictEqual(isCastSenderOriginAllowed({
    protocol: 'http:',
    hostname: '192.168.1.50',
  }), false);

  assert.strictEqual(buildLocalhostSenderUrl({
    protocol: 'http:',
    hostname: '192.168.1.50',
    port: '3000',
    pathname: '/index.html',
    search: '?page=stream',
    hash: '#/stream',
  }), 'http://localhost:3000/index.html?page=stream#/stream');
}

async function main() {
  await testSubtitleManifestTracksBecomeAbsoluteUrls();
  testBuildCastMediaDraftHonorsSelectedSubtitleTrack();
  testBuildCastMediaDraftOmitsTracksWhenNoSubtitlesSelected();
  testRenderCastTvModalUsesPlayerUrlForTvLinkOnly();
  testRenderCastTvModalShowsSubtitleChooserAndNoSubtitleWarning();
  await testStartChromecastRequestsSessionBeforeSubtitleRefresh();
  testUpdateStreamReadyActionsTogglesCastButtonWithPlayerReadiness();
  testCastOriginHelpersPreferLocalhostOrHttps();
  console.log('cast-tv-modal.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
