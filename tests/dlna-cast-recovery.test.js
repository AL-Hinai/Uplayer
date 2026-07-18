'use strict';

// Reproduces the "connected to the TV but cast says timeout" bug with a fake renderer:
// SetAVTransportURI's reply is LOST (the renderer drops the socket), yet the TV is really
// playing. play() must VERIFY the transport state and report success — not throw the raw
// network error. A second renderer that is genuinely STOPPED must still fail.

const assert = require('assert');
const http = require('http');
const dlna = require('../core/dlna-caster');

function soapOk(inner) {
  return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<s:Body>' + (inner || '') + '</s:Body></s:Envelope>';
}

// Fake MediaRenderer control endpoint. `transportState` is what GetTransportInfo reports;
// SetAVTransportURI always drops the connection to simulate a lost/slow reply.
function makeRenderer(transportState) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const action = String(req.headers.soapaction || '');
      if (/SetAVTransportURI/.test(action)) { req.socket.destroy(); return; } // reply lost
      if (/GetTransportInfo/.test(action)) {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(soapOk('<u:GetTransportInfoResponse><CurrentTransportState>' + transportState
          + '</CurrentTransportState></u:GetTransportInfoResponse>'));
        return;
      }
      // Stop / Play / anything else → benign OK
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(soapOk(''));
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function withRenderer(transportState, fn) {
  const server = makeRenderer(transportState);
  const port = await listen(server);
  const id = 'fake-' + port;
  dlna._internals.cacheDevice({ id, name: 'Fake TV', model: 'test', address: '127.0.0.1:' + port, controlUrl: 'http://127.0.0.1:' + port + '/ctrl' });
  try { return await fn(id); } finally { server.close(); }
}

async function testRecoversWhenReplyLostButPlaying() {
  await withRenderer('PLAYING', async (id) => {
    const r = await dlna.play(id, 'http://192.168.1.9:8090/stream/x.mkv?link=ab&index=2&play', { title: 'T' });
    assert.ok(r && r.ok, 'cast must SUCCEED when the TV is playing despite the lost SetAVTransportURI reply');
    assert.match(String(r.note || ''), /transport state/, 'success should note it was verified by transport state');
  });
}

async function testStillFailsWhenTvIsStopped() {
  await withRenderer('STOPPED', async (id) => {
    let threw = false;
    try { await dlna.play(id, 'http://192.168.1.9:8090/stream/x.mkv?a=1&b=2', { title: 'T' }); }
    catch (e) { threw = true; assert.match(e.message, /rejected/, 'error should explain the rejection'); }
    assert.ok(threw, 'cast must FAIL when the TV never started playing');
  });
}

async function main() {
  await testRecoversWhenReplyLostButPlaying();
  await testStillFailsWhenTvIsStopped();
  console.log('dlna-cast-recovery.test.js passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
