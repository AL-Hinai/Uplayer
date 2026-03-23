'use strict';

const assert = require('assert');
const { StreamLifecycleState } = require('../core/stream-lifecycle');

function testOrderingAndIdempotency() {
  const events = [];
  const lifecycle = new StreamLifecycleState((event, data) => {
    events.push({ event, data });
  });

  assert.strictEqual(lifecycle.playerReady('http://localhost:8000'), true);
  assert.strictEqual(lifecycle.playerReady('http://localhost:9000'), false, 'player_ready should emit once');
  assert.strictEqual(lifecycle.exit(0), true);
  assert.strictEqual(lifecycle.exit(1), false, 'exit should emit once');
  assert.strictEqual(lifecycle.progress({ percent: 50 }), false, 'progress must stop after exit');
  assert.strictEqual(lifecycle.line('hello'), false, 'line events must stop after exit');

  assert.deepStrictEqual(
    events.map((e) => e.event),
    ['player_ready', 'exit']
  );
  assert.strictEqual(events[0].data.url, 'http://localhost:8000');
  assert.strictEqual(events[1].data.code, 0);
}

function testExitBeforeReady() {
  const events = [];
  const lifecycle = new StreamLifecycleState((event, data) => {
    events.push({ event, data });
  });

  assert.strictEqual(lifecycle.exit(1), true);
  assert.strictEqual(lifecycle.playerReady('http://localhost:8000'), false);

  assert.deepStrictEqual(events.map((e) => e.event), ['exit']);
}

function main() {
  testOrderingAndIdempotency();
  testExitBeforeReady();
  console.log('stream-lifecycle.test.js passed');
}

main();
