'use strict';

// The one check the whole design rests on: can somebody holding nothing but the publishable
// key — the key that ships inside every copy of the app, which anyone can read out of the
// binary — read other people's libraries?
//
// If Row Level Security is off, the answer is yes, for every account in the project, and
// NOTHING ELSE GOES WRONG. No error, no warning, no failed request. The app works perfectly
// while being completely open. That is why connecting a project probes for the denial instead
// of probing for success: a request that succeeds tells you the project exists, and nothing
// whatsoever about whether it is safe.
//
// The last test runs the same probe against the configured project when one is set — in
// core/system-config.js, .env, or the environment — and skips itself otherwise, the same
// arrangement subtitle-window-sync.test.js uses for the alass binary. `npm run check:supabase`
// runs exactly this check on demand, which is the one to use when setting a project up.

const assert = require('assert');
const { verifyProject } = require('../core/supabase-verify');

/** A client whose anonymous probe answers however the test says. */
function fakeAnon(answer) {
  return () => ({
    _request: async () => (typeof answer === 'function' ? answer() : answer),
  });
}

async function testDeniedIsThePass() {
  for (const status of [401, 403]) {
    const result = await verifyProject('https://p.supabase.co', 'key', {
      createClient: fakeAnon({ status, body: { message: 'permission denied for table libraries' } }),
    });
    assert.strictEqual(result.fatal, undefined, 'a denial is exactly what we want to see');
    assert.strictEqual(result.verified, true, 'status ' + status + ' must read as protected');
  }
}

async function testAnInvalidKeyIsNotMistakenForADenial() {
  // The nastiest false pass available here. Supabase answers a key it does not recognise with
  // 401 — the same status a successful RLS denial produces — so a check that reads status
  // alone would bless a project on the strength of a request that never reached a policy.
  // Both of these are the real bodies, copied from a live project.
  const bodies = [
    { message: 'Invalid API key', hint: 'Double check your API key.' },
    { message: 'No API key found in request' },
  ];
  for (const body of bodies) {
    const result = await verifyProject('https://p.supabase.co', 'wrong', {
      createClient: fakeAnon({ status: 401, body }),
    });
    assert.ok(result.fatal, 'a rejected key must not read as "protected": ' + JSON.stringify(body));
    assert.ok(/not valid for this project/.test(result.fatal));
    assert.notStrictEqual(result.verified, true);
  }
}

async function testReadableRowsAreRefusedOutright() {
  const result = await verifyProject('https://p.supabase.co', 'key', {
    createClient: fakeAnon({ status: 200, body: [{ version: 3 }] }),
  });
  assert.ok(result.fatal, 'rows readable without signing in means every library is exposed');
  assert.ok(/Row Level Security is OFF/.test(result.fatal));
  assert.strictEqual(result.warning, undefined,
    'this is not a warning to click past - saving these credentials is worse than having no sync');
}

async function testAnEmptyTableIsAWarningNotAPass() {
  const result = await verifyProject('https://p.supabase.co', 'key', {
    createClient: fakeAnon({ status: 200, body: [] }),
  });
  assert.strictEqual(result.fatal, undefined, 'an empty table is not proof of a problem...');
  assert.ok(result.warning, '...but it is not proof of safety either, and silence would imply it was');
  assert.ok(/could not be proven/.test(result.warning));
}

async function testAMissingTableSaysWhichScriptToRun() {
  const byStatus = await verifyProject('https://p.supabase.co', 'key', {
    createClient: fakeAnon({ status: 404, body: {} }),
  });
  assert.ok(/supabase-schema\.sql/.test(byStatus.fatal),
    'the fix is one named file - an error that does not name it sends people to a search engine');

  // PostgREST more often answers 400 with a message rather than a bare 404.
  const byMessage = await verifyProject('https://p.supabase.co', 'key', {
    createClient: fakeAnon({ status: 400, body: { message: 'relation "public.libraries" does not exist' } }),
  });
  assert.ok(/supabase-schema\.sql/.test(byMessage.fatal));

  // What a real Supabase project actually answers before the schema has been run.
  const live = await verifyProject('https://p.supabase.co', 'key', {
    createClient: fakeAnon({
      status: 404,
      body: { code: 'PGRST205', message: "Could not find the table 'public.libraries' in the schema cache" },
    }),
  });
  assert.ok(/supabase-schema\.sql/.test(live.fatal));
}

async function testAnUnreachableProjectIsNotSaved() {
  const result = await verifyProject('https://nope.supabase.co', 'key', {
    createClient: () => ({ _request: async () => { throw new Error('getaddrinfo ENOTFOUND nope.supabase.co'); } }),
  });
  assert.ok(/Could not reach that project/.test(result.fatal));
  assert.ok(/ENOTFOUND/.test(result.fatal), 'the underlying message is more use than anything we could invent');
}

/**
 * The real thing, against a real project. Skipped unless credentials are in the environment,
 * because the alternative is a test suite that needs a network and an account to run at all.
 */
async function testAgainstARealProjectIfConfigured() {
  // Through getEnv, not process.env directly, so this covers a project set in
  // core/system-config.js — which is where a shipping build's project actually lives.
  const { loadEnvFileOnce, getEnv } = require('../core/config');
  loadEnvFileOnce();
  const url = getEnv('SUPABASE_URL', '');
  const key = getEnv('SUPABASE_PUBLISHABLE_KEY', '');
  if (!url || !key) {
    console.log('  (skipped the live check: no Supabase project configured)');
    return;
  }

  const result = await verifyProject(url, key);

  // Being offline must not turn the whole suite red — that would make every test hostage to a
  // network connection. A project we DID reach and found wanting is a different matter: that
  // is the finding this file exists to produce, and it has to break the build.
  if (result.fatal && /Could not reach that project/.test(result.fatal)) {
    console.log('  (skipped the live check: ' + result.fatal + ')');
    return;
  }

  assert.strictEqual(result.fatal, undefined,
    'the configured project failed its own security check: ' + result.fatal);
  if (result.warning) {
    console.log('  (live check passed with a warning: ' + result.warning + ')');
  } else {
    console.log('  (live check: anonymous reads are denied)');
  }
}

async function main() {
  await testDeniedIsThePass();
  await testAnInvalidKeyIsNotMistakenForADenial();
  await testReadableRowsAreRefusedOutright();
  await testAnEmptyTableIsAWarningNotAPass();
  await testAMissingTableSaysWhichScriptToRun();
  await testAnUnreachableProjectIsNotSaved();
  await testAgainstARealProjectIfConfigured();
  console.log('supabase-rls.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
