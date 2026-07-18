'use strict';

// Source facts: what the FILE is. The probe JSON here mirrors real ffprobe output,
// including the traps — a truncated sample's format.size, cover art muxed ahead of the
// real video stream, and VFR Matroska's nonsense frame rate.

const assert = require('assert');
const { normalizeProbe, legacyProbeAlias, toVideoFormat } = require('../core/media-facts');

const REAL_SIZE = 8 * 1024 * 1024 * 1024; // 8 GB file...
const SAMPLE_SIZE = 4 * 1024 * 1024;      // ...probed via a 4 MB sample

function probeJson(overrides = {}) {
  return {
    streams: [
      {
        index: 0, codec_type: 'video', codec_name: 'HEVC', profile: 'Main 10', level: 153,
        width: 3840, height: 2160, r_frame_rate: '24000/1001', avg_frame_rate: '24000/1001',
        pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10',
      },
      {
        index: 1, codec_type: 'audio', codec_name: 'EAC3', channels: 6,
        channel_layout: '5.1', tags: { language: 'eng', title: 'Surround' },
        disposition: { default: 1 },
      },
      {
        index: 2, codec_type: 'audio', codec_name: 'aac', channels: 2,
        channel_layout: 'stereo', tags: { language: 'fra' },
      },
      {
        index: 3, codec_type: 'subtitle', codec_name: 'subrip',
        tags: { language: 'eng' }, disposition: { forced: 1 },
      },
    ],
    format: {
      format_name: 'matroska,webm',
      duration: '7200.0',
      // What ffprobe says about the SAMPLE on disk. Both are lies about the real file.
      size: String(SAMPLE_SIZE),
      bit_rate: '4660',
      ...overrides.format,
    },
    ...overrides,
  };
}

// THE trap in "just stop discarding the fields": the probe runs against a ~4 MB
// truncated temp file, so format.size is 4 MB and format.bit_rate is derived from it.
// format.duration survives only because it's a header field — which is exactly why the
// original 7-field parse got away with reading it.
function testTruncatedSampleSizeIsNeverUsed() {
  const facts = normalizeProbe(probeJson(), REAL_SIZE);

  assert.strictEqual(facts.sizeBytes, REAL_SIZE, 'size must come from the caller, not the sample');
  assert.notStrictEqual(facts.sizeBytes, SAMPLE_SIZE);
  // 8 GB * 8 / 7200s ≈ 9.54 Mbps — a real 4K bitrate, not the sample's 4660 bps.
  assert.strictEqual(facts.bitrateBps, Math.round((REAL_SIZE * 8) / 7200));
  assert.ok(facts.bitrateBps > 9_000_000, 'a 4K film is ~9.5 Mbps, not 4.6 kbps');
}

function testNoSizeMeansNoBitrateGuess() {
  const facts = normalizeProbe(probeJson(), null);
  assert.strictEqual(facts.sizeBytes, null);
  assert.strictEqual(facts.bitrateBps, null, 'better no bitrate than a wrong one');
}

function testVideoFacts() {
  const facts = normalizeProbe(probeJson(), REAL_SIZE);
  assert.deepStrictEqual(facts.video, {
    codec: 'hevc', profile: 'main 10', level: 153,
    width: 3840, height: 2160, fps: 23.976, pixFmt: 'yuv420p10le', bitDepth: 10,
  });
  assert.strictEqual(facts.container, 'matroska,webm');
  assert.strictEqual(facts.durationSec, 7200);
}

// Cover art muxed into an MKV is a video stream to ffprobe, and it usually comes FIRST.
// Picking it would report a JPEG's dimensions as the film's resolution.
function testCoverArtIsNotTheVideoStream() {
  const json = probeJson();
  json.streams.unshift({
    index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900,
    disposition: { attached_pic: 1 },
  });

  const facts = normalizeProbe(json, REAL_SIZE);
  assert.strictEqual(facts.video.codec, 'hevc', 'must skip the attached_pic stream');
  assert.strictEqual(facts.video.width, 3840, 'not the 600px poster');
}

// A file that really is just cover art shouldn't come back empty-handed.
function testAttachedPicOnlyFallsBack() {
  const facts = normalizeProbe({
    streams: [{ codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 900, disposition: { attached_pic: 1 } }],
    format: { duration: '10' },
  }, 1000);
  assert.strictEqual(facts.video.codec, 'mjpeg', 'fall back rather than report no video at all');
}

