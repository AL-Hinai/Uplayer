# Uplayer — architecture

The structural map of the codebase, the landmines in it, and the plan for fixing them.
`CLAUDE.md` holds the conventions; this holds the map. `README.md` and `docs/DOCUMENTATION.md`
are user-facing and describe none of this.

Every line number here was verified against the working tree on **2026-07-18**. They drift.
Treat a citation that doesn't match as a bug in this document — and fix it, rather than working
around it. The first re-verification pass found the §1 table understating migration progress by
2,400 lines and one landmine contradicting the roadmap two sections below it; a stale map read
with confidence is worse than no map.

The cheapest check, before trusting anything below:
```
wc -l uplayer.js server.js public/js/app.js; ls core/*.js | wc -l
```
If those don't match §1, assume every line citation here has drifted too.

---

## 1. The short version

`core/` is well-structured. The rest is catching up.

| Area | Lines | Was (phase 0) | State |
|---|---|---|---|
| `core/` — 26 modules | 5,821 | 3,780 / 18 | **Good.** Focused, documented, pure/IO separated. The pattern. |
| `public/js/app.js` | 5,607 | 5,618 | Monolith. Entire SPA in one classic script. Untouched. |
| `uplayer.js` | 2,568 | 4,458 | One hard knot (`StreamManager`) + the CLI. |
| `server.js` | 1,591 | 2,139 | No huge functions; ~25 session-coupled routes still inline. |
| `routes/` — 2 modules | 461 | — | 23 routes migrated out of `server.js`. |

**9,766 lines — 57% of the app's code — sit in three files**, down from 12,215 / 76% when this
document was first written. The work ahead is not to invent an architecture. It is to finish the
migration `core/` already started.

---

## 2. `core/` — the pattern

Modules marked **[2a]** / **[1]** / **[3]** were lifted out of the monoliths by the phase named;
the rest predate this document.

| Module | Lines | Responsibility | IO? |
|---|---|---|---|
| `recommendation-service.js` | 677 | Watchlist CRUD, TMDB candidates, section assembly | injected |
| `recommendation-engine.js` | 604 | Scoring, time decay, section building | **pure** |
| `torrent-scraper.js` **[2a]** | 609 | Indexer fan-out (1337x, YTS, PirateBay, Nyaa, SubsPlease) | IO |
| `subtitle-manager.js` **[2a]** | 417 | Provider search/download fan-out, degrades quietly | IO |
| `dlna-caster.js` | 334 | SSDP discovery + AVTransport SOAP control | IO + timers |
| `media-searcher.js` **[2a]** | 310 | TMDB search + HTML-scraper fallback, season/episode lists | IO |
| `torrserver-client.js` | 309 | TorrServer sidecar: spawn, HTTP API, magnet enrichment | IO |
| `torrent-name-patterns.js` | 300 | Release-name parsing, quality tiers, infohash | **pure** |
| `playback-target.js` | 225 | Normalizes what any player is doing into one shape | **pure** |
| `history-store.js` | 209 | Watch history / progress JSON persistence | IO |
| `memory-tracker.js` **[2a]** | 203 | Memory diagnostics behind `--debug-memory` | timers |
| `media-facts.js` | 193 | What the file *is* — codec, resolution, tracks | **pure** |
| `stream-health.js` | 188 | Byte supply — speed, swarm, buffer ahead | **pure** |
| `session-player-state.js` **[1]** | 181 | A session's player-facing URLs, resolved in one place | **pure** |
| `config.js` | 169 | Env / `.env` loading, runtime config | IO |
| `stream-hub.js` **[2a]** | 139 | The one shared HTTP listener; N streams, one port | IO + singleton |
| `torrent-filters.js` **[2a]** | 121 | Dedupe by infohash, size/date parsing, query planning | **pure** |
| `subtitle-tools.js` | 118 | Wraps `alass` + `whisper.cpp`, degrades if absent | IO |
| `stream-lifecycle.js` | 103 | Buffers last playback/health/targets, re-emits | **pure** |
| `network-address.js` | 78 | LAN IPv4 detection, accessible URLs | os only |
| `session-registry.js` **[3]** | 78 | Owns `streamSessions`; defines "the current stream" | in-memory |
| `shared-services.js` | 73 | Composition root (see below) | transitively |
| `subtitle-token-store.js` | 73 | TTL'd subtitle tokens | in-memory |
| `recommendation-store.js` | 62 | Recommendation signal persistence | IO |
| `tmdb-client.js` | 36 | TMDB HTTP client + factory | IO |
| `system-config.js` | 12 | Optional hardcoded constants | pure data |

