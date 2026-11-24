'use strict';

// Account routes — sign up, sign in, sign out, password reset, and the sync status the Settings
// panel shows. register(app, ctx) is the route-module contract: dependencies arrive in ctx
// (injected, per the core/ convention) instead of each handler reaching for a global.
//
// The sync engine is held at module level, like streamHub in core/stream-hub.js and for the
// same reason: there is exactly one signed-in account per process, and its background timer
// has to outlive any single request. Switching account rebuilds it.
//
// NOTHING HERE IS THE AUTHENTICATION BOUNDARY, and that is now a statement of design rather
// than an apology. These handlers run on the user's own machine, so any check they made would
// be a check the user could delete. The real boundary is Row Level Security in Postgres: the
// session token goes up with every request and the database decides what it may touch
// (scripts/supabase-schema.sql). What is left here is the part that genuinely belongs on this
// side — which files to open, when to sync, and refusing to switch account mid-stream.

const { createCloudSync } = require('../core/cloud-sync');
const {
  readActiveAccount,
  saveSession,
  clearActiveAccount,
  createConfiguredClient,
  describeCloudProject,
  createSyncMeta,
} = require('../core/account-session');

let syncEngine = null;

function stopSync() {
  if (syncEngine) syncEngine.stop();
  syncEngine = null;
}

/** Build (or rebuild) the engine around whichever account and stores are current. */
function startSync(ctx) {
  stopSync();
  const account = readActiveAccount();
  const client = createConfiguredClient();
  if (!account || !client || !client.isSignedIn()) return null;

  const services = ctx.getServices();
  syncEngine = createCloudSync({
    client,
    historyStore: services.historyStore,
    recommendationStore: services.recommendationStore,
    meta: createSyncMeta(account.id),
    userId: account.id,
    onEvent: (name, payload) => ctx.onSyncEvent && ctx.onSyncEvent(name, payload),
  });
  syncEngine.start();
  return syncEngine;
}

/**
 * Supabase refuses to send mail for two reasons that look alike to whoever pressed the button
 * and mean completely different things to whoever runs the project. Both get the same calm
 * message and a pointed warning in the server log.
 *
 * The built-in email service is capped at 2 messages per hour FOR THE WHOLE PROJECT, and it
 * delivers only to addresses on the project's team — Supabase documents it as not for
 * production use. So the second case below is not a passing inconvenience to retry around:
 * until custom SMTP is configured, no stranger can ever receive a code. Saying so in the log
 * is the only way that reaches anybody, because from the outside it is indistinguishable from
 * a slow inbox.
 */
function describeMailFailure(err) {
  const text = String((err && err.message) || '');
  const code = (err && err.code) || '';

  if (code === 'over_email_send_rate_limit' || /rate limit/i.test(text)) {
    return {
      // Says the wait is real and gives a length, because "try again later" with no number is
      // what makes people retry every ten seconds — which, on an hourly cap, only keeps it
      // exhausted. Deliberately vague about why: the cap is the operator's problem.
      user: 'Too many emails have been sent recently. Please wait up to an hour and try again — '
        + 'your current password still works in the meantime.',
      log: '[uplayer] Supabase refused to send: ' + text
        + ' — the built-in email service allows only 2 messages per hour for the whole project.'
        + ' Configure custom SMTP (Authentication > Emails > SMTP Settings) before real users'
        + ' depend on this.',
    };
  }
  if (code === 'email_address_not_authorized' || /not authorized/i.test(text)) {
    return {
      user: 'That address could not be emailed. Try again shortly.',
      log: '[uplayer] Supabase refused to send: ' + text
        + ' — without custom SMTP, Supabase only delivers to members of the project team, so NO'
        + ' outside user can sign up or reset a password. Configure custom SMTP.',
    };
  }
  return null;
}

