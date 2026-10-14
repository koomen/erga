// Just enough Git to host Erga's own repository: objects and their
// hashes, commits and trees, packfiles (read and write), and pkt-lines, the
// framing of Git's smart HTTP protocol. Platform-neutral (web APIs only), so
// it runs in the Worker, in a Durable Object and under `bun test` alike.
//
// Packs are read whole, in memory: Erga's repository is small (about 10MB of
// packed history), and the Worker only ever reads packs it asked for itself
// (never a client's thin pack). Inflate is written out here because the
// platform's DecompressionStream can't say where a zlib stream ends, which a
// pack needs to find its next object.

export type ObjectType = "commit" | "tree" | "blob" | "tag";
export interface GitObject { type: ObjectType; data: Uint8Array }

export const ZERO = "0".repeat(40);
const enc = new TextEncoder(), dec = new TextDecoder();
export const utf8 = (s: string) => enc.encode(s);
export const text = (b: Uint8Array) => dec.decode(b);

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const isSha = (s: unknown): s is string => typeof s == "string" && /^[0-9a-f]{40}$/.test(s);

export async function sha1(data: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", data as BufferSource)));
}

/** An object as Git stores it ("<type> <size>\0" and its data), and its id. */
export const objectBytes = (o: GitObject) => concat([utf8(`${o.type} ${o.data.length}\0`), o.data]);
export const hashObject = (o: GitObject) => sha1(objectBytes(o));

// ---- Commits and trees ------------------------------------------------------

export interface Person { name: string; email: string; /** Seconds since the epoch. */ time: number; tz: string }
export interface Commit { tree: string; parents: string[]; author: Person; committer: Person; message: string }

function person(line: string): Person {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  return m ? { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] } : { name: line, email: "", time: 0, tz: "+0000" };
}
const personLine = (p: Person) => `${p.name} <${p.email}> ${p.time} ${p.tz}`;

export function parseCommit(data: Uint8Array): Commit {
  const s = text(data);
  const split = s.indexOf("\n\n");
  const head = split < 0 ? s : s.slice(0, split), message = split < 0 ? "" : s.slice(split + 2);
  const c: Commit = { tree: "", parents: [], author: person(""), committer: person(""), message };
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue; // a continuation (gpgsig)
    const sp = line.indexOf(" "), key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key == "tree") c.tree = value;
    else if (key == "parent") c.parents.push(value);
    else if (key == "author") c.author = person(value);
    else if (key == "committer") c.committer = person(value);
  }
  return c;
}

export function commitBytes(c: Commit): Uint8Array {
  return utf8([`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${personLine(c.author)}`, `committer ${personLine(c.committer)}`, "", c.message].join("\n"));
}

/** A commit's subject: its message's first line. */
export const subjectOf = (message: string) => message.split("\n").find((l) => l.trim())?.trim() ?? "";

/** An annotated tag: what it points at (a commit, for a release), its name, who made it, its message. */
export interface Tag { object: string; type: ObjectType; tag: string; tagger: Person; message: string }

export function parseTag(data: Uint8Array): Tag {
  const s = text(data);
  const split = s.indexOf("\n\n");
  const head = split < 0 ? s : s.slice(0, split), message = split < 0 ? "" : s.slice(split + 2);
  const t: Tag = { object: "", type: "commit", tag: "", tagger: person(""), message };
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue;
    const sp = line.indexOf(" "), key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key == "object") t.object = value;
    else if (key == "type") t.type = value as ObjectType;
    else if (key == "tag") t.tag = value;
    else if (key == "tagger") t.tagger = person(value);
  }
  return t;
}

export function tagBytes(t: Tag): Uint8Array {
  return utf8([`object ${t.object}`, `type ${t.type}`, `tag ${t.tag}`, `tagger ${personLine(t.tagger)}`, "", t.message.endsWith("\n") ? t.message : `${t.message}\n`].join("\n"));
}

