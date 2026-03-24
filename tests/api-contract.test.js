'use strict';

const assert = require('assert');
const { startServer, stopServer, getServerUrl } = require('../server');

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const server = startServer(0);
  await new Promise((resolve) => server.once('listening', resolve));
  assert.strictEqual(startServer(server.address().port), server, 'startServer should reuse the in-process server on the same port');
  assert.match(String(getServerUrl() || ''), /^http:\/\/(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const legacy = await requestJson(`${base}/api/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet: 'magnet:?xt=urn:btih:TEST',
        playerMode: 'native-js',
      }),
    });
    assert.strictEqual(legacy.status, 400);
    assert.match(String(legacy.data.error || ''), /Legacy fields/i);

    const invalidToken = await requestJson(`${base}/api/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet: 'magnet:?xt=urn:btih:TEST',
        subtitleToken: 'invalid-token',
      }),
    });
    assert.strictEqual(invalidToken.status, 400);
    assert.match(String(invalidToken.data.error || ''), /token/i);

    const invalidHistory = await requestJson(`${base}/api/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        magnet: 'magnet:?xt=urn:btih:TEST',
        history: {
          type: 'tv',
          item: {},
        },
      }),
    });
    assert.strictEqual(invalidHistory.status, 400);
    assert.match(String(invalidHistory.data.error || ''), /history\.item\.tmdbId/i);

    const missingSubtitle = await requestJson(`${base}/api/subtitles/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingSubtitle.status, 400);
    assert.match(String(missingSubtitle.data.error || ''), /subtitle required/i);

    const watchlist = await requestJson(`${base}/api/watchlist`);
    assert.strictEqual(watchlist.status, 200);
    assert.ok(watchlist.data.watchlist, 'watchlist response should include watchlist object');
    assert.ok(Array.isArray(watchlist.data.items), 'watchlist response should include flat items array');

    const missingEventFields = await requestJson(`${base}/api/recommendations/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingEventFields.status, 400);
    assert.match(String(missingEventFields.data.error || ''), /eventType, type, and tmdbId/i);

    const status = await requestJson(`${base}/api/stream/status`);
    assert.strictEqual(status.status, 200);
    assert.ok(Array.isArray(status.data), 'status response should be an array');
    for (const row of status.data) {
      assert.strictEqual(row.mode, 'native-js');
    }

    const openVlc = await requestJson(`${base}/api/stream/open-vlc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(openVlc.status, 409);
    assert.match(String(openVlc.data.error || ''), /Player is still starting/i);

    console.log('api-contract.test.js passed');
  } finally {
    await stopServer();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
