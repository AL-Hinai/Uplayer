'use strict';

// Normalizes what a player is doing into one shape, whatever the player is.
//
// Four targets report playback and no two can report the same way: the web player
// pushes real events from the page, VLC gets scraped over its HTTP interface, a DLNA
// TV gets polled over SOAP, and Chromecast is polled by the *browser*. Position was
// the only thing all four could supply, so historically it was the only thing that got
// a shared destination — `ended`, errors and transport state were each solved for
// whichever target needed them first and never generalized. The visible cost was that
// auto-next-episode only ever worked in the web player.
//
// This module is the missing middle. It holds no timers and does no I/O: the existing
// pollers keep their plumbing and feed it pre-mapped reports, it decides what those
// reports MEAN, and emits. Same shape as StreamLifecycleState (constructor takes an
// onEvent callback, mutators return true/false) so it unit-tests the same way.

// Below this, a playhead is startup noise rather than a resume point. This is the one
// definition — server, web player and cast sender all defer to it instead of each
// carrying their own literal 5.
const MIN_POSITION_SEC = 5;

// history-store.js:132 counts >=90% as "completed" (clears the resume marker).
// Exported so that rule keeps a single owner.
const COMPLETION_RATIO = 0.9;

// ...but "completed" and "ended" are deliberately NOT the same threshold. `ended` is
// what fires the auto-next-episode overlay, and it has to be inferred from an
// ambiguous stop: a TV reporting STOPPED can't tell us whether the credits rolled or
// the user walked away. At history's 0.9, quitting 4 minutes before the end of a
// 45-minute episode would pop an overlay nobody asked for. 0.95 keeps that inference
// conservative. Targets with an explicit finished signal (the web player's `ended`
// event, Chromecast's IDLE+FINISHED) bypass this entirely and are always believed.
const ENDED_RATIO = 0.95;

// Seeking back before this clears a previously-derived `ended`, so re-watching after
// the credits doesn't leave the flag stuck true for the rest of the session.
const RESUME_RATIO = 0.8;

const KINDS = new Set(['web', 'vlc', 'dlna', 'cast']);
const STATES = new Set(['playing', 'paused', 'buffering', 'stopped', 'idle']);

// Number(null) and Number('') are both 0 — without the guard, "the renderer didn't
// report this" would become a confident zero. The noise floor happens to reject that
// today, but it's not a thing to rely on.
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// What the caller knows about the device behind a target, kept to the fields every
// kind can actually supply. `kind` already says WHO is playing in the abstract; this
// says which box in the house. Free-form on purpose — only the caller can know a TV's
// friendly name — but normalized here so the shape is the same for all four kinds.
function normalizeDevice(device) {
  if (!device || typeof device !== 'object') return null;
  const str = (v) => (v == null || v === '' ? null : String(v));
  const out = {
    name: str(device.name),
    model: str(device.model),
    address: str(device.address),
  };
  // A descriptor with nothing in it is worse than none: it makes an unknown device
  // look like a known one with blank fields.
  return (out.name || out.model || out.address) ? out : null;
}

class PlaybackTarget {
  /**
   * @param {'web'|'vlc'|'dlna'|'cast'} kind
   * @param {(event: string, payload: object) => void} onEvent
   * @param {{name?: string, model?: string, address?: string}} [device] the box itself,
   *   when the caller knows it (a TV's friendly name, a Chromecast's label). VLC and the
   *   web player are usually just "here", so they pass nothing.
   */
  constructor(kind, onEvent, device = null) {
    this.kind = KINDS.has(kind) ? kind : 'web';
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.device = normalizeDevice(device);
    this.state = 'idle';
    this.positionSec = null;
    this.durationSec = null;
    this.ended = false;
    this.lastSeenAt = null;
    this.finished = false;
  }

  /**
   * Name the device after the fact. Discovery and playback don't always land in that
   * order — a Chromecast's friendly name arrives with its first progress report, not
   * when the target is created — and a late name is still better than none.
   */
  describe(device) {
    const next = normalizeDevice(device);
    if (next) this.device = next;
    return this.device;
  }