export interface TreeEntry { mode: string; name: string; sha: string }
export const isTreeMode = (mode: string) => mode == "40000" || mode == "040000";

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i), nul = data.indexOf(0, sp);
    entries.push({ mode: text(data.subarray(i, sp)), name: text(data.subarray(sp + 1, nul)), sha: hex(data.subarray(nul + 1, nul + 21)) });
    i = nul + 21;
  }
  return entries;
}

/** A tree's bytes, its entries in Git's order (a tree sorts as if its name ended in "/"). */
export function treeBytes(entries: TreeEntry[]): Uint8Array {
  const key = (e: TreeEntry) => utf8(isTreeMode(e.mode) ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] != y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  return concat(sorted.flatMap((e) => [utf8(`${isTreeMode(e.mode) ? "40000" : e.mode} ${e.name}\0`), unhex(e.sha)]));
}

// ---- pkt-lines ----------------------------------------------------------------

export const FLUSH = utf8("0000"), DELIM = utf8("0001");
export function pkt(line: string | Uint8Array): Uint8Array {
  const body = typeof line == "string" ? utf8(line) : line;
  return concat([utf8((body.length + 4).toString(16).padStart(4, "0")), body]);
}

/** A pkt-line: its payload, or a special packet (flush, delim, response end). */
export type Pkt = { kind: "data"; data: Uint8Array } | { kind: "flush" | "delim" | "end" };

/** Reads pkt-lines from `at` up to `limit` packets (or the end); returns where it stopped. */
export function readPkts(buf: Uint8Array, at = 0, until?: (p: Pkt) => boolean): { pkts: Pkt[]; end: number } {
  const pkts: Pkt[] = [];
  while (at + 4 <= buf.length) {
    const len = parseInt(text(buf.subarray(at, at + 4)), 16);
    if (Number.isNaN(len)) throw new Error("bad pkt-line");
    let p: Pkt;
    if (len < 4) { p = { kind: len == 0 ? "flush" : len == 1 ? "delim" : "end" }; at += 4; }
    else { if (at + len > buf.length) throw new Error("truncated pkt-line"); p = { kind: "data", data: buf.subarray(at + 4, at + len) }; at += len; }
    pkts.push(p);
    if (until?.(p)) break;
  }
  return { pkts, end: at };
}
export const pktText = (p: Pkt) => (p.kind == "data" ? text(p.data).replace(/\n$/, "") : null);

/** Splits side-band data (band 1 the payload, 2 progress, 3 an error) out of pkt-lines. */
export function sideBand(pkts: Pkt[]): { data: Uint8Array; progress: string[] } {
  const data: Uint8Array[] = [], progress: string[] = [];
  for (const p of pkts) {
    if (p.kind != "data") continue;
    const band = p.data[0], body = p.data.subarray(1);
    if (band == 1) data.push(body);
    else if (band == 2) progress.push(text(body));
    else if (band == 3) throw new Error(text(body).trim() || "the remote reported an error");
  }
  return { data: concat(data), progress };
}

/** Wraps `data` in side-band packets (band 1, or `band`), at most 65515 bytes each. */
export function toSideBand(data: Uint8Array, band = 1, max = 65515): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += max) out.push(pkt(concat([Uint8Array.of(band), data.subarray(i, i + max)])));
  return out;
}

// ---- Inflate (zlib), reporting where the stream ends -------------------------------

class Huffman { counts = new Uint16Array(16); symbols = new Uint16Array(320) }
const LEN_BITS = new Uint8Array(30), LEN_BASE = new Uint16Array(30), DIST_BITS = new Uint8Array(30), DIST_BASE = new Uint16Array(30);
(function tables() {
  const build = (bits: Uint8Array, base: Uint16Array, delta: number, first: number) => {
    for (let i = 0; i < delta; i++) bits[i] = 0;
    for (let i = 0; i < 30 - delta; i++) bits[i + delta] = (i / delta) | 0;
    for (let i = 0, sum = first; i < 30; i++) { base[i] = sum; sum += 1 << bits[i]; }
  };
  build(LEN_BITS, LEN_BASE, 4, 3);
  build(DIST_BITS, DIST_BASE, 2, 1);
  LEN_BITS[28] = 0; LEN_BASE[28] = 258;
})();
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(t: Huffman, lengths: Uint8Array, off: number, num: number) {
  t.counts.fill(0);
  for (let i = 0; i < num; i++) t.counts[lengths[off + i]]++;
  t.counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 0, sum = 0; i < 16; i++) { offs[i] = sum; sum += t.counts[i]; }
  for (let i = 0; i < num; i++) if (lengths[off + i]) t.symbols[offs[lengths[off + i]]++] = i;
}
const FIXED_LIT = new Huffman(), FIXED_DIST = new Huffman();
(function fixed() {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  buildHuffman(FIXED_LIT, l, 0, 288);
  buildHuffman(FIXED_DIST, new Uint8Array(30).fill(5), 0, 30);
})();

