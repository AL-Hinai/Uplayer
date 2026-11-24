# Catalog provider benchmark — TMDB (current setup) vs keyless (Cinemeta + AniList + ani.zip)

Run date: 2026-11-24, Windows 10, residential connection. 3 reps per operation, medians,
all requests sequential. Raw data: `catalog-results.json`. Script: `catalog-bench.js`.

Figures below are from the **second** run of the day. The first run's anime-numbering metric
counted specials in its denominator and reported absolute coverage far too low; §6 records
what the bug was and why the metric is now defined the way it is. Every other dimension is
unchanged between the two runs except for ordinary latency noise.

This measures the **metadata plane** — the question is narrow: can the app replace its TMDB
dependency, and what does that cost or save. Torrent discovery and the streaming engine are
already keyless in both setups and are out of scope. **Subtitles are also already keyless,
but "keyless" turned out not to mean "working"** — §8 reports a separate probe of that path,
because the first-run story is only as good as its weakest plane.

The two sides are:

- **TMDB** — `api.themoviedb.org/3`, requires an API key. What the app does today.
- **Keyless** — Cinemeta (`v3-cinemeta.strem.io`) for movies and TV, AniList
  (`graphql.anilist.co`) for anime, `api.ani.zip` for anime episode numbering. No key,
  no account, no registration.

---

## Read this first: the latency numbers are inflated in keyless's favour

Cinemeta sits behind Cloudflare and serves `Cache-Control: public, max-age=10800` with
`stale-while-revalidate`. TMDB sends `max-age=300` and was not edge-cached during this run
(`X-Cache: Error from cloudfront`). So a large part of the latency gap is *caching policy*,
not provider speed. Measured directly, same method, same machine:

| Cinemeta request | `cf-cache-status` | Time |
|---|---|---|
| `/meta/movie/tt1375666` (Inception) | HIT | 48 ms |
| `/meta/movie/tt0133093` (The Matrix) | HIT | 46 ms |
| `/meta/movie/tt11224722` (an obscure 2019 title) | **MISS** | **537 ms** |

A cold edge for an unpopular title costs ~537 ms — slower than TMDB's typical 145–300 ms in
this harness. **Treat the keyless latency column as a best case for popular content, not a
uniform speedup.** The round-trip and byte counts below are *not* cache-dependent and are
the result that actually matters.

---

## 1. Round trips per operation — the real result

| Operation | TMDB calls | Keyless calls |
|---|---|---|
| Search one query across movies + TV | 2 | 2 |
| Title details | 1 | 1 |
| Every episode of Breaking Bad (5 seasons) | **6** | **1** |
| Every episode of Severance (3 seasons) | **4** | **1** |
| Every episode of Frieren (1 season) | 2 | 1 |
| Every episode of Bleach (2 seasons listed) | 3 | 1 |
| Every episode of One Piece (23 seasons) | **24** | **1** |
| Resolve a movie's IMDb id | **1** | **0** |
| Home page first screen | 3 | 2 |
| **Total across all of the above** | **60** | **22** |

Two structural wins, neither of which depends on caching:

- **Episode lists collapse to one call.** TMDB needs `/tv/{id}` to learn the season list,
  then one `/tv/{id}/season/{n}` per season. Cinemeta's `/meta/series/{imdb}` returns every
  episode of every season in a single `videos[]` array. One Piece is **24 calls → 1**.
- **The IMDb id is free.** `core/subtitle-manager.js` needs an IMDb id for the YIFY
  provider, and today that costs a dedicated `/movie/{id}/external_ids` call
  (`server.js:1077`). Keyless is IMDb-id-native — the id *is* the key every other call
  already used. **1 call → 0.**

## 2. Latency per operation (median of 3; see the caveat above)

| Operation | TMDB | Keyless |
|---|---|---|
| Search "inception" | 267.1 ms | 15.0 ms |
| Search "the matrix" | 272.6 ms | 15.2 ms |
| Search "breaking bad" | 265.5 ms | 15.3 ms |
| Details — Inception | 129.4 ms | 8.2 ms |
| Details — Breaking Bad | 134.3 ms | 8.8 ms |
| All episodes — Breaking Bad | 1,428.6 ms | 8.3 ms |
| All episodes — Severance | 589.0 ms | 8.2 ms |
| All episodes — Bleach | 731.5 ms | 15.5 ms |
| All episodes — One Piece | **4,301 ms** | **24.0 ms** |
| IMDb id — Inception | 129.3 ms | 0 ms (no call) |
| Home first screen | 388.9 ms | 22.1 ms |
| **Total** | **10,250 ms** | **212 ms** |

