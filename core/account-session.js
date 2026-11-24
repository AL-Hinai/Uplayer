'use strict';

// Which account this device is signed into, and the small pieces of state that go with it:
// the Supabase project to talk to, the session tokens, and the per-account sync watermark.
//
// The session is kept in the config store in plaintext. That is the same trust level as every
// other secret this app holds (TMDB key, OpenSubtitles password) and the same one a browser's
// cookie jar has: anyone who can read the file is already running as this user. What matters
// more is what the stored session is NOT — it is not a password. It expires, it can be revoked
// from the Supabase dashboard, and a refresh token that stops working logs the device out
// rather than leaving a credential lying around that still opens the account.
//
// Deliberately excluded: the sync engine, and anything that reads a library. This module
// answers "who are we, where does our bookkeeping live, and how do we reach the cloud" —
// nothing more.
//
// IO: the config store (via core/config), and one small JSON file per account.

const fs = require('fs');
const path = require('path');
const { getEnv, setConfigValues, describeEnvSource } = require('./config');
const { createSupabaseClient } = require('./supabase-client');
const { resolveDataPaths, ensureAccountDir } = require('./account-paths');

// Config-store keys. Not listed in /api/config's field list, so the settings endpoint never
// echoes them back to the browser.
const ACCOUNT_ID = 'UPLAYER_ACCOUNT_ID';
const ACCOUNT_EMAIL = 'UPLAYER_ACCOUNT_EMAIL';
const ACCESS_TOKEN = 'UPLAYER_ACCESS_TOKEN';
const REFRESH_TOKEN = 'UPLAYER_REFRESH_TOKEN';
// Stored so a restarted app knows its access token is stale before spending a request to find
// out. Not a security boundary — the server decides — just a way to skip a certain failure.
const EXPIRES_AT = 'UPLAYER_SESSION_EXPIRES_AT';

// The project. Both are safe to ship compiled into the binary: the publishable key grants
// nothing on its own, and Row Level Security decides what each signed-in request may touch
// (scripts/supabase-schema.sql). That is the whole reason this app can reach the database
// directly with no server of its own in between.
const PROJECT_URL = 'SUPABASE_URL';
const PROJECT_KEY = 'SUPABASE_PUBLISHABLE_KEY';

function readActiveAccount() {
  const id = getEnv(ACCOUNT_ID, '');
  if (!id) return null;
  return {
    id,
    email: getEnv(ACCOUNT_EMAIL, ''),
    accessToken: getEnv(ACCESS_TOKEN, ''),
    refreshToken: getEnv(REFRESH_TOKEN, ''),
    expiresAt: Number(getEnv(EXPIRES_AT, '')) || 0,
  };
}

/**
 * Persist a signed-in session. Passing null signs out — and it is the SAME function on purpose,
 * because every path that ends a session has to clear all four keys together. A sign-out that
 * left the refresh token behind would silently restore the account on the next start.
 */
function saveSession(session) {
  if (!session || !session.userId) {
    // Empty string deletes the entry (core/config.js). The account's FILES are left alone:
    // signing out is not "delete my library", and signing back in must find it where it was.
    setConfigValues({
      [ACCOUNT_ID]: '',
      [ACCOUNT_EMAIL]: '',
      [ACCESS_TOKEN]: '',
      [REFRESH_TOKEN]: '',
      [EXPIRES_AT]: '',
    });
    return null;
  }

  const written = setConfigValues({
    [ACCOUNT_ID]: session.userId,
    [ACCOUNT_EMAIL]: session.email || getEnv(ACCOUNT_EMAIL, ''),
    [ACCESS_TOKEN]: session.accessToken || '',
    [REFRESH_TOKEN]: session.refreshToken || '',
    [EXPIRES_AT]: session.expiresAt ? String(session.expiresAt) : '',
  });
  ensureAccountDir(session.userId);
  // Reported upward rather than ignored. A refresh token that reached memory but not disk is
  // the one way this app can drift into Supabase's stolen-token detection and lose the whole
  // session; the client stops rotating when it sees this. See SupabaseClient.refreshSession.
  if (!written) return false;
  return readActiveAccount();
}

