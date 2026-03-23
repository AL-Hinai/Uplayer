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
npm run web
npm run test:core
npm run test:api-contract
npm run test:lifecycle
npm run test:stream-speed
```

## API Notes

- `POST /api/subtitles/download` returns `subtitleToken` and token metadata.
- `POST /api/stream/start` accepts `magnet` and optional `subtitleToken`.
- Legacy stream start fields are rejected: `subtitlePath`, `playerMode`, `noSubtitles`.
- `GET /api/stream/status` returns single-mode session state with `mode: "native-js"`.
