'use strict';

// Two people sharing one PC must never see each other's library, and an existing
// single-user install that never signs in must keep using the file it always has — an
// upgrade that silently moved ~/.uplayer-history.json would read as "all my history is
// gone". Both properties are decided entirely by which path is returned, so that is what
// this pins.

const assert = require('assert');
const os = require('os');
const path = require('path');
const { resolveDataPaths, ensureAccountDir, _internals } = require('../core/account-paths');

const HOME = path.join(os.tmpdir(), 'uplayer-account-paths-test');

function testSignedOutKeepsTheLegacyPaths() {
  const paths = resolveDataPaths(null, { home: HOME });
  assert.strictEqual(paths.historyPath, path.join(HOME, '.uplayer-history.json'),
    'an install that never signs in must not be migrated anywhere');
  assert.strictEqual(paths.recommendationPath, path.join(HOME, '.uplayer-recommendations.json'));
  assert.strictEqual(paths.accountId, null);

  // Empty string and undefined mean the same thing as null here.
  assert.strictEqual(resolveDataPaths('', { home: HOME }).historyPath, paths.historyPath);
  assert.strictEqual(resolveDataPaths(undefined, { home: HOME }).historyPath, paths.historyPath);
}

function testTwoAccountsNeverShareAFile() {
  const sara = resolveDataPaths('usr_sara', { home: HOME });
  const omar = resolveDataPaths('usr_omar', { home: HOME });
  assert.notStrictEqual(sara.historyPath, omar.historyPath);
  assert.notStrictEqual(sara.recommendationPath, omar.recommendationPath);
  assert.notStrictEqual(sara.syncPath, omar.syncPath);

  // ...and neither collides with the signed-out profile.
  const guest = resolveDataPaths(null, { home: HOME });
  assert.notStrictEqual(sara.historyPath, guest.historyPath);
}

function testUserIdCannotEscapeTheAccountsDirectory() {
  // The id comes from the cloud, so it is untrusted input on a path.
  const evil = resolveDataPaths('../../../etc/passwd', { home: HOME });
  assert.ok(evil.historyPath.startsWith(path.join(HOME, '.uplayer', 'accounts')),
    'a traversal attempt must stay inside the accounts directory');
  assert.ok(!evil.historyPath.includes('..'));
  assert.strictEqual(_internals.safeAccountId('a/b\\c..d'), 'abcd');
  assert.strictEqual(_internals.safeAccountId('../..'), '', 'a fully invalid id degrades to signed-out');
}

function testSyncStateIsNotInTheHistoryFile() {
  // The cursor and watermark live beside the library, not inside it — the history file's
  // shape is what every existing reader depends on.
  const paths = resolveDataPaths('usr_sara', { home: HOME });
  assert.notStrictEqual(paths.syncPath, paths.historyPath);
  assert.strictEqual(path.basename(paths.syncPath), 'sync.json');
}

function testEnsureAccountDirIsIdempotent() {
  const first = ensureAccountDir('usr_sara', { home: HOME });
  const second = ensureAccountDir('usr_sara', { home: HOME });
  assert.strictEqual(first.dir, second.dir);
  assert.ok(require('fs').existsSync(first.dir));

  // Signed out creates nothing — the legacy files are written by the stores themselves.
  const guest = ensureAccountDir(null, { home: HOME });
  assert.strictEqual(guest.accountId, null);
}

function main() {
  testSignedOutKeepsTheLegacyPaths();
  testTwoAccountsNeverShareAFile();
  testUserIdCannotEscapeTheAccountsDirectory();
  testSyncStateIsNotInTheHistoryFile();
  testEnsureAccountDirIsIdempotent();
  console.log('account-paths.test.js passed');
}

main();
