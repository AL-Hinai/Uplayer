'use strict';

const fs = require('fs');
const os = require('os');
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

// --- user-entered config store ----------------------------------------------
// Keys entered in the app's Settings popup are saved here so a fresh PC doesn't
// need a .env / env vars at all — it just asks for what it needs. This store has
// the HIGHEST priority; env / system-config remain as optional fallbacks.
let store = null;
function configStorePath() {
  const base = process.env.HOME || process.env.USERPROFILE || os.homedir() || __dirname;
  return path.join(base, '.uplayer-config.json');
}
function readConfigStore() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(configStorePath(), 'utf8')) || {}; } catch (e) { store = {}; }
  return store;
}
/**
 * Returns whether the values actually reached DISK, not just the in-memory cache.
 *
 * That distinction used to be swallowed, and for most keys it genuinely does not matter — a
 * TMDB key that fails to save is re-typed. For the auth session it matters a great deal:
 * Supabase hands out a new refresh token every time one is used and invalidates the old, so a
 * write that silently fails leaves disk holding a token that is one rotation further behind
 * with every refresh. Far enough behind and Supabase treats it as a stolen-token replay and
 * terminates the whole session. The caller has to be able to see that coming.
 */
function setConfigValues(values = {}) {
  const s = readConfigStore();
  for (const [k, v] of Object.entries(values)) {
    if (v == null || String(v).trim() === '') delete s[k];
    else s[k] = String(v).trim();
  }
  let written = false;
  try {
    fs.writeFileSync(configStorePath(), JSON.stringify(s, null, 2));
    written = true;
  } catch (e) {
    // Read-only filesystem, no permission, disk full. Reported, never thrown: a failure to
    // save a setting must not take down whatever the caller was doing.
    written = false;
  }
  store = s;
  return written;
}

function getEnv(name, fallback = '') {
  const fromStore = readConfigStore()[name];
  if (fromStore != null && String(fromStore).trim()) {
    return String(fromStore).trim();
  }

  const fromSystem = systemConfig[name];
  if (fromSystem != null && String(fromSystem).trim()) {
    return String(fromSystem).trim();
  }

  const value = process.env[name];
  if (value != null && String(value).trim()) return String(value).trim();

  return fallback;
}

// WHERE a value came from, which getEnv deliberately flattens away. One caller needs the
// distinction: cloud sync has to tell the person whether the database it syncs to arrived
// with the app — shared with every other install, and therefore not private — or was
// configured here and is theirs. Answering that wrong is worse than not answering it.
//
//   'user'  — typed into the Settings popup on this device (highest priority)
//   'build' — core/system-config.js, i.e. compiled into the binary and identical everywhere
//   'env'   — a real env var or .env file, so configured on this machine but outside the app
//   null    — not set anywhere
//
// Fully injectable because the alternative is a test that reads the developer's own
// ~/.uplayer-config.json and passes or fails depending on what is in it.
function describeEnvSource(name, deps = {}) {
  const set = (value) => value != null && String(value).trim() !== '';
  const store = deps.store || readConfigStore();
  const system = deps.systemConfig || systemConfig;
  const env = deps.env || process.env;

  if (set(store[name])) return 'user';
  if (set(system[name])) return 'build';
  if (set(env[name])) return 'env';
  return null;
}

// Which keys are configured (booleans only — never leak the secret values).
function getConfigStatus() {
  return {
    TMDB_API_KEY: !!getEnv('TMDB_API_KEY'),
    OPENSUBTITLES_API_KEY: !!getEnv('OPENSUBTITLES_API_KEY'),
    OPENSUBTITLES_USERNAME: !!getEnv('OPENSUBTITLES_USERNAME'),
    OPENSUBTITLES_PASSWORD: !!getEnv('OPENSUBTITLES_PASSWORD'),
    PREFERRED_QUALITY: !!getEnv('PREFERRED_QUALITY'),
  };
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
  setConfigValues,
  getConfigStatus,
  configStorePath,
  describeEnvSource,
};
