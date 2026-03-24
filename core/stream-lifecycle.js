'use strict';

class StreamLifecycleState {
  constructor(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.playerUrl = null;
    this.playerReadyData = null;
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
    };
  }
}

module.exports = {
  StreamLifecycleState,
};
