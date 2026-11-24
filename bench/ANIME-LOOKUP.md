# Anime episode lookup — name matching vs id matching

Run date: 2026-11-24, Windows 10, residential connection. Raw data:
`anime-lookup-results.json`. Script: `anime-lookup-bench.js`.

Two ways to turn "this episode" into "these torrents":

- **Name** — what the app does today. `core/episode-numbering.js` derives a profile from
  TMDB (romaji and season-scoped titles, S/E aliases from episode groups, the absolute
  number) and `core/torrent-scraper.js` fans it across five indexers, classifying every
  release name against the profile. The benchmark drives the real code path.
- **Id** — what zenshin does. `api.ani.zip` maps the TMDB id to an AniDB show id and the
  episode to an AniDB episode id; `feed.animetosho.xyz` is queried by those ids. No release
  name is ever parsed.

Path B's eid-filtered rows are correct by construction, so they serve as the reference set
and Path A is scored by how much of it it recovers. The reverse is reported too, because the
eid filter drops every batch and season pack: rows only Path A finds are not automatically
wrong.

Path A's latency is indexer-bound and varies run to run — it hit the scraper's 20s
follow-up budget in every case here. Treat it as an order of magnitude.

---

## Results

| Case | Name path | Id path | Overlap |
|---|---|---|---|
| **Bleach TYBW** S2E14 (abs 380) | 21.2 s, 22 query/source combos, **15 results**, max 77 seeders, 1080p ✓ | 1.7 s, 2 requests, **0 exact** (75 broad), no 1080p — but **33 rows once the cour bridge below is applied** | name-only 14 |
| **One Piece** S13E1 (abs 422) | 21.7 s, 15 combos, **4 results**, max 14 seeders | 2.9 s, 3 requests, **0 exact** (75 broad) | name-only 4 |
| **Frieren** S1E5 (abs 5) | 20.6 s, 12 combos, 11 results, max 36 seeders, 1080p ✓ | 2.7 s, 3 requests, **30 exact**, max **680 seeders**, 1080p ✓ | both 9 · **only-id 21** · only-name 2 · **name recall of the id set: 30%** |
| **Severance** S1E1 (non-anime control) | 20.5 s, 4 combos, 0 results | 0.4 s, 1 request, **declines cleanly** — no AniDB mapping | — |

Read that table twice. **The id path won the easy case decisively and returned nothing at
all on both hard cases.** That is the opposite of what "exact beats inferred" predicts, and
the reason is structural rather than incidental.

## Why the id path returns nothing for Bleach TYBW

The mapping from a TMDB id to an AniDB id is **many-to-one, and ani.zip's reverse index
returns only one of them.**

```
ani.zip?themoviedb_id=30984  →  anidb_id 2369  (the ORIGINAL Bleach, 366 episodes)
                                 has absolute 380?  NO
```

TMDB models Bleach as two seasons: S1 "Bleach" (366 episodes) and S2 "Thousand-Year Blood
War" (50). AniDB and AniList split that second season into **four separate series**:

| AniList id | Title | Episodes | AniDB id | Reports `themoviedb_id` |
|---|---|---|---|---|
| 116674 | BLEACH: Sennen Kessen-hen | 13 | 15449 | **30984** |
| 159322 | …Ketsubetsu-tan | 13 | — | **30984** |
| 169755 | …Soukoku-tan | 14 | — | **30984** |
| 185874 | …Kashin-tan | 10 | — | **30984** |

13 + 13 + 14 + 10 = 50, which is exactly TMDB's season 2. All four claim the same TMDB id,
and the reverse lookup resolves to the original series instead — so the requested absolute
number (380) falls outside the entry the mapping landed on, and the eid lookup finds nothing.

Given the *right* AniDB id the data is there: `aids=15449` returns 75 rows, top result
`[SubsPlease] Bleach - Sennen Kessen Hen (41-50) (1080p) [Batch]` at 86 seeders. The torrents
exist. The mapping is what fails.

**zenshin never hits this** because its catalogue *is* AniList: the user browses to the
"Sennen Kessen-hen" entry directly, so the id in hand is already the right one. Uplayer is
TMDB-keyed, so it would have to resolve TMDB season 2 episode 14 → which of four cours →
which index within that cour. That is `partLengths`-shaped work — the same problem
`episode-numbering.js` already solves from the TMDB side, not a way around it.

One Piece S13E1 fails for a milder version of the same thing plus sparse tagging: the eid
exists, but AnimeTosho's episode-id tagging runs around 44% of rows (measured in
`CATALOG-COMPARISON.md` §6) and is thinnest on older episodes, so the exact query comes back
empty.

## Why the id path wins Frieren so clearly

