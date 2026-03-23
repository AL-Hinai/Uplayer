'use strict';

const assert = require('assert');
const { StreamManager } = require('../uplayer');

function buildHtml(subtitlePaths) {
  return StreamManager.prototype.getNativePlayerHTML.call(
    {
      subtitlePaths,
      ffmpegPath: null,
    },
    '/video.mp4',
    'type="video/mp4"',
    'Demo Video',
    false
  );
}

function testIncludesSubtitleSyncUi() {
  const html = buildHtml([
    { language: 'en', label: 'English', source: 'downloaded' },
  ]);

  assert.match(html, /id="subtitleOverlay"/);
  assert.match(html, /id="subtitleAdjustBtn"/);
  assert.match(html, /id="subtitleAdjustPopup"/);
  assert.match(html, /id="subtitlePreview"/);
  assert.match(html, /Positive values delay subtitles/);
  assert.match(html, /"subtitleTracks":\[\{"index":0,"language":"en","label":"English","source":"downloaded"\}\]/);
}

function testHidesSyncButtonWithoutTracks() {
  const html = buildHtml([]);
  assert.match(html, /id="subtitleAdjustBtn"[^>]*hidden/);
}

function main() {
  testIncludesSubtitleSyncUi();
  testHidesSyncButtonWithoutTracks();
  console.log('native-player-html.test.js passed');
}

main();
