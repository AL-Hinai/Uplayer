'use strict';

// Does this Supabase project actually protect its data?
//
// Separate from everything else because of what it asks. Reaching a project proves almost
// nothing — a misconfigured project answers just as cheerfully as a correct one. What this
// asks instead is whether an UNAUTHENTICATED caller, holding only the publishable key that
// ships inside every copy of the app, can read the libraries table.
//
// That single question is the whole security model. If Row Level Security is off, every
// library in the project is readable by anyone who runs the app, AND NOTHING ELSE GOES WRONG:
// no error, no warning, no failed request, no slow query. Sync works perfectly while being
// completely open. A failure mode with no symptom is one you have to go looking for, which is
// why this exists as a thing you run rather than a thing you hope about.
//
// Deliberately excluded: anything that writes. A probe that tried an insert to see if it was
// refused would leave junk in a stranger's database on the one path where it was not.
//
// IO: one outbound HTTPS GET through the injected client factory. No files, no timers.

const { createSupabaseClient } = require('./supabase-client');

/**
 * @returns {Promise<{verified?: true, warning?: string, fatal?: string}>}
 *
 *   fatal   — do not use this project. Reported for data that is readable without signing in,
 *             and for a missing schema.
 *   warning — could not prove it either way. An empty table looks identical to a protected
 *             one from out here.
 *   verified — an anonymous read was refused. This is the pass.
 */
async function verifyProject(url, publishableKey, deps) {
  // Injected so tests can drive every answer; the default is the real client.
  const create = (deps && deps.createClient) || createSupabaseClient;
  // No session on purpose: this IS the anonymous case.
  const anon = create({ url, publishableKey });

  let probe;
  try {
    probe = await anon._request('GET', '/rest/v1/libraries?select=version&limit=1');
  } catch (e) {
    return { fatal: 'Could not reach that project: ' + e.message };
  }

  const bodyText = probe.body ? JSON.stringify(probe.body) : '';

  // A 401 is normally the answer we are hoping for. But Supabase ALSO answers 401 when the key
  // itself is not valid for this project — and that arrives looking identical to a successful
  // denial. Reading it as a pass would be the worst failure this file could have: it would
  // bless a project on the strength of a request that never reached the policy at all, and the
  // check exists precisely so nobody has to guess about this.
  if (/invalid api key|no api key found/i.test(bodyText)) {
    return {
      fatal: 'That publishable key is not valid for this project. Copy it again from '
        + 'Supabase: Settings -> API -> Project API keys (the publishable one).',
    };
  }

  if (probe.status === 401 || probe.status === 403) {
    return { verified: true };
  }

  // PGRST205 is PostgREST's "that table is not in my schema cache", which is what a project
  // that has never had the schema run answers with.
  if (probe.status === 404 || /does not exist|not find the table|PGRST205/i.test(bodyText)) {
    return {
      fatal: 'That project has no "libraries" table yet. Run scripts/supabase-schema.sql in '
        + 'the project SQL editor first.',
    };
  }

  if (probe.status === 200 && Array.isArray(probe.body) && probe.body.length > 0) {
    return {
      fatal: 'Row Level Security is OFF on that project: the libraries table is readable '
        + 'without signing in, so every account in it is exposed. Run '
        + 'scripts/supabase-schema.sql, then check again.',
    };
  }

  if (probe.status === 200) {
    return {
      warning: 'Reached the project, but the libraries table is empty so it could not be '
        + 'proven that Row Level Security is on. Run the check at the bottom of '
        + 'scripts/supabase-schema.sql before anyone else signs up.',
    };
  }

  return { fatal: 'That project answered with an unexpected status (' + probe.status + ')' };
}

module.exports = { verifyProject };
