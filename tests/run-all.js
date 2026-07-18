'use strict';

// Runs every tests/*.test.js. Replaces the hand-maintained `&&` chain that used to live in
// package.json's "test" script.
//
// The chain wasn't just tedious — it silently lost a test. tests/stream-manager.test.js was
// never added to it, so it had never run. A list you have to remember to update is a list that
// drifts, and the drift is invisible: a forgotten test looks exactly like a passing one.
// Globbing the directory means a new tests/x.test.js runs the moment it exists.
//
// Each test is spawned as its OWN process, deliberately. These tests bind ports, spawn ffmpeg,
// and call process.exit() — running them in-process would let one test's lingering handles or
// exit call take down the run.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;

// Tests that are known-broken and deliberately skipped. Each entry MUST carry a reason — an
// unexplained skip is how a test rots. Empty is the goal.
const QUARANTINE = {};

function discover() {
  return fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
}

function main() {
  const only = process.argv[2]; // node tests/run-all.js <substring> runs a subset
  const all = discover();
  const files = only ? all.filter((f) => f.includes(only)) : all;

  if (!files.length) {
    console.error(only ? `No test matches "${only}"` : 'No tests found');
    process.exit(1);
  }

  const failed = [];
  const skipped = [];
  const started = Date.now();

  for (const file of files) {
    if (QUARANTINE[file]) {
      skipped.push(file);
      console.log(`SKIP  ${file} — ${QUARANTINE[file]}`);
      continue;
    }
    const r = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], {
      stdio: 'inherit',
      cwd: path.join(TESTS_DIR, '..'),
    });
    if (r.status !== 0) failed.push(file);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log(`${files.length - failed.length - skipped.length}/${files.length - skipped.length} passed in ${secs}s`
    + (skipped.length ? ` (${skipped.length} quarantined)` : ''));

  if (failed.length) {
    console.error(`\nFAILED:\n${failed.map((f) => `  - ${f}`).join('\n')}`);
    process.exit(1);
  }
}

main();
