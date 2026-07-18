'use strict';
// Ad-hoc A/B: original magnet (without our injection) vs enriched (with). Measures how
// fast peers show up for the top-3 recommended titles. Not a unit test — a bench script.
const { TorrServerClient, enrichMagnet } = require('../core/torrserver-client');
const http = require('http');
const fs = require('fs');
const os = require('os');

function ts(body) {
  return new Promise((res) => {
    const d = JSON.stringify(body);
    const q = http.request({ host: '127.0.0.1', port: 8090, path: '/torrents', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) }, timeout: 8000 }, (x) => {
      let b = '';
      x.on('data', (c) => { b += c; });
      x.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } });
    });
    q.on('error', () => res(null));
    q.on('timeout', () => { q.destroy(); res(null); });
    q.write(d); q.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findInfo(hash) {
  const l = await ts({ action: 'list' });
  return (Array.isArray(l) ? l : []).find((x) => String(x.hash || x.Hash || '').toLowerCase() === hash.toLowerCase());
}

async function measure(magnet, hash) {
  await ts({ action: 'add', link: magnet, title: 'ab', save_to_db: false });
  const t0 = Date.now();
  const conn = [];
  let first = null;
  let swarm = 0;
  for (let i = 0; i < 9; i++) {
    await sleep(1000);
    const info = await findInfo(hash);
    const c = (info && (info.active_peers || info.connected_seeders)) || 0;
    swarm = Math.max(swarm, (info && info.total_peers) || 0);
    if (first === null && c > 0) first = ((Date.now() - t0) / 1000).toFixed(1);
    conn.push(c);
  }
  await ts({ action: 'rem', hash });
  await sleep(2500);
  return { first: first || '>9', conn, swarm };
}

(async () => {
  const mags = JSON.parse(fs.readFileSync(os.tmpdir() + '/uplayer_ab_magnets.json')).filter(Boolean);
  const c = new TorrServerClient({ log: () => {} });
  await c.start();
  const R = {};
  for (const mode of ['WITHOUT', 'WITH']) {
    for (const m of mags) {
      R[mode + '|' + m.title] = await measure(mode === 'WITH' ? enrichMagnet(m.magnet, c.extraTrackers) : m.magnet, m.hash);
    }
  }
  console.log('\n=== TOP 3 RECOMMENDED — peer acquisition (connected peers @ t=1..9s) ===\n');
  for (const m of mags) {
    console.log(m.title + ':');
    for (const mode of ['WITHOUT', 'WITH ']) {
      const r = R[mode.trim() + '|' + m.title];
      console.log('  ' + mode + ' | 1stPeer=' + r.first + 's | connected:[' + r.conn.join(',') + '] | swarm=' + r.swarm);
    }
    console.log('');
  }
})();
