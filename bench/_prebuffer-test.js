'use strict';
const http = require('http');
function reqJson(port, method, path, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 8000 }, (x) => { let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b || 'null')); } catch (e) { res(b); } }); });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAGNET = 'magnet:?xt=urn:btih:NUOCMTJW26BSPOVZJ53JHNEFCBPM7NQV&dn=OnePiece&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fexodus.desync.com%3A6969%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce';
(async () => {
  const t0 = Date.now();
  await reqJson(3000, 'POST', '/api/stream/start', { magnet: MAGNET });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const st = await reqJson(3000, 'GET', '/api/stream/status');
    const s = Array.isArray(st) ? st[0] : null;
    if (s && s.playerUrl) { ready = true; console.log('PLAYER READY after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's (pre-buffer complete)'); break; }
    await sleep(1000);
  }
  if (!ready) { console.log('did not become ready in 90s'); process.exit(0); }
  const list = await reqJson(8090, 'POST', '/torrents', { action: 'list' });
  const t = (Array.isArray(list) && list[0]) || {};
  console.log('buffered in TorrServer: ' + (((t.preloaded_bytes) || 0) / 1048576).toFixed(0) + ' MB');
  console.log('peers: ' + (t.connected_seeders || t.active_peers || '?'));
  process.exit(0);
})();
