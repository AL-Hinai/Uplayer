#!/usr/bin/env node
'use strict';

// Subtitle provider diagnostic CLI.
//
// Runs the real SubtitleManager against the LIVE provider hosts with fixed fixtures
// and reports, per provider, whether it still answers. It exists because provider rot
// is silent by construction: every search method returns [] on failure so one dead
// host never fails a search, which also means a host can go away and nothing says so.
// Two providers sat in the fan-out returning zero for an unknown length of time before
// this script existed — SubsPlease's search URL had started answering "Page not found"
// and Addic7ed's table markup had lost the class the scraper selected on.
//
// Not a test: it needs the network and third-party uptime, so it must never run in
// `npm test`. Run it by hand when subtitles look thin, or after touching a provider.
// A provider reporting 0 is either rot or a genuinely uncovered fixture — check the
// other fixtures for the same provider before concluding.
//
// Usage:
//   node tools/subtitle-diagnose.js [--lang en] [--json]

const path = require('path');

const { loadEnvFileOnce } = require(path.join(__dirname, '..', 'core', 'config'));
try { loadEnvFileOnce(); } catch (e) { /* keyless is the point */ }
const { createSubtitleManager } = require(path.join(__dirname, '..', 'core', 'subtitle-manager'));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LANG = argOf('--lang', 'en');
const AS_JSON = args.includes('--json');

// One fixture per provider per content kind. Each is something the provider is
// expected to carry, so a 0 is a signal rather than a shrug.
const FIXTURES = [
  {
    provider: 'YIFY', kind: 'movie', label: 'Inception (2010)',
    run: (m) => m.searchYify('tt1375666', LANG),
  },
  {
    provider: 'YIFY', kind: 'movie', label: 'The Matrix (1999)',
    run: (m) => m.searchYify('tt0133093', LANG),
  },
  {
    provider: 'Gestdown', kind: 'tv', label: 'Breaking Bad S01E01',
    run: (m) => m.searchGestdown('Breaking Bad', LANG, 1, 1),
  },
  {
    provider: 'Gestdown', kind: 'tv', label: 'Severance S01E01',
    run: (m) => m.searchGestdown('Severance', LANG, 1, 1),
  },
  {
    provider: 'OpenSubtitles', kind: 'optional', label: 'Inception (needs a key)',
    run: (m) => m.searchOpenSubtitles('Inception', LANG, null, null, 2010, 27205, 'movie'),
  },
];

(async () => {
  const m = createSubtitleManager();
  const keyed = m.hasOpenSubtitlesCredentials();
  const rows = [];

  for (const f of FIXTURES) {
    const t0 = Date.now();
    let n = 0;
    let error = null;
    try {
      const r = await f.run(m);
      n = Array.isArray(r) ? r.length : 0;
    } catch (e) {
      error = e.message;
    }
    rows.push({ provider: f.provider, kind: f.kind, fixture: f.label, results: n, ms: Date.now() - t0, error });
  }

  // A provider is healthy if ANY of its fixtures answered — one uncovered title is
  // normal, all of them answering zero is rot.
  const byProvider = {};
  for (const r of rows) {
    const p = (byProvider[r.provider] = byProvider[r.provider] || { total: 0, fixtures: 0 });
    p.total += r.results;
    p.fixtures += 1;
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ language: LANG, openSubtitlesConfigured: keyed, rows, byProvider }, null, 2));
  } else {
    console.log(`Subtitle providers — language "${LANG}", OpenSubtitles key ${keyed ? 'configured' : 'absent (keyless)'}\n`);
    for (const r of rows) {
      console.log(
        '  ' + r.provider.padEnd(14) + r.kind.padEnd(10) + r.fixture.padEnd(28) +
        String(r.results).padStart(3) + ' results  ' + String(r.ms).padStart(6) + ' ms' +
        (r.error ? '  ERROR: ' + r.error : '')
      );
    }
    console.log('\n  verdict');
    for (const [p, v] of Object.entries(byProvider)) {
      const optional = p === 'OpenSubtitles' && !keyed;
      const state = v.total > 0 ? 'OK' : optional ? 'inert (no key — expected)' : 'RETURNS NOTHING — investigate';
      console.log('  ' + p.padEnd(14) + state + `  (${v.total} results across ${v.fixtures} fixtures)`);
    }
  }

  // Exit non-zero only for a provider that should work and did not, so this is usable
  // as a scripted health check without failing on the optional API being absent.
  const broken = Object.entries(byProvider)
    .filter(([p, v]) => v.total === 0 && !(p === 'OpenSubtitles' && !keyed))
    .map(([p]) => p);
  if (broken.length) {
    if (!AS_JSON) console.log('\n  broken: ' + broken.join(', '));
    process.exit(2);
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
