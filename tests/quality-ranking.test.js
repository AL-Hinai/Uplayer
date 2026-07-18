'use strict';

// qualityTier / qualityLabel / extractInfohash from core/torrent-name-patterns,
// plus dedupeTorrentResults from uplayer.js: the same torrent listed by two
// sources merges into one entry keeping the higher seeder count, while
// magnet-less results still dedupe by name|source.

const assert = require('assert');
const { qualityTier, qualityLabel, extractInfohash } = require('../core/torrent-name-patterns');
const { dedupeTorrentResults, filterByPreferredQuality } = require('../uplayer.js');

function main() {
  // Quality tiers.
  assert.strictEqual(qualityTier('Movie.2160p.UHD.BluRay'), 4);
  assert.strictEqual(qualityTier('Movie 4K HDR'), 4);
  assert.strictEqual(qualityTier('Show.S01E01.1080p.WEB'), 3);
  assert.strictEqual(qualityTier('Show.S01E01.720p.HDTV'), 2);
  assert.strictEqual(qualityTier('Old.Movie.480p.DVDRip'), 1);
  assert.strictEqual(qualityTier('Some Release No Res Tag'), 0);
  assert.strictEqual(qualityLabel(3), '1080p');
  assert.strictEqual(qualityLabel(0), null);

  // Infohash extraction.
  const hex = extractInfohash('magnet:?xt=urn:btih:F3B2ADA3E0AF06D166ACBA3C4C4127DDA32A5A21&dn=x');
  assert.strictEqual(hex, 'f3b2ada3e0af06d166acba3c4c4127dda32a5a21', 'hex hash lowercased');
  assert.strictEqual(extractInfohash('http://site/page/123'), null, 'non-magnet → null');
  assert.strictEqual(extractInfohash(null), null);
  const b32 = extractInfohash('magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=y');
  assert.strictEqual(b32, 'nuocmtjw26bspovzj53jhnefcbpm7nqv', 'base32 form kept as stable key');

  // Infohash dedupe across sources.
  const magnetA = 'magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=z';
  const results = dedupeTorrentResults([
    { name: 'Same.Movie.1080p-A', seeders: 10, link: magnetA, source: 'PirateBay' },
    { name: 'Same.Movie.1080p-B', seeders: 90, link: magnetA, source: 'YTS' },
    { name: 'Different.Movie.720p', seeders: 50, link: 'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', source: 'PirateBay' },
    { name: 'Pageonly Release', seeders: 3, link: 'http://x/1', source: '1337x' },
    { name: 'Pageonly Release', seeders: 3, link: 'http://x/1', source: '1337x' },
    { name: 'Pageonly Release', seeders: 7, link: 'http://y/1', source: 'Nyaa' },
  ]);
  assert.strictEqual(results.length, 4, 'dupes collapsed (hash pair + identical name|source pair)');
  const merged = results.find((r) => extractInfohash(r.link) === 'a'.repeat(40));
  assert.strictEqual(merged.seeders, 90, 'higher-seeder copy wins the hash merge');
  assert.strictEqual(merged.source, 'YTS');
  assert.strictEqual(results.filter((r) => r.name === 'Pageonly Release').length, 2,
    'same name from DIFFERENT sources both kept when no hash to compare');

  // Preferred quality is a filter, not just a boost: a high-seeder 1080p release
  // must not survive a 2160p preference.
  const mixed = [
    { name: 'Interstellar 2014 1080p BluRay x264', seeders: 1386 },
    { name: 'Interstellar 2014 2160p UHD BluRay HEVC', seeders: 256 },
    { name: 'Interstellar 2014 720p BrRip x264', seeders: 616 },
    { name: 'Interstellar 2014 BrRip XviD', seeders: 800 }, // no res tag → tier 0
  ];
  const uhd = filterByPreferredQuality(mixed, qualityTier('2160p'));
  assert.deepStrictEqual(uhd.map((r) => r.name), ['Interstellar 2014 2160p UHD BluRay HEVC'],
    '2160p preference hides the higher-seeder 1080p/720p/untagged releases');

  const hd = filterByPreferredQuality(mixed, qualityTier('1080p'));
  assert.strictEqual(hd.length, 1, '1080p preference keeps only the 1080p release');
  assert.strictEqual(hd[0].seeders, 1386);

  // Order within the kept set is preserved (callers sort before filtering).
  const twoUhd = filterByPreferredQuality([
    { name: 'A.2160p', seeders: 5 }, { name: 'B.1080p', seeders: 900 }, { name: 'C.4K', seeders: 1 },
  ], 4);
  assert.deepStrictEqual(twoUhd.map((r) => r.name), ['A.2160p', 'C.4K'], 'all tier matches kept, in order');

  // Fallback: a preference with no matches must never yield an empty list.
  const noneMatch = filterByPreferredQuality(
    [{ name: 'Show.S01E01.720p.HDTV', seeders: 12 }, { name: 'Show.S01E01.1080p.WEB', seeders: 30 }],
    qualityTier('2160p'));
  assert.strictEqual(noneMatch.length, 2, 'no 2160p release → fall back to the full list, not zero results');

  // No preference set → untouched.
  assert.strictEqual(filterByPreferredQuality(mixed, 0).length, 4, 'tier 0 preference is a no-op');

  console.log('quality-ranking: all assertions passed');
}

main();