/**
 * Inflates the zlib stream at `at` in `src`, whose inflated size is `size`
 * (a pack says it). Returns the data and the offset just past the stream
 * (its Adler-32 included).
 */
export function inflate(src: Uint8Array, at: number, size: number): { data: Uint8Array; end: number } {
  const out = new Uint8Array(size);
  let pos = at + 2, tag = 0, bits = 0, len = 0;
  if ((src[at] & 0x0f) != 8 || ((src[at] << 8) | src[at + 1]) % 31) throw new Error("not a zlib stream");
  const need = (n: number) => { while (bits < n) { tag |= (src[pos++] ?? 0) << bits; bits += 8; } };
  const read = (n: number) => { if (!n) return 0; need(n); const v = tag & ((1 << n) - 1); tag >>>= n; bits -= n; return v; };
  const decode = (t: Huffman) => {
    need(16);
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= tag & 1; tag >>>= 1; bits--;
      const count = t.counts[l];
      if (code - first < count) return t.symbols[index + code - first];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error("bad Huffman code");
  };
  const put = (b: number) => { if (len >= size) throw new Error("inflated past its size"); out[len++] = b; };
  let final = 0;
  do {
    final = read(1);
    const type = read(2);
    if (type == 0) {
      // Stored: back to the byte boundary (whole bytes in the bit buffer go back), then LEN, NLEN and the bytes.
      pos -= bits >> 3; tag = 0; bits = 0;
      const n = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (len + n > size || pos + n > src.length) throw new Error("bad stored block");
      out.set(src.subarray(pos, pos + n), len); len += n; pos += n;
      continue;
    }
    let lit = FIXED_LIT, dist = FIXED_DIST;
    if (type == 2) {
      const hlit = read(5) + 257, hdist = read(5) + 1, hclen = read(4) + 4;
      const lengths = new Uint8Array(320);
      for (let i = 0; i < hclen; i++) lengths[CL_ORDER[i]] = read(3);
      const cl = new Huffman();
      buildHuffman(cl, lengths, 0, 19);
      lengths.fill(0, 0, 19);
      for (let n = 0; n < hlit + hdist;) {
        const sym = decode(cl);
        if (sym < 16) lengths[n++] = sym;
        else if (sym == 16) { const prev = lengths[n - 1]; for (let r = read(2) + 3; r; r--) lengths[n++] = prev; }
        else if (sym == 17) for (let r = read(3) + 3; r; r--) lengths[n++] = 0;
        else for (let r = read(7) + 11; r; r--) lengths[n++] = 0;
      }
      lit = new Huffman(); dist = new Huffman();
      buildHuffman(lit, lengths, 0, hlit);
      buildHuffman(dist, lengths, hlit, hdist);
    } else if (type != 1) throw new Error("bad block type");
    for (;;) {
      const sym = decode(lit);
      if (sym == 256) break;
      if (sym < 256) { put(sym); continue; }
      const s = sym - 257, n = LEN_BASE[s] + read(LEN_BITS[s]);
      const d = decode(dist), from = len - (DIST_BASE[d] + read(DIST_BITS[d]));
      if (from < 0) throw new Error("bad distance");
      for (let i = 0; i < n; i++) put(out[from + i]);
    }
  } while (!final);
  if (len != size) throw new Error(`inflated ${len} bytes, expected ${size}`);
  // Whole bytes still in the bit buffer weren't the stream's; then the Adler-32.
  return { data: out, end: pos - (bits >> 3) + 4 };
}