function clearActiveAccount() {
  return saveSession(null);
}

/**
 * A client for the configured project, carrying this device's session if there is one.
 * Null when no project is configured at all.
 *
 * The onSession wiring is load-bearing rather than tidy: access tokens last an hour while the
 * sync loop runs for days, so the client refreshes itself mid-flight. Without persisting the
 * result, every restart would land on a dead token and ask the person to sign in again.
 */
function createConfiguredClient() {
  const url = getEnv(PROJECT_URL, '');
  const publishableKey = getEnv(PROJECT_KEY, '');
  if (!url || !publishableKey) return null;

  const account = readActiveAccount();
  const session = account && account.accessToken
    ? {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      userId: account.id,
      email: account.email,
      expiresAt: account.expiresAt,
    }
    : null;

  return createSupabaseClient({
    url,
    publishableKey,
    session,
    onSession: (next) => saveSession(next),
  });
}

/**
 * Which Supabase project this device talks to, and where that setting came from.
 *
 * Note what this deliberately does NOT report any more: whether the project is "shared". Under
 * the Turso design that mattered enormously — one token in every binary meant no boundary at
 * all — but a publishable key is public by design and Row Level Security is what separates one
 * person's library from another's. A project shared by every install is now the normal, correct
 * arrangement, so warning about it would be telling people something false.
 *
 * The key is never returned. The host is, so somebody can confirm which project they are on.
 */
function describeCloudProject(deps) {
  const options = deps || {};
  const read = options.getEnv || getEnv;
  const sourceOf = options.describeEnvSource || describeEnvSource;

  const url = read(PROJECT_URL, '');
  const key = read(PROJECT_KEY, '');

  if (!url || !key) {
    return { configured: false, source: null, host: '' };
  }

  const sources = [sourceOf(PROJECT_URL), sourceOf(PROJECT_KEY)];
  const source = sources.includes('user')
    ? 'user'
    : (sources.includes('build') ? 'build' : 'env');

  let host = '';
  try {
    host = new (require('url').URL)(url).host;
  } catch (e) {
    // A malformed URL is worth showing back as typed rather than hiding: it is almost always
    // a paste that lost its scheme, and seeing it is how someone spots that.
    host = String(url).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  }

  return { configured: true, source, host };
}

/**
 * The sync watermark for one account: the version we last agreed with, and how far our uploads
 * have got. A separate file from the library so the library's shape stays exactly what every
 * existing reader expects.
 */
function createSyncMeta(userId) {
  const { syncPath } = resolveDataPaths(userId);
  const fallback = { version: 0, lastPushedAt: 0 };
  return {
    read() {
      try {
        const raw = JSON.parse(fs.readFileSync(syncPath, 'utf8'));
        return {
          version: Number(raw.version) || 0,
          lastPushedAt: Number(raw.lastPushedAt) || 0,
        };
      } catch (e) {
        // Missing or corrupt reads as "never synced". That costs one full exchange, which the
        // merge rules make harmless, and it is far better than refusing to sync at all.
        return { ...fallback };
      }
    },
    write(state) {
      try {
        fs.mkdirSync(path.dirname(syncPath), { recursive: true });
        fs.writeFileSync(syncPath, JSON.stringify(state, null, 2), 'utf8');
      } catch (e) { /* read-only fs — the next sync re-derives it */ }
    },
    path: syncPath,
  };
}

module.exports = {
  readActiveAccount,
  saveSession,
  clearActiveAccount,
  createConfiguredClient,
  describeCloudProject,
  createSyncMeta,
  // exposed for unit tests
  _internals: {
    ACCOUNT_ID, ACCOUNT_EMAIL, ACCESS_TOKEN, REFRESH_TOKEN, EXPIRES_AT, PROJECT_URL, PROJECT_KEY,
  },
};