// Real ffprobe omits bits_per_raw_sample even on genuinely 10-bit HEVC (verified
// against a real encode) — pix_fmt is the field that actually carries it.
function testBitDepthComesFromPixFmtWhenAbsent() {
  const depth = (stream) => normalizeProbe({
    streams: [Object.assign({ codec_type: 'video', codec_name: 'hevc' }, stream)], format: {},
  }, 100).video.bitDepth;

  assert.strictEqual(depth({ pix_fmt: 'yuv420p10le' }), 10, 'the real-world HEVC 10-bit case');
  assert.strictEqual(depth({ pix_fmt: 'yuv444p12le' }), 12);
  assert.strictEqual(depth({ pix_fmt: 'yuv420p' }), 8, 'plain 420p is 8-bit');
  assert.strictEqual(depth({ pix_fmt: '' }), null, 'unknown stays unknown');
  assert.strictEqual(depth({ pix_fmt: 'yuv420p', bits_per_raw_sample: '10' }), 10,
    'an explicit value still wins');
}

function testFrameRateEdgeCases() {
  const facts = (r, avg) => normalizeProbe({
    streams: [{ codec_type: 'video', codec_name: 'h264', r_frame_rate: r, avg_frame_rate: avg }],
    format: {},
  }, 100).video.fps;

  assert.strictEqual(facts('0/0', null), null, 'a zero denominator must not divide');
  assert.strictEqual(facts('', ''), null);
  assert.strictEqual(facts('25/1', null), 25);
  assert.strictEqual(facts('24000/1001', null), 23.976);
  // VFR Matroska routinely claims 1000fps; avg_frame_rate is the honest answer.
  assert.strictEqual(facts('1000000/1', '24000/1001'), 23.976, 'absurd r_frame_rate falls back to avg');
}

function testTrackLists() {
  const facts = normalizeProbe(probeJson(), REAL_SIZE);

  assert.strictEqual(facts.audioTracks.length, 2, 'both audio tracks, not just the first');
  assert.deepStrictEqual(facts.audioTracks[0], {
    index: 1, codec: 'eac3', channels: 6, channelLayout: '5.1',
    language: 'eng', title: 'Surround', default: true,
  });
  assert.strictEqual(facts.audioTracks[1].language, 'fra');
  assert.strictEqual(facts.audioTracks[1].default, false);

  assert.strictEqual(facts.subtitleTracks.length, 1);
  assert.strictEqual(facts.subtitleTracks[0].forced, true);
  assert.strictEqual(facts.subtitleTracks[0].index, 3, 'container index — VLC selects by this');
}

// decidePlaybackStrategy reads probe.vcodec/acodec/vlevel and probeMediaStreams retries
// on !r.vcodec. Those must keep working byte-for-byte off the same object.
function testLegacyAliasFeedsPlaybackStrategy() {
  const facts = normalizeProbe(probeJson(), REAL_SIZE);
  assert.deepStrictEqual(legacyProbeAlias(facts), {
    vcodec: 'hevc',
    vprofile: 'main 10',
    vlevel: 153,
    acodec: 'eac3',
    achannels: 6,
    container: 'matroska,webm',
    durationSec: 7200,
  });
}

function testLegacyAliasOnEmptyProbe() {
  const facts = normalizeProbe({}, null);
  const alias = legacyProbeAlias(facts);
  assert.strictEqual(alias.vcodec, null, 'no video codec => the retry gate must fire');
  assert.strictEqual(alias.acodec, null);
  assert.strictEqual(facts.audioTracks.length, 0);
}

// videoFormat is what the UI and localStorage have always read. Its shape must not move.
function testVideoFormatProjectionIsUnchanged() {
  const facts = normalizeProbe(probeJson(), REAL_SIZE);
  assert.deepStrictEqual(toVideoFormat(facts, '.mkv', 'remux'), {
    container: 'mkv',
    codec: 'hevc',
    acodec: 'eac3',
    playbackStrategy: 'remux',
  });
  // container here is the EXTENSION, deliberately not ffprobe's format_name.
  assert.notStrictEqual(toVideoFormat(facts, '.mkv', 'remux').container, facts.container);
  assert.deepStrictEqual(toVideoFormat(facts, '', 'transcode').container, 'unknown');
}

function testVideoFormatSurvivesNoProbe() {
  assert.deepStrictEqual(toVideoFormat(null, '.mp4', 'directplay'), {
    container: 'mp4', codec: null, acodec: null, playbackStrategy: 'directplay',
  });
}

function main() {
  testTruncatedSampleSizeIsNeverUsed();
  testNoSizeMeansNoBitrateGuess();
  testVideoFacts();
  testCoverArtIsNotTheVideoStream();
  testAttachedPicOnlyFallsBack();
  testBitDepthComesFromPixFmtWhenAbsent();
  testFrameRateEdgeCases();
  testTrackLists();
  testLegacyAliasFeedsPlaybackStrategy();
  testLegacyAliasOnEmptyProbe();
  testVideoFormatProjectionIsUnchanged();
  testVideoFormatSurvivesNoProbe();
  console.log('media-facts.test.js passed');
}

main();