  /**
   * Fold one report from a player into the target's state.
   *
   * `state` must already be mapped to a common vocabulary by the caller — only the
   * caller knows that VLC says "playing" and a renderer says "PLAYING" and the CAF
   * SDK says "IDLE" with an idleReason. Pass `ended: true` only for an explicit
   * finished signal; an ambiguous stop is `state: 'stopped'` and gets inferred here.
   *
   * @returns the derived status, or null when the report carried nothing usable.
   */
  report({ positionSec, durationSec, state, ended } = {}) {
    if (this.finished) return null;
    if (!STATES.has(state)) return null;

    // Retain the last good playhead. This is the whole reason the abstraction exists:
    // players zero their counters on stop (VLC reports <time>0</time>, renderers
    // report 0:00:00), so at the exact moment we need to ask "did it finish?" the
    // current report can't tell us — only the retained one can. Stopped/idle reports
    // therefore never overwrite position, and for live states the noise floor already
    // rejects the zeroes for free.
    if (state !== 'stopped' && state !== 'idle') {
      const position = finiteOrNull(positionSec);
      if (position != null && position >= MIN_POSITION_SEC) {
        this.positionSec = Math.floor(position);
        const duration = finiteOrNull(durationSec);
        if (duration != null && duration > 0) this.durationSec = Math.floor(duration);
      }
    }

    const ratio = this.completionRatio();

    if (ended === true) {
      this.ended = true; // explicit and trusted: the player told us it finished
    } else if (state === 'stopped' || state === 'idle') {
      // Ambiguous: finished, or bailed out early? Only the retained playhead knows.
      // A renderer can also report STOPPED in the seconds after SetAVTransportURI,
      // before playback settles — retained position is null there, so ratio is null
      // and this correctly stays false.
      if (ratio != null && ratio >= ENDED_RATIO) this.ended = true;
    } else if (state === 'playing' && ratio != null && ratio < RESUME_RATIO) {
      this.ended = false; // seeked back well before the end: no longer ended
    }

    // Nothing worth telling anyone yet — still under the noise floor, and no verdict.
    if (this.positionSec == null && !this.ended) return null;

    this.state = state;
    this.lastSeenAt = Date.now();
    const payload = this.status();
    this.onEvent('playback', payload);
    return payload;
  }

  /** The player failed. `fatal` distinguishes "playback is over" from a warning. */
  error({ code = null, message = '', fatal = true } = {}) {
    if (this.finished) return false;
    this.onEvent('playback_error', {
      kind: this.kind,
      device: this.device,
      code: code == null ? null : code,
      message: String(message || 'Playback failed'),
      fatal: fatal !== false,
      positionSec: this.positionSec,
    });
    return true;
  }

  /**
   * The target stopped answering and won't be back — VLC closed, the TV went off.
   * Terminal: later reports are ignored, so a poller racing its own teardown can't
   * resurrect a dead target.
   */
  gone(reason = 'unknown') {
    if (this.finished) return false;
    this.finished = true;
    this.onEvent('playback_error', {
      kind: this.kind,
      device: this.device,
      code: null,
      reason: String(reason),
      message: goneMessage(this.kind, reason, this.device),
      // "unavailable" means we never established contact at all (VLC too old, or its
      // flags went to an already-running instance). That's an expected shrug, not a
      // failure worth interrupting the user over.
      fatal: reason !== 'unavailable',
      positionSec: this.positionSec,
    });
    return true;
  }

  /** position/duration, or null when either is unknown — never guess a ratio. */
  completionRatio() {
    if (this.positionSec == null) return null;
    if (this.durationSec == null || this.durationSec <= 0) return null;
    return this.positionSec / this.durationSec;
  }

  status() {
    return {
      kind: this.kind,
      device: this.device,
      state: this.state,
      positionSec: this.positionSec,
      durationSec: this.durationSec,
      ended: this.ended,
      lastSeenAt: this.lastSeenAt,
    };
  }
}

function goneMessage(kind, reason, device) {
  if (kind === 'vlc' && reason === 'unavailable') return 'VLC is playing, but progress tracking is unavailable';
  if (kind === 'vlc') return 'VLC was closed';
  // Name the box when we know it: with two TVs in the house, "Lost contact with the TV"
  // doesn't say which one to go and prod.
  if (kind === 'dlna') return `Lost contact with ${(device && device.name) || 'the TV'}`;
  return 'Playback stopped reporting';
}

module.exports = {
  PlaybackTarget,
  MIN_POSITION_SEC,
  COMPLETION_RATIO,
  ENDED_RATIO,
  RESUME_RATIO,
};
