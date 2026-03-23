#!/usr/bin/env node
'use strict';

const { StreamManager } = require('./uplayer.js');

const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAGNET = process.env.UPLAYER_TEST_MAGNET || '';

function parseArgs(argv) {
  const args = {
    magnet: DEFAULT_MAGNET,
    cliOnly: false,
    webOnly: false,
    serverUrl: DEFAULT_SERVER_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--magnet') args.magnet = argv[++i] || '';
    else if (token === '--cli-only') args.cliOnly = true;
    else if (token === '--web-only') args.webOnly = true;
    else if (token === '--server-url') args.serverUrl = argv[++i] || DEFAULT_SERVER_URL;
    else if (token === '--timeout-ms') args.timeoutMs = Number(argv[++i] || DEFAULT_TIMEOUT_MS);
  }

  if (!args.magnet) {
    throw new Error(
      'Missing magnet link. Pass --magnet "magnet:?..." or set UPLAYER_TEST_MAGNET in environment.'
    );
  }
  if (args.cliOnly && args.webOnly) {
    throw new Error('Use either --cli-only or --web-only, not both.');
  }
  return args;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCliBenchmark(magnet, timeoutMs) {
  const streamManager = new StreamManager();
  const started = Date.now();

  const timeout = setTimeout(() => {
    streamManager.destroy().catch(() => {});
  }, timeoutMs);

  try {
    const result = await streamManager.stream(magnet, {
      openPlayer: false,
      disableSubtitles: true,
    });
    const elapsedMs = Date.now() - started;
    await streamManager.destroy();
    return { elapsedMs, url: result.url };
  } finally {
    clearTimeout(timeout);
  }
}

async function runWebBenchmark(serverUrl, magnet, timeoutMs) {
  const startRes = await fetch(`${serverUrl}/api/stream/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ magnet }),
  });
  const startData = await startRes.json();
  if (!startRes.ok || !startData.sessionId) {
    throw new Error(startData.error || `Failed to start web stream (${startRes.status})`);
  }

  const sessionId = startData.sessionId;
  const started = Date.now();
  let playerUrl = null;

  try {
    while (Date.now() - started < timeoutMs) {
      const statusRes = await fetch(`${serverUrl}/api/stream/status`);
      const rows = await statusRes.json();
      const row = Array.isArray(rows) ? rows.find((s) => s.id === sessionId) : null;
      if (row && row.playerUrl) {
        playerUrl = row.playerUrl;
        break;
      }
      await sleep(1000);
    }
  } finally {
    await fetch(`${serverUrl}/api/stream/stop/${sessionId}`, { method: 'DELETE' }).catch(() => {});
  }

  if (!playerUrl) {
    throw new Error(`Web stream did not become ready within ${timeoutMs}ms`);
  }

  return { elapsedMs: Date.now() - started, url: playerUrl, sessionId };
}

function printResult(label, result) {
  const secs = (result.elapsedMs / 1000).toFixed(2);
  console.log(`${label}: ${secs}s`);
  console.log(`  URL: ${result.url}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log('Uplayer stream speed benchmark');
  console.log(`Server URL: ${opts.serverUrl}`);
  console.log(`Timeout: ${opts.timeoutMs}ms`);
  console.log('');

  const summary = [];

  if (!opts.webOnly) {
    const cli = await runCliBenchmark(opts.magnet, opts.timeoutMs);
    printResult('CLI', cli);
    summary.push({ label: 'CLI', ...cli });
  }

  if (!opts.cliOnly) {
    const web = await runWebBenchmark(opts.serverUrl, opts.magnet, opts.timeoutMs);
    printResult('Web', web);
    summary.push({ label: 'Web', ...web });
  }

  if (summary.length === 2) {
    const diffMs = summary[1].elapsedMs - summary[0].elapsedMs;
    const faster = diffMs > 0 ? summary[0].label : summary[1].label;
    console.log('');
    console.log(`Difference: ${(Math.abs(diffMs) / 1000).toFixed(2)}s`);
    console.log(`Faster path: ${faster}`);
  }
}

main().catch((err) => {
  console.error(`Benchmark failed: ${err.message}`);
  process.exit(1);
});
