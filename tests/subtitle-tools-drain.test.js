'use strict';

// The pipe deadlock behind every "timeout" subtitle sync. runProcess drained only
// stderr; alass prints a per-cue progress bar to STDOUT (1600+ lines on a real
// movie subtitle), so the unread pipe filled its 64KB buffer, the child blocked
// mid-write, and the timeout reaped a process that finishes in seconds when its
// output is consumed. Trailer-sized files stayed under the buffer, which made the
// bug look like "sync works sometimes". Verified against the real binary: alass
// completed the same movie subtitle in 4.6s once stdout was drained.

const assert = require('assert');
const { runProcess } = require('../core/subtitle-tools')._internals;

async function testStdoutFloodDoesNotDeadlock() {
  // 1MB to stdout = 16x the pipe buffer. Pre-fix this hung until the timeout.
  const started = Date.now();
  const r = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024*1024))'], { timeoutMs: 15000 });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.code, 0, 'flooding child must exit cleanly: ' + JSON.stringify(r));
  assert.ok(elapsed < 10000, `finished in ${elapsed}ms — a deadlock would have eaten the full timeout`);
}

async function testStderrIsStillCaptured() {
  const r = await runProcess(process.execPath, ['-e', 'process.stderr.write("boom-detail"); process.exit(3)'], { timeoutMs: 15000 });
  assert.strictEqual(r.code, 3);
  assert.ok(r.stderr.includes('boom-detail'), 'diagnostic tail still reaches the caller');
}

async function main() {
  await testStdoutFloodDoesNotDeadlock();
  await testStderrIsStillCaptured();
  console.log('subtitle-tools-drain.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
