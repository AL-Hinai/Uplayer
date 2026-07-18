# Uplayer — conventions

Read `docs/ARCHITECTURE.md` for the module map, the design planes, and the known landmines.
This file is the short version: the rules to follow when writing code here.

These conventions are not aspirational. `core/` (26 modules, ~5,800 lines) already follows all
of them. The rest of the codebase is mid-migration toward them. When in doubt, copy
`core/stream-health.js` or `core/playback-target.js`.

## Runtime

- **CommonJS. No `type` field in package.json. No build step, no bundler, no TypeScript.**
  This is load-bearing, not laziness: `package.json` sets both `"main"` and `"bin"` to
  `uplayer.js`, the `pkg` build compiles the CLI to standalone binaries, and bun is a supported
  runtime (`npm run start:bun`). A build step would break all three.
- `'use strict';` on line 1 of every file.
- The frontend is **classic scripts in dependency order** — see "Frontend" below. Do not convert
  it to ESM. There is a specific reason, recorded in `docs/ARCHITECTURE.md`.

## Module shape

- Export a named object literal: `module.exports = { Thing, createThing };`
  Never `module.exports = fn`. (`server.js` is the one exception — it exports the Express app,
  because it must.)
- Prefer a **class + factory pair**: `class TmdbClient` plus `createTmdbClient(apiKey)`.
  See `core/tmdb-client.js:5,29`.
- **Inject callbacks; never reach for a global.** A module that needs to tell someone something
  takes an `onEvent` in its constructor and calls it. It does not import an emitter, a logger,
  or a session map.
  - `core/stream-lifecycle.js:4` — `constructor(onEvent) { this.onEvent = typeof onEvent === 'function' ? onEvent : () => {}; }`
  - `core/playback-target.js:77` — same idiom, with the callback's signature in a JSDoc above it.
  - `core/recommendation-service.js:75` — `constructor({ tmdbClient, historyStore, recommendationStore })`, destructured injection. This is how `core/` avoids ever depending upward on `uplayer.js`.
- **State goes on `this`, not at module level.** The only module-level mutable state in
  `uplayer.js` is the `streamHub` singleton, and that is deliberate. Follow that ratio.

## Documentation in code

Every non-trivial module opens with a prose header that answers two questions:

1. **Why does this module exist** — what question it answers that no other module can.
2. **What it deliberately excludes** — the thing a reader would otherwise assume it does.

Examples worth imitating: `core/playback-target.js:3-16` (explains that position was the only
thing four different players could all report, and that this module is "the missing middle"),
`core/stream-health.js:3-11`, `core/media-facts.js:3-14`.

**State purity in the header.** If a module has no IO and no timers, say so — it is a promise to
the caller and a constraint on the next editor. `core/stream-health.js:11`:

> `// Pure: no IO, no timers. The caller polls TorrServer and hands the stats in.`

**Comments explain constraints and decisions, not mechanics.** The good comments in this repo say
why a number is 0.95 and not 0.9 (`core/playback-target.js:27-34`), or why a payload shape is
frozen (`core/stream-health.js:165-172`). Do not write comments that restate the next line.

## Tests

- Plain `require('assert')`. **No framework** — no jest, no vitest, no `node:test`.
- Shape: `'use strict'`, a prose comment naming the bug or behaviour under test, named
  `testXxx()` functions, a `main()` at the bottom, and `console.log('<file>.test.js passed')`.
  Async tests end `main().catch((err) => { console.error(err); process.exit(1); });`.
- `"test"` is `node tests/run-all.js`, which **globs `tests/*.test.js`** and spawns each in its
  own process. Drop a new `*.test.js` in `tests/` and it runs — no registration step. (The old
  hand-maintained `&&` chain silently orphaned a test file for months; that is why it is gone.)
  A `test:<slug>` script is optional convenience for running one file directly.
- The one exclusion list is `tests/run-all.js:29`. Adding to it needs a stated reason in the
  file — today it holds `cast-tv-modal.test.js`, quarantined over a render regression.
- **`_internals` is the sanctioned test escape hatch.** Export it with the comment
  `// exposed for unit tests`. See `core/dlna-caster.js:333`, `server.js:1584`.
- Prefer testing a pure function over mocking IO. `core/stream-health.js` is pure precisely so
  that `tests/stream-health.test.js` needs no TorrServer.

## Frontend (`public/js/`)

- `public/index.html:94` loads `app.js` as a **classic script** at the end of `<body>`, after
  `next-episode.js` (93). There is no `type="module"`, no `defer` — the order is the dependency
  graph.
- Consequence: **every top-level `function` is an implicit `window` global**, and 50 inline
  `onclick=`/`onchange=` handlers depend on that. Three of them (`closeModal`, `navigate`,
  `goBackFromWizard`) are *only* implicit — never assigned to `window`.
- If you add an inline handler, **assign the function to `window` explicitly** (the block at
  `app.js:5436-5492`). Do not rely on the implicit rule; it is what makes this file hard to split.
- `public/player/native-player.js` is a **separate world**: an independent IIFE, ES5 dialect on
  purpose, served on a server-generated page, its entire input surface is the injected
  `window.__UPLAYER_PLAYER_CONFIG__`. It shares nothing with `app.js`. Keep it that way.

## Two planes — do not collapse them

The stream monitoring code is deliberately split into two planes that answer different questions:

- **Byte supply** (`core/stream-health.js`) — what the swarm is delivering. Session-level.
- **Playback targets** (`core/playback-target.js`) — what each player is doing. Per-target.

They meet in exactly **one** place, on purpose: `server.js:523`, where a target's playhead is
handed to `StreamHealth.observePlayhead()` — because "how much buffer is ahead of me" needs the
playhead (target plane) and the bitrate (supply plane), and neither plane can answer it alone.

If you find yourself adding target state to `stream-health.js`, or byte counters to
`playback-target.js`, stop. Add a new event instead — that is why `stream_health` and `targets`
are separate SSE events rather than one payload.
