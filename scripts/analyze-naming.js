#!/usr/bin/env node
'use strict';

/**
 * Pattern analyzer — Deliverable 2.
 *
 * Reads the corpus produced by torrent-naming-survey.js and writes a
 * human-readable Markdown report at scripts/data/torrent-naming-report.md
 * plus a machine-readable summary at scripts/data/torrent-naming-summary.json.
 *
 * Sections:
 *   1. Per-source naming pattern frequencies (anime vs live-action buckets)
 *   2. "S omitted, only E present" cases — the user-flagged concern
 *   3. Year-collision risks
 *   4. Cross-show contamination on bare-title queries
 *   5. Recommended classifier hit rate (per the shared name-patterns.js rules)
 */

const fs = require('fs');
const path = require('path');

const { parseName, classify } = require('../core/torrent-name-patterns');

const DATA_DIR = path.join(__dirname, 'data');
const INPUT = path.join(DATA_DIR, 'torrent-naming-data.json');
const REPORT_MD = path.join(DATA_DIR, 'torrent-naming-report.md');
const SUMMARY_JSON = path.join(DATA_DIR, 'torrent-naming-summary.json');

if (!fs.existsSync(INPUT)) {
  console.error(`Missing ${INPUT} — run scripts/torrent-naming-survey.js first.`);
  process.exit(1);
}

const corpus = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

// ---------------------------------------------------------------------------
// Pattern buckets
// ---------------------------------------------------------------------------

const PATTERN_BUCKETS = [
  'SE_PAIR',
  'LONGFORM',
  'ANIME_SEASON_DASH',
  'EP_ONLY',
  'ANIME_DASH',
  'SEASON_ONLY',
  'NONE',
];

