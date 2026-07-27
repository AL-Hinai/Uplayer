'use strict';

// Has this episode come out yet, and if not, when does it?
//
// TMDB hands out `air_date` for episodes that have not happened — a running
// show's season lists its whole remaining schedule. Torrent scrapers can never
// find those, so the season/episode picker has to tell three states apart
// rather than render every episode as equally playable.
//
// The states, and why there are four and not two:
//   'aired'    — in the past. Playable.
//   'today'    — airs today. Playable; a release may or may not be up yet.
//   'upcoming' — a confirmed future date. NOT playable; the picker disables it.
//   'tba'      — no usable date. Playable anyway, deliberately: TMDB leaves the
//                date empty on plenty of specials that already exist, so
//                treating a blank like a future date would hide them.
//
// Dates are parsed as LOCAL midnight, not UTC. `new Date('2026-09-27')` is UTC
// midnight, which renders as Sep 26 for every user west of Greenwich — an
// episode that visibly aired "yesterday" relative to its own listed date.
// Appending T00:00:00 forces local parsing so the day math and the printed
// date agree with the user's calendar.
//
// PURE, and fed by the caller: `now` is an argument so tests can pin a date
// instead of mocking the clock. That is the whole reason it lives in its own
// file rather than inside app.js.
//
// Loaded as a classic script BEFORE app.js (see index.html), so `airDateStatus`
// is a window global there.

function formatAirDate(d) {
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Beyond this horizon a countdown stops being useful and the calendar date is
// the more informative label ("In 94 days" tells you less than "Sep 27, 2026").
// Callers use `label === date` to detect that the fallback kicked in.
const RELATIVE_HORIZON_DAYS = 21;

function airDateStatus(str, now) {
  if (!str) return { state: 'tba', label: 'TBA', date: '', days: null };
  const d = new Date(`${String(str).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { state: 'tba', label: 'TBA', date: '', days: null };

  const today = now ? new Date(now.getTime()) : new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  const date = formatAirDate(d);

  if (days > 0) {
    const label = days === 1 ? 'Tomorrow'
      : days <= RELATIVE_HORIZON_DAYS ? `In ${days} days`
        : date;
    return { state: 'upcoming', label, date, days };
  }
  if (days === 0) return { state: 'today', label: 'Today', date, days: 0 };
  return { state: 'aired', label: date, date, days };
}

// Node require() for the test; harmless no-op in the browser (no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { airDateStatus };
}
