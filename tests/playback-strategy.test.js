'use strict';

const assert = require('assert');
const { StreamManager } = require('../uplayer');

function decide(probe, containerExt) {
  return StreamManager.prototype.decidePlaybackStrategy.call({}, probe, containerExt);
}

function testMp4H264AacIsDirectPlay() {
  const result = decide(
    { vcodec: 'h264', vlevel: 40, acodec: 'aac', achannels: 2 },
    'mp4'
  );
  assert.strictEqual(result.strategy, 'directplay');
}

function testMkvH264AacIsRemuxOnly() {
  const result = decide(
    { vcodec: 'h264', vlevel: 40, acodec: 'aac', achannels: 2 },
    'mkv'
  );
  assert.strictEqual(result.strategy, 'remux');
  assert.ok(result.videoArgs.includes('copy'), 'video must stream-copy');
  assert.ok(result.videoArgs.includes('h264_mp4toannexb'), 'H.264 needs Annex-B BSF for MPEG-TS');
  assert.deepStrictEqual(result.audioArgs, ['-c:a', 'copy']);
}

function testMkvH264Ac3IsRemuxAudio() {
  const result = decide(
    { vcodec: 'h264', vlevel: 40, acodec: 'ac3', achannels: 6 },
    'mkv'
  );
  assert.strictEqual(result.strategy, 'remux-audio');
  assert.ok(result.videoArgs.includes('copy'), 'video must stream-copy');
  assert.ok(result.audioArgs.includes('aac'), 'audio must transcode to aac');
}

function testMkvHevcAacIsFullTranscode() {
  const result = decide(
    { vcodec: 'hevc', vlevel: 51, acodec: 'aac', achannels: 2 },
    'mkv'
  );
  assert.strictEqual(result.strategy, 'transcode');
  assert.strictEqual(result.hevcSource, true);
}

function testMp4H264HighLevelForcesTranscode() {
  // Level 5.2 (52) exceeds CC1AD845 cap; should fall to transcode despite container OK.
  const result = decide(
    { vcodec: 'h264', vlevel: 52, acodec: 'aac', achannels: 2 },
    'mp4'
  );
  assert.strictEqual(result.strategy, 'transcode');
}

function testWebmVp9IsFullTranscode() {
  const result = decide(
    { vcodec: 'vp9', vlevel: null, acodec: 'opus', achannels: 2 },
    'webm'
  );
  assert.strictEqual(result.strategy, 'transcode');
}

function testNoProbeFallsBackToExtension() {
  assert.strictEqual(decide(null, 'mp4').strategy, 'directplay');
  assert.strictEqual(decide(null, 'mkv').strategy, 'remux');
}

function testMp3AudioStaysCompatible() {
  const result = decide(
    { vcodec: 'h264', vlevel: 41, acodec: 'mp3', achannels: 2 },
    'mkv'
  );
  // h264 + mp3 in mkv should be remux (both codecs Cast-compatible, only container wrong)
  assert.strictEqual(result.strategy, 'remux');
}

function main() {
  testMp4H264AacIsDirectPlay();
  testMkvH264AacIsRemuxOnly();
  testMkvH264Ac3IsRemuxAudio();
  testMkvHevcAacIsFullTranscode();
  testMp4H264HighLevelForcesTranscode();
  testWebmVp9IsFullTranscode();
  testNoProbeFallsBackToExtension();
  testMp3AudioStaysCompatible();
  console.log('playback-strategy.test.js passed');
}

main();
