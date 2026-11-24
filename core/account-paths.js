'use strict';

// Which files an account's library lives in. It exists so that two people sharing one PC
// keep two separate libraries, and so that signing out never shows one person the other's
// history — the isolation is a different directory, not a filter applied at read time.
//
// The logged-out case deliberately resolves to the ORIGINAL paths
// (~/.uplayer-history.json, ~/.uplayer-recommendations.json). An existing single-user
// install that never signs in therefore keeps reading and writing exactly the file it
// always has: no migration step, no import prompt, nothing to go wrong on upgrade.
//
// Deliberately excluded: knowing who is signed in. That is the account client's business;
// this module is handed a userId (or nothing) and answers with paths.
//
// Pure except for ensureAccountDir, which is the one function that touches the filesystem.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same resolution order as the config store (config.js:69-72) so an account's files land
// beside .uplayer-config.json rather than in a second location. It matters on Android,
// where main.js points HOME at the app's writable files dir and os.homedir() would
// otherwise resolve to /data — which is not writable.
function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || __dirname;
}

// The userId arrives from the cloud, so it is untrusted input on a path. Anything outside
// this set is dropped rather than escaped: a directory named for a mangled id is a
// recoverable annoyance, whereas '../../' in a path is not.
function safeAccountId(userId) {
  const cleaned = String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned.slice(0, 64);
}

function accountsRoot(home = homeDir()) {
  return path.join(home, '.uplayer', 'accounts');
}

/**
 * Resolve the three files one profile uses. `userId` null/empty means signed out, which
 * returns the legacy top-level paths.
 *
 * syncPath holds the pull cursor, the last-pushed watermark, and this install's device id —
 * kept out of the history file so that file's shape stays exactly what every existing
 * reader expects.
 */
function resolveDataPaths(userId, options = {}) {
  const home = options.home || homeDir();
  const id = safeAccountId(userId);
  if (!id) {
    return {
      accountId: null,
      dir: home,
      historyPath: path.join(home, '.uplayer-history.json'),
      recommendationPath: path.join(home, '.uplayer-recommendations.json'),
      syncPath: path.join(home, '.uplayer-sync.json'),
    };
  }
  const dir = path.join(accountsRoot(home), id);
  return {
    accountId: id,
    dir,
    historyPath: path.join(dir, 'history.json'),
    recommendationPath: path.join(dir, 'recommendations.json'),
    syncPath: path.join(dir, 'sync.json'),
  };
}

/** Create the account directory if needed. Returns the same paths object for chaining. */
function ensureAccountDir(userId, options = {}) {
  const paths = resolveDataPaths(userId, options);
  if (paths.accountId) {
    fs.mkdirSync(paths.dir, { recursive: true });
  }
  return paths;
}

module.exports = {
  resolveDataPaths,
  ensureAccountDir,
  accountsRoot,
  // exposed for unit tests
  _internals: { safeAccountId, homeDir },
};
