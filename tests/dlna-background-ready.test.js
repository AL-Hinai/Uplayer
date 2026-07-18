'use strict';

// Verifies the Cast popup shows DLNA TVs discovered in the BACKGROUND immediately, and a
// refresh-in-progress never hides them. The old behaviour checked `dlnaScanning` before
// the device list, so any in-progress scan replaced the list with "Scanning the network
// for DLNA TVs…" — which the user saw every time they opened the popup.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadCastHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('const CAST_SENDER_SCRIPT');
  const end = source.indexOf('function goBackFromWizard', start);
  assert.notStrictEqual(start, -1, 'cast helper constants not found');
  assert.notStrictEqual(end, -1, 'cast helper block not found');

  const context = {
    module: { exports: {} },
    exports: {},
    Promise, Map, URL, console,
    wizard: { sessionId: null, playerUrl: null, vlcUrl: null, castUrl: null, subtitleManifestUrl: null, titleText: 'Demo' },
    state: { currentPage: 'stream' },
    fetchJson: async () => ({ subtitles: [] }),
    navigate: () => {}, toast: () => {}, navigator: {},
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: () => null, getElementsByTagName: () => [], head: { appendChild: () => {} } },
    window: { location: { protocol: 'http:', hostname: 'localhost', port: '3000', pathname: '/index.html', search: '', hash: '#/stream', href: 'http://localhost:3000/index.html#/stream' } },
    escape: escapeHtml, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nmodule.exports = { renderCastTvModalContent, castTvState };`,
    context
  );
  return context.module.exports;
}

const META = { playerUrl: 'http://192.168.1.50:8000/abc/', vlcUrl: 'http://192.168.1.50:8090/stream/x.mkv?play', castUrl: 'http://192.168.1.50:8000/abc/video.mkv' };
const STATE = { senderAllowed: false, senderHelperUrl: 'http://localhost:3000/#/stream', subtitleOptions: [], selectedSubtitleTrackId: '' };

function render(helpers) {
  return helpers.renderCastTvModalContent(META, STATE);
}

function testDevicesShownWhileRefreshing() {
  const h = loadCastHelpers();
  // Background scan already found a TV, and a refresh is in progress.
  h.castTvState.dlnaDevices = [{ id: 'tv1', name: 'Living Room TV', model: 'LG webOS' }];
  h.castTvState.dlnaScanning = true;
  h.castTvState.dlnaCasting = false;
  const html = render(h);

  assert.ok(html.includes('Living Room TV'), 'discovered TV must be listed immediately');
  assert.doesNotMatch(html, /Scanning the network for DLNA TVs/, 'must NOT replace the list with a scanning message');
  assert.match(html, /Refreshing/, 'a subtle refreshing hint is shown instead');
}

function testScanningOnlyWhenNothingFound() {
  const h = loadCastHelpers();
  h.castTvState.dlnaDevices = [];
  h.castTvState.dlnaScanning = true;
  h.castTvState.dlnaCasting = false;
  const html = render(h);
  assert.match(html, /Scanning the network for DLNA TVs/, 'first scan with nothing found still shows scanning');
}

function testDevicesShownWhenIdle() {
  const h = loadCastHelpers();
  h.castTvState.dlnaDevices = [{ id: 'tv1', name: 'Bedroom TV' }];
  h.castTvState.dlnaScanning = false;
  h.castTvState.dlnaCasting = false;
  const html = render(h);
  assert.ok(html.includes('Bedroom TV'), 'cached device listed when idle');
  assert.doesNotMatch(html, /Refreshing/, 'no refreshing hint when not scanning');
  assert.doesNotMatch(html, /Scanning the network/, 'no scanning message when devices are cached');
}

function main() {
  testDevicesShownWhileRefreshing();
  testScanningOnlyWhenNothingFound();
  testDevicesShownWhenIdle();
  console.log('dlna-background-ready.test.js passed');
}

main();