Single cour, one AniDB entry, recent and well-tagged. It returned **30 exact rows against the
name path's 11**, with a best seeder count of **680 vs 36** — and the name path recovered only
**30% of the correct files**, missing 21 of 30. Those 21 are releases whose names the
classifier could not tie to S01E05 with confidence. The id path does not have to.

## Verdict

**Neither is "the best". They fail in opposite directions.**

| | Name matching | Id matching |
|---|---|---|
| Cour-split / sequel-series anime | **Works** (15 results for TYBW) | **Fails completely** (0) |
| Older episodes of long runs | Works (4 results) | Fails — sparse eid tagging (0) |
| Single-cour recent anime | Weak — 30% recall, 36 seeders | **Strong** — 30 rows, 680 seeders |
| Batches and season packs | Found | Invisible to the eid query |
| Movies, live-action TV | Only option | Declines (correctly) |
| Latency | ~20 s (budget-bound) | 0.4–2.9 s |

So the id lane is **additive, not authoritative**:

1. **Name matching stays the floor.** It is the only path that handles cour splits, old
   episodes, batches and non-anime. It must never be skipped or suppressed because the id
   lane ran.
2. **Run the id lane in parallel and merge.** When it returns rows they are exact and often
   far better seeded; `dedupeTorrentResults` already merges by infohash and keeps the higher
   seeder count, so the merge is free.
3. **An empty id lane means nothing.** 0 exact rows is the normal case for anything
   cour-split or older, so it must not be read as "no such episode" or allowed to shorten
   the name search.
4. **Boosting id-matched rows is still right** — they are exact — but the earlier spec's
   framing of "exact beats inferred" oversold it. It beats inferred *when it answers*, which
   on this sample was one case in three.

## The cour split is solvable — with data the app already has

The conclusion above ("the mapping is what fails") understates what is available. TMDB
*itself* publishes the cour breakdown, and `core/episode-numbering.js` already parses it.

Bleach has 15 episode groups. One of them is:

```
type 4  groups 4  eps 50  |  Hulu Season Split (Thousand-Year Blood War)
```

Four groups, 50 episodes — the same 50 that TMDB calls season 2, split exactly as AniDB
splits it:

| TMDB part | Name | Eps | AniList sibling | Eps |
|---|---|---|---|---|
| 1 | The Blood Warfare | 13 | 116674 Sennen Kessen-hen (2022) | 13 |
| 2 | **The Separation** | 13 | **159322 …Ketsubetsu-tan (2023)** | 13 |
| 3 | The Conflict | 14 | 169755 …Soukoku-tan (2024) | 14 |
| 4 | The Calamity | 10 | 185874 …Kashin-tan (2026) | 10 |

And `buildProfile(30984, 2, 14)` **already returns both halves of the bridge**, with no new
TMDB request:

```
partLengths  [13,13,14,10]
partHints    { part: 2, episode: 1, hint: "the separation", resolved: true }
seasonTitles ["Bleach thousand year blood war", "Bleach sennen kessen hen", "Bleach tybw"]
```

"The Separation" is the cour name `core/episode-numbering.js`'s own header cites as a release
form (`"...The Separation - 01"`). The profile knows this episode is **part 2, episode 1 of a
[13,13,14,10] split**. That is precisely what is needed to choose among the four AniDB
entries.

### Measured end to end

Listing the franchise's AniList entries in release order gives episode counts
`[13, 13, 14, 10]` — an **exact signature match at offset 0**, no other candidate window —
so part 2 resolves to AniList 159322, and from there:

```
anilist 159322 → ani.zip → anidb_id 17765 → episodes["1"].anidbEid = 267537
tosho ?aids=17765&eids=267537  →  33 rows
   best: [ZigZag] BLEACH: Thousand-Year Blood War S02E01 [1080p]  (86 seeders)
```

| Bleach TYBW S2E14 | Rows | Best seeders | 1080p |
|---|---|---|---|
| Name matching | 15 | 77 | ✓ |
| Id lane, naive TMDB→AniDB | **0** | — | ✗ |
| **Id lane + TMDB cour bridge** | **33** | **86** | ✓ |

The worst failure becomes the best result, using data the profile already computed.

### Three caveats before this is treated as solved

1. **Enumerating the siblings is still a text search**, just at the *series* level — the run
   above searched AniList for `seasonTitles[1]` ("Bleach sennen kessen hen"). That is far
   sturdier than matching release names (series titles are stable, it is one query, and the
   count signature validates the answer), but it is not id-to-id, and it inherits the keyless
   problem from `CATALOG-COMPARISON.md` §9: without TMDB those season titles do not exist.
   Walking AniList `relations` from a known entry would remove the text search; not tested.