The One Piece row is the one to trust least on absolute values and most on shape: 24
sequential round trips cannot be fast whatever the cache does, and the keyless side is one
request regardless of season count.

## 3. Bytes moved

| Operation | TMDB | Keyless |
|---|---|---|
| All episodes — Bleach | 1,566 KB | **473 KB** |
| All episodes — One Piece | 1,801 KB | **1,328 KB** |
| All episodes — Frieren | 410 KB | **46 KB** |
| All episodes — Breaking Bad | 311 KB | **38 KB** |
| Details — Breaking Bad | **5 KB** | 38 KB |
| Details — Severance | **3 KB** | 24 KB |
| Home first screen | **39 KB** | **702 KB** |
| **Total** | **4,281 KB** | **2,726 KB** |

Keyless moves ~36% fewer bytes overall, but the distribution is uneven and two rows go the
wrong way:

- **Details calls are fatter keyless** (38 KB vs 5 KB for Breaking Bad) because
  `/meta/series` always includes the full `videos[]` array. That is the same property that
  wins §1 — you cannot ask for the show without the episodes. Net positive, since the app
  wants both.
- **The home screen is 18× heavier keyless** (702 KB vs 39 KB). Cinemeta catalog rows carry
  full cast, writer, director, description and trailer lists for all 50 items, where TMDB's
  trending rows are lean. This is a genuine regression and needs a fix in the provider
  (trim to the card fields before returning) rather than being passed to the client.

## 4. Field completeness on search results

Across 5 queries: 66 TMDB rows, 126 keyless rows.

| Field present | TMDB | Keyless |
|---|---|---|
| Poster | 88% | **100%** |
| Year | 89% | **93%** |
| Rating | **67%** | 0% |
| TMDB id | **100%** | 0% |
| IMDb id | 0% | **100%** |

**This corrects an assumption in the keyless spec.** Cinemeta *catalog* rows (`top`, `year`,
`imdbRating`) carry `moviedb_id` and `imdbRating` on every row — I verified 50 of 50 — but
**search rows are a leaner shape** and carry neither:

```
search row keys: background, behaviorHints, id, imdb_id, links, name, poster,
                 releaseInfo, type
```

Consequence for the implementation: the TMDB id must be resolved **lazily, on open**, from
the `/meta/` call the detail view makes anyway — never eagerly for the results grid, which
would turn one search into N+2 calls. The grid itself only needs name, poster and year, and
has 100% / 93% coverage of those.

### 4b. Rank-1 correctness

| Query | TMDB first result | Keyless first result |
|---|---|---|
| inception | Inception | Inception |
| the matrix | The Matrix | The Matrix |
| breaking bad | El Camino: A Breaking Bad Movie | El Camino |
| severance | Severance | Severance |
| dune part two | Dune: Part Two | Dune: Part Two |

Parity, including the same failure: both rank the *El Camino* film above the *Breaking Bad*
series, because the harness queries the movie catalog first on both sides. That is a
harness artifact, not a provider difference — but it does mean the app's own
movie-before-TV ordering is worth revisiting independently of this decision.

## 5. Capabilities

| Capability | TMDB | Keyless |
|---|---|---|
| Similar / recommendations — **movies and live-action TV** | **20 candidates** | **0 — no keyless graph exists** |
| Similar / recommendations — **anime** | 20 candidates | **25 candidates** (AniList, crowd-rated) |
| `vote_count` quality floor | yes | no (proxy: `imdbRating` presence) |
| `now_playing` / `on_the_air` | yes | no (substitute: `year` catalog) |
| Episode group / alias numbering | yes | anime only, via ani.zip |

The movie/TV similarity graph is **the one unambiguous loss** and the reason this is a
trade, not an upgrade. `core/recommendation-engine.js` is pure and does its own scoring, so
rows still render from genre-filtered catalog candidates — but the candidate pool is
shallower than TMDB's curated graph. For anime, keyless is *ahead*: AniList returned 25
crowd-rated recommendations versus TMDB's 20.

## 6. Anime episode numbering

This is where keyless wins by the widest margin, and it is the case
`core/episode-numbering.js` exists for.

| Show | TMDB episode groups | Calls to read them all | ani.zip | Real episodes | Specials | `anidbEid` | Absolute number |
|---|---|---|---|---|---|---|---|
| Frieren | 5 | **6** | 1 call, 53 KB | 28 | 31 | **100%** | **100%** |
| Bleach | 15 | **16** | 1 call, 522 KB | 366 | 11 | **100%** | **100%** |
| One Piece | 17 | **18** | 1 call, 1,827 KB | 1,184 | 81 | **100%** | **99%** |

