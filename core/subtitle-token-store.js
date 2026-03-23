'use strict';

const crypto = require('crypto');

class SubtitleTokenStore {
  constructor(defaultTtlMs = 2 * 60 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
    this.tokens = new Map();
  }

  issueWithMetadata(filePath, ttlMs = this.defaultTtlMs) {
    this.prune();
    const token = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const record = {
      filePath,
      createdAt: now,
      expiresAt: now + Math.max(1000, Number(ttlMs) || this.defaultTtlMs),
    };
    this.tokens.set(token, record);
    return {
      token,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ttlMs: record.expiresAt - record.createdAt,
    };
  }

  issue(filePath, ttlMs = this.defaultTtlMs) {
    return this.issueWithMetadata(filePath, ttlMs).token;
  }

  resolve(token) {
    if (!token) return null;
    const item = this.tokens.get(token);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return item.filePath;
  }

  inspect(token) {
    if (!token) return null;
    const item = this.tokens.get(token);
    if (!item) return null;
    if (item.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return {
      token,
      filePath: item.filePath,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      ttlMs: item.expiresAt - item.createdAt,
    };
  }

  prune() {
    const now = Date.now();
    for (const [token, value] of this.tokens.entries()) {
      if (value.expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}

module.exports = {
  SubtitleTokenStore,
};
