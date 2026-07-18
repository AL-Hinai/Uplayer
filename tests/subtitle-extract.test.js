'use strict';
// Regression test for embedded-subtitle extraction.
//
// The two-pass extractor writes to a temp file ending in `.tmp` and atomically renames
// it into place. ffmpeg picks its MUXER from the output extension, so `.tmp` makes it
// abort with "Unable to choose an output format" unless `-f webvtt` is passed explicitly.
// That failure was silent: the track stayed ready:false for the whole session, there is
// no retry, and the player skips non-ready tracks — so NO subtitles ever appeared.
//
// Builds a real MKV with an embedded subtitle track and drives the actual extractor.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { StreamManager } = require('../uplayer.js');

const ffmpegPath = (() => {
  try { return require('ffmpeg-static'); } catch (e) { return null; }
})();
const ffprobePath = (() => {
  try { return require('ffprobe-static').path; } catch (e) { return null; }
})();

function buildFixture(dir) {
  const srt = path.join(dir, 'src.srt');
  fs.writeFileSync(srt, [
    '1', '00:00:01,000 --> 00:00:03,000', 'First embedded line.', '',
    '2', '00:00:04,000 --> 00:00:06,000', 'Second embedded line.', '',
  ].join('\n'));
  const mkv = path.join(dir, 'fixture.mkv');
  const r = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=8',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English subs',
    '-shortest', '-t', '8', '-y', mkv,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(mkv)) {
    throw new Error('fixture build failed: ' + (r.stderr || '').slice(-300));
  }
  return mkv;
}

// Mirrors the readiness rule in the /api/subtitles handler.
function isReady(sub) {
  if (sub.isPlaceholder || !sub.path) return false;
  try { return fs.existsSync(sub.path) && fs.statSync(sub.path).size > 24; } catch (e) { return false; }
}

async function testEmbeddedSubtitlesBecomeReady() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subextract-'));
  try {
    const mkv = buildFixture(dir);

    const sm = Object.create(StreamManager.prototype);
    sm.tempDir = dir;
    sm.subtitlePaths = [];
    sm.activeStreams = new Set();
    sm._torrserverStreamUrl = mkv;   // ffmpeg/ffprobe read a local path the same way
    sm.ffmpegPath = ffmpegPath;
    sm.ffprobePath = ffprobePath;
    sm._log = () => {};

    await sm.extractEmbeddedSubtitlesStreaming(path.basename(mkv), {});

    assert.strictEqual(sm.subtitlePaths.length, 1, 'the embedded track should be detected');
    const sub = sm.subtitlePaths[0];
    assert.match(sub.label, /English subs/, 'track label comes from the stream tags');

    // Extraction is fire-and-forget; wait for both passes like the player's poll does.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !(sub.complete && isReady(sub))) {
      await new Promise((r) => setTimeout(r, 250));
    }

    assert.ok(isReady(sub), 'track must become ready — a .tmp output without -f webvtt fails silently and never does');
    assert.ok(sub.complete, 'the full pass must mark the track complete');
    assert.strictEqual(sub.isPlaceholder, false, 'a produced track is no longer a placeholder');

    const vtt = fs.readFileSync(sub.path, 'utf8');
    assert.match(vtt, /^WEBVTT/, 'output must be WebVTT');
    assert.match(vtt, /First embedded line\./, 'cue text must survive the conversion');
    assert.match(vtt, /Second embedded line\./);
    assert.ok((vtt.match(/-->/g) || []).length >= 2, 'both cues must be present');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
}

async function main() {
  if (!ffmpegPath || !ffprobePath) {
    console.log('subtitle-extract.test.js skipped (ffmpeg/ffprobe not available)');
    return;
  }
  await testEmbeddedSubtitlesBecomeReady();
  console.log('subtitle-extract.test.js passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
