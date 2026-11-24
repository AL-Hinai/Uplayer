'use strict';

// The Supabase client, with no network. Four behaviours carry real weight here, and three of
// them only ever show up on a bad day:
//
//   1. A lost compare-and-swap must be visible. PostgREST answers a PATCH that matched nothing
//      with 200 and an empty array, NOT an error — so a client that only checks the status
//      reports a successful upload that never happened, and the sync engine then advances its
//      watermark past changes it never sent.
//   2. An expired access token must refresh itself. Tokens last an hour, the sync loop runs for
//      days, and without this the app would ask for a password every hour.
//   3. A refresh token that no longer works must END the session rather than retry forever.
//   4. Signing up into a project that requires email confirmation is neither success nor
//      failure, and reporting it as either leaves the person stuck.

const assert = require('assert');
const { createSupabaseClient, _internals } = require('../core/supabase-client');

const PROJECT = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' };
const SESSION = { accessToken: 'access-1', refreshToken: 'refresh-1', userId: 'usr-1', email: 'a@b.c' };

/**
 * Replaces the transport, recording every request. Each entry in `answers` is matched in order
 * against the requests made; anything unmatched is a test bug and throws rather than silently
 * returning a 200.
 */
function withTransport(client, answers) {
  const sent = [];
  let i = 0;
  client._request = async (method, path, options) => {
    sent.push({ method, path, body: (options || {}).body, headers: (options || {}).headers || {} });
    if (i >= answers.length) throw new Error('unexpected extra request: ' + method + ' ' + path);
    const answer = answers[i];
    i += 1;
    return typeof answer === 'function' ? answer({ method, path, options }) : answer;
  };
  return sent;
}

function signedIn(onSession) {
  return createSupabaseClient({ ...PROJECT, session: { ...SESSION }, onSession });
}

async function testALostUploadRaceIsNotReportedAsSuccess() {
  const client = signedIn();
  // 200 with an empty array: the version filter matched no row, so another device won.
  withTransport(client, [{ status: 200, body: [] }]);

  const applied = await client.updateLibrary('usr-1', '{}', 7);
  assert.strictEqual(applied, false,
    'an empty 200 means the compare-and-swap lost - reporting true would advance the sync watermark past changes that were never uploaded');
}

async function testAWonUploadRaceIsReportedAsSuccess() {
  const client = signedIn();
  const sent = withTransport(client, [{ status: 200, body: [{ user_id: 'usr-1', version: 8 }] }]);

  assert.strictEqual(await client.updateLibrary('usr-1', '{"a":1}', 7), true);
  assert.ok(/version=eq\.7/.test(sent[0].path), 'the version it read has to be in the filter, or there is no race protection at all');
  assert.strictEqual(sent[0].body.version, 8, 'and the write bumps it by exactly one');
  assert.strictEqual(sent[0].headers.Prefer, 'return=representation',
    'without return=representation PostgREST reports nothing back and a lost race is invisible');
}

async function testInsertYieldsWhenAnotherDeviceGotThereFirst() {
  const client = signedIn();
  withTransport(client, [{ status: 409, body: { message: 'duplicate key value' } }]);
  assert.strictEqual(await client.insertLibrary('usr-1', '{}'), false,
    'a primary-key conflict is an ordinary outcome, not an error: the caller re-reads and updates');
}

async function testAnExpiredTokenRefreshesItselfAndRetriesOnce() {
  const saved = [];
  const client = signedIn((s) => saved.push(s));
  const sent = withTransport(client, [
    { status: 401, body: { msg: 'JWT expired' } },
    { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, user: { id: 'usr-1' } } },
    { status: 200, body: [{ version: 4 }] },
  ]);

  assert.strictEqual(await client.readVersion('usr-1'), 4);
  assert.strictEqual(sent.length, 3, 'expired request, refresh, retry');
  assert.ok(/grant_type=refresh_token/.test(sent[1].path));
  assert.strictEqual(sent[2].headers.Authorization, 'Bearer access-2', 'the retry must carry the NEW token');
  assert.strictEqual(saved.length, 1, 'and the refreshed session has to be handed back for persisting');
  assert.strictEqual(saved[0].accessToken, 'access-2',
    'otherwise every restart lands on a dead token and asks for the password again');
}

