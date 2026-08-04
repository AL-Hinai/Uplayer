'use strict';

// Syncing a subtitle against audio that only covers the FIRST 20 minutes of the film.
//
// The bug this pins, seen on a live stream of The Mandalorian and Grogu: the downloaded
// subtitle (916 cues, 2h05) was handed to alass with 20 minutes of reference audio, and
// alass shifted the whole track by -20:37 — sliding the cues that follow the window INTO
// the window, because that is where the overlap score is. 152 cues clamped to 00:00:00.
// The subtitle had been correct to within 10ms. `--no-split` did not prevent it; it only
// decided whether the damage arrived as one shift or as many.
//
// The fix, and what these tests hold in place: when the reference is partial, only the
// excerpt it covers is aligned, and alass's answer is carried to the rest of the track as
// the affine map it actually is (offset + framerate scale). The excerpt cannot be dragged
// backward because the cues that would replace it are not in the file.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const timing = require('../core/subtitle-timing');
const { StreamManager } = require('../uplayer.js');

const TOOLS = require.resolve('../core/subtitle-tools');

function stamp(msVal) {
  const t = Math.max(0, Math.round(msVal));
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / 3600000), 2)}:${pad(Math.floor(t / 60000) % 60, 2)}:${pad(Math.floor(t / 1000) % 60, 2)},${pad(t % 1000, 3)}`;
}

// A film-length subtitle: `count` cues over `spanMs`, starting at `startMs`.
//
// The gaps are irregular, and deliberately so. Perfectly periodic cues make a framerate
// scale AMBIGUOUS — a 4% squeeze of an evenly-spaced track lines up on its neighbour just
// as well as on itself — and the real binary then picks the wrong one. Dialogue is never
// periodic; a subtitle that is would be a metronome, not a film.
function buildSubtitle(count, startMs, spanMs) {
  const gaps = [];
  let total = 0;
  for (let i = 0; i < count - 1; i += 1) {
    const g = 1 + ((i * 7919) % 23) / 4; // deterministic 1.0-6.5x spread, no PRNG to seed
    gaps.push(g);
    total += g;
  }
  const unit = spanMs / total;
  const out = [];
  let t = startMs;
  for (let i = 0; i < count; i += 1) {
    out.push(`${i + 1}\n${stamp(t)} --> ${stamp(t + 1200)}\nline ${i + 1}`);
    t += (gaps[i] || 0) * unit;
  }
  return out.join('\n\n') + '\n';
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-window-sync-'));
}

// A manager with just enough on it for _syncAgainstPartialReference: it reads and writes
// files in tempDir and calls out to subtitle-tools, and touches nothing else.
function fakeManager(dir) {
  const m = Object.create(StreamManager.prototype);
  m.tempDir = dir;
  m._log = () => {};
  return m;
}

// Replace the alass wrapper for one call. The method re-requires the module every time,
// so patching the cached export is enough and needs no injection seam.
function withFakeAlass(impl, fn) {
  const mod = require(TOOLS);
  const real = mod.syncSubtitle;
  mod.syncSubtitle = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { mod.syncSubtitle = real; });
}

function testTrimToWindowCutsAtTheReferenceEdge() {
  const sub = buildSubtitle(100, 30000, 7200000); // 100 cues over two hours
  const { text, count } = timing.trimToWindow(sub, 1200000);
  const starts = timing.cueStartsMs(text);
  assert.strictEqual(count, starts.length, 'reported count matches what came out');
  assert.ok(starts.length > 0 && starts.length < 100, 'a window is a proper subset');
  assert.ok(starts[starts.length - 1] < 1200000, 'nothing past the end of the reference');
  assert.strictEqual(starts[0], timing.cueStartsMs(sub)[0], 'and the window starts where the film does');
  assert.ok(/^1\n/.test(text), 'renumbered from 1 — alass rejects a file whose numbering has holes');
}

function testApplyLinearRetimesCuesAndNothingElse() {
  const sub = '1\n00:00:10,000 --> 00:00:12,000\nAt 00:59:59,999 he left\n';
  const out = timing.applyLinear(sub, { scale: 1, offsetMs: 5000 });
  assert.ok(out.includes('00:00:15,000 --> 00:00:17,000'), 'the cue line moved');
  assert.ok(out.includes('At 00:59:59,999 he left'), 'a clock quoted in the dialogue is not a timestamp');

  // Negative results clamp to zero exactly as alass does, which is what leaves
  // _implausibleSync able to count the damage.
  const back = timing.applyLinear(sub, { offsetMs: -30000 });
  assert.ok(back.includes('00:00:00,000 --> 00:00:00,000'), 'negative timings clamp, they do not wrap');

  const vtt = timing.applyLinear('00:00:10.000 --> 00:00:12.000 line:90%', { offsetMs: 1000 });
  assert.strictEqual(vtt, '00:00:11.000 --> 00:00:13.000 line:90%', 'WebVTT separator and cue settings survive');
}

function testFitLinearRecoversOffsetAndScale() {
  const from = [1000, 60000, 600000, 1190000];
  const shifted = from.map((t) => t + 7000);
  const f1 = timing.fitLinear(from, shifted);
  assert.ok(Math.abs(f1.scale - 1) < 1e-9 && Math.abs(f1.offsetMs - 7000) < 1e-6, 'pure offset');
  assert.ok(f1.maxResidualMs < 1, 'and it sits on the line');

  const scale = 25 / 23.976;
  const warped = from.map((t) => t * scale + 4000);
  const f2 = timing.fitLinear(from, warped);
  assert.ok(Math.abs(f2.scale - scale) < 1e-9, 'framerate correction recovered as a scale');
  assert.ok(f2.maxResidualMs < 1);

  // Per-scene retiming: real, but not a straight line — the residual is what says so.
  const perScene = from.map((t, i) => t + (i < 2 ? 1000 : 9000));
  assert.ok(timing.fitLinear(from, perScene).maxResidualMs > 250, 'non-affine corrections are visible in the residual');

  assert.strictEqual(timing.fitLinear([5], [5]), null, 'one point fits nothing');
  assert.strictEqual(timing.fitLinear([5, 5, 5], [1, 2, 3]), null, 'no spread, no slope');
}

// The regression itself. alass is asked about the excerpt ONLY, and whatever it answers
// is applied to the whole film — including the cues an hour past the reference, which is
// the part the old code let alass invent.
async function testOnlyTheWindowIsAlignedAndTheAnswerCarries() {
  const dir = tmpdir();
  try {
    const sub = path.join(dir, 'downloaded.srt');
    fs.writeFileSync(sub, buildSubtitle(400, 30000, 7200000), 'utf8');
    const seen = [];

    await withFakeAlass(async (ref, incorrect, outFile) => {
      const text = fs.readFileSync(incorrect, 'utf8');
      seen.push({ cues: timing.cueStartsMs(text).length, last: timing.cueStartsMs(text).slice(-1)[0] });
      fs.writeFileSync(outFile, timing.applyLinear(text, { offsetMs: -7000 }), 'utf8');
      return { ok: true, output: outFile };
    }, async () => {
      const m = fakeManager(dir);
      const out = path.join(dir, 'fixed.srt');
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sub, out, 1200);

      assert.strictEqual(r.ok, true, r.reason);
      assert.strictEqual(seen.length, 1, 'one alass run');
      assert.ok(seen[0].last < 1200000, 'alass never saw a cue past the end of the reference audio');
      assert.ok(seen[0].cues < 400, 'i.e. it was the excerpt, not the film');

      const before = timing.cueStartsMs(fs.readFileSync(sub, 'utf8'));
      const after = timing.cueStartsMs(fs.readFileSync(r.output, 'utf8'));
      assert.strictEqual(after.length, before.length, 'the full track came back whole');
      for (let i = 0; i < before.length; i += 1) {
        assert.ok(Math.abs((before[i] - 7000) - after[i]) <= 1, `cue ${i} carries the correction`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The framerate case is why the excerpt's answer is fitted as an affine map instead of
// being read off as a median offset: carrying only the offset would be minutes wrong by
// the end of a film it never saw.
async function testFramerateCorrectionIsCarriedAsAScale() {
  const dir = tmpdir();
  try {
    const scale = 23.976 / 25;
    const sub = path.join(dir, 'downloaded.srt');
    fs.writeFileSync(sub, buildSubtitle(400, 30000, 7200000), 'utf8');

    await withFakeAlass(async (ref, incorrect, outFile) => {
      const text = fs.readFileSync(incorrect, 'utf8');
      fs.writeFileSync(outFile, timing.applyLinear(text, { scale, offsetMs: 2000 }), 'utf8');
      return { ok: true, output: outFile };
    }, async () => {
      const m = fakeManager(dir);
      const out = path.join(dir, 'fixed.srt');
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sub, out, 1200);
      assert.strictEqual(r.ok, true, r.reason);

      const before = timing.cueStartsMs(fs.readFileSync(sub, 'utf8'));
      const after = timing.cueStartsMs(fs.readFileSync(r.output, 'utf8'));
      const lastErr = Math.abs((before[before.length - 1] * scale + 2000) - after[after.length - 1]);
      assert.ok(lastErr <= 2, `the last cue of the film is right too (off by ${lastErr}ms)`);
      // The point: an offset-only extrapolation would be minutes out down there.
      const offsetOnly = Math.abs((before[before.length - 1] - after[after.length - 1]));
      assert.ok(offsetOnly > 60000, 'and it is a correction a constant offset could not have made');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testUnextrapolatableAndUnderevidencedResultsAreRefused() {
  const dir = tmpdir();
  try {
    const sub = path.join(dir, 'downloaded.srt');
    fs.writeFileSync(sub, buildSubtitle(400, 30000, 7200000), 'utf8');
    const m = fakeManager(dir);
    const out = path.join(dir, 'fixed.srt');

    // Per-scene retiming inside the window says nothing about the other 100 minutes.
    await withFakeAlass(async (ref, incorrect, outFile) => {
      const starts = timing.cueStartsMs(fs.readFileSync(incorrect, 'utf8'));
      const half = starts[Math.floor(starts.length / 2)];
      const text = fs.readFileSync(incorrect, 'utf8').split(/\r?\n\r?\n/)
        .map((b) => {
          const s = timing.cueStartsMs(b)[0];
          return s == null ? b : timing.applyLinear(b, { offsetMs: s < half ? 1000 : 20000 });
        }).join('\n\n');
      fs.writeFileSync(outFile, text, 'utf8');
      return { ok: true, output: outFile };
    }, async () => {
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sub, out, 1200);
      assert.strictEqual(r.ok, false);
      assert.ok(/not a single offset/.test(r.reason), r.reason);
      assert.ok(!fs.existsSync(out), 'and nothing was written for a player to pick up');
    });

    // A film with almost no dialogue in the cached window: too little to fit a line
    // through, and the extrapolation would multiply it by six.
    const sparse = path.join(dir, 'sparse.srt');
    fs.writeFileSync(sparse, buildSubtitle(60, 1500000, 5400000), 'utf8');
    await withFakeAlass(async () => { throw new Error('alass must not run'); }, async () => {
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sparse, out, 1200);
      assert.strictEqual(r.ok, false);
      assert.ok(/too little to align on/.test(r.reason), r.reason);
    });

    // alass returning a different cue list means the output is not an answer about the
    // file we asked about; pairing it by index would manufacture one.
    await withFakeAlass(async (ref, incorrect, outFile) => {
      const blocks = fs.readFileSync(incorrect, 'utf8').split(/\r?\n\r?\n/).slice(0, 5);
      fs.writeFileSync(outFile, blocks.join('\n\n'), 'utf8');
      return { ok: true, output: outFile };
    }, async () => {
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sub, out, 1200);
      assert.strictEqual(r.ok, false);
      assert.ok(/returned \d+ lines for \d+/.test(r.reason), r.reason);
    });

    // A failed alass run is passed through untouched, so the retry loop upstream can read
    // its reason (that is how "audio incomplete" keeps its meaning).
    await withFakeAlass(async () => ({ ok: false, reason: 'alass exit 1' }), async () => {
      const r = await m._syncAgainstPartialReference(path.join(dir, 'ref.wav'), sub, out, 1200);
      assert.deepStrictEqual(r, { ok: false, reason: 'alass exit 1' });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// End to end against the real binary, using a subtitle as the reference (alass accepts
// either) so the test needs no audio and no ffmpeg. This is the shape of the live failure:
// a 2-hour track, a reference that stops at minute 20. Skipped when alass is not vendored.
async function testRealAlassIsNotDraggedIntoTheWindow() {
  const tools = require('../core/subtitle-tools');
  if (!tools.isAlassAvailable()) {
    console.log('  (alass not installed — real-binary window test skipped)');
    return;
  }
  const dir = tmpdir();
  try {
    const truth = buildSubtitle(900, 35000, 7460000); // ~2h05, the live film's shape
    const reference = path.join(dir, 'reference.srt');
    fs.writeFileSync(reference, timing.trimToWindow(truth, 1200000).text, 'utf8');

    for (const [name, broken] of [
      ['already correct', truth],
      ['late by 7s', timing.applyLinear(truth, { offsetMs: 7000 })],
      ['25 -> 23.976fps', timing.applyLinear(truth, { scale: 23.976 / 25 })],
    ]) {
      const sub = path.join(dir, 'in.srt');
      const out = path.join(dir, 'out.srt');
      fs.writeFileSync(sub, broken, 'utf8');
      const m = fakeManager(dir);
      const r = await m._syncAgainstPartialReference(reference, sub, out, 1200);
      assert.strictEqual(r.ok, true, `${name}: ${r.reason}`);

      const got = timing.cueStartsMs(fs.readFileSync(r.output, 'utf8'));
      const want = timing.cueStartsMs(truth);
      assert.strictEqual(got.length, want.length, `${name}: whole track returned`);
      let worst = 0;
      for (let i = 0; i < want.length; i += 1) worst = Math.max(worst, Math.abs(got[i] - want[i]));
      assert.ok(worst < 1000, `${name}: recovered the true timing across the whole film (worst ${worst}ms)`);
      assert.strictEqual(got.filter((t) => t === 0).length, 0, `${name}: nothing pushed off the front`);
      fs.unlinkSync(out);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testTrimToWindowCutsAtTheReferenceEdge();
  testApplyLinearRetimesCuesAndNothingElse();
  testFitLinearRecoversOffsetAndScale();
  await testOnlyTheWindowIsAlignedAndTheAnswerCarries();
  await testFramerateCorrectionIsCarriedAsAScale();
  await testUnextrapolatableAndUnderevidencedResultsAreRefused();
  await testRealAlassIsNotDraggedIntoTheWindow();
  console.log('subtitle-window-sync.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
