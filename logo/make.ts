// Makes Erga's logo: "erga" set in Special Elite (logo/SpecialElite-Regular.ttf,
// Google Fonts, Apache 2.0, a worn typewriter face), its letters turned into
// outlines, so the SVG needs no font and looks the same anywhere (a README,
// Slack, a favicon tool). Run it after changing anything here:
//
//   bun logo/make.ts
//
// It writes:
//   logo/erga.svg        the wordmark, fill="currentColor" (takes the text colour)
//   logo/erga-ink.svg    the wordmark in dark ink, for light backgrounds
//   logo/erga-light.svg  the wordmark in light ink, for dark backgrounds
//   logo/favicon.svg     a typed "e" in dark ink on a white rounded square
//   logo/logo.ts         the wordmark sized for the header and the favicon as a
//                        data: URL, for the pages (front.ts, page.html, landing/)
// and puts the wordmark and the favicon into page.html and landing/index.html,
// which can't import logo.ts. No dependencies: the script reads the TrueType
// tables it needs (cmap, hmtx, loca, glyf) itself.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORD = "erga";
/** The header's wordmark: its x-height, in CSS pixels (the letters sit on the breadcrumbs' baseline, the g below it). */
const HEADER_X_HEIGHT = 9.4;
const INK = "#1c1c1f", LIGHT = "#f4f4f5";
const here = import.meta.dir, root = join(here, "..");

const font = readFileSync(join(import.meta.dir, "SpecialElite-Regular.ttf"));
const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
const u16 = (o: number) => v.getUint16(o), i16 = (o: number) => v.getInt16(o), u32 = (o: number) => v.getUint32(o);

const tables: Record<string, number> = {};
for (let i = 0, n = u16(4); i < n; i++) tables[String.fromCharCode(...font.subarray(12 + i * 16, 16 + i * 16))] = u32(20 + i * 16);

const upm = u16(tables.head + 18);
const longLoca = i16(tables.head + 50) == 1;
const numHMetrics = u16(tables.hhea + 34);
const advance = (g: number) => u16(tables.hmtx + 4 * Math.min(g, numHMetrics - 1));

/** The glyph for a character: the cmap's Unicode subtable, format 4. */
function glyphOf(ch: string): number {
  const code = ch.codePointAt(0)!;
  for (let i = 0, n = u16(tables.cmap + 2); i < n; i++) {
    const rec = tables.cmap + 4 + i * 8, sub = tables.cmap + u32(rec + 4);
    if (u16(sub) != 4) continue;
    const segs = u16(sub + 6) / 2, ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
    for (let s = 0; s < segs; s++) {
      if (code > u16(ends + s * 2) || code < u16(starts + s * 2)) continue;
      const range = u16(ranges + s * 2);
      if (!range) return (code + i16(deltas + s * 2)) & 0xffff;
      const g = u16(ranges + s * 2 + range + (code - u16(starts + s * 2)) * 2);
      return g ? (g + i16(deltas + s * 2)) & 0xffff : 0;
    }
  }
  throw new Error(`Special Elite has no glyph for ${JSON.stringify(ch)}`);
}

type Pt = { x: number; y: number; on: boolean };

/** A glyph's contours, in font units (y up); a composite glyph's parts moved into place. */
function contours(g: number): Pt[][] {
  const at = (k: number) => (longLoca ? u32(tables.loca + k * 4) : u16(tables.loca + k * 2) * 2);
  const start = tables.glyf + at(g);
  if (at(g + 1) == at(g)) return [];
  const n = i16(start);
  if (n < 0) {
    const all: Pt[][] = [];
    let p = start + 10, flags: number;
    do {
      flags = u16(p);
      const part = u16(p + 2);
      p += 4;
      const dx = flags & 1 ? i16(p) : (v.getInt8(p) as number), dy = flags & 1 ? i16(p + 2) : (v.getInt8(p + 1) as number);
      p += flags & 1 ? 4 : 2;
      let a = 1, b = 0, c = 0, d = 1;
      const f2 = (o: number) => i16(o) / 16384;
      if (flags & 8) { a = d = f2(p); p += 2; }
      else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of contours(part)) all.push(contour.map((q) => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })));
    } while (flags & 0x20);
    return all;
  }
  const ends = Array.from({ length: n }, (_, i) => u16(start + 10 + i * 2));
  const count = n ? ends[n - 1] + 1 : 0;
  let p = start + 10 + n * 2;
  p += 2 + u16(p);
  const flags: number[] = [];
  while (flags.length < count) {
    const f = font[p++];
    flags.push(f);
    if (f & 8) for (let r = font[p++]; r > 0; r--) flags.push(f);
  }
  const coords = (short: number, same: number) => {
    let val = 0;
    return flags.map((f) => {
      if (f & short) { const d = font[p++]; val += f & same ? d : -d; }
      else if (!(f & same)) { val += i16(p); p += 2; }
      return val;
    });
  };
  const xs = coords(2, 16), ys = coords(4, 32);
  const pts = flags.map((f, i) => ({ x: xs[i], y: ys[i], on: (f & 1) == 1 }));
  return ends.map((end, i) => pts.slice(i ? ends[i - 1] + 1 : 0, end + 1));
}