function register(app, ctx) {
  const { resetServices, hasLiveStreams } = ctx;

  // Switch the app onto an account's files, then bring the sync loop up around them.
  function activate(session) {
    saveSession(session);
    resetServices();
    startSync(ctx);
  }

  function refuseIfStreaming() {
    if (hasLiveStreams && hasLiveStreams()) {
      return 'Stop playback before switching account';
    }
    return null;
  }

  app.get('/api/account', (req, res) => {
    const account = readActiveAccount();
    const project = describeCloudProject();
    const status = syncEngine ? syncEngine.status() : null;
    res.json({
      // Whether this build was given a Supabase project at all (core/system-config.js). When
      // it was not, the UI says sync is unavailable rather than offering a sign-in that can
      // only fail — there is nothing a user could do about it from here, by design.
      cloudConfigured: project.configured,
      // Not shown in the UI. Kept in the payload because "which project is this install
      // pointed at" is the first question any support conversation needs, and reading it from
      // the browser console beats shipping a debug build to find out.
      project: { host: project.host, source: project.source },
      signedIn: !!account,
      email: account ? account.email : null,
      lastSyncAt: status ? status.lastSyncAt : null,
      lastError: status ? status.lastError : null,
      pending: status ? status.pending : 0,
    });
  });

  app.post('/api/account/register', async (req, res) => {
    const streaming = refuseIfStreaming();
    if (streaming) return res.status(409).json({ error: streaming });

    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'An email address and a password are required' });
    }

    try {
      const { session, needsConfirmation } = await client.signUp(email, password);
      if (needsConfirmation) {
        // Not an error, and not a signed-in state either. Saying so is the whole point: the
        // form otherwise looks like it did nothing, and the person tries again and again.
        return res.json({ needsConfirmation: true, email });
      }
      activate(session);
      res.json({ email: session.email || email, signedIn: true });
    } catch (e) {
      const mail = describeMailFailure(e);
      if (mail) { console.warn(mail.log); return res.status(400).json({ error: mail.user }); }
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/account/login', async (req, res) => {
    const streaming = refuseIfStreaming();
    if (streaming) return res.status(409).json({ error: streaming });

    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'An email address and a password are required' });
    }

    try {
      const session = await client.signIn(email, password);
      activate(session);
      res.json({ email: session.email || email, signedIn: true });
    } catch (e) {
      // Supabase answers a wrong password and an unknown address with the same message, on
      // purpose — it is what stops this endpoint being used to find out who has an account.
      // Passing it through unchanged keeps that property.
      res.status(401).json({ error: e.message });
    }
  });

  // --- Finishing a sign-up ---------------------------------------------------------------
  // The confirmation email carries a 6-digit code rather than a link, because a link can only
  // send a browser to the project's Site URL and no such address exists for a desktop app
  // (SupabaseClient.verifyOtp says more). Verifying the code also signs the person in, so this
  // route activates the session exactly as login does.

  app.post('/api/account/confirm', async (req, res) => {
    const streaming = refuseIfStreaming();
    if (streaming) return res.status(409).json({ error: streaming });

    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ error: 'Enter the code from your email' });
    }

    try {
      const session = await client.verifyOtp(email, code);
      activate(session);
      res.json({ email: session.email || email, signedIn: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/account/resend', async (req, res) => {
    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'An email address is required' });

    try {
      await client.resendConfirmation(email);
      res.json({ ok: true });
    } catch (e) {
      // Usually the 60-second per-user limit, which is worth showing rather than hiding: the
      // alternative is someone pressing the button repeatedly and seeing nothing happen.
      const mail = describeMailFailure(e);
      if (mail) { console.warn(mail.log); return res.status(400).json({ error: mail.user }); }
      res.status(400).json({ error: e.message });
    }
  });

  // Finishing a password reset: the code from the email, plus the new password. Same reason as
  // the sign-up code — the link in a reset email points at the project's Site URL, and for a
  // desktop app that address is nobody's.
  //
  // Verifying a recovery code returns a real session, so this writes the new password with it
  // and leaves the person signed in. Two calls, and no window in between where the account has
  // no usable password.
  app.post('/api/account/reset/confirm', async (req, res) => {
    const streaming = refuseIfStreaming();
    if (streaming) return res.status(409).json({ error: streaming });

    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email, code, password } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'Enter the code from your email' });
    if (!password) return res.status(400).json({ error: 'Enter the new password you want' });

    try {
      // 'magiclink', matching the code sent by sendSignInCode. The code signs the person in;
      // the password change is what they actually came for.
      const session = await client.verifyOtp(email, code, 'magiclink');
      await client.updatePassword(password);
      // Only now: a session saved before the password change would survive a failure here and
      // leave the device signed in with the OLD password still in force, which is not what
      // anyone pressing this button is asking for.
      activate(session);
      res.json({ email: session.email || email, signedIn: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/account/logout', async (req, res) => {
    const streaming = refuseIfStreaming();
    if (streaming) return res.status(409).json({ error: streaming });

    stopSync();
    const client = createConfiguredClient();
    if (client) await client.signOut();
    clearActiveAccount();
    // Back to the signed-out files — the original single-user paths, untouched all along.
    resetServices();
    res.json({ ok: true });
  });

  app.post('/api/account/reset', async (req, res) => {
    const client = createConfiguredClient();
    if (!client) return res.status(400).json({ error: 'Cloud sync is not configured on this device' });

    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Enter your email address first' });

    try {
      await client.sendSignInCode(email);
      res.json({ ok: true });
    } catch (e) {
      // `otp_disabled` here means "no account for that address" — Supabase refuses to sign up
      // a new one because we passed create_user:false. Reporting it would turn this endpoint
      // into a way to find out who has an account, so the answer is the same either way.
      //
      // The same code ALSO appears when email OTP is switched off for the whole project, which
      // would break reset for everyone with no visible symptom. Hence the server-side warning:
      // invisible to the person asking, obvious to whoever runs the thing.
      if (e.code === 'otp_disabled') {
        console.warn('[uplayer] reset code not sent for one address (' + e.message
          + '). If NOBODY can reset, check Authentication > Providers > Email > Email OTP.');
        return res.json({ ok: true });
      }
      // A send that failed for a reason the person can act on — wait a few minutes — is worth
      // reporting, unlike the one above which they cannot tell apart from an unknown address.
      const mail = describeMailFailure(e);
      if (mail) { console.warn(mail.log); return res.status(400).json({ error: mail.user }); }
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/account/sync', async (req, res) => {
    if (!syncEngine) startSync(ctx);
    if (!syncEngine) return res.status(400).json({ error: 'Not signed in' });
    const result = await syncEngine.syncOnce();
    res.json(result);
  });
}

module.exports = {
  register,
  startSync,
  stopSync,
  // exposed for unit tests
  // exposed for unit tests
  _internals: { getEngine: () => syncEngine, describeMailFailure },
};