async function testOneRefreshOnly() {
  const client = signedIn();
  // A project that answers 401 even to a freshly refreshed token must not loop forever.
  const sent = withTransport(client, [
    { status: 401, body: {} },
    { status: 200, body: { access_token: 'access-2', refresh_token: 'r', expires_in: 3600, user: { id: 'usr-1' } } },
    { status: 401, body: {} },
  ]);

  await assert.rejects(() => client.readVersion('usr-1'), /Could not read the library/);
  assert.strictEqual(sent.length, 3, 'exactly one refresh-and-retry, then give up');
}

// --- staying signed in ---------------------------------------------------------------
// Signing in is meant to happen ONCE. Every test below is a way the old code would have ended
// a session that was perfectly good, leaving someone to hunt for a password because their
// train went into a tunnel.

async function testBeingOfflineDoesNotSignYouOut() {
  const saved = [];
  const client = signedIn((s) => saved.push(s));
  client._request = async () => { throw new Error('getaddrinfo ENOTFOUND'); };

  await assert.rejects(() => client.refreshSession(), /Could not reach the server/);
  assert.strictEqual(client.isSignedIn(), true,
    'failing to ASK about the token teaches us nothing about it, so it must be kept');
  assert.deepStrictEqual(saved, [], 'and nothing should be written away');
}

async function testAServerHavingABadMinuteDoesNotSignYouOut() {
  for (const status of [429, 500, 502, 503]) {
    const client = signedIn();
    withTransport(client, [{ status, body: { msg: 'try again later' } }]);
    await assert.rejects(() => client.refreshSession(), (err) => {
      assert.strictEqual(err.retryable, true, 'status ' + status + ' is temporary by nature');
      return true;
    });
    assert.strictEqual(client.isSignedIn(), true, 'status ' + status + ' must not end the session');
  }
}

async function testAnUnrecognisedFailureIsTreatedAsTemporary() {
  // The safe default. Being wrong this way costs one retry; being wrong the other way costs
  // somebody their session for no reason at all.
  const client = signedIn();
  withTransport(client, [{ status: 400, body: { msg: 'something nobody has seen before' } }]);
  await assert.rejects(() => client.refreshSession());
  assert.strictEqual(client.isSignedIn(), true);
}

async function testTwoRefreshesAtOnceOnlyAskOnce() {
  // Refresh tokens are single-use: Supabase invalidates the old one as it issues the new. Two
  // in flight would destroy each other's token and end the session permanently.
  const client = signedIn();
  let calls = 0;
  client._request = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 10));
    return {
      status: 200,
      body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, user: { id: 'usr-1' } },
    };
  };

  const [one, two] = await Promise.all([client.refreshSession(), client.refreshSession()]);
  assert.strictEqual(calls, 1, 'both callers must wait on the SAME request');
  assert.strictEqual(one.accessToken, 'a2');
  assert.strictEqual(two.accessToken, 'a2');
}

async function testAStaleTokenIsRefreshedBeforeItIsUsed() {
  // What every restart after an hour looks like. Sending the known-expired token first would
  // spend a round trip to be told what the expiry already said.
  const client = createSupabaseClient({
    ...PROJECT,
    session: { ...SESSION, expiresAt: Date.now() - 1000 },
  });
  const sent = withTransport(client, [
    { status: 200, body: { access_token: 'fresh', refresh_token: 'r2', expires_in: 3600, user: { id: 'usr-1' } } },
    { status: 200, body: [{ version: 9 }] },
  ]);

  assert.strictEqual(await client.readVersion('usr-1'), 9);
  assert.ok(/grant_type=refresh_token/.test(sent[0].path), 'the refresh comes FIRST');
  assert.strictEqual(sent[1].headers.Authorization, 'Bearer fresh');
  assert.strictEqual(sent.length, 2, 'and no doomed request is sent before it');
}

