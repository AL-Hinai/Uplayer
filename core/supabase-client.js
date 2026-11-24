'use strict';

// Talking to Supabase over its REST APIs with nothing but the https module: GoTrue for
// accounts (/auth/v1) and PostgREST for the library row (/rest/v1).
//
// It exists because the account model finally needs an authority that is not this process.
// With a database token, whoever holds the binary holds the database, so a password could only
// ever be a UI formality — routes/account.js said as much in its own header. Supabase inverts
// that: the key compiled into the app is PUBLISHABLE and grants nothing on its own, and Row
// Level Security in Postgres decides what each request may touch. The boundary moves to a
// place the user cannot reach around, which is the entire point of the change.
//
// Why raw https rather than @supabase/supabase-js: this app ships through pkg as three OS
// binaries and runs on nodejs-mobile for Android. A dependency tree with native pieces in it
// survives neither reliably, and both APIs here are plain JSON over HTTPS, so nothing is given
// up by calling them directly. (The Turso client this replaced was raw for the same reason.)
//
// Deliberately excluded:
//   - Realtime, storage, edge functions. The library is one row, polled; a socket would be a
//     second failure mode for no gain.
//   - Any service_role or secret key. One of those in a client binary would undo the whole
//     reason for this file. If something later needs one, it belongs on a server, not here.
//   - Password rules. Supabase enforces its own minimum, and a second opinion in the client
//     would only disagree with the server at the worst possible moment.
//
// IO: outbound HTTPS only. No files, no timers. The caller owns scheduling, and the caller
// owns persisting a refreshed session (see onSession).

const https = require('https');
const { URL } = require('url');

// GoTrue access tokens are short-lived (an hour by default) while a sync loop runs for days.
// Rather than make every caller think about that, a 401 triggers one refresh-and-retry here.
// The refreshed session reaches the caller through onSession so it can be written to disk —
// losing it would mean asking the person to sign in again every hour.
const REFRESHABLE_STATUS = 401;

class SupabaseClient {
  /**
   * @param {object} options
   * @param {string} options.url             https://<project>.supabase.co
   * @param {string} options.publishableKey  safe to ship; RLS is what protects the data
   * @param {object} [options.session]       {accessToken, refreshToken, userId}
   * @param {function} [options.onSession]   called with the new session after a refresh, and
   *                                         with null when the session can no longer be used.
   *                                         Returns false if it could not persist the session;
   *                                         refreshSession treats that as a failed refresh and
   *                                         keeps the previous token, which is what stops
   *                                         memory and disk drifting apart.
   */
  constructor({ url, publishableKey, session, onSession } = {}) {
    this.url = String(url || '').trim().replace(/\/+$/, '');
    this.publishableKey = String(publishableKey || '').trim();
    this.session = session || null;
    this.onSession = typeof onSession === 'function' ? onSession : () => {};
    // The single in-flight refresh. See refreshSession for why there can only ever be one.
    this._refreshing = null;
  }

  isConfigured() {
    return !!(this.url && this.publishableKey);
  }

  isSignedIn() {
    return !!(this.session && this.session.accessToken && this.session.userId);
  }

  get userId() {
    return this.session ? this.session.userId : null;
  }

  // --- transport ------------------------------------------------------------------------

  /**
   * One request. Resolves with {status, body} rather than throwing on a non-2xx, because
   * several callers need to read the status themselves: a lost compare-and-swap is an empty
   * 200, an expired token is a 401, and a wrong password is a 400 whose message has to reach
   * the person as words.
   */
  _request(method, pathAndQuery, options) {
    const opts = options || {};
    if (!this.isConfigured()) {
      return Promise.reject(new Error('Cloud sync is not configured'));
    }
    const target = new URL(this.url + pathAndQuery);
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);

