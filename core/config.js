'use strict';

const fs = require('fs');
const path = require('path');
let systemConfig = {};
try {
  // Optional local hardcoded runtime config.
  // This file is intentionally loaded dynamically so projects can choose env-only or hardcoded setup.
  // eslint-disable-next-line global-require
  systemConfig = require('./system-config');
} catch (e) {
  systemConfig = {};
}

let loaded = false;

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eq = trimmed.indexOf('=');
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  if (!key) return null;
  let value = trimmed.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('\'') && value.endsWith('\''))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function loadEnvFileOnce() {
  if (loaded) return;
  loaded = true;

  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] == null) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

function requireEnv(name, options = {}) {
  const { allowEmpty = false } = options;
  const value = process.env[name];
  if (value == null) {
    throw new Error(`${name} environment variable is required`);
  }
  if (!allowEmpty && !String(value).trim()) {
    throw new Error(`${name} environment variable must not be empty`);
  }
  return value;
}

function getEnv(name, fallback = '') {
  const fromSystem = systemConfig[name];
  if (fromSystem != null && String(fromSystem).trim()) {
    return String(fromSystem).trim();
  }

  const value = process.env[name];
  if (value != null && String(value).trim()) return String(value).trim();

  return fallback;
}

function getRuntimeConfig() {
  loadEnvFileOnce();
  const portRaw = getEnv('PORT', '3000');
  const portNum = Number(portRaw);
  return {
    port: Number.isFinite(portNum) && portNum > 0 ? portNum : 3000,
    tmdbApiKey: getEnv('TMDB_API_KEY', ''),
    openSubtitles: {
      apiKey: getEnv('OPENSUBTITLES_API_KEY', ''),
      username: getEnv('OPENSUBTITLES_USERNAME', ''),
      password: getEnv('OPENSUBTITLES_PASSWORD', ''),
    },
  };
}

function validateRuntimeConfig(config = getRuntimeConfig()) {
  const warnings = [];
  const errors = [];

  if (!config.tmdbApiKey) {
    warnings.push(
      'TMDB_API_KEY is missing in system config. TMDB-based discovery routes will return errors until configured.'
    );
  }

  const missingOpenSubtitles = [];
  if (!config.openSubtitles.apiKey) missingOpenSubtitles.push('OPENSUBTITLES_API_KEY');
  if (!config.openSubtitles.username) missingOpenSubtitles.push('OPENSUBTITLES_USERNAME');
  if (!config.openSubtitles.password) missingOpenSubtitles.push('OPENSUBTITLES_PASSWORD');
  if (missingOpenSubtitles.length > 0) {
    warnings.push(
      `OpenSubtitles credentials are incomplete in system config (${missingOpenSubtitles.join(', ')}). Subtitle search/download may be limited.`
    );
  }

  return {
    config,
    warnings,
    errors,
    ok: errors.length === 0,
  };
}

module.exports = {
  loadEnvFileOnce,
  requireEnv,
  getEnv,
  getRuntimeConfig,
  validateRuntimeConfig,
};