async function testATokenThatCannotBeSavedIsNotAdopted() {
  // The failure that quietly destroys a session. Supabase invalidates the old refresh token as
  // it issues the new one, so if the new one reaches memory but not disk, every later refresh
  // puts disk one more generation behind — and a token more than one generation stale is read
  // as a stolen-token replay, which terminates the whole session.
  //
  // Keeping the old token instead is safe: it is the PARENT of the active one, and Supabase
  // answers a parent token with the active session rather than an error. So the next refresh
  // recovers as soon as the disk is writable.
  const client = createSupabaseClient({
    ...PROJECT,
    session: { ...SESSION },
    onSession: () => false, // read-only config file
  });
  withTransport(client, [{
    status: 200,
    body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, user: { id: 'usr-1' } },
  }]);

  await assert.rejects(() => client.refreshSession(), (err) => {
    assert.strictEqual(err.retryable, true, 'a disk that is full now may not be later');
    return /could not be saved/i.test(err.message);
  });
  assert.strictEqual(client.isSignedIn(), true, 'still signed in - nothing was lost');
  assert.strictEqual(client.session.refreshToken, SESSION.refreshToken,
    'and still holding the token that IS on disk, so memory and disk cannot drift apart');
}

async function testASavedTokenIsAdopted() {
  // The ordinary path, pinned alongside the one above so the guard cannot be "fixed" by
  // making it always refuse.
  const client = createSupabaseClient({
    ...PROJECT,
    session: { ...SESSION },
    onSession: () => ({ saved: true }),
  });
  withTransport(client, [{
    status: 200,
    body: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, user: { id: 'usr-1' } },
  }]);

  const session = await client.refreshSession();
  assert.strictEqual(session.refreshToken, 'new-refresh');
  assert.strictEqual(client.session.accessToken, 'new-access',
    'anything other than an explicit false means it was saved');
}

async function testADeadRefreshTokenEndsTheSession() {
  const saved = [];
  const client = signedIn((s) => saved.push(s));
  withTransport(client, [
    { status: 401, body: {} },
    { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh Token Not Found' } },
  ]);

  await assert.rejects(() => client.readVersion('usr-1'), /Refresh Token Not Found/);
  assert.strictEqual(client.isSignedIn(), false,
    'this is the ONE failure that genuinely ends a session: Supabase said the token is gone, not that it could not be reached');
  assert.deepStrictEqual(saved, [null],
    'and the caller is told to clear it, so the UI shows a sign-in form instead of retrying forever');
}

async function testSignUpAwaitingConfirmationIsNeitherSuccessNorFailure() {
  const client = createSupabaseClient({ ...PROJECT });
  // Supabase's default: the user is created, but no session comes back until they click the
  // link in the email.
  withTransport(client, [{ status: 200, body: { id: 'usr-9', email: 'a@b.c' } }]);

  const result = await client.signUp('a@b.c', 'hunter2hunter2');
  assert.strictEqual(result.needsConfirmation, true);
  assert.strictEqual(result.session, null);
  assert.strictEqual(client.isSignedIn(), false,
    'claiming to be signed in here would send the sync loop off with no token at all');
}

async function testConfirmingWithACodeSignsYouIn() {
  // The whole point of the code flow: one step, not two. If verify returned something that was
  // not a session, the UI would have to send the person back to a password form they have
  // already filled in once.
  const saved = [];
  const client = createSupabaseClient({ ...PROJECT, onSession: (s) => saved.push(s) });
  const sent = withTransport(client, [{
    status: 200,
    body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'usr-7', email: 'a@b.c' } },
  }]);

  const session = await client.verifyOtp('a@b.c', '123456');
  assert.strictEqual(session.userId, 'usr-7');
  assert.strictEqual(client.isSignedIn(), true, 'confirming a code must also sign you in');
  assert.strictEqual(saved.length, 1, 'and the session has to be persisted like any other');
  assert.strictEqual(sent[0].path, '/auth/v1/verify');
  assert.deepStrictEqual(sent[0].body, { type: 'email', email: 'a@b.c', token: '123456' });
}