/**
 * zlib-deflates `data`: the platform's CompressionStream ("deflate" is zlib's
 * format) where there is one, else stored (uncompressed) blocks.
 */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream == "function") {
    const stream = new Blob([data as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const parts: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let i = 0; i < data.length || i == 0; i += 65535) {
    const chunk = data.subarray(i, i + 65535), last = i + 65535 >= data.length;
    parts.push(Uint8Array.of(last ? 1 : 0, chunk.length & 255, chunk.length >> 8, ~chunk.length & 255, (~chunk.length >> 8) & 255), chunk);
    if (last) break;
  }
  let a = 1, b = 0;
  for (const x of data) { a = (a + x) % 65521; b = (b + a) % 65521; }
  parts.push(Uint8Array.of(b >> 8, b & 255, a >> 8, a & 255));
  return concat(parts);
}

// ---- Packs --------------------------------------------------------------------

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let i = 0;
  const varint = () => { let n = 0, shift = 0, c: number; do { c = delta[i++]; n += (c & 0x7f) * 2 ** shift; shift += 7; } while (c & 0x80); return n; };
  if (varint() != base.length) throw new Error("delta base size mismatch");
  const out = new Uint8Array(varint());
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0, size = 0;
      if (op & 1) off |= delta[i++];
      if (op & 2) off |= delta[i++] << 8;
      if (op & 4) off |= delta[i++] << 16;
      if (op & 8) off += delta[i++] * 2 ** 24;
      if (op & 16) size |= delta[i++];
      if (op & 32) size |= delta[i++] << 8;
      if (op & 64) size |= delta[i++] << 16;
      if (!size) size = 0x10000;
      out.set(base.subarray(off, off + size), o); o += size;
    } else if (op) { out.set(delta.subarray(i, i + op), o); o += op; i += op; }
    else throw new Error("bad delta op");
  }
  if (o != out.length) throw new Error("delta result size mismatch");
  return out;
}

interface Entry { offset: number; type: ObjectType | null; base?: number | string; data: Uint8Array | null; root: ObjectType | null; sha?: string }

/**
 * The objects in a pack, by id. `keep` says which types to keep the data of
 * (every type, by default); objects of other types are still read through
 * (to find the next one), and dropped.
 */