2. **The count signature breaks on a currently-airing cour.** AniList reports
   `episodes: null` while a season is still airing, so an in-flight cour has no count to
   match and the signature shifts or fails — and that is the case users care about most. The
   fallback used here (take the *n*th entry with the expected length) does not help when the
   length is unknown. This needs its own handling before shipping.
3. **`[13,13,14,10]` is distinctive; `[12,12]` is not.** Shows with repeated equal splits can
   match several windows. The part *name* offers a second signal ("The Separation" ↔
   "Ketsubetsu-tan"), but cross-language title matching is exactly the unreliability this
   whole approach was meant to escape. Prefer release-date ordering plus the count
   signature, and treat an ambiguous match as "no id lane" rather than guessing.

### Correction to the tosho-lane spec

The spec said the id lane would let `episode-numbering.js` and `torrent-name-patterns.js`
"stop being load-bearing" for anime with a mapping. **That is wrong.** A mapping exists for
Bleach and the lane still returns nothing, because the mapping points at the wrong one of
four AniDB series. Those two modules stay load-bearing for exactly the shows they were
written for.

Making the id lane cover cour splits needs a step the spec does not have — and the section
above shows that step is cheap, because `partLengths` and the resolved `partHint` are
already in the profile. The missing piece is only the sibling lookup: list the franchise's
AniList entries in release order and match the ordered episode-count signature. Measured on
Bleach that turns 0 rows into 33, best-seeded 1080p included.

So the revised plan is two pieces, in this order:

1. **The additive lane** (rules 1–4 above), driven by the naive `themoviedb_id` mapping. Safe
   on its own: it helps single-cour shows like Frieren and contributes nothing — rather than
   something wrong — everywhere else.
2. **The cour bridge.** Resolve the sibling entry from `partLengths` + `partHints` before
   querying, subject to the three caveats above, and treat an ambiguous or airing-cour match
   as "no id lane" instead of a guess.

Both keep name matching as the floor. Neither replaces `episode-numbering.js` — piece 2 is
*built on* it, which is the opposite of the spec's original framing.

---

## Shipped — measured through the real search path

Both pieces are implemented: `core/anime-ids.js` (resolution, including the cour bridge) and
`core/tosho-client.js` (the id-keyed source), wired into `searchAllSources` as a `Tosho`
source and resolved in `/api/torrents/search` alongside the numbering profile.

Id resolution, live:

```
Bleach TYBW   S2E14  ->  anidb 17765  eid 267537  [cour-bridge]
Frieren       S1E5   ->  anidb 17617  eid 271708  [direct]
One Piece     S13E1  ->  anidb 69     eid 109084  [direct]
```

Full `searchAllSources`, same profile, with and without the lane:

| Case | Results before | Results after | id-matched rows | Best seeders before → after | New top result |
|---|---|---|---|---|---|
| **Bleach TYBW** S2E14 | 17 | **44** | 26 | 78 → **86** | `[ZigZag] BLEACH: Thousand-Year Blood War S02E01 [1080p REPACK]` |
| **Frieren** S1E5 | 11 | **32** | 21 | 36 → **680** | `[SubsPlease] Sousou no Frieren - 05 (1080p)` |

Nothing was displaced: both counts went up, and the name-matched rows are all still present
below the id-matched ones.

One Piece S13E1 resolves an id but AnimeTosho has no rows tagged with it — sparse tagging on
older episodes, as §"Why the id path returns nothing" predicted. The lane contributes
nothing there and the name path carries the search unchanged, which is rule 3 working as
intended rather than a failure.

### What the tests pin

`tests/anime-ids.test.js` — the cour bridge reaches Ketsubetsu-tan rather than the original
Bleach, and the two refusals (airing cour, ambiguous signature) return null instead of a
guess. `tests/tosho-client.test.js` — the four silent field traps (`article_title` is the
source site; `link` must be the magnet or infohash dedupe breaks; `idMatched` only on
eid-filtered rows; sizes from `total_size`). `tests/id-match-ranking.test.js` — an
id-matched row with an unparseable name survives the `verdictIsMatch` filter, an empty lane
leaves the ranking byte-identical, and no ids means no request.

One behaviour is pinned deliberately because it looks like a bug: a much healthier row that
the classifier also judged to be this episode still outranks a barely-seeded id match. Score
is `seeders + evidence boost`, both rows are the right episode, and preferring the one that
will actually play is correct. `ID_MATCH_BOOST` (2500, above the 2000 an alias S/E tag
earns) decides ties in *evidence*, not in *health*.

*Repro:* `node bench/anime-lookup-bench.js` (needs a TMDB key configured, as the app does).
Note that bench implements its own naive id path — it predates `core/anime-ids.js` and does
**not** use the cour bridge, which is why its Bleach row still reads 0.
