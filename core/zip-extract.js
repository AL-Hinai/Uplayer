'use strict';

// Minimal ZIP reader for subtitle archives.
//
// Why this exists: the keyless subtitle sources (YIFY and friends) serve their
// downloads as .zip files, and this app ships as a pkg-compiled binary with no
// build step — a hand-rolled ~60-line reader over Node's zlib beats adding a zip
// dependency to the runtime for the sake of one .srt inside one small archive.
//
// Deliberately excluded: zip64, encryption, multi-disk archives, streaming.
// Subtitle zips are tiny single-file archives; anything this can't read is
// treated by the caller as a failed download, which is the right degradation.

const zlib = require('zlib');

const EOCD_SIG = 0x06054b50; // end of central directory
const CDFH_SIG = 0x02014b50; // central directory file header

/** Every extractable file in the archive → [{ name, data:Buffer }]. */
function extractEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip archive');
  // EOCD sits at the end, pushed back by an optional comment (max 65535 bytes).
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== CDFH_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // The local header repeats name/extra with ITS OWN lengths (extra often differs).
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const cdata = buf.subarray(dataStart, dataStart + csize);
    let data = null;
    if (method === 0) data = cdata; // stored
    else if (method === 8) { try { data = zlib.inflateRawSync(cdata); } catch (e) { data = null; } }
    if (data != null && !name.endsWith('/')) entries.push({ name, data });

    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const SUBTITLE_FILE_RE = /\.(srt|ass|ssa|sub|vtt)$/i;

/** The first subtitle file in the archive, or null. Never throws. */
function extractFirstSubtitle(buf) {
  try {
    return extractEntries(buf).find((e) => SUBTITLE_FILE_RE.test(e.name)) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { extractEntries, extractFirstSubtitle };
