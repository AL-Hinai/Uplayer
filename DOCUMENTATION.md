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

## Chromecast & TV Casting

Uplayer supports casting to Chromecast devices and opening streams directly on TV browsers.

### Features

- **Chromecast Support**: Cast video streams to any Chromecast-enabled device on the same network
- **TV Browser Mode**: Open streams directly on Samsung, LG, and Google TV browsers
- **Subtitle Support**: Select and cast subtitles with the video stream
- **Volume Control**: Adjust volume remotely during casting
- **Session Persistence**: Cast sessions survive page refresh (5-minute window)
- **Status Indicator**: Navbar indicator shows cast connection state

### How to Cast

1. **Start a stream** using the web interface
2. **Click the Cast icon** in the navbar (or the "Cast / TV" button on the stream page)
3. **Select a subtitle track** (optional)
4. **Click "Choose Chromecast"** and select your device
5. **Control playback** using the cast modal (volume, stop casting)

### Cast Status Indicator

The navbar shows a cast icon with status:

- **Gray icon**: Cast available, not connected
- **Green pulsing dot**: Actively casting
- **Device name**: Shows when connected

Click the indicator anytime to open the cast control modal.

### TV Browser Mode

For TVs without Chromecast:

1. Open the Cast / TV modal
2. Find the "Open on TV" section
3. **Scan the QR code** or **copy the link**
4. Open the link in your TV's browser

The TV browser mode works on:
- Samsung Tizen browsers
- LG webOS browsers
- Chromecast with Google TV
- Any TV with a web browser

### Requirements

- **Chromecast**: Requires Chrome or Edge browser on localhost or HTTPS
- **Same Network**: Both PC and TV must be on the same local network
- **Network IP**: Uplayer automatically uses your local network IP for cast URLs

### Troubleshooting

**"Cast unavailable" message:**
- Open Uplayer on `http://localhost:3000` in Chrome or Edge
- Chromecast requires a secure context (localhost or HTTPS)

**Can't find Chromecast device:**
- Ensure Chromecast is powered on and on the same network
- Check firewall settings allow local network discovery
- Restart the Chromecast device

**Video doesn't play on TV:**
1. Click "Test TV Readiness" in the Cast modal
2. Check that all tests pass (green checkmark)
3. If issues are found, follow the recommendations shown
4. Common fixes:
   - Open Uplayer from your network IP instead of localhost
   - Ensure the stream has fully started before casting
   - Try a different torrent (some formats may not be TV-compatible)

**VLC can't open the stream ("Your input can't be opened"):**
- Uplayer now automatically uses your network IP for VLC (e.g., `http://192.168.x.x:8000`)
- If VLC still fails:
  1. Check Windows Firewall allows VLC to access local network
  2. Make sure your network profile is set to "Private" not "Public"
  3. Try opening VLC manually and pasting the network URL
  4. Reinstall VLC from videolan.org if problem persists

**No subtitles on cast:**
- Select subtitle track before starting cast
- Some formats may not support external subtitles
- Try a different subtitle language

**Cast stops unexpectedly:**
- Check network connectivity
- Ensure the streaming PC doesn't go to sleep
- Restore session by reopening the cast modal (5-minute window)

**TV browser link doesn't work:**
- Ensure your TV and PC are on the same network
- Check that the PC firewall allows incoming connections
- Try copying the link manually instead of scanning QR code
- Use the "Test TV Readiness" button to verify the stream is accessible

### Testing TV Readiness

Before casting to your TV, use the built-in readiness test:

1. Start a stream in Uplayer
2. Open the Cast / TV modal
3. Click **"Test TV Readiness"**
4. Review the results:
   - **✓ TV Ready!** - All tests passed, TV can receive the stream
   - **Issues found** - Follow the recommendations to fix connectivity
   - **Not ready** - Start a stream first or check your network

The test verifies:
- Cast URL is accessible from the network (not localhost)
- Subtitle manifest is accessible
- Stream is running properly

### Performance Optimization

Uplayer includes several optimizations for TV casting and VLC playback:

**Format Support:**

| Device | Video Formats | Subtitle Support | Transcoding |
|--------|--------------|------------------|-------------|
| **VLC** | MKV, MP4, AVI, HEVC, H.264, VP9 | Embedded + External | ❌ No (native) |
| **Chromecast** | MP4, WebM, MKV (limited), HEVC | External VTT only | ❌ No (native) |
| **Web Browser** | MP4, WebM (HEVC needs transcoding) | External VTT only | ✅ Yes (HEVC only) |

**Server-side optimizations:**
- **No transcoding for VLC/Cast** - Original format preserved for best quality
- **Large initial chunk (10MB)** - TV devices receive more data upfront for faster startup
- **Large range chunks (50MB)** - Reduces request overhead during playback
- **8MB stream buffer** - Smooths out network variations
- **TCP no-delay** - Reduces latency by disabling Nagle's algorithm
- **Cache headers** - Allows TV devices to cache stream metadata

**Client-side optimizations:**
- **BUFFERED stream type** - Allows seeking and reduces buffering latency
- **Network IP detection** - Automatically uses accessible network addresses
- **Session persistence** - Survives page refresh (5-minute window)

**Tips for best performance:**
1. Use VLC for best format compatibility (MKV, HEVC, embedded subtitles)
2. Use a wired Ethernet connection for the streaming PC when possible
3. Ensure your TV and PC are on the same network segment (not guest networks)
4. Close other bandwidth-intensive applications during casting
5. For 4K content, ensure your network has sufficient bandwidth (25+ Mbps)

### API Extensions

Cast-related session data is available via `/api/stream/status`:

```json
{
  "id": "stream_123",
  "running": true,
  "playerUrl": "http://localhost:8000/video.mp4",
  "vlcUrl": "http://192.168.1.50:8000/video.mp4",
  "castUrl": "http://192.168.1.50:8000/video.mp4",
  "subtitleManifestUrl": "http://192.168.1.50:8000/api/subtitles"
}
```

- `castUrl`: Network-accessible URL for casting (uses machine IP, not localhost)
- `vlcUrl`: Network-accessible URL for VLC
- `playerUrl`: Localhost URL for local playback