TMDB tells you a show has 17 episode groups; reading them costs one call each. ani.zip
returns the whole mapping in one call with **100% `anidbEid` coverage on all three shows** —
and an AniDB episode id is an *exact* identifier that the tosho lane can query directly,
where episode groups only yield numbering aliases that still have to be matched against
release names.

**On how this metric is defined** — the first run of this benchmark reported absolute-number
coverage of 47% / 97% / 92% and concluded ani.zip was patchy. That was a measurement bug,
not a finding. ani.zip keys `episodes` by episode number for real episodes and by `"S<n>"`
for **specials**, and specials carry no `absoluteEpisodeNumber` — correctly, since they have
no place in a running order. 31 of Frieren's 59 keys are specials, so counting them in the
denominator turned 28-of-28 into "47%". Measured over real episodes, coverage is 100% /
100% / 99%.

The only genuine gaps are in One Piece: 14 of 1,184 real episodes lack an absolute number,
and **4 of those (1181–1184) are unaired placeholders** ani.zip creates ahead of broadcast
with no title and no air date. The remaining 10 are old episodes (100, 101, 103, 126, 156,
176, 197, 250, 251, 491) where ani.zip's own record is incomplete — they also lack
`seasonNumber`. The newest *aired* episode (1180) has its absolute number. Over aired
episodes only, coverage is 99%.

## 7. Rate limits as advertised

| Provider | Advertised in response headers |
|---|---|
| TMDB | none sent |
| Cinemeta | none sent |
| AniList | `x-ratelimit-limit: 30` (per minute), `x-ratelimit-remaining: 28` |

**AniList's 30 requests/minute is a real ceiling** and the tightest constraint in the
keyless stack. Anime browsing must batch and cache against it; a naive per-card lookup
would exhaust it in two seconds of scrolling. Neither TMDB nor Cinemeta advertises a limit,
which is not the same as not having one.

## 8. Subtitles with zero configuration

Separate probe, same question. `core/subtitle-manager.js` is documented as "KEYLESS BY
DEFAULT" with four providers that need no credentials plus an optional OpenSubtitles API.
This ran the app's own `SubtitleManager` with the credentials explicitly blanked.

The optional-API design works exactly as its header promises: with no key the
`opensubtitles.com` client is never constructed (`this.client === null`),
`hasOpenSubtitlesCredentials()` is `false`, and nothing throws. What the probe found is that
**two of the four keyless providers return nothing at all.**

| Case (no credentials) | Results | Source | Time |
|---|---|---|---|
| Movie — Inception, English | **15** | YIFY | 11.6 s |
| Movie — Inception, **Arabic** | **15** | YIFY | 11.0 s |
| Movie — Inception, **no IMDb id** | **0** | — | 9.1 s |
| TV — Breaking Bad S01E01, English | **6** | Gestdown | 6.3 s |
| TV — Breaking Bad S01E01, Arabic | **0** | — | 0.4 s |
| Anime — Frieren S01E01, English | **0** | — | 7.8 s |
| Anime — Bleach S01E01, English | **3** | Gestdown | 8.2 s |

Per-provider, probed directly:

| Provider | State |
|---|---|
| **YIFY** (`yifysubtitles.ch`) | **Works.** Language filtering is correct — `en` returns tracks labelled `English`, `ar` returns `Arabic`. Movies only, and **100% dependent on an IMDb id**. |
| **Gestdown** (`api.gestdown.info`) | **Works.** TV only. Also returns a `tmdbId` per show, so it maps cleanly to the app's id space. |
| **SubsPlease** (`subsplease.org/?s=`) | **Dead — since REMOVED.** The search URL answers `Page not found — SubsPlease`, and the site publishes no standalone subtitle files at all: zero `.ass`/`.srt` links on a show page, and `/api/?f=search` returns only magnets. It was never a subtitle provider. |
| **Addic7ed** (`www.addic7ed.com/search.php`) | **Broken — since REMOVED.** The page loads (HTTP 200, 252 KB) but `table.tabel95` no longer exists (the tables carry no class), and the search page lists only the show's *latest* season, so a season-1 lookup could never match. Gestdown serves the same catalogue as JSON. |
| **OpenSubtitles** | Correctly inert without credentials. No crash, no warning per search. |

Three consequences worth acting on, none of which are specific to keyless mode — they apply
to the keyed setup too, since both scrapers sit in the same `Promise.all`:

1. **Anime has no keyless subtitle source.** SubsPlease *was* the anime provider and it is
   dead. Frieren returned 0; Bleach returned 3 only because Addic7ed/Gestdown carry it as an
   ordinary TV show. Note this is survivable rather than fatal: embedded-track extraction
   via ffmpeg and whisper.cpp generation are fully local and need no key or provider — but
   the download path contributes nothing for anime.
