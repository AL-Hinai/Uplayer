-- Uplayer cloud sync — Supabase schema.
--
-- Paste this whole file into your project's SQL editor (Supabase dashboard → SQL Editor →
-- New query → Run). It is idempotent: running it twice changes nothing.
--
-- WHY THIS FILE IS SHORT: a person's entire library is ONE row of JSON. The database never
-- parses a history entry, so it never has to learn about seasons, episodes, watchlists or
-- anything else the app grows later. The merge rules live on the device, in
-- core/history-merge.js, which is the only place that can see both copies at once.
--
-- WHY ROW LEVEL SECURITY IS THE WHOLE POINT: the key shipped inside the app is Supabase's
-- PUBLISHABLE key, and anyone can read it out of the binary. That is expected and documented
-- by Supabase. What stops one person reading another's library is the policy below, enforced
-- by Postgres on every request. If RLS is off, the publishable key reaches every row in this
-- table and there is no error anywhere to tell you — it simply works, for everyone, on
-- everyone's data. The verification block at the bottom is not optional reading.

-- ---------------------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------------------

create table if not exists public.libraries (
  -- Not just a foreign key: it is also the identity RLS compares against, and ON DELETE
  -- CASCADE is what makes "delete my account" actually delete the library with it.
  user_id    uuid primary key references auth.users (id) on delete cascade,

  -- {history, recommendations}, exactly as the local JSON stores hold them.
  json       text not null,

  -- Bumped on every write. An update naming the version it read is how two devices writing at
  -- once are ordered: the loser matches zero rows, re-reads, re-merges and retries, instead of
  -- silently overwriting the winner. core/cloud-sync.js depends on this being exact.
  version    bigint not null default 1,

  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------

alter table public.libraries enable row level security;

-- Belt and braces alongside the policy. A signed-out caller (the `anon` role, which is what
-- the publishable key alone gets you) has no business touching this table at all.
revoke all on public.libraries from anon;
grant select, insert, update, delete on public.libraries to authenticated;

drop policy if exists "own library only" on public.libraries;
create policy "own library only"
  on public.libraries
  for all
  to authenticated
  -- USING filters what you can see and change.
  using (auth.uid() = user_id)
  -- WITH CHECK is the half that is easy to forget, and the half that matters most here:
  -- without it, a signed-in person could INSERT a row carrying someone else's user_id, or
  -- UPDATE their own row to point at one. Both would write into another account's library.
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------------------
-- Verify it — run this, do not assume it
-- ---------------------------------------------------------------------------------------
--
-- 1. Confirm RLS is actually on. This must return true. If it returns false, every library in
--    the table is readable by anyone holding the publishable key, which is everyone.
--
--      select relrowsecurity from pg_class where oid = 'public.libraries'::regclass;
--
-- 2. Confirm the policy exists and covers all four commands:
--
--      select policyname, cmd, roles from pg_policies
--       where schemaname = 'public' and tablename = 'libraries';
--
-- 3. Confirm a DENIED request is denied. This is the test worth doing, because a permitted
--    request succeeding proves nothing about the boundary. As the anon role — what an
--    unauthenticated caller with the publishable key gets — selecting must return no rows:
--
--      set local role anon;
--      select count(*) from public.libraries;   -- expect 0 rows / permission denied
--      reset role;
--
--    tests/supabase-rls.test.js runs this same check over the REST API against a real project
--    when SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are set, and skips itself otherwise.

-- ---------------------------------------------------------------------------------------
-- The dashboard settings, which are not SQL
-- ---------------------------------------------------------------------------------------
--
-- Three settings, and the first one removes most of the work:
--
-- 1. Authentication → Providers → Email → "Confirm email": TURN IT OFF.
--
--    Creating an account then needs no email at all. Sign-up returns a session straight away:
--    type an address and a password, and you are in. Nothing to deliver, nothing to click,
--    nothing to wait for — which matters more here than anywhere, because of the sending
--    limits described below.
--
--    What you give up is proof that an address belongs to whoever typed it. Here that buys an
--    attacker nothing: the address is an account name, the library behind it starts empty, and
--    a password reset still requires access to the real inbox. Nothing is ever sent TO users,
--    so an unverified address costs nobody anything.
--
--    (The app still handles confirmation correctly if you ever switch it back on — sign-up
--    then shows a code screen rather than appearing to do nothing. That path is kept precisely
--    so flipping this setting cannot break sign-up silently.)
--
-- 2. Authentication → Emails → "Magic Link" template: send the CODE, not the link.
--
--        <h2>Your Uplayer code</h2>
--        <p>Enter this code in Uplayer:</p>
--        <p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
--        <p>The code expires in an hour. If you did not ask for it, ignore this email and
--           your password stays as it is.</p>
--
--    This is the only email the app sends now, and only for a forgotten password. It is the
--    Magic Link template rather than "Reset password" because Supabase documents {{ .Token }}
--    for this one and not for that one — see core/supabase-client.js sendSignInCode.
--
--    A link would be useless anyway: it points at the project's Site URL, which for a desktop
--    app is http://localhost:<some port>, an address that exists on nobody's phone and only
--    sometimes on their PC.
--
-- 3. Authentication → Sessions: leave "Time-box user sessions" and "Inactivity timeout" OFF.
--
--    They are off by default, and they should stay off. Signing in is meant to happen once per
--    device, for good. Either setting makes Supabase expire sessions server-side no matter what
--    the app does, and the person is simply logged out one day with no explanation — on a media
--    player, where the account exists only to sync a watch history, that is all cost and no
--    benefit. The app itself never ends a session except when you press Sign out, or when
--    Supabase states the refresh token is gone (core/supabase-client.js refreshSession).
--
-- 4. Authentication → Providers → Email → "Email OTP": make sure it is ENABLED.
--
--    Without it no code is ever sent, and the failure is invisible — the send endpoint answers
--    identically whether an address has no account or OTP is off for the whole project. The
--    server logs a warning naming this setting when it happens.

-- ---------------------------------------------------------------------------------------
-- The email limits you are living with, and what they mean
-- ---------------------------------------------------------------------------------------
--
-- With "Confirm email" off, the ONLY email this app sends is the password-reset code. That is
-- a deliberate trade, because the built-in email service Supabase provides is severely capped:
--
--   * TWO MESSAGES PER HOUR, for the entire project. Not per user, and not configurable.
--   * IT ONLY DELIVERS TO YOUR OWN TEAM. Supabase's words: "Supabase Auth will refuse to
--     deliver messages to addresses that are not part of the project's team."
--
-- Supabase states this service "is not meant for production use".
--
-- So, as configured today:
--
--   * Anyone can sign up and sync. That path touches no email, so no limit applies to it.
--   * Password reset works for YOU and for anyone else on the project team.
--   * Password reset does NOT work for anybody else. They will request a code, see the app
--     say it may take a few minutes, and wait for an email that is never sent. The app cannot
--     detect this — the send call succeeds.
--
-- That is an accepted limitation, not an oversight. The reset screen tells people the code can
-- take time and that only a few are sent each hour, and routes/account.js answers a refusal
-- with "wait up to an hour" rather than a raw provider error.
--
-- WHEN A FORGOTTEN PASSWORD STOPS BEING ACCEPTABLE, the fix is one setting, not a rewrite:
--
--   Authentication → Emails → SMTP Settings → configure a provider. Supabase names Resend,
--   AWS SES, Postmark, Twilio SendGrid, ZeptoMail and Brevo; several free tiers are far larger
--   than this app needs. Then Authentication → Rate Limits → raise the email limit from the
--   30/hour that custom SMTP starts at.
--
--   If the provider offers link tracking, turn it OFF — it rewrites URLs in outgoing mail.
--
-- Nothing in the application code changes when you do that. It is a dashboard setting, and
-- every flow here keeps working exactly as it does now, for everybody instead of for you.
