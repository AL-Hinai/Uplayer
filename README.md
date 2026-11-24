# Uplayer

Standalone torrent streaming with one runtime mode:

- `uplayer` for CLI flow
- `uplayer web` for web flow
- Native local JS player only (no mode variants)

## Quick Start

```bash
npm install
npm run web
# or
uplayer web
```

CLI:

```bash
uplayer "Inception"
```

## Commands

```bash
uplayer "Movie Name"
uplayer --magnet "magnet:?xt=urn:btih:..."
uplayer --torrent /path/to/file.torrent
uplayer web
uplayer clean
```

Deprecated compatibility flags (accepted as no-op):

- `--low-memory`
- `--no-subtitles`

## Android (standalone APK)

A native Android app that runs the whole stack **on the phone** (on-device
torrenting + transcoding, serves the LAN URL, opens an external player, and casts
to a TV via the native Google Cast SDK) lives in [`android-app/`](android-app/).
Build it with Android Studio — see [android-app/BUILD.md](android-app/BUILD.md).

## Runtime Behavior

- Single visible player mode: native JS player.
- Subtitle flow is token-based in web API.
- Stream compatibility handling is automatic and silent.
- One active stream session at a time (new start replaces previous).

## Environment

Create `.env` from `.env.example`:

```bash
TMDB_API_KEY=...
OPENSUBTITLES_API_KEY=...
OPENSUBTITLES_USERNAME=...
OPENSUBTITLES_PASSWORD=...
PORT=3000
```

Notes:

- Missing TMDB key limits TMDB-backed catalog routes.
- Missing OpenSubtitles credentials limits subtitle search/download.

## Scripts

```bash
npm run web            # web flow on :3000
npm test               # whole suite — globs tests/*.test.js, no registration step
npm run test:core      # or any single test:<slug>
npm run bench:stream-speed   # benchmarks live in bench/ — untracked, local only
```

## Documentation

| Doc | Answers |
|---|---|
| `docs/DOCUMENTATION.md` | Full user manual — install, run, configure |
| `docs/ARCHITECTURE.md` | Module map, the two design planes, known landmines, migration roadmap |
| `CLAUDE.md` | Conventions to follow when writing code here |
| `android-app/BUILD.md` | Building the Android APK |

Benchmarks are **not** part of the repo. `bench/` is untracked in full — harnesses and
reports alike — because a benchmark measures one machine on one network on one evening, and
a committed report goes stale without any code changing. A checkout only has what whoever
is sitting at it wrote, so the `bench:*` scripts will not run on a fresh clone.

`README.md` and `CLAUDE.md` stay at the repo root by convention (GitHub's entry point, and
Claude Code auto-loads `CLAUDE.md`); every other prose doc lives with what it documents.

## API Notes

- `POST /api/subtitles/download` returns `subtitleToken` and token metadata.
- `POST /api/stream/start` accepts `magnet` and optional `subtitleToken`.
- Legacy stream start fields are rejected: `subtitlePath`, `playerMode`, `noSubtitles`.
- `GET /api/stream/status` returns single-mode session state with `mode: "native-js"`.
