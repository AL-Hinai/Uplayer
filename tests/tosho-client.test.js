'use strict';

// The id-keyed AnimeTosho source, and the four field-name traps in its payload. Each one
// fails SILENTLY if got wrong, which is why each gets its own assertion:
//
//   1. `article_title` is the SOURCE SITE ("Nyaa", "nBT"), not the release name. Reading it
//      feeds "Nyaa" to parseName and produces garbage with no error anywhere.
//   2. `link` must be the magnet. dedupeTorrentResults pulls the infohash out of `link`;
//      the payload's own `link` field is an animetosho.net page URL with no infohash in it,
//      so using it would silently stop tosho rows from merging with the nyaa rows for the
//      same release.
//   3. `idMatched` may only be set on rows from the eid-filtered query. Setting it on a
//      broad-query row would let a whole-series result bypass episode classification.
//   4. Sizes arrive as bytes in `total_size`, not as a display string.
//
// Also pinned: the batch problem. Querying by eid alone hides every season pack, because
// packs carry no episode id — measured at 75 rows for a show of which only 22 had one. So
// the client must issue the broad query too, and those rows must stay classifiable.
//
// Pure apart from a local fake HTTP server; no third-party network.

const assert = require('assert');
const http = require('http');
const { createToshoClient, _internals } = require('../core/tosho-client');

const EXACT_ROW = {
  anidb_aid: 17765,
  anidb_eid: 267537,
  article_title: 'Nyaa',                       // the trap
  article_url: 'https://nyaa.si/view/1752049',
  link: 'https://animetosho.net/view/454700',  // the other trap
  title: '[ZigZag] BLEACH: Thousand-Year Blood War S02E01 [1080p]',
  torrent_name: '[ZigZag] BLEACH: Thousand-Year Blood War S02E01 [1080p]',
  info_hash: '3DFCF9FA4EF3EE1E6BA6749B79505E95EB5CC6F2',
  magnet_uri: 'magnet:?xt=urn:btih:3DFCF9FA4EF3EE1E6BA6749B79505E95EB5CC6F2&dn=x',
  seeders: 86,
  leechers: 1,
  total_size: 1454859350,
  num_files: 1,
};
const BATCH_ROW = {
  anidb_aid: 17765,
  anidb_eid: null,                             // a pack: no episode id, invisible to eids
  article_title: 'nBT',
  title: '[SubsPlease] Bleach - Sennen Kessen Hen (41-50) (1080p) [Batch]',
  magnet_uri: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=y',
  seeders: 86,
  leechers: 3,
  total_size: 8423228390,
};

function startFake() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (/eids=/.test(req.url)) return res.end(JSON.stringify([EXACT_ROW]));
    if (/aids=/.test(req.url)) return res.end(JSON.stringify([EXACT_ROW, BATCH_ROW]));
    res.end(JSON.stringify([]));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, seen, host: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function testExactQueryShapeAndFieldTraps() {
  const { server, seen, host } = await startFake();
  try {
    const c = createToshoClient({ hosts: [host] });
    const rows = await c.search({ aids: 17765, eids: 267537 });
    assert.strictEqual(rows.length, 1);
    const r = rows[0];

    assert.ok(r.name.startsWith('[ZigZag]'), 'name comes from title, never article_title');
    assert.notStrictEqual(r.name, 'Nyaa');
    assert.ok(r.link.startsWith('magnet:?'), 'link must be the magnet so infohash dedupe works');
    assert.ok(!/animetosho\.net\/view/.test(r.link), 'link must not be the page URL');
    assert.strictEqual(r.idMatched, true, 'eid-filtered rows are exact');
    assert.strictEqual(r.sizeBytes, 1454859350, 'bytes come from total_size');
    assert.strictEqual(r.seeders, 86);
    assert.strictEqual(r.source, 'Tosho');
    assert.ok(/eids=267537/.test(seen[0]), 'the eid must actually reach the query string');
  } finally {
    server.close();
  }
}

// The reason the broad query exists at all.
async function testBroadQueryKeepsBatchesAndDoesNotClaimExactness() {
  const { server, host } = await startFake();
  try {
    const c = createToshoClient({ hosts: [host] });
    const rows = await c.search({ aids: 17765 });
    assert.strictEqual(rows.length, 2, 'the broad query is what surfaces the pack');
    const batch = rows.find((r) => /Batch/.test(r.name));
    assert.ok(batch, 'the season pack must survive normalisation');
    assert.ok(rows.every((r) => r.idMatched === undefined),
      'no broad-query row may claim idMatched — it would bypass episode classification');
  } finally {
    server.close();
  }
}

async function testDeadHostsDegradeToEmpty() {
  const c = createToshoClient({ hosts: ['http://127.0.0.1:1'] });
  assert.deepStrictEqual(await c.search({ aids: 17765, eids: 1 }), [],
    'an unreachable host returns [], never throws into the fan-out');
  assert.deepStrictEqual(await c.search({}), [], 'no aids => no request, no results');
}

// A dead first mirror must cost one failed request per process, not one per query.
async function testStickyMirrorIsRemembered() {
  const { server, seen, host } = await startFake();
  try {
    const c = createToshoClient({ hosts: ['http://127.0.0.1:1', host] });
    await c.search({ aids: 17765, eids: 267537 });
    assert.strictEqual(c.sticky, host, 'the host that answered is remembered');
    await c.search({ aids: 17765 });
    assert.strictEqual(seen.length, 2, 'both queries reached the live host');
  } finally {
    server.close();
  }
}

function testNormalizeRowRejectsUnusableRows() {
  const { normalizeRow } = _internals;
  assert.strictEqual(normalizeRow(null, true), null);
  assert.strictEqual(normalizeRow({ title: 'x' }, true), null, 'no magnet => unusable');
  assert.strictEqual(normalizeRow({ magnet_uri: 'magnet:?x' }, true), null, 'no name => unusable');
  const fallback = normalizeRow({ torrent_name: 'n', magnet_uri: 'magnet:?x' }, false);
  assert.strictEqual(fallback.name, 'n', 'torrent_name is an accepted fallback for title');
}

async function main() {
  await testExactQueryShapeAndFieldTraps();
  await testBroadQueryKeepsBatchesAndDoesNotClaimExactness();
  await testDeadHostsDegradeToEmpty();
  await testStickyMirrorIsRemembered();
  testNormalizeRowRejectsUnusableRows();
  console.log('tosho-client.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
