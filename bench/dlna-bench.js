'use strict';
/*
 * DLNA discovery benchmark — NEW CAPABILITY, no prior-version baseline.
 *
 * V0.17 (git HEAD, last pushed commit) has no DLNA/UPnP code at all — WebTorrent-only,
 * no casting of any kind. This benchmark therefore does NOT compare old-vs-new; it just
 * honestly characterizes how core/dlna-caster.js's discover() behaves on its own, on
 * whatever network this machine happens to be running on right now.
 *
 * discover({ timeout, debug }) does SSDP M-SEARCH multicast to 239.255.255.250:1900 PLUS
 * a unicast /24 sweep from every non-internal local IPv4 interface, and resolves via a
 * timer after `timeout` ms. debug:true also populates getLastRaw() with every raw SSDP
 * responder seen (even ones that didn't expose AVTransport and so got filtered out of
 * the final device list) — that split is what lets this report distinguish "nothing on
 * this network answered SSDP at all" from "things answered but none were media renderers".
 *
 * USAGE
 *   node bench/dlna-bench.js
 *
 * Results render to bench/dlna-results.md.
 */

const fs = require('fs');
const path = require('path');
const dlna = require('../core/dlna-caster.js');

const RESULTS_MD = path.join(__dirname, 'dlna-results.md');
const TIMEOUTS = [2000, 5000, 8000];
const HARD_CAP_MS = 15000; // per-call safety cap so a hung discover() can't hang the benchmark

function raceWithCap(promise, capMs) {
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), capMs);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

async function runOne(timeout) {
  process.stdout.write(`Running discover({ timeout: ${timeout}, debug: true }) ... `);
  const t0 = Date.now();
  const capMs = timeout + HARD_CAP_MS; // requested timeout + slack for describe() HTTP calls
  const result = await raceWithCap(dlna.discover({ timeout, debug: true }), capMs);
  const elapsedMs = Date.now() - t0;

  if (result && result.__timedOut) {
    console.log(`HARD-CAP HIT after ${elapsedMs}ms (discover() did not resolve within ${capMs}ms)`);
    return {
      timeout, elapsedMs, devicesFound: 0, rawResponders: 0, timedOut: true, devices: [],
    };
  }

  const devices = Array.isArray(result) ? result : [];
  const raw = dlna.getLastRaw() || [];
  console.log(`done in ${elapsedMs}ms — ${devices.length} device(s), ${raw.length} raw SSDP responder(s)`);
  return {
    timeout, elapsedMs, devicesFound: devices.length, rawResponders: raw.length, timedOut: false, devices, raw,
  };
}