export async function readPack(pack: Uint8Array, keep: (type: ObjectType) => boolean = () => true): Promise<Map<string, GitObject>> {
  const objects = new Map<string, GitObject>();
  if (pack.length == 0) return objects;
  if (text(pack.subarray(0, 4)) != "PACK") throw new Error("not a pack");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const count = view.getUint32(8);
  const entries: Entry[] = [], byOffset = new Map<number, Entry>(), bySha = new Map<string, Entry>();
  let at = 12;
  for (let n = 0; n < count; n++) {
    const offset = at;
    let c = pack[at++];
    const code = (c >> 4) & 7;
    let size = c & 15, shift = 4;
    while (c & 0x80) { c = pack[at++]; size += (c & 0x7f) * 2 ** shift; shift += 7; }
    let base: number | string | undefined;
    if (code == 6) {
      c = pack[at++];
      let back = c & 0x7f;
      while (c & 0x80) { c = pack[at++]; back = (back + 1) * 128 + (c & 0x7f); }
      base = offset - back;
    } else if (code == 7) { base = hex(pack.subarray(at, at + 20)); at += 20; }
    else if (!TYPES[code]) throw new Error(`unknown pack object type ${code}`);
    const { data, end } = inflate(pack, at, size);
    at = end;
    const e: Entry = { offset, type: TYPES[code] ?? null, base, data, root: TYPES[code] ?? null };
    if (e.type) {
      e.sha = await hashObject({ type: e.type, data });
      bySha.set(e.sha, e);
      if (keep(e.type)) objects.set(e.sha, { type: e.type, data });
      else e.data = null;
    } else {
      const b = typeof base == "number" ? byOffset.get(base) : bySha.get(base!);
      e.root = b?.root ?? null;
      // A delta whose chain ends in a type we drop is dropped too.
      if (e.root && !keep(e.root)) e.data = null;
    }
    entries.push(e);
    byOffset.set(offset, e);
  }
  // Deltas, each over its base (itself perhaps a delta), in passes: a base named by its id may be a delta itself, which
  // has no id until it's resolved, and may come anywhere in the pack. Each pass resolves the deltas whose base is ready.
  const dead = new Set<Entry>();
  let waiting = entries.filter((e) => !e.type);
  for (let progress = true; waiting.length && progress;) {
    progress = false;
    const next: Entry[] = [];
    for (const e of waiting) {
      if (!e.data) { dead.add(e); progress = true; continue; }
      const b = typeof e.base == "number" ? byOffset.get(e.base) : bySha.get(e.base!);
      if (!b || (!b.type && !dead.has(b))) { next.push(e); continue; }
      progress = true;
      if (dead.has(b) || !b.data) { dead.add(e); e.data = null; continue; }
      const data = applyDelta(b.data, e.data);
      e.type = b.type; e.root = b.type; e.data = data;
      e.sha = await hashObject({ type: e.type!, data });
      bySha.set(e.sha, e);
      if (keep(e.type!)) objects.set(e.sha, { type: e.type!, data });
      else e.data = null;
    }
    waiting = next;
  }
  // Left over: a base that's not in the pack. Fine if deltas of a type we drop were dropped unread (it's one of them, so
  // these are that type too: a delta is its base's type); otherwise the pack is incomplete.
  if (waiting.length && !dead.size) throw new Error(`a delta's base ${waiting[0].base} isn't in the pack`);
  return objects;
}

/** A pack of these objects (none deltified). */
export async function writePack(objects: GitObject[]): Promise<Uint8Array> {
  const head = new Uint8Array(12);
  head.set(utf8("PACK"));
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];
  for (const o of objects) {
    const bytes: number[] = [];
    let size = o.data.length;
    let c = (CODES[o.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) { bytes.push(c | 0x80); c = size & 0x7f; size = Math.floor(size / 128); }
    bytes.push(c);
    parts.push(Uint8Array.from(bytes), await deflate(o.data));
  }
  const body = concat(parts);
  return concat([body, unhex(await sha1(body))]);
}

/** A pack with nothing in it: what a push sends when the remote has every object already. */
export const emptyPack = () => writePack([]);

// ---- tar --------------------------------------------------------------------

/** A ustar archive of files (path → bytes; mode "100755" makes one executable, "120000" a symlink to its contents). */
export function tar(files: { path: string; mode: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const field = (h: Uint8Array, at: number, len: number, s: string) => h.set(utf8(s).subarray(0, len), at);
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  for (const f of files) {
    const h = new Uint8Array(512);
    let name = f.path, prefix = "";
    if (utf8(name).length > 100) {
      const cut = name.lastIndexOf("/", 155);
      if (cut > 0) { prefix = name.slice(0, cut); name = name.slice(cut + 1); }
    }
    const link = f.mode == "120000";
    field(h, 0, 100, name);
    field(h, 100, 8, octal(f.mode == "100755" ? 0o755 : 0o644, 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(link ? 0 : f.data.length, 12));
    field(h, 136, 12, octal(0, 12));
    h.fill(0x20, 148, 156);
    h[156] = link ? 0x32 : 0x30;
    if (link) field(h, 157, 100, text(f.data));
    field(h, 257, 6, "ustar\0");
    field(h, 263, 2, "00");
    field(h, 345, 155, prefix);
    const sum = h.reduce((a, b) => a + b, 0);
    field(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(h);
    if (!link) {
      blocks.push(f.data);
      if (f.data.length % 512) blocks.push(new Uint8Array(512 - (f.data.length % 512)));
    }
  }
  blocks.push(new Uint8Array(1024));
  return concat(blocks);
}
