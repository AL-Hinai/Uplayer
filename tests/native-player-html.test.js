'use strict';

const assert = require('assert');
const { StreamManager } = require('../uplayer');

function buildHtml(subtitlePaths, streamBasePath) {
  return StreamManager.prototype.getNativePlayerHTML.call(
    {
      subtitlePaths,
      ffmpegPath: null,
      streamBasePath: streamBasePath || '',
    },
    '/video.mp4',
    'type="video/mp4"',
    'Demo Video',
    false
  );
}

function testCleanPlayerHtml() {
  const html = buildHtml([
    { language: 'en', label: 'English', source: 'downloaded' },
  ]);

  // Minimal player: one Video.js element + config + scripts.
  assert.match(html, /id="videoPlayer"/);
  assert.match(html, /class="video-js/);
  assert.match(html, /src="\/player\.js"/);
  assert.match(html, /src="\/vendor\/videojs\/video\.min\.js"/);
  assert.match(html, /"subtitleTracks":\[\{"index":0,"language":"en","label":"English","source":"downloaded","url":"\/subtitle_0\.vtt"\}\]/);
  assert.match(html, /"subtitleManifestUrl":"\/api\/subtitles"/);

  // The heavy custom UI was removed.
  assert.doesNotMatch(html, /id="subtitleAdjustPopup"/);
  assert.doesNotMatch(html, /id="subtitleSelect"/);
  assert.doesNotMatch(html, /id="errorOverlay"/);
  assert.doesNotMatch(html, /jassub/);
}

function testRendersWithoutTracks() {
  const html = buildHtml([]);
  assert.match(html, /id="videoPlayer"/);
  assert.match(html, /"subtitleTracks":\[\]/);
}

// With a per-stream base path, EVERY URL the player requests must carry the
// /<streamId> prefix so the shared hub can route it back to this stream.
function testPrefixesAllUrlsWithStreamBasePath() {
  const html = buildHtml(
    [{ language: 'en', label: 'English', source: 'downloaded' }],
    '/3f9a1b2c'
  );
  // Static assets
  assert.match(html, /href="\/3f9a1b2c\/player\.css"/);
  assert.match(html, /href="\/3f9a1b2c\/vendor\/videojs\/video-js\.min\.css"/);
  assert.match(html, /src="\/3f9a1b2c\/vendor\/videojs\/video\.min\.js"/);
  assert.match(html, /src="\/3f9a1b2c\/player\.js"/);
  // Config URLs
  assert.match(html, /"videoUrl":"\/3f9a1b2c\/video\.mp4"/);
  assert.match(html, /"subtitleManifestUrl":"\/3f9a1b2c\/api\/subtitles"/);
  assert.match(html, /"url":"\/3f9a1b2c\/subtitle_0\.vtt"/);
  // No unprefixed root asset should leak through
  assert.doesNotMatch(html, /src="\/player\.js"/);
  assert.doesNotMatch(html, /"subtitleManifestUrl":"\/api\/subtitles"/);
}

function main() {
  testCleanPlayerHtml();
  testRendersWithoutTracks();
  testPrefixesAllUrlsWithStreamBasePath();
  console.log('native-player-html.test.js passed');
}

main();