async function main() {
  console.log('DLNA device discovery benchmark (core/dlna-caster.js) — new capability, no old-version baseline');
  console.log(`Timeout values under test: ${TIMEOUTS.join(', ')}ms (sequential, one run each)\n`);

  const runs = [];
  for (const timeout of TIMEOUTS) {
    // Sequential on purpose — concurrent runs would share/collide on UDP sockets bound
    // to the same local interfaces.
    // eslint-disable-next-line no-await-in-loop
    const r = await runOne(timeout);
    runs.push(r);
  }

  const totalDevices = runs.reduce((sum, r) => sum + r.devicesFound, 0);
  const totalRaw = runs.reduce((sum, r) => sum + r.rawResponders, 0);
  const anyTimedOut = runs.some((r) => r.timedOut);

  const lines = [];
  lines.push('# DLNA Device Discovery Benchmark');
  lines.push('');
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## What this is (and isn\'t)');
  lines.push('');
  lines.push(
    'This benchmarks `core/dlna-caster.js`\'s `discover()` — SSDP M-SEARCH multicast to '
    + '239.255.255.250:1900 plus a unicast sweep of each local interface\'s /24 — at three '
    + 'timeout budgets. **This is a brand-new capability**: the last pushed commit (V0.17, '
    + 'git HEAD) has no DLNA/UPnP code at all, so there is no old-version number to compare '
    + 'against. This report is *not* an old-vs-new comparison for this dimension — it only '
    + 'characterizes the new version\'s discovery behavior on its own, on whatever network '
    + 'this benchmark happened to run on.'
  );
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Timeout requested | Devices found | Raw SSDP responders seen | Actual elapsed |');
  lines.push('|---|---|---|---|');
  for (const r of runs) {
    const elapsedStr = r.timedOut ? `${r.elapsedMs}ms (HARD-CAP HIT)` : `${r.elapsedMs}ms`;
    lines.push(`| ${r.timeout}ms | ${r.devicesFound} | ${r.rawResponders} | ${elapsedStr} |`);
  }
  lines.push('');

  lines.push('## Notes');
  lines.push('');
  lines.push(
    '- "Devices found" = entries in the returned array, i.e. SSDP responders whose device-description '
    + 'XML was fetched and confirmed to expose an `AVTransport` service (so they are actually castable '
    + 'MediaRenderers).'
  );
  lines.push(
    '- "Raw SSDP responders seen" = every distinct SSDP `LOCATION` response captured via `getLastRaw()` '
    + '(with `debug: true`), regardless of whether it turned out to expose AVTransport. This is what '
    + 'separates "nothing answered SSDP on this network" from "things answered, none were media renderers".'
  );
  lines.push(
    '- "Actual elapsed" is wall-clock time for the `discover()` call to resolve. It should land close to '
    + 'the requested timeout, since `discover()` resolves via a `setTimeout(finish, timeout)` — the extra '
    + 'few ms is `describe()` HTTP fetches for any SSDP responders plus `Promise.all(pending)` before the '
    + 'promise settles.'
  );
  if (anyTimedOut) {
    lines.push(
      `- **One or more runs hit the benchmark's own ${HARD_CAP_MS}ms hard-cap wrapper** (requested timeout `
      + '+ slack) without `discover()` resolving — see the per-run detail below. This would point at a bug '
      + 'in `discover()`\'s own timer/cleanup path, since the function is documented to always resolve via '
      + 'its internal timeout.'
    );
  }
  lines.push('');

  lines.push('## Bottom line');
  lines.push('');
  if (totalDevices === 0 && totalRaw === 0) {
    lines.push(
      '**Zero DLNA/UPnP devices and zero raw SSDP responders were detected across all three runs.** '
      + 'This is a plausible, valid result for a dev machine / sandboxed or virtualized network with no '
      + 'real smart TVs or other UPnP MediaRenderers on the same LAN segment — it is not evidence of a bug '
      + 'in `discover()`. To get a non-zero result, this benchmark needs to run on a network segment that '
      + 'actually has a DLNA-capable TV or renderer reachable (and, for the multicast path, one that '
      + 'forwards SSDP multicast to this host — the unicast /24 sweep is the fallback for networks that don\'t).'
    );
  } else if (totalDevices === 0 && totalRaw > 0) {
    lines.push(
      `**No AVTransport-capable MediaRenderers were found, but ${totalRaw} raw SSDP responder(s) did answer** `
      + 'across the three runs. That means something on this network responds to SSDP M-SEARCH but doesn\'t '
      + 'expose an AVTransport service in its device-description XML (or `describe()` couldn\'t fetch/parse '
      + 'it) — i.e. it isn\'t a usable cast target, not that discovery itself is broken.'
    );
  } else {
    const names = Array.from(new Set(runs.flatMap((r) => (r.devices || []).map((d) => `${d.name} (${d.model || 'unknown model'})`))));
    lines.push(
      `**Real DLNA MediaRenderer(s) were detected on this network.** Distinct device(s) seen across runs: `
      + names.map((n) => `\`${n}\``).join(', ') + '.'
    );
  }
  lines.push('');

  fs.writeFileSync(RESULTS_MD, lines.join('\n'));
  console.log(`\nResults written to ${RESULTS_MD}`);
  console.log(`Totals: ${totalDevices} device(s) found, ${totalRaw} raw SSDP responder(s) seen across ${runs.length} runs.`);

  process.exit(0);
}

main().catch((e) => {
  console.error('Benchmark failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
