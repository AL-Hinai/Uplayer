'use strict';
const http = require('http');
function req(port, method, path, body) {
  return new Promise((res) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json' } : {};
    const r = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 6000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b || 'null')); } catch (e) { res(b); } });
    });
    r.on('error', (e) => res({ err: e.message })); r.on('timeout', () => { r.destroy(); res({ err: 'timeout' }); });
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1048576;
(async () => {
  const status = await req(3000, 'GET', '/api/stream/status');
  const s = Array.isArray(status) ? status[0] : null;
  console.log('=== APP STREAM STATUS ===');
  if (!s) { console.log('No active stream session found.'); process.exit(0); }
  console.log('running   :', s.running);
  console.log('player    :', s.playerUrl);
  console.log('cast      :', s.castUrl);
  console.log('format    :', JSON.stringify(s.videoFormat));

  const list = await req(8090, 'POST', '/torrents', { action: 'list' });
  if (!Array.isArray(list) || !list.length) { console.log('\nTorrServer: no torrents (engine may be on a different port)'); process.exit(0); }
  const t = list[0];
  const hash = t.hash || t.Hash;
  console.log('\n=== TORRENT ===');
  console.log('name      :', t.title || t.name);
  console.log('size      :', (((t.torrent_size || 0)) / MB / 1024).toFixed(2), 'GB');

  console.log('\n=== LIVE SPEED (sampling ~9s, non-intrusive) ===');
  const samples = []; let peers = 0, preloaded = 0;
  for (let i = 0; i < 6; i++) {
    const g = await req(8090, 'POST', '/torrents', { action: 'get', hash });
    samples.push(g.download_speed || 0);
    peers = g.active_peers || g.connected_seeders || g.total_peers || peers;
    preloaded = g.preloaded_bytes || preloaded;
    process.stdout.write('.');
    await sleep(1500);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const peak = Math.max.apply(null, samples);
  console.log('\ndownload   : avg ' + (avg / MB).toFixed(2) + ' MB/s  |  peak ' + (peak / MB).toFixed(2) + ' MB/s');
  console.log('peers      :', peers);
  console.log('buffered   :', (preloaded / MB).toFixed(1), 'MB ahead');
})();