/** Font units are small (2048 to the em): whole ones are finer than any screen shows the logo. */
const r = (x: number) => String(Math.round(x));

/** One contour as SVG path data: TrueType's quadratic curves, with the on-curve points they leave out put back. */
function pathOf(c: Pt[], dx: number): string {
  const P = (q: Pt) => `${r(q.x + dx)} ${r(-q.y)}`;
  const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  let first = c.findIndex((q) => q.on);
  const pts = first < 0 ? [mid(c[0], c[1]), ...c.slice(1), c[0]] : [...c.slice(first), ...c.slice(0, first)];
  let d = `M${P(pts[0])}`;
  for (let i = 1; i <= pts.length; i++) {
    const q = pts[i % pts.length];
    if (q.on) { d += `L${P(q)}`; continue; }
    let next = pts[(i + 1) % pts.length];
    if (!next.on) next = mid(q, next);
    else i++;
    d += `Q${P(q)} ${P(next)}`;
  }
  return d + "Z";
}

/** Text set in the font: its outlines as one path's data, and the box around its ink (font units, y down, the baseline at 0). */
function set(text: string) {
  let pen = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const parts: string[] = [];
  for (const ch of text) {
    const g = glyphOf(ch);
    for (const c of contours(g)) {
      if (!c.length) continue;
      for (const q of c) {
        minX = Math.min(minX, q.x + pen); maxX = Math.max(maxX, q.x + pen);
        minY = Math.min(minY, -q.y); maxY = Math.max(maxY, -q.y);
      }
      parts.push(pathOf(c, pen));
    }
    pen += advance(g);
  }
  // A little room around the ink, so a soft edge isn't cut by the box.
  const pad = Math.round(upm * 0.02);
  return { d: parts.join(""), x: Math.floor(minX) - pad, y: Math.floor(minY) - pad, w: Math.ceil(maxX - minX) + 2 * pad, h: Math.ceil(maxY - minY) + 2 * pad };
}

const word = set(WORD);
const viewBox = `${word.x} ${word.y} ${word.w} ${word.h}`;
const wordmark = (fill: string, attrs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${attrs} role="img" aria-label="Erga"><title>Erga</title><path fill="${fill}" d="${word.d}"/></svg>`;
for (const [file, fill] of [["erga.svg", "currentColor"], ["erga-ink.svg", INK], ["erga-light.svg", LIGHT]]) writeFileSync(join(here, file), wordmark(fill) + "\n");

// The favicon: the "e", centred on a white square with round corners, so it shows on a light tab bar and a dark one.
const e = set("e");
const side = Math.round(Math.max(e.w, e.h) * 1.3), radius = Math.round(side * 0.18);
const ex = Math.round(e.x - (side - e.w) / 2), ey = Math.round(e.y - (side - e.h) / 2);
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ex} ${ey} ${side} ${side}"><rect x="${ex}" y="${ey}" width="${side}" height="${side}" rx="${radius}" fill="#fff"/><path fill="${INK}" d="${e.d}"/></svg>`;
writeFileSync(join(here, "favicon.svg"), favicon + "\n");
const faviconUrl = `data:image/svg+xml,${encodeURIComponent(favicon)}`;

// In the header: px per font unit from the x-height, and the g's descent below the baseline (vertical-align) as the box's foot.
const xHeight = -set("x").y - Math.round(upm * 0.02);
const k = HEADER_X_HEIGHT / xHeight;
const px = (n: number) => String(Math.round(n * k * 10) / 10);
const header = wordmark("currentColor", ` class="wordmark" width="${px(word.w)}" height="${px(word.h)}" style="vertical-align:-${px(word.y + word.h)}px"`);

writeFileSync(join(here, "logo.ts"), `// Made by logo/make.ts: don't edit it, run \`bun logo/make.ts\`.

/** Erga's wordmark ("erga" in Special Elite, as outlines), sized for the breadcrumbs: the text colour, on the baseline. */
export const WORDMARK = ${JSON.stringify(header)};

/** The favicon (logo/favicon.svg) as a data: URL, so a page needs no request for it. */
export const FAVICON = ${JSON.stringify(faviconUrl)};

/** The <link> for it, for a page's head. */
export const FAVICON_LINK = \`<link rel="icon" type="image/svg+xml" href="\${FAVICON}">\`;
`);

/** Puts the logo into a page that can't import logo.ts: in place of what \`find\` matches there (the last one made). */
function put(file: string, find: RegExp, html: string) {
  const path = join(root, file), text = readFileSync(path, "utf8");
  if (!find.test(text)) throw new Error(`${file} has nothing for the logo to replace (${find})`);
  writeFileSync(path, text.replace(find, () => html));
}
const made = /<svg [^>]*class="wordmark"[\s\S]*?<\/svg>/;
put("page.html", /<link rel="icon"[^>]*>/, `<link rel="icon" type="image/svg+xml" href="${faviconUrl}">`);
put("page.html", made, header);
put("landing/index.html", made, wordmark("currentColor", ` class="wordmark"`));

console.log(`erga: viewBox ${viewBox}, ${word.d.length} bytes of path; header ${px(word.w)}×${px(word.h)} px; favicon ${favicon.length} bytes`);
