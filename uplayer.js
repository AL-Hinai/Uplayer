#!/usr/bin/env node

// Torrent engine: TorrServer sidecar (see core/torrserver-client.js). The previous
// in-process WebTorrent client was removed in favour of TorrServer, which downloads
// from the swarm and serves the file over HTTP — the same engine on desktop and Android.
const axios = require('axios');
const cheerio = require('cheerio');
const { program } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const open = require('open');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const OpenSubtitles = require('opensubtitles.com');
const { loadEnvFileOnce, getEnv } = require('./core/config');
const { createTmdbClient } = require('./core/tmdb-client');
const { createSharedServices } = require('./core/shared-services');
const { buildAccessibleUrls } = require('./core/network-address');
const { parseName, classify, qualityTier, qualityLabel, extractInfohash } = require('./core/torrent-name-patterns');
const { MIN_POSITION_SEC } = require('./core/playback-target');
const { normalizeProbe, legacyProbeAlias, toVideoFormat } = require('./core/media-facts');
const { StreamHealth, legacyProgressPayload } = require('./core/stream-health');
const { MemoryTracker } = require('./core/memory-tracker');
const { dedupeTorrentResults, filterByPreferredQuality } = require('./core/torrent-filters');
const { TorrentScraper } = require('./core/torrent-scraper');
const { MediaSearcher } = require('./core/media-searcher');
const { SubtitleManager } = require('./core/subtitle-manager');
const {
  streamHub, hiddenChildProcessOptions, waitForServerReady, probeExistingWebServer,
} = require('./core/stream-hub');

loadEnvFileOnce();

// Ceilings on what the subtitle timing auto-fix is allowed to call a fix. Both are
// deliberately far above any real correction — they exist to catch a MISALIGNMENT, not
// to grade one. See StreamManager._implausibleSync for what each one is measuring.
const MAX_PLAUSIBLE_SHIFT_MS = 5 * 60 * 1000;
const MAX_SPAN_WARP = 0.06;

// How much of the film a subtitle has to cover to be a subtitle FOR that film. Asymmetric
// on purpose: subtitles routinely stop a few minutes early (untranslated credits, a song
// left alone), so the floor is generous — but one that runs PAST the end is describing a
// longer cut or a different title, and there is no innocent reason for it.
// See StreamManager._subtitleMisfitReason.
const MIN_SUBTITLE_COVERAGE = 0.4;
const MAX_SUBTITLE_OVERRUN = 1.1;

// Stream manager
class StreamManager extends EventEmitter {
  constructor(lowMemoryMode = false, memoryTracker = null) {
    super();
    // Torrent engine: TorrServer sidecar (downloads from the swarm + serves the file
    // over HTTP). On Android the native side may launch the arm binary and set
    // UPLAYER_TORRSERVER_EXTERNAL=1; otherwise this client spawns the bundled binary.
    
    // One shared, long-lived TorrServer for the whole app (started at boot, stopped on
    // exit) — NOT a per-stream process. Every StreamManager talks to the same engine, so
    // starting/stopping a stream never spawns or kills it.
    const { getSharedClient } = require('./core/torrserver-client');
    this.tsClient = getSharedClient();
    this.currentHash = null;
    
    this.lowMemoryMode = lowMemoryMode;
    this.memoryTracker = memoryTracker;
    this.activeStreams = new Set(); // Track active streams for cleanup
    this.streamBufferSize = 2 * 1024 * 1024; // 2MB buffer (increased from 256-512KB)
    this.maxConcurrentStreams = 10; // Allow more concurrent streams
    this.server = null;
    this.currentTorrent = null;
    
    // SECURITY: Use STRICT sandboxed temp directory with complete isolation
    const SandboxManager = require('./sandbox.js');
    this.sandbox = new SandboxManager({
      useTmpfs: true,           // Use RAM-based storage (Linux)
      useIsolated: true,        // Use isolated directory
      maxSize: '5G',            // Limit to 5GB max
      maxAge: 3600000,          // Clean files older than 1 hour
      autoCleanup: true,        // Auto cleanup on exit
      strictIsolation: true,    // STRICT: No execute, no escape
      noExec: true,             // Prevent execution of any files
      readOnlyForOthers: true   // Only owner can access
    });
    this.tempDir = this.sandbox.createSandbox();
    this.sandbox.startAutoCleanup();
    this.sandbox.setupCleanupHandlers();
    
    const sandboxInfo = this.sandbox.getInfo();
    console.log(chalk.cyan(`STRICT Isolation: ${sandboxInfo.type} (${sandboxInfo.sizeLimit} limit)`));
    console.log(chalk.cyan(`   ? No file execution allowed`));
    console.log(chalk.cyan(`   ? No path escape allowed`));
    console.log(chalk.cyan(`   ? Stream-only access`));
    
    this.subtitlePath = null;
    this.subtitlePaths = []; // Array of all available subtitles with metadata
    this.cleanupInterval = null; // Periodic cleanup timer
    this._cancelPendingStream = null; // Abort in-flight stream setup during teardown
    this._transcodedPath = null; // Path to background-transcoded temp MP4 file
    this._transcodeProc = null;  // ffmpeg child process for background transcoding
    this._bestEncoder = null;    // Cached best encoder result
    
    // ENHANCED: Start periodic memory cleanup in low-memory mode
    if (lowMemoryMode) {
      console.log(chalk.yellow('? Low-memory mode enabled (with maximum speed settings)'));
      console.log(chalk.yellow('   - Max connections: 100 (unlimited)'));
      console.log(chalk.yellow('   - Upload limit: Unlimited'));
      console.log(chalk.yellow('   - Download limit: Unlimited'));
      console.log(chalk.yellow('   - Stream buffer: ' + (this.streamBufferSize / 1024 / 1024) + 'MB'));
      console.log(chalk.yellow('   - Periodic cleanup: Every 2 minutes'));
      
      // Schedule periodic cleanup every 2 minutes
      this.cleanupInterval = setInterval(() => {
        const activeCount = this.activeStreams.size;
        if (activeCount > 0) {
          console.log(chalk.cyan(`Periodic cleanup (${activeCount} active streams)...`));
          this.cleanup();
        }
      }, 120000); // Every 2 minutes
    }
    
    // Cache ffmpeg/ffprobe paths
    this.ffmpegPath = this.findFFmpegBinary('ffmpeg');
    this.ffprobePath = this.findFFmpegBinary('ffprobe');

    // Live byte-supply state for this stream. Fed by the TorrServer stats tick; the
    // playhead crosses in from whichever target is playing (see the registry fan-out).
    this.streamHealth = new StreamHealth();
    this._healthTicker = null; // playback-phase stats poll; outlives the startup bar's tick
    this._destroyed = false;   // stops background retry loops (subtitle auto-sync) at teardown
  }