async function testAWrongCodeStaysAmbiguous() {
  const client = createSupabaseClient({ ...PROJECT });
  // The real body from a live project, for a code that is wrong or stale.
  withTransport(client, [{
    status: 403,
    body: { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' },
  }]);

  await assert.rejects(() => client.verifyOtp('a@b.c', '000000'), /has expired or is invalid/,
    'wrong and expired are deliberately one message - telling them apart would say which codes had once been real');
  assert.strictEqual(client.isSignedIn(), false);
}

async function testResendDoesNotRevealWhetherAnAccountExists() {
  const client = createSupabaseClient({ ...PROJECT });
  // A live project answers 200 with an empty body for an address that has no account at all.
  const sent = withTransport(client, [{ status: 200, body: {} }]);

  assert.strictEqual(await client.resendConfirmation('nobody@example.invalid'), true,
    'answering differently for an unknown address would turn this into a way to enumerate users');
  assert.strictEqual(sent[0].path, '/auth/v1/resend');
  assert.deepStrictEqual(sent[0].body, { type: 'signup', email: 'nobody@example.invalid' });
}

async function testResendSurfacesTheRateLimit() {
  const client = createSupabaseClient({ ...PROJECT });
  withTransport(client, [{
    status: 429,
    body: { msg: 'For security purposes, you can only request this after 48 seconds.' },
  }]);
  await assert.rejects(() => client.resendConfirmation('a@b.c'), /48 seconds/,
    'swallowing this leaves someone pressing a button that appears to do nothing');
}

async function testASignInCodeNeverCreatesAnAccount() {
  const client = createSupabaseClient({ ...PROJECT });
  const sent = withTransport(client, [{ status: 200, body: {} }]);

  await client.sendSignInCode('a@b.c');
  assert.strictEqual(sent[0].path, '/auth/v1/otp');
  assert.strictEqual(sent[0].body.create_user, false,
    'without this, "I forgot my password" typed with a typo SIGNS UP the typo as a new account');
}

async function testAnUnknownAddressIsDistinguishableOnlyToTheServer() {
  const client = createSupabaseClient({ ...PROJECT });
  // The real body from a live project for an address with no account, given create_user:false.
  withTransport(client, [{
    status: 422,
    body: { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' },
  }]);

  await assert.rejects(
    () => client.sendSignInCode('nobody@example.invalid'),
    (err) => {
      assert.strictEqual(err.code, 'otp_disabled',
        'the route flattens this into a success, so it has to recognise it by code, not by prose');
      return true;
    }
  );
}

async function testRecoveryCodeUsesTheMagiclinkType() {
  // The code arrives from /auth/v1/otp, so it verifies as 'magiclink'. Sending 'recovery' here
  // would verify nothing, and the reset would fail claiming the code was wrong.
  const client = createSupabaseClient({ ...PROJECT });
  const sent = withTransport(client, [{
    status: 200,
    body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'usr-3', email: 'a@b.c' } },
  }]);

  await client.verifyOtp('a@b.c', '654321', 'magiclink');
  assert.deepStrictEqual(sent[0].body, { type: 'magiclink', email: 'a@b.c', token: '654321' });
  assert.strictEqual(client.isSignedIn(), true,
    'the code returns a real session - that is what lets the new password be written at all');
}

async function testTheNewPasswordIsWrittenWithThatSession() {
  const client = signedIn();
  const sent = withTransport(client, [{ status: 200, body: { id: 'usr-1', email: 'a@b.c' } }]);

  assert.strictEqual(await client.updatePassword('a-new-password'), true);
  assert.strictEqual(sent[0].method, 'PUT');
  assert.strictEqual(sent[0].path, '/auth/v1/user');
  assert.deepStrictEqual(sent[0].body, { password: 'a-new-password' });
  assert.strictEqual(sent[0].headers.Authorization, 'Bearer access-1',
    'the endpoint identifies the account from the session alone, so the bearer is the whole authorisation');
}