`stream-hub.js` is the **only** module-level singleton in the stream path, and it is deliberate:
one listener serving N streams under id prefixes beats N bound ports.

**`shared-services.js` is a composition root, not a DI container.** No registry, no `get(name)`.
It builds singletons and returns them. Its important trick is at line 12: the big classes that
live in `uplayer.js` (`MediaSearcher`, `TorrentScraper`, `SubtitleManager`, `StreamManager`) are
**passed in by the caller** rather than required — which is the only reason `core/` never
depends upward on `uplayer.js`. Preserve that.

---

## 3. The two planes

Stream monitoring is deliberately two planes, and keeping them apart is a design decision that
is easy to undo by accident.

- **Byte supply** — `core/stream-health.js`. What the swarm delivers. Session-level, live,
  ticks every second. Emitted as the `stream_health` SSE event.
- **Playback targets** — `core/playback-target.js`. What each player is doing. Per-target
  (`web` | `vlc` | `dlna:<deviceId>` | `cast`). Emitted as `playback` (one report) and
  `targets` (the roster).

They cross in **exactly one place**: `server.js:523`, handing a target's playhead to
`StreamHealth.observePlayhead()`. That crossing exists because "how much buffer is ahead of me"
needs the playhead (target plane) and the average bitrate (supply plane), and neither plane can
answer it alone. The crossing is last-writer-wins across targets, which is why the payload
stamps `buffer.playheadFrom`.

Practical consequence, worth knowing before designing delivery/quality monitoring:

| Target | URL it actually opens | Visible to us? |
|---|---|---|
| Web player | `:8000/…` (our stream server) | yes |
| Chromecast | `:8000/…/hls/index.m3u8` (our stream server) | yes |
| VLC | `:8090/stream/…` (TorrServer direct) | **no** |
| DLNA TV | `:8090/stream/…` (TorrServer direct) | **no** |

VLC and DLNA bypass our process entirely (TorrServer preloads
around the seek position, and proxying through `:8000` capped reads at 10 MB). TorrServer's API
reports **nothing** about its HTTP readers — `bytes_written` is BitTorrent upload to the swarm,
not bytes served to your TV. So per-device delivery rate is unmeasurable for half the targets
without changing that routing.

---

## 4. The monoliths

### `uplayer.js` — 2,568 lines

Phase 2a took clusters A–F out (1,890 lines → `core/`). What remains is exactly the part the
ordering rationale predicted would be hard, plus the CLI:

| Cluster | Lines | Weight | Notes |
|---|---|---|---|
| requires | 1-36 | 36 | 14 of them are `core/*` |
| G — `class StreamManager` | 38-1925 | **1,888** | 74% of the file |
| H — Commander CLI `main()` | 1927-2561 | 635 | default action alone is ~549 |
| re-export facade | 2562-2568 | 7 | pass-throughs of the `core/` imports |

**All the difficulty is in one call chain.** `startStreamingServer` (900-1747) is 847 lines and
contains `requestHandler` (1208-~1720) at ~512. Inside it:

- `let hlsState = null` at **948 is a closure variable, not a field** — per-invocation by design.
- `startHlsPipeline` (1014), `buildVodPlaylist` (1132), `produceSegment` (1150), `ensureSegment`
  (1186) all capture `hlsState` lexically **and** capture `this` (for `activeStreams`,
  `_torrserverStreamUrl`).

The player UI is **already externalized** — `getNativePlayerCSS` (1748) and `getNativePlayerJS`
(1756) are `readFileSync` of `public/player/*`, not string blobs. Only ~16 lines of embedded
markup exist in the whole file (`getNativePlayerHTML`, 1764).

Dead / duplicated still here: `convertSRTtoVTT` (238) delegates to `_legacySrtToVtt` (260).
`getHTMLPlayer` was deleted. The `searchSubsPlease` pair and the `*Scraper` fallback both moved
to `core/` in phase 2a — see the tree comment in §6 for why they were **not** merged.

### `server.js` — 1,591 lines

The inverse: no giant function (largest route is ~120 lines). `streamSessions` (line 104) is now
wrapped by `core/session-registry.js`, so the 19 raw read sites are gone — routes ask
`sessionRegistry.currentStreamSession()` instead.

