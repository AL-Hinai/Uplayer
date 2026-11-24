'use strict';

// Check the configured Supabase project before shipping a build that points at it.
//
//   npm run check:supabase
//
// Credentials come from core/system-config.js, a .env file, or real environment variables, in
// the usual precedence (core/config.js). Run this once after filling them in, and again any
// time you touch the project's policies.
//
// It exits non-zero on a fatal finding so it can sit in a release script. The finding that
// matters is not "can I reach the project" but "can somebody who is NOT signed in read other
// people's libraries" — see core/supabase-verify.js for why that one has no other symptom.

const path = require('path');
const { loadEnvFileOnce, getEnv } = require(path.join(__dirname, '..', 'core', 'config'));
const { verifyProject } = require(path.join(__dirname, '..', 'core', 'supabase-verify'));

async function main() {
  loadEnvFileOnce();
  const url = getEnv('SUPABASE_URL', '');
  const key = getEnv('SUPABASE_PUBLISHABLE_KEY', '');

  if (!url || !key) {
    console.error('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are not set.');
    console.error('Fill them in core/system-config.js, or in .env, then run this again.');
    process.exit(1);
  }

  if (/service_role|^sb_secret_/i.test(key)) {
    // Worth refusing outright rather than testing: a secret key bypasses RLS, so the probe
    // below would pass for the wrong reason and the build would ship full database access.
    console.error('That looks like a SECRET key. Use the publishable key — a secret key in a');
    console.error('client binary gives every user read and write over everybody else\'s data.');
    process.exit(1);
  }

  console.log('Project: ' + url);
  const result = await verifyProject(url, key);

  if (result.fatal) {
    console.error('\nFAILED: ' + result.fatal);
    process.exit(1);
  }
  if (result.warning) {
    console.warn('\nWARNING: ' + result.warning);
    console.warn('Not a failure, but the one property this design rests on is unproven.');
    return;
  }
  console.log('\nOK: an anonymous caller holding the publishable key cannot read the');
  console.log('libraries table. Row Level Security is doing its job.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
