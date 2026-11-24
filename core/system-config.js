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
  //
  // LEFT BLANK ON PURPOSE IN THE REPOSITORY. This file is public, and while the publishable
  // key is safe to expose by design, the project URL beside it is an open invitation to create
  // accounts in somebody else's database. Day to day the values live in .env, which is
  // gitignored, and the precedence above means a blank here falls through to it.
  //
  // THE CONSEQUENCE FOR RELEASES, which is easy to forget until someone reports that sync has
  // vanished: a `pkg` binary bundles THIS FILE and cannot read a .env sitting next to the
  // executable. Blank here means a shipped build has no project and offers no sync at all.
  // Fill both in immediately before `npm run build`, and blank them again before committing.
  SUPABASE_URL: '',
  SUPABASE_PUBLISHABLE_KEY: '',
};