Clusters: bootstrap 1-68 · express + static 70-71 · store accessors / TMDB proxy 75-120 ·
**route-module mounts 96, 100** · session core + helpers 104-705 · torrents 706-905 ·
subtitles 908-1000 · stream 1002-1277 · cast 1279-1344 · DLNA 1346-1448 · config 1450-1488 ·
SPA catch-all 1490 · server lifecycle 1498-1575 · exports + `_internals` 1576-1591.

Other module state is trivially confined: `sessionCounter` (117) is write-once inside one
function, `PLAYER_MODE` (36) is a string literal.

### `public/js/app.js` — 5,607 lines

Riskiest, because **there is no frontend test coverage** except via the source-slicing hacks
(§5).

Good news: the file is **already pre-sectioned** with 39 `// --- Section ---` banners that match
cluster boundaries, and `public/css/style.css` (2,743) has 30 banner sections in nearly the same
order. It is pre-cut along the seams.

| Group | Weight | % |
|---|---|---|
| Wizard + stream page | ~1,713 | 30.5% |
| Cast / DLNA / native bridges | ~1,683 | 30.0% |
| TMDB browsing / rendering | ~1,097 | 19.5% |
| Stream health + targets + SSE | ~404 | 7.2% |
| History / continue-watching | ~353 | 6.3% |
| Bootstrap / routing / chrome | ~240 | 4.3% |
| Settings / exports | ~127 | 2.3% |

State: `state` (10-19, ~54 refs, easy). `castTvState` (1694-1716, ~178 refs — bundles three
unrelated transports; the `dlna*` fields are cleanly severable, the Chromecast ones are not).
**`wizard` (1647-1688, ~289 refs) is the dominant coupling** — it is simultaneously the wizard
form model, the active-session handle, the live health buffer, and the cast source of truth.
30 declared fields plus 8 undeclared ones added at runtime.

---

## 5. Landmines

Each verified against the working tree. Two claims that *look* true are refuted below — don't
re-derive them.

**1. ~~`server.js:58` defeats its own laziness.~~ RESOLVED (phase 0.)** `PORT` is now the
`getPort()` function at `server.js:65`, so the `server.js ↔ uplayer.js` cycle resolves at call,
not at import. `tests/module-graph.test.js` asserts `uplayer.js` is absent from `require.cache`
after requiring `server.js` — **that test is the only thing keeping this fixed**, because the
regression is a one-line change that looks harmless. Verify by hand:
```
node -e "require('./server.js'); console.log(Object.keys(require.cache).some(k=>k.endsWith('uplayer.js')))"   # → false
```

**2. Three tests read source as text and `vm`-eval a slice.** Markers are raw `indexOf`, so **a
comment mentioning a marker name earlier in the file silently changes what the test runs.**

| Test | Slices | From → to |
|---|---|---|
| `cast-tv-modal.test.js:19-20` | app.js | `const CAST_SENDER_SCRIPT` → `function goBackFromWizard` |
| `cast-tv-modal.test.js:86-87` | app.js | `function updateStreamReadyActions` → `async function wizardStartStream` |
| `dlna-background-ready.test.js:24-25` | app.js | same boundaries as the first |
| `open-active-player.test.js:10-11` | app.js | `function normalizeActiveStreamMeta` → `function goBackFromWizard` |

`goBackFromWizard` is the shared terminator for **three** different slices. All four remaining
slices target `app.js` — phase 4 is what finally kills them (see §7, "How the vm hacks die").

> Phase 1 removed two: `next-episode.test.js` and `open-vlc-target.test.js` are now plain
> `require`s of `public/js/next-episode.js` and `core/session-player-state.js`. With them went
> the `\n}`-terminator hazard this section used to flag as latent.

**3. ~~`tests/stream-manager.test.js` is orphaned.~~ RESOLVED (phase 0.)** `package.json`'s
`test` is now just `node tests/run-all.js`, which globs `tests/*.test.js` — the hand-maintained
`&&` chain that lost this file is gone, and the test was rewritten against the current TorrServer
architecture. One deliberate exclusion remains, listed at `tests/run-all.js:29`:
`cast-tv-modal.test.js`, quarantined over a pre-existing `renderCastTvModalContent` render
regression. 450 lines of cast coverage are not running — **that is a debt, not a decision.**

