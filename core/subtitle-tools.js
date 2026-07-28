'use strict';

/*
 * Subtitle tooling that wraps external binaries, provisioned like ffmpeg:
 *   - alass        : automatic subtitle synchronization (reference can be a
 *                    subtitle OR a video/audio file).
 *   - whisper.cpp  : speech-to-text subtitle generation from audio.
 *
 * Binaries are resolved from (in order): an explicit env override, the bundled
 * vendor/ dir (desktop, provisioned by scripts/setup-subtitle-tools.js), or the
 * Android nativeLibDir (set by android-app main.js, same as ffmpeg). Every entry
 * point degrades gracefully — if the binary isn't present the feature is skipped,
 * exactly like the existing ffmpeg-not-found handling.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', 'vendor');

function firstExisting(paths) {
  for (const p of paths) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}

function resolveAlass() {
  const env = process.env.UPLAYER_ALASS_PATH;
  if (env && fs.existsSync(env)) return env;
  if (process.platform === 'win32') {
    return firstExisting([
      path.join(VENDOR, 'alass', 'alass-windows64', 'bin', 'alass-cli.exe'),
      path.join(VENDOR, 'alass', 'alass-cli.exe'),
    ]);
  }
  return firstExisting([
    path.join(VENDOR, 'alass', 'alass-linux64'),
    path.join(VENDOR, 'alass', 'alass-cli'),
    '/usr/bin/alass-cli', '/usr/local/bin/alass-cli',
  ]);
}

function resolveWhisper() {
  const env = process.env.UPLAYER_WHISPER_PATH;
  if (env && fs.existsSync(env)) return env;
  if (process.platform === 'win32') {
    return firstExisting([
      path.join(VENDOR, 'whisper', 'whisper-cli.exe'),
      path.join(VENDOR, 'whisper', 'main.exe'),
    ]);
  }
  return firstExisting([
    path.join(VENDOR, 'whisper', 'whisper-cli'),
    path.join(VENDOR, 'whisper', 'main'),
    '/usr/local/bin/whisper-cli',
  ]);
}

function resolveWhisperModel() {
  const env = process.env.UPLAYER_WHISPER_MODEL;
  if (env && fs.existsSync(env)) return env;
  return firstExisting([
    path.join(VENDOR, 'whisper', 'ggml-base.en.bin'),
    path.join(VENDOR, 'whisper', 'ggml-tiny.en.bin'),
    path.join(VENDOR, 'whisper', 'ggml-tiny.bin'),
  ]);
}

const isAlassAvailable = () => !!resolveAlass();
const isWhisperAvailable = () => !!(resolveWhisper() && resolveWhisperModel());

function runProcess(bin, args, { timeoutMs = 600000, cwd } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, cwd });
    } catch (e) {
      return resolve({ code: -1, error: e.message, stderr: '' });
    }
    // BOTH pipes must be drained. alass writes a per-cue progress bar to STDOUT
    // (1600+ lines on a movie-length subtitle); leaving that pipe unread fills
    // its 64KB buffer, the child blocks mid-write, and the timeout reaps a
    // process that finishes in seconds when its output is consumed. Small
    // (trailer-sized) files stayed under the buffer — which is why this
    // deadlock masqueraded as "works sometimes".
    if (proc.stdout) proc.stdout.on('data', () => {});
    if (proc.stderr) proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ code: -1, error: 'timeout', stderr }); }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(to); resolve({ code, stderr }); });
    proc.on('error', (e) => { clearTimeout(to); resolve({ code: -1, error: e.message, stderr }); });
  });
}

// Sync `incorrectSubPath` to `referencePath` (a subtitle or a video/audio file),
// writing `outputPath`. Returns { ok, output?, reason? }.
//
// `opts.noSplit` passes alass's --no-split: the whole track may only be SHIFTED, never
// cut into segments that each move by a different amount. That is not a tuning
// preference — split mode needs reference material under every segment, so it is only
// honest when the reference covers the whole subtitle. The caller owns that judgement;
// see uplayer.js syncSubtitle for why it is usually false here.
async function syncSubtitle(referencePath, incorrectSubPath, outputPath, opts = {}) {
  const bin = resolveAlass();
  if (!bin) return { ok: false, reason: 'alass not installed' };
  if (!fs.existsSync(referencePath) || !fs.existsSync(incorrectSubPath)) return { ok: false, reason: 'input file missing' };
  const args = [];
  if (opts.noSplit) args.push('--no-split');
  args.push(referencePath, incorrectSubPath, outputPath);
  const r = await runProcess(bin, args, { timeoutMs: opts.timeoutMs || 180000 });
  if (r.code === 0 && fs.existsSync(outputPath)) return { ok: true, output: outputPath };
  return { ok: false, reason: r.error || ('alass exit ' + r.code), stderr: (r.stderr || '').slice(-300) };
}

// Generate subtitles from an audio file (wav 16k mono preferred) via whisper.cpp.
// `audioPath` should already be extracted with ffmpeg. Writes `<outBase>.srt`.
async function generateSubtitle(audioPath, outBase, opts = {}) {
  const bin = resolveWhisper();
  const model = resolveWhisperModel();
  if (!bin || !model) return { ok: false, reason: 'whisper not installed (binary or model missing)' };
  if (!fs.existsSync(audioPath)) return { ok: false, reason: 'audio file missing' };
  const args = ['-m', model, '-f', audioPath, '-osrt', '-of', outBase];
  if (opts.language) args.push('-l', opts.language);
  const r = await runProcess(bin, args, { timeoutMs: opts.timeoutMs || 1800000 });
  const out = outBase + '.srt';
  if (r.code === 0 && fs.existsSync(out)) return { ok: true, output: out };
  return { ok: false, reason: r.error || ('whisper exit ' + r.code), stderr: (r.stderr || '').slice(-300) };
}

module.exports = {
  resolveAlass, resolveWhisper, resolveWhisperModel,
  isAlassAvailable, isWhisperAvailable,
  syncSubtitle, generateSubtitle,
};
// exposed for unit tests
module.exports._internals = { runProcess };
