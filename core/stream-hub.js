'use strict';

// The one HTTP server shared by every concurrent stream, plus the small process/server
// helpers that sit next to it. Each StreamManager registers its request handler here under a
// stream-id prefix instead of binding its own port, so N streams cost one listener. This is
// the only module-level singleton in the whole stream path — deliberately (see CLAUDE.md).
//
// IO: owns the shared HTTP server and its listen socket. hiddenChildProcessOptions/
// waitForServerReady/probeExistingWebServer are stateless helpers kept here because they are
// about the same server lifecycle.

const http = require('http');
const path = require('path');

// ---------------------------------------------------------------------------
// Shared stream hub
// ---------------------------------------------------------------------------
// ONE HTTP server is shared by every concurrent stream. Each stream registers
// under a unique id and is addressed by a path prefix rather than its own port:
//
//   http://<host>:<PORT>/<streamId>/            -> player page
//   http://<host>:<PORT>/<streamId>/video.mkv   -> video bytes
//   http://<host>:<PORT>/<streamId>/hls/...      -> HLS playlist + segments
//   http://<host>:<PORT>/<streamId>/subtitle_0.vtt, /api/subtitles, /player.js…
//
// The first stream to start binds the port (default 8000, OS-assigned fallback
// if it is busy); every later stream reuses the SAME server. The server shuts
// down only when the last stream unregisters. So no matter how many streams run
// at once, exactly ONE port is ever opened — clients tell streams apart by the
// id in the URL, never by the port.
const streamHub = (() => {
  const handlers = new Map(); // streamId -> (req, res) => void
  let server = null;
  let listenPort = null;
  let startPromise = null;

  // Route a request to the right stream by its leading path segment, then rewrite
  // req.url so the per-stream handler sees root-relative paths exactly as before.
  function dispatch(req, res) {
    const raw = req.url || '/';
    const qIdx = raw.indexOf('?');
    const query = qIdx === -1 ? '' : raw.slice(qIdx);
    const pathOnly = qIdx === -1 ? raw : raw.slice(0, qIdx);
    const segs = pathOnly.replace(/^\/+/, '').split('/');
    const streamId = segs.shift() || '';
    const handler = handlers.get(streamId);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end('Unknown or ended stream');
      return;
    }
    req.url = ('/' + segs.join('/')) + query;
    try { handler(req, res); }
    catch (e) { try { res.writeHead(500); res.end(''); } catch (_) {} }
  }

  function ensureListening(preferredPort, bindHost) {
    if (server && listenPort != null) return Promise.resolve(listenPort);
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      server = http.createServer(dispatch);
      const onListening = () => { listenPort = server.address().port; resolve(listenPort); };
      server.once('error', (err) => {
        if (err && err.code === 'EADDRINUSE') {
          try { server.listen(0, bindHost, onListening); } catch (e) { reject(e); }
        } else { reject(err); }
      });
      server.listen(preferredPort, bindHost, onListening);
    });
    return startPromise;
  }

  return {
    async register(streamId, handler, preferredPort, bindHost) {
      const port = await ensureListening(preferredPort, bindHost);
      handlers.set(streamId, handler);
      return { port };
    },
    unregister(streamId) {
      if (!streamId) return;
      handlers.delete(streamId);
      if (handlers.size === 0 && server) {
        try { server.close(); } catch (e) {}
        server = null; listenPort = null; startPromise = null;
      }
    },
    get port() { return listenPort; },
    size() { return handlers.size; },
  };
})();

function hiddenChildProcessOptions(options = {}) {
  return {
    shell: false,
    ...options,
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
  };
}

function waitForServerReady(server) {
  if (server.listening) {
    return Promise.resolve(server);
  }
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function probeExistingWebServer(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/stream/status',
      timeout: 2000,
    }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

module.exports = {
  streamHub, hiddenChildProcessOptions, waitForServerReady, probeExistingWebServer,
};
