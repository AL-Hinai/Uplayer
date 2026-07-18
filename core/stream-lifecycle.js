'use strict';

class StreamLifecycleState {
  constructor(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.playerUrl = null;
    this.playerReadyData = null;
    this.exited = false;
    this.lastPlayback = null;
    this.lastStreamHealth = null;
    this.lastTargets = [];
  }

  line(text) {
    if (this.exited) return false;
    this.onEvent('line', { text: String(text || '') });
    return true;
  }

  progress(payload) {
    if (this.exited) return false;
    this.onEvent('progress', payload || {});
    return true;
  }

  // Playback events are deliberately NOT folded into `progress` above: that one already
  // means torrent download percent and the UI reads {percent, speed} off it. These are
  // new event names, and EventSource ignores types nobody listens for, so existing
  // clients are unaffected by them appearing.
  playback(payload) {
    if (this.exited) return false;
    this.lastPlayback = payload || {};
    this.onEvent('playback', this.lastPlayback);
    return true;
  }

  playbackError(payload) {
    if (this.exited) return false;
    this.onEvent('playback_error', payload || {});
    return true;
  }

  // The byte supply: real numbers, seeds vs peers, buffer ahead. Separate from
  // `progress` above for the same reason `playback` is — `progress` is the download bar
  // and its {percent, speed} shape is frozen.
  streamHealth(payload) {
    if (this.exited) return false;
    this.lastStreamHealth = payload || {};
    this.onEvent('stream_health', this.lastStreamHealth);
    return true;
  }

  // Every target that has played this session, with what each is doing right now.
  // `playback` above is one report from ONE target and is what auto-next listens to;
  // this is the roster. They're separate events because they answer different
  // questions — "did this finish?" vs "what is this stream feeding?" — and because a
  // roster that arrived only when a playhead moved would never show a target that has
  // gone quiet, which is exactly when you want to look at it.
  targets(list) {
    if (this.exited) return false;
    this.lastTargets = Array.isArray(list) ? list : [];
    this.onEvent('targets', this.lastTargets);
    return true;
  }

  playerReady(payloadOrUrl) {
    if (this.exited) return false;
    const payload = payloadOrUrl && typeof payloadOrUrl === 'object' && !Array.isArray(payloadOrUrl)
      ? { ...payloadOrUrl }
      : { url: payloadOrUrl };
    const url = payload && payload.url ? String(payload.url) : '';
    if (!url || this.playerUrl) return false;
    this.playerUrl = url;
    this.playerReadyData = {
      ...payload,
      url,
    };
    this.onEvent('player_ready', this.playerReadyData);
    return true;
  }

  exit(code = 0) {
    if (this.exited) return false;
    this.exited = true;
    this.onEvent('exit', { code: Number.isFinite(Number(code)) ? Number(code) : 0 });
    return true;
  }

  status() {
    return {
      playerUrl: this.playerUrl,
      playerReadyData: this.playerReadyData,
      exited: this.exited,
      playback: this.lastPlayback,
      streamHealth: this.lastStreamHealth,
      targets: this.lastTargets,
    };
  }
}

module.exports = {
  StreamLifecycleState,
};