function bucketize(parsed) {
  if (parsed.patternsHit.includes('SE_PAIR')) return 'SE_PAIR';
  if (parsed.patternsHit.includes('LONGFORM')) return 'LONGFORM';
  if (parsed.patternsHit.includes('ANIME_SEASON_DASH')) return 'ANIME_SEASON_DASH';
  if (parsed.patternsHit.includes('ANIME_DASH')) return 'ANIME_DASH';
  if (parsed.patternsHit.includes('EP_ONLY')) return 'EP_ONLY';
  if (parsed.patternsHit.includes('SEASON_ONLY')) return 'SEASON_ONLY';
  return 'NONE';
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

function emptyTable(rowKeys, colKeys) {
  const t = {};
  for (const r of rowKeys) {
    t[r] = {};
    for (const c of colKeys) t[r][c] = 0;
    t[r].__total = 0;
  }
  return t;
}

const sources = corpus.sources || ['1337x', 'YTS', 'PirateBay', 'Nyaa', 'SubsPlease'];
const animeFreq = emptyTable(sources, PATTERN_BUCKETS);
const liveFreq = emptyTable(sources, PATTERN_BUCKETS);

const sOmitted = []; // { source, name, show, parsed }
const yearCollisions = []; // { source, name, expectedYear, foundYear }
const crossShowSuspect = []; // { source, name, queryShow }

const classifierStats = {
  total: 0,
  anyMatch: 0,
  exactSEMatch: 0,
  longformMatch: 0,
  episodeOnlyMatch: 0,
  animeDashMatch: 0,
  absoluteMatch: 0,
  wrongSeasonRejected: 0,
};

for (const rec of corpus.records || []) {
  const isAnime = !!rec.show.isAnime;
  const table = isAnime ? animeFreq : liveFreq;
  const bucket = bucketize(rec.parsed);
  if (!table[rec.source]) continue; // unknown source key — skip
  table[rec.source][bucket] += 1;
  table[rec.source].__total += 1;

  // S-omitted detection: episode tag present, no season tag, show is S2+.
  // This is the user-reported failure mode.
  if (
    rec.show.season >= 2 &&
    rec.parsed.seasonTag == null &&
    rec.parsed.episodeTag != null &&
    rec.parsed.exactSE == null
  ) {
    sOmitted.push({
      source: rec.source,
      name: rec.name,
      show: `${rec.show.title} (tmdbId=${rec.show.tmdbId}, S${rec.show.season})`,
      parsedEpisode: rec.parsed.episodeTag,
      requestedEpisode: rec.show.episode,
      seeders: rec.seeders,
    });
  }

  // Year collision: torrent name contains a year that doesn't match the show's
  // first-air year (signals a same-titled different show).
  if (
    rec.show.firstAirYear != null &&
    rec.parsed.year != null &&
    rec.parsed.year !== rec.show.firstAirYear &&
    Math.abs(rec.parsed.year - rec.show.firstAirYear) >= 2
  ) {
    yearCollisions.push({
      source: rec.source,
      name: rec.name,
      show: `${rec.show.title} (${rec.show.firstAirYear})`,
      foundYear: rec.parsed.year,
    });
  }

  // Cross-show suspect on bare-title queries: variant A returned a result
  // whose name doesn't contain the show's title prefix at all.
  if (rec.queryVariant === 'A') {
    const lowerName = (rec.name || '').toLowerCase();
    const lowerTitle = (rec.show.title || '').toLowerCase();
    if (lowerTitle && !lowerName.includes(lowerTitle)) {
      crossShowSuspect.push({
        source: rec.source,
        name: rec.name,
        queryShow: rec.show.title,
      });
    }
  }

  // Classifier hit-rate
  classifierStats.total += 1;
  const v = rec.verdict;
  if (v.exactSEMatch || v.longformMatch || v.episodeOnlyMatch || v.animeDashMatch || v.absoluteMatch) {
    classifierStats.anyMatch += 1;
  }
  if (v.exactSEMatch) classifierStats.exactSEMatch += 1;
  if (v.longformMatch) classifierStats.longformMatch += 1;
  if (v.episodeOnlyMatch) classifierStats.episodeOnlyMatch += 1;
  if (v.animeDashMatch) classifierStats.animeDashMatch += 1;
  if (v.absoluteMatch) classifierStats.absoluteMatch += 1;
  if (v.wrongSeason) classifierStats.wrongSeasonRejected += 1;
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function pct(num, denom) {
  if (!denom) return '0%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function freqTable(table) {
  const lines = [];
  lines.push(`| Source | Total | ${PATTERN_BUCKETS.join(' | ')} |`);
  lines.push(`|--------|-------|${PATTERN_BUCKETS.map(() => '------').join('|')}|`);
  for (const src of sources) {
    const row = table[src];
    const cells = PATTERN_BUCKETS.map((b) => `${row[b]} (${pct(row[b], row.__total)})`);
    lines.push(`| ${src} | ${row.__total} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function bullets(items, fmt, max = 30) {
  if (!items.length) return '_None observed._';
  const lines = items.slice(0, max).map((it) => `- ${fmt(it)}`);
  if (items.length > max) lines.push(`- _…and ${items.length - max} more (see torrent-naming-summary.json)._`);
  return lines.join('\n');
}

const md = `# Torrent Naming Survey — Report

Generated from \`${path.relative(process.cwd(), INPUT)}\`.

- Corpus generated: ${corpus.generatedAt}
- Shows surveyed: ${corpus.showCount}
- Records: ${corpus.recordCount} (${corpus.failureCount} source errors)
- Sources: ${sources.join(', ')}

---

## 1. Per-source naming patterns (anime shows)

${freqTable(animeFreq)}

## 1b. Per-source naming patterns (live-action shows)

${freqTable(liveFreq)}

**Reading the table:** \`SE_PAIR\` = \`SxxExx\` style; \`EP_ONLY\` = episode tag with no season; \`ANIME_DASH\` = \`Show - NN\`; \`SEASON_ONLY\` = season tag with no episode (likely a season pack); \`NONE\` = no recognizable S/E.

---

## 2. "S omitted, only E present" cases

These are torrents for shows in **Season 2 or later** whose names tag only the episode and never the season. The user specifically flagged this — the production filter must accept them as implicit-season matches when no contradicting season tag is present.

${bullets(sOmitted, (it) => `**${it.source}** — \`${it.name}\` _(${it.show}, parsed E${it.parsedEpisode} vs requested E${it.requestedEpisode}, ${it.seeders} seeders)_`)}

Total observed: **${sOmitted.length}**

---

## 3. Year-collision risks

Torrent names whose embedded year differs from the show's TMDB first-air year by ≥ 2 years. These are usually same-titled different shows (the \`One Piece (1999)\` vs \`One Piece (2023)\` case).

${bullets(yearCollisions, (it) => `**${it.source}** — \`${it.name}\` _(asked about ${it.show}, name says ${it.foundYear})_`)}

Total observed: **${yearCollisions.length}**

---

## 4. Cross-show contamination (bare-title query)

When the search query is just \`{title}\`, results whose name doesn't even contain the title prefix.

${bullets(crossShowSuspect, (it) => `**${it.source}** — \`${it.name}\` _(query: ${it.queryShow})_`)}

Total observed: **${crossShowSuspect.length}**

---

## 5. Classifier hit rate (shared rules in \`core/torrent-name-patterns.js\`)

Of every torrent in the corpus, what fraction does the candidate classifier flag as a real match for the requested S/E?

| Outcome | Count | % of corpus |
|---|---|---|
| Any match | ${classifierStats.anyMatch} | ${pct(classifierStats.anyMatch, classifierStats.total)} |
| Exact S##E## match | ${classifierStats.exactSEMatch} | ${pct(classifierStats.exactSEMatch, classifierStats.total)} |
| Long-form "Season X Episode Y" | ${classifierStats.longformMatch} | ${pct(classifierStats.longformMatch, classifierStats.total)} |
| Episode-only (S omitted) | ${classifierStats.episodeOnlyMatch} | ${pct(classifierStats.episodeOnlyMatch, classifierStats.total)} |
| Anime " - NN" | ${classifierStats.animeDashMatch} | ${pct(classifierStats.animeDashMatch, classifierStats.total)} |
| Anime absolute episode | ${classifierStats.absoluteMatch} | ${pct(classifierStats.absoluteMatch, classifierStats.total)} |
| Wrong-season rejection | ${classifierStats.wrongSeasonRejected} | ${pct(classifierStats.wrongSeasonRejected, classifierStats.total)} |

Total records classified: **${classifierStats.total}**.

> A high "Any match" % across both anime and live-action sources indicates the rule set generalises. A high "Wrong-season rejection" indicates how often the source returned a wrong-season result that we successfully rejected.

---

## 6. Failed source calls

${corpus.failures && corpus.failures.length
  ? bullets(corpus.failures, (f) => `**${f.source}** — query: \`${f.query}\` — error: ${f.error}`)
  : '_None._'}
`;

fs.writeFileSync(REPORT_MD, md);

const summary = {
  generatedAt: new Date().toISOString(),
  source: INPUT,
  patternFrequencies: { anime: animeFreq, live: liveFreq },
  sOmittedCount: sOmitted.length,
  sOmitted,
  yearCollisionCount: yearCollisions.length,
  yearCollisions,
  crossShowSuspectCount: crossShowSuspect.length,
  crossShowSuspect,
  classifierStats,
};
fs.writeFileSync(SUMMARY_JSON, JSON.stringify(summary, null, 2));

console.log(`Wrote report:  ${REPORT_MD}`);
console.log(`Wrote summary: ${SUMMARY_JSON}`);
console.log(
  `\nClassifier hit rate: ${pct(classifierStats.anyMatch, classifierStats.total)} ` +
    `(${classifierStats.anyMatch}/${classifierStats.total})`
);
console.log(`S-omitted cases: ${sOmitted.length}`);
console.log(`Year collisions: ${yearCollisions.length}`);
console.log(`Cross-show suspects: ${crossShowSuspect.length}`);
