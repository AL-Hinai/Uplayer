'use strict';

// Which Supabase project this device talks to, and where that setting came from.
//
// This replaces the old cloud-credentials test, and the thing it no longer asserts is the
// interesting part. Under the Turso design the module had to work out whether the database was
// "shared", because one token in every binary meant the account was a label rather than a
// boundary and the UI had to warn about it. A publishable key is public by design and Row
// Level Security is the boundary now, so a project shared by every install is the normal,
// correct arrangement — and a warning about it would be telling people something false.
//
// What survives is the precedence, which still matters: a project configured in Settings must
// beat one baked into the build, or someone who points the app at their own project keeps
// quietly syncing to the other one.
//
// Pure and injected: no config file is read, no network is touched.

const assert = require('assert');
const { describeEnvSource } = require('../core/config');
const { describeCloudProject } = require('../core/account-session');

const URL_KEY = 'SUPABASE_URL';
const KEY_KEY = 'SUPABASE_PUBLISHABLE_KEY';

function testSettingsOutranksTheBuildWhichOutranksTheEnvironment() {
  const layers = { store: { X: 'a' }, systemConfig: { X: 'b' }, env: { X: 'c' } };
  assert.strictEqual(describeEnvSource('X', layers), 'user');
  assert.strictEqual(describeEnvSource('X', { ...layers, store: {} }), 'build');
  assert.strictEqual(describeEnvSource('X', { store: {}, systemConfig: {}, env: { X: 'c' } }), 'env');
  assert.strictEqual(describeEnvSource('X', { store: {}, systemConfig: {}, env: {} }), null);

  // Blank is not configured. An empty string in the store is how clearing works, and it has to
  // uncover the layer underneath rather than read as a value of its own.
  assert.strictEqual(describeEnvSource('X', { store: { X: '   ' }, systemConfig: { X: 'b' }, env: {} }), 'build');
}

/** Builds the two injected lookups from a plain description of the three layers. */
function project(layers) {
  const value = (name) => {
    for (const layer of [layers.store || {}, layers.systemConfig || {}, layers.env || {}]) {
      if (layer[name] != null && String(layer[name]).trim() !== '') return String(layer[name]).trim();
    }
    return '';
  };
  return describeCloudProject({
    getEnv: (name) => value(name),
    describeEnvSource: (name, deps) => describeEnvSource(name, {
      store: deps && deps.store ? deps.store : (layers.store || {}),
      systemConfig: layers.systemConfig || {},
      env: layers.env || {},
    }),
  });
}

function testAProjectShippedWithTheBuildIsPerfectlyNormal() {
  const result = project({
    systemConfig: { [URL_KEY]: 'https://shipped.supabase.co', [KEY_KEY]: 'sb_publishable_x' },
  });
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.source, 'build');
  assert.strictEqual(result.host, 'shipped.supabase.co');
  assert.ok(!('shared' in result),
    'nothing here should still be deciding whether a project is "shared" - RLS answers that now');
}

function testOwnProjectOverridesTheBuild() {
  const result = project({
    store: { [URL_KEY]: 'https://mine.supabase.co', [KEY_KEY]: 'sb_publishable_mine' },
    systemConfig: { [URL_KEY]: 'https://shipped.supabase.co', [KEY_KEY]: 'sb_publishable_x' },
  });
  assert.strictEqual(result.source, 'user');
  assert.strictEqual(result.host, 'mine.supabase.co', 'Settings wins, so this is the host actually in use');
}

function testNothingConfiguredIsReportedAsNothing() {
  const result = project({});
  assert.strictEqual(result.configured, false);
  assert.strictEqual(result.source, null);
  assert.strictEqual(result.host, '');
}

function testAHalfConfiguredProjectIsNotUsable() {
  // A URL with no key cannot authenticate, so the UI has to offer the form rather than claim a
  // project is configured.
  assert.strictEqual(project({ store: { [URL_KEY]: 'https://mine.supabase.co' } }).configured, false);
  assert.strictEqual(project({ store: { [KEY_KEY]: 'sb_publishable_mine' } }).configured, false);
}

function testTheKeyIsNeverReturned() {
  const result = project({
    store: { [URL_KEY]: 'https://mine.supabase.co', [KEY_KEY]: 'sb_publishable_do_not_echo' },
  });
  assert.ok(!JSON.stringify(result).includes('sb_publishable_do_not_echo'),
    'this object goes straight into an HTTP response; even a publishable key has no business being echoed back');
}

function testAPastedUrlMissingItsSchemeStillShowsSomething() {
  // Seeing the mangled host back is how somebody spots that they pasted the wrong thing.
  const result = project({ store: { [URL_KEY]: 'mine.supabase.co/', [KEY_KEY]: 'k' } });
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.host, 'mine.supabase.co');
}

function main() {
  testSettingsOutranksTheBuildWhichOutranksTheEnvironment();
  testAProjectShippedWithTheBuildIsPerfectlyNormal();
  testOwnProjectOverridesTheBuild();
  testNothingConfiguredIsReportedAsNothing();
  testAHalfConfiguredProjectIsNotUsable();
  testTheKeyIsNeverReturned();
  testAPastedUrlMissingItsSchemeStillShowsSomething();
  console.log('cloud-project.test.js passed');
}

main();