2. **Every search waits on two providers that cannot answer.** The 6–11.6 s figures above
   are inflated by that. Removing or fixing them is the single cheapest latency win in the
   subtitle path.
3. **The IMDb id is load-bearing, not incidental.** With it, Inception yields 15 tracks;
   without it, 0. That makes §1's "IMDb id is free keyless" a correctness argument, not just
   a saved round trip — under TMDB the id costs an `/external_ids` call that, if skipped or
   failed, silently zeroes movie subtitles.

Arabic is a coverage gap, not a bug: `LANGUAGE_NAMES` maps `ar` → `Arabic` correctly, and
Gestdown's Arabic endpoint for Breaking Bad S01E01 answers HTTP 200 with
`matchingSubtitles: 0` where English has 6. The data is not there upstream. Arabic *movie*
subtitles do work, via YIFY.

### 8b. After removing the two dead providers

Both were deleted from `core/subtitle-manager.js` (206 lines), their dispatch branches
dropped, and the same probe re-run. **Result counts are identical — 30 YIFY + 9 Gestdown —
so nothing was lost; only the waiting.**

| Case | Before | After |
|---|---|---|
| Movie — Inception, English | 11,567 ms | **1,621 ms** |
| Movie — Inception, Arabic | 11,047 ms | **749 ms** |
| Movie — no IMDb id | 9,116 ms | **0 ms** (no request issued) |
| TV — Breaking Bad S01E01 | 6,257 ms | **39 ms** |
| Anime — Bleach S01E01 | 8,213 ms | **21 ms** |

The surviving providers are now checked by `tools/subtitle-diagnose.js`
(`npm run subtitle-diagnose`), which exits non-zero when a provider that should answer
returns nothing across all of its fixtures. Provider rot is silent by construction here —
every search method returns `[]` on failure so one dead host never fails a search, which is
exactly why nothing reported these two — and that script is the thing that now would.

## 9. Torrent search — where keyless is WORSE

Torrent discovery itself is unaffected by this decision: all five indexers (1337x, YTS,
apibay, nyaa.si, subsplease) need no key today and would not change. What changes is the
**query plan** fed into them, and that is built almost entirely from TMDB fields Cinemeta
does not have.

`core/episode-numbering.js` fetches `/tv/{id}?append_to_response=alternative_titles` for
romaji seeds and `/tv/{id}/episode_groups` for S/E aliases. Measured against the keyless
stack:

| Show | TMDB latin title variants | Keyless (AniList + ani.zip) | TMDB variants keyless misses | TMDB `episode_groups` |
|---|---|---|---|---|
| Frieren | 8 | **13** | 2 | 5 |
| Bleach | 20 | 6 | **12** | 15 |
| Severance (non-anime) | 4 | 1 (Cinemeta `name` only) | 3 | 0 |

**Frieren is a win** — ani.zip and AniList carry more localized titles than TMDB, and the two
misses are a diacritic spelling and an alternate English gloss.

**Bleach is a serious loss, and it is the exact case this app was built for.** The 12 missed
variants are the *season-scoped sequel titles*:

```
"Bleach : Thousand-Year Blood War"   "Bleach Sennen Kessen Hen"
"Burīchi: Sennen Kessen-hen"         "Bleach - Sennen Kessen-hen"
```

Those are what releases are actually named — `core/episode-numbering.js`'s own header cites
`[EMBER] Bleach: Sennen Kessen-hen S01E14` and
`[Anime Time] Bleach - Thousand-Year Blood War - 014` as the strings that must match. They
are missing keylessly because **AniList models each anime season as a separate media entry**:
"Bleach: Sennen Kessen-hen" has its own AniList id, so the parent entry (269) returns only
the original series' titles. Recovering them would mean walking AniList `relations` — a
different data model from TMDB's episode groups, and more work than this spec covers.

**`episode_groups` has no keyless equivalent at all** (15 for Bleach, 5 for Frieren). That is
the source of `seAliases` — the TVDB-order tags like `Bleach S17E42` that Disney+/Hulu rips
carry — and of `partLengths`. Without it, whole query forms disappear from the Nyaa and
PirateBay plans.

Cinemeta provides **no alias field of any kind**: a `/meta/series` payload has `name` and
`slug` and nothing alias-shaped, so non-anime TV loses its alternate titles too (Severance:
4 → 1). That matters far less, since live-action releases use the English title.