  // Emit a log line to EventEmitter listeners AND write to stdout (CLI behaviour preserved)
  _log(text) {
    if (this.listenerCount('line') > 0) {
      // In server/in-process mode: emit structured event, suppress stdout
      const lines = String(text).split('\n');
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          this.emit('line', { text: trimmed });
          // Mirror to the embedded-build log sink (Android) for crash diagnosis.
          if (typeof global.__uplayerTee === 'function') global.__uplayerTee(trimmed);
        }
      }
    } else {
      // In CLI mode: write directly to stdout as before
      process.stdout.write(String(text));
    }
  }

  findFFmpegBinary(binaryName = 'ffmpeg') {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');

    // Explicit override for embedded builds (Android nodejs-mobile ships ffmpeg/
    // ffprobe as extracted native libs). Honored before any PATH lookup.
    const overrideEnv = binaryName === 'ffprobe' ? 'UPLAYER_FFPROBE_PATH' : 'UPLAYER_FFMPEG_PATH';
    const overridePath = process.env[overrideEnv];
    if (overridePath && fs.existsSync(overridePath)) {
      return overridePath;
    }

    const lookupCommands = [];
    if (process.platform === 'win32') {
      lookupCommands.push(['where', [`${binaryName}.exe`]]);
      lookupCommands.push(['where', [binaryName]]);
    }
    lookupCommands.push(['which', [binaryName]]);

    for (const [cmd, args] of lookupCommands) {
      try {
        const result = spawnSync(cmd, args, hiddenChildProcessOptions({ encoding: 'utf8' }));
        if (result.status === 0 && result.stdout) {
          const firstMatch = result.stdout
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);
          if (firstMatch) {
            return firstMatch;
          }
        }
      } catch (e) {
        // Ignore and try next lookup strategy
      }
    }

    // Windows fallback: detect common install locations directly (winget/choco/scoop)
    if (process.platform === 'win32') {
      const exeName = `${binaryName}.exe`;
      const candidates = [];

      if (process.env.LOCALAPPDATA) {
        const linksPath = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exeName);
        candidates.push(linksPath);

        const wingetPackagesDir = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
        if (fs.existsSync(wingetPackagesDir)) {
          try {
            const packageDirs = fs.readdirSync(wingetPackagesDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && d.name.toLowerCase().startsWith('gyan.ffmpeg'))
              .map(d => path.join(wingetPackagesDir, d.name));

            for (const packageDir of packageDirs) {
              try {
                const builds = fs.readdirSync(packageDir, { withFileTypes: true })
                  .filter(d => d.isDirectory())
                  .map(d => path.join(packageDir, d.name, 'bin', exeName));
                candidates.push(...builds);
              } catch (e) {
                // Ignore unreadable package variant
              }
            }
          } catch (e) {
            // Ignore unreadable winget package directory
          }
        }
      }

      if (process.env.ProgramData) {
        candidates.push(path.join(process.env.ProgramData, 'chocolatey', 'bin', exeName));
      }

      if (process.env.USERPROFILE) {
        candidates.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'ffmpeg', 'current', 'bin', exeName));
      }

      const foundCandidate = candidates.find(candidate => fs.existsSync(candidate));
      if (foundCandidate) {
        return foundCandidate;
      }
    }

    // Fallback: if executable name itself is callable in PATH
    try {
      const directRun = spawnSync(binaryName, ['-version'], hiddenChildProcessOptions({ stdio: 'ignore' }));
      if (directRun.status === 0) {
        return binaryName;
      }
    } catch (e) {
      // Not callable
    }

    return null;
  }
  
  // Convert SRT/VTT subtitle content to WebVTT.
  // Primary path uses the maintained `subtitle` library, which tolerates partially
  // downloaded/streaming files (subtitles are written progressively as the torrent
  // downloads, so the input is sometimes truncated mid-cue). A permissive inline
  // SRT parser remains as a defensive fallback for the rare case the library throws.
  convertSRTtoVTT(srtContent) {
    if (!srtContent || srtContent.trim() === '') {
      return 'WEBVTT\n\n';
    }
    if (srtContent.trim().startsWith('WEBVTT')) {
      return srtContent;
    }

    try {
      const { parseSync, stringifySync } = require('subtitle');
      const converted = stringifySync(parseSync(srtContent), { format: 'WebVTT' });
      if (converted && converted.trim().startsWith('WEBVTT')) {
        return converted;
      }
    } catch (err) {
      // Library couldn't parse (often a partially-downloaded file) — fall back.
    }

    return this._legacySrtToVtt(srtContent);
  }

  // The inverse, and it exists for exactly one consumer: the DLNA sidecar. A smart TV
  // fetches the subtitle URL we name in the DIDL and parses it ITSELF — and Samsung's
  // sec:CaptionInfoEx path (plus most LG firmwares) understands SRT, not WebVTT. So
  // the same track has to be offerable in both dialects; everything internal to
  // Uplayer stays VTT, since that is what <track> and Chromecast want.
  convertVTTtoSRT(vttContent) {
    if (!vttContent || vttContent.trim() === '') return '';
    if (!vttContent.trim().startsWith('WEBVTT')) return vttContent; // already SRT

    try {
      const { parseSync, stringifySync } = require('subtitle');
      const converted = stringifySync(parseSync(vttContent), { format: 'SRT' });
      if (converted && converted.trim()) return converted;
    } catch (err) {
      // Same reason as above: a track still being extracted can be truncated mid-cue.
    }

    return this._legacyVttToSrt(vttContent);
  }

  // Tolerant inline VTT->SRT fallback. Drops WEBVTT/NOTE/STYLE blocks, renumbers the
  // cues (SRT requires an index line, WebVTT does not) and strips WebVTT cue settings,
  // which a TV's SRT parser reads as part of the timestamp and then rejects the cue.
  _legacyVttToSrt(vttContent) {
    const body = String(vttContent).replace(/^WEBVTT[^\n]*\r?\n/, '');
    const out = [];
    let n = 0;
    for (const raw of body.split(/\r?\n\r?\n/)) {
      const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (!lines.length || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
      const t = lines.findIndex((l) => l.includes('-->'));
      if (t === -1) continue;
      const text = lines.slice(t + 1).join('\n');
      if (!text.trim()) continue;
      n += 1;
      const timing = lines[t]
        .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
        .replace(/-->\s*([\d:,]+).*$/, '--> $1');
      out.push(`${n}\n${timing}\n${text}`);
    }
    return out.length ? out.join('\n\n') + '\n' : '';
  }

  // Tolerant inline SRT->VTT fallback (kept permissive for truncated streaming files).
  _legacySrtToVtt(srtContent) {
    if (srtContent.trim().startsWith('WEBVTT')) {
      return srtContent;
    }
    
    let vtt = 'WEBVTT\n\n';
    const lines = srtContent.split(/\r?\n/);
    let i = 0;
    
    while (i < lines.length) {
      while (i < lines.length && lines[i].trim() === '') {
        i++;
      }
      if (i >= lines.length) break;
      
      const seqLine = lines[i].trim();
      if (/^\d+$/.test(seqLine)) {
        i++;
      }
      
      if (i < lines.length && lines[i].includes('-->')) {
        let timecode = lines[i].trim();
        timecode = timecode.replace(/,/g, '.');
        vtt += timecode + '\n';
        i++;
      }
      
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      
      if (textLines.length > 0) {
        vtt += textLines.join('\n') + '\n\n';
      }
    }
    
    return vtt;
  }

  // Extract embedded subtitles from video file during streaming (works with partially downloaded files)
  // Total duration (seconds) of the media at `url`, via ffprobe. Reads the container
  // header only (fast) — used to build the full on-demand HLS playlist.
  _probeDurationSeconds(url) {
    return new Promise((resolve) => {
      if (!this.ffprobePath || !url) return resolve(0);
      const { execFile } = require('child_process');
      execFile(this.ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url],
        { timeout: 30000 }, (e, out) => { const d = parseFloat(String(out || '').trim()); resolve(Number.isFinite(d) && d > 0 ? d : 0); });
    });
  }

  async extractEmbeddedSubtitlesStreaming(videoFile, torrent) {
    const { spawn } = require('child_process');
    if (!this.ffmpegPath || !this.ffprobePath || !this._torrserverStreamUrl) return [];
    const url = this._torrserverStreamUrl;

    // DETECT subtitle tracks straight from the LIVE TorrServer stream. The old path
    // probed a truncated byte-sample (gated on TorrServer's preloaded_bytes), which
    // frequently failed to parse — so the file's subtitles were never detected and
    // none ever appeared. A direct probe of the stream URL reads just the header and
    // is reliable.
    const streams = await new Promise((resolve) => {
      const p = spawn(this.ffprobePath, [
        '-v', 'error', '-select_streams', 's',
        '-show_entries', 'stream=index:stream_tags=language,title',
        '-of', 'json', url,
      ], hiddenChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', () => { try { resolve(JSON.parse(out).streams || []); } catch (e) { resolve([]); } });
      p.on('error', () => resolve([]));
    });
    if (!streams.length) { this._log('No embedded subtitle tracks in this file.'); return []; }
    this._log(`Found ${streams.length} embedded subtitle track(s); extracting to WebVTT…`);

    // EXTRACT each track to WebVTT in TWO passes. ffmpeg's webvtt writer only emits its
    // cues at the very END of a run (it doesn't flush as it goes), so a single full pass
    // means subtitles don't appear until the whole file has been read ≈ fully downloaded.
    // Instead we do a quick first pass over the opening few minutes (`-t`) so subtitles
    // show within seconds, then a full pass that replaces it with every cue. The player's
    // /api/subtitles poll loads the early file, then reloads once `complete` flips true.
    streams.forEach((stream, i) => {
      const language = (stream.tags && stream.tags.language) || 'und';
      const title = (stream.tags && stream.tags.title) || `Subtitle ${i + 1}`;
      const outputPath = path.join(this.tempDir, `subtitle_${stream.index}_${Date.now()}_${i}.vtt`);
      let info = this.subtitlePaths.find((s) => s.source === 'embedded' && s.trackIndex === stream.index);
      if (!info) {
        info = { path: outputPath, source: 'embedded', language, label: `${title} (${language})`, codec: 'webvtt', trackIndex: stream.index, isPlaceholder: true, complete: false };
        this.subtitlePaths.push(info);
        if (!this.subtitlePath) this.subtitlePath = outputPath;
      } else {
        info.path = outputPath;
      }

      // Extract subtitles for [0, limitSec] (or the whole file when limitSec is 0) and
      // atomically swap the result into outputPath. Returns true if it produced cues.
      const extract = (limitSec) => new Promise((resolve) => {
        const tmp = `${outputPath}.${limitSec || 'full'}.tmp`;
        const args = ['-i', url];
        if (limitSec) args.push('-t', String(limitSec));
        // -f webvtt is mandatory here: `tmp` ends in .tmp, so ffmpeg cannot infer the
        // muxer from the extension and aborts with "Unable to choose an output format".
        args.push('-map', `0:s:${i}`, '-c:s', 'webvtt', '-f', 'webvtt', '-fflags', '+genpts', '-loglevel', 'error', '-y', tmp);
        const proc = spawn(this.ffmpegPath, args, hiddenChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
        this.activeStreams.add(proc);
        let stderr = '';
        if (proc.stderr) proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-500); });
        proc.on('close', () => {
          this.activeStreams.delete(proc);
          try { if (fs.existsSync(tmp) && fs.statSync(tmp).size > 24) { fs.renameSync(tmp, outputPath); resolve(true); return; } } catch (e) {}
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
          // Surface the reason — a silent failure here leaves the track stuck at
          // ready:false for the whole session, with no retry and nothing in the log.
          if (stderr.trim()) this._log(`Subtitle extraction failed (${info.label}): ${stderr.trim().split('\n')[0]}`);
          resolve(false);
        });
        proc.on('error', () => { this.activeStreams.delete(proc); resolve(false); });
      });

      (async () => {
        if (await extract(180)) { info.isPlaceholder = false; this._log(`Subtitle ready (first minutes): ${info.label}`); }
        if (await extract(0)) { info.isPlaceholder = false; info.complete = true; this._log(`Subtitle complete: ${info.label}`); }
      })();
    });

    return this.subtitlePaths.filter((s) => s.source === 'embedded');
  }

  async stream(magnetLink, options = {}) {
    const serverMode = this.listenerCount('line') > 0 || this.listenerCount('progress') > 0;

    const log = (text) => {
      if (serverMode) {
        const lines = String(text).split('\n');
        for (const l of lines) { const t = l.trimEnd(); if (t) this.emit('line', { text: t }); }
      } else {
        process.stdout.write(String(text) + (String(text).endsWith('\n') ? '' : '\n'));
      }
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let statsInterval = null;
      const cleanup = () => { if (statsInterval) { clearInterval(statsInterval); statsInterval = null; } };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        this._cancelPendingStream = null;
        fn(value);
      };
      this._cancelPendingStream = (message = 'Stream manager destroyed') => finish(reject, new Error(message));

      (async () => {
        try {
          log('Starting torrent engine (TorrServer)...');
          await this.tsClient.start();
          if (settled) return;

          log('Adding torrent...');
          const hash = await this.tsClient.add(magnetLink, options.title || '');
          this.currentHash = hash;

          log('Resolving files (waiting for metadata)...');
          const fileInfo = await this.tsClient.resolveLargestFile(hash);
          if (settled) return;

          const videoFile = this.createTorrServerFile(hash, fileInfo);
          this._torrserverStreamUrl = this.tsClient.streamUrl(hash, fileInfo.id, fileInfo.path);
          log(`Video file: ${videoFile.name}`);
          log(`Size: ${(videoFile.length / 1024 / 1024 / 1024).toFixed(2)} GB`);

          // ALWAYS kick TorrServer's native preload — the request its own player makes
          // before playing. The engine downloads only while a reader is attached and
          // drops the torrent after 30s without one, so a stream that sat unplayed
          // froze at a fixed percent until the user opened it in TorrServer's player.
          // This attaches an engine-side reader up front for every movie instead.
          // Fire-and-forget: the call blocks until the preload target is reached, and
          // the streaming path must never wait on it. UPLAYER_TS_PRELOAD=0 disables.
          if (process.env.UPLAYER_TS_PRELOAD !== '0') {
            this.tsClient.preload(hash, fileInfo.id, fileInfo.path)
              .then((ok) => { if (ok) this._log('TorrServer preload target reached'); });
          }

          // Stats shim so existing code that reads torrent.downloaded/downloadSpeed keeps working.
          const torrentLike = {
            downloaded: 0, downloadSpeed: 0, progress: 0,
            pieceLength: 4 * 1024 * 1024, numPeers: 0,
            files: [videoFile], name: videoFile.name,
            on() {}, once() {}, removeListener() {},
          };
          this.streamHealth.attachSource({ sizeBytes: videoFile.length });
          statsInterval = setInterval(async () => {
            try {
              const s = await this.tsClient.stats(hash);
              const health = this.streamHealth.report(s);

              // torrentLike is the WebTorrent-compatibility shim; keep it fed.
              torrentLike.downloaded = health.downloadedBytes;
              torrentLike.downloadSpeed = health.downloadSpeedBps;
              torrentLike.numPeers = health.peers;
              torrentLike.progress = health.percent;

              if (serverMode) {
                // `progress` is the startup download bar and its shape is frozen —
                // legacyProgressPayload is the only producer of those pre-formatted
                // strings. This interval dies at finish() (i.e. when the player appears),
                // which is exactly the bar's intended life.
                this.emit('progress', legacyProgressPayload(health));
                this.emit('stream_health', health);
              }
            } catch (e) { /* ignore poll errors */ }
          }, 1000);

          // Embedded subtitle extraction (reads videoFile.createReadStream + torrentLike.downloaded)
          if (this.ffmpegPath && this.ffprobePath) {
            log('Extracting embedded subtitles...');
            this.extractEmbeddedSubtitlesStreaming(videoFile, torrentLike).catch(() => {});
          } else {
            log('Embedded subtitle extraction unavailable: ffmpeg/ffprobe not found');
          }

          // External subtitle if provided
          if (options.subtitlePath && fs.existsSync(options.subtitlePath)) {
            this.subtitlePaths.push({ path: options.subtitlePath, source: 'external', language: 'en', label: 'External Subtitle', codec: 'srt', complete: true });
            if (!this.subtitlePath) this.subtitlePath = options.subtitlePath;
          }

          // Burn-in: when requested, the external subtitle is rendered into the cast
          // transcode (for TVs/receivers that can't display a separate subtitle track).
          this._burnSubtitlePath = (options.burnSubtitle && options.subtitlePath && fs.existsSync(options.subtitlePath))
            ? options.subtitlePath : null;

          await this.startStreamingServer(videoFile, async (url, urls, videoPath, originalVideoPath, streamMeta = {}) => {
            const subtitleManifestUrl = `${String(url).replace(/\/$/, '')}/api/subtitles`;
            log('Streaming server started!');
            log(`Stream URL: ${url}`);
            const fullVideoUrl = videoPath ? `${url.replace(/\/$/, '')}${videoPath}` : url;
            const fullOriginalVideoUrl = originalVideoPath ? `${url.replace(/\/$/, '')}${originalVideoPath}` : fullVideoUrl;

            // VLC / external players seek best against TorrServer's NATIVE stream
            // endpoint — it preloads around the seek position — so point them straight
            // at it instead of proxying raw bytes (capped 10MB/request) through :8000.
            let vlcDirectUrl = fullOriginalVideoUrl;
            try {
              var lanHost = new URL(String(url)).hostname || '127.0.0.1';
              vlcDirectUrl = this.tsClient.streamUrl(hash, fileInfo.id, fileInfo.path, lanHost);
            } catch (e) { /* fall back to proxied URL */ }

            // Show the player / cast / VLC buttons THE MOMENT the stream server is up.
            // Every URL is already known here, so there's no reason to make the user wait
            // for a download threshold first (that "stuck waiting at 0.6%" feeling). The
            // player — and TorrServer's own preload — buffer when the stream is actually
            // opened. We still warm TorrServer's cache from the start in the BACKGROUND
            // (below) so a cushion is usually ready by the time they click, but it no
            // longer gates the UI.
            if (serverMode) {
              const playerRoot = String(url || '').replace(/\/?$/, '/');
              this.emit('player_ready', {
                url: playerRoot, urls, playerUrl: playerRoot,
                vlcUrl: vlcDirectUrl, mediaUrl: vlcDirectUrl, castUrl: fullVideoUrl,
                subtitleManifestUrl, videoFormat: streamMeta.videoFormat || null,
                mediaFacts: streamMeta.mediaFacts || null,
              });
              // The stats tick above is about to be cleared by finish(), because the
              // download bar's job ends when the player appears. Stream health outlives
              // it by design: the interesting question during playback is how far ahead
              // of the PLAYHEAD the cache is, and the playhead doesn't exist until now.
              this._startHealthTicker(hash);
            }

            if (options.openPlayer !== false) {
              open(url, { newInstance: true, wait: false }).catch(() => log('Could not auto-open player. Open the URL in your browser.'));
            }

            finish(resolve, {
              url, urls, torrent: torrentLike, videoFile, subtitlePath: options.subtitlePath,
              videoPath, originalVideoPath, vlcUrl: vlcDirectUrl, mediaUrl: vlcDirectUrl,
              castUrl: fullVideoUrl, subtitleManifestUrl,
            });

            // Downloaded subtitle timing gets checked against the audio in the
            // background (embedded tracks never need this — see the method).
            this._autoSyncExternalSubtitle();

            // Background cache warm-up (NON-blocking): drive TorrServer's download from the
            // start so a cushion is buffered ahead of when the user opens the player. This
            // does NOT gate the buttons — it just runs ahead, then stops once the target is
            // reached; TorrServer's read-ahead takes over once playback begins.
            //   UPLAYER_PREBUFFER_MB  how much to pre-warm, MB (default 16; set 0 to disable)
            let warmMB = Number(process.env.UPLAYER_PREBUFFER_MB);
            if (!Number.isFinite(warmMB)) warmMB = 16;
            warmMB = Math.max(0, warmMB);
            if (warmMB > 0) {
              const warmBytes = warmMB * 1024 * 1024;
              log(`Warming ~${warmMB} MB of cache in the background…`);
              let got = 0;
              const warm = videoFile.createReadStream({ start: 0 });
              this.activeStreams.add(warm);
              const endWarm = () => { this.activeStreams.delete(warm); try { warm.destroy(); } catch (e) {} };
              warm.on('data', (d) => { got += d.length; if (got >= warmBytes) endWarm(); });
              warm.on('error', endWarm);
              warm.on('end', endWarm);
            }
          }, options.subtitlePath);
        } catch (err) {
          finish(reject, err);
        }
      })();
    });
  }

  // Playback-phase stream_health poll. The startup stats tick in stream() dies at
  // finish() with the download bar; this one takes over for the life of playback so
  // the health panel keeps ticking — and so an engine death mid-movie shows up as
  // health.engineDown instead of a percent frozen at its last value. (This method
  // was once called but not defined: the TypeError left the STARTUP interval leaked
  // as an accidental forever-poller, which is exactly the frozen-at-38% session.)
  _startHealthTicker(hash) {
    this._stopHealthTicker();
    this._healthTicker = setInterval(async () => {
      if (this.currentHash !== hash) { this._stopHealthTicker(); return; }
      try {
        const s = await this.tsClient.stats(hash);
        this.emit('stream_health', this.streamHealth.report(s));
      } catch (e) { /* a bad tick must not kill playback */ }
    }, 1000);
    if (typeof this._healthTicker.unref === 'function') this._healthTicker.unref();
  }

  _stopHealthTicker() {
    if (this._healthTicker) { clearInterval(this._healthTicker); this._healthTicker = null; }
  }

  // TorrServer-backed file object exposing the same surface (createReadStream/length/name)
  // the streaming/transcode/subtitle code previously relied on from a WebTorrent file.
  createTorrServerFile(hash, fileInfo) {
    const ts = this.tsClient;
    const streamPath = ts.streamPath(hash, fileInfo.id, fileInfo.path);
    const port = ts.port;
    const name = require('path').basename(fileInfo.path || 'video');
    const fileLength = fileInfo.length || 0;
    return {
      name,
      length: fileLength,
      _torrent: null,
      select() {},
      deselect() {},
      // RESILIENT read stream. TorrServer's /stream response can end EARLY — when the
      // reader hits a piece the swarm hasn't delivered yet it may return a clean EOF
      // rather than blocking. A naive `res.pipe(out)` forwards that as end-of-stream,
      // and a consumer reading from a non-resumable pipe (the HLS-remux ffmpeg, fed via
      // stdin) takes it as "file finished" and exits after ~one segment → the web /
      // Chromecast player gets ~6s then stalls forever. So instead of piping once, we
      // track how many bytes were delivered and, if the upstream ends before the
      // requested range is complete and the consumer still wants data, transparently
      // RECONNECT from the next byte and keep feeding. The consumer sees one continuous
      // stream; transient swarm stalls become invisible reconnects, not a false EOF.
      createReadStream(opts = {}) {
        const { PassThrough } = require('stream');
        const http = require('http');
        const out = new PassThrough(opts.highWaterMark ? { highWaterMark: opts.highWaterMark } : {});
        const start = opts.start || 0;
        const hasEnd = opts.end != null && opts.end !== Infinity;
        const finalEnd = hasEnd ? opts.end : (fileLength ? fileLength - 1 : null); // inclusive target byte
        const MAX_EMPTY_RETRIES = 60; // consecutive reconnects with no progress before giving up (~12s)
        let pos = start;          // next byte we still need
        let emptyRetries = 0;     // reset whenever data flows, so a slow-but-alive swarm streams forever
        let closed = false;
        let curReq = null, curRes = null;

        const teardown = () => { closed = true; try { curRes && curRes.destroy(); } catch (e) {} try { curReq && curReq.destroy(); } catch (e) {} };
        out.on('error', teardown);
        out.on('close', teardown);
        out.on('drain', () => { try { curRes && curRes.resume(); } catch (e) {} });

        const retryOrFail = () => {
          if (closed) return;
          if (emptyRetries < MAX_EMPTY_RETRIES) { emptyRetries++; setTimeout(connect, 200); }
          else { try { out.destroy(new Error('TorrServer stream stalled')); } catch (e) {} }
        };

        function connect() {
          if (closed) return;
          if (finalEnd != null && pos > finalEnd) { try { out.end(); } catch (e) {} return; } // whole range delivered → real EOF
          const range = `bytes=${pos}-${finalEnd != null ? finalEnd : ''}`;
          curReq = http.request({ host: '127.0.0.1', port, path: streamPath, method: 'GET', headers: { Range: range } }, (res) => {
            curRes = res;
            res.on('data', (d) => { emptyRetries = 0; pos += d.length; if (!out.write(d)) res.pause(); });
            res.on('end', () => {
              curRes = null;
              if (closed) return;
              if (finalEnd != null && pos <= finalEnd) retryOrFail(); // ended early → resume from pos
              else { try { out.end(); } catch (e) {} }
            });
            res.on('error', () => { curRes = null; retryOrFail(); });
          });
          curReq.on('error', () => { curReq = null; retryOrFail(); });
          curReq.end();
        }

        connect();
        return out;
      },
    };
  }

  // Extract mono 16kHz wav from the current TorrServer stream for speech tools.
  async _extractStreamAudio(outWav, { maxSeconds } = {}) {
    if (!this.ffmpegPath || !this._torrserverStreamUrl) return false;
    const { spawn } = require('child_process');
    const args = ['-y', '-i', this._torrserverStreamUrl];
    if (maxSeconds) args.push('-t', String(maxSeconds));
    args.push('-vn', '-ac', '1', '-ar', '16000', outWav);
    return new Promise((resolve) => {
      const p = spawn(this.ffmpegPath, args, hiddenChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
      p.on('close', (code) => resolve(code === 0 && fs.existsSync(outWav)));
      p.on('error', () => resolve(false));
    });
  }

  // Generate subtitles from the stream audio via whisper.cpp; appends to subtitlePaths
  // so the player's subtitle manifest poll picks them up. Heavy — user-triggered.
  async generateSubtitles(opts = {}) {
    const tools = require('./core/subtitle-tools');
    if (!tools.isWhisperAvailable()) return { ok: false, reason: 'whisper not installed' };
    const wav = path.join(this.tempDir, `whisper_${Date.now()}.wav`);
    this._log('Extracting audio for subtitle generation…');
    if (!(await this._extractStreamAudio(wav, { maxSeconds: opts.maxSeconds }))) return { ok: false, reason: 'audio extraction failed' };
    this._log('Generating subtitles with whisper (this can take a while)…');
    const outBase = path.join(this.tempDir, `whisper_${Date.now()}`);
    const r = await tools.generateSubtitle(wav, outBase, { language: opts.language });
    try { fs.unlinkSync(wav); } catch (e) {}
    if (!r.ok) return r;
    this.subtitlePaths.push({ path: r.output, source: 'whisper', language: opts.language || 'en', label: 'Generated (whisper)', codec: 'srt', complete: true });
    this._log('Generated subtitles ready.');
    return { ok: true, index: this.subtitlePaths.length - 1 };
  }

  // Auto-sync an external subtitle to the stream audio via alass; returns { ok, output }.
  async syncSubtitle(subPath, opts = {}) {
    const tools = require('./core/subtitle-tools');
    if (!tools.isAlassAvailable()) return { ok: false, reason: 'alass not installed' };
    if (!subPath || !fs.existsSync(subPath)) return { ok: false, reason: 'subtitle missing' };
    // Before spending minutes extracting audio: is this a subtitle for this film at all?
    // The auto path asks the same question earlier (it can skip the whole job); this is
    // the backstop for the player's CC⇄ button, where the file came from a hand-picked
    // search result and nothing has vetted it.
    const misfit = this._subtitleMisfitReason(subPath);
    if (misfit) return { ok: false, reason: `sync skipped (${misfit})` };
    const wav = path.join(this.tempDir, `alass_${Date.now()}.wav`);
    this._log('Extracting audio for subtitle sync…');
    if (!(await this._extractStreamAudio(wav, { maxSeconds: opts.maxSeconds }))) return { ok: false, reason: 'audio extraction failed' };

    // TorrServer's /stream returns a clean EOF at the first uncached piece (the
    // reason createTorrServerFile's reader reconnects), so on a cold cache ffmpeg
    // can hand back a FRAGMENT of the requested window without erroring. Feeding
    // alass a fragment is how a correctly-timed subtitle got "corrected" by almost
    // four minutes — aligning 20 minutes of cues against 30 seconds of audio.
    // A truncated extraction is a failed extraction, full stop.
    const expected = Math.min(
      opts.maxSeconds || Infinity,
      (this.streamHealth && this.streamHealth.durationSec) || Infinity
    );
    let wavDur = null;
    if (Number.isFinite(expected)) {
      try { wavDur = await this._probeDurationSeconds(wav); } catch (e) { /* probe unavailable → trust ffmpeg */ }
      if (wavDur != null && wavDur < expected * 0.9) {
        try { fs.unlinkSync(wav); } catch (e) {}
        return { ok: false, reason: `audio incomplete (${Math.round(wavDur)}s of ${Math.round(expected)}s cached) — retry once more is buffered` };
      }
    }

    // The reference is the FIRST `maxSeconds` of the film — 20 minutes of a 140-minute
    // feature, because that is all the swarm has delivered when this runs. alass's
    // default mode cuts the subtitle into segments and moves each independently
    // (--split-penalty 7), which needs reference audio UNDER every segment. Give it a
    // reference that stops at minute 20 and the best-scoring alignment is to drag the
    // whole track into that window — which is precisely what it did on a real run:
    // cues pulled up to 43 minutes early, the first 45 minutes of the film clamped to
    // 00:00:00 (alass writes 0 for a negative timestamp), the subtitle destroyed.
    //
    // A partial reference can only honestly support ONE inference: a constant offset
    // for the whole track (plus alass's framerate correction, which is a global scale
    // and stays enabled). So ask for exactly that. Full coverage — a short subtitle, or
    // a user-triggered sync on a fully cached film — keeps split mode, where per-scene
    // retiming is a real thing worth fixing.
    const subSpan = this._subtitleSpanSeconds(subPath);
    const refSeconds = wavDur != null ? wavDur : (opts.maxSeconds || null);
    const noSplit = !!(subSpan && refSeconds && refSeconds < subSpan * 0.98);

    // This name is for humans reading a temp dir, and nothing else. It was chosen when
    // VLC was believed to name an external track after its filename; VLC 3.0.23 does not
    // — it calls every external track "Track N" regardless, which is why the label now
    // reaches VLC through a Matroska track name instead (core/vlc-subtitle-label.js).
    // The timestamp still guarantees uniqueness across repeated runs.
    const out = path.join(this.tempDir, `Auto-synced timing ${Date.now()}.srt`);
    // alass's VAD over a 20-minute WAV takes minutes on its own — the library
    // default of 3 killed real runs mid-analysis ("error":"timeout" with a warm
    // cache). 10 minutes is generous without letting a hang live forever.
    const r = await tools.syncSubtitle(wav, subPath, out, { timeoutMs: 10 * 60 * 1000, noSplit });
    try { fs.unlinkSync(wav); } catch (e) {}

    // --no-split narrows what alass CAN do wrong; it does not make it right. alass exits
    // 0 on a confidently wrong alignment exactly as it does on a good one, so the only
    // thing standing between a bad alignment and every playback target is this check.
    // A rejected fix leaves the downloaded subtitle exactly as it arrived, which is the
    // right failure: out by a few seconds beats out by half an hour.
    if (r.ok) {
      const bad = this._implausibleSync(subPath, r.output);
      if (bad) {
        try { fs.unlinkSync(r.output); } catch (e) {}
        this._log(`Subtitle sync rejected — ${bad}. Keeping the original timing.`);
        return { ok: false, reason: `sync rejected (${bad})` };
      }
    }
    return r;
  }

  // Cue START times of a subtitle file, in ms — null when unreadable.
  _subtitleCueStarts(subPath) {
    try {
      const text = fs.readFileSync(subPath, 'utf8');
      const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->/g;
      const out = [];
      let m;
      while ((m = re.exec(text))) out.push(((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]));
      return out;
    } catch (e) { return null; }
  }

  // Did alass actually MOVE anything? A subtitle that was already correctly timed comes
  // back effectively identical, and treating that as a correction is not harmless: it
  // relabels the track "(auto-synced)", adds a duplicate "Original timing" entry nobody
  // needs, and — on a TV — offers to RESTART the film to apply a change of zero. Nothing
  // changed, so nothing should change.
  //
  // 50ms is under one frame at 24fps, i.e. below what anyone can perceive. When the two
  // files can't be compared (unreadable, different cue counts) the answer is "yes it
  // changed": the fallback has to be the behaviour that keeps a real correction.
  _syncChangedTiming(originalPath, syncedPath) {
    const a = this._subtitleCueStarts(originalPath);
    const b = this._subtitleCueStarts(syncedPath);
    if (!a || !b || a.length === 0 || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i += 1) {
      if (Math.abs(a[i] - b[i]) > 50) return true;
    }
    return false;
  }

  // Is this subtitle even FOR this film? Returns a human reason string when it plainly
  // is not, or null when nothing rules it out. Judged only by how much of the runtime it
  // covers, which is the one thing comparable without understanding either.
  //
  // This exists because the viewer picks the subtitle by hand, from provider search
  // results that are frequently mislabelled — a trailer that charts high on download
  // count, an episode file in a film's results, a different cut of the same title. alass
  // will align any of them to something and exit 0, and the cost of letting it is not
  // just a useless subtitle: it is minutes of audio extraction, a green "timing fixed"
  // badge that says the opposite of the truth, and on a TV an offer to RESTART the film
  // to apply it. Cheaper and more honest to say no first.
  //
  // Both entry points must ask — the background auto-fix AND the player's CC⇄ button —
  // which is why the rule lives here and not in either caller.
  //
  // Note the limit of this test: a subtitle for a DIFFERENT film of similar runtime
  // passes it, and nothing downstream can tell either. Timing cannot distinguish two
  // 164-minute films; only the words could, and we do not read them. What is guaranteed
  // is narrower and more useful — a wrong subtitle stays wrong, and a RIGHT one is never
  // made wrong.
  _subtitleMisfitReason(subPath) {
    const mediaDur = this.streamHealth && this.streamHealth.durationSec;
    const span = this._subtitleSpanSeconds(subPath);
    // Duration arrives from the probe and the span from the file; without both there is
    // no ratio, and a missing input is not evidence of anything.
    if (!mediaDur || span == null) return null;
    const mins = (s) => Math.round(s / 60);
    if (span < mediaDur * MIN_SUBTITLE_COVERAGE) {
      return `it covers only ${mins(span)}min of a ${mins(mediaDur)}min film (a trailer or sample?)`;
    }
    if (span > mediaDur * MAX_SUBTITLE_OVERRUN) {
      return `its last line falls ${mins(span - mediaDur)}min past the end of a ${mins(mediaDur)}min film (a different cut, or another title?)`;
    }
    return null;
  }

  // Is this "correction" too large to be a correction? Returns a human reason string when
  // the result should be thrown away, or null when it is worth keeping.
  //
  // Three independent signals, because a bad alignment usually trips all three and any
  // one of them alone is enough to know. Deliberately loose: this is not a quality
  // score, it is a floor under catastrophe. A sync that is merely mediocre gets through,
  // and should — the viewer can still pick "Original timing".
  //
  //   * Cues clamped to zero. alass writes 00:00:00,000 for any negative timestamp, so
  //     cues appearing at zero that were not there before means the alignment ran the
  //     subtitle off the front of the film. Nothing legitimate does that.
  //   * An implausible shift. A downloaded subtitle was cut for a different release of
  //     the SAME film, so its error is a distributor intro or a missing pre-roll —
  //     seconds, at worst a minute or two. Half an hour is not a mis-timing, it is a
  //     misalignment.
  //   * A warped span. First-cue-to-last-cue must survive the correction. An offset does
  //     not change it at all and alass's framerate correction scales it by a known ratio
  //     — 25/23.976 is the widest pair in play, 4.3% — so anything past 6% is the track
  //     being squashed or stretched to fit something it is not.
  _implausibleSync(originalPath, syncedPath) {
    const a = this._subtitleCueStarts(originalPath);
    const b = this._subtitleCueStarts(syncedPath);
    // Unreadable or empty: no evidence either way. _syncChangedTiming already treats
    // that case as "keep the correction", and disagreeing here would silently undo it.
    if (!a || !b || a.length === 0 || b.length === 0) return null;

    // Three, not one: a subtitle whose opening cue sits a few seconds in can legitimately
    // lose that one cue to a small negative correction. Three or more is a track being
    // walked off the front of the film, which is what a squashed alignment looks like.
    const zeros = (list) => list.filter((t) => t === 0).length;
    const clamped = zeros(b) - zeros(a);
    if (clamped >= 3) return `${clamped} cues pushed off the start of the film`;

    // The median, not _subtitleUniformShiftMs: that one pairs mismatched cue lists by
    // NEAREST neighbour, which on a badly misaligned file quietly pairs cue 800 with cue
    // 40 and reports a small offset for a huge error. Index pairing is the honest
    // measure here, so a length mismatch skips this signal rather than faking it — the
    // other two still apply.
    if (a.length === b.length) {
      const offsets = a.map((t, i) => b[i] - t).sort((x, y) => x - y);
      const median = offsets[Math.floor(offsets.length / 2)];
      if (Math.abs(median) > MAX_PLAUSIBLE_SHIFT_MS) {
        return `it moves the subtitle by ${(Math.abs(median) / 60000).toFixed(0)} minutes`;
      }
    }

    const spanA = a[a.length - 1] - a[0];
    const spanB = b[b.length - 1] - b[0];
    if (spanA > 0) {
      const ratio = spanB / spanA;
      if (Math.abs(ratio - 1) > MAX_SPAN_WARP) {
        return `it ${ratio < 1 ? 'compresses' : 'stretches'} the subtitle to ${(ratio * 100).toFixed(0)}% of its length`;
      }
    }
    return null;
  }

  // The constant offset between two subtitle files in ms, or null when the correction is
  // not a pure shift (frame-rate drift, per-scene retiming).
  //
  // This exists for VLC. VLC cannot swap a subtitle file it has already loaded, so a
  // corrected one arrives as a SECOND track that the viewer has to go and select by hand
  // — which is not a fix, it is homework. But when the whole correction is "every cue is
  // 7 seconds late", which is what a subtitle cut for a different release usually is, the
  // identical result comes from telling VLC to delay the track it ALREADY has. One track,
  // its original name, correct timing, nothing to select.
  //
  // Deliberately tolerant, because the first version was not and it cost the whole point.
  // Requiring every cue to move by an identical amount (max-min <= 100ms) only holds when
  // alass aligns a subtitle against ANOTHER SUBTITLE. The auto-fix aligns against AUDIO,
  // where alass matches speech segments and individual cues land a few tens or hundreds
  // of ms apart even when the correction is, to a viewer, one constant offset. Those runs
  // all failed the test, fell through to addsubtitle, and produced the second VLC track
  // this is supposed to avoid.
  //
  // So: take the MEDIAN offset (immune to a handful of outliers) and accept it if the
  // large majority of cues sit near it. A few stragglers are alass nudging one line; a
  // broad spread is real drift, and then only the file will do.
  _subtitleUniformShiftMs(originalPath, syncedPath, toleranceMs = 250, minAgreement = 0.9) {
    const a = this._subtitleCueStarts(originalPath);
    const b = this._subtitleCueStarts(syncedPath);
    if (!a || !b || a.length === 0 || b.length === 0) return null;

    // alass can drop or merge a cue, so the two lists are not always the same length.
    // Pair each corrected cue with the closest original one rather than giving up — a
    // length mismatch was another reason this returned null on real output.
    const offsets = [];
    if (a.length === b.length) {
      for (let i = 0; i < a.length; i += 1) offsets.push(b[i] - a[i]);
    } else {
      for (let i = 0; i < b.length; i += 1) {
        let best = null;
        let bestAbs = Infinity;
        for (let j = 0; j < a.length; j += 1) {
          const d = b[i] - a[j];
          const abs = Math.abs(d);
          if (abs < bestAbs) { bestAbs = abs; best = d; }
        }
        if (best != null) offsets.push(best);
      }
    }
    if (!offsets.length) return null;

    const sorted = offsets.slice().sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    const agree = offsets.filter((d) => Math.abs(d - median) <= toleranceMs).length;
    if (agree / offsets.length < minAgreement) return null; // genuine drift — send the file
    return Math.round(median);
  }

  // Last cue timestamp of a subtitle file, in seconds — null when unparseable.
  _subtitleSpanSeconds(subPath) {
    try {
      const text = fs.readFileSync(subPath, 'utf8');
      let last = null, m;
      const re = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g;
      while ((m = re.exec(text))) last = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      return last;
    } catch (e) { return null; }
  }

  // Wait until the byte supply covers the first `maxSeconds` of the file (the span
  // syncSubtitle will extract), so alass always sees the full window. Returns early
  // once covered; false on timeout or teardown — callers proceed and let the
  // duration validation in syncSubtitle be the backstop.
  async _waitForSyncWindow(maxSeconds, capMs = 10 * 60 * 1000) {
    const started = Date.now();
    while (Date.now() - started < capMs) {
      if (this._destroyed) return false;
      const h = this.streamHealth;
      const size = h && h.sizeBytes;
      // No health data YET is not the same as no health data ever. This runs the instant
      // the stream server comes up, a beat before the health ticker's first poll — and
      // returning false there meant the very first sync attempt skipped its wait entirely
      // and extracted audio from the coldest possible cache, guaranteeing a fragment.
      // Keep waiting; the caller's cap bounds this.
      if (!size) { await new Promise((r) => setTimeout(r, 5000)); continue; }
      const frac = h.durationSec ? Math.min(1, maxSeconds / h.durationSec) : null;
      // 10% margin over the average-bitrate estimate; unknown duration falls back
      // to "a generous slab from the front".
      const needed = Math.min(size, frac != null ? size * frac * 1.1 : Math.min(size, 200 * 1024 * 1024));
      if ((h.downloadedBytes || 0) >= needed) return true;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
  }

  // Alass availability, in a method so tests can stub it without touching require().
  _isAlassAvailable() {
    try { return require('./core/subtitle-tools').isAlassAvailable(); } catch (e) { return false; }
  }

  // AUTO-fix timing — for the DOWNLOADED subtitle only. An embedded/extracted
  // track was muxed with this exact video, so its clock IS the video's clock;
  // running alass on it would spend minutes of audio extraction fixing nothing.
  // A downloaded subtitle was cut for whatever encode its uploader had, so it
  // arrives suspect by definition.
  //
  // On success the external entry is swapped IN PLACE: the manifest (web + cast),
  // VLC's --sub-file, and the cast burn-in path all read these fields, so every
  // playback target gets the corrected timing without anyone selecting anything.
  // The uncorrected file stays available as its own "Original timing" track in
  // case alass guessed wrong. Runs as the shared background job, so the player's
  // CC⇄ spinner reflects it. UPLAYER_AUTO_SYNC_SUBS=0 disables.
  _autoSyncExternalSubtitle() {
    if (process.env.UPLAYER_AUTO_SYNC_SUBS === '0') return;
    if (!this._isAlassAvailable()) return;
    const entry = this.subtitlePaths.find((s) => s && s.source === 'external' && s.path);
    if (!entry) return;
    if (this._subtitleJob && this._subtitleJob.running) return;
    this._subtitleJob = { kind: 'sync', running: true, error: null, startedAt: Date.now() };
    (async () => {
      const original = entry.path;
      const maxSeconds = 1200;
      // This fires at stream START, the coldest possible moment for the cache —
      // so wait for the byte supply to cover the sync window first, and treat an
      // incomplete extraction as "not yet", not as a result. Syncing against a
      // fragment is worse than not syncing: it once shifted a correct subtitle
      // by four minutes and every player dutifully showed the damage.
      // Junk guard: a subtitle that does not span this film is not a subtitle for this
      // film, and aligning it against the movie's audio produces a meaningless shift.
      // Leave it be — the user can see it is wrong; a sync would only disguise that.
      // Asked here as well as inside syncSubtitle so the whole job — audio extraction
      // included — is skipped rather than merely wasted.
      const misfit = this._subtitleMisfitReason(entry.path);
      if (misfit) {
        this._log(`Auto-sync skipped — ${misfit}`);
        this._subtitleJob = { kind: 'sync', running: false, error: `sync skipped (${misfit})`, startedAt: this._subtitleJob.startedAt };
        return;
      }

      // "audio incomplete" is not a failure — it means the bytes for the sync window
      // haven't arrived yet. This fires at stream START, the coldest the cache ever is,
      // on a file whose first 20 minutes can be a few hundred MB. Three attempts all
      // burned inside the opening minutes and the fix then gave up FOREVER, leaving the
      // player's CC⇄ button as the only way to get it — which is the whole thing this is
      // supposed to do without being asked.
      //
      // So: keep retrying for as long as the stream is alive. The viewer is watching,
      // which is precisely what pulls those bytes down, so waiting is what makes it
      // succeed. Each pass already blocks on _waitForSyncWindow and a full audio
      // extraction, so the loop is paced by real work and cannot spin. The cap only
      // exists so a permanently stalled swarm doesn't retry until the process dies.
      const MAX_ATTEMPTS = 12;
      let r = { ok: false, reason: 'stream ended before sync could run' };
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !this._destroyed; attempt++) {
        await this._waitForSyncWindow(maxSeconds);
        if (this._destroyed) break;
        r = await this.syncSubtitle(original, { maxSeconds });
        if (r.ok || !/audio incomplete/.test(r.reason || '')) break;
        this._log(`Subtitle auto-sync deferred (${r.reason}) — attempt ${attempt}/${MAX_ATTEMPTS}`);
      }
      // Already correctly timed. Keep the original as THE track, untouched and unlabelled,
      // and throw the identical copy away — see _syncChangedTiming.
      if (r.ok && !this._syncChangedTiming(original, r.output)) {
        try { fs.unlinkSync(r.output); } catch (e) {}
        this._log('Downloaded subtitle was already in sync with the audio — left as it is.');
        this._subtitleJob = {
          kind: 'sync', running: false, error: null, unchanged: true,
          startedAt: this._subtitleJob.startedAt,
          finishedAt: Date.now(),
          durationMs: Date.now() - this._subtitleJob.startedAt,
          shiftMs: 0,
        };
        return;
      }
      let shiftMs = null;
      if (r.ok) {
        shiftMs = this._subtitleUniformShiftMs(original, r.output);
        entry.path = r.output;
        // The size of the correction goes in the LABEL, because the label is what every
        // player shows in its captions menu — so "which of these two is the fixed one,
        // and by how much" is answerable without leaving the video.
        const by = shiftMs == null ? '' : ` ${shiftMs > 0 ? '+' : '−'}${(Math.abs(shiftMs) / 1000).toFixed(1)}s`;
        entry.label = (entry.label || 'External Subtitle') + ` (auto-synced${by})`;
        if (this.subtitlePath === original) this.subtitlePath = r.output;
        if (this._burnSubtitlePath === original) this._burnSubtitlePath = r.output;
        this.subtitlePaths.push({
          path: original, source: 'external', language: entry.language || 'en',
          label: 'Original timing', codec: entry.codec || 'srt', complete: true,
        });
        // Already-running players: the web player refreshes through its manifest
        // poll; VLC needs a push (the owning server relays this to its web
        // interface). DLNA/Chromecast only pick the new file up on re-cast.
        // shiftMs lets VLC fix the track it already has instead of gaining a second one
        // — see _subtitleUniformShiftMs. null means "not a pure offset, send the file".
        this.emit('subtitle_updated', { path: entry.path, label: entry.label, shiftMs });
        const secs = ((Date.now() - this._subtitleJob.startedAt) / 1000).toFixed(0);
        this._log(`Downloaded subtitle auto-synced against the audio (alass)`
          + `${shiftMs == null ? '' : ` — moved ${(shiftMs / 1000).toFixed(1)}s`} in ${secs}s.`);
      }
      this._subtitleJob = {
        kind: 'sync',
        running: false,
        error: r.ok ? null : (r.reason || 'sync failed'),
        startedAt: this._subtitleJob.startedAt,
        finishedAt: Date.now(),
        // How long the whole thing took and how far it moved the subtitle. Both are
        // reported to the UI beside "Subtitle loaded": a fix that silently happens is
        // indistinguishable from one that never ran.
        durationMs: Date.now() - this._subtitleJob.startedAt,
        shiftMs,
      };
    })().catch((e) => {
      this._subtitleJob = { kind: 'sync', running: false, error: e.message, startedAt: Date.now() };
    });
  }

  // Probe video codec from the stream (HEVC/H.265 not supported in browsers - needs transcoding)
  async probeVideoCodec(videoFile) {
    const probe = await this.probeMediaStreams(videoFile);
    return probe ? probe.vcodec : null;
  }

  // Probe the file for video + audio + format info, returning
  // { vcodec, vlevel, vprofile, acodec, achannels, container, durationSec } or null.
  //
  // Codec/container info lives in the header (the MP4 `moov` / MKV header), which is a
  // few MB at most — so we sample a SMALL front chunk first to keep time-to-playable low
  // (this probe runs before the player buttons appear, so a 10 MB sample on a cold swarm
  // was the main "stuck waiting" delay). Only if the small sample yields no video codec
  // (e.g. an unusually large/late header) do we retry with a bigger sample, so correctness
  // is preserved. Tunable via UPLAYER_PROBE_SAMPLE_MB (default 4).
  async probeMediaStreams(videoFile) {
    if (!this.ffprobePath) return null;
    // Duration reaches streamHealth from here (see the tail of this method): without it
    // there's no average bitrate, so no buffer-ahead estimate — and the estimate stays
    // null rather than becoming a guess.

    // Deliberately sample the front of the file rather than ffprobe the URL directly.
    // A URL probe is faster in isolation (~265ms vs downloading a sample) BUT it reads
    // only what ffprobe wants and seeks to the end for the Matroska index, so it leaves
    // very little of the file START cached. The sample below pulls the opening MBs
    // sequentially through the resilient reader — those are exactly the bytes the HLS
    // remux reads next, so the "waste" is really a prebuffer. Losing it starves the
    // remux on a cold swarm: TorrServer answers with a clean early EOF, ffmpeg treats
    // that as end-of-file and exits, and the Chromecast plays a few seconds then stops.
    const smallMB = Math.max(1, Number(process.env.UPLAYER_PROBE_SAMPLE_MB) || 4);
    const smallBytes = smallMB * 1024 * 1024;
    let r = await this._probeSample(videoFile, smallBytes);
    if ((!r || !r.vcodec) && videoFile.length > smallBytes) {
      r = (await this._probeSample(videoFile, Math.min(10 * 1024 * 1024, videoFile.length))) || r;
    }
    if (r && r.mediaFacts) {
      this.streamHealth.attachSource({
        sizeBytes: r.mediaFacts.sizeBytes,
        durationSec: r.mediaFacts.durationSec,
      });
    }
    return r;
  }

  // ffprobe the first `sampleSize` bytes (downloaded to a temp file so ffprobe never hangs
  // on a growing stream). Returns the same shape as probeMediaStreams, or null.
  async _probeSample(videoFile, sampleSize) {
    const { spawn } = require('child_process');
    if (!this.ffprobePath) return null;
    sampleSize = Math.min(sampleSize, videoFile.length);
    const samplePath = path.join(this.tempDir, `probe_${Date.now()}.tmp`);
    return new Promise((resolve) => {
      const readStream = videoFile.createReadStream({ start: 0, end: sampleSize - 1 });
      const writeStream = fs.createWriteStream(samplePath);
      readStream.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      writeStream.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      readStream.pipe(writeStream);
      writeStream.on('finish', () => {
        const ffprobe = spawn(this.ffprobePath, [
          '-v', 'error',
          '-show_streams',
          '-show_format',
          '-of', 'json',
          samplePath,
        ], hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'] }));
        let out = '';
        ffprobe.stdout.on('data', (d) => { out += d.toString(); });
        ffprobe.on('close', (code) => {
          try { fs.unlinkSync(samplePath); } catch (e) {}
          if (code !== 0 || !out) return resolve(null);
          try {
            // The full probe: resolution, bitrate, frame rate and the real track lists
            // were always in this JSON and were being dropped on the floor. videoFile.length
            // is passed because `format.size`/`format.bit_rate` describe the truncated
            // SAMPLE on disk, not the real file — reading them would report ~4 MB.
            const facts = normalizeProbe(JSON.parse(out), videoFile.length);
            // The 7 flat keys callers already read (decidePlaybackStrategy, the !vcodec
            // retry gate) ride along on the same object, so both shapes share one owner.
            resolve(Object.assign({ mediaFacts: facts }, legacyProbeAlias(facts)));
          } catch (e) {
            resolve(null);
          }
        });
        ffprobe.on('error', () => { try { fs.unlinkSync(samplePath); } catch (e) {} resolve(null); });
      });
    });
  }

  // Pick the cheapest pipeline that yields a Chromecast-compatible stream.
  // containerExt is the file extension (no dot), e.g. 'mp4', 'mkv'.
  // Returns { strategy, audioArgs, videoArgs } where strategy is one of:
  //   'directplay'   — serve raw bytes; no FFmpeg
  //   'remux'        — `-c:v copy -c:a copy` into fMP4/HLS
  //   'remux-audio'  — `-c:v copy -c:a aac …`
  //   'transcode'    — full re-encode (Tier 3)
  decidePlaybackStrategy(probe, containerExt) {
    const cont = String(containerExt || '').toLowerCase().replace(/^\./, '');
    const directContainer = cont === 'mp4' || cont === 'm4v';

    // No probe data: fall back to extension-only decision.
    if (!probe) {
      if (directContainer) return { strategy: 'directplay' };
      return { strategy: 'remux', audioArgs: ['-c:a', 'copy'], videoArgs: ['-c:v', 'copy'] };
    }

    const vcodec = (probe.vcodec || '').toLowerCase();
    const acodec = (probe.acodec || '').toLowerCase();
    const vlevel = Number.isFinite(probe.vlevel) ? probe.vlevel : null;

    const isH264 = vcodec === 'h264' || vcodec === 'avc' || vcodec === 'avc1';
    const isHevc = vcodec === 'hevc' || vcodec === 'h265';
    const needsVideoReencode = !isH264 || (vlevel != null && vlevel > 51); // L5.1 cap for CC1AD845

    // Audio compatibility: Chromecast default receiver plays AAC + MP3 reliably.
    const audioCastCompatible = acodec === 'aac' || acodec === 'mp3' || acodec === 'mp4a';

    if (!needsVideoReencode && audioCastCompatible && directContainer) {
      return { strategy: 'directplay' };
    }

    // H.264 in MP4/MKV uses AVCC packaging; MPEG-TS needs Annex-B. ffmpeg's hls
    // muxer mostly auto-applies this filter, but being explicit avoids edge cases
    // (some MKV muxes ship NAL units that the auto-detector misses).
    const h264BsfArgs = isH264 ? ['-bsf:v', 'h264_mp4toannexb'] : [];

    if (!needsVideoReencode && audioCastCompatible) {
      // Codecs are fine, only the container is wrong → cheapest tier.
      return {
        strategy: 'remux',
        videoArgs: ['-c:v', 'copy', ...h264BsfArgs],
        audioArgs: ['-c:a', 'copy'],
      };
    }

    if (!needsVideoReencode) {
      // Video copy, audio transcode (AC3/EAC3/DTS/FLAC/Opus/TrueHD/...).
      return {
        strategy: 'remux-audio',
        videoArgs: ['-c:v', 'copy', ...h264BsfArgs],
        audioArgs: ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'],
      };
    }

    // Tier 3 — encoder args injected later by caller from this._encoderArgs().
    return {
      strategy: 'transcode',
      audioArgs: ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'],
      hevcSource: isHevc,
    };
  }

  // Detect the fastest available H.264 encoder by probing ffmpeg with a tiny null test.
  // Priority: NVIDIA NVENC ? Intel QSV ? AMD AMF/VCE ? Apple VideoToolbox ? CPU ultrafast
  async detectBestEncoder() {
    if (this._bestEncoder) return this._bestEncoder;
    if (!this.ffmpegPath) { this._bestEncoder = null; return null; }

    const { spawnSync } = require('child_process');

    // Bitrates tuned for Full HD (1080p): 10M target allows VBR headroom for complex scenes
    const candidates = [
      {
        encoder: 'h264_nvenc',
        extraArgs: ['-preset', 'p4', '-b:v', '10M', '-maxrate', '18M', '-bufsize', '18M'],
        label: 'NVIDIA NVENC (GPU)',
      },
      {
        encoder: 'h264_qsv',
        extraArgs: ['-preset', 'veryfast', '-b:v', '10M'],
        label: 'Intel QuickSync (GPU)',
      },
      {
        encoder: 'h264_amf',
        extraArgs: ['-quality', 'quality', '-b:v', '10M'],
        label: 'AMD AMF (GPU)',
      },
      {
        encoder: 'h264_videotoolbox',
        extraArgs: ['-b:v', '10M'],
        label: 'Apple VideoToolbox (GPU)',
      },
      {
        encoder: 'libx264',
        extraArgs: ['-preset', 'veryfast', '-crf', '20'],
        label: 'CPU ultrafast (libx264)',
      },
    ];

    for (const candidate of candidates) {
      const result = spawnSync(this.ffmpegPath, [
        '-f', 'lavfi', '-i', 'nullsrc=s=64x64:d=0.1',
        '-c:v', candidate.encoder,
        ...candidate.extraArgs,
        '-f', 'null', '-',
      ], hiddenChildProcessOptions({ stdio: 'pipe', timeout: 6000 }));

      if (result.status === 0) {
        this._bestEncoder = candidate;
        console.log(chalk.green(`\n? GPU/HW encoder selected: ${candidate.label}`));
        return candidate;
      }
    }

    this._bestEncoder = null;
    return null;
  }

  // Build ffmpeg video encoding args. Inserts -vf scale (even dimensions) and -pix_fmt yuv420p
  // so GPU encoders (NVENC, QSV, AMF) don't fail with "Error while opening encoder".
  _encoderArgs(enc, burnFilter = null) {
    const filters = [];
    if (burnFilter) filters.push(`subtitles=${burnFilter}`); // burn subtitles into the picture (libass)
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    const scaleAndPix = [
      '-vf', filters.join(','),
      '-pix_fmt', 'yuv420p',
    ];
    if (!enc) {
      return [...scaleAndPix, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
    }
    return [...scaleAndPix, '-c:v', enc.encoder, ...enc.extraArgs];
  }

  async startStreamingServer(videoFile, callback, subtitlePath = null) {
    const port = 8000;
    const videoExt = path.extname(videoFile.name).toLowerCase();
    const containerExt = videoExt.replace(/^\./, '');

    // Probe video + audio streams once, decide playback tier from the result.
    const probe = await this.probeMediaStreams(videoFile);
    const codec = probe ? probe.vcodec : null;
    let strategyInfo = this.decidePlaybackStrategy(probe, containerExt);

    // FFmpeg is required for any non-directplay tier; fall back to directplay if missing.
    if (strategyInfo.strategy !== 'directplay' && !this.ffmpegPath) {
      console.log(chalk.yellow('\nNon-MP4 / non-AAC content - install ffmpeg for HLS remux/transcode. Falling back to direct-play.'));
      strategyInfo = { strategy: 'directplay' };
    }

    // Burn-in subtitles requires re-encoding the video — force the transcode tier
    // (you can't stream-copy and overlay text at the same time).
    if (this._burnSubtitlePath && this.ffmpegPath) {
      strategyInfo = { strategy: 'transcode', audioArgs: ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'] };
      this._log('Burn-in subtitles enabled — forcing full transcode.');
    }

    // Detect best H.264 encoder up front for Tier 3 only.
    let selectedEncoder = null;
    if (strategyInfo.strategy === 'transcode') {
      selectedEncoder = await this.detectBestEncoder();
      this._log(`Full transcode required (${codec || 'unknown'} → H.264) via ${selectedEncoder ? selectedEncoder.label : 'CPU libx264'}.`);
    } else if (strategyInfo.strategy === 'remux') {
      this._log(`Tier 1 remux: ${codec || 'video'}/${probe ? probe.acodec : 'audio'} stream-copy into HLS fMP4 (near-zero CPU).`);
    } else if (strategyInfo.strategy === 'remux-audio') {
      this._log(`Tier 2: video stream-copy, audio transcode (${probe && probe.acodec ? probe.acodec : 'audio'} → aac) into HLS fMP4.`);
    } else {
      this._log(`Tier 0 direct-play: serving raw ${containerExt || 'file'} via byte-range.`);
    }

    const useHls = strategyInfo.strategy !== 'directplay';
    const serveTranscoded = useHls; // legacy alias kept for HTML player flag
    const needsTranscode = useHls;

    // MIME for raw byte-range `/video.<ext>` path (VLC + direct-play). Always derived
    // from the source container, never overridden by HLS playback mode.
    const rawContentType = (
      { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v' }[videoExt] || 'video/mp4'
    );

    // HLS session state — created on first HLS request, reused thereafter.
    let hlsState = null;
    if (useHls) {
      const sessionDir = path.join(this.tempDir, `hls_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      try { fs.mkdirSync(sessionDir, { recursive: true }); } catch (e) {}

      // ON-DEMAND VOD: we know the total duration up front, so the player gets a COMPLETE
      // playlist (full seek bar from second 0, no "LIVE" badge) and each segment is made
      // on demand — seeking anywhere runs `ffmpeg -ss <t>` against the :8090 stream.
      //   • copy tiers (remux/remux-audio): stream-copy → original quality.
      //   • transcode (HEVC/etc.): per-segment re-encode with the detected encoder.
      // Burn-in subtitles still use the old sequential pipeline (the overlay needs one
      // continuous filter graph).
      const isCopyTier = strategyInfo.strategy === 'remux' || strategyInfo.strategy === 'remux-audio';
      const isTranscode = strategyInfo.strategy === 'transcode' && !this._burnSubtitlePath;
      const canOnDemand = isCopyTier || isTranscode;
      let durationSec = 0;
      if (canOnDemand) {
        // probe already carries format.duration when it came from the URL (or a sample
        // big enough to hold the header) — no need to spend another ffprobe round on it.
        if (probe && Number.isFinite(probe.durationSec) && probe.durationSec > 0) {
          durationSec = probe.durationSec;
        } else {
          try { durationSec = await this._probeDurationSeconds(this._torrserverStreamUrl); } catch (e) {}
        }
      }
      // On-demand VOD is OFF by default because its playlist is a promise `-c copy` can't
      // keep. It declares a uniform 6.000s grid up front, but stream copy can only cut on
      // keyframes — measured on a SubsPlease release, keyframes sit on a ~6.006s grid, so
      // seg1 really starts at 4.004s and runs 8.007s. Segments overlap ~2s while claiming
      // to be back-to-back. hls.js silently remaps the timestamps (which is why the web
      // player never showed it), but Chromecast's receiver trusts the playlist, sees the
      // timeline jump backwards after the first segment, decides the stream ended and
      // drops to its backdrop — "plays a few seconds, then the Chromecast logo".
      //
      // The continuous pipeline cuts on real keyframes as it reaches them and writes each
      // #EXTINF from the segment it actually produced, so the playlist matches the media
      // and strict receivers are happy. Cost: the seek window covers what's been remuxed
      // so far rather than the whole file from second zero.
      //
      // UPLAYER_HLS_ONDEMAND=1 restores the old seek-anywhere behaviour — only safe when
      // nothing strict (Chromecast) will ever play this stream.
      const onDemand = process.env.UPLAYER_HLS_ONDEMAND === '1' && canOnDemand && durationSec > 0;
      const segDur = 6;

      hlsState = {
        dir: sessionDir,
        indexPath: path.join(sessionDir, 'index.m3u8'),
        process: null,
        starting: false,
        started: false,
        startError: null,
        // on-demand VOD fields
        onDemand,
        segDur,
        duration: durationSec,
        totalSegs: onDemand ? Math.max(1, Math.ceil(durationSec / segDur)) : 0,
        videoArgs: isTranscode ? this._encoderArgs(selectedEncoder, null) : (strategyInfo.videoArgs || ['-c:v', 'copy']),
        audioArgs: strategyInfo.audioArgs || (isTranscode ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'] : ['-c:a', 'copy']),
        url: this._torrserverStreamUrl,
        producer: null,
      };
      this._log(onDemand
        ? `HLS: on-demand VOD — ${Math.round(durationSec)}s, ${hlsState.totalSegs} segments, ${isTranscode ? 'transcode' : 'copy'} (full seek bar, seek anywhere)`
        : 'HLS: sequential pipeline');
    }

    const startHlsPipeline = () => {
      // Start exactly once per session. ffmpeg copy-remuxes the whole file (fast when
      // it's already downloaded), reaches EOF and exits cleanly — which nulls .process.
      // Without the `started` latch, the next /hls/ request would respawn ffmpeg from
      // byte 0, overwriting every segment and rewriting index.m3u8 underneath the
      // player (hls.js tolerates it; Chromecast catches the playlist mid-rewrite and stops).
      if (!hlsState || hlsState.started || hlsState.process || hlsState.starting) return;
      hlsState.starting = true;
      hlsState.started = true;
      const { spawn } = require('child_process');

      const HLS_SEGMENT_SECS = 6;
      // Assume 30 fps as a safe upper bound for GOP sizing. Real fps comes from probe
      // but defaulting to 30 errs on the side of MORE-frequent keyframes (smaller GOP)
      // when the source is 24-25 fps; this only costs a tiny bit of bitrate efficiency
      // and guarantees segments stay within HLS_SEGMENT_SECS.
      const ASSUMED_FPS = 30;
      const GOP_FRAMES = HLS_SEGMENT_SECS * ASSUMED_FPS;
      let videoArgs;
      let audioArgs;
      let spawnCwd;
      if (strategyInfo.strategy === 'transcode') {
        // Force a keyframe every HLS_SEGMENT_SECS so HLS segments line up exactly with
        // GOPs. Without this, the encoder reuses source GOPs (often 10 s+) which makes
        // ffmpeg produce oversized segments and — worse — leaves later segments without
        // a leading keyframe, which the Chromecast decoder hates (plays seg0, stops at
        // seg1).
        //
        // Three layers of insurance because each encoder honors different options:
        //   -g GOP_FRAMES                    universal max-GOP size
        //   -keyint_min 1                    allow forced keyframes anywhere (libx264 / NVENC)
        //   -sc_threshold 0                  libx264: no extra keyframes on scene cuts
        //   -force_key_frames expr:…         demuxer-level keyframe hint
        //   -forced-idr 1                    NVENC: turn forced keyframes into real IDR frames
        let burnFilter = null;
        if (this._burnSubtitlePath) {
          try {
            const ext = (path.extname(this._burnSubtitlePath) || '.srt').toLowerCase();
            fs.copyFileSync(this._burnSubtitlePath, path.join(this.tempDir, 'burnsub' + ext));
            spawnCwd = this.tempDir;        // run ffmpeg here so the subtitles= path needs no escaping
            burnFilter = 'burnsub' + ext;
            this._log('Burning subtitles into the cast stream: ' + path.basename(this._burnSubtitlePath));
          } catch (e) { this._log('Burn-in copy failed: ' + e.message); }
        }
        videoArgs = [
          ...this._encoderArgs(selectedEncoder, burnFilter),
          '-g', String(GOP_FRAMES),
          '-keyint_min', '1',
          '-sc_threshold', '0',
          '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SECS})`,
          '-forced-idr', '1',
        ];
        audioArgs = strategyInfo.audioArgs || ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'];
      } else {
        videoArgs = strategyInfo.videoArgs || ['-c:v', 'copy'];
        audioArgs = strategyInfo.audioArgs || ['-c:a', 'copy'];
      }

      // MPEG-TS segments — Chromecast default receiver (CC1AD845) plays these reliably
      // across all generations; fMP4 (.m4s) is supported only on newer CAF receivers
      // and frequently shows the "loading forever" symptom otherwise.
      //
      // EVENT playlist (not VOD) — the playlist is GROWING as ffmpeg produces segments.
      // VOD declares "this is the full list" and Chromecast stops after the last listed
      // segment if #EXT-X-ENDLIST is missing (which it is until ffmpeg exits). EVENT
      // explicitly signals "keep polling"; ffmpeg adds #EXT-X-ENDLIST automatically on
      // clean shutdown so the manifest becomes a valid VOD playlist by then.
      //
      // -hls_list_size 0  → never drop old segments (default for VOD/event differs).
      const ffmpegArgs = [
        '-i', 'pipe:0',
        ...videoArgs,
        ...audioArgs,
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_playlist_type', 'event',
        '-hls_list_size', '0',
        '-hls_segment_type', 'mpegts',
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', path.join(hlsState.dir, 'seg%05d.ts'),
        hlsState.indexPath,
      ];

      const inputStream = videoFile.createReadStream();
      const ffmpeg = spawn(this.ffmpegPath, ffmpegArgs, hiddenChildProcessOptions({ stdio: ['pipe', 'pipe', 'pipe'], cwd: spawnCwd }));
      hlsState.process = ffmpeg;
      hlsState.starting = false;
      this.activeStreams.add(ffmpeg);
      inputStream.pipe(ffmpeg.stdin);

      inputStream.on('error', () => { try { ffmpeg.kill(); } catch (e) {} });
      ffmpeg.stdin.on('error', () => { try { inputStream.destroy(); } catch (e) {} });
      this._log(`HLS pipeline starting: ffmpeg ${ffmpegArgs.slice(0, 20).join(' ')}${ffmpegArgs.length > 20 ? ' …' : ''}`);
      let stderrTail = '';
      ffmpeg.stderr.on('data', (d) => {
        const chunk = d.toString();
        stderrTail = (stderrTail + chunk).slice(-2000);
        const line = chunk.trim();
        if (/error|failed|invalid|cannot|unable/i.test(line)) {
          this._log(`HLS ffmpeg: ${line.substring(0, 300)}`);
        }
      });
      ffmpeg.on('close', (code) => {
        this.activeStreams.delete(ffmpeg);
        hlsState.process = null;
        if (code !== 0 && code !== null) {
          hlsState.startError = `ffmpeg exit ${code}`;
          this._log(`HLS pipeline exited with code ${code}. Last stderr:\n${stderrTail}`);
        }
      });
    };

    // --- on-demand VOD helpers (copy tiers) --------------------------------
    const padSeg = (n) => `seg${String(n).padStart(5, '0')}.ts`;

    // A COMPLETE VOD playlist for the whole episode — built from the known duration, so
    // the player shows the full seek bar (no "LIVE") immediately. Segments are produced
    // lazily as the player requests them.
    const buildVodPlaylist = () => {
      const { segDur, totalSegs, duration } = hlsState;
      let m = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:' + (segDur + 1)
        + '\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n';
      for (let i = 0; i < totalSegs; i++) {
        const segLen = (i === totalSegs - 1) ? Math.max(0.1, duration - i * segDur) : segDur;
        m += '#EXTINF:' + segLen.toFixed(3) + ',\n' + padSeg(i) + '\n';
      }
      return m + '#EXT-X-ENDLIST\n';
    };

    // Produce ONE segment independently and atomically. ffmpeg -ss jumps straight to the
    // segment's 6 s boundary — which is a keyframe, since the source GOP is 2 s — and
    // stream-copies 6 s to a temp file that's renamed in only once complete (so the player
    // never reads a half-written segment). -copyts keeps the real, continuous timestamps,
    // so the timeline stays seamless across segments and across seeks. This per-segment
    // model is fast (~1-2 s) and reliable; the previous single rolling ffmpeg could hang.
    const pending = new Map(); // K -> in-flight production promise (dedup)
    const produceSegment = (K) => new Promise((resolve) => {
      const { spawn } = require('child_process');
      const segPath = path.join(hlsState.dir, padSeg(K));
      const tmp = path.join(hlsState.dir, `.seg${K}.${Math.random().toString(36).slice(2, 8)}.tmp`);
      const segLen = (K === hlsState.totalSegs - 1)
        ? Math.max(0.5, hlsState.duration - K * hlsState.segDur)
        : hlsState.segDur;
      // -output_ts_offset puts the segment's timestamps at its real position (K*segDur)
      // so the timeline is continuous across segments and seeks. (-copyts would do that
      // too, but it breaks -t — ffmpeg measures the duration against the shifted clock
      // and stops "in the past", producing an empty file → the seek would hang.)
      const args = [
        '-ss', String(K * hlsState.segDur), '-i', hlsState.url,
        '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
        ...hlsState.videoArgs, ...hlsState.audioArgs,
        '-t', String(segLen), '-output_ts_offset', String(K * hlsState.segDur),
        '-muxdelay', '0', '-muxpreload', '0',
        '-f', 'mpegts', '-loglevel', 'error', '-y', tmp,
      ];
      const proc = spawn(this.ffmpegPath, args, hiddenChildProcessOptions({ stdio: ['ignore', 'ignore', 'pipe'] }));
      this.activeStreams.add(proc);
      let tail = '';
      proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-500); });
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 45000);
      proc.on('close', (code) => {
        clearTimeout(timer); this.activeStreams.delete(proc);
        try {
          if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) { fs.renameSync(tmp, segPath); resolve(segPath); return; }
        } catch (e) {}
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
        if (tail) this._log(`HLS seg${K} produce failed: ${tail.slice(-160)}`);
        resolve(null);
      });
      proc.on('error', () => { clearTimeout(timer); try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {} resolve(null); });
    });

    const ensureSegment = (K) => {
      const segPath = path.join(hlsState.dir, padSeg(K));
      try { if (fs.existsSync(segPath) && fs.statSync(segPath).size > 0) return Promise.resolve(segPath); } catch (e) {}
      if (pending.has(K)) return pending.get(K);
      const pr = produceSegment(K);
      pending.set(K, pr);
      pr.then(() => pending.delete(K), () => pending.delete(K));
      return pr;
    };

    // Web player + Cast URL: HLS playlist when remuxing/transcoding, raw file when direct-play.
    const videoUrl = useHls ? '/hls/index.m3u8' : `/video${videoExt}`;
    // Original file URL for VLC (VLC can play any format, no transcoding needed)
    // Always use the original file extension, even if transcoding is enabled for web
    const originalFileUrl = `/video${videoExt}`;
    const videoName = videoFile.name;
    const contentType = useHls ? 'application/vnd.apple.mpegurl' : (
      { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v' }[videoExt] || 'video/mp4'
    );
    const htmlVideoType = `type="${contentType}"`;

    const requestHandler = (req, res) => {
      // Handle root request - serve unified native JS player page
      if (req.url === '/' || req.url === '/index.html') {
        const html = this.getNativePlayerHTML(videoUrl, htmlVideoType, videoName, serveTranscoded);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(html);
        return;
      }

      // Serve vendored player libs (Video.js, JASSUB) from public/vendor/.
      if (req.url.startsWith('/vendor/')) {
        const rel = req.url.split('?')[0].replace(/^\/+/, '');
        const file = path.join(__dirname, 'public', path.normalize(rel));
        const vendorRoot = path.join(__dirname, 'public', 'vendor');
        if (file.startsWith(vendorRoot) && fs.existsSync(file)) {
          const ext = path.extname(file).toLowerCase();
          const types = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
          res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
          res.end(fs.readFileSync(file));
          return;
        }
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end('');
        return;
      }

      if (req.url === '/player.css') {
        const css = this.getNativePlayerCSS();
        res.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(css);
        return;
      }

      if (req.url === '/player.js') {
        const js = this.getNativePlayerJS();
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(js);
        return;
      }
      
      // API endpoint to check available subtitles
      if (req.url === '/api/subtitles' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache'
        });
        const subtitleList = this.subtitlePaths.map((sub, index) => {
          let ready = false;
          if (!sub.isPlaceholder && sub.path) {
            try {
              if (fs.existsSync(sub.path)) {
                const st = fs.statSync(sub.path);
                // Placeholder / not-yet-written files must not look "ready" to Cast (empty WEBVTT breaks subs).
                ready = st.size > 24;
              }
            } catch (e) {
              ready = false;
            }
          }
          return {
            index,
            url: `${this.streamBasePath || ''}/subtitle_${index}.vtt`,
            // Same track, SRT dialect — for DLNA TVs, which parse the sidecar
            // themselves and mostly don't accept WebVTT.
            srtUrl: `${this.streamBasePath || ''}/subtitle_${index}.srt`,
            language: sub.language || 'en',
            label: sub.label || `Subtitle ${index + 1}`,
            source: sub.source || 'unknown',
            ready,
            // complete === true once extraction finished; clients stop re-fetching this track.
            complete: sub.complete === true,
          };
        });
        const subTools = require('./core/subtitle-tools');
        res.end(JSON.stringify({
          subtitles: subtitleList,
          count: subtitleList.length,
          // Which one-click tools the player should offer, and the state of the
          // currently/last-running job (generate/sync) for button spinners.
          tools: { alass: subTools.isAlassAvailable(), whisper: subTools.isWhisperAvailable() },
          job: this._subtitleJob || null,
        }));
        return;
      }

      // Playback-position pings from the player page (same origin as the player, so
      // no CORS dance). Emitted as an event; the web server owning this session
      // persists it to watch history for resume/continue-watching.
      if (req.url === '/api/progress' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 4096) { try { req.destroy(); } catch (e) {} } });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            // The same endpoint carries failures, so a dead source reaches the app
            // instead of dying silently in the player tab.
            if (data.error && typeof data.error === 'object') {
              this.emit('playback_error', {
                code: data.error.code == null ? null : data.error.code,
                message: String(data.error.message || 'Playback failed'),
              });
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end('{"ok":true}');
              return;
            }
            const positionSec = Number(data.positionSec);
            const durationSec = Number(data.durationSec);
            if (Number.isFinite(positionSec) && positionSec >= 0) {
              this.emit('playback_position', {
                positionSec,
                durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
                ended: data.ended === true,
              });
            }
          } catch (e) { /* malformed ping — ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end('{"ok":true}');
        });
        return;
      }

      // One-click subtitle tools, called by the player's control-bar buttons. Both are
      // slow (audio extraction + alass/whisper), so they run as a single background job
      // and reply immediately; the player watches `job` on /api/subtitles and picks up
      // the finished track through its normal manifest poll.
      const startSubtitleJob = (kind, work) => {
        if (this._subtitleJob && this._subtitleJob.running) {
          res.writeHead(409, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: false, reason: 'a subtitle job is already running' }));
          return;
        }
        this._subtitleJob = { kind, running: true, error: null, startedAt: Date.now() };
        work()
          .then((r) => { this._subtitleJob = { kind, running: false, error: r && r.ok ? null : ((r && r.reason) || 'failed'), startedAt: this._subtitleJob.startedAt }; })
          .catch((e) => { this._subtitleJob = { kind, running: false, error: e.message, startedAt: this._subtitleJob.startedAt }; });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, started: true, kind }));
      };

      if (req.url === '/api/subtitles/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 4096) { try { req.destroy(); } catch (e) {} } });
        req.on('end', () => {
          let language;
          try { language = (JSON.parse(body || '{}').language || '').trim() || undefined; } catch (e) {}
          // Cap the transcribed span so whisper-tiny stays in the minutes range even on
          // long movies; the opening 20 minutes is plenty to judge usefulness.
          startSubtitleJob('generate', () => this.generateSubtitles({ language, maxSeconds: 1200 }));
        });
        return;
      }

      if (req.url === '/api/subtitles/sync' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; if (body.length > 4096) { try { req.destroy(); } catch (e) {} } });
        req.on('end', () => {
          let index = -1;
          try { index = Number(JSON.parse(body || '{}').index); } catch (e) {}
          const src = Number.isInteger(index) && index >= 0 ? this.subtitlePaths[index] : null;
          if (!src || !src.path) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: false, reason: 'no subtitle track at that index' }));
            return;
          }
          // Embedded tracks were muxed with this exact video — their clock IS the
          // video's clock. Refusing here keeps a misclick from burning minutes of
          // audio extraction to "fix" timing that cannot be wrong.
          if (src.source === 'embedded') {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ok: false, reason: 'embedded subtitles are already in sync with the video — timing fix is for downloaded subtitles' }));
            return;
          }
          startSubtitleJob('sync', async () => {
            const r = await this.syncSubtitle(src.path, { maxSeconds: 1200 });
            if (r.ok) {
              // syncSubtitle returns a file but doesn't self-register — add it as a NEW
              // track so the player can offer both the original and the synced version.
              const label = `${src.label || 'Subtitle'} (synced)`;
              this.subtitlePaths.push({
                path: r.output,
                source: 'alass',
                language: src.language || 'en',
                label,
                codec: 'srt',
                complete: true,
              });
              // A running VLC gets the corrected track pushed too (see the owning server).
              this.emit('subtitle_updated', { path: r.output, label });
            }
            return r;
          });
        });
        return;
      }

      // Serve subtitle files. WebVTT is the house format (browsers + Chromecast); the
      // .srt twin exists for DLNA TVs, which parse the sidecar themselves and largely
      // don't speak WebVTT. Same index, same file on disk — so an auto-synced swap
      // (which replaces the path at the SAME index) reaches both without re-indexing.
      const subtitleMatch = req.url.match(/^\/subtitle_(\d+)\.(vtt|srt)(\?.*)?$/);
      if (subtitleMatch) {
        const subtitleIndex = parseInt(subtitleMatch[1]);
        const wantSrt = subtitleMatch[2] === 'srt';
        if (subtitleIndex >= 0 && subtitleIndex < this.subtitlePaths.length) {
          const subPath = this.subtitlePaths[subtitleIndex].path;
          const emptyVtt = 'WEBVTT\n\n';

          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
              'Access-Control-Allow-Headers': 'Range',
              'Access-Control-Max-Age': '86400'
            });
            res.end();
            return;
          }

          let subtitleContent = emptyVtt;
          try {
            if (fs.existsSync(subPath)) {
              subtitleContent = fs.readFileSync(subPath, 'utf8');
            }
          } catch (err) {
            subtitleContent = emptyVtt;
          }

          const isSRT = subPath.toLowerCase().endsWith('.srt') ||
                       (!subPath.toLowerCase().endsWith('.vtt') &&
                        !subtitleContent.trim().startsWith('WEBVTT'));
          if (isSRT) {
            subtitleContent = this.convertSRTtoVTT(subtitleContent);
          }
          if (wantSrt) {
            subtitleContent = this.convertVTTtoSRT(subtitleContent);
          }

          const vttBuffer = Buffer.from(subtitleContent, 'utf8');
          res.writeHead(200, {
            // text/srt is what the DLNA DIDL declares for this file (core/dlna-caster
            // subInfo). Serving a different type than we advertised is a reason some
            // renderers drop the sidecar, so the two are kept identical on purpose.
            'Content-Type': wantSrt ? 'text/srt; charset=utf-8' : 'text/vtt; charset=utf-8',
            'Content-Length': vttBuffer.length,
            'Accept-Ranges': 'none',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range',
            'Access-Control-Expose-Headers': 'Content-Length',
            'Cache-Control': 'no-cache'
          });

          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(vttBuffer);
          }
          return;
        }
        res.writeHead(404, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain'
        });
        res.end('');
        return;
      }

      // HLS endpoint family: /hls/index.m3u8, /hls/init.mp4, /hls/segNNNNN.m4s
      // Spawns one FFmpeg per session on first request, then serves segment files
      // as they appear on disk. Waits briefly for files that the encoder hasn't
      // produced yet (FFmpeg writes them sequentially with -hls_flags temp_file).
      const hlsMatch = req.url.match(/^\/hls\/([A-Za-z0-9_.-]+)(\?.*)?$/);
      if (hlsMatch) {
        if (!hlsState) {
          res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
          res.end('HLS pipeline not active for this stream');
          return;
        }

        const fileName = hlsMatch[1];
        const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range',
        };
        if (req.method === 'OPTIONS') {
          res.writeHead(204, Object.assign({ 'Access-Control-Max-Age': '86400' }, cors));
          res.end();
          return;
        }

        // ON-DEMAND VOD (copy tiers): full playlist served by us; segments produced on
        // demand so the player has a real seek bar from the start and can jump anywhere.
        if (hlsState.onDemand) {
          if (fileName === 'index.m3u8') {
            const body = buildVodPlaylist();
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' }, cors));
            res.end(req.method === 'HEAD' ? undefined : body);
            return;
          }
          const segM = fileName.match(/^seg(\d+)\.ts$/);
          if (segM) {
            const K = parseInt(segM[1], 10);
            ensureSegment(K).then((segPath) => {
              if (!segPath) { res.writeHead(404, cors); res.end('segment unavailable'); return; }
              res.writeHead(200, Object.assign({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'public, max-age=300' }, cors));
              if (req.method === 'HEAD') { res.end(); return; }
              const fsr = fs.createReadStream(segPath);
              fsr.on('error', () => { try { res.end(); } catch (e) {} });
              fsr.pipe(res);
            }).catch(() => { try { res.writeHead(500, cors); res.end('segment error'); } catch (e) {} });
            return;
          }
          res.writeHead(404, cors); res.end('');
          return;
        }

        // TRANSCODE tier: sequential EVENT pipeline (one ffmpeg, segments served as written).
        startHlsPipeline();
        const resolvedPath = path.join(hlsState.dir, fileName);
        if (path.relative(hlsState.dir, resolvedPath).startsWith('..')) {
          res.writeHead(403, cors); res.end('');
          return;
        }
        const isPlaylist = fileName.endsWith('.m3u8');
        const isSegment = fileName.endsWith('.ts');
        const maxWaitMs = isPlaylist ? 15000 : 60000;
        const startedWaiting = Date.now();
        const tryServe = () => {
          if (fs.existsSync(resolvedPath)) {
            let mime = 'application/octet-stream';
            if (isPlaylist) mime = 'application/vnd.apple.mpegurl';
            else if (isSegment) mime = 'video/mp2t';
            res.writeHead(200, Object.assign({ 'Content-Type': mime, 'Cache-Control': isPlaylist ? 'no-cache' : 'public, max-age=300' }, cors));
            if (req.method === 'HEAD') { res.end(); return; }
            const fileStream = fs.createReadStream(resolvedPath);
            fileStream.on('error', () => { try { res.end(); } catch (e) {} });
            fileStream.pipe(res);
            return;
          }
          if (hlsState.startError) {
            res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain' }, cors));
            res.end(`HLS pipeline error: ${hlsState.startError}`);
            return;
          }
          if (Date.now() - startedWaiting >= maxWaitMs) {
            res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, cors));
            res.end('Segment not ready');
            return;
          }
          setTimeout(tryServe, 200);
        };
        tryServe();
        return;
      }

      const videoPathMatch = req.url.match(/^\/video\.(\w+)(\?.*)?$/);
      if (!videoPathMatch) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('');
        return;
      }

      // Extract requested video extension
      const requestedExt = videoPathMatch[1].toLowerCase();

      // Chromecast receivers send User-Agent containing CrKey; they need Content-Range on the first
      // byte fetch so they know the full size. A plain 200 with a short body looks like the whole file
      // and MP4/Matroska may not have headers in the first 10MB (playback never starts).
      const chromecastReceiverLike = /\bCrKey\b/i.test(String(req.headers['user-agent'] || ''));

      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Length': videoFile.length,
          'Accept-Ranges': 'bytes',
          'Content-Type': rawContentType,
          'Access-Control-Allow-Origin': '*',
        });
        res.end();
        return;
      }

      if (req.method !== 'GET') {
        res.writeHead(405, {
          'Content-Type': 'text/plain',
          'Allow': 'GET, HEAD',
          'Access-Control-Allow-Origin': '*',
        });
        res.end('');
        return;
      }

      // Handle range requests for video streaming (or transcoding for HEVC)
      const range = req.headers.range;

      let stream;

      const destroyStream = () => {
        if (!stream) return;
        this.activeStreams.delete(stream);
        if (typeof stream.kill === 'function') stream.kill();
        else if (!stream.destroyed) stream.destroy();
        stream = null;
      };

      // ENHANCED: Handle client disconnect with stream cleanup
      res.on('close', () => {
        destroyStream();
        // Trigger garbage collection hint if available (V8 specific)
        if (global.gc && this.lowMemoryMode) {
          setImmediate(() => {
            try {
              global.gc();
            } catch (e) {
              // GC not exposed, ignore
            }
          });
        }
      });

      // Handle response errors
      res.on('error', (err) => {
        destroyStream();
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
          console.error('Response error:', err.message);
        }
      });

      // Without Range: use 200 + Content-Length matching the body (first chunk only).
      // Browsers/VLC expect 200 for a plain GET; 206 without a client Range breaks many stacks.
      // Chromecast still gets an honest length (no "wait for full file" hang).
      // With Range: 206 + Content-Range (standard partial content).
      const maxChunkSize = 10 * 1024 * 1024; // first-chunk cap for plain (no-Range) GETs only
      let start;
      let end;
      let usePartialContent = false;
      if (!range) {
        start = 0;
        const firstByteCap = chromecastReceiverLike
          ? Math.min(32 * 1024 * 1024, videoFile.length)
          : maxChunkSize;
        end = Math.min(firstByteCap - 1, videoFile.length - 1);
        usePartialContent = chromecastReceiverLike;
      } else {
        const positions = range.replace(/bytes=/, '').split('-');
        start = parseInt(positions[0], 10);
        // Open-ended range (`bytes=N-`, what a browser <video> and VLC send): stream
        // straight through to EOF in ONE sequential read instead of capping each
        // response. TorrServer's reader is sequential with a large read-ahead window,
        // so a single long-lived stream keeps its cache filled AHEAD of playback. The
        // old per-response cap forced a brand-new range request — and a fresh TorrServer
        // reader seek + piece re-prioritisation — every ~10 MB, which is exactly what
        // produced the periodic stalls/lag while watching. On seek the player tears the
        // connection down (`res` 'close' → destroyStream), so a seek now costs ONE new
        // sequential read, not a storm of them. An explicit end is still honoured as-is.
        const requestedEnd = positions[1]
          ? parseInt(positions[1], 10)
          : (videoFile.length - 1);
        end = Math.min(requestedEnd, videoFile.length - 1);
        usePartialContent = true;
      }
      if (
        !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end < 0 || start > end || start >= videoFile.length
      ) {
        res.writeHead(416, {
          'Content-Range': `bytes */${videoFile.length}`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end();
        return;
      }
      end = Math.min(end, videoFile.length - 1);
      const chunksize = (end - start) + 1;

      if (usePartialContent) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${videoFile.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': rawContentType,
          'Access-Control-Allow-Origin': '*',
        });
      } else {
        res.writeHead(200, {
          'Content-Length': chunksize,
          'Accept-Ranges': 'bytes',
          'Content-Type': rawContentType,
          'Access-Control-Allow-Origin': '*',
        });
      }

      stream = videoFile.createReadStream({
        start,
        end,
        highWaterMark: 5 * 1024 * 1024,
      });

      this.activeStreams.add(stream);

      stream.on('error', (err) => {
        if (!res.destroyed) {
          destroyStream();
          if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') {
            console.error('Stream error:', err.message);
          }
        }
      });

      stream.on('data', (chunk) => {
        if (!res.write(chunk)) {
          stream.pause();
        }
      });

      res.on('drain', () => {
        stream.resume();
      });

      stream.on('end', () => {
        res.end();
      });
    };

    // Register this stream with the shared hub instead of opening a per-stream port.
    // Every concurrent stream is served from ONE shared HTTP server and told apart by
    // a unique id in the URL path (http://host:PORT/<streamId>/…), so a single port is
    // ever opened no matter how many streams run at once. The id is generated once and
    // reused if the same StreamManager (re)starts.
    const bindHost = buildAccessibleUrls(port).bindHost;
    const streamId = this.streamId || (this.streamId = crypto.randomBytes(8).toString('hex'));
    this.streamBasePath = '/' + streamId;
    this._hubStreamId = streamId;
    streamHub.register(streamId, requestHandler, port, bindHost)
      .then(({ port: actualPort }) => {
        this.streamPort = actualPort;
        // The path option prefixes every accessible URL with /<streamId>, so the cast /
        // VLC / subtitle URLs the caller builds by concatenation inherit it automatically.
        const urls = buildAccessibleUrls(actualPort, { path: '/' + streamId });
        // videoUrl is for the web player (may be transcoded), originalFileUrl is for VLC
        // (always original format); the caller appends them to the prefixed root URL.
        callback(urls.preferred, urls, videoUrl, originalFileUrl, {
          // videoFormat is now DERIVED from mediaFacts rather than built separately, so
          // the two can't drift. Its shape is unchanged — the UI and localStorage still
          // read the same four keys.
          videoFormat: toVideoFormat(probe && probe.mediaFacts, videoExt, strategyInfo.strategy),
          mediaFacts: (probe && probe.mediaFacts) || null,
        });
      })
      .catch((err) => { console.error('Stream hub listen failed:', err && err.message); });
  }
  
  getNativePlayerCSS() {
    try {
      return fs.readFileSync(path.join(__dirname, 'public', 'player', 'native-player.css'), 'utf8');
    } catch (e) {
      return 'body{margin:0;background:#000;color:#fff;font-family:Arial,sans-serif;}';
    }
  }

  getNativePlayerJS() {
    try {
      return fs.readFileSync(path.join(__dirname, 'public', 'player', 'native-player.js'), 'utf8');
    } catch (e) {
      return 'console.error("Native player script not found");';
    }
  }

  getNativePlayerHTML(videoUrl, htmlVideoType, videoName, transcoding = false) {
    const esc = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Every URL the player requests must carry this stream's id prefix so the shared
    // hub can route it back here (the page itself is served from /<streamId>/). When
    // there is no base path (e.g. unit tests) URLs stay root-relative as before.
    const base = this.streamBasePath || '';
    const prefix = (u) => (typeof u === 'string' && u.startsWith('/')) ? base + u : u;

    const normalizedTracks = this.subtitlePaths.map((sub, index) => {
      const language = (sub.language || 'en').toString().trim().toLowerCase() || 'en';
      return {
        index,
        language,
        label: sub.label || `Subtitle ${index + 1}`,
        source: sub.source || 'unknown',
        url: `${base}/subtitle_${index}.vtt`,
      };
    });

    const isHlsSource = /\.m3u8(\?|$)/.test(String(videoUrl || ''));

    const config = JSON.stringify({
      transcoding: !!transcoding,
      isHlsSource,
      videoUrl: prefix(videoUrl),
      subtitleCount: normalizedTracks.length,
      subtitleTracks: normalizedTracks,
      subtitleManifestUrl: `${base}/api/subtitles`,
      progressUrl: `${base}/api/progress`,
      minPositionSec: MIN_POSITION_SEC,
    });

    // Minimal, clean player: a single full-screen Video.js element with its built-in
    // control bar (which already provides a subtitles/captions menu). All the subtitle
    // loading is done in native-player.js; no custom toolbar/sync-popup/overlay.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(videoName)}</title>
  <link rel="stylesheet" href="${base}/vendor/videojs/video-js.min.css">
  <link rel="stylesheet" href="${base}/player.css">
</head>
<body>
  <video id="videoPlayer" class="video-js vjs-big-play-centered" controls preload="auto" playsinline crossorigin="anonymous"></video>
  <script>window.__UPLAYER_PLAYER_CONFIG__ = ${config};</script>
  <script src="${base}/vendor/videojs/video.min.js"></script>
  <script src="${base}/player.js"></script>
</body>
</html>`;
  }

  stop() {
    this._stopHealthTicker();
    // Unregister from the shared hub (this closes the shared server only if no other
    // concurrent stream is still registered) instead of closing a per-stream server.
    if (this._hubStreamId) {
      streamHub.unregister(this._hubStreamId);
      this._hubStreamId = null;
    }
    this.server = null;
    const hash = this.currentHash;
    this.currentHash = null;
    this._releaseTorrServer(hash);
  }

  // Remove this stream's torrent from the shared engine. TorrServer is a long-lived
  // service for the whole app — started once at boot, stopped only on app exit — so we
  // deliberately NEVER stop it here. Tearing it down per-stream is what caused it to
  // "open and close every time" and the :8090 restart races ("did not start on :8090").
  async _releaseTorrServer(hash) {
    if (!this.tsClient) return;
    try { if (hash) await this.tsClient.remove(hash); } catch (e) {}
  }

  // ENHANCED: Cleanup method to free memory
  cleanup() {
    // Don't destroy active streams, just trigger GC
    // Active streams will be cleaned up when they finish naturally
    
    // Trigger garbage collection if available
    if (global.gc) {
      try {
        global.gc();
        if (this.memoryTracker) {
          this.memoryTracker.logMemory('After cleanup');
        }
      } catch (e) {
        // GC not exposed, run with --expose-gc flag
      }
    }
  }

  async destroy() {
    this._destroyed = true;
    this._stopHealthTicker();
    // Stop periodic cleanup
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this._cancelPendingStream) {
      try {
        this._cancelPendingStream();
      } catch (e) {
        // Ignore pending setup cancellation failures during teardown
      }
      this._cancelPendingStream = null;
    }
    
    // Kill the background transcode child if running — it holds the sandbox video
    // file open, which would block the sandbox cleanup below.
    if (this._transcodeProc) {
      try { this._transcodeProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      this._transcodeProc = null;
    }

    // Clean up all active streams / child processes. ffmpeg children are tracked here
    // too — they expose .kill(), not .destroy(); killing them releases the file handles.
    this.activeStreams.forEach(entry => {
      try {
        if (entry && typeof entry.kill === 'function') {
          entry.kill('SIGKILL');
        } else if (entry && !entry.destroyed) {
          entry.destroy();
        }
      } catch (e) {
        // Ignore individual teardown failures
      }
    });
    this.activeStreams.clear();
    
    // Unregister from the shared hub — the shared server is closed only when the last
    // concurrent stream is gone, so tearing down one stream never kills the others.
    if (this._hubStreamId) {
      try { streamHub.unregister(this._hubStreamId); } catch (e) { /* ignore */ }
      this._hubStreamId = null;
    }
    this.server = null;

    // Remove this stream's torrent; only kill TorrServer if no other stream still uses it.
    const hashToRelease = this.currentHash;
    this.currentHash = null;
    await this._releaseTorrServer(hashToRelease);

    // SECURITY: Clean up sandbox
    if (this.sandbox) {
      try {
        this.sandbox.cleanup();
      } catch (e) {
        // Ignore sandbox cleanup failures during teardown
      }
    }

    this.emit('exit', { code: 0 });
  }
}

