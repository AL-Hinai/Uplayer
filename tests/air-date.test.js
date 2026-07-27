'use strict';

// Pins airDateStatus, which decides whether the season/episode picker offers an
// episode at all. Two things it must never get wrong:
//
//   1. A confirmed FUTURE date is 'upcoming' — the picker disables those, because
//      no scraper can find a release for an episode that has not aired.
//   2. A MISSING date is 'tba', not 'upcoming'. TMDB leaves air_date empty on
//      specials that already exist; collapsing blank into "future" would make
//      them unselectable with no way to override.
//
// Also covers the local-midnight parse. `new Date('2026-09-27')` is UTC midnight,
// which prints as "Sep 26" for anyone west of Greenwich — an episode showing a
// date one day before the one TMDB lists. Appending T00:00:00 forces local
// parsing; the assertions below compare against a locally-constructed date so
// they hold in any timezone.

const assert = require('assert');
const { airDateStatus } = require('../public/js/air-date.js');

const NOW = new Date(2026, 6, 27); // 2026-07-27, local midnight

function fmtLocal(y, m, d) {
  return new Date(y, m, d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function testReleased() {
  const a = airDateStatus('2025-09-28', NOW);
  assert.strictEqual(a.state, 'aired', 'a past date is released');
  assert.strictEqual(a.days < 0, true, 'past dates have negative days');
  // The label for a released episode is just the date — no countdown to show.
  assert.strictEqual(a.label, a.date, 'aired label is the date');
  assert.strictEqual(a.date, fmtLocal(2025, 8, 28), 'formats as local Sep 28, 2025');
}

function testToday() {
  const a = airDateStatus('2026-07-27', NOW);
  assert.strictEqual(a.state, 'today', 'same day is its own state, not aired');
  assert.strictEqual(a.days, 0, 'today is zero days out');
  assert.strictEqual(a.label, 'Today');
}

function testUpcomingNear() {
  assert.strictEqual(airDateStatus('2026-07-28', NOW).label, 'Tomorrow', 'one day out reads "Tomorrow"');
  const week = airDateStatus('2026-08-03', NOW);
  assert.strictEqual(week.state, 'upcoming');
  assert.strictEqual(week.days, 7);
  assert.strictEqual(week.label, 'In 7 days', 'inside the horizon the label counts down');
}

function testUpcomingFar() {
  // Past the 21-day horizon the countdown stops being informative and the label
  // falls back to the date. Callers detect that with `label === date` and print
  // a plain "Upcoming" chip instead of repeating the date twice in one row.
  const far = airDateStatus('2026-09-27', NOW);
  assert.strictEqual(far.state, 'upcoming');
  assert.strictEqual(far.label, far.date, 'beyond the horizon label falls back to the date');
  assert.strictEqual(far.date, fmtLocal(2026, 8, 27), 'formats as local Sep 27, 2026');

  // The horizon boundary itself is still a countdown; one day past it is not.
  assert.strictEqual(airDateStatus('2026-08-17', NOW).label, 'In 21 days', '21 days is inside the horizon');
  assert.strictEqual(airDateStatus('2026-08-18', NOW).label, fmtLocal(2026, 7, 18), '22 days falls back');
}

function testMissingDateIsSelectable() {
  // The load-bearing case: blank must NOT become 'upcoming', or every
  // undated special silently turns into a disabled card.
  for (const empty of [null, undefined, '', 'not-a-date']) {
    const a = airDateStatus(empty, NOW);
    assert.strictEqual(a.state, 'tba', `${JSON.stringify(empty)} is TBA, not upcoming`);
    assert.strictEqual(a.days, null, 'TBA has no day count');
    assert.strictEqual(a.label, 'TBA');
  }
}

function testFullTimestampAccepted() {
  // TMDB is consistent about YYYY-MM-DD, but slicing to 10 chars means a full
  // ISO timestamp does not silently produce an Invalid Date.
  const a = airDateStatus('2025-09-28T12:30:00.000Z', NOW);
  assert.strictEqual(a.state, 'aired', 'a full timestamp still parses');
  assert.strictEqual(a.date, fmtLocal(2025, 8, 28), 'timestamp keeps the calendar day');
}

function main() {
  testReleased();
  testToday();
  testUpcomingNear();
  testUpcomingFar();
  testMissingDateIsSelectable();
  testFullTimestampAccepted();
  console.log('air-date.test.js passed');
}

main();
