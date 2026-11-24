'use strict';

// Hardcoded runtime configuration, compiled into the build.
//
// Fill these in for a standalone system-level setup that needs no .env file. This is the file
// the `pkg` binaries carry, so whatever is here is what every install starts with.
//
// PRECEDENCE, which is not what you would guess: core/config.js resolves a value as
//
//     Settings popup  ->  THIS FILE  ->  environment variable / .env  ->  default
//
// so a value filled in here BEATS an env var, rather than the other way round. If you set
// something here and then wonder why your exported variable is being ignored, that is why.
// Leave a key blank to let .env or a real env var supply it.

module.exports = {
  TMDB_API_KEY: '',
  OPENSUBTITLES_API_KEY: '',
  OPENSUBTITLES_USERNAME: '',
  OPENSUBTITLES_PASSWORD: '',
  PORT: '',

  // --- Cloud sync (Supabase) -----------------------------------------------------------
  // Fill both to give every install sync out of the box. Users then only ever see sign in,
  // create account and forgot password — there is nothing for them to configure, because
  // there is nothing here that is theirs to hold.
  //
  // THE KEY BELOW IS MEANT TO BE PUBLIC. It is Supabase's *publishable* key: it identifies
  // the project and grants nothing on its own. What separates one person's library from
  // another's is Row Level Security in Postgres (scripts/supabase-schema.sql), which the
  // database enforces on every request against the signed-in session. So shipping this key in
  // a binary anyone can read is the intended design, not a compromise.
  //
  // Never put a service_role or secret key here. One of those bypasses RLS entirely, and in a
  // client binary it would hand every user full read and write over everybody's data.
  //
  // After filling these in, run `npm run check:supabase` once. It verifies the schema is in
  // place and — the part that matters — that an anonymous caller holding this key CANNOT read
  // the libraries table. If RLS is off, nothing else goes wrong: the app works perfectly while
  // being completely open.
  SUPABASE_URL: 'https://uyrmizmgnqwkdofhbbqi.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_vf3APcaAD5A5mhk3IKbmuA_I-IhIjkW',
};
