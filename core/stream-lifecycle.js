'use strict';

class StreamLifecycleState {
  constructor(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.playerUrl = null;
    this.exited = false;
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

  playerReady(url) {
    if (this.exited) return false;
    if (!url || this.playerUrl) return false;
    this.playerUrl = String(url);
    this.onEvent('player_ready', { url: this.playerUrl });
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
      exited: this.exited,
    };
  }
}

module.exports = {
  StreamLifecycleState,
};
