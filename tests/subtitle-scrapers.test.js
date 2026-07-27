'use strict';

// The keyless subtitle pipeline. The bug under test: subtitle search effectively
// REQUIRED an OpenSubtitles API key + account — without credentials, movies got
// nothing (Addic7ed/SubsPlease only cover TV/anime). The keyless providers must
// carry the search on their own: YIFY for movies (addressed by IMDb id, zip
// downloads needing a Referer), Gestdown for TV (keyless Addic7ed JSON proxy),
// plus the dependency-free zip extractor that unwraps YIFY's archives.
//
// Providers are exercised against a LOCAL fake server via the injectable base
// URLs — no network. The fixture HTML/JSON mirror live responses captured from
// yifysubtitles.ch and api.gestdown.info on 2026-07-25.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { extractEntries, extractFirstSubtitle } = require('../core/zip-extract');
const { SubtitleManager } = require('../core/subtitle-manager');

// Build a real minimal zip (local headers + central directory + EOCD). CRCs are
// left zero — the extractor deliberately doesn't verify them.
function buildZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const method = e.store ? 0 : 8;
    const data = e.store ? raw : zlib.deflateRawSync(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    parts.push(lh, nameBuf, data);
    offset += lh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello subtitle\n';

function testZipExtraction() {
  const zip = buildZip([
    { name: 'readme.txt', data: 'not a subtitle' },
    { name: 'Movie.2026.1080p.srt', data: SRT },
    { name: 'stored.srt', data: SRT, store: true },
  ]);
  const entries = extractEntries(zip);
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[1].data.toString(), SRT, 'deflated entry round-trips');
  assert.strictEqual(entries[2].data.toString(), SRT, 'stored entry round-trips');

  const sub = extractFirstSubtitle(zip);
  assert.strictEqual(sub.name, 'Movie.2026.1080p.srt', 'first SUBTITLE file, not the readme');

  assert.strictEqual(extractFirstSubtitle(Buffer.from('not a zip at all, definitely')), null);
  assert.strictEqual(extractFirstSubtitle(buildZip([{ name: 'notes.txt', data: 'x' }])), null,
    'archive without any subtitle file → null, not a bogus track');
}

// Fixture mirroring the live yifysubtitles.ch movie page rows (tt0816692, 2026-07-25).
const YIFY_PAGE = `<html><body><table><tbody>
<tr data-id="56676"><td class="rating-cell"><span class="label">0</span></td>
  <td class="flag-cell"><span class="sub-lang">Albanian</span></td>
  <td><a href="/subtitles/interstellar-2014-albanian-yify-56676"><span class="text-muted">subtitle</span> Interstellar ALB</a></td></tr>
<tr data-id="56700"><td class="rating-cell"><span class="label label-success">6</span></td>
  <td class="flag-cell"><span class="sub-lang">English</span></td>
  <td><a href="/subtitles/interstellar-2014-english-yify-56700"><span class="text-muted">subtitle</span> Interstellar.2014.1080p.BluRay.x264.YIFY</a></td></tr>
<tr data-id="56701"><td class="rating-cell"><span class="label">2</span></td>
  <td class="flag-cell"><span class="sub-lang">English</span></td>
  <td><a href="/subtitles/interstellar-2014-english-yify-56701"><span class="text-muted">subtitle</span> Interstellar.2014.720p.WEBRip</a></td></tr>
</tbody></table></body></html>`;

async function withFakeServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn('http://127.0.0.1:' + srv.address().port); }
  finally { srv.close(); }
}

