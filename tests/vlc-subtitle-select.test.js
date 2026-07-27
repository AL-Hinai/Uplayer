'use strict';

// A corrected subtitle pushed into a running VLC used to arrive as a second track that
// nobody selected, so the viewer kept watching the WRONG timing while the fix sat one
// menu level away. `addsubtitle` does not select what it loads — measured on 3.0.23,
// where the original stayed the current track afterwards.
//
// It can be selected, though, which is what this covers. status.xml lists subtitle
// streams as <category name='Stream N'>, N is the ES id, and `subtitle_track` takes it.
// (The comment that used to sit in server.js said the opposite and was wrong on the very
// version it cited — hence the pinned fixtures below, which are real captures.)
//
// The id is found by DIFFING the list around the add, never by a numbering rule, because
// selecting the wrong id puts the uncorrected subtitle on screen — worse than doing
// nothing. testDiffBeatsGuessingTheHighestId is the one that matters.

const assert = require('assert');
const http = require('http');
const { pushSubtitleToVlc, vlcSubtitleTrackIds } = require('../server.js')._internals;

// Real capture: an MKV with two embedded subtitle tracks plus an external one, after a
// fourth was added. Note the categories are NOT in id order — VLC emits them however it
// likes, so the parser must read the numbers and not the positions.
const XML_FOUR_SUBS = `<root><information>
<category name="meta"><info name='filename'>test.mkv</info></category>
<category name='Stream 0'><info name='Codec'>H264</info><info name='Type'>Video</info></category>
<category name='Stream 1'><info name='Codec'>mp4a</info><info name='Type'>Audio</info></category>
<category name='Stream 3'><info name='Type'>Subtitle</info><info name='Codec'>subt</info></category>
<category name='Stream 5'><info name='Type'>Subtitle</info><info name='Codec'>subt</info></category>
<category name='Stream 4'><info name='Type'>Subtitle</info><info name='Codec'>subt</info></category>
<category name='Stream 2'><info name='Type'>Subtitle</info><info name='Codec'>subt</info></category>
</information></root>`;

const XML_NO_SUBS = `<root><information>
<category name='Stream 0'><info name='Type'>Video</info></category>
<category name='Stream 1'><info name='Type'>Audio</info></category>
</information></root>`;

function testParserReadsIdsNotPositions() {
  assert.deepStrictEqual(vlcSubtitleTrackIds(XML_FOUR_SUBS), [3, 5, 4, 2],
    'ids come from the Stream number, in document order — the caller diffs them as a set');
  assert.deepStrictEqual(vlcSubtitleTrackIds(XML_NO_SUBS), [], 'video and audio are not subtitles');
  assert.deepStrictEqual(vlcSubtitleTrackIds(null), [], 'a failed request is not a crash');
  assert.deepStrictEqual(vlcSubtitleTrackIds(''), []);
}

// Stands in for VLC's --extraintf=http interface. `subs` is the subtitle ES id list it
// reports, which the test mutates to simulate the input thread attaching the new slave.
function fakeVlc(state) {
  const server = http.createServer((req, res) => {
    const q = decodeURIComponent(String(req.url).split('?')[1] || '');
    if (q) state.queries.push(q);
    if (/command=addsubtitle/.test(q)) state.onAdd();
    const cats = state.subs.map((id) =>
      `<category name='Stream ${id}'><info name='Type'>Subtitle</info></category>`).join('');
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<root><information><category name='Stream 0'><info name='Type'>Video</info></category>${cats}</information></root>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      session: { vlcHttp: { port: server.address().port, password: 'x' } },
    }));
  });
}

const cmd = (queries) => queries.map((q) => (q.match(/command=([a-z_]+)/) || [])[1]).filter(Boolean);

// The whole point of diffing. Here the ADDED track gets id 3 while an embedded track
// already holds 5 — so "take the highest id", or "take the last one listed", both pick a
// track that is not ours and put an uncorrected subtitle on screen.
async function testDiffBeatsGuessingTheHighestId() {
  const state = { queries: [], subs: [2, 5], onAdd() { state.subs = [2, 5, 3]; } };
  const { server, session } = await fakeVlc(state);
  try {
    await pushSubtitleToVlc(session, 'C:\\tmp\\fixed.srt', null);
    assert.deepStrictEqual(cmd(state.queries), ['addsubtitle', 'subtitle_track'],
      'the file is loaded and then selected');
    assert.ok(state.queries.some((q) => q === 'command=subtitle_track&val=3'),
      'the NEW id is selected — not the highest (5), not the last listed');
  } finally { server.close(); }
}

// A pure offset must never reach addsubtitle: subdelay fixes the track VLC already has,
// which leaves one track with its original name. Adding a second one here would be a
// regression dressed as a feature.
async function testUniformShiftStillUsesSubdelayOnly() {
  const state = { queries: [], subs: [2], onAdd() { throw new Error('addsubtitle must not be called'); } };
  const { server, session } = await fakeVlc(state);
  try {
    await pushSubtitleToVlc(session, 'C:\\tmp\\fixed.srt', -7000);
    assert.deepStrictEqual(cmd(state.queries), ['subdelay']);
    assert.ok(state.queries.some((q) => q === 'command=subdelay&val=-7'),
      'ms to seconds; a subtitle running 7s late is delayed by -7');
  } finally { server.close(); }
}

// Two new ids means something other than us touched the input. Selecting either is a
// coin flip on whether the viewer sees the corrected subtitle, so select neither — the
// track is loaded regardless and the menu still has it.
async function testAmbiguousAddSelectsNothing() {
  const state = { queries: [], subs: [2], onAdd() { state.subs = [2, 3, 4]; } };
  const { server, session } = await fakeVlc(state);
  try {
    await pushSubtitleToVlc(session, 'C:\\tmp\\fixed.srt', null);
    assert.deepStrictEqual(cmd(state.queries), ['addsubtitle'], 'loaded, but nothing selected');
  } finally { server.close(); }
}

// The slave is attached by the input thread, so the new ES is not in status.xml the
// instant addsubtitle returns — it took ~2s against real VLC. The poll has to outlast
// that without a fixed sleep.
async function testWaitsForTheSlaveToAttach() {
  let polls = 0;
  const state = {
    queries: [], subs: [2],
    onAdd() { /* nothing yet — the ES appears three polls later */ },
  };
  const { server, session } = await fakeVlc(state);
  const realPush = pushSubtitleToVlc(session, 'C:\\tmp\\fixed.srt', null);
  const tick = setInterval(() => { if (++polls === 3) state.subs = [2, 7]; }, 500);
  try {
    await realPush;
    assert.ok(state.queries.some((q) => q === 'command=subtitle_track&val=7'),
      'the late-arriving track is still selected');
  } finally { clearInterval(tick); server.close(); }
}

async function main() {
  testParserReadsIdsNotPositions();
  await testDiffBeatsGuessingTheHighestId();
  await testUniformShiftStillUsesSubdelayOnly();
  await testAmbiguousAddSelectsNothing();
  await testWaitsForTheSlaveToAttach();
  console.log('vlc-subtitle-select.test.js passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