// Main CLI interface
async function main() {
  const sandboxModule = require('./sandbox.js');

  program
    .name('uplayer')
    .description('Uplayer - Simple torrent player. Search and play movies instantly')
    .version('1.0.0');

  // Clean command: remove cached torrent chunks and temp files (fixes dark screen / stale data)
  program
    .command('clean')
    .description('Remove cached WebTorrent chunks and temp files (run when video shows dark screen or stale playback)')
    .action(() => {
      let count = sandboxModule.cleanAllStreamingTemp();
      // Also clean project .temp folder (subtitle downloads)
      const tempDir = path.join(__dirname, '.temp');
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          count++;
        } catch (e) { /* ignore */ }
      }
      console.log(chalk.green(`? Cleaned ${count} temp/cache location(s). Restart UPlayer and try again.`));
    });

  program
    .command('web')
    .description('Start the Uplayer web interface')
    .option('-p, --port <port>', 'Port to run the web interface on')
    .action(async (options) => {
      const requestedPort = options.port ? Number(options.port) : Number(process.env.PORT || 3000);
      const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 3000;
      const { startServer, stopServer, getServerUrl } = require('./server');

      let server;
      try {
        server = startServer(port);
        await waitForServerReady(server);
      } catch (error) {
        if (error && error.code === 'EADDRINUSE') {
          const alreadyRunning = await probeExistingWebServer(port);
          if (alreadyRunning) {
            const existingUrl = buildAccessibleUrls(port).preferred;
            console.log(chalk.yellow(`Uplayer web is already running at ${existingUrl}`));
            await open(existingUrl, { newInstance: true, wait: false }).catch(() => {});
            return;
          }
        }
        throw error;
      }

      const webUrl = typeof getServerUrl === 'function' ? getServerUrl() : buildAccessibleUrls(port).preferred;
      console.log(chalk.green(`Web interface ready at ${webUrl}`));
      await open(webUrl, { newInstance: true, wait: false }).catch(() => {});

      let shuttingDown = false;
      const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        if (signal) {
          console.log(chalk.yellow(`\nStopping web server (${signal})...`));
        }
        try {
          await stopServer();
        } catch (err) {
          // Ignore shutdown errors and exit cleanly.
        }
        process.exit(0);
      };

      process.on('SIGINT', () => { shutdown('SIGINT'); });
      process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    });

  program
    .argument('[query]', 'Movie name to search and stream')
    .option('-m, --magnet <link>', 'Direct magnet link to stream')
    .option('-t, --torrent <file>', 'Torrent file path')
    .option('--no-open', 'Do not auto-open player')
    .option('--no-subtitles', 'Deprecated no-op (single runtime mode always handles subtitles automatically)')
    .option('--low-memory', 'Deprecated no-op (single runtime mode always uses the default setup)')
    .option('--debug-memory', 'Enable detailed memory tracking and diagnostics (helps identify crash causes)')
    .option('--expose-gc', 'Enable garbage collection (run with: node --expose-gc stream.js)')
    .action(async (query, options) => {
      const debugMemory = options.debugMemory === true;
      const deprecatedFlags = [];
      if (options.lowMemory === true) deprecatedFlags.push('--low-memory');
      if (options.subtitles === false) deprecatedFlags.push('--no-subtitles');
      if (deprecatedFlags.length > 0) {
        console.log(
          chalk.yellow(
            `${deprecatedFlags.join(', ')} ${deprecatedFlags.length > 1 ? 'are' : 'is'} deprecated and now treated as no-op.`
          )
        );
      }

      const services = createSharedServices({
        constructors: {
          TorrentScraper,
          StreamManager,
          MediaSearcher,
          SubtitleManager,
        },
      });
      for (const warning of services.runtime.warnings) {
        console.warn(chalk.yellow(`${warning}`));
      }
      
      // Initialize memory tracker if requested
      const memoryTracker = new MemoryTracker(debugMemory);
      
      const streamManager = services.createStreamManager({ memoryTracker });
      const scraper = services.createTorrentScraper();
      const mediaSearcher = services.createMediaSearcher();

      // Cleanup function to ensure proper resource cleanup
      const cleanup = async (exitCode = 0) => {
        try {
          // Clear the progress line first to prevent terminal clutter
          process.stdout.write('\r\x1b[K');
          console.log(chalk.yellow('\nStopping stream...'));
          if (memoryTracker) {
            memoryTracker.stop();
          }
          if (streamManager) {
            await streamManager.destroy();
          }
        } catch (err) {
          // Ignore cleanup errors
        }
        process.exit(exitCode);
      };

      // Handle cleanup on all exit scenarios
      process.on('SIGINT', () => { cleanup(0); });
      process.on('SIGTERM', () => { cleanup(0); });
      process.on('exit', () => {
        // Synchronous cleanup only
        try {
          if (streamManager && streamManager.client) {
            streamManager.client.destroy();
          }
        } catch (err) {
          // Ignore
        }
      });

      try {
        let magnetLink = null;
        let selectedResult = null;  // Declare at higher scope

        // If direct magnet or torrent file provided
        if (options.magnet) {
          magnetLink = options.magnet;
        } else if (options.torrent) {
          const torrentPath = path.resolve(options.torrent);
          if (!fs.existsSync(torrentPath)) {
            console.error(chalk.red(`Error: Torrent file not found: ${torrentPath}`));
            process.exit(1);
          }
          magnetLink = torrentPath;
        } else {
          // Variables to store season/episode for filtering (declare at higher scope)
          let searchSeason = null;
          let searchEpisode = null;
          
          // Get search query
          let searchQuery = query;
          if (!searchQuery) {
            const answer = await inquirer.prompt([
              {
                type: 'input',
                name: 'query',
                message: 'Enter movie or TV show name:',
                validate: (input) => input.trim().length > 0 || 'Please enter a name'
              }
            ]);
            searchQuery = answer.query;
          }

          // Ask what type of content user is searching for
          const typeAnswer = await inquirer.prompt([
            {
              type: 'list',
              name: 'mediaType',
              message: 'What are you searching for?',
              choices: [
                { name: 'Movie', value: 'movie' },
                { name: 'TV Show', value: 'tv' }
              ]
            }
          ]);
          const mediaType = typeAnswer.mediaType;

          // Search TMDB database using API only
          console.log(chalk.cyan('\n[1/4] Discovering title metadata'));
          console.log(chalk.blue(`Searching TMDB database for: ${searchQuery}...`));
          let tmdbResults = [];
          
          try {
            if (mediaType === 'movie') {
              tmdbResults = await mediaSearcher.searchMovies(searchQuery);
            } else {
              tmdbResults = await mediaSearcher.searchTVShows(searchQuery);
            }
          } catch (error) {
            console.error(chalk.red(`\n? Error searching TMDB: ${error.message}`));
            console.log(chalk.yellow('Falling back to direct torrent search...'));
            tmdbResults = [];
          }

          let selectedMedia = null;
          
          if (tmdbResults.length > 0) {
            // Let user select from TMDB results
            const choices = tmdbResults.map((r, i) => ({
              name: r.displayTitle,
              value: i
            }));

            const mediaAnswer = await inquirer.prompt([
              {
                type: 'list',
                name: 'media',
                message: 'Select from TMDB database:',
                choices: choices,
                pageSize: 10
              }
            ]);

            selectedMedia = tmdbResults[mediaAnswer.media];
            console.log(chalk.green(`\n? Selected: ${selectedMedia.displayTitle}`));
            
            // Use TMDB title for torrent search (without year - only title)
            searchQuery = selectedMedia.title;
            // Don't include year in search query - only title, season/episode filtered after search

            // For TV shows, get seasons and episodes from TMDB (like Elementum)
            if (mediaType === 'tv' && (selectedMedia.tmdbId || selectedMedia.id)) {
              const tvShowId = selectedMedia.tmdbId || selectedMedia.id;
              console.log(chalk.blue(`\nLoading seasons for ${selectedMedia.title}...`));
              let seasons = [];
              try {
                seasons = await mediaSearcher.getTVShowSeasons(tvShowId);
              } catch (error) {
                console.error(chalk.red(`\n? Error loading seasons: ${error.message}`));
              }
              
              if (seasons.length > 0) {
                // Add "Last Season" option at the top
                const seasonChoices = [
                  { name: 'Last Season', value: 'last' },
                  ...seasons.map(s => ({
                    name: s.displayName,
                    value: s.number
                  }))
                ];

                const seasonAnswer = await inquirer.prompt([
                  {
                    type: 'list',
                    name: 'season',
                    message: 'Select a season:',
                    choices: seasonChoices,
                    pageSize: 10
                  }
                ]);

                let selectedSeason = null;
                if (seasonAnswer.season === 'last') {
                  selectedSeason = seasons[0]; // First one is the latest (sorted descending)
                } else {
                  selectedSeason = seasons.find(s => s.number === seasonAnswer.season);
                }

                if (selectedSeason) {
                  const tvShowId = selectedMedia.tmdbId || selectedMedia.id;
                  console.log(chalk.cyan(`\nLoading episodes for ${selectedSeason.displayName}...`));
                  const episodes = await mediaSearcher.getSeasonEpisodes(tvShowId, selectedSeason.number);
                  
                  if (episodes.length > 0) {
                    const episodeChoices = episodes.map(e => ({
                      name: e.displayName,
                      value: e.number
                    }));

                    const episodeAnswer = await inquirer.prompt([
                      {
                        type: 'list',
                        name: 'episode',
                        message: 'Select an episode:',
                        choices: episodeChoices,
                        pageSize: 15
                      }
                    ]);

                    const selectedEpisode = episodes.find(e => e.number === episodeAnswer.episode);
                    if (selectedEpisode) {
                      // Store season/episode separately for filtering - search by show name only
                      searchSeason = selectedSeason.number;
                      searchEpisode = selectedEpisode.number;
                    } else {
                      // If no episodes found, just use season
                      searchSeason = selectedSeason.number;
                      searchEpisode = null;
                    }
                }
              } else {
                // Fallback to manual input if seasons not found
                console.log(chalk.yellow('\nCould not load seasons. Enter manually...'));
                const seasonAnswer = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'season',
                    message: 'Enter season number (or press Enter to skip):',
                    validate: (input) => {
                      if (!input.trim()) return true;
                      const num = parseInt(input);
                      return !isNaN(num) && num > 0 || 'Please enter a valid season number';
                    }
                  }
                ]);

                if (seasonAnswer.season && seasonAnswer.season.trim()) {
                  const episodeAnswer = await inquirer.prompt([
                    {
                      type: 'input',
                      name: 'episode',
                      message: 'Enter episode number (or press Enter to skip):',
                      validate: (input) => {
                        if (!input.trim()) return true;
                        const num = parseInt(input);
                        return !isNaN(num) && num > 0 || 'Please enter a valid episode number';
                      }
                    }
                  ]);

                  const season = seasonAnswer.season.trim();
                  if (episodeAnswer.episode && episodeAnswer.episode.trim()) {
                    const episode = episodeAnswer.episode.trim();
                    // Store season/episode separately for filtering - search by show name only
                    searchSeason = parseInt(season);
                    searchEpisode = parseInt(episode);
                  } else {
                    searchSeason = parseInt(season);
                    searchEpisode = null;
                  }
                }
              }
            } else if (mediaType === 'tv') {
              // Fallback if no TMDB ID
              const seasonAnswer = await inquirer.prompt([
                {
                  type: 'input',
                  name: 'season',
                  message: 'Enter season number (or press Enter to skip):',
                  validate: (input) => {
                    if (!input.trim()) return true;
                    const num = parseInt(input);
                    return !isNaN(num) && num > 0 || 'Please enter a valid season number';
                  }
                }
              ]);

              if (seasonAnswer.season && seasonAnswer.season.trim()) {
                const episodeAnswer = await inquirer.prompt([
                  {
                    type: 'input',
                    name: 'episode',
                    message: 'Enter episode number (or press Enter to skip):',
                    validate: (input) => {
                      if (!input.trim()) return true;
                      const num = parseInt(input);
                      return !isNaN(num) && num > 0 || 'Please enter a valid episode number';
                    }
                  }
                ]);

                const season = seasonAnswer.season.trim();
                if (episodeAnswer.episode && episodeAnswer.episode.trim()) {
                  const episode = episodeAnswer.episode.trim();
                  // Store season/episode separately for filtering - search by show name only
                  searchSeason = parseInt(season);
                  searchEpisode = parseInt(episode);
                } else {
                  searchSeason = parseInt(season);
                  searchEpisode = null;
                }
              }
            }
          }
          
          // If no TMDB results, use original search query
          if (tmdbResults.length === 0) {
            console.log(chalk.yellow('\nNo results from TMDB. Using original search query...'));
          }

          // Search for torrents using only the show/movie name (filter by season/episode after)
          console.log(chalk.cyan('\n[2/4] Finding torrents'));
          console.log(chalk.blue(`Searching torrents for: ${searchQuery}...`));
          const results = await scraper.searchAllSources(searchQuery, null, searchSeason, searchEpisode);
            
          if (results.length === 0) {
            console.error(chalk.red('\n? No torrents found. Try a different search term.'));
            process.exit(1);
          }

          // Sort by seeders
          results.sort((a, b) => b.seeders - a.seeders);

          // If only one result, use it; otherwise let user choose
          if (results.length === 1) {
            selectedResult = results[0];
          } else {
            // Show top 10 results
            const choices = results.slice(0, 10).map((r, i) => ({
              name: `${r.name} | ${r.size} | Seeds ${r.seeders} | Source ${r.source}`,
              value: i
            }));

            const answer = await inquirer.prompt([
              {
                type: 'list',
                name: 'torrent',
                message: 'Select a torrent:',
                choices: choices,
                pageSize: 10
              }
            ]);

            selectedResult = results[answer.torrent];
          }

          console.log(chalk.green(`\n? Selected: ${selectedResult.name}`));
          
          // Ask if user wants subtitles
          const subtitleAnswer = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'wantSubtitles',
              message: 'Do you want to search for subtitles?',
              default: true
            }
          ]);

          let subtitlePath = null;
          if (subtitleAnswer.wantSubtitles) {
            // Ask for subtitle language
            const languageAnswer = await inquirer.prompt([
              {
                type: 'list',
                name: 'language',
                message: 'Select subtitle language:',
                choices: [
                  { name: 'English', value: 'en' },
                  { name: 'Arabic', value: 'ar' },
                  { name: 'Spanish', value: 'es' },
                  { name: 'French', value: 'fr' },
                  { name: 'German', value: 'de' },
                  { name: 'Italian', value: 'it' },
                  { name: 'Portuguese', value: 'pt' },
                  { name: 'Russian', value: 'ru' },
                  { name: 'Chinese', value: 'zh' },
                  { name: 'Japanese', value: 'ja' },
                  { name: 'Korean', value: 'ko' }
                ],
                default: 'en'
              }
            ]);

            const selectedLanguage = languageAnswer.language;
            const languageNames = {
              'en': 'English',
              'ar': 'Arabic',
              'es': 'Spanish',
              'fr': 'French',
              'de': 'German',
              'it': 'Italian',
              'pt': 'Portuguese',
              'ru': 'Russian',
              'zh': 'Chinese',
              'ja': 'Japanese',
              'ko': 'Korean'
            };
            
            console.log(chalk.cyan('\n[3/4] Resolving subtitles'));
            console.log(chalk.green(`? Selected language: ${languageNames[selectedLanguage]}`));
            
            const subtitleManager = services.createSubtitleManager();
            
            // Prepare subtitle search query - ALWAYS use TMDB data when available (clean and accurate)
            let subtitleQuery = searchQuery;
            let subtitleYear = null;
            let subtitleTmdbId = null;
            let subtitleMediaType = null;
            let subtitleSeason = null;
            let subtitleEpisode = null;
            
            // Use TMDB data (title + year + ID) for accurate subtitle search
            if (selectedMedia) {
              subtitleQuery = selectedMedia.title;
              subtitleYear = selectedMedia.year;
              subtitleTmdbId = selectedMedia.tmdbId || selectedMedia.id;
              subtitleMediaType = mediaType;
              
              console.log(chalk.cyan(`Using TMDB data for subtitles:`));
              console.log(chalk.cyan(`   Title: ${subtitleQuery}`));
              console.log(chalk.cyan(`   Year: ${subtitleYear || 'N/A'}`));
              console.log(chalk.cyan(`   TMDB ID: ${subtitleTmdbId || 'N/A'}`));
              console.log(chalk.cyan(`   Type: ${subtitleMediaType || 'N/A'}`));
              
              // Use stored season/episode for TV shows
              if (mediaType === 'tv') {
                subtitleSeason = searchSeason;
                subtitleEpisode = searchEpisode;
                console.log(chalk.cyan(`   Season: ${subtitleSeason}, Episode: ${subtitleEpisode}`));
              }
            } else {
              // Fallback: Extract year from torrent name if no TMDB data
              const torrentName = selectedResult.name;
              const yearMatch = torrentName.match(/\((\d{4})\)|\[(\d{4})\]|[\s\.](\d{4})[\s\.]/);
              subtitleYear = yearMatch ? (yearMatch[1] || yearMatch[2] || yearMatch[3]) : null;
              console.log(chalk.cyan(`No TMDB data - using search query: ${subtitleQuery} (${subtitleYear || 'N/A'})`));
            }
            
            // Build display query with year for user feedback
            const displayQuery = subtitleYear ? `${subtitleQuery} (${subtitleYear})` : subtitleQuery;
            if (subtitleSeason && subtitleEpisode) {
              console.log(chalk.blue(`\nSearching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery} S${subtitleSeason.toString().padStart(2, '0')}E${subtitleEpisode.toString().padStart(2, '0')}...`));
            } else {
              console.log(chalk.blue(`\nSearching ${languageNames[selectedLanguage]} subtitles for: ${displayQuery}...`));
            }
            
            const subtitles = await subtitleManager.searchSubtitles(
              subtitleQuery,
              selectedLanguage,
              subtitleSeason,
              subtitleEpisode,
              subtitleYear,      // Pass year
              subtitleTmdbId,    // Pass TMDB ID for precise matching
              subtitleMediaType  // Pass media type (movie/tv)
            );

            if (subtitles.length > 0) {
              const subtitleChoices = subtitles.slice(0, 15).map((s, i) => ({
                name: `${s.title} | ${s.language} | ${s.downloadCount} downloads`,
                value: i
              }));

              subtitleChoices.push({ name: '? Skip subtitles', value: -1 });

              const subtitleSelect = await inquirer.prompt([
                {
                  type: 'list',
                  name: 'subtitle',
                  message: 'Select a subtitle:',
                  choices: subtitleChoices,
                  pageSize: 15
                }
              ]);

              if (subtitleSelect.subtitle !== -1) {
                const selectedSubtitle = subtitles[subtitleSelect.subtitle];
                const tempDir = path.join(__dirname, '.temp');
                if (!fs.existsSync(tempDir)) {
                  fs.mkdirSync(tempDir, { recursive: true });
                }
                subtitlePath = path.join(tempDir, `subtitle_${Date.now()}.srt`);
                
                console.log(chalk.cyan(`Downloading subtitle from ${selectedSubtitle.source}...`));
                const downloaded = await subtitleManager.downloadSubtitle(
                  selectedSubtitle.fileId || selectedSubtitle.id,
                  subtitlePath,
                  selectedSubtitle.source,
                  selectedSubtitle.downloadUrl || selectedSubtitle.attributes?.addic7ed_url || selectedSubtitle.attributes?.subsplease_url,
                  selectedSubtitle.language || selectedSubtitle.attributes?.language || null
                );
                
                if (downloaded) {
                  console.log(chalk.green(`? Subtitle downloaded: ${subtitlePath}`));
                } else {
                  console.log(chalk.yellow(`Failed to download subtitle`));
                  subtitlePath = null;
                }
              }
            } else {
              console.log(chalk.yellow(`No subtitles found`));
            }
          }
          
          console.log(chalk.cyan('\n[4/4] Starting stream'));
          console.log(chalk.cyan(`Getting magnet link...`));
          magnetLink = await scraper.getMagnetLink(selectedResult);
          
          // Store subtitle path for later use
          if (subtitlePath) {
            selectedResult.subtitlePath = subtitlePath;
          }
        }

        if (!magnetLink) {
          console.error(chalk.red('\n? Could not get magnet link.'));
          cleanup(1);
          return;
        }

        // Start streaming with subtitle if available
        await streamManager.stream(magnetLink, {
          openPlayer: options.open !== false,
          subtitlePath: selectedResult?.subtitlePath || null,
        });
      }
    } catch (error) {
        // Handle user cancellation (Ctrl+C during prompts)
        if (error.isTtyError || error.name === 'ExitPromptError') {
          cleanup(0);
          return;
        }
        const message = String(error && error.message ? error.message : error);
        console.error(chalk.red(`\n? Error: ${message}`));
        if (/timeout|no peers|Could not connect to torrent/i.test(message)) {
          console.log(chalk.yellow('   Hint: pick a torrent with more seeders or retry in a few minutes.'));
        }
        if (/EADDRINUSE|address already in use/i.test(message)) {
          console.log(chalk.yellow('   Hint: stop previous streams or run `uplayer clean`, then retry.'));
        }
        if (/subtitle token/i.test(message)) {
          console.log(chalk.yellow('   Hint: subtitle tokens expire; restart the subtitle step and try again.'));
        }
        cleanup(1);
      }
    });

  program.parse();
}

module.exports = { TorrentScraper, StreamManager, MediaSearcher, SubtitleManager, dedupeTorrentResults, filterByPreferredQuality, _streamHub: streamHub };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

