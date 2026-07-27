'use strict';

/*
 * Why this module exists: a downloaded subtitle is a file a stranger uploaded, and its
 * bytes are not UTF-8 often enough to matter. YIFY's Arabic packs ship UTF-16LE with a
 * BOM; older Arabic/Cyrillic/Greek uploads ship a Windows codepage. Every reader in
 * Uplayer does readFileSync(path, 'utf8') — the /subtitle_N.vtt route, alass's input,
 * the trailer-detection cue-span check — so a UTF-16 file decodes to NUL-riddled
 * garbage, parses to ZERO cues, and the player shows a subtitle track that is simply
 * empty. VLC hid this, because VLC does its own charset detection; the web player and
 * the auto-sync did not.
 *
 * The download path is the only place that sees the raw bytes, so it is where the text
 * is made UTF-8, once, for every consumer downstream.
 *
 * Deliberately NOT a charset detector: no statistical language guessing, no n-gram
 * scoring. It reads BOMs, recognises BOM-less UTF-16 by its NUL pattern, and otherwise
 * decides between UTF-8 and a single-byte codepage by whether the bytes are VALID
 * UTF-8 — the only one of these questions with a reliable answer. The codepage for the
 * "not UTF-8" case comes from the language the user asked for, not from the bytes.
 *
 * Pure: no IO, no timers. Buffer in, string out.
 */

// Legacy codepage per subtitle language. Only consulted when the bytes are NOT valid
// UTF-8 — i.e. an upload old enough to predate the convention. Accepts ISO codes and
// the English names the keyless scrapers label rows with ("Arabic"), because both
// reach here depending on the provider.
const LANGUAGE_CODEPAGES = {
  ar: 'windows-1256', arabic: 'windows-1256',
  he: 'windows-1255', hebrew: 'windows-1255',
  ru: 'windows-1251', russian: 'windows-1251',
  bg: 'windows-1251', uk: 'windows-1251',
  el: 'windows-1253', greek: 'windows-1253',
  tr: 'windows-1254', turkish: 'windows-1254',
  th: 'windows-874', thai: 'windows-874',
  zh: 'gbk', chinese: 'gbk',
  ja: 'shift_jis', japanese: 'shift_jis',
  ko: 'euc-kr', korean: 'euc-kr',
  pl: 'windows-1250', cs: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250',
};

// Western European. The right guess for the languages that dominate subtitle sites, and
// a lossless byte-preserving fallback for anything else (it maps every byte to a code
// point, so no cue is ever destroyed — worst case some accents look wrong).
const DEFAULT_CODEPAGE = 'windows-1252';

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (e) {
    return false;
  }
}

// BOM-less UTF-16 is common in subtitle packs. Latin text encoded as UTF-16 is half
// NUL bytes, and their PARITY says which endianness: little-endian puts the NUL in the
// high byte (odd index), big-endian in the low byte (even index). A UTF-8 subtitle
// contains no NULs at all, so any meaningful count is already the answer.
function sniffBomlessUtf16(buf) {
  const window = Math.min(buf.length, 4096);
  if (window < 16) return null;
  let odd = 0;
  let even = 0;
  for (let i = 0; i < window; i += 1) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 0) even += 1; else odd += 1;
  }
  const total = odd + even;
  if (total < window * 0.2) return null;
  return odd > even * 4 ? 'utf-16le' : (even > odd * 4 ? 'utf-16be' : null);
}

// Returns { encoding, bomBytes } — the encoding name TextDecoder should use and how
// many leading bytes are a byte-order mark rather than content.
function detectEncoding(buf, language) {
  if (!buf || buf.length === 0) return { encoding: 'utf-8', bomBytes: 0 };

  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { encoding: 'utf-8', bomBytes: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return { encoding: 'utf-16le', bomBytes: 2 };
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return { encoding: 'utf-16be', bomBytes: 2 };
  }

  const sniffed = sniffBomlessUtf16(buf);
  if (sniffed) return { encoding: sniffed, bomBytes: 0 };

  if (isValidUtf8(buf)) return { encoding: 'utf-8', bomBytes: 0 };

  const key = String(language || '').trim().toLowerCase();
  return { encoding: LANGUAGE_CODEPAGES[key] || DEFAULT_CODEPAGE, bomBytes: 0 };
}

// Decode subtitle bytes to a UTF-8 JavaScript string.
//
// The `pkg`-built binaries and bun may carry a small-ICU build with no legacy codepages,
// so a missing decoder falls back to latin1 rather than throwing: latin1 maps every byte
// to a code point, which keeps the TIMESTAMPS — and therefore every cue — intact even
// when the text of a non-Latin language comes out wrong. An empty track is a bug; a
// mojibake track is still a usable subtitle the user can swap out.
function decodeSubtitle(buf, language) {
  const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (buffer.length === 0) return '';
  const { encoding, bomBytes } = detectEncoding(buffer, language);
  const body = bomBytes ? buffer.subarray(bomBytes) : buffer;

  if (encoding === 'utf-8') return body.toString('utf8');
  if (encoding === 'utf-16le') return body.toString('utf16le');
  if (encoding === 'utf-16be') {
    // Node has no utf16be reader — swap the pairs and reuse utf16le. `swap16` needs an
    // even length, so an odd trailing byte (truncated file) is dropped first.
    const even = body.length % 2 === 0 ? Buffer.from(body) : Buffer.from(body.subarray(0, body.length - 1));
    return even.swap16().toString('utf16le');
  }

  try {
    return new TextDecoder(encoding).decode(body);
  } catch (e) {
    return body.toString('latin1');
  }
}

module.exports = { detectEncoding, decodeSubtitle, LANGUAGE_CODEPAGES, DEFAULT_CODEPAGE };
