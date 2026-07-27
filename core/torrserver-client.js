'use strict';

/*
 * TorrServer sidecar client.
 *
 * TorrServer (https://github.com/YouROK/TorrServer) is the torrent engine: it
 * downloads from the swarm and serves the chosen file over HTTP with range
 * support. Uplayer runs it as a local sidecar and talks to its HTTP API.
 *
 * Desktop: this module spawns the bundled binary.
 * Android (nodejs-mobile): the native side may launch the arm binary itself and
 *   set UPLAYER_TORRSERVER_EXTERNAL=1 — then this module just connects to it.
 *
 * The spawned process is supervised: if it dies while nobody called stop(), a
 * watchdog respawns it with exponential backoff (a real session once froze at 38%
 * mid-movie because the engine had silently died and nothing brought it back).
 * Its stdout/stderr go to <dataDir>/torrserver.log — TorrServer is a Go binary and
 * dies by panicking to stderr, so discarding that output made every crash
 * undiagnosable. Engine lifecycle is reported through the injected onEvent
 * callback; this module never emits or logs to anything it wasn't handed.
 *
 * Binary resolution order:
 *   1. UPLAYER_TORRSERVER_PATH (explicit)
 *   2. <repo>/vendor/torrserver/<platform-binary>   (provisioned by setup)
 *   3. <repo>/bench/<platform-binary>               (the benchmark copy, for dev)
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_PORT = 8090;
const VIDEO_RE = /\.(mkv|mp4|avi|mov|m4v|webm|ts|flv|wmv|mpg|mpeg|m2ts)$/i;

// Watchdog backoff: 1s, 2s, 4s … capped at 30s. The cap matters more than the curve —
// a binary that dies instantly (bad port, corrupt download) must not become a hot
// respawn loop, but a swarm-killing crash mid-movie should recover in ~a second.
const RESPAWN_BASE_MS = 1000;
const RESPAWN_MAX_MS = 30000;
// A process that survived this long was healthy; its eventual death starts the backoff
// over rather than continuing a stale streak from crashes an hour ago.
const STABLE_UPTIME_MS = 60000;
const LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate to .old past this — it's a diagnostic tail, not an archive

function respawnDelayMs(attempt) {
  return Math.min(RESPAWN_MAX_MS, RESPAWN_BASE_MS * Math.pow(2, Math.max(0, attempt)));
}

// Curated, long-lived public trackers. Many magnets (esp. from 1337x/PirateBay) ship with
// few or dead trackers, so the engine starts cold and leans on DHT alone — slow to find
// peers. Announcing to a broad set of WORKING trackers in parallel surfaces peers much
// faster, which speeds the whole ramp (metadata → first bytes → full speed). These are the
// most stable public UDP/HTTP trackers (up for years); override/extend with the env var
// UPLAYER_EXTRA_TRACKERS (whitespace/comma separated; set it empty to disable injection).
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker-udp.gbitt.info:80/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://uploads.gamecoast.net:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'http://tracker.openbittorrent.com:80/announce',
];

function resolveTrackers() {
  const env = process.env.UPLAYER_EXTRA_TRACKERS;
  if (env != null) return env.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean); // empty → disabled
  return DEFAULT_TRACKERS;
}

// Append our tracker list to a magnet (deduped against the ones it already carries). Only
// touches magnet links with an infohash; .torrent URLs / raw hashes pass through unchanged.
function enrichMagnet(magnet, trackers) {
  if (!trackers || !trackers.length) return magnet;
  if (typeof magnet !== 'string' || !/^magnet:\?/i.test(magnet) || !/xt=urn:btih/i.test(magnet)) return magnet;
  const have = new Set();
  let m; const re = /[?&]tr=([^&]+)/gi;
  while ((m = re.exec(magnet))) { try { have.add(decodeURIComponent(m[1]).toLowerCase()); } catch (e) { have.add(m[1].toLowerCase()); } }
  const extra = trackers.filter((t) => t && !have.has(String(t).toLowerCase()));
  if (!extra.length) return magnet;
  return magnet + extra.map((t) => '&tr=' + encodeURIComponent(t)).join('');
}

function platformBinaryName() {
  const a = process.arch;
  switch (process.platform) {
    case 'win32': return 'TorrServer-windows-amd64.exe';
    case 'darwin': return a === 'arm64' ? 'TorrServer-darwin-arm64' : 'TorrServer-darwin-amd64';
    case 'android': return a === 'arm' ? 'TorrServer-android-arm7' : 'TorrServer-android-arm64';
    case 'linux':
      if (a === 'arm64') return 'TorrServer-linux-arm64';
      if (a === 'arm') return 'TorrServer-linux-arm7';
      return 'TorrServer-linux-amd64';
    default: return 'TorrServer-linux-amd64';
  }
}

function resolveBinary() {
  const env = process.env.UPLAYER_TORRSERVER_PATH;
  if (env && fs.existsSync(env)) return env;
  const name = platformBinaryName();
  const candidates = [
    path.join(__dirname, '..', 'vendor', 'torrserver', name),
    path.join(__dirname, '..', 'bench', name),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return env || candidates[0];
}

function request(port, method, urlPath, body, { raw = false, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, timeout }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { if (raw) return resolve(buf); try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve(buf); } });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class TorrServerClient {
  constructor(opts = {}) {
    this.port = opts.port || Number(process.env.UPLAYER_TORRSERVER_PORT) || DEFAULT_PORT;
    this.binPath = opts.binPath || resolveBinary();
    this.dataDir = opts.dataDir || process.env.UPLAYER_TORRSERVER_DATA || path.join(os.tmpdir(), 'uplayer-torrserver');
    // external = an instance is already running (e.g. launched natively on Android); don't spawn/kill it.
    this.external = opts.external || process.env.UPLAYER_TORRSERVER_EXTERNAL === '1';
    this.settingsOverride = opts.settings || {};
    this.proc = null;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    // Engine lifecycle callback (engine_exit / engine_respawned / engine_respawn_failed).
    // Injected, per house rules — this module tells its owner, it doesn't import a bus.
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    // Extra trackers injected into every magnet to find peers faster (see DEFAULT_TRACKERS).
    this.extraTrackers = opts.trackers || resolveTrackers();
    this.logPath = opts.logPath || path.join(this.dataDir, 'torrserver.log');
    // Watchdog state. Armed only after a successful start of a process WE spawned —
    // start()'s own boot loop owns failures before that, and external engines are
    // someone else's to supervise.
    this._watchdogArmed = false;
    this._stopping = false;
    this._respawnTimer = null;
    this._respawnAttempt = 0;
    this._spawnedAt = 0;
    // Torrents are added with save_to_db:false, so a respawned engine comes back
    // EMPTY — without this ledger a crash mid-movie would leave every active
    // session pointing at a 404. Re-adding the same magnet yields the same
    // infohash, so stream URLs survive the restart untouched.
    this._addedTorrents = new Map(); // hash → { link, title }
  }

  async echo() {
    try { const t = await request(this.port, 'GET', '/echo', null, { raw: true, timeout: 2000 }); return /Torr|MatriX/i.test(t) ? String(t).trim() : null; }
    catch (e) { return null; }
  }
  async isUp() { return !!(await this.echo()); }

  async start({ waitMs = 30000 } = {}) {
    // Process-wide single-flight: TorrServer is one shared service, so two callers must
    // never run start() at once. Without this, a second stream starting while the first
    // boot is still coming up would spawn a SECOND binary that can't bind :8090, dies, and
    // surfaces as "TorrServer did not start". Concurrent callers await the same start.
    if (this._startPromise) return this._startPromise;
    this._stopping = false; // a deliberate start() supersedes any earlier stop()
    this._startPromise = this._doStart({ waitMs }).finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  // Open the engine log for append, rotating to .old when it grows past the cap.
  // Returns null on failure — a broken log file must never block the engine itself.
  _openLogFd() {
    try {
      try {
        if (fs.statSync(this.logPath).size > LOG_MAX_BYTES) {
          try { fs.unlinkSync(this.logPath + '.old'); } catch (e) {} // rename over an existing target fails on Windows
          fs.renameSync(this.logPath, this.logPath + '.old');
        }
      } catch (e) { /* no log yet */ }
      return fs.openSync(this.logPath, 'a');
    } catch (e) { return null; }
  }

  // Spawn the binary with output captured to the log file, and route its eventual
  // exit through the watchdog. The 'exit' handler compares against the proc it
  // spawned so a late exit from an already-replaced process can't clobber state.
  _spawnProc() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const fd = this._openLogFd();
    this._spawnedAt = Date.now();
    const proc = spawn(this.binPath, ['--port', String(this.port), '--path', this.dataDir], {
      stdio: fd == null ? 'ignore' : ['ignore', fd, fd],
      windowsHide: true,
    });
    if (fd != null) { try { fs.closeSync(fd); } catch (e) {} } // the child holds its own copy
    this.proc = proc;
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this._onProcExit(code == null ? 0 : code);
    });
    return proc;
  }

  _onProcExit(code) {
    if (this._stopping || this.external || !this._watchdogArmed) return;
    if (Date.now() - this._spawnedAt >= STABLE_UPTIME_MS) this._respawnAttempt = 0;
    this.log('TorrServer died unexpectedly (exit code ' + code + ') — last output in ' + this.logPath);
    this.onEvent({ type: 'engine_exit', code });
    this._scheduleRespawn();
  }

  _scheduleRespawn() {
    if (this._stopping || this.external || this._respawnTimer) return;
    const delay = respawnDelayMs(this._respawnAttempt);
    this._respawnAttempt += 1;
    const attempt = this._respawnAttempt;
    this.log('Respawning TorrServer in ' + Math.round(delay / 1000) + 's (attempt ' + attempt + ')');
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (this._stopping || this.proc) return;
      this.start()
        .then(async () => {
          await this._readdTorrents(); // the respawned engine starts empty (save_to_db:false)
          this.log('TorrServer respawned on :' + this.port);
          this.onEvent({ type: 'engine_respawned', attempt });
        })
        .catch((err) => {
          this.onEvent({ type: 'engine_respawn_failed', attempt, error: err && err.message });
          // A spawn-then-instant-death already re-entered via _onProcExit; this covers
          // failures that never made a process (binary missing, port race lost).
          if (!this.proc) this._scheduleRespawn();
        });
    }, delay);
    if (typeof this._respawnTimer.unref === 'function') this._respawnTimer.unref();
  }

  async _doStart({ waitMs = 30000 } = {}) {
    if (await this.isUp()) { this.log('TorrServer already up on :' + this.port); await this.configure(); return; }
    if (this.external) {
      const end = Date.now() + waitMs;
      while (Date.now() < end) { if (await this.isUp()) { await this.configure(); return; } await sleep(500); }
      throw new Error('External TorrServer not reachable on :' + this.port);
    }
    if (!fs.existsSync(this.binPath)) throw new Error('TorrServer binary not found: ' + this.binPath);
    this.log('Starting TorrServer: ' + this.binPath + ' on :' + this.port + ' (log: ' + this.logPath + ')');
    let exitCode = null; // set if the binary dies before it answers
    this._spawnProc().on('exit', (code) => { exitCode = code == null ? 0 : code; });
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      if (await this.isUp()) { await this.configure(); this._watchdogArmed = true; return; }
      // The binary exited before answering. The usual cause is :8090 already being held
      // by another TorrServer (e.g. one left running from a previous app run) — adopt it
      // if it responds, otherwise fail fast with a clear message instead of waiting out
      // the full timeout.
      if (exitCode != null) {
        await sleep(400);
        if (await this.isUp()) { this.log('Adopted existing TorrServer on :' + this.port); await this.configure(); return; }
        throw new Error('TorrServer exited (code ' + exitCode + ') — is :' + this.port + ' already in use by a stray TorrServer? Close it and retry.');
      }
      await sleep(500);
    }
    throw new Error('TorrServer did not start on :' + this.port);
  }

  async configure() {
    try {
      const cur = await request(this.port, 'POST', '/settings', { action: 'get' });

      // Smoothness lever. The cache lives in RAM (UseDisk stays off — disk/SD I/O is
      // itself a stall source on Android). A LARGER cache means a longer read-ahead
      // window, so a brief dip in swarm speed is absorbed by the buffer instead of
      // pausing playback. ReaderReadAHead is the % of that cache kept filled AHEAD of
      // the read head. More connections = more bandwidth headroom = fewer starve stalls.
      // Android gets a more conservative cache default (phones have less spare RAM).
      // Desktop gets a large RAM cache: with a 95% read-ahead this pre-downloads a big
      // cushion AHEAD of the playhead during fast swarm bursts, so a later dip in swarm
      // speed (peers come and go) is absorbed by the buffer instead of stalling playback.
      const defaultCacheMB = process.platform === 'android' ? 256 : 1024;
      const cacheMB = Math.max(64, Number(process.env.UPLAYER_TORRSERVER_CACHE_MB) || defaultCacheMB);
      const conns = Math.max(40, Number(process.env.UPLAYER_TORRSERVER_CONNS) || 200);
      const readAhead = Math.min(100, Math.max(5, Number(process.env.UPLAYER_TORRSERVER_READAHEAD) || 95));

      const desired = Object.assign({
        CacheSize: cacheMB * 1024 * 1024,
        ReaderReadAHead: readAhead,
        ConnectionsLimit: conns,  // default 25 is far too conservative for HD streaming
        EnableDLNA: true,         // cast to LG/Samsung/any DLNA TV natively
        FriendlyName: 'Uplayer',
      }, this.settingsOverride);

      // Writing settings makes TorrServer re-init its torrent client (~3.5s) — a big slice
      // of stream-start latency. So only write when something ACTUALLY differs. The first
      // run applies + persists them (StoreSettingsInJson); every later start finds them
      // already in place and skips the slow write entirely.
      const needsUpdate = Object.keys(desired).some((k) => cur[k] !== desired[k]);
      if (needsUpdate) {
        await request(this.port, 'POST', '/settings', { action: 'set', sets: Object.assign({}, cur, desired) });
        this.log(`TorrServer configured (cache=${cacheMB}MB, readahead=${readAhead}%, conns=${conns}, DLNA=${desired.EnableDLNA})`);
      } else {
        this.log('TorrServer settings already applied — skipping write');
      }
    } catch (e) { this.log('TorrServer configure failed: ' + e.message); }
  }

  async add(magnet, title = '') {
    // Enrich the magnet with our curated trackers so the engine announces widely from the
    // first second — the single biggest lever for finding peers (and metadata) faster.
    const link = enrichMagnet(magnet, this.extraTrackers);
    const r = await request(this.port, 'POST', '/torrents', { action: 'add', link, title, save_to_db: false });
    const hash = r.hash || r.Hash;
    if (!hash) throw new Error('TorrServer add failed: ' + JSON.stringify(r).slice(0, 160));
    this._addedTorrents.set(hash, { link, title });
    return hash;
  }

  // Restore every live torrent into a freshly respawned engine. Failures are logged
  // and skipped — one dead magnet must not block the others from coming back.
  async _readdTorrents() {
    for (const [hash, t] of this._addedTorrents) {
      try {
        await request(this.port, 'POST', '/torrents', { action: 'add', link: t.link, title: t.title, save_to_db: false });
        this.log('Restored torrent after engine restart: ' + hash);
      } catch (e) {
        this.log('Failed to restore torrent ' + hash + ' after restart: ' + e.message);
      }
    }
  }

  async info(hash) { return request(this.port, 'POST', '/torrents', { action: 'get', hash }); }
  async files(hash) { const i = await this.info(hash); return i.file_stats || i.FileStats || []; }

  // The REAL cache state from POST /cache: which pieces are in RAM (map id → piece,
  // absent id = not cached), plus capacity/filled and live engine-side readers.
  // /torrents action:get has none of this — the buffer "estimate" in stream-health
  // predates the discovery that this route exposes a true piece bitmap (verified on
  // MatriX.141.5). Null on any failure; shape is normalized so callers never touch
  // TorrServer's capitalized field names.
  async cacheState(hash) {
    try {
      const c = await request(this.port, 'POST', '/cache', { action: 'get', hash });
      if (!c || typeof c !== 'object' || !c.PiecesLength) return null;
      return {
        capacity: c.Capacity || 0,
        filled: c.Filled || 0,
        piecesCount: c.PiecesCount || 0,
        pieceLength: c.PiecesLength || 0,
        pieces: c.Pieces && typeof c.Pieces === 'object' ? c.Pieces : {},
        readers: Array.isArray(c.Readers) ? c.Readers : [],
      };
    } catch (e) { return null; }
  }

  // Wait until the file list resolves; return the largest (video) file normalized to {id,length,path}.
  async resolveLargestFile(hash, { timeout = 60000, videoOnly = true } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const files = await this.files(hash);
      if (files.length) {
        let pool = files;
        if (videoOnly) { const v = files.filter((f) => VIDEO_RE.test(f.path || f.Path || '')); if (v.length) pool = v; }
        const pick = pool.reduce((a, b) => ((b.length || b.Length) > (a.length || a.Length) ? b : a));
        return { id: pick.id != null ? pick.id : pick.Id, length: pick.length || pick.Length, path: pick.path || pick.Path || 'video' };
      }
      await sleep(500);
    }
    throw new Error('TorrServer: torrent metadata/files did not resolve');
  }

  streamPath(hash, fileId, name = 'video') {
    return `/stream/${encodeURIComponent(path.basename(name))}?link=${hash}&index=${fileId}&play`;
  }

  // Kick TorrServer's NATIVE preload for a file — the same request its own web player
  // issues before it starts playing. The engine is strictly demand-driven: it only
  // downloads while some reader is attached, and after TorrentDisconnectTimeout
  // (default 30s) with no readers it drops the torrent and the download halts.
  // That is why a stream that was added but never played showed a frozen percent
  // until the user opened it in TorrServer's own player. Preload attaches an
  // engine-side reader that fills PreloadCache% of the cache (50% by default —
  // ~512MB of the desktop 1GB cache) with no external player involved.
  //
  // The HTTP request blocks server-side until the preload target is reached, which
  // on a slow swarm is minutes — callers must fire-and-forget this, never await it
  // on the streaming path. Resolves true when the target was reached, false on any
  // failure (including the engine being down); it never throws.
  async preload(hash, fileId, name = 'video', { timeout = 30 * 60 * 1000 } = {}) {
    const p = `/stream/${encodeURIComponent(path.basename(name))}?link=${hash}&index=${fileId}&preload&stat`;
    try { await request(this.port, 'GET', p, null, { raw: true, timeout }); return true; }
    catch (e) { return false; }
  }
  streamUrl(hash, fileId, name = 'video', host = '127.0.0.1') {
    return `http://${host}:${this.port}${this.streamPath(hash, fileId, name)}`;
  }

  // Report what TorrServer actually says, without collapsing. Seeds, connected peers and
  // known-swarm peers are three different numbers (a live swarm reads 84 / 86 / 205) and
  // `active_peers || connected_seeders || total_peers` threw two of them away before any
  // caller got a look. Lossy summarising is the caller's business, not the client's.
  async stats(hash) {
    try {
      const i = await this.info(hash);
      return {
        downloadSpeed: i.download_speed || i.DownloadSpeed || 0,
        uploadSpeed: i.upload_speed || i.UploadSpeed || 0,
        seeds: i.connected_seeders || 0,
        peers: i.active_peers || 0,
        swarmPeers: i.total_peers || 0,
        pendingPeers: i.pending_peers || 0,
        preloadedBytes: i.preloaded_bytes || i.PreloadedBytes || 0,
        loadedBytes: i.loaded_size || 0,
        torrentSize: i.torrent_size || i.TorrentSize || 0,
        chunksRead: i.chunks_read || 0,
        chunksWasted: i.chunks_read_wasted || 0,
        stat: i.stat,
        statText: i.stat_string || null,
      };
    } catch (e) {
      // The engine didn't answer at all — a different fact from "answered with zeros".
      // StreamHealth turns a streak of these into engineDown, which is how a dead
      // engine surfaces in the UI instead of a silently frozen percent.
      return { downloadSpeed: 0, peers: 0, seeds: 0, preloadedBytes: 0, unreachable: true };
    }
  }

  async remove(hash) {
    this._addedTorrents.delete(hash);
    try { await request(this.port, 'POST', '/torrents', { action: 'rem', hash }); } catch (e) {}
  }

  // All torrents currently loaded in TorrServer (across every concurrent stream).
  async list() { try { const r = await request(this.port, 'POST', '/torrents', { action: 'list' }); return Array.isArray(r) ? r : []; } catch (e) { return []; } }

  async stop() {
    // Deliberate stop: disarm the watchdog FIRST so the kill below isn't mistaken
    // for a crash and respawned.
    this._stopping = true;
    this._watchdogArmed = false;
    if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null; }
    if (this.external) return;
    if (this.proc) {
      const pid = this.proc.pid;
      try {
        if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
        else this.proc.kill('SIGTERM');
      } catch (e) {}
      this.proc = null;
    }
  }
}

// Process-wide shared instance. TorrServer is a single long-lived service for the whole
// app (started once at boot, stopped on exit) — every StreamManager and the server share
// THIS one client so nobody spawns a second binary or kills the engine out from under
// another stream. The log can be (re)set by the first real owner (e.g. the web server).
let sharedClient = null;
function getSharedClient(opts = {}) {
  if (!sharedClient) sharedClient = new TorrServerClient(opts);
  else {
    if (typeof opts.log === 'function') sharedClient.log = opts.log;
    if (typeof opts.onEvent === 'function') sharedClient.onEvent = opts.onEvent;
  }
  return sharedClient;
}

module.exports = { TorrServerClient, getSharedClient, resolveBinary, platformBinaryName, enrichMagnet, DEFAULT_TRACKERS };
// exposed for unit tests
module.exports._internals = { respawnDelayMs, RESPAWN_MAX_MS, STABLE_UPTIME_MS };
