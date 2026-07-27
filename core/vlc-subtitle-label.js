'use strict';

/*
 * Why this module exists: VLC's subtitle menu ignores what a subtitle FILE is called.
 * An external track is "Track 1", "Track 2", "Track 3" no matter what — measured on
 * 3.0.23 by loading identical cues five ways:
 *
 *     Auto-synced timing 1753574400000.srt  ->  "Track 1"
 *     movie.eng.srt                         ->  "Track 2 - [English]"
 *     synced.ass  (with [Script Info] Title)->  "Track 5"
 *     synced.mks  (Matroska track name)     ->  "Auto-synced timing - [Arabic]"
 *
 * Only two things get through: a language guessed from a filename suffix, and a Matroska
 * track NAME. So a subtitle bound for VLC is wrapped — cues untouched — in a one-track
 * .mks whose title is the label the rest of Uplayer already shows. That is the whole
 * module. It is what turns "which of these two Track Ns is the corrected one" into a
 * question the menu answers by itself.
 *
 * The wrapping is lossless: round-tripping an Arabic UTF-8 SRT with inline <i> markup
 * back out of the container reproduced the cue text byte for byte. Safe because the
 * download path already normalised the bytes to UTF-8 (core/subtitle-encoding.js); this
 * module assumes that and passes -sub_charenc UTF-8 rather than guessing again.
 *
 * Deliberately NOT the canonical subtitle. The web player's /subtitle_N.vtt route, the
 * cast burn-in and the DLNA sidecar all read the .srt, and an .mks would break all three.
 * This produces a SECOND artifact, used at the two VLC-only call sites and nowhere else.
 * Every failure path returns the original path unchanged, so the worst outcome is the
 * "Track N" naming we had before.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Matroska wants ISO 639-2; Uplayer carries ISO 639-1 (and sometimes the English name the
// keyless scrapers label rows with). Only the languages that actually show up in subtitle
// packs — an unknown code omits the tag rather than writing a wrong one, and VLC then
// shows the title alone, which is still the point of the exercise.
const ISO_639_2 = {
  ar: 'ara', arabic: 'ara', en: 'eng', english: 'eng', fr: 'fra', french: 'fra',
  es: 'spa', spanish: 'spa', de: 'deu', german: 'deu', it: 'ita', italian: 'ita',
  pt: 'por', portuguese: 'por', ru: 'rus', russian: 'rus', tr: 'tur', turkish: 'tur',
  nl: 'nld', dutch: 'nld', pl: 'pol', polish: 'pol', sv: 'swe', swedish: 'swe',
  fa: 'fas', persian: 'fas', he: 'heb', hebrew: 'heb', hi: 'hin', hindi: 'hin',
  id: 'ind', indonesian: 'ind', ja: 'jpn', japanese: 'jpn', ko: 'kor', korean: 'kor',
  zh: 'zho', chinese: 'zho', el: 'ell', greek: 'ell', cs: 'ces', da: 'dan', fi: 'fin',
  no: 'nor', ro: 'ron', hu: 'hun', th: 'tha', vi: 'vie', uk: 'ukr', bg: 'bul',
};

// A Matroska title is a single UTF-8 string. Newlines and control characters have no
// business in one, and a runaway label would push the rest of the menu off screen.
function sanitizeTitle(label) {
  const s = String(label || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || 'Subtitle').slice(0, 120);
}

function runFfmpeg(ffmpegPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return resolve(false); }
    // ffmpeg is chatty on stderr and this is a sub-second job, but an undrained pipe is
    // how core/subtitle-tools.js once deadlocked alass. Same discipline, no exceptions.
    if (proc.stderr) proc.stderr.on('data', () => {});
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(false); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(to); resolve(code === 0); });
    proc.on('error', () => { clearTimeout(to); resolve(false); });
  });
}

/*
 * Wrap `subPath` in a titled one-track .mks and return its path. Returns `subPath`
 * unchanged whenever wrapping is impossible or pointless — no ffmpeg, not an .srt, the
 * mux failed. The caller must not care which it got back; both are things VLC can play.
 *
 * Only .srt is wrapped. That is not laziness: -c:s srt would flatten an .ass to plain
 * text, and every external subtitle Uplayer produces (downloaded, then alass-corrected)
 * is already .srt. Anything else passes through untouched rather than being silently
 * downgraded for the sake of a nicer menu entry.
 */
async function labelSubtitleForVlc({ ffmpegPath, subPath, label, language, outDir, timeoutMs = 15000 } = {}) {
  if (!ffmpegPath || !subPath) return subPath || null;
  if (path.extname(subPath).toLowerCase() !== '.srt') return subPath;
  if (!fs.existsSync(subPath)) return subPath;

  const dir = outDir || path.dirname(subPath);
  const title = sanitizeTitle(label);
  // The title is part of the output identity: a re-sync reuses neither the cues nor the
  // name of the previous pass, and a stale "Original timing" caption on the corrected
  // track would be worse than no caption at all.
  const stamp = Buffer.from(title).toString('hex').slice(0, 16);
  const out = path.join(dir, path.basename(subPath, '.srt') + '.' + stamp + '.mks');

  try {
    // Reuse only if it is genuinely newer than the cues it wraps. alass writes the
    // corrected file in place under some paths, so an mtime check is the difference
    // between showing the fix and showing a cached copy of what it replaced.
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(subPath).mtimeMs) return out;
  } catch (e) { /* fall through and re-mux */ }

  const args = ['-y', '-sub_charenc', 'UTF-8', '-i', subPath, '-c:s', 'srt',
    '-metadata:s:s:0', 'title=' + title];
  const iso = ISO_639_2[String(language || '').toLowerCase()];
  if (iso) args.push('-metadata:s:s:0', 'language=' + iso);
  args.push('-f', 'matroska', out);

  const ok = await runFfmpeg(ffmpegPath, args, timeoutMs);
  return ok && fs.existsSync(out) ? out : subPath;
}

module.exports = { labelSubtitleForVlc, ISO_639_2 };
// exposed for unit tests
module.exports._internals = { sanitizeTitle };