async function testARejectedPasswordSurfacesTheReason() {
  const client = signedIn();
  withTransport(client, [{
    status: 422,
    body: { msg: 'Password should be at least 6 characters.' },
  }]);
  await assert.rejects(() => client.updatePassword('x'), /at least 6 characters/,
    'the server owns the password rules; repeating them in the client only creates a second opinion to disagree with');
}

async function testSignInStoresTheSession() {
  const saved = [];
  const client = createSupabaseClient({ ...PROJECT, onSession: (s) => saved.push(s) });
  withTransport(client, [{
    status: 200,
    body: { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'usr-5', email: 'a@b.c' } },
  }]);

  const session = await client.signIn('a@b.c', 'pw');
  assert.strictEqual(session.userId, 'usr-5');
  assert.strictEqual(client.isSignedIn(), true);
  assert.strictEqual(saved.length, 1);
}

async function testAWrongPasswordReachesThePersonAsWords() {
  const client = createSupabaseClient({ ...PROJECT });
  withTransport(client, [{ status: 400, body: { error_description: 'Invalid login credentials' } }]);
  await assert.rejects(() => client.signIn('a@b.c', 'wrong'), /Invalid login credentials/);
}

async function testSigningOutWorksOffline() {
  const saved = [];
  const client = signedIn((s) => saved.push(s));
  client._request = async () => { throw new Error('getaddrinfo ENOTFOUND'); };

  await client.signOut();
  assert.strictEqual(client.isSignedIn(), false,
    'a failed network call must not trap someone in an account they can no longer reach');
  assert.deepStrictEqual(saved, [null]);
}

function testTheKeyTravelsAsApikeyAndNothingElseLeaks() {
  // Not a transport test: this pins the shape _sessionFrom hands onward, since it is what gets
  // written to the config store.
  const session = _internals.sessionFrom({
    access_token: 'a', refresh_token: 'r', expires_in: 60, user: { id: 'u', email: 'e@f.g' },
  });
  assert.deepStrictEqual(Object.keys(session).sort(),
    ['accessToken', 'email', 'expiresAt', 'refreshToken', 'userId']);
  assert.ok(session.expiresAt > Date.now(), 'expiry is absolute, because it is read back hours later');
}

async function main() {
  await testALostUploadRaceIsNotReportedAsSuccess();
  await testAWonUploadRaceIsReportedAsSuccess();
  await testInsertYieldsWhenAnotherDeviceGotThereFirst();
  await testAnExpiredTokenRefreshesItselfAndRetriesOnce();
  await testOneRefreshOnly();
  await testBeingOfflineDoesNotSignYouOut();
  await testAServerHavingABadMinuteDoesNotSignYouOut();
  await testAnUnrecognisedFailureIsTreatedAsTemporary();
  await testTwoRefreshesAtOnceOnlyAskOnce();
  await testAStaleTokenIsRefreshedBeforeItIsUsed();
  await testATokenThatCannotBeSavedIsNotAdopted();
  await testASavedTokenIsAdopted();
  await testADeadRefreshTokenEndsTheSession();
  await testSignUpAwaitingConfirmationIsNeitherSuccessNorFailure();
  await testConfirmingWithACodeSignsYouIn();
  await testAWrongCodeStaysAmbiguous();
  await testResendDoesNotRevealWhetherAnAccountExists();
  await testResendSurfacesTheRateLimit();
  await testASignInCodeNeverCreatesAnAccount();
  await testAnUnknownAddressIsDistinguishableOnlyToTheServer();
  await testRecoveryCodeUsesTheMagiclinkType();
  await testTheNewPasswordIsWrittenWithThatSession();
  await testARejectedPasswordSurfacesTheReason();
  await testSignInStoresTheSession();
  await testAWrongPasswordReachesThePersonAsWords();
  await testSigningOutWorksOffline();
  testTheKeyTravelsAsApikeyAndNothingElseLeaks();
  console.log('supabase-client.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
