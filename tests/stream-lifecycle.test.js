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

function testStructuredPlayerReadyPayload() {
  const events = [];
  const lifecycle = new StreamLifecycleState((event, data) => {
    events.push({ event, data });
  });
  const payload = {
    url: 'http://192.168.1.50:8000',
    playerUrl: 'http://192.168.1.50:8000',
    vlcUrl: 'http://localhost:8000/video.mkv',
    castUrl: 'http://192.168.1.50:8000/video.mp4?compat=1',
    subtitleManifestUrl: 'http://192.168.1.50:8000/api/subtitles',
  };

  assert.strictEqual(lifecycle.playerReady(payload), true);
  assert.deepStrictEqual(lifecycle.status(), {
    playerUrl: payload.url,
    playerReadyData: payload,
    exited: false,
  });
  assert.deepStrictEqual(events, [
    { event: 'player_ready', data: payload },
  ]);
}

function main() {
  testOrderingAndIdempotency();
  testExitBeforeReady();
  testStructuredPlayerReadyPayload();
  console.log('stream-lifecycle.test.js passed');
}

main();
