'use strict';
/*
 * Minimal DLNA / UPnP MediaRenderer control point — lets Uplayer PUSH a stream to a
 * smart TV (Samsung / LG / Sony / etc.) the way the cast button does for Chromecast,
 * but sending TorrServer's native :8090 stream URL so the TV plays the ORIGINAL file
 * at full quality with no transcoding.
 *
 * Pure Node (dgram + http), zero dependencies:
 *   discover()                       SSDP M-SEARCH for MediaRenderer devices
 *   play(id, url, {title, sub})      SetAVTransportURI + Play (AVTransport SOAP)
 *   stop/pause/resume/status(id)     transport controls
 *
 * Discovery is server-side (the app server is on the LAN); the browser only ever
 * passes back a device id, never a control URL, so a page can't make us POST to an
 * arbitrary host.
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { URL } = require('url');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1';

const cache = new Map(); // id -> { id, name, model, address, controlUrl, location, ts }

const xmlEscape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const pick = (re, s) => { const m = String(s || '').match(re); return m ? m[1].trim() : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpRequest(opts, payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.setTimeout(timeout);
    if (payload) req.write(payload);
    req.end();
  });
}

// Fetch a renderer's device-description XML and pull out its AVTransport control URL.
async function describe(location) {
  let u; try { u = new URL(location); } catch (e) { return null; }
  const { body } = await httpRequest({ host: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''), method: 'GET' }, null, 6000);
  // Keep only devices that expose an AVTransport service (i.e. can play media).
  if (!body || !/AVTransport/i.test(body)) return null;
  const name = pick(/<friendlyName>([^<]*)<\/friendlyName>/i, body) || 'DLNA TV';
  const model = pick(/<modelName>([^<]*)<\/modelName>/i, body) || '';
  const udn = pick(/<UDN>([^<]*)<\/UDN>/i, body) || location;
  const urlBase = pick(/<URLBase>([^<]*)<\/URLBase>/i, body);
  // Find the <service> block whose serviceType is AVTransport, then its <controlURL>.
  // (Regex over each block — more robust than splitting; tolerates whitespace/namespaces.)
  let controlPath = '';
  const svcRe = /<service\b[^>]*>([\s\S]*?)<\/service>/gi;
  let sm;
  while ((sm = svcRe.exec(body))) {
    if (/AVTransport/i.test(sm[1])) { controlPath = pick(/<controlURL>\s*([^<]*?)\s*<\/controlURL>/i, sm[1]); if (controlPath) break; }
  }
  if (!controlPath) return null;
  let controlUrl; try { controlUrl = new URL(controlPath, urlBase || location).toString(); } catch (e) { return null; }
  return { id: udn.replace(/^uuid:/i, ''), name, model, address: u.host, controlUrl, location, ts: Date.now() };
}

function publicList() {
  return Array.from(cache.values()).map((d) => ({ id: d.id, name: d.name, model: d.model, address: d.address }));
}

let lastRaw = []; // raw SSDP responders from the most recent scan (for the ?debug=1 view)

function localIPv4Addresses() {
  const addrs = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const e of list || []) {
      if (!e || e.internal) continue;
      const fam = typeof e.family === 'string' ? e.family : String(e.family);
      if (fam === 'IPv4' || fam === '4') addrs.push(e.address);
    }
  }
  return addrs;
}

function msearch(st) {
  // Devices accept the multicast HOST header even on a unicast probe (verified on LG).
  return Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + st + '\r\n\r\n');
}

// SSDP discovery. Sent from EVERY local interface, two ways:
//   1) Multicast to 239.255.255.250 — fast when the network forwards it.
//   2) UNICAST sweep of the local /24 — the robust path. Many Wi-Fi routers DON'T
//      forward multicast to wireless clients (an LG webOS TV, for instance, never
//      sees the multicast M-SEARCH), and a unicast probe routes normally + the OS
//      firewall allows the reply because we initiated to that exact host.
// Several search targets are used (TVs answer `ssdp:all` more reliably than a narrow
// MediaRenderer ST). Every LOCATION we hear back is fetched and kept only if it
// exposes an AVTransport service.
function discover({ timeout = 5000, debug = false } = {}) {
  return new Promise((resolve) => {
    const seenLoc = new Set();
    const pending = [];
    const raw = [];
    const targets = ['ssdp:all', RENDERER, AVT];
    const addrs = localIPv4Addresses();
    if (!addrs.length) addrs.push('0.0.0.0');

    const sockets = [];
    let settled = false;
    const finish = () => {
      if (settled) return; settled = true;
      lastRaw = raw;
      for (const s of sockets) { try { s.close(); } catch (e) {} }
      Promise.all(pending).then(() => resolve(publicList())).catch(() => resolve(publicList()));
    };

    for (const addr of addrs) {
      let sock;
      try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { continue; }
      sock.on('error', () => { try { sock.close(); } catch (e) {} });
      sock.on('message', (buf, rinfo) => {
        const text = buf.toString();
        const loc = pick(/LOCATION:\s*(\S+)/i, text);
        if (debug) raw.push({ from: rinfo.address, iface: addr, st: pick(/\bST:\s*(\S+)/i, text), location: loc });
        if (!loc || seenLoc.has(loc)) return;
        seenLoc.add(loc);
        pending.push(describe(loc).then((d) => { if (d) cache.set(d.id, d); }).catch(() => {}));
      });
      try {
        sock.bind(0, addr === '0.0.0.0' ? undefined : addr, () => {
          try { sock.setBroadcast(true); } catch (e) {}
          try { sock.setMulticastTTL(4); } catch (e) {}
          if (addr !== '0.0.0.0') { try { sock.setMulticastInterface(addr); } catch (e) {} }
          // 1) Multicast
          for (const st of targets) {
            const m = msearch(st);
            const fire = () => { try { sock.send(m, 0, m.length, SSDP_PORT, SSDP_ADDR); } catch (e) {} };
            fire(); setTimeout(fire, 700);
          }
          // 2) Unicast sweep of this interface's /24
          if (addr !== '0.0.0.0' && /^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
            const prefix = addr.replace(/\.\d+$/, '.');
            const um = msearch('ssdp:all');
            let i = 1;
            const sweep = setInterval(() => {
              if (settled || i > 254) { clearInterval(sweep); return; }
              const host = prefix + i; i += 1;
              if (host !== addr) { try { sock.send(um, 0, um.length, SSDP_PORT, host); } catch (e) {} }
            }, 5);
          }
        });
        sockets.push(sock);
      } catch (e) { try { sock.close(); } catch (_) {} }
    }

    setTimeout(finish, timeout);
  });
}

function getLastRaw() { return lastRaw; }

function soap(controlUrl, action, inner, timeout = 8000) {
  const u = new URL(controlUrl);
  const payload = '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + '<s:Body><u:' + action + ' xmlns:u="' + AVT + '">' + inner + '</u:' + action + '></s:Body></s:Envelope>';
  return httpRequest({
    host: u.hostname, port: u.port || 80, path: u.pathname + (u.search || ''), method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: '"' + AVT + '#' + action + '"',
      'Content-Length': Buffer.byteLength(payload),
      Connection: 'close',
    },
  }, payload, timeout);
}

function mimeFor(url) {
  const p = String(url || '').toLowerCase();
  if (/\.mkv(\?|$)/.test(p)) return 'video/x-matroska';
  if (/\.(mp4|m4v)(\?|$)/.test(p)) return 'video/mp4';
  if (/\.webm(\?|$)/.test(p)) return 'video/webm';
  if (/\.avi(\?|$)/.test(p)) return 'video/avi';
  if (/\.(ts|m2ts|mpe?g)(\?|$)/.test(p)) return 'video/mpeg';
  return 'video/mp4';
}

// Subtitle MIME + LG caption type, matched to the actual file so the TV doesn't reject a
// .vtt sidecar that we mislabelled as srt.
function subInfo(url) {
  const p = String(url || '').toLowerCase();
  if (/\.vtt(\?|$)/.test(p)) return { mime: 'text/vtt', type: 'vtt' };
  if (/\.smi(\?|$)/.test(p)) return { mime: 'application/smil', type: 'smi' };
  return { mime: 'text/srt', type: 'srt' };
}

// DIDL-Lite metadata for the item. It rides INSIDE the SOAP XML, so the whole thing is
// XML-escaped once more by the caller.
//
// ONE subtitle, not a list — and that is a measured limit, not an assumption. DIDL-Lite
// permits repeated <res> elements, so a build carrying three sidecars (plus a
// sec:CaptionInfoEx each) was sent to an LG webOS QNED816RA: it accepted the payload,
// played fine, and fetched ONLY THE FIRST subtitle URL. The others were never requested.
// There is no track list in AVTransport to switch between anyway. So the choice of which
// subtitle to send has to be made before casting — which is why the DLNA card has a
// picker and the Chromecast path (which takes a real track array) does not.
function buildDidl(mediaUrl, title, subtitleUrl) {
  const mime = mimeFor(mediaUrl);
  const si = subInfo(subtitleUrl);
  const subRes = subtitleUrl ? '<res protocolInfo="http-get:*:' + si.mime + ':*">' + xmlEscape(subtitleUrl) + '</res>' : '';
  const cap = subtitleUrl ? '<sec:CaptionInfoEx sec:type="' + si.type + '">' + xmlEscape(subtitleUrl) + '</sec:CaptionInfoEx>' : '';
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    + 'xmlns:sec="http://www.sec.co.kr/dlna">'
    + '<item id="0" parentID="-1" restricted="1">'
    + '<dc:title>' + xmlEscape(title || 'Uplayer') + '</dc:title>'
    + '<upnp:class>object.item.videoItem</upnp:class>'
    + '<res protocolInfo="http-get:*:' + mime + ':DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000">' + xmlEscape(mediaUrl) + '</res>'
    + subRes + cap
    + '</item></DIDL-Lite>';
}

// A SOAP call "faulted" if there's no clean 2xx response. That covers a UPnP fault (HTTP
// 500 + SOAP <Fault>) AND a timeout / network error, which soapSafe reports as status 0.
function faulted(r) { return !r || r.status < 200 || r.status >= 300; }

// soap() but a timeout / network error becomes a uniform { status: 0 } result instead of a
// rejection. Crucial: a rejection would blow straight past the fallback/verify logic and
// surface as "timeout" — even when the TV actually accepted the command (its HTTP reply
// was just slow or lost). With this, every outcome flows through the same handling.
async function soapSafe(controlUrl, action, inner, timeout) {
  try { return await soap(controlUrl, action, inner, timeout); }
  catch (e) { return { status: 0, err: e && e.message }; }
}

// Ask the TV what it's actually doing. A renderer that's loading or playing the URI we
// just sent means the cast SUCCEEDED, regardless of whether the SOAP reply came back.
async function isLoadingOrPlaying(dev) {
  const ti = await soap(dev.controlUrl, 'GetTransportInfo', '<InstanceID>0</InstanceID>', 4000).catch(() => null);
  const state = ti ? pick(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i, ti.body) : '';
  return /PLAYING|TRANSITIONING|PAUSED_PLAYBACK/i.test(state);
}

// Pull the real reason out of a UPnP SOAP fault so the error isn't just "HTTP 500".
// Body looks like: …<detail><UPnPError><errorCode>701</errorCode>
// <errorDescription>Transition not available</errorDescription></UPnPError></detail>…
function faultText(r) {
  if (!r) return 'no response from TV';
  const code = pick(/<errorCode>\s*(\d+)\s*<\/errorCode>/i, r.body);
  const desc = pick(/<errorDescription>\s*([^<]*?)\s*<\/errorDescription>/i, r.body);
  if (code) return `UPnP ${code}${desc ? ' "' + desc + '"' : ''} (HTTP ${r.status})`;
  return `HTTP ${r && r.status}`;
}

async function play(id, mediaUrl, { title = 'Uplayer', subtitleUrl = '' } = {}) {
  const dev = cache.get(id);
  if (!dev) throw new Error('device not found — rescan');
  const ok = (note) => ({ ok: true, device: dev.name, note });

  const setUri = (metaXml) => soapSafe(dev.controlUrl, 'SetAVTransportURI',
    '<InstanceID>0</InstanceID><CurrentURI>' + xmlEscape(mediaUrl) + '</CurrentURI>'
    + '<CurrentURIMetaData>' + metaXml + '</CurrentURIMetaData>', 10000);

  // Reset the renderer FIRST: a TV left mid-play or TRANSITIONING (e.g. a previous cast
  // whose source went away) rejects the new URI with UPnP 701 "Transition not available".
  // Stop returns it to STOPPED so the URI is accepted. Ignored if it fails.
  await soapSafe(dev.controlUrl, 'Stop', '<InstanceID>0</InstanceID>', 5000);
  await sleep(300);

  // Progressive metadata fallback — TVs vary in how strict their DIDL parser is:
  //   1. full metadata (title + subtitle caption);
  //   2. WITHOUT the subtitle/caption metadata (a mismatched caption type is a common
  //      reason a renderer rejects the whole request);
  //   3. bare URI, empty metadata (most renderers still play it).
  // After ANY non-OK reply we ask the TV what it's doing: a slow or lost HTTP response
  // does NOT mean the TV ignored us (the "connected to the TV but cast says timeout"
  // case) — if it's already loading/playing, the cast worked.
  const metas = [xmlEscape(buildDidl(mediaUrl, title, subtitleUrl))];
  if (subtitleUrl) metas.push(xmlEscape(buildDidl(mediaUrl, title, '')));
  metas.push('');

  let set = null;
  for (let i = 0; i < metas.length; i += 1) {
    set = await setUri(metas[i]);
    if (!faulted(set)) break;                                 // clean OK
    if (await isLoadingOrPlaying(dev)) return ok('verified by transport state');
    if (set.status === 0) break;                              // timeout/unreachable — simpler metadata won't help
    await sleep(400);                                         // HTTP fault → try the next, simpler metadata
  }
  if (faulted(set)) {
    if (await isLoadingOrPlaying(dev)) return ok('verified by transport state');
    throw new Error('SetAVTransportURI rejected — ' + faultText(set));
  }

  // Many renderers auto-play on SetAVTransportURI, or are slow to ACK Play while they
  // buffer — a Play timeout with the TV already playing is still a success.
  const pl = await soapSafe(dev.controlUrl, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>', 8000);
  if (faulted(pl) && !(await isLoadingOrPlaying(dev))) throw new Error('Play rejected — ' + faultText(pl));
  return ok();
}

async function action(id, name, inner) {
  const dev = cache.get(id);
  if (!dev) throw new Error('device not found — rescan');
  const r = await soap(dev.controlUrl, name, inner).catch((e) => ({ status: 0, err: e.message }));
  return { ok: !!r && r.status < 400, status: r && r.status, body: r && r.body };
}

const stop = (id) => action(id, 'Stop', '<InstanceID>0</InstanceID>');
const pause = (id) => action(id, 'Pause', '<InstanceID>0</InstanceID>');
const resume = (id) => action(id, 'Play', '<InstanceID>0</InstanceID><Speed>1</Speed>');
const seek = (id, target) => action(id, 'Seek', '<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>' + xmlEscape(target) + '</Target>');

// What the renderer says it can do RIGHT NOW — "Play,Stop,Pause,Seek,X_DLNA_SeekTime".
//
// Asked before offering to re-send a corrected subtitle: that re-send restarts the title,
// and only a Seek puts the viewer back where they were. A TV without Seek would strand
// them at 00:00, which they deserve to know BEFORE choosing it rather than after.
//
// GetCurrentTransportActions is OPTIONAL in the AVTransport spec, so a fault means
// "unknown", not "no" — hence ok:false rather than canSeek:false. Never warn on unknown;
// a false alarm would talk people out of something that works.
async function transportActions(id) {
  const dev = cache.get(id);
  if (!dev) return { ok: false, actions: [], canSeek: false };
  const r = await soapSafe(dev.controlUrl, 'GetCurrentTransportActions', '<InstanceID>0</InstanceID>', 5000);
  if (faulted(r)) return { ok: false, actions: [], canSeek: false };
  const raw = pick(/<Actions>([^<]*)<\/Actions>/i, r.body);
  const actions = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { ok: true, actions, canSeek: actions.some((a) => /seek/i.test(a)) };
}

async function status(id) {
  const dev = cache.get(id);
  if (!dev) return { ok: false };
  const [ti, pi] = await Promise.all([
    soap(dev.controlUrl, 'GetTransportInfo', '<InstanceID>0</InstanceID>').catch(() => null),
    soap(dev.controlUrl, 'GetPositionInfo', '<InstanceID>0</InstanceID>').catch(() => null),
  ]);
  return {
    ok: !!ti,
    device: dev.name,
    state: ti ? pick(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i, ti.body) : '',
    relTime: pi ? pick(/<RelTime>([^<]*)<\/RelTime>/i, pi.body) : '',
    duration: pi ? pick(/<TrackDuration>([^<]*)<\/TrackDuration>/i, pi.body) : '',
  };
}

module.exports = {
  discover, publicList, getLastRaw, getDevice: (id) => cache.get(id) || null,
  play, stop, pause, resume, seek, status, transportActions,
  // exposed for unit tests
  _internals: { buildDidl, subInfo, faultText, faulted, xmlEscape, isLoadingOrPlaying, cacheDevice: (d) => cache.set(d.id, d) },
};
