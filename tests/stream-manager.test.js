'use strict';

// destroy() must abort a stream setup that is still in flight, and must do it safely.
//
// StreamManager.stream() returns a promise that only settles once TorrServer has started, the
// torrent has been added, and the file list has resolved. Any of those can hang — a dead swarm,
// a TorrServer that never comes up. If the user stops the stream while it hangs, destroy() has
// to reject that promise rather than leave it pending forever. The hook is
// `_cancelPendingStream` (uplayer.js:2297), cleared through `finish()` so it can't fire twice.
//
// HISTORY: this file was orphaned — it was never added to package.json's hand-maintained test
// chain, so it had never run once. When tests/run-all.js started globbing the directory it
// surfaced immediately, failing: the assertions were written against the old WebTorrent client
// (`manager.client.add()`, a connection setTimeout, a progress setInterval), none of which
// survived the migration to TorrServer. The MOCK was obsolete; the BEHAVIOUR under test is
// still live, so the test was rewritten around the real one rather than deleted.
//
// No IO: the injected tsClient never resolves, which is exactly the hang being tested.

const assert = require('assert');
const { EventEmitter } = require('events');
const { StreamManager } = require('../uplayer.js');

// A StreamManager with its collaborators replaced — built without calling the real constructor,
// which would spawn a sandbox and reach for the shared TorrServer client.
function createFakeManager({ tsClient }) {
  const manager = new EventEmitter();
  Object.setPrototypeOf(manager, StreamManager.prototype);

  manager.tsClient = tsClient;
  manager.memoryTracker = null;
  manager.lowMemoryMode = false;
  manager.activeStreams = new Set();
  manager.cleanupInterval = null;
  manager.server = null;
  manager.currentHash = null;
  manager._hubStreamId = null;
  manager._transcodeProc = null;
  manager.sandbox = { cleanup() {} };
  manager.subtitlePath = null;
  manager.subtitlePaths = [];
  manager._cancelPendingStream = null;

  // Presence of a 'line' listener is what puts stream() in server mode (uplayer.js:2275).
  manager.on('line', () => {});
  return manager;
}

// A TorrServer client whose start() never settles — the hang destroy() has to break out of.
function hangingTsClient() {
  return {
    started: false,
    start() { this.started = true; return new Promise(() => {}); },
    add() { throw new Error('add() must not be reached — start() never resolved'); },
    remove() { return Promise.resolve(); },
    list() { return Promise.resolve([]); },
  };
}

async function testDestroyCancelsPendingConnectSafely() {
  const tsClient = hangingTsClient();
  const manager = createFakeManager({ tsClient });

  const streamPromise = manager.stream('magnet:?xt=urn:btih:test', { openPlayer: false });
  const rejection = assert.rejects(streamPromise, /Stream manager destroyed/);

  // Set synchronously, before the first await — otherwise a destroy() racing an early hang
  // would find nothing to cancel.
  assert.strictEqual(typeof manager._cancelPendingStream, 'function',
    'stream() should install the abort hook synchronously');
  assert.strictEqual(tsClient.started, true, 'stream() should have reached tsClient.start()');

  await manager.destroy();
  await rejection;

  assert.strictEqual(manager._cancelPendingStream, null,
    'destroy() should clear the abort hook');
  assert.strictEqual(manager.currentHash, null, 'destroy() should clear the torrent hash');
}

// destroy() is called from session teardown AND from the CLI's exit path, so it can land twice.
// The second call must not throw on an already-cancelled setup.
async function testDestroyIsIdempotent() {
  const manager = createFakeManager({ tsClient: hangingTsClient() });
  const rejection = assert.rejects(manager.stream('magnet:?xt=urn:btih:test', { openPlayer: false }),
    /Stream manager destroyed/);

  await manager.destroy();
  await rejection;
  await manager.destroy(); // must not throw
}

// finish() guards on `settled`, so a cancel arriving after the promise already resolved or
// rejected must be a no-op rather than a second reject on a settled promise.
async function testCancelAfterSettleIsNoop() {
  const manager = createFakeManager({ tsClient: hangingTsClient() });
  const rejection = assert.rejects(manager.stream('magnet:?xt=urn:btih:test', { openPlayer: false }),
    /Stream manager destroyed/);

  const cancel = manager._cancelPendingStream;
  await manager.destroy();
  await rejection;

  assert.doesNotThrow(() => cancel('late cancel'), 'a late cancel should not throw');
}

async function main() {
  await testDestroyCancelsPendingConnectSafely();
  await testDestroyIsIdempotent();
  await testCancelAfterSettleIsNoop();
  console.log('stream-manager.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
