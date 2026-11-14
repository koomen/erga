// A PNG's first bytes for a picture of a size (its header, with no pixels), as base64: what the picture rule reads
// (shared/picture.ts).
import { base64 } from "../../shared/bytes";

export function pngOf(width: number, height: number, bytes = 33): string {
  const b = new Uint8Array(bytes);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return base64(b);
}
