'use strict';

// VLC's subtitle menu called every external track "Track 1"/"Track 2", so after an
// auto-sync the viewer had two identically-useless entries and no way to tell which one
// carried the corrected timing. VLC ignores the filename entirely (measured on 3.0.23 —
// "Auto-synced timing 175….srt" still displayed as "Track 1"); the one thing it reads is
// a Matroska track name. Hence the wrap.
//
// What must stay true:
//   - the cues survive byte for byte, Arabic and inline markup included
//   - the .srt remains the canonical file — the web player and cast burn-in read it
//   - every failure returns the ORIGINAL path, because a nameless subtitle beats none
//
// Needs a real ffmpeg to prove the mux; the parts that do not are asserted regardless, so
// this file is still worth running on a machine without one.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { labelSubtitleForVlc, ISO_639_2, _internals } = require('../core/vlc-subtitle-label');

const ARABIC_SRT = [
  '1', '00:00:02,000 --> 00:00:20,000', 'مرحبا بك في هذا الفيلم', '',
  '2', '00:00:22,000 --> 00:00:40,000', 'سطر ثانٍ مع تنسيق <i>مائل</i>', '',
].join('\n');

function ffmpeg() {
  for (const bin of ['ffmpeg', 'ffmpeg.exe']) {
    const r = spawnSync(bin, ['-version'], { windowsHide: true });
    if (r.status === 0) return bin;
  }
  return null;
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-vlclabel-'));
  return { dir, write: (n, b) => { const p = path.join(dir, n); fs.writeFileSync(p, b, 'utf8'); return p; } };
}

// The two pure inputs to the menu entry: the title, and the language tag beside it.
function testTitleAndLanguageMapping() {
  const { sanitizeTitle } = _internals;
  assert.strictEqual(sanitizeTitle('two\nlines\there'), 'two lines here', 'a Matroska title is one line');
  assert.strictEqual(sanitizeTitle('   '), 'Subtitle', 'never an empty menu entry');
  assert.strictEqual(sanitizeTitle('x'.repeat(400)).length, 120, 'a runaway label must not eat the menu');
  assert.strictEqual(ISO_639_2.arabic, 'ara', 'the keyless scrapers label rows "Arabic", not "ar"');
  assert.strictEqual(ISO_639_2.qq, undefined, 'an unknown code omits the tag rather than writing a wrong one');
}

// Every one of these leaves the caller holding a subtitle VLC can play.
async function testFailuresReturnTheOriginalPath() {
  const t = tmp();
  const srt = t.write('a.srt', ARABIC_SRT);

  assert.strictEqual(await labelSubtitleForVlc({ subPath: srt }), srt, 'no ffmpeg -> unchanged');
  assert.strictEqual(await labelSubtitleForVlc({}), null, 'nothing in, nothing out');
  assert.strictEqual(
    await labelSubtitleForVlc({ ffmpegPath: 'definitely-not-a-real-binary', subPath: srt, label: 'x' }),
    srt, 'a spawn that fails must not lose the subtitle');

  const ass = t.write('a.ass', '[Script Info]\nTitle: x\n');
  assert.strictEqual(await labelSubtitleForVlc({ ffmpegPath: 'ffmpeg', subPath: ass, label: 'x' }), ass,
    'only .srt is wrapped — flattening an .ass to plain text for a nicer menu entry is a bad trade');

  const gone = path.join(t.dir, 'nope.srt');
  assert.strictEqual(await labelSubtitleForVlc({ ffmpegPath: 'ffmpeg', subPath: gone, label: 'x' }), gone);
}

async function testWrapsAndKeepsTheCuesIntact(bin) {
  const t = tmp();
  const srt = t.write('downloaded.srt', ARABIC_SRT);

  const out = await labelSubtitleForVlc({
    ffmpegPath: bin, subPath: srt, label: 'Arabic (auto-synced −7.0s)', language: 'ar',
  });
  assert.notStrictEqual(out, srt, 'a wrap actually happened');
  assert.strictEqual(path.extname(out), '.mks');
  assert.ok(fs.existsSync(out));
  assert.ok(fs.existsSync(srt), 'the .srt is still there — the web player and cast burn-in read it');

  // The title is what VLC will show, so it has to be IN the container.
  const probe = spawnSync(bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'),
    ['-v', 'quiet', '-show_entries', 'stream_tags=title,language', '-of', 'default=nw=1', out],
    { encoding: 'utf8', windowsHide: true });
  if (probe.status === 0) {
    assert.ok(/title=Arabic \(auto-synced −7\.0s\)/.test(probe.stdout), 'the label is the Matroska track name');
    assert.ok(/language=ara/.test(probe.stdout), 'ISO 639-1 in, ISO 639-2 out');
  }

  // Lossless: pull the cues back out and compare the text.
  const back = path.join(t.dir, 'roundtrip.srt');
  const r = spawnSync(bin, ['-y', '-i', out, '-c:s', 'srt', back], { windowsHide: true });
  assert.strictEqual(r.status, 0, 'the container is readable');
  const textOf = (p) => fs.readFileSync(p, 'utf8').split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l) && !/-->/.test(l)).join('\n');
  assert.strictEqual(textOf(back), textOf(srt), 'Arabic and inline <i> markup survive byte for byte');
}

// A re-sync must not be served a cached wrap of the cues it replaced — that would show
// the OLD timing under the NEW name, which is the one outcome worse than "Track 1".
async function testStaleWrapIsRebuilt(bin) {
  const t = tmp();
  const srt = t.write('sub.srt', ARABIC_SRT);
  const first = await labelSubtitleForVlc({ ffmpegPath: bin, subPath: srt, label: 'Original timing' });

  // Same label, newer cues.
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(srt, ARABIC_SRT.replace('00:00:02,000', '00:00:09,000'), 'utf8');
  const second = await labelSubtitleForVlc({ ffmpegPath: bin, subPath: srt, label: 'Original timing' });
  assert.strictEqual(second, first, 'same label -> same path');

  const back = path.join(t.dir, 'rt.srt');
  spawnSync(bin, ['-y', '-i', second, '-c:s', 'srt', back], { windowsHide: true });
  assert.ok(/00:00:09,000/.test(fs.readFileSync(back, 'utf8')), 'the wrap was rebuilt from the NEW cues');

  // A different label is a different track, so it gets its own file.
  const renamed = await labelSubtitleForVlc({ ffmpegPath: bin, subPath: srt, label: 'Auto-synced timing' });
  assert.notStrictEqual(renamed, first, 'a relabel cannot reuse the old title');
}

async function main() {
  testTitleAndLanguageMapping();
  await testFailuresReturnTheOriginalPath();

  const bin = ffmpeg();
  if (!bin) {
    console.log('vlc-subtitle-label.test.js passed (mux tests skipped — no ffmpeg on PATH)');
    return;
  }
  await testWrapsAndKeepsTheCuesIntact(bin);
  await testStaleWrapIsRebuilt(bin);
  console.log('vlc-subtitle-label.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
