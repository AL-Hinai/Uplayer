'use strict';
// Diagnose "web starts then stops": start a stream on the running server, then watch
// whether the HLS EVENT playlist keeps growing (ffmpeg producing) or stalls.
const http = require('http');
function reqJson(port, method, path, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 8000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b || 'null')); } catch (e) { res(b); } });
    });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
function getText(port, path) {
  return new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', timeout: 8000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => res({ status: x.statusCode, body: b }));
    });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGNET = process.argv[2] || 'magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=OnePiece&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce';

(async () => {
  console.log('starting stream...');
  const start = await reqJson(3000, 'POST', '/api/stream/start', { magnet: MAGNET });
  console.log('start ->', JSON.stringify(start));
  let cast = null, fmt = null;
  for (let i = 0; i < 40; i++) {
    const st = await reqJson(3000, 'GET', '/api/stream/status');
    const s = Array.isArray(st) ? st[0] : null;
    if (s && s.castUrl) { cast = s.castUrl; fmt = s.videoFormat; break; }
    await sleep(1500);
  }
  if (!cast) { console.log('no castUrl (player_ready never fired)'); process.exit(0); }
  console.log('castUrl:', cast, '\nformat:', JSON.stringify(fmt));
  const idxPath = new URL(cast).pathname;
  console.log('\nwatching HLS playlist growth (' + idxPath + '):');
  let last = -1, stalls = 0;
  for (let i = 0; i < 14; i++) {
    const r = await getText(8000, idxPath);
    if (r.err) { console.log('t=' + (i * 3) + 's  ERR ' + r.err); }
    else {
      const segs = (r.body.match(/seg\d+\.ts/g) || []).length;
      const endlist = /#EXT-X-ENDLIST/.test(r.body);
      const grew = segs > last;
      if (!grew && last >= 0 && !endlist) stalls++;
      console.log('t=' + (i * 3) + 's  status=' + r.status + '  segments=' + segs + '  grew=' + grew + (endlist ? '  [ENDLIST]' : ''));
      last = segs;
      if (endlist) { console.log('\nffmpeg finished cleanly (full file transcoded).'); break; }
    }
    await sleep(3000);
  }
  console.log('\n' + (stalls >= 3 ? 'DIAGNOSIS: HLS playlist STALLED — ffmpeg stopped producing segments (this is the "starts then stops").' : 'HLS playlist grew steadily (healthy).'));
  process.exit(0);
})();
