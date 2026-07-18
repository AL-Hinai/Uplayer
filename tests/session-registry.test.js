'use strict';

// The registry centralizes "the current stream" and makes the single-stream invariant
// observable. These tests pin: the majority definition is unchanged, the { live: true } variant
// skips exited sessions, the Map identity is preserved (the _internals test hook depends on it),
// and onEvent fires exactly when more than one session is active.

const assert = require('assert');
const { SessionRegistry, createSessionRegistry } = require('../core/session-registry.js');

function sess(id, { streamManager = true, exited = false } = {}) {
  return { id, streamManager: streamManager ? {} : null, lifecycle: { status: () => ({ exited }) } };
}

function testInjectedMapIdentityPreserved() {
  const map = new Map();
  const reg = new SessionRegistry({ sessions: map });
  assert.strictEqual(reg.map, map, 'registry must expose the SAME Map it was given');
  reg.set('a', sess('a'));
  assert.strictEqual(map.get('a').id, 'a', 'writes through the registry land in the injected Map');
  map.set('b', sess('b'));
  assert.strictEqual(reg.get('b').id, 'b', 'writes to the Map are visible through the registry');
  reg.clear();
  assert.strictEqual(map.size, 0, 'clear() empties the same Map, not a copy');
}

function testCurrentStreamMajorityBehaviour() {
  const reg = createSessionRegistry({ sessions: new Map() });
  assert.strictEqual(reg.currentStreamSession(), null, 'no sessions → null');

  reg.set('idle', sess('idle', { streamManager: false }));
  assert.strictEqual(reg.currentStreamSession(), null, 'a session without a StreamManager is not current');

  reg.set('run', sess('run'));
  assert.strictEqual(reg.currentStreamSession().id, 'run', 'the session with a StreamManager is current');
}

function testLiveVariantSkipsExited() {
  const reg = createSessionRegistry({ sessions: new Map() });
  reg.set('dead', sess('dead', { exited: true }));

  // Default returns it (matches the historical majority sites); live skips it.
  assert.strictEqual(reg.currentStreamSession().id, 'dead', 'default returns first with a StreamManager, exited or not');
  assert.strictEqual(reg.currentStreamSession({ live: true }), null, 'live variant skips an exited session');

  reg.set('alive', sess('alive'));
  assert.strictEqual(reg.currentStreamSession({ live: true }).id, 'alive', 'live variant finds the non-exited one');
}

function testMultipleActiveEmitsButDoesNotChangeResult() {
  const events = [];
  const reg = new SessionRegistry({ sessions: new Map(), onEvent: (e, p) => events.push({ e, p }) });
  reg.set('one', sess('one'));
  reg.currentStreamSession();
  assert.strictEqual(events.length, 0, 'one active session is not a warning');

  reg.set('two', sess('two'));
  const chosen = reg.currentStreamSession();
  assert.strictEqual(chosen.id, 'one', 'still returns the first — the warning does not change the choice');
  assert.strictEqual(events.length, 1, 'two active sessions emits exactly once');
  assert.strictEqual(events[0].e, 'multiple-active-sessions');
  assert.strictEqual(events[0].p.count, 2);
  assert.deepStrictEqual(events[0].p.ids.sort(), ['one', 'two']);
}

function testActiveStreamSessionsPlural() {
  const reg = createSessionRegistry({ sessions: new Map() });
  reg.set('a', sess('a'));
  reg.set('b', sess('b', { streamManager: false }));
  reg.set('c', sess('c'));
  assert.deepStrictEqual(reg.activeStreamSessions().map((s) => s.id), ['a', 'c']);
}

function main() {
  testInjectedMapIdentityPreserved();
  testCurrentStreamMajorityBehaviour();
  testLiveVariantSkipsExited();
  testMultipleActiveEmitsButDoesNotChangeResult();
  testActiveStreamSessionsPlural();
  console.log('session-registry.test.js passed');
}

main();
