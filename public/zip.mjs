/* ---------------------------------------------------------------------------
   A minimal zip writer, so a playlist can leave the board as a folder of WAVs.

   Stored (method 0) only, and deliberately: 16-bit PCM barely deflates, and a
   compressor is a lot of code to save a few percent on a file the browser is
   about to hand straight to the user. Everything here is what every unzipper
   has read since 1989 -- local header, central directory, end-of-central-
   directory -- with no zip64, so the ceiling is 4 GB and 65535 entries. A
   playlist of ten-second mono cues reaches neither.

   test/verify.mjs parses the bytes this produces back apart, checks the CRCs
   and compares the extracted entries against what went in, because a download
   nobody in this repo can open is exactly the sort of thing that would ship
   broken and stay broken.
   ------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3), the checksum every zip entry carries. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* The DOS timestamp every entry carries. Fixed at the epoch of the format
   itself, so zipping the same cues twice produces the same bytes -- the same
   reason export/cues.js has no timestamp in its header. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;        // 1980-01-01, the earliest DOS can say

/**
 * Build a zip archive.
 * @param {{name: string, data: ArrayBuffer|Uint8Array|string}[]} files
 * @returns {Uint8Array}
 */
export function zip(files) {
  const entries = files.map((f) => {
    const name = utf8(f.name);
    const data = f.data instanceof Uint8Array ? f.data
      : typeof f.data === 'string' ? utf8(f.data)
        : new Uint8Array(f.data);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  const LOCAL = 30, CENTRAL = 46, EOCD = 22;
  let size = EOCD;
  for (const e of entries) size += LOCAL + e.name.length + e.data.length + CENTRAL + e.name.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v >>> 0, true); at += 4; };
  const raw = (b) => { out.set(b, at); at += b.length; };

  for (const e of entries) {
    e.offset = at;
    u32(0x04034b50);          // local file header
    u16(20);                  // version needed: 2.0
    u16(1 << 11);             // flags: names are UTF-8
    u16(0);                   // method: stored
    u16(DOS_TIME); u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);       // compressed == uncompressed, stored
    u32(e.data.length);
    u16(e.name.length);
    u16(0);                   // no extra field
    raw(e.name);
    raw(e.data);
  }

  const dirAt = at;
  for (const e of entries) {
    u32(0x02014b50);          // central directory header
    u16(20);                  // version made by
    u16(20);                  // version needed
    u16(1 << 11);
    u16(0);
    u16(DOS_TIME); u16(DOS_DATE);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); u16(0);           // extra, comment
    u16(0);                   // disk number
    u16(0);                   // internal attributes
    u32(0);                   // external attributes
    u32(e.offset);
    raw(e.name);
  }

  const dirSize = at - dirAt;   // read it before the EOCD moves `at` past it

  u32(0x06054b50);            // end of central directory
  u16(0); u16(0);             // this disk, disk with the directory
  u16(entries.length); u16(entries.length);
  u32(dirSize);
  u32(dirAt);
  u16(0);                     // no archive comment

  return out;
}

const utf8 = (s) => new TextEncoder().encode(s);
