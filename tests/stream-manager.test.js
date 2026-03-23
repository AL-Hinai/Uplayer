'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { StreamManager } = require('../uplayer.js');

async function withMockTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  const timeouts = [];
  const intervals = [];

  global.setTimeout = (callback, delay, ...args) => {
    const handle = {
      callback: () => callback(...args),
      cleared: false,
      delay,
    };
    timeouts.push(handle);
    return handle;
  };

  global.clearTimeout = (handle) => {
    if (handle) handle.cleared = true;
  };

  global.setInterval = (callback, delay, ...args) => {
    const handle = {
      callback: () => callback(...args),
      cleared: false,
      delay,
    };
    intervals.push(handle);
    return handle;
  };

  global.clearInterval = (handle) => {
    if (handle) handle.cleared = true;
  };

  try {
    await run({ timeouts, intervals });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
}

function createFakeManager() {
  const manager = new EventEmitter();
  Object.setPrototypeOf(manager, StreamManager.prototype);

  manager.client = {
    once(event, handler) {
      this.lastOnce = { event, handler };
    },
    removeListener(event, handler) {
      this.lastRemoved = { event, handler };
    },
    add() {
      // Intentionally do nothing so the connection timeout remains pending.
    },
    destroy(callback) {
      this.destroyed = true;
      if (callback) callback();
    },
  };

  manager.memoryTracker = null;
  manager.lowMemoryMode = false;
  manager.activeStreams = new Set();
  manager.cleanupInterval = null;
  manager.server = null;
  manager.currentTorrent = null;
  manager.sandbox = { cleanup() {} };
  manager.subtitlePath = null;
  manager.subtitlePaths = [];
  manager._cancelPendingStream = null;

  manager.on('line', () => {});
  return manager;
}

async function testDestroyCancelsPendingConnectSafely() {
  await withMockTimers(async ({ timeouts, intervals }) => {
    const manager = createFakeManager();
    const streamPromise = manager.stream('magnet:?xt=urn:btih:test', { openPlayer: false });
    const rejection = assert.rejects(streamPromise, /Stream manager destroyed/);

    assert.strictEqual(timeouts.length, 1, 'stream setup should register a connection timeout');
    assert.strictEqual(intervals.length, 1, 'stream setup should register a progress interval');
    assert.strictEqual(typeof manager._cancelPendingStream, 'function', 'destroy should be able to abort pending setup');

    await manager.destroy();
    await rejection;

    assert.strictEqual(manager.client, null, 'destroy should tear down the client');
    assert.strictEqual(manager._cancelPendingStream, null, 'pending setup abort hook should be cleared');
    assert.strictEqual(timeouts[0].cleared, true, 'destroy should clear the connection timeout');
    assert.strictEqual(intervals[0].cleared, true, 'destroy should clear the progress interval');
    assert.doesNotThrow(() => timeouts[0].callback(), 'late timeout callback should not crash after destroy');
  });
}

async function main() {
  await testDestroyCancelsPendingConnectSafely();
  console.log('stream-manager.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
