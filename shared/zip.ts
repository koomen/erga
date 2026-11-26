// A zip of files, each stored as it is (no compression), made on Unix with its mode. The same files give the same zip
// (the date is 1980-01-01, the first a zip can say): its hash names its version. For the agent plugins that each
// instance serves (server/pages/plugin.ts) and the AWS deployer's code (deploy/aws/deployer.ts).

/** A file of a zip: its path in the zip, its bytes, and its Unix mode (0o644: a plain file; 0o755: one that runs). */
export interface ZipFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 of `bytes`, as a zip holds it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A header's numbers, each of 2 or 4 bytes, little-endian. */
function record(fields: [size: 2 | 4, value: number][]): Uint8Array {
  const out = new DataView(new ArrayBuffer(fields.reduce((sum, [size]) => sum + size, 0)));
  let at = 0;
  for (const [size, value] of fields) {
    if (size == 2) out.setUint16(at, value, true);
    else out.setUint32(at, value, true);
    at += size;
  }
  return new Uint8Array(out.buffer);
}

/** `files` as one zip. */
export function zip(files: readonly ZipFile[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [],
    central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const path = new TextEncoder().encode(f.path);
    // Version 2.0, no flags, stored, at 00:00 on 1980-01-01, then the CRC, the two sizes and the name's length.
    const same: [2 | 4, number][] = [
      [2, 20],
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 33],
      [4, crc32(f.bytes)],
      [4, f.bytes.length],
      [4, f.bytes.length],
      [2, path.length],
      [2, 0],
    ];
    const local = record([[4, 0x04034b50], ...same]);
    // Made on Unix (3), so the mode in the external attributes counts: a regular file's.
    const mode = (0o100000 | (f.mode ?? 0o644)) << 16;
    central.push(record([[4, 0x02014b50], [2, (3 << 8) | 20], ...same, [2, 0], [2, 0], [2, 0], [4, mode >>> 0], [4, offset]]), path);
    parts.push(local, path, f.bytes);
    offset += local.length + path.length + f.bytes.length;
  }
  const size = central.reduce((n, p) => n + p.length, 0);
  const end = record([
    [4, 0x06054b50],
    [2, 0],
    [2, 0],
    [2, files.length],
    [2, files.length],
    [4, size],
    [4, offset],
    [2, 0],
  ]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
