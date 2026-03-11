# Uplayer - Documentation

Complete guide for Uplayer torrent streaming application.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Usage](#usage)
3. [Memory Management](#memory-management)
4. [Subtitle Support](#subtitle-support)
5. [TMDB Integration](#tmdb-integration)
6. [Troubleshooting](#troubleshooting)
7. [Command Reference](#command-reference)

---

## Quick Start

### Installation

```bash
# 1. Clone
git clone https://github.com/yourusername/uplayer.git
cd uplayer

# 2. Run installer
./setup.sh

# 3. Use anywhere!
uplayer "Inception"
```

The installer automatically:
- Detects your system
- Installs Bun or Node.js if needed
- Installs dependencies
- Creates global `uplayer` command
- Configures PATH

---

## Usage

### Basic Commands

```bash
# Search and stream
uplayer "Movie Name"

# Interactive mode
uplayer

# Direct magnet link
uplayer --magnet "magnet:?xt=urn:btih:..."

# Torrent file
uplayer --torrent /path/to/movie.torrent

# Low memory mode
uplayer --low-memory "Movie Name"
```

### Workflow

1. **Search**: Enter movie name
2. **Select**: Choose from results (sorted by seeders)
3. **Subtitles**: Choose if you want subtitles and select language (English, Arabic, etc.)
4. **Stream**: Automatically starts streaming
5. **Play**: Opens in your media player (VLC/MPV)
6. **Watch**: Start watching while downloading!

---

## Memory Management

### Why It Matters

WebTorrent streaming can use significant RAM. Uplayer includes smart memory management to prevent crashes.

### Quick Commands

```bash
# Low memory systems (<8GB RAM)
uplayer --low-memory --no-subtitles "Movie"

# Normal systems (8GB+ RAM)
uplayer --low-memory "Movie"

# Debug memory usage
uplayer --debug-memory "Movie"
```

### Memory Modes

| Mode | Memory Usage | Best For |
|------|--------------|----------|
| Default | ~600-800MB | 16GB+ RAM systems |
| Low-Memory | ~200-300MB | 8GB RAM systems |
| Ultra Low (no subs) | ~150-250MB | 4GB RAM systems |

### Features

**Adaptive Buffer Management**
- Dynamic chunk sizing (0.5-10MB)
- Reduces chunk size under load
- Prevents memory exhaustion

**Stream Backpressure**
- Pauses when buffers full
- Resumes when drained
- Prevents overflow

**Aggressive Cleanup**
- Keeps only necessary pieces
- Removes old pieces (200+ behind)
- Runs every 10 seconds

**Browser Auto-Cleanup**
- Monitors every 2 seconds
- Preventive cleanup at 60% usage
- Emergency cleanup at 80% usage

**Garbage Collection**
- Periodic cleanup every 2 minutes
- On-demand after streams
- Optional: `--expose-gc` for low-memory mode (run: `node --expose-gc uplayer.js`)

---

## Subtitle Support

### Automatic Download

Uplayer automatically searches and downloads subtitles from:
- OpenSubtitles.com
- Addic7ed

### Subtitle Features

- **Auto-detection**: Finds best match by movie name and year
- **Multi-language**: Supports multiple languages including English, Arabic, Spanish, French, German, Italian, Portuguese, Russian, Chinese, Japanese, and Korean
- **Language selection**: Interactive prompt to choose your preferred subtitle language
- **Auto-sync**: Syncs with video automatically
- **Embedded support**: Extracts embedded subtitles from MKV files

### Disable Subtitles

```bash
# Save ~50MB RAM
uplayer --no-subtitles "Movie"
```

### Manual Subtitle Loading

If auto-download fails:
1. Download subtitle file (.srt)
2. Place in same directory as video
3. Name it same as video file
4. VLC will load it automatically

---

## TMDB Integration

### What is TMDB?

The Movie Database (TMDB) provides accurate movie information:
- Release years
- Movie titles
- TV show episodes
- Better search results

### Setup (Optional)

```bash
# Set your API key
export TMDB_API_KEY="your_api_key_here"

# Add to ~/.bashrc for permanent
echo 'export TMDB_API_KEY="your_key"' >> ~/.bashrc
```

Get free API key: https://www.themoviedb.org/settings/api

### Without TMDB

Uplayer works fine without TMDB:
- Uses direct torrent search
- Slightly less accurate results
- No API key needed

---

## Troubleshooting

### "uplayer: command not found"

```bash
# Reload shell config
source ~/.bashrc  # or ~/.zshrc

# Or restart terminal
```

### Browser/Player Crashes

```bash
# Use low memory mode
uplayer --low-memory --no-subtitles "Movie"

# Check available RAM
free -h  # Linux
vm_stat  # macOS
```

### "Port already in use" (EADDRINUSE)

```bash
# Kill previous instance
killall node  # or: killall bun

# Or wait 30 seconds for auto-cleanup
```

### No Torrents Found

- Check internet connection
- Try different search terms
- Use more specific movie name
- Include year: "Inception 2010"

### Slow Streaming

- Choose torrents with more seeders (10+)
- Check internet speed (need 5+ Mbps for HD)
- Close other downloads
- Try different torrent

### Player Won't Open

```bash
# Don't auto-open player
uplayer --no-open "Movie"

# Then manually open in VLC
vlc http://localhost:8000/video.mp4
```

### Subtitles Not Found

- Movie might be too new/old
- Try different subtitle language
- Download manually from opensubtitles.org
- Disable with `--no-subtitles`

### Installation Fails

```bash
# Install Node.js manually
# Visit: https://nodejs.org

# Then install dependencies
npm install

# Create global command manually
echo '#!/bin/bash' > ~/.local/bin/uplayer
echo 'node /path/to/uplayer/uplayer.js "$@"' >> ~/.local/bin/uplayer
chmod +x ~/.local/bin/uplayer
```

---

## Command Reference

### Options

| Option | Description | Example |
|--------|-------------|---------|
| `--magnet <link>` | Use direct magnet link | `uplayer --magnet "magnet:?xt=..."` |
| `--torrent <file>` | Use torrent file | `uplayer --torrent movie.torrent` |
| `--low-memory` | Enable low-memory mode | `uplayer --low-memory "Movie"` |
| `--no-subtitles` | Disable subtitle download | `uplayer --no-subtitles "Movie"` |
| `--no-open` | Don't auto-open player | `uplayer --no-open "Movie"` |
| `--debug-memory` | Show memory usage | `uplayer --debug-memory "Movie"` |
| `-h, --help` | Show help | `uplayer --help` |
| `-V, --version` | Show version | `uplayer --version` |

### Environment Variables

```bash
# TMDB API key (optional)
export TMDB_API_KEY="your_api_key"

# Custom install directory
export INSTALL_DIR="$HOME/bin"
```

### Examples

```bash
# Basic usage
uplayer "Inception"

# Low memory system
uplayer --low-memory "Interstellar"

# No subtitles (save RAM)
uplayer --low-memory --no-subtitles "The Matrix"

# Direct magnet link
uplayer --magnet "magnet:?xt=urn:btih:..."

# Torrent file
uplayer --torrent ~/Downloads/movie.torrent

# Interactive mode
uplayer

# Don't open player
uplayer --no-open "Movie"

# Debug memory
uplayer --debug-memory "Movie"
```

---

## System Requirements

### Minimum

- **OS**: Linux, macOS, Windows (WSL/Git Bash)
- **RAM**: 4GB (8GB recommended)
- **Internet**: 5+ Mbps for HD streaming
- **Runtime**: Bun or Node.js (auto-installed)
- **Player**: VLC, MPV, or MPlayer

### Recommended

- **OS**: Linux (best performance)
- **RAM**: 8GB+
- **Internet**: 25+ Mbps for 4K
- **Runtime**: Bun (fastest)
- **Player**: VLC (most compatible)

---

## Storage & Privacy

### 🔒 Strict Sandbox Isolation (NEW!)

Uplayer now includes **strict isolation** for complete security:

**Security Features:**
- ✅ **RAM-based storage** (Linux): Files in `/dev/shm` (RAM), never touch disk
- ✅ **5GB size limit**: Prevents disk space issues
- ✅ **No execution**: Files cannot run (permissions: 0o600, no +x)
- ✅ **No path escape**: Cannot copy/move files outside sandbox
- ✅ **Owner-only**: Restricted access (permissions: 0o700)
- ✅ **Stream-only**: Files only for streaming, nothing else
- ✅ **Auto-cleanup**: Removes files on exit or after 1 hour
- ✅ **Cross-platform**: Works on Linux, macOS, Windows

**How It Works:**
```
Your Files              Strict Sandbox
┌──────────┐           ┌──────────────┐
│Documents │    ❌     │ Temp Files   │
│Photos    │ ←─────→   │ Max 5GB      │
│Work      │  Blocked  │ No execute   │
└──────────┘           │ Auto-delete  │
                       └──────────────┘
                              ↓
                       ┌──────────────┐
                       │ HTTP Stream  │
                       │ (Read-only)  │
                       └──────────────┘
                              ↓
                       ┌──────────────┐
                       │ VLC Player   │
                       │ (Safe)       │
                       └──────────────┘
```

### Temporary Files

**Locations:**
- **Linux**: `/dev/shm/stream-sandbox-*` (RAM, fastest, most secure)
- **macOS**: `/tmp/stream-sandbox-*` (Disk, isolated)
- **Windows**: `%TEMP%\stream-sandbox-*` (Disk, isolated)

**Properties:**
- **Size**: Maximum 5GB enforced
- **Permissions**: 0o700 (directory), 0o600 (files, no execute)
- **Cleanup**: Every 5 minutes (removes files older than 1 hour)
- **Auto-delete**: On exit (Ctrl+C, crash, timeout, normal exit)

### Privacy

- ✅ No tracking or analytics
- ✅ No data collection
- ✅ All streaming is peer-to-peer
- ✅ Temporary files auto-deleted
- ✅ Files completely isolated from system
- ✅ RAM storage (Linux) - no disk traces

### Cleanup

```bash
# Automatic cleanup (happens on exit)
# - Ctrl+C (SIGINT)
# - Kill signal (SIGTERM)
# - Program crash
# - Normal exit
# - After 1 hour (periodic cleanup)

# Manual cleanup (if needed)
rm -rf /tmp/webtorrent
rm -rf /dev/shm/stream-sandbox-*
rm -rf /tmp/stream-sandbox-*

# Check disk usage
du -sh /dev/shm/stream-sandbox-* /tmp/webtorrent 2>/dev/null
```

### Security Details

**What's Protected:**
- ✅ Disk space (5GB limit enforced)
- ✅ File execution (no files can run)
- ✅ Path traversal (cannot escape sandbox)
- ✅ System isolation (restricted permissions)
- ✅ Resource limits (size and age monitoring)

**What's NOT Protected:**
- ⚠️ Network privacy (use VPN for anonymity)
- ⚠️ Virus scanning (use antivirus if concerned)
- ⚠️ Legal issues (respect copyright laws)

**Recommendation:**
- Download only from trusted sources (YTS, RARBG)
- Use VPN for privacy
- Video files (.mp4, .mkv) are safe in VLC/MPV
- Never run .exe or script files

---

## Performance Tips

### Choose Good Torrents

- **High seeders** (10+): Faster streaming
- **Reasonable size**: 1-3GB for movies
- **Good quality**: 720p or 1080p

### Optimize System

```bash
# Use low-memory mode
uplayer --low-memory "Movie"

# Close other applications
# Free up RAM

# Use wired connection
# Better than WiFi for streaming
```

### Player Settings

**VLC:**
- Tools → Preferences → Input/Codecs
- Network Caching: 3000ms
- Disk Caching: 1000ms

**MPV:**
- Add to `~/.config/mpv/mpv.conf`:
  ```
  cache=yes
  cache-secs=10
  ```

### Compare CLI vs Web stream speed

To measure the difference in time-to-stream-ready between running uplayer from the CLI and from the web UI:

1. **Web test:** Start the server in one terminal: `npm run web`
2. In another terminal run: `npm run test:stream-speed`

The script times how long until the stream is ready (CLI: in-process `StreamManager`; Web: server spawns `uplayer.js`). Optional args:

- `--magnet "magnet:?..."` — use a specific torrent (e.g. Mercy.2026)
- `--cli-only` — run only the CLI benchmark
- `--web-only` — run only the Web benchmark (server must be running)
- `--server-url http://localhost:3000` — web server URL

---

## Uninstall

```bash
# Remove command
rm -f ~/.local/bin/uplayer

# Remove PATH entry
# Edit ~/.bashrc or ~/.zshrc
# Remove "# Uplayer" section

# Remove dependencies (optional)
cd uplayer
rm -rf node_modules

# Remove temporary files
rm -rf /tmp/webtorrent
```

---

## Legal Notice

This tool is for **educational purposes only**.

- Respect copyright laws
- Only stream content you have rights to access
- Torrenting copyrighted material may be illegal in your country
- Use responsibly and legally

---

## Support

- **Issues**: https://github.com/yourusername/uplayer/issues
- **Documentation**: This file
- **Quick Guide**: README.md

---

**Made with ❤️ for easy movie streaming**