**4. Three inline-handler globals work only by accident.** `closeModal`, `navigate`,
`goBackFromWizard` are used from `onclick=` but never assigned to `window` — they resolve only
via the classic-script implicit-global rule. There are **50 distinct inline handler names** and
**65 `window.X` assignments**; these three are the gap. Any ESM conversion breaks them silently.

**5. ~~"The current stream" is copy-pasted five times, and one copy diverges.~~ RESOLVED
(phase 3.)** All five sites now call `core/session-registry.js`'s `currentStreamSession()`, and
the one divergent predicate — cast-readiness, which additionally excluded exited sessions — is
the explicit `{ live: true }` option (`server.js:1283`). The invariant *at most one session owns
a running StreamManager* is now written down and observable: the registry emits
`onEvent({type:'multiple-active-sessions'})` when it breaks. **Constraint that outlived the fix:**
`_internals.streamSessions` must keep the same Map identity, because
`tests/vlc-progress.test.js:16` destructures that Map and mutates it directly. Construct once,
never reassign.

**6. `hlsState` (uplayer.js:948) is a closure variable, not a field.** Promoting it to
`this._hlsState` would silently share it across concurrent streams on one StreamManager — two
streams stomping each other's segment dir. That would be a semantic change disguised as a
refactor.

**7. `this._torrserverStreamUrl`** is assigned at `uplayer.js:430` but never declared in the
`StreamManager` constructor, and read at 315, 316, 633, 635, 1006. Latent typo hazard.

**8. `navbarEl` / `hamburgerEl` (app.js:1596-1597)** call `getElementById` at top level. This
works *only* because the `<script>` sits at the end of `<body>`. Any load-order change breaks it.

> **Refuted:** the claim that `app.js` interpolates a function *name* into HTML that must resolve
> at global scope. The call sites (795, 802, 811) render `applyFilters('${type}','${renderFn}')`
> — the name is passed as a **quoted string**, and `applyFilters` (837) dispatches it through an
> explicit if-chain (851-853) calling `renderMovies`/`renderTV`/`renderRecommendations`
> **lexically**. It never goes through `window`. The real constraint is much milder: those four
> functions must end up in the same file, or the render functions must remain reachable.

**9. `pkg` does not bundle the SPA — accepted.** `pkg.assets` covers only
`node_modules/ffmpeg-static/*`, `node_modules/ffprobe-static/bin/**`, `public/player/**`, and
`public/vendor/**`. `index.html`, `public/js/`, and `public/css/` are **not** in a packaged
binary. This is intentional: **the packaged build is CLI-only; the web UI runs from source.**
Consequence for planning: splitting `app.js` into N files is pkg-neutral.

**10. There are two HTTP routers, and two endpoint names exist in both with different
semantics.** `StreamManager.startStreamingServer` (uplayer.js:900) is a hand-rolled
`http.createServer` whose `requestHandler` (1208) string-matches paths — it is a second router
running alongside Express, registered on the shared hub at `uplayer.js:1729`. Two names collide:

| Path | `uplayer.js` (raw router) | `server.js` (Express) |
|---|---|---|
| `/api/subtitles/sync` | 1369 — takes a subtitle **`index`**, self-registers the new track | 973 — takes a **`subtitleToken`**, returns a new token |
| `/api/subtitles/generate` | 1356 — same shape as above | 990 — same shape as above |

Also near-collisions: `/api/progress` (uplayer.js:1305) vs `/api/history/progress`
(routes/library.js:74).

**This is the highest-consequence undocumented hazard in the repo**, because nothing at either
site says the other exists. Fixing a subtitle bug in one leaves the other wrong, and which one a
request reaches depends on which port the player was handed (`:8000` hub vs `:3000` Express) —
see the target/URL table in §3. Phase 2b is what collapses this; until then, **grep both files
for any `/api/subtitles` or `/api/progress` change.**

---

## 6. Target structure

Source line numbers below are **pre-migration coordinates** for the items still marked todo —
they refer to the file as it was when the plan was written, not to today's `uplayer.js`. Today's
coordinates are in §4.

