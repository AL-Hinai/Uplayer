# Uplayer Documentation

## Overview

Uplayer is a standalone streaming system with:

- CLI flow: `uplayer`
- Web flow: `uplayer web`
- One player runtime mode: native local JS player

There is no user-visible lightweight or player-variant mode.

## Install

```bash
npm install
```

## Run

Web:

```bash
npm run web
# or
uplayer web
```

CLI:

```bash
uplayer "Movie Name"
```

Direct sources:

```bash
uplayer --magnet "magnet:?xt=urn:btih:..."
uplayer --torrent /path/to/file.torrent
```

Cleanup:

```bash
uplayer clean
```

## Environment

Use `.env` (see `.env.example`):

- `TMDB_API_KEY`
- `OPENSUBTITLES_API_KEY`
- `OPENSUBTITLES_USERNAME`
- `OPENSUBTITLES_PASSWORD`
- `PORT` (default `3000`)

Startup validation prints warnings when keys are missing.

## Web API

### `POST /api/subtitles/download`

Input:

```json
{ "subtitle": { "id": "..." } }
```

Output:

```json
{
  "filename": "sub_...srt",
  "subtitleToken": "...",
  "tokenExpiresAt": 1712345678901,
  "tokenTtlMs": 7200000
}
```

### `POST /api/stream/start`

Input:

```json
{ "magnet": "magnet:?xt=...", "subtitleToken": "optional" }
```

Output:

```json
{ "sessionId": "stream_...", "mode": "native-js" }
```

Rejected legacy fields:

- `subtitlePath`
- `playerMode`
- `noSubtitles`

### `GET /api/stream/status`

Output list includes:

- `id`
- `running`
- `playerUrl`
- `started`
- `mode` (always `native-js`)
- `exited`
- `exitedAt`

## UX and Reliability Notes

- Web wizard preserves stream state in session storage for refresh recovery.
- Stream page re-attaches to active session and restores live indicator.
- Retry actions exist for torrent search, subtitle search/download, and stream start.
- Server stream lifecycle enforces idempotent teardown and single-session behavior.

## Deprecated Compatibility Flags

These are accepted but no-op in CLI:

- `--low-memory`
- `--no-subtitles`

## Tests

```bash
npm run test:core
npm run test:api-contract
npm run test:lifecycle
npm run test:stream-speed
```

`test:stream-speed` requires a valid magnet input (`--magnet` or `UPLAYER_TEST_MAGNET`).