**The id-keyed tosho lane does NOT mitigate this — that claim was wrong and has been
measured.** See `ANIME-LOOKUP.md`: querying `feed.animetosho.xyz` by `aids`/`eids` returned
**zero rows for Bleach TYBW**, the very example above, because the TMDB→AniDB mapping is
many-to-one and ani.zip's reverse index resolves TMDB 30984 to the *original* Bleach
(anidb 2369, 366 episodes) while TYBW is four *separate* AniDB series that all claim the same
TMDB id. The requested absolute number falls outside the entry the mapping lands on.

So for cour-split anime, keyless loses the season titles **and** the id lane cannot stand in
for them. The name-matching path — which won that case outright, 15 results to 0 — is the
only thing that works, and it is the path keyless degrades. That makes §9 the strongest
argument in this document for **preferring TMDB whenever a key is present**, rather than a
gap a later feature closes.

---

## Bottom line

| Dimension | Verdict |
|---|---|
| Setup cost | **Keyless wins outright** — zero keys, zero accounts; `needsSetup` stops being true |
| Round trips | **Keyless clearly better** — 60 → 22 calls over the same work; 24 → 1 on One Piece's episode list |
| IMDb id for subtitles | **Keyless better** — 1 call → 0 |
| Anime numbering | **Keyless clearly better** — 1 call vs up to 18, 100% exact episode ids |
| Anime recommendations | **Keyless slightly better** — 25 vs 20 candidates |
| Bytes overall | **Keyless better** (−36%), but the home screen regresses 18× and must be trimmed in the provider |
| Latency | **Keyless much faster on cached content, comparable or slower on cold** — a caching artifact, not a provider property |
| **Torrent query planning** | **TMDB wins, and this is the most consequential loss** (§9) — keyless misses 12 of Bleach's 20 title variants, including every sequel-series title releases are actually named after, and has no `episode_groups` equivalent. Affects whether the file is found at all. |
| Movie/TV recommendations | **TMDB wins** — keyless has no similarity graph at all |
| `now_playing`, `vote_count` | **TMDB wins** — no keyless equivalent |
| Search result metadata | **Split** — keyless has better posters and IMDb ids, TMDB has ratings and its own ids |
| Subtitles with no key | **Already keyless and provider-independent of this decision** — but 2 of 4 providers are dead (§8); keyless mode helps movies by supplying the IMDb id YIFY needs |

**Conclusion.** Keyless is the right *default* and the wrong *replacement*. On the two things
that cost real time — episode-list assembly and anime identification — it is architecturally
better, not incidentally faster, and it makes the app work before anyone has registered for
anything. But §9 is not a rounding error: TMDB's `alternative_titles` and `episode_groups`
are what let the app find a Bleach episode released as "Sennen Kessen-hen", and nothing
keyless replaces them.

So: ship both providers behind one interface; use keyless when there is no key, so the app
works on first launch; and when a key IS present, **prefer TMDB** — it restores the
similarity graph *and* the richer query plan. A TMDB key is not garnish, it is the upgrade.
Sequence the id-keyed tosho lane **before** making keyless the default for anime, or anime
torrent search regresses.

### Amendments this run forces on the keyless spec

1. **Search rows carry no `moviedb_id` and no `imdbRating`.** Resolve the TMDB id lazily on
   open from the `/meta/` call, never eagerly for the grid. The earlier "50 of 50 rows carry
   `moviedb_id`" finding holds for `top`/`year`/`imdbRating` catalogs only.
2. **Trim catalog rows in the provider.** 702 KB for one home screen is not acceptable;
   strip cast/writer/director/trailers/description to the card fields before returning.
3. **Respect AniList's 30 req/min.** Batch anime lookups and cache them; it is the hardest
   limit in the stack.
4. **Keep `episode-numbering.js`'s absolute-number derivation — but not for the reason the
   first run gave.** The coverage argument was a measurement artifact (see §6). The real
   reasons it stays: `computeAbsoluteEpisode` (`core/episode-numbering.js:119`) is a pure
   7-line sum over the `/tv/{id}` payload the profile build has already fetched, so it costs
   **zero HTTP calls** and there is nothing to save by replacing it; and its answer has to
   stay consistent with the TMDB season structure that `seAliases` and `seasonTitles` in the
   *same* query plan are derived from. ani.zip splits seasons differently from TMDB, so
   mixing an ani.zip absolute number into a TMDB-derived query plan would produce incoherent
   queries. Use ani.zip's `anidbEid` for the id-keyed tosho lane and TMDB's derived absolute
   number for the name-keyed indexers; they are inputs to different queries, not rivals.

*Repro:* `node bench/catalog-bench.js` (needs a TMDB key configured, as the app does; the
script aborts rather than report a one-sided comparison without one).
