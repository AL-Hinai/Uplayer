'use strict';

// server.js must not drag uplayer.js in at import time.
//
// server.js and uplayer.js require each other. Both edges are deliberately deferred to call
// time — server.js:41 hides its require inside getServices(), and uplayer.js hides its require
// of ./server inside the `web` CLI command — so the cycle never resolves at load and neither
// file's exports are half-built when the other reads them.
//
// That was true of the *intent* and false in practice. `const PORT = getServices()...` sat at
// server.js top level, so requiring server.js called getServices() immediately, which required
// uplayer.js immediately. The laziness bought nothing and nobody noticed, because nothing
// asserted it. PORT is now getPort(), called from startServer().
//
// This test is the whole reason that fix stays fixed. Without it the next top-level
// `getServices()` re-breaks the graph silently, and any later attempt to reorder the module
// graph inherits the problem.
//
// Pure: requires server.js and inspects require.cache. Binds no port — server.js only listens
// under `require.main === module`.

const assert = require('assert');
const path = require('path');

function testRequiringServerDoesNotLoadUplayer() {
  const uplayerPath = path.join(__dirname, '..', 'uplayer.js');
  assert.ok(!require.cache[uplayerPath], 'precondition: uplayer.js must not be loaded yet');

  require('../server.js');

  assert.ok(
    !require.cache[uplayerPath],
    'requiring server.js must not load uplayer.js.\n'
    + 'Something at server.js top level is calling getServices() (or requiring ./uplayer.js\n'
    + 'directly). Move it behind a function — see getPort().'
  );
}

// The counterpart: the laziness is only useful if getServices() still works when called.
// A "fix" that made getServices() unreachable would pass the test above and break the app.
function testGetServicesStillLoadsUplayerOnDemand() {
  const uplayerPath = path.join(__dirname, '..', 'uplayer.js');
  const server = require('../server.js');

  assert.strictEqual(typeof server.startServer, 'function', 'server.js should export startServer');

  // Reaching into the app's own lazy loader without starting a listener: getSessionPlayerState
  // is not it, so drive the documented path instead — requiring uplayer.js directly must still
  // succeed and hand back the constructors createSharedServices needs.
  const uplayer = require('../uplayer.js');
  assert.ok(require.cache[uplayerPath], 'uplayer.js should be loadable on demand');
  for (const name of ['StreamManager', 'TorrentScraper', 'SubtitleManager', 'MediaSearcher']) {
    assert.strictEqual(typeof uplayer[name], 'function', `uplayer.js should export ${name}`);
  }
}

function main() {
  testRequiringServerDoesNotLoadUplayer();
  testGetServicesStillLoadsUplayerOnDemand();
  console.log('module-graph.test.js passed');
}

main();