async function testYifySearchAndDownload() {
  const requests = [];
  await withFakeServer((req, res) => {
    requests.push({ url: req.url, referer: req.headers.referer || null });
    if (req.url === '/movie-imdb/tt0816692') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(YIFY_PAGE);
    } else if (req.url === '/subtitle/interstellar-2014-english-yify-56700.zip') {
      // Like the real site: 403 unless the subtitle page is the Referer.
      if (!req.headers.referer || !req.headers.referer.includes('/subtitles/interstellar-2014-english-yify-56700')) {
        res.writeHead(403); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      res.end(buildZip([{ name: 'Interstellar.srt', data: SRT }]));
    } else { res.writeHead(404); res.end(); }
  }, async (base) => {
    const m = new SubtitleManager({ yifyBase: base });

    const results = await m.searchYify('tt0816692', 'en');
    assert.strictEqual(results.length, 2, 'language filter drops the Albanian row');
    assert.strictEqual(results[0].title, 'Interstellar.2014.1080p.BluRay.x264.YIFY',
      'release-named rows, best-rated first — the release name is how timing gets matched');
    assert.strictEqual(results[0].source, 'YIFY');
    assert.ok(results[0].downloadUrl.endsWith('/subtitle/interstellar-2014-english-yify-56700.zip'),
      'zip URL derived from the row (singular /subtitle/ + .zip)');

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-subtest-')), 'out.srt');
    const ok = await m.downloadSubtitle(results[0].id, out, 'YIFY', results[0].downloadUrl);
    assert.strictEqual(ok, true, 'download + Referer + unzip all succeed');
    assert.strictEqual(fs.readFileSync(out, 'utf8'), SRT, 'callers get a plain .srt, never a zip');
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  });

  const noSearch = new SubtitleManager({});
  assert.deepStrictEqual(await noSearch.searchYify(null, 'en'), [], 'no imdb id → empty, no request');
}

async function testGestdownSearchAndDownload() {
  await withFakeServer((req, res) => {
    if (req.url === '/shows/search/Breaking%20Bad') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ shows: [{ id: 'guid-1', name: 'Breaking Bad', nbSeasons: 5 }] }));
    } else if (req.url === '/subtitles/get/guid-1/1/1/English') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ matchingSubtitles: [
        { subtitleId: 's-9', version: '720p.BluRay', downloadCount: 42, downloadUri: '/subtitles/download/s-9', language: 'English', hearingImpaired: false },
      ] }));
    } else if (req.url === '/subtitles/download/s-9') {
      res.writeHead(200, { 'Content-Type': 'text/srt' });
      res.end(SRT);
    } else { res.writeHead(404); res.end(); }
  }, async (base) => {
    const m = new SubtitleManager({ gestdownBase: base });

    assert.deepStrictEqual(await m.searchGestdown('Breaking Bad', 'en', null, null), [],
      'no season/episode → movies never hit the TV provider');

    const results = await m.searchGestdown('Breaking Bad', 'en', 1, 1);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].source, 'Gestdown');
    assert.strictEqual(results[0].title, 'Breaking Bad - S01E01 - 720p.BluRay');
    assert.strictEqual(results[0].downloadCount, 42);

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uplayer-subtest-')), 'out.srt');
    const ok = await m.downloadSubtitle(results[0].id, out, 'Gestdown', results[0].downloadUrl);
    assert.strictEqual(ok, true);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), SRT, 'direct file, no archive');
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  });
}

function testOpenSubtitlesIsOptionalNotRequired() {
  const bare = new SubtitleManager({});
  assert.strictEqual(bare.hasOpenSubtitlesCredentials(), false);
  const withCreds = new SubtitleManager({ openSubtitles: { apiKey: 'k', username: 'u', password: 'p' } });
  assert.strictEqual(withCreds.hasOpenSubtitlesCredentials(), true);
}

async function testDownloadDispatchRoutesBySource() {
  const m = new SubtitleManager({});
  const calls = [];
  m.downloadYify = async () => { calls.push('yify'); return true; };
  m.downloadGestdown = async () => { calls.push('gestdown'); return true; };
  m.downloadAddic7ed = async () => { calls.push('addic7ed'); return true; };
  m.downloadOpenSubtitles = async () => { calls.push('opensubtitles'); return true; };

  await m.downloadSubtitle('id', '/x', 'YIFY', 'https://yifysubtitles.ch/subtitle/a.zip');
  await m.downloadSubtitle('id', '/x', 'Gestdown', 'https://api.gestdown.info/subtitles/download/s');
  await m.downloadSubtitle('id', '/x', 'Addic7ed', 'https://www.addic7ed.com/original/1/0');
  await m.downloadSubtitle('id', '/x', 'OpenSubtitles', null);
  assert.deepStrictEqual(calls, ['yify', 'gestdown', 'addic7ed', 'opensubtitles']);
}

async function main() {
  testZipExtraction();
  await testYifySearchAndDownload();
  await testGestdownSearchAndDownload();
  testOpenSubtitlesIsOptionalNotRequired();
  await testDownloadDispatchRoutesBySource();
  console.log('subtitle-scrapers.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
