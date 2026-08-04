'use strict';

// Subtitle timestamps as arithmetic: read them, cut the window an alignment can actually
// see, apply a linear correction to a whole track, and recover the linear correction
// between two versions of one.
//
// Why this exists. The auto-fix aligns a downloaded subtitle against the only audio the
// swarm has delivered — the first 20 minutes. alass scores an alignment by how much of
// the subtitle overlaps reference speech, so handing it a 2-hour track and a 20-minute
// reference makes sliding the track BACKWARD by about one reference length score best:
// it drags the cues that follow the window into the window. On a real run (The Mandalorian
// and Grogu, 916 cues) it did exactly that — shifted by -20:37, clamped the first 152 cues
// to 00:00:00 — on a subtitle that was already correct to within 10ms. `--no-split` does
// not prevent this. It only makes the damage one shift instead of many.
//
// The cure is to stop asking a question the reference cannot answer: align ONLY the cues
// the reference actually covers, then carry that answer to the rest of the track. alass's
// answer is affine — an offset, plus its framerate correction, which is a global scale —
// so fitting `t -> scale*t + offset` over the aligned excerpt recovers it exactly and
// extrapolates without inventing anything. Measured over the six mis-timings in
// `tests/subtitle-window-sync.test.js`, the fit residual is 0-1ms and the recovered
// full-film timing lands within 20ms of truth, including the 25 -> 23.976fps cases where
// carrying only the offset would be five minutes wrong by the closing credits.
//
// Deliberately NOT here: any judgement about whether a correction is plausible. Deciding
// that a fix is too large to keep needs the media duration, the guards' thresholds and the
// whole picture — it lives in uplayer.js with the rest of them.
//
// Pure: no IO, no timers, no module state. Text in, text (or numbers) out.

// Only a full cue line is rewritten — `00:00:35,791 --> 00:00:37,208`, optionally with
// the WebVTT cue settings that follow it. Rewriting every timestamp-shaped run in the
// file instead would retime a line of dialogue that happens to quote a clock.
const CUE_LINE = /^(\s*)(\d{2,}:\d{2}:\d{2}[,.]\d{3})(\s*-->\s*)(\d{2,}:\d{2}:\d{2}[,.]\d{3})(.*)$/;
const STAMP = /^(\d{2,}):(\d{2}):(\d{2})([,.])(\d{3})$/;

function parseStamp(s) {
  const m = STAMP.exec(s);
  if (!m) return null;
  return { ms: ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[5]), sep: m[4] };
}

// Negative timestamps are clamped to zero rather than written out, which is what alass
// itself does. It is also what keeps `_implausibleSync` able to see the damage: cues that
// arrive at 00:00:00 and were not there before are the signature of a correction that ran
// the track off the front of the film.
function formatStamp(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / 3600000), 2)}:${pad(Math.floor(t / 60000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)}${sep}${pad(t % 1000, 3)}`;
}

// Cue START times in ms, in file order.
function cueStartsMs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = CUE_LINE.exec(line);
    if (!m) continue;
    const a = parseStamp(m[2]);
    if (a) out.push(a.ms);
  }
  return out;
}

// The leading slice of a track: every cue that STARTS before `windowMs`, renumbered so the
// result is a valid standalone subtitle. Returns { text, count }.
//
// The cut is made on the subtitle's own (wrong) timeline, because that is the only one
// available before the alignment runs. A track that is late by a minute therefore hands
// over a few cues whose audio sits just past the reference; alass tolerates that — what it
// cannot tolerate is the reverse, cues with no reference under them for an hour.
function trimToWindow(text, windowMs) {
  const blocks = String(text).split(/\r?\n\s*\r?\n/);
  const kept = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const cue = lines.find((l) => CUE_LINE.test(l));
    if (!cue) continue;
    const start = parseStamp(CUE_LINE.exec(cue)[2]);
    if (!start || start.ms >= windowMs) continue;
    // Drop the original sequence number so the excerpt numbers from 1; some parsers
    // (and alass's own reader) treat a gap as a malformed file.
    const body = /^\s*\d+\s*$/.test(lines[0]) ? lines.slice(1) : lines;
    kept.push(`${kept.length + 1}\n${body.join('\n')}`);
  }
  return { text: kept.join('\n\n') + (kept.length ? '\n' : ''), count: kept.length };
}

// Apply `t -> scale*t + offsetMs` to every cue timestamp, leaving all other text alone.
function applyLinear(text, { scale = 1, offsetMs = 0 } = {}) {
  return String(text)
    .split(/(\r?\n)/)
    .map((part) => {
      const m = CUE_LINE.exec(part);
      if (!m) return part;
      const a = parseStamp(m[2]);
      const b = parseStamp(m[4]);
      if (!a || !b) return part;
      return m[1] + formatStamp(a.ms * scale + offsetMs, a.sep) + m[3] + formatStamp(b.ms * scale + offsetMs, b.sep) + m[5];
    })
    .join('');
}

// Least-squares fit of `to[i] = scale*from[i] + offsetMs`, plus the worst residual it
// leaves. The residual is the honest part: a genuine alass correction over an excerpt is
// affine to within a millisecond, so anything larger means the correction was per-scene
// retiming — real, but not something an excerpt licenses extrapolating over the hour of
// film that has no audio to check it against.
//
// Returns null when there is nothing to fit: fewer than two cues, or every cue at the
// same timestamp (no spread, so any scale fits and none is justified).
function fitLinear(from, to) {
  if (!Array.isArray(from) || !Array.isArray(to)) return null;
  const n = Math.min(from.length, to.length);
  if (n < 2) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i += 1) { sumA += from[i]; sumB += to[i]; }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (from[i] - meanA) * (to[i] - meanB);
    den += (from[i] - meanA) * (from[i] - meanA);
  }
  if (den === 0) return null;
  const scale = num / den;
  const offsetMs = meanB - scale * meanA;
  let maxResidualMs = 0;
  for (let i = 0; i < n; i += 1) {
    maxResidualMs = Math.max(maxResidualMs, Math.abs(from[i] * scale + offsetMs - to[i]));
  }
  return { scale, offsetMs, maxResidualMs };
}

module.exports = { cueStartsMs, trimToWindow, applyLinear, fitLinear };
