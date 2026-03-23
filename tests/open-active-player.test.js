'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadPlayerHelpers(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const start = source.indexOf('async function resolveActivePlayerUrl');
  const end = source.indexOf('function goBackFromWizard', start);

  assert.notStrictEqual(start, -1, 'resolveActivePlayerUrl not found');
  assert.notStrictEqual(end, -1, 'openActivePlayer block not found');

  const context = {
    module: { exports: {} },
    exports: {},
    Promise,
    console,
    wizard: { playerUrl: null },
    state: { currentPage: 'home' },
    navigate: () => {},
    toast: () => {},
    fetchJson: async () => [],
    window: { open: () => null },
    ...overrides,
  };

  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}\nmodule.exports = { resolveActivePlayerUrl, openActivePlayer };`,
    context
  );

  return {
    ...context.module.exports,
    context,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function testReusesSinglePopupForResolvedUrl() {
  const calls = [];
  const popup = {
    closed: false,
    opener: { active: true },
    location: {
      replace(url) {
        calls.push(['replace', url]);
      },
    },
    close() {
      this.closed = true;
      calls.push(['close']);
    },
  };

  const { openActivePlayer } = loadPlayerHelpers({
    fetchJson: async () => [{ playerUrl: 'http://127.0.0.1:8000', running: true }],
    window: {
      open(...args) {
        calls.push(['open', ...args]);
        return popup;
      },
    },
  });

  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };

  assert.strictEqual(openActivePlayer(event, '#'), false);
  await flushAsyncWork();

  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(popup.opener, null);
  assert.deepStrictEqual(calls, [
    ['open', '', '_blank'],
    ['replace', 'http://127.0.0.1:8000'],
  ]);
}

async function testFallsBackToDirectOpenWhenPopupBlocked() {
  const calls = [];

  const { openActivePlayer } = loadPlayerHelpers({
    fetchJson: async () => [{ playerUrl: 'http://127.0.0.1:9000', running: true }],
    window: {
      open(...args) {
        calls.push(['open', ...args]);
        return calls.length === 1 ? null : { closed: false };
      },
    },
  });

  assert.strictEqual(openActivePlayer(null, '#'), false);
  await flushAsyncWork();

  assert.deepStrictEqual(calls, [
    ['open', '', '_blank'],
    ['open', 'http://127.0.0.1:9000', '_blank', 'noopener'],
  ]);
}

async function testClosesPlaceholderPopupWhenPlayerIsNotReady() {
  const calls = [];
  let navigatedTo = null;
  let toastArgs = null;
  const popup = {
    closed: false,
    opener: { active: true },
    close() {
      this.closed = true;
      calls.push(['close']);
    },
  };

  const { openActivePlayer } = loadPlayerHelpers({
    state: { currentPage: 'movies' },
    navigate(url) {
      navigatedTo = url;
    },
    toast(message, type) {
      toastArgs = [message, type];
    },
    window: {
      open(...args) {
        calls.push(['open', ...args]);
        return popup;
      },
    },
  });

  assert.strictEqual(openActivePlayer(null, '#'), false);
  await flushAsyncWork();

  assert.strictEqual(popup.closed, true);
  assert.deepStrictEqual(calls, [
    ['open', '', '_blank'],
    ['close'],
  ]);
  assert.strictEqual(navigatedTo, '/stream');
  assert.deepStrictEqual(toastArgs, ['Player is still starting', 'info']);
}

async function main() {
  await testReusesSinglePopupForResolvedUrl();
  await testFallsBackToDirectOpenWhenPopupBlocked();
  await testClosesPlaceholderPopupWhenPlayerIsNotReady();
  console.log('open-active-player.test.js passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