```
core/                      # existing modules unchanged — the pattern
  stream-hub.js            [DONE 2a] the one shared listener + process utils
  media-searcher.js        [DONE 2a]
  subtitle-manager.js      [DONE 2a]
  torrent-filters.js       [DONE 2a] pure result helpers
  torrent-scraper.js       [DONE 2a] requires torrent-filters
  memory-tracker.js        [DONE 2a]
  session-player-state.js  [DONE 1]  applySessionPlayerReady etc.
  session-registry.js      [DONE 3]  owns streamSessions + the invariant
  hls-pipeline.js          ← uplayer.js:948-1206    HlsPipeline class + pure buildVodPlaylist
  http-router.js           ← route array + a matcher that knows 405-vs-404
  stream-routes/           ← uplayer.js:1208-1720   video-range, subtitles, assets, hls, progress
  stream-manager.js        ← uplayer.js:38-1925 remainder
# subsplease-client.js — REJECTED. The two searchSubsPlease methods (SubtitleManager vs
#   TorrentScraper) share a name but not behaviour: one HTML-scrapes subsplease.org/?s= for
#   subtitle files, the other hits /api/?f=search for magnets. Different endpoints, different
#   return types. Not a dedup — the classes keep their own. (Finding from phase 2a.)
routes/                    # register(app, ctx); ctx = { getServices, sessions, onEvent }
  catalog.js library.js    [DONE 3]  the two zero-session-coupling clusters
  sessions.js playback-targets.js vlc-progress.js
  torrents.js subtitles.js stream-lifecycle.js cast.js
  config.js                # MUST register last — it owns the SPA catch-all
cli/                       ← uplayer.js:1927-2561
public/js/                 # classic scripts, dependency order
  state.js next-episode.js api.js chrome.js browse.js history.js
  monitor.js wizard.js cast.js settings.js globals.js
server.js                  # ~80 lines: error guards, express setup, ordered register(), exports
uplayer.js                 # ~30 lines: shebang, require.main guard, unchanged re-export block
```

Three decisions recorded so they aren't relitigated:

**`HlsPipeline` as a class** — not a field (breaks per-invocation isolation, landmine 6), not a
threaded argument (you'd end up passing `{hlsState, streamUrl, activeStreams}`, which is a
hand-rolled class, worse). The class matches the `core/` convention: `activeStreams` and
`_torrserverStreamUrl` become **injected callbacks** instead of reached-for state. Export the
pure `buildVodPlaylist` standalone so it tests without a filesystem — the `stream-health.js`
arrangement.

**`SessionRegistry.currentStreamSession()`** replaces the five-way copy-paste and emits
`onEvent({type:'multiple-active-sessions'})` when the invariant breaks — turning an undocumented
assumption into an observable one. Dedupe is the side benefit; the divergent `1829` predicate is
the point. Constraint: `_internals.streamSessions` must keep the **same Map identity** —
`tests/vlc-progress.test.js:16` destructures that Map and mutates it directly. Construct the Map
once, never reassign; `clear()` calls `Map.clear()`.

**`public/js/globals.js` is the most valuable file in the frontend split**, despite changing
nothing at runtime. It assigns all 65 current `window.X` **plus** the 3 implicit ones — turning
the inline-handler contract from a language accident into a written interface, and making any
future ESM migration mechanical instead of archaeological.

---

## 7. Roadmap

One phase per PR. Each is independently shippable; stop after any of them.

| Phase | Content | Size | Risk | Status |
|---|---|---|---|---|
| 0 | These docs, globbing test runner, PORT fix, 2 pinning tests | ~300 new | ~0 | **DONE** |
| 1 | Two pilot extractions, each deletes a vm-slice hack | ~250 moved | low | **DONE** |
| 2a | `uplayer.js` clusters A–F (zero shared state between them) | ~1,700 moved | low | **DONE** |
| 3 | `server.js` — session registry + route modules | ~2,100 moved | medium | **PARTIAL — 23 of 48 routes** |
| 2b | StreamManager / HLS / requestHandler knot | ~2,100 moved | **high** | todo |
| 4 | `app.js` split (classic scripts) | ~5,600 moved | **high** | todo |
| 5 | Sever `wizard.health/*` → monitor, `castTvState.dlna*` → dlna | ~400 touched | medium | todo |

**Progress (as of this pass).**
- Phase 0 — `tests/run-all.js`, `module-graph.test.js`, `inline-handlers.test.js`; PORT is now
  `getPort()`; the orphaned `stream-manager.test.js` was rewritten against the current TorrServer
  architecture and now runs. Suite: 26 tests, one quarantine (`cast-tv-modal.test.js`, a
  pre-existing render regression unrelated to the split).
- Phase 1 — `public/js/next-episode.js` and `core/session-player-state.js` extracted; both former
  vm-slice tests are now plain `require`s. (While converting `open-vlc-target.test.js` we found its
  old assertions were only passing because the vm sandbox lacked the `URL` global, so the URL
  normalization never ran — the test now exercises the real code.)
