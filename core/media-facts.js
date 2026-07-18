'use strict';

// What the media file IS — codec, resolution, bitrate, the tracks inside it.
//
// These are SOURCE facts: they're a property of the file, not of whoever happens to be
// playing it. A DLNA TV can't tell you the bitrate and never will, but it doesn't need
// to — ffprobe already ran. So this is probed once, stored on the session, and shared
// by every target, rather than being asked of each one and getting four different
// half-answers back.
//
// Distinct from what a player is ACHIEVING right now (resolution actually decoded,
// frames dropped) — that's delivery health and lives on the PlaybackTarget. The two
// diverge exactly when something is wrong, which is the whole diagnostic value.
//
// Pure: no IO, no timers. The caller runs ffprobe and hands the JSON in.

// Number(null) and Number('') are both 0, so a plain Number.isFinite check would turn
// "ffprobe didn't report this" into a confident zero — and a zero size silently becomes
// a zero bitrate. Absent must stay absent.
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function lower(value) {
  return value ? String(value).toLowerCase() : null;
}

// ffprobe reports "24000/1001" (and "0/0" when it has no idea). Guard the divide, and
// reject absurd results: VFR Matroska routinely claims r_frame_rate=1000/1, in which
// case avg_frame_rate is the honest answer.
function parseRate(rate, fallbackRate) {
  const parse = (text) => {
    const m = /^(\d+)\/(\d+)$/.exec(String(text || '').trim());
    if (!m) return null;
    const den = Number(m[2]);
    if (!den) return null;
    const fps = Number(m[1]) / den;
    return Number.isFinite(fps) && fps > 0 ? fps : null;
  };
  const primary = parse(rate);
  if (primary != null && primary <= 1000) return Math.round(primary * 1000) / 1000;
  const fallback = parse(fallbackRate);
  if (fallback != null && fallback <= 1000) return Math.round(fallback * 1000) / 1000;
  return primary != null ? Math.round(primary * 1000) / 1000 : null;
}

// Real ffprobe usually omits bits_per_raw_sample entirely — a genuinely 10-bit HEVC
// stream reports nothing there — so the honest source is pix_fmt: "yuv420p10le" is
// 10-bit, plain "yuv420p" is 8-bit. Verified against real ffprobe output, not docs.
function bitDepthFrom(stream) {
  const explicit = finiteOrNull(stream.bits_per_raw_sample);
  if (explicit != null) return explicit;
  const pix = String(stream.pix_fmt || '');
  if (!pix) return null;
  const m = /p(\d+)(?:le|be)?$/.exec(pix);
  if (m) return Number(m[1]);
  return /p$|p[a-z]*$/.test(pix) ? 8 : null;
}

// A still image muxed into an MKV (cover art) is a video stream as far as ffprobe is
// concerned, and it usually comes FIRST. Picking it means reporting a JPEG's dimensions
// as the film's resolution. Harmless while only the codec name was kept; not harmless
// once width/height ship.
function pickVideoStream(streams) {
  const real = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  return real || streams.find((s) => s.codec_type === 'video') || null;
}

function trackLanguage(stream) {
  const tags = stream.tags || {};
  return tags.language || tags.LANGUAGE || null;
}

function trackTitle(stream) {
  const tags = stream.tags || {};
  return tags.title || tags.TITLE || null;
}

function isDisposition(stream, key) {
  return !!(stream.disposition && stream.disposition[key]);
}

/**
 * Normalize an ffprobe -show_streams -show_format JSON blob into source facts.
 *
 * `realSizeBytes` is REQUIRED and must be the true file size, not anything from the
 * JSON. The probe runs against a ~4 MB sample written to a temp file, so `format.size`
 * is the size of that sample and `format.bit_rate` is derived from it — both are
 * garbage for the real file. `format.duration` survives truncation only because it's a
 * header field, which is why the original 7-field parse got away with reading it.
 */
function normalizeProbe(json, realSizeBytes) {
  const parsed = json && typeof json === 'object' ? json : {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const format = parsed.format || {};

  const video = pickVideoStream(streams);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subtitleStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const durationSec = finiteOrNull(format.duration);
  const sizeBytes = finiteOrNull(realSizeBytes);
  // Derived, never read from the truncated sample.
  const bitrateBps = sizeBytes != null && durationSec != null && durationSec > 0
    ? Math.round((sizeBytes * 8) / durationSec)
    : null;

  return {
    container: lower(format.format_name),
    durationSec,
    sizeBytes,
    bitrateBps,
    video: video ? {
      codec: lower(video.codec_name),
      profile: lower(video.profile),
      level: finiteOrNull(video.level),
      width: finiteOrNull(video.width),
      height: finiteOrNull(video.height),
      fps: parseRate(video.r_frame_rate, video.avg_frame_rate),
      pixFmt: lower(video.pix_fmt),
      bitDepth: bitDepthFrom(video),
    } : null,
    audioTracks: audioStreams.map((s) => ({
      index: finiteOrNull(s.index),
      codec: lower(s.codec_name),
      channels: finiteOrNull(s.channels),
      channelLayout: s.channel_layout || null,
      language: trackLanguage(s),
      title: trackTitle(s),
      default: isDisposition(s, 'default'),
    })),
    // EMBEDDED subtitle tracks, in the CONTAINER's id space. Deliberately not the same
    // set as /api/subtitles, which holds what we extracted plus whisper/alass tracks
    // that don't exist in the file. VLC plays the original file, so this is the list
    // that matches what VLC can select. Do not conflate the two.
    subtitleTracks: subtitleStreams.map((s) => ({
      index: finiteOrNull(s.index),
      codec: lower(s.codec_name),
      language: trackLanguage(s),
      title: trackTitle(s),
      forced: isDisposition(s, 'forced'),
      default: isDisposition(s, 'default'),
    })),
    probedAt: Date.now(),
  };
}

/**
 * The 7 flat keys the rest of the codebase already reads (decidePlaybackStrategy takes
 * probe.vcodec/acodec/vlevel; probeMediaStreams retries on !r.vcodec). Kept as an alias
 * ON the facts object so both shapes have ONE owner and can't drift apart.
 */
function legacyProbeAlias(facts) {
  const v = facts.video || {};
  const firstAudio = facts.audioTracks[0] || {};
  return {
    vcodec: v.codec || null,
    vprofile: v.profile || null,
    vlevel: v.level,
    acodec: firstAudio.codec || null,
    achannels: firstAudio.channels == null ? null : firstAudio.channels,
    container: facts.container,
    durationSec: facts.durationSec,
  };
}

/**
 * The `videoFormat` the UI has always received, projected from facts rather than built
 * independently — one owner, no dual-write drift.
 *
 * NOTE `videoFormat.container` is the file EXTENSION while `facts.container` is
 * ffprobe's format_name ("matroska,webm"). Different things; don't unify them.
 * `playbackStrategy` is a DECISION from decidePlaybackStrategy, not a fact about the
 * file — it stays here and must never migrate into mediaFacts.
 */
function toVideoFormat(facts, containerExt, playbackStrategy) {
  const v = (facts && facts.video) || {};
  const firstAudio = (facts && facts.audioTracks && facts.audioTracks[0]) || {};
  return {
    container: String(containerExt || '').replace(/^\./, '') || 'unknown',
    codec: v.codec || null,
    acodec: firstAudio.codec || null,
    playbackStrategy,
  };
}

module.exports = {
  normalizeProbe,
  legacyProbeAlias,
  toVideoFormat,
};
