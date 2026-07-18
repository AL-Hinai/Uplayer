'use strict';

// Verifies the DLNA SetAVTransportURI payload helpers: the DIDL-Lite metadata is
// well-formed and properly XML-escaped (TorrServer URLs contain '&', which must survive
// the double-escape into CurrentURIMetaData), the subtitle MIME/caption type matches the
// actual file, and a UPnP SOAP fault is decoded into a human-readable reason.

const assert = require('assert');
const { _internals: I } = require('../core/dlna-caster');

// A real TorrServer media URL: has spaces (%20) and multiple '&' query params.
const MEDIA = 'http://192.168.100.2:8090/stream/Big%20Buck%20Bunny.mp4?link=dd8255ec&index=2&play';

function testDidlEscapesAmpersands() {
  const didl = I.buildDidl(MEDIA, 'Big & Bunny', '');
  // The raw '&' must NOT appear unescaped anywhere (would break the TV's XML parser).
  // Every '&' should be part of an entity (&amp; / &lt; / …).
  const stray = didl.replace(/&(amp|lt|gt|quot|apos);/g, '').indexOf('&');
  assert.strictEqual(stray, -1, 'DIDL must not contain an unescaped & — found one');
  // The media URL is present (escaped) inside a <res> element.
  assert.match(didl, /<res protocolInfo="http-get:\*:video\/mp4:[^"]*">/);
  assert.ok(didl.includes('link=dd8255ec&amp;index=2&amp;play'), 'URL query & must be &amp; in the res');
  assert.ok(didl.includes('<dc:title>Big &amp; Bunny</dc:title>'), 'title & must be escaped');
}

function testSubtitleMimeMatchesFile() {
  const vtt = I.buildDidl(MEDIA, 'x', 'http://h/s/subtitle_0.vtt');
  assert.ok(vtt.includes('http-get:*:text/vtt:*'), 'vtt sidecar must be declared text/vtt, not text/srt');
  assert.ok(vtt.includes('sec:type="vtt"'), 'caption type must be vtt');

  const srt = I.buildDidl(MEDIA, 'x', 'http://h/s/sub.srt');
  assert.ok(srt.includes('http-get:*:text/srt:*'), 'srt sidecar declared text/srt');
  assert.ok(srt.includes('sec:type="srt"'));

  const none = I.buildDidl(MEDIA, 'x', '');
  assert.ok(!/sec:CaptionInfoEx/.test(none), 'no caption element when there is no subtitle');
}

function testFaultTextDecodesUpnpError() {
  const body = '<s:Envelope><s:Body><s:Fault><detail>'
    + '<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">'
    + '<errorCode>701</errorCode><errorDescription>Transition not available</errorDescription>'
    + '</UPnPError></detail></s:Fault></s:Body></s:Envelope>';
  const msg = I.faultText({ status: 500, body });
  assert.ok(msg.includes('701'), 'must surface the UPnP error code');
  assert.ok(msg.includes('Transition not available'), 'must surface the description');

  // No SOAP detail → fall back to the HTTP status.
  assert.strictEqual(I.faultText({ status: 500, body: 'oops' }), 'HTTP 500');
  assert.strictEqual(I.faultText(null), 'no response from TV');
}

function testFaultedPredicate() {
  assert.strictEqual(I.faulted(null), true);
  assert.strictEqual(I.faulted({ status: 500 }), true);
  assert.strictEqual(I.faulted({ status: 200 }), false);
  // A timeout / network error is reported as status 0 by soapSafe — must count as faulted
  // so it flows through the verify-state path instead of being treated as success.
  assert.strictEqual(I.faulted({ status: 0 }), true);
}

function main() {
  testDidlEscapesAmpersands();
  testSubtitleMimeMatchesFile();
  testFaultTextDecodesUpnpError();
  testFaultedPredicate();
  console.log('dlna-cast-payload.test.js passed');
}

main();