- Phase 2a — six modules lifted from `uplayer.js` (4,458 → ~2,570 lines): `stream-hub`,
  `media-searcher`, `subtitle-manager`, `torrent-filters`, `torrent-scraper`, `memory-tracker`.
  `subsplease-client` was investigated and **rejected** — the two `searchSubsPlease` methods are
  different endpoints, not a dedup (see the core/ tree comment).
- Phase 3 — **`core/session-registry.js` done**: it wraps the injected `streamSessions` Map
  (identity preserved for `_internals`), and `currentStreamSession()` replaces all five hand-copied
  finder sites; the one divergent site (cast-readiness, `!exited`) is now the explicit
  `{ live: true }` option. `routes/catalog.js` and `routes/library.js` extracted (the two
  zero-session-coupling clusters), establishing the `register(app, ctx)` pattern.
- **Remaining in Phase 3**: the session-coupled route modules (sessions, playback-targets,
  vlc-progress, torrents, subtitles, stream-lifecycle, cast, config, server-lifecycle). These
  thread more through `ctx` and must keep `config` registered last (SPA catch-all) and
  `_internals` intact — medium risk, covered by `api-contract`.
  Measured: **23 routes migrated, 25 still inline in `server.js`** (~48%). The easy half is
  spent — the two extracted clusters were exactly the ones touching no session state, so
  everything left threads session state through `ctx`. Expect the second half to cost more per
  route than the first.
- **Phases 2b, 4, 5**: not started. 2b and 4 are the high-risk, thin-coverage phases; do them as
  focused PRs with the new tests each requires (see §5 test-coverage ledger in the plan).

**Ordering rationale.** 2a before 2b: `uplayer.js` is mostly trivial text-moves, and all its
difficulty sits in one call chain that is harder than the whole of `server.js`. 3 before 2b: no
giant functions there, and two clusters (433 lines) touch no session state at all. 4 last: it is
the only area with no test coverage.

**Phase 0 specifics.** `tests/run-all.js` globs `tests/*.test.js` and spawns each — killing the
hand-maintained chain and un-orphaning `stream-manager.test.js` (it did fail first run; that was
the point). `tests/module-graph.test.js` asserts `uplayer.js` is absent from
`require.cache` after requiring `server.js` — without it, the PORT fix rots back in two commits.
`tests/inline-handlers.test.js` regexes handler names out of `public/js/*.js` and asserts each is
`window`-assigned or top-level declared — **written against the current file as a control**, it
is the only net Phase 4 will have.

**Frontend stays classic scripts.** ESM would break landmine 4 with zero tests to catch it; its
one real benefit (deferred scripts, which would fix landmine 8) costs three lines to get
directly. Classic scripts make the 5,618-line split a **pure text move** with no reference
rewrites — the only reason it is shippable at all.

**How the vm hacks die.** A split file has no `module.exports`, so tests can't `require` it — but
they can `vm.runInContext(fs.readFileSync('public/js/cast.js'), ctx)`. That is whole-file eval
instead of marker-sliced eval: no `indexOf`, no terminator, no shared boundary, refactor-proof.
Pure-logic files get a guarded `if (typeof module !== 'undefined' && module.exports)` tail and a
plain `require`. Every marker dies; the vm stays.

---

## 8. Explicitly not doing

1. **ESM / bundler / TypeScript / any build step** — "no build step" is load-bearing (`pkg`,
   `bin`, bun).
2. **A test framework** — the plain-assert convention is uniform across 24 files; a ~40-line
   globbing runner gets ~90% of the value with zero dependencies.
3. **Touching `public/player/native-player.js`** — independent IIFE, ES5 on purpose, single
   injected input. It is already what everything else is trying to become.
4. **Deleting the `uplayer.js` facade** — it is `main` *and* `bin`, and `server.js:41` requires it.
5. **Splitting `searchAllSources` (230 lines) per-source** — over-splitting.
6. **Deleting the `*Scraper` fallback (287-493) blind** — instrument it with an event, ship once,
   delete when it never fires.
7. **Decomposing the `wizard` god-object before the file split** — a 289-reference refactor inside
   a 5,618-line file with no test coverage is the worst possible ordering.
8. **Splitting wizard's form-model vs session-handle roles** — defer until a real bug.
9. **Fixing the pkg asset globs** — accepted as CLI-only (landmine 9).
