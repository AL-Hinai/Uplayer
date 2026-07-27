'use strict';

// What the viewer is told about the timing fix, beside "Subtitle loaded".
//
// The fix is automatic and runs in the background for minutes. Without a status line all
// three of these look exactly the same from the outside: still working, already done, and
// never started. That ambiguity is what made people reach for a manual button — the fix
// was doing its job and saying nothing about it.
//
// So the line answers three questions: did it fix the timing, by how much, and how long
// did it take. The data comes from the `job` the subtitle manifest already publishes;
// StreamManager fills in durationMs and shiftMs when the job settles.
//
// Pure: runs the real describeSubtitleFix in a vm. No DOM, no network, no stream.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = src.indexOf('function formatFixDuration');
  const end = src.indexOf('function renderSubtitleFixStatus');
  assert.notStrictEqual(start, -1, 'formatFixDuration not found in app.js');
  assert.notStrictEqual(end, -1, 'describeSubtitleFix block not found in app.js');
  const ctx = { console, Date };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end), ctx);
  return ctx;
}

const H = loadHelpers();

function testTheThreeThingsItMustReport() {
  // 1. That it fixed the timing, 2. by how much, 3. how long it took.
  const fixed = H.describeSubtitleFix({ kind: 'sync', running: false, error: null, durationMs: 134000, shiftMs: -7000 });
  assert.ok(/timing fixed/.test(fixed.text), 'says it fixed the timing');
  assert.ok(/7\.0s/.test(fixed.text), 'says by how much');
  assert.ok(/2m 14s/.test(fixed.text), 'says how long it took');
  assert.strictEqual(fixed.color, 'var(--green)', 'a real fix reads as a success');
}

// Sign is not cosmetic: "−" means the subtitle was running late and has been pulled
// earlier. A viewer comparing it against what they saw needs the direction.
function testDirectionOfTheCorrection() {
  assert.ok(/−7\.0s/.test(H.describeSubtitleFix({ kind: 'sync', running: false, durationMs: 1000, shiftMs: -7000 }).text),
    'late subtitle pulled earlier shows a minus');
  assert.ok(/\+1\.5s/.test(H.describeSubtitleFix({ kind: 'sync', running: false, durationMs: 1000, shiftMs: 1500 }).text),
    'early subtitle pushed later shows a plus');
}

// While it runs, the elapsed time is the whole point — this job can take minutes, and a
// bare "checking…" gives no sense of whether it is progressing or wedged.
function testRunningShowsElapsed() {
  const r = H.describeSubtitleFix({ kind: 'sync', running: true, startedAt: Date.now() - 200000 });
  assert.ok(/checking timing/.test(r.text));
  assert.ok(/3m 20s/.test(r.text), 'elapsed time while working');
  assert.notStrictEqual(r.color, 'var(--green)', 'not finished, so not styled as done');
}

// "Already correct" is a real, common outcome and must not read as a failure or as a
// change. A well-matched release needs no correction at all.
function testAlreadyCorrectIsItsOwnAnswer() {
  const r = H.describeSubtitleFix({ kind: 'sync', running: false, error: null, unchanged: true, durationMs: 95000, shiftMs: 0 });
  assert.ok(/already correct/.test(r.text));
  assert.ok(!/fixed/.test(r.text), 'nothing was changed, so do not claim a fix');
  assert.ok(/1m 35s/.test(r.text), 'it still took time and that is worth showing');
}

// A correction alass could not express as one offset still happened — report it, just
// without a number that would be a lie.
function testNonUniformFixReportsNoNumber() {
  const r = H.describeSubtitleFix({ kind: 'sync', running: false, error: null, durationMs: 140000, shiftMs: null });
  assert.ok(/timing fixed/.test(r.text));
  assert.ok(!/s in|[0-9]\.[0-9]s/.test(r.text.replace(/in 2m 20s/, '')), 'no invented shift figure');
  assert.ok(/2m 20s/.test(r.text));
}

function testFailureSaysWhatHappened() {
  const r = H.describeSubtitleFix({ kind: 'sync', running: false, error: 'alass not installed', durationMs: 900 });
  assert.ok(/unchanged/.test(r.text), 'the subtitle is still the one they downloaded');
  assert.ok(/alass not installed/.test(r.text), 'and the reason is not hidden');
  assert.notStrictEqual(r.color, 'var(--green)');
}

// Only the timing job belongs here. A whisper GENERATE job shares the job slot but has
// nothing to do with "Subtitle loaded", and claiming otherwise would be wrong.
function testUnrelatedJobsAreSilent() {
  assert.strictEqual(H.describeSubtitleFix({ kind: 'generate', running: true, startedAt: Date.now() }).text, '');
  assert.strictEqual(H.describeSubtitleFix(null).text, '');
  assert.strictEqual(H.describeSubtitleFix(undefined).text, '');
}

function testDurationFormatting() {
  assert.strictEqual(H.formatFixDuration(0), '0s');
  assert.strictEqual(H.formatFixDuration(45000), '45s');
  assert.strictEqual(H.formatFixDuration(60000), '1m');
  assert.strictEqual(H.formatFixDuration(134000), '2m 14s');
  assert.strictEqual(H.formatFixDuration(-5), '0s', 'clock skew must not print a negative age');
}

// The manifest has to actually carry these fields, or the line above can never fill in.
function testStreamManagerPublishesTheFields() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'uplayer.js'), 'utf8');
  assert.ok(/durationMs: Date\.now\(\) - this\._subtitleJob\.startedAt/.test(src),
    'the job must record how long the fix took');
  assert.ok(/shiftMs,?\s*\n\s*\};/.test(src) || /shiftMs: 0,/.test(src),
    'the job must record how far it moved the subtitle');
  assert.ok(/job: this\._subtitleJob \|\| null/.test(src),
    '/api/subtitles must publish the job for the UI to read');
}

function main() {
  testTheThreeThingsItMustReport();
  testDirectionOfTheCorrection();
  testRunningShowsElapsed();
  testAlreadyCorrectIsItsOwnAnswer();
  testNonUniformFixReportsNoNumber();
  testFailureSaysWhatHappened();
  testUnrelatedJobsAreSilent();
  testDurationFormatting();
  testStreamManagerPublishesTheFields();
  console.log('subtitle-fix-status.test.js passed');
}

main();
