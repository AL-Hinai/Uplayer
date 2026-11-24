'use strict';

// Two ways Supabase refuses to send mail, and why they must not be reported the same way to
// everyone.
//
// The built-in email service allows 2 messages per hour for the WHOLE project and delivers
// only to members of the project's team. Both refusals reach the app as an ordinary 4xx, and
// both look to the person pressing the button exactly like an inbox that is being slow. One of
// them is temporary. The other means no outside user can ever sign up, and will stay that way
// until somebody configures custom SMTP — which nobody will do if the app never says so.
//
// Hence: a calm, honest sentence for the person, and a warning in the server log that names
// the setting. These tests pin that split, because the easy mistake is to show the raw
// provider message to users (meaningless to them) or to swallow it (invisible to the operator).

const assert = require('assert');
const { _internals } = require('../routes/account');

const { describeMailFailure } = _internals;

function errorWith(message, code) {
  const err = new Error(message);
  err.code = code || null;
  return err;
}

function testTheHourlyCapIsReportedAsTemporary() {
  const result = describeMailFailure(errorWith('email rate limit exceeded', 'over_email_send_rate_limit'));
  assert.ok(result, 'this is the error the built-in service gives after two messages in an hour');
  assert.ok(/try again/i.test(result.user), 'to the person it is a wait, and the message should say so');
  assert.ok(/hour/i.test(result.user),
    'with a length: "try again later" and no number is what makes people retry every ten seconds, which on an hourly cap keeps it exhausted');
  assert.ok(!/SMTP/i.test(result.user), 'and should not lecture them about a setting only the operator can change');
  assert.ok(/2 messages per hour/.test(result.log), 'the log carries the number, since that is what explains it');
  assert.ok(/SMTP/.test(result.log), 'and names the fix');
}

function testItIsRecognisedByMessageAlone() {
  // The error_code is not always present, and matching only on it would let the raw provider
  // text reach the UI on any project that words it differently.
  const result = describeMailFailure(errorWith('email rate limit exceeded'));
  assert.ok(result, 'the message alone has to be enough');
  assert.ok(/try again/i.test(result.user));
}

function testTheTeamOnlyRestrictionIsReportedToTheOperator() {
  const result = describeMailFailure(errorWith('Email address not authorized', 'email_address_not_authorized'));
  assert.ok(result);
  assert.ok(/NO/.test(result.log) && /outside user/.test(result.log),
    'this one is not a hiccup: it means the app is unusable by anyone but the project team');
  assert.ok(/SMTP/.test(result.log));
  assert.ok(!/team/i.test(result.user),
    'the person signing up should not be told about the project team - it is not theirs to fix');
}

function testAnythingElseIsLeftAlone() {
  // A wrong password, an expired code, a malformed address: all have messages worth showing as
  // they are. Catching them here would replace a useful sentence with a vague one.
  assert.strictEqual(describeMailFailure(errorWith('Invalid login credentials')), null);
  assert.strictEqual(describeMailFailure(errorWith('Token has expired or is invalid', 'otp_expired')), null);
  assert.strictEqual(describeMailFailure(errorWith('Signups not allowed for otp', 'otp_disabled')), null);
  assert.strictEqual(describeMailFailure(null), null);
  assert.strictEqual(describeMailFailure(new Error('')), null);
}

function main() {
  testTheHourlyCapIsReportedAsTemporary();
  testItIsRecognisedByMessageAlone();
  testTheTeamOnlyRestrictionIsReportedToTheOperator();
  testAnythingElseIsLeftAlone();
  console.log('account-mail-failures.test.js passed');
}

main();
