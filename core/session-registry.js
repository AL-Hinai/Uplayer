'use strict';

// The live stream-session registry, and the single definition of "the current stream".
//
// Sessions live in a Map keyed by id. That much was already true; what was NOT centralized was
// the question every route kept re-answering by hand — `Array.from(sessions.values()).find(
// s => s.streamManager)` appeared verbatim in four places, and a FIFTH copy (the cast-readiness
// route) quietly added `&& !s.lifecycle?.status()?.exited`. Nobody could say whether that extra
// condition was the bug or the other four were, because the invariant it all assumes — AT MOST
// ONE session owns a running StreamManager at a time — was written down nowhere.
//
// This module makes that invariant observable (onEvent fires when two sessions are active at
// once) without changing behaviour: currentStreamSession() reproduces the majority definition
// exactly, and the divergent variant is a named option ({ live: true }) rather than a silent
// fifth copy. Unifying the two is a separate, test-backed decision; this only stops them drifting.
//
// The Map is INJECTED, not owned: server.js constructs it, hands it in, and still re-exports it
// as _internals.streamSessions (tests/vlc-progress.test.js destructures that Map and mutates it
// directly, so its identity is load-bearing). The registry never reassigns it.
//
// Pure: no IO, no timers. The caller owns session objects, their lifecycles, and teardown.

class SessionRegistry {
  /**
   * @param {Map} sessions the live session Map (injected; identity is preserved)
   * @param {(event: string, payload: object) => void} [onEvent] fires 'multiple-active-sessions'
   */
  constructor({ sessions, onEvent } = {}) {
    this.sessions = sessions instanceof Map ? sessions : new Map();
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
  }

  // The live Map, for whoever still needs direct access (server.js keeps ~19 direct call sites
  // and the _internals test hook). Never reassigned — clear() calls Map.clear().
  get map() { return this.sessions; }
  get size() { return this.sessions.size; }

  get(id) { return this.sessions.get(id); }
  has(id) { return this.sessions.has(id); }
  set(id, session) { this.sessions.set(id, session); return session; }
  delete(id) { return this.sessions.delete(id); }
  values() { return this.sessions.values(); }
  clear() { this.sessions.clear(); }

  // Every session that owns a StreamManager. Replaces the plural `.filter(s => s.streamManager)`.
  activeStreamSessions() {
    const out = [];
    for (const s of this.sessions.values()) if (s.streamManager) out.push(s);
    return out;
  }

  /**
   * The one session a bare "the current stream" request should act on.
   *
   * Default reproduces the historical majority behaviour exactly — the first session with a
   * StreamManager, in insertion order. `{ live: true }` additionally skips a session whose
   * lifecycle has exited, which is what the cast-readiness route did on its own; it is offered
   * here so that behaviour has one home instead of being copy-pasted with a subtle difference.
   *
   * Emits 'multiple-active-sessions' when more than one session qualifies — the case the
   * single-stream invariant says shouldn't happen. Surfacing it is the point; it does not change
   * which session is returned.
   */
  currentStreamSession({ live = false } = {}) {
    const active = this.activeStreamSessions();
    if (active.length > 1) {
      this.onEvent('multiple-active-sessions', { count: active.length, ids: active.map((s) => s.id) });
    }
    if (!live) return active[0] || null;
    return active.find((s) => !(s.lifecycle && s.lifecycle.status && s.lifecycle.status().exited)) || null;
  }
}

function createSessionRegistry(opts = {}) {
  return new SessionRegistry(opts);
}

module.exports = { SessionRegistry, createSessionRegistry };
