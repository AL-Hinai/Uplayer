# Uplayer - Simple Torrent Player

Stream movies instantly from the command line using WebTorrent.

**One command. Works on Linux, macOS, Windows.**

```bash
./setup.sh
uplayer "Inception"
```

---

## Installation

```bash
# 1. Clone or download
git clone https://github.com/yourusername/uplayer.git
cd uplayer

# 2. Run installer
./setup.sh

# 3. Use anywhere!
uplayer "Inception"
```

**What the installer does:**
- ✅ Detects your system (Linux/macOS/Windows)
- ✅ Installs runtime (Bun or Node.js) if needed
- ✅ Installs all dependencies
- ✅ Creates global `uplayer` command
- ✅ Configures PATH automatically

**Time:** ~30 seconds

---

## Usage

```bash
# Search and stream
uplayer "Movie Name"

# Interactive mode
uplayer

# Direct magnet link
uplayer --magnet "magnet:?xt=urn:btih:..."

# Torrent file
uplayer --torrent /path/to/movie.torrent

# Low memory mode (for <8GB RAM)
uplayer --low-memory "Movie Name"

# Help
uplayer --help
```

---

## Features

- 🔍 **Smart Search**: Automatically finds torrents from multiple sources
- 🎬 **TMDB Integration**: Search movies and TV shows
- 📺 **Instant Streaming**: Start watching before download completes
- 📝 **Multi-Language Subtitles**: Choose from English, Arabic, Spanish, French, German, and more
- 🚀 **One-Command Install**: Works on Linux, macOS, Windows
- 🧠 **Smart Memory**: Prevents crashes on low-RAM systems
- ⚡ **Fast**: 10-50 MB/s streaming speeds
- 🔒 **Strict Isolation**: Files sandboxed with no-execute, auto-cleanup, 5GB limit

---

## Options

| Option | Description |
|--------|-------------|
| `--magnet <link>` | Use a direct magnet link |
| `--torrent <file>` | Use a torrent file |
| `--low-memory` | Enable low-memory mode (prevents crashes) |
| `--no-subtitles` | Disable subtitle processing (saves ~50MB RAM) |
| `--no-open` | Don't auto-open the player |
| `--debug-memory` | Enable detailed memory tracking |
| `-h, --help` | Show help message |
| `-V, --version` | Show version number |

---

## Requirements

**Automatic (installer handles these):**
- Bun or Node.js (auto-installed if missing)
- All npm dependencies

**Manual:**
- Media player: VLC, MPV, or MPlayer
  ```bash
  # Linux
  sudo apt install vlc
  
  # macOS
  brew install --cask vlc
  
  # Windows
  # Download from https://www.videolan.org/vlc/
  ```

---

## Troubleshooting

### "uplayer: command not found"
```bash
source ~/.bashrc  # or ~/.zshrc, or restart terminal
```

### Browser crashes?
```bash
uplayer --low-memory --no-subtitles "Movie"
```

### Installation fails
```bash
# Install Node.js manually from https://nodejs.org
# Then run: npm install
```

### Slow streaming?
- Choose torrents with more seeders
- Check your internet connection

### Player won't open?
```bash
uplayer --no-open "Movie"
# Then manually open: http://localhost:8000/video.mp4 in VLC
```

**More help:** See [DOCUMENTATION.md](DOCUMENTATION.md)

---

## Uninstall

```bash
rm -f ~/.local/bin/uplayer
# Remove "# Uplayer" section from ~/.bashrc or ~/.zshrc
```

---

## Storage & Privacy

### 🔒 Strict Isolation (NEW!)

Uplayer now uses **strict sandbox isolation** for maximum security:

- ✅ **RAM-based storage** (Linux): Files stored in `/dev/shm` (RAM), not disk
- ✅ **5GB size limit**: Prevents filling your disk
- ✅ **No file execution**: Downloaded files cannot run (no-execute permissions)
- ✅ **No path escape**: Files cannot leave sandbox directory
- ✅ **Owner-only access**: Restricted permissions (0o700)
- ✅ **Auto-cleanup**: Removes files on exit or after 1 hour
- ✅ **Stream-only**: Files only accessible for streaming, nothing else

### Temporary Files

- **Location**: `/dev/shm/stream-sandbox-*` (Linux RAM) or `/tmp/stream-sandbox-*`
- **Size**: Maximum 5GB enforced
- **Cleanup**: Automatic on exit (Ctrl+C, timeout, crash, or normal exit)
- **Monitoring**: Checks every 5 minutes, removes old files

### Manual Cleanup

```bash
# Clean all temp files
rm -rf /tmp/webtorrent /dev/shm/stream-sandbox-*

# Check disk usage
du -sh /dev/shm/stream-sandbox-* /tmp/webtorrent 2>/dev/null
```

### Privacy

- No tracking or analytics
- No data collection
- All streaming is peer-to-peer
- Temporary files auto-deleted
- Files isolated from your system

---

## Legal Notice

This tool is for educational purposes. Please respect copyright laws and only stream content you have the right to access.

---

## Documentation

📚 **[Complete Documentation](DOCUMENTATION.md)** - Full feature guide:
- Memory Management
- Performance Optimizations
- Subtitle Support
- TMDB Integration
- Troubleshooting
- Technical Architecture

---

**Made with ❤️ for easy movie streaming**