    const headers = Object.assign(
      {
        apikey: this.publishableKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
      opts.headers || {}
    );

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: target.hostname,
          // Honour an explicit port. A self-hosted Supabase behind one would otherwise fail as
          // an unresolvable host, which reads like a typo in the URL.
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          headers,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            if (text) {
              try { parsed = JSON.parse(text); } catch (e) { parsed = { raw: text }; }
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** An authenticated request, refreshing the session once if the token has expired. */
  async _authed(method, pathAndQuery, options, retrying) {
    const opts = options || {};
    if (!this.isSignedIn()) throw new Error('Not signed in');

    // Refresh up front when the stored token is already past its expiry — which it always is
    // after the app has been closed for an hour. Sending it anyway would spend a round trip to
    // be told what we already knew, and on a flaky connection that is a failure for nothing.
    if (!retrying && this.session.expiresAt && Date.now() >= this.session.expiresAt
      && this.session.refreshToken) {
      await this.refreshSession();
      if (!this.isSignedIn()) throw new Error('Not signed in');
    }

    const headers = Object.assign(
      { Authorization: 'Bearer ' + this.session.accessToken },
      opts.headers || {}
    );
    const res = await this._request(method, pathAndQuery, Object.assign({}, opts, { headers }));

    if (res.status === REFRESHABLE_STATUS && !retrying && this.session && this.session.refreshToken) {
      await this.refreshSession();
      return this._authed(method, pathAndQuery, opts, true);
    }
    return res;
  }

  /** Flattens GoTrue's several error shapes into one sentence worth showing someone. */
  static _authError(res, fallback) {
    const body = (res && res.body) || {};
    const err = new Error(
      body.error_description || body.msg || body.message || body.error || fallback
    );
    // Kept alongside the message because one caller has to branch on WHICH failure this was
    // without matching on English prose: /api/account/reset must answer identically whether or
    // not the address has an account, so it needs to recognise `otp_disabled` precisely.
    err.code = body.error_code || null;
    err.status = res ? res.status : 0;
    return err;
  }

  static _sessionFrom(body) {
    if (!body || !body.access_token) return null;
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || '',
      userId: body.user ? body.user.id : (body.id || ''),
      email: body.user ? body.user.email : '',
      // Absolute, not a duration: a duration is only meaningful at the instant it was issued,
      // and this gets written to disk and read back hours later.
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
  }

  // --- accounts -------------------------------------------------------------------------

  /**
   * Create an account. Returns {session, needsConfirmation}.
   *
   * `needsConfirmation` is the case that would otherwise look like a silent failure: with
   * email confirmation switched on (the Supabase default) signup succeeds, returns a user and
   * NO session, and the person is left looking at a form that appears to have done nothing.
   * The caller has to say "check your email" instead of "signed in".
   */
  async signUp(email, password) {
    const res = await this._request('POST', '/auth/v1/signup', {
      body: { email: String(email || '').trim(), password: String(password || '') },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not create the account');

    const session = SupabaseClient._sessionFrom(res.body);
    if (session) {
      this.session = session;
      this.onSession(session);
    }
    return { session, needsConfirmation: !session };
  }

  async signIn(email, password) {
    const res = await this._request('POST', '/auth/v1/token?grant_type=password', {
      body: { email: String(email || '').trim(), password: String(password || '') },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Email or password is wrong');

    const session = SupabaseClient._sessionFrom(res.body);
    if (!session) throw new Error('Sign in did not return a session');
    this.session = session;
    this.onSession(session);
    return session;
  }

  /**
   * Finish a sign-up with the 6-digit code from the confirmation email, and sign in.
   *
   * This exists because the link in a confirmation email is useless to a desktop app. That
   * link sends the browser to the project's Site URL, which for an app running on someone's
   * own machine is http://localhost:<whatever port they happen to use> — wrong on a phone
   * always, and wrong on a PC unless Uplayer is running at that exact moment. A code the
   * person reads out of their inbox and types here needs no address to exist at all.
   *
   * Supabase documents this as the alternative to the link; the email template supplies
   * {{ .Token }} instead of {{ .ConfirmationURL }}. The verify call returns a full session, so
   * confirming and signing in are the same step — which is also why there is no separate
   * "now sign in" prompt afterwards.
   */
  async verifyOtp(email, token, type) {
    const res = await this._request('POST', '/auth/v1/verify', {
      body: {
        // 'email' confirms a sign-up ('signup' is accepted too, but 'email' is what Supabase's
        // own docs use); 'recovery' is the same mechanism for a forgotten password. Both
        // return a real session, which is what makes the password reset below possible at all.
        type: type || 'email',
        email: String(email || '').trim(),
        token: String(token || '').trim(),
      },
    });
    if (res.status >= 400) {
      // The real error_code from a wrong or stale code is `otp_expired`, whose message reads
      // "Token has expired or is invalid" — ambiguous on purpose, because distinguishing the
      // two would tell an attacker which codes had once been real.
      throw SupabaseClient._authError(res, 'That code is wrong or has expired');
    }

    const session = SupabaseClient._sessionFrom(res.body);
    if (!session) throw new Error('Confirmation did not return a session');
    this.session = session;
    this.onSession(session);
    return session;
  }

  /**
   * Send the confirmation code again. Answers 200 whether or not the address has an account,
   * which is deliberate on Supabase's part and worth preserving: a resend endpoint that said
   * "no such user" would be a way to enumerate who has signed up.
   *
   * Supabase rate-limits this to once every 60 seconds by default, and that refusal arrives
   * here as an error the caller should show rather than swallow.
   */
  async resendConfirmation(email) {
    const res = await this._request('POST', '/auth/v1/resend', {
      body: { type: 'signup', email: String(email || '').trim() },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not send another code');
    return true;
  }

  /**
   * Trade the refresh token for a new session. Signing in is meant to happen ONCE, so the only
   * thing in this class that may end a session is this method deciding the refresh token is
   * genuinely dead — and it is deliberately reluctant to decide that.
   *
   * The distinction it draws is the whole point:
   *
   *   - The request never reached Supabase (offline, DNS, timeout), or came back 429 or 5xx →
   *     the token is probably fine, we simply could not ask. KEEP the session and let the
   *     caller retry; the sync loop already backs off and tries again forever.
   *   - Supabase answered that the token is invalid or already used → it will never work
   *     again. Only now clear the session, so the UI stops retrying and asks for a password.
   *
   * Getting this wrong in the obvious direction — treating every failure as "signed out" —
   * means a laptop opened on a train, or a project having a bad minute, silently logs someone
   * out of an account they will then have to find the password for.
   */
  async refreshSession() {
    // Refresh tokens are single-use: Supabase invalidates the old one as it issues the new.
    // Two refreshes racing would therefore destroy each other's token and end the session for
    // good, so everyone waits on the same request.
    if (this._refreshing) return this._refreshing;

    this._refreshing = this._doRefresh().finally(() => { this._refreshing = null; });
    return this._refreshing;
  }

  async _doRefresh() {
    const token = this.session && this.session.refreshToken;
    if (!token) throw new Error('Session expired. Sign in again.');

    let res;
    try {
      res = await this._request('POST', '/auth/v1/token?grant_type=refresh_token', {
        body: { refresh_token: token },
      });
    } catch (e) {
      // Never reached the server. Nothing has been learned about the token, so nothing is
      // thrown away: the next attempt, in five minutes or next week, uses it again.
      const err = new Error('Could not reach the server to refresh the session: ' + e.message);
      err.retryable = true;
      throw err;
    }

    if (res.status >= 400) {
      const err = SupabaseClient._authError(res, 'Session expired. Sign in again.');
      if (SupabaseClient._isDeadToken(res)) {
        // Unrecoverable. Clearing is what lets the UI show a sign-in form rather than retrying
        // a token that can never work.
        this.session = null;
        this.onSession(null);
        throw err;
      }
      // Rate limited, or the service is unwell. The session stays exactly as it was.
      err.retryable = true;
      throw err;
    }

    const session = SupabaseClient._sessionFrom(res.body);
    if (!session) {
      const err = new Error('Session refresh did not return a session');
      err.retryable = true;
      throw err;
    }

    // Persist BEFORE adopting, and refuse to adopt a token that did not reach disk.
    //
    // Supabase issues a new refresh token on every use and invalidates the old, so memory and
    // disk must never drift apart. If they do — a read-only config file, a full disk — then
    // each refresh puts disk one generation further behind, and Supabase treats a token that
    // is more than one generation stale as a stolen-token replay and TERMINATES THE WHOLE
    // SESSION. The thing we were trying to avoid, caused by trying to avoid it.
    //
    // Keeping the old session instead is safe because of Supabase's parent-token rule: using
    // the parent of the currently active token returns the active token rather than failing.
    // The token still on disk is exactly that parent, so the next refresh recovers the session
    // the moment the disk is writable again, however long that takes.
    if (this.onSession(session) === false) {
      const err = new Error('Signed in, but the session could not be saved to this device');
      err.retryable = true;
      throw err;
    }

    this.session = session;
    return session;
  }

  /**
   * Did Supabase say this refresh token is finished, as opposed to failing to answer?
   *
   * Matched on the error code rather than the status, because 400 covers both "that token is
   * nonsense" and a handful of transient complaints. Anything not recognised is treated as
   * temporary — the cost of being wrong that way is one more retry, while the other way is a
   * person logged out of an account for no reason.
   */
  static _isDeadToken(res) {
    const body = (res && res.body) || {};
    const code = String(body.error_code || body.error || '');
    const message = String(body.msg || body.message || body.error_description || '');
    return /invalid_grant|refresh_token_not_found|refresh_token_already_used|bad_jwt|session_not_found|user_not_found/i.test(code)
      || /refresh token not found|invalid refresh token|already used|user from sub claim.*does not exist/i.test(message);
  }

  /** Best-effort: the local session is dropped whether or not the server agrees. */
  async signOut() {
    try {
      if (this.isSignedIn()) await this._authed('POST', '/auth/v1/logout');
    } catch (e) {
      // Signing out while offline still has to work, or the app traps someone in an account
      // it can no longer reach.
    }
    this.session = null;
    this.onSession(null);
  }

  /**
   * Set a new password for whoever this client is currently signed in as.
   *
   * The reset flow leans on one fact: verifying a `recovery` code returns an ordinary session,
   * and a session is all this endpoint needs. So "forgot my password" is two calls, not a
   * special protocol — verify the code, then write the new password with the session it gave
   * you. The person ends up signed in, which is what they wanted anyway.
   *
   * Supabase enforces its own minimum length and rejects a password matching the current one;
   * both come back as messages worth showing rather than rules to duplicate here.
   */
  async updatePassword(password) {
    const res = await this._authed('PUT', '/auth/v1/user', {
      body: { password: String(password || '') },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not set that password');
    return true;
  }

  /**
   * Email a 6-digit sign-in code. This is how a forgotten password is recovered: sign in with
   * the code, then set a new password with the session it produces.
   *
   * Why not /auth/v1/recover, which exists for exactly this? Because the email it sends comes
   * from the "Reset password" template, and Supabase does NOT document {{ .Token }} as working
   * there — their own example for that template uses {{ .ConfirmationURL }}, which is the link
   * this app cannot use. {{ .Token }} IS documented for the Magic Link template, which is what
   * this endpoint sends. Choosing the documented path is the difference between a reset that
   * works and one that depends on undocumented behaviour not changing.
   *
   * `create_user: false` is not optional. Without it this endpoint SIGNS UP any address it is
   * given — so "I forgot my password" typed with a typo would silently create a second,
   * empty account rather than failing.
   */
  async sendSignInCode(email) {
    const res = await this._request('POST', '/auth/v1/otp', {
      body: { email: String(email || '').trim(), create_user: false },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not send a code');
    return true;
  }

  // --- the library row ------------------------------------------------------------------
  // Four calls, which is the entire interface core/cloud-sync.js needs. RLS already limits
  // every one of them to the caller's own row; the explicit user_id filter is there because
  // PostgREST needs something to target, not because it is the protection.

  async readVersion(userId) {
    const path = '/rest/v1/libraries?select=version&user_id=eq.' + encodeURIComponent(userId);
    const res = await this._authed('GET', path);
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not read the library');
    const rows = Array.isArray(res.body) ? res.body : [];
    return rows.length ? Number(rows[0].version) || 0 : 0;
  }

  async readLibrary(userId) {
    const path = '/rest/v1/libraries?select=json,version&user_id=eq.' + encodeURIComponent(userId);
    const res = await this._authed('GET', path);
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not read the library');
    const rows = Array.isArray(res.body) ? res.body : [];
    if (!rows.length) return null;
    return { json: rows[0].json, version: Number(rows[0].version) || 0 };
  }

  /** First upload. False when a row already exists, which sends the caller round to update. */
  async insertLibrary(userId, json) {
    const res = await this._authed('POST', '/rest/v1/libraries', {
      body: { user_id: userId, json, version: 1 },
      headers: { Prefer: 'return=representation' },
    });
    // 409 is the primary-key conflict: another device inserted first.
    if (res.status === 409) return false;
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not upload the library');
    return Array.isArray(res.body) ? res.body.length > 0 : true;
  }

  /**
   * Compare-and-swap. The version filter is what orders two devices writing at once: the loser
   * matches no rows, gets false back, and re-merges instead of overwriting the winner.
   */
  async updateLibrary(userId, json, expectedVersion) {
    const path = '/rest/v1/libraries?user_id=eq.' + encodeURIComponent(userId)
      + '&version=eq.' + Number(expectedVersion);
    const res = await this._authed('PATCH', path, {
      body: {
        json,
        version: Number(expectedVersion) + 1,
        updated_at: new Date().toISOString(),
      },
      headers: { Prefer: 'return=representation' },
    });
    if (res.status >= 400) throw SupabaseClient._authError(res, 'Could not upload the library');
    // return=representation is what makes "matched nothing" visible: PostgREST answers 200
    // with an empty array rather than an error, so without it a lost race would be
    // indistinguishable from a successful write.
    return Array.isArray(res.body) ? res.body.length > 0 : false;
  }
}

function createSupabaseClient(options) {
  return new SupabaseClient(options || {});
}

module.exports = {
  SupabaseClient,
  createSupabaseClient,
  // exposed for unit tests
  _internals: {
    sessionFrom: SupabaseClient._sessionFrom,
    authError: SupabaseClient._authError,
    REFRESHABLE_STATUS,
  },
};
