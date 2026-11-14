// The one rule for a picture that goes to a model: in a person's message, in a tool's answer (view_page, read), in an
// old message of a long conversation; to Erga's own agent and to an outside one. Decisions only, no IO: the server's
// browser cuts and takes the pictures (cloudflare/render.ts), the panel scales an attached one (client/agent/attach-ui.ts),
// and the agent loop holds each request to it (agents/models.ts, fitPictures).
//
// The model's limits (Anthropic's Vision guide, read 2026-11-13):
// - A picture has at most 8000 px a side. In a request with more than 20 pictures it has at most 3000 px a side, and
//   every picture of the conversation counts, the old ones and a tool's too. A conversation grows, so a picture that
//   was fine with few may be refused later: 3000 px is the limit for every picture, always (`side`).
// - A picture is at most 10 MB of base64 (`data`); a request has at most 600 pictures, and 128 MB in all.
// - The model reads a picture whole up to 2576 px on its long side and 4784 patches of 28 px (`edge`, `patches`). It
//   scales a larger one down itself, and small text is lost: so a tall capture goes in parts, each one read whole.

import { fromBase64 } from "./bytes";

export const PICTURE = { side: 3000, data: 10 * 1024 * 1024, edge: 2576, patches: 4784, patch: 28 } as const;

/**
 * The pictures of one request together, in base64 characters and in number: over `high`, the oldest leave until `low`
 * is left (fitPictures), so they leave seldom, many at once. Far under the model's 128 MB and 600: the server holds
 * the conversation in memory, and writes it whole for each request.
 */
export const PICTURES = { high: { data: 48 * 1024 * 1024, count: 200 }, low: { data: 24 * 1024 * 1024, count: 100 } } as const;

export interface Size {
  width: number;
  height: number;
}

/** The size of a PNG, JPEG, GIF or WebP, from its header; null when the bytes don't say (another format, or cut short). */
export function pictureSize(b: Uint8Array): Size | null {
  const be = (i: number) => (b[i] << 8) | b[i + 1],
    le = (i: number) => b[i] | (b[i + 1] << 8),
    tag = (i: number, s: string) => [...s].every((c, k) => b[i + k] == c.charCodeAt(0));
  if (b.length < 30) return null;
  if (b[0] == 0x89 && tag(1, "PNG")) return { width: be(16) * 65536 + be(18), height: be(20) * 65536 + be(22) };
  if (tag(0, "GIF8")) return { width: le(6), height: le(8) };
  if (tag(0, "RIFF") && tag(8, "WEBP")) {
    if (tag(12, "VP8 ")) return { width: le(26) & 0x3fff, height: le(28) & 0x3fff };
    if (tag(12, "VP8L")) return { width: 1 + (le(21) & 0x3fff), height: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | (b[22] >> 6)) };
    if (tag(12, "VP8X")) return { width: 1 + le(24) + (b[26] << 16), height: 1 + le(27) + (b[29] << 16) };
    return null;
  }
  if (b[0] != 0xff || b[1] != 0xd8) return null;
  // A JPEG: its segments, up to the frame's header (SOF0 to SOF15, but DHT, JPG and DAC).
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] != 0xff) return null;
    const m = b[i + 1];
    if (m == 0xff) i++;
    else if (m >= 0xc0 && m <= 0xcf && m != 0xc4 && m != 0xc8 && m != 0xcc) return { width: be(i + 7), height: be(i + 5) };
    else i += m == 0x01 || (m >= 0xd0 && m <= 0xd8) ? 2 : 2 + be(i + 2);
  }
  return null;
}

/** The size of a picture given as base64: from its first 64 KB, else (a JPEG with a long header) from all of it. */
export function base64PictureSize(data: string): Size | null {
  const head = 87_380;
  try {
    return pictureSize(fromBase64(data.slice(0, head))) ?? (data.length > head ? pictureSize(fromBase64(data)) : null);
  } catch {
    return null;
  }
}

/** Why the model can't take this picture, in words that end a sentence ("4000×1200 px: ..."); null when it can. */
export function tooLarge(size: Size | null, base64Length: number): string | null {
  if (size && Math.max(size.width, size.height) > PICTURE.side)
    return `${size.width}×${size.height} px: more than the ${PICTURE.side} px a side that the model takes`;
  if (base64Length > PICTURE.data)
    return `${(base64Length / 1024 / 1024).toFixed(1)} MB as base64: more than the 10 MB that the model takes`;
  return null;
}

/**
 * The parts a capture of `width` × `height` px goes in, from its top: each part's height. One part when the model
 * reads the capture whole; else equal parts, each as tall as the model reads whole at this width. (A capture is at
 * most 2400 px wide: no part is over `side`.)
 */
export function pictureParts(width: number, height: number): number[] {
  const rows = Math.floor(PICTURE.patches / Math.ceil(width / PICTURE.patch)) * PICTURE.patch;
  const count = Math.ceil(height / Math.min(PICTURE.edge, Math.max(PICTURE.patch, rows)));
  const each = Math.ceil(height / count);
  return Array.from({ length: count }, (_, i) => Math.min(each, height - i * each));
}
